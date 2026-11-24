// Copy-trader proportional size (human decision 2026-11-24): lib/copy-sizing.mjs and the real
// copy-trader in DRY RUN on the mock socket / mock RPC (no network, nothing sent).
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET } from "./mocks/copy-ws-mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const S = await import("../lib/copy-sizing.mjs");
const { numOr } = await import("../lib/config.mjs");
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};

// 1. the share of the target's wallet applied to ours
{
  // target held 10 SOL, put 1 SOL in (9 left after the buy) -> 10 %; ours 0.51, reserve 0.01 -> 0.05
  const a = S.proportionalBuySol({ targetSpentSol: 1, targetBalanceAfterSol: 9, ourBalanceSol: 0.51, reserveSol: 0.01, minBuySol: 0.005 });
  assert.deepEqual(a, { ok: true, buySol: 0.05, fraction: 0.1 });
  // the human's example: $1000 wallet, $100 buy -> 10 % of ours, whatever ours is now
  for (const ours of [0.3, 1.01, 5.01]) {
    const r = S.proportionalBuySol({ targetSpentSol: 100, targetBalanceAfterSol: 900, ourBalanceSol: ours, reserveSol: 0.01, minBuySol: 0 });
    assert.equal(r.buySol, Math.round((ours - 0.01) * 0.1 * 1e9) / 1e9);
  }
  const all = S.proportionalBuySol({ targetSpentSol: 5, targetBalanceAfterSol: 0, ourBalanceSol: 1.01, reserveSol: 0.01, minBuySol: 0 });
  assert.equal(all.fraction, 1, "the target went all in -> all of our usable balance");
  assert.equal(all.buySol, 1);
  const dust = S.proportionalBuySol({ targetSpentSol: 0.1, targetBalanceAfterSol: 99.9, ourBalanceSol: 1, reserveSol: 0.01, minBuySol: 0.005 });
  assert.equal(dust.ok, false);
  assert.match(dust.reason, /below COPY_MIN_BUY_SOL/);
  assert.equal(S.proportionalBuySol({ targetSpentSol: 1, targetBalanceAfterSol: 9, ourBalanceSol: 0.005, reserveSol: 0.01, minBuySol: 0 }).buySol, 0, "balance below the reserve -> 0");
  for (const bad of [{ targetSpentSol: 0 }, { targetSpentSol: null }, { targetBalanceAfterSol: NaN }, { ourBalanceSol: undefined }]) {
    const r = S.proportionalBuySol({ targetSpentSol: 1, targetBalanceAfterSol: 9, ourBalanceSol: 1, ...bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  ok("proportional size: target spent / target balance before the buy, times (our balance - reserve); dust below the minimum skipped; unknown inputs refused");
}

// 2. env
{
  assert.deepEqual(S.parseSizeEnv({}, numOr), { mode: "fixed", reserveSol: 0.01, minBuySol: 0.005 });
  assert.deepEqual(S.parseSizeEnv({ COPY_SIZE_MODE: "proportional", COPY_RESERVE_SOL: "0.05", COPY_MIN_BUY_SOL: "0" }, numOr), { mode: "proportional", reserveSol: 0.05, minBuySol: 0 });
  assert.throws(() => S.parseSizeEnv({ COPY_SIZE_MODE: "percent" }, numOr), /COPY_SIZE_MODE/);
  assert.throws(() => S.parseSizeEnv({ COPY_RESERVE_SOL: "-1" }, numOr), /COPY_RESERVE_SOL/);
  ok("env: default fixed (the old behaviour); proportional; a bad mode or a negative reserve is refused");
}

// 3. the copy-trader process (DRY RUN, mocks): mock balances 2 SOL for every wallet, the target buys for 0.02 SOL
const run = (extra) =>
  new Promise((resolve) => {
    const env = cleanEnv({
      RPC_URL: "http://127.0.0.1:1",
      RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
      WS_MOCK: path.join(here, "mocks", "copy-ws-mock.mjs"),
      KEYS_DIR: makeTempKeys(),
      COPY_TARGETS: TARGET,
      COPY_BUY_SOL: "0.02",
      COPY_MAX_POSITIONS: "5",
      ...extra,
    });
    const child = spawn(process.execPath, [path.join(root, "bots", "copy-trader", "watcher.mjs"), "--dry-run"], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const killer = setTimeout(() => child.kill(), 4000);
    child.on("exit", (code) => {
      clearTimeout(killer);
      resolve({ code, out });
    });
  });
{
  const p = await run({ COPY_SIZE_MODE: "proportional" });
  assert.match(p.out, /Config: buy=proportional to the target/);
  // 0.02 of 2.02 SOL = 0.990099 %; (2 - 0.01) x 0.02 / 2.02 = 0.019702970 SOL
  assert.match(p.out, /size: target spent 0\.02 of 2\.0200 SOL = 0\.99 % -> 0\.01970297 SOL of our 2\.0000 SOL/);
  assert.match(p.out, /mint: .* \| 0\.01970297 SOL ->/);
  assert.equal((p.out.match(/\[DRY RUN\] tracked/g) || []).length, 1);
  const tiny = await run({ COPY_SIZE_MODE: "proportional", COPY_MIN_BUY_SOL: "0.05" });
  assert.match(tiny.out, /skip: proportional buy 0\.01970297 SOL .* below COPY_MIN_BUY_SOL 0\.05/);
  assert.ok(!/\[DRY RUN\] tracked/.test(tiny.out));
  const fixed = await run({});
  assert.match(fixed.out, /Config: buy=0\.02 SOL/);
  assert.match(fixed.out, /mint: .* \| 0\.02 SOL ->/);
  assert.ok(!/size: target spent/.test(fixed.out), "fixed mode reads no balance for sizing");
  const bad = await run({ COPY_SIZE_MODE: "percent" });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /COPY_SIZE_MODE must be fixed or proportional/);
  ok("copy-trader DRY RUN: proportional buys 0.0197 SOL for a 0.02 of 2.02 SOL target buy; below the minimum -> skip; fixed mode unchanged; bad mode -> exit 1");
}

console.log(`copy-sizing: ${passed} checks passed`);
