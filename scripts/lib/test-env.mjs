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

process.env.ROOT ??= fs.mkdtempSync(path.join(os.tmpdir(), "test-root-"));
process.env.RPC_URL ??= "https://example.invalid";

// A throwaway keypair in a temp KEYS_DIR. Spawned bots load the wallet from here; pass the
// returned directory as KEYS_DIR in the child's env so no keys/ dir in the repo is needed.
export function makeTempKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-keys-"));
  const kp = Keypair.generate();
  fs.writeFileSync(path.join(dir, "default.json"), JSON.stringify(Array.from(kp.secretKey)));
  return dir;
}
