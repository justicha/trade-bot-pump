// Unified leveled logger with private-key masking (A8 / D14).
// Levels: debug < info < warn < error. Threshold via LOG_LEVEL (default "info").
// Timestamps are Moscow time (lib/time.mjs) — explicit zone, not the host's.
import { fmtMsk } from "./time.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

// Patterns that could leak a secret key into logs:
//  - a JSON / Uint8 array of >=60 small integers (a Solana secretKey is 64 bytes)
//  - explicit secretKey / privateKey key-value blobs
const U8ARR = /\[\s*(?:-?\d{1,3}\s*,\s*){59,}\s*-?\d{1,3}\s*\]/g;
const KV = /\b(secret[_-]?key|private[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
// A base58 run of 80-90 chars is a 64-byte value (a secret key, or a tx signature).
const B58 = /\b[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;

function stringify(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return `[REDACTED Buffer(${v.length})]`;
  if (v instanceof Uint8Array) return `[REDACTED Uint8Array(${v.length})]`;
  if (typeof v === "object" && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

// Strip anything that looks like a raw private key / key material out of a value.
export function maskSecrets(value) {
  let s = stringify(value);
  s = s.replace(U8ARR, "[REDACTED_SECRET_KEY_ARRAY]");
  s = s.replace(KV, (_m, key) => `${key}=[REDACTED]`);
  s = s.replace(B58, "[REDACTED_BASE58]");
  return s;
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = args.map((a) => maskSecrets(a)).join(" ");
  // Moscow time in the log prefix (lib/time.mjs); the zone is explicit, not the host's.
  const ts = fmtMsk();
  process[level === "error" ? "stderr" : "stdout"].write(`[${ts}] [${level.toUpperCase()}] ${line}\n`);
}

export const log = {
  debug: (...a) => emit("debug", a),
  info: (...a) => emit("info", a),
  warn: (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};

export default log;
