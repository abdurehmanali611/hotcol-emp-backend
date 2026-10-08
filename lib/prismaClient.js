import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.ts";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
// Vercel's file tracer (@vercel/nft) parses files with a JavaScript-only parser
// and gives up on TypeScript-only syntax (it fails on `export type ...` in
// generated/prisma/client.ts), so none of the imports inside the generated
// client — including these Prisma runtime files — are added to the serverless
// bundle. Importing them here, from plain JS, makes the tracer include them.
// These are the same specifiers generated/prisma/internal/class.ts imports
// dynamically, so this resolves to the same module instances and changes no
// runtime behavior.
import "@prisma/client/runtime/client";
import "@prisma/client/runtime/query_compiler_fast_bg.mysql.mjs";
import "@prisma/client/runtime/query_compiler_fast_bg.mysql.wasm-base64.mjs";

/**
 * Shared MariaDB pool for all HotCol backends (user / apex / owner / room).
 * Keep this aligned with a known-working mariadb.createPool config.
 */
function resolveConnectionLimit() {
  const raw = process.env.DB_CONNECTION_LIMIT;
  const n = raw ? Number.parseInt(String(raw).trim(), 10) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return 3;
  return 5;
}

export function createPrismaClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Prisma");
  }

  const parsed = new URL(databaseUrl);
  const adapter = new PrismaMariaDb({
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
    connectionLimit: resolveConnectionLimit(),
    connectTimeout: 30_000,
    acquireTimeout: 30_000,
    allowPublicKeyRetrieval: true,
    ssl:
      parsed.searchParams.get("sslaccept") === "strict"
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false },
  });

  return new PrismaClient({ adapter });
}
