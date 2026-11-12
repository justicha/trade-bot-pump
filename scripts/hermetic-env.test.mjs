// Hermetic-env guard: `npm test` must not depend on what the developer's shell exports. This test
// spawns three representative child tests under a POISONED parent env (a fake RPC URL that carries
// an api-key, plus HELIUS_API_KEY and other settings) and asserts each child still exits 0 and never
// prints the poison key. If any child echoes the poison, a real api-key could leak the same way.
import { cleanEnv } from "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const POISON = "POISON_KEY_7f3a";
const poisonEnv = {
  ...cleanEnv(),
  RPC_URL: "https://poison.invalid/?api-key=" + POISON,
  HELIUS_API_KEY: POISON,
  CU_PRICE: "999",
  SNIPER_BUY_SOL: "abc",
  LIVE_CONFIRM_AMM: "yes",
  DRY_SELL: "yes",
  CU_LIMIT: "120000",
  SLIPPAGE_ASSUMED_BPS: "77",
  GRAD_MIN_FILL_PCT: "11",
  SHADOW_BUY_SOL: "0.5",
};

const targets = [
  "scripts/env-inline.test.mjs",
  "scripts/journal.test.mjs",
  "scripts/pump-errors.test.mjs",
  "scripts/gshadow-amm.test.mjs",
];

let leaked = 0;
for (const rel of targets) {
  const res = spawnSync(process.execPath, [path.join(repo, rel)], {
    cwd: repo,
    encoding: "utf8",
    env: poisonEnv,
  });
  const combined = String(res.stdout ?? "") + String(res.stderr ?? "");
  if (res.status !== 0) {
    leaked += 1;
    console.error(`FAIL: ${rel} exited ${res.status} under the poisoned env`);
    console.error(combined.slice(0, 400));
  } else if (combined.includes(POISON)) {
    leaked += 1;
    console.error(`FAIL: ${rel} printed the poison key under the poisoned env`);
  }
}

// Direct test-env regression guard: a child that imports test-env under the poisoned env must see
// RPC_URL overwritten to the throwaway value and the secret/settings vars stripped (never inherited).
{
  const code =
    "await import('./scripts/lib/test-env.mjs'); console.log(JSON.stringify({ rpc: process.env.RPC_URL, helius: process.env.HELIUS_API_KEY ?? null, amm: process.env.LIVE_CONFIRM_AMM ?? null, dry: process.env.DRY_SELL ?? null, cuLimit: process.env.CU_LIMIT ?? null, cuPrice: process.env.CU_PRICE ?? null, minFill: process.env.GRAD_MIN_FILL_PCT ?? null }))";
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: repo,
    encoding: "utf8",
    env: poisonEnv,
  });
  assert.equal(res.status, 0, "test-env child exited " + res.status + ": " + String(res.stderr).slice(0, 300));
  const out = String(res.stdout ?? "");
  assert.ok(!out.includes(POISON), "test-env child printed the poison key");
  const got = JSON.parse(out.trim());
  assert.equal(got.rpc, "https://example.invalid", "RPC_URL must be overwritten, got " + got.rpc);
  assert.equal(got.helius, null, "HELIUS_API_KEY must be stripped");
  assert.equal(got.amm, null, "LIVE_CONFIRM_AMM must be stripped");
  assert.equal(got.dry, null, "DRY_SELL must be stripped");
  assert.equal(got.cuLimit, null, "CU_LIMIT must be stripped");
  assert.equal(got.cuPrice, null, "CU_PRICE must be stripped");
  assert.equal(got.minFill, null, "GRAD_MIN_FILL_PCT must be stripped");
}

assert.equal(leaked, 0, `${leaked} of ${targets.length} child tests leaked/failed under a poisoned parent env`);
console.log(JSON.stringify({ targets: targets.length, leaked, direct: "ok" }));
console.log("PASS: tests are hermetic against a poisoned parent env");
