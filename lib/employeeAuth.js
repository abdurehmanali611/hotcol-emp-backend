/**
 * Employee portal auth helpers (hotcol-emp).
 * Alphanumeric OTP — do not strip letters.
 */
import { signToken, assertAuthenticated } from "./auth.js";

export const EMPLOYEE_ROLE = "HrEmployee";

export function signEmployeeToken({
  employeeId,
  HotelName,
  tinNumber,
  fullName,
}) {
  return signToken({
    role: EMPLOYEE_ROLE,
    employeeId: Number(employeeId),
    HotelName: String(HotelName),
    tinNumber: tinNumber ? String(tinNumber) : String(HotelName),
    fullName: String(fullName || "Employee"),
  });
}

export function assertEmployee(context) {
  assertAuthenticated(context);
  const role = context.user.role || context.user.Role;
  if (role !== EMPLOYEE_ROLE) {
    throw new Error("Not authorized — employee session required");
  }
  const employeeId = Number(context.user.employeeId);
  if (!(employeeId > 0)) throw new Error("Invalid employee session");
  return employeeId;
}

/** Simple in-memory login rate limit (per process). */
const loginBuckets = new Map();

/**
 * @returns {{ ok: true } | { ok: false, retryAfterSec: number }}
 */
export function consumeEmployeeLoginAttempt(
  clientKey,
  { limit = 12, windowMs = 15 * 60 * 1000 } = {},
) {
  const key = String(clientKey || "unknown").trim() || "unknown";
  const now = Date.now();
  let bucket = loginBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    loginBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  return { ok: true };
}
