/**
 * Alphanumeric portal OTP/PIN helpers for hotcol-emp (bcrypt, cost 12).
 * Login is OTP-only (like hotcol-room guestOtp) — codes are globally unique
 * among active portal employees via portalOtpLookup.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";

const OTP_LEN = 6;
const OTP_RE = /^[A-Z0-9]{6}$/;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O
const DIGITS = "23456789"; // no 0/1
const MIX = LETTERS + DIGITS;

export function normalizePortalOtp(raw) {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isValidPortalOtpFormat(otp) {
  return OTP_RE.test(normalizePortalOtp(otp));
}

/** Prefer mixed letters+digits (e.g. AB1234). */
export function generatePortalOtp() {
  const bytes = crypto.randomBytes(OTP_LEN);
  const chars = [];
  // Force at least 2 letters and 2 digits
  chars.push(LETTERS[bytes[0] % LETTERS.length]);
  chars.push(LETTERS[bytes[1] % LETTERS.length]);
  chars.push(DIGITS[bytes[2] % DIGITS.length]);
  chars.push(DIGITS[bytes[3] % DIGITS.length]);
  for (let i = 4; i < OTP_LEN; i++) {
    chars.push(MIX[bytes[i] % MIX.length]);
  }
  // Shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i % bytes.length] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export async function hashPortalOtp(otp) {
  const normalized = normalizePortalOtp(otp);
  if (!isValidPortalOtpFormat(normalized)) {
    throw new Error("Invalid portal OTP format");
  }
  return bcrypt.hash(normalized, 12);
}

export async function verifyPortalOtp(otp, hash) {
  const normalized = normalizePortalOtp(otp);
  if (!hash || !isValidPortalOtpFormat(normalized)) return false;
  return bcrypt.compare(normalized, String(hash));
}

/** Clears plaintext preview after first login / PIN change. */
export function clearOtpPreviewFields() {
  return {
    portalOtpPreview: "",
    portalOtpViewer: "none",
  };
}

export function issuePortalOtpPayload(plainOtp, viewer) {
  const normalized = normalizePortalOtp(plainOtp);
  if (!isValidPortalOtpFormat(normalized)) {
    throw new Error("Invalid portal OTP format");
  }
  if (viewer !== "HR" && viewer !== "Manager") {
    throw new Error("portalOtpViewer must be HR or Manager when issuing");
  }
  return {
    plain: normalized,
    portalOtpPreview: normalized,
    portalOtpViewer: viewer,
    mustChangeOtp: true,
    portalOtpIssuedAt: new Date(),
  };
}

/**
 * True when another non-terminated portal employee already uses this code.
 */
export async function isPortalOtpTaken(
  prisma,
  otp,
  { excludeEmployeeId = null } = {},
) {
  const code = normalizePortalOtp(otp);
  if (!isValidPortalOtpFormat(code)) return false;
  const where = {
    portalOtpLookup: code,
    status: { not: "terminated" },
  };
  if (excludeEmployeeId != null && Number(excludeEmployeeId) > 0) {
    where.id = { not: Number(excludeEmployeeId) };
  }
  const clash = await prisma.hr_employee.findFirst({
    where,
    select: { id: true },
  });
  return Boolean(clash);
}

/**
 * Allocate a globally unique portal OTP (among active employees) and write
 * hash + lookup + preview — same uniqueness model as lodging guestOtp.
 */
export async function issueUniquePortalOtp(
  prisma,
  employeeId,
  viewer,
  { maxAttempts = 40 } = {},
) {
  const id = Number(employeeId);
  if (!(id > 0)) throw new Error("Invalid employee id");
  if (viewer !== "HR" && viewer !== "Manager") {
    throw new Error("portalOtpViewer must be HR or Manager when issuing");
  }

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const plain = generatePortalOtp();
    const taken = await isPortalOtpTaken(prisma, plain, {
      excludeEmployeeId: id,
    });
    if (taken) continue;

    const hash = await hashPortalOtp(plain);
    const issued = issuePortalOtpPayload(plain, viewer);
    await prisma.hr_employee.update({
      where: { id },
      data: {
        portalOtpHash: hash,
        portalOtpLookup: plain,
        portalOtpPreview: issued.portalOtpPreview,
        portalOtpViewer: issued.portalOtpViewer,
        mustChangeOtp: true,
        portalOtpIssuedAt: issued.portalOtpIssuedAt,
        portalFirstLoginAt: null,
      },
    });
    return plain;
  }
  throw new Error("Could not allocate a unique portal code — try again");
}

/** Clear lookup so the code can be reused (terminate / disable portal). */
export function clearPortalOtpLoginFields() {
  return {
    portalOtpHash: "",
    portalOtpLookup: "",
    ...clearOtpPreviewFields(),
    mustChangeOtp: false,
    portalOtpIssuedAt: null,
  };
}
