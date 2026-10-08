import jwt from "jsonwebtoken";

const JWT_Secret = process.env.JWT_Secret;

function resolveJwtExpiresIn() {
  const raw = process.env.JWT_EXPIRES_IN;
  if (raw == null || String(raw).trim() === "") return "7d";
  const s = String(raw).trim();
  if (/^\d+[smhdw]$/i.test(s)) return s;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n >= 3600) return n;
    return "7d";
  }
  return s;
}

export const JWT_EXPIRES_IN = resolveJwtExpiresIn();

if (!JWT_Secret || String(JWT_Secret).trim() === "") {
  console.error(
    "[hotcol-emp] JWT_Secret is missing — tokens will fail verification. Set JWT_Secret in the environment.",
  );
}

export function signToken(payload) {
  return jwt.sign(payload, JWT_Secret, { expiresIn: JWT_EXPIRES_IN });
}

export function authenticateRequest(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  try {
    return jwt.verify(token, JWT_Secret);
  } catch (err) {
    if (err?.name === "TokenExpiredError") {
      return { __authExpired: true };
    }
    return null;
  }
}

export function assertAuthenticated(context) {
  if (!context.user) throw new Error("Not Authenticated");
  if (context.user.__authExpired) throw new Error("Session expired");
}
