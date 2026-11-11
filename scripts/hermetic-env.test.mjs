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
};

const targets = [
  "scripts/env-inline.test.mjs",
  "scripts/journal.test.mjs",
  "scripts/pump-errors.test.mjs",
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

assert.equal(leaked, 0, `${leaked} of ${targets.length} child tests leaked/failed under a poisoned parent env`);
console.log(JSON.stringify({ targets: targets.length, leaked }));
console.log("PASS: tests are hermetic against a poisoned parent env");
