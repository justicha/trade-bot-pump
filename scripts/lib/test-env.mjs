// Hermetic test bootstrap. Import this FIRST in any test that (transitively) loads lib/config.mjs
// or spawns a bot, before any other repo import. It makes a test independent of the developer's
// machine: ROOT points at a fresh temp dir (so ROOT/.env is never read) and RPC_URL gets a
// throwaway value (lib/config.mjs aborts the process without a http(s) RPC_URL).
//
// The repo-local .env and keys/default.json must not be required for `npm test` to pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

process.env.ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "test-root-"));
process.env.RPC_URL = "https://example.invalid";

// Never inherit settings/secrets from the developer's shell: a real RPC URL (with an api-key)
// must not leak into tests or spawned bots. Pass these explicitly via cleanEnv({ ... }) when a
// child actually needs them.
for (const k of ["HELIUS_API_KEY", "WS_URL", "LIVE_CONFIRM", "LIVE_CONFIRM_AMM", "DRY_SELL", "SELL_ON_EXIT"]) {
  delete process.env[k];
}

// A fresh child env for spawn/spawnSync: only a whitelist of system variables that are actually
// present in process.env, plus the test's own ROOT and RPC_URL, plus `extra` (which wins last).
// Nothing else from the developer's shell leaks into a spawned bot.
const SYSTEM_ALLOW = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "NODE_OPTIONS",
]);
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SYSTEM_ALLOW.has(k) && v !== undefined) env[k] = v;
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
