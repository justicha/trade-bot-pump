// Run metadata stamped into every journal line: who ran, with which params, on which code.
//
// Why: without a sessionId and a paramsHash a journal silently mixes runs with different settings,
// and two runs cannot be compared. The hash is over the *effective* parameters (the ones the bot
// actually uses after env overrides), not over the defaults.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// "2026-11-08T12:34:56-msk" style, unique per process start.
export function newSessionId(prefix = "sniper") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const rand = crypto.randomBytes(3).toString("hex");
  return `${prefix}-${stamp}-${rand}`;
}

// Stable 12-hex-char hash of an arbitrary params object (keys sorted, so key order never matters).
export function paramsHash(params) {
  const norm = JSON.stringify(params, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    }
    return v;
  });
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

// Short git SHA of the running checkout, or null when git is unavailable (packaged copy, no repo).
// Cached: called once per process.
let cachedSha;
export function gitSha() {
  if (cachedSha !== undefined) return cachedSha;
  try {
    cachedSha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: process.cwd(), encoding: "utf8", timeout: 3000 }).trim() || null;
  } catch {
    cachedSha = null;
  }
  return cachedSha;
}
