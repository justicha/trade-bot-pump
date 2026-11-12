// Hermetic test bootstrap. Import this FIRST in any test that (transitively) loads lib/config.mjs
// or spawns a bot, before any other repo import. It makes a test independent of the developer's
// machine: process.env is stripped down to a small system allowlist (so neither secrets nor the
// developer's bot settings leak in), then ROOT points at a fresh temp dir and RPC_URL gets a
// throwaway value (lib/config.mjs aborts the process without a http(s) RPC_URL).
//
// The repo-local .env and keys/default.json must not be required for `npm test` to pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

// The only environment variables a test process may keep. Compared case-insensitively
// (k.toUpperCase()) because Windows env names vary in case ("ComSpec", "Path", ...).
const SYSTEM_ALLOW = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "NODE_OPTIONS",
]);

// Strip every non-system variable so a test sees only code defaults plus what it sets explicitly.
// A real RPC URL (with an api-key) and the developer's bot settings never leak into a test or a
// spawned bot. Pass anything a child needs explicitly via cleanEnv({ ... }).
for (const k of Object.keys(process.env)) {
  if (!SYSTEM_ALLOW.has(k.toUpperCase())) delete process.env[k];
}

process.env.ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-root-"));
process.env.RPC_URL = "https://example.invalid";

// A fresh child env for spawn/spawnSync: the same system allowlist (case-insensitive), plus the
// test's own ROOT and RPC_URL, plus `extra` (which wins last). Nothing else leaks into a child.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SYSTEM_ALLOW.has(k.toUpperCase()) && v !== undefined) env[k] = v;
  }
  if (process.env.ROOT !== undefined) env.ROOT = process.env.ROOT;
  if (process.env.RPC_URL !== undefined) env.RPC_URL = process.env.RPC_URL;
  return { ...env, ...extra };
}

// A throwaway keypair in a temp KEYS_DIR. Spawned bots load the wallet from here; pass the
// returned directory as KEYS_DIR in the child's env so no keys/ dir in the repo is needed.
export function makeTempKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-keys-"));
  const kp = Keypair.generate();
  fs.writeFileSync(path.join(dir, "default.json"), JSON.stringify(Array.from(kp.secretKey)));
  return dir;
}
