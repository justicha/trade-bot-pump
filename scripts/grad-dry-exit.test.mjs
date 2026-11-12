import "./lib/test-env.mjs";
// P4 (task 5): the graduation DRY RUN exit.
//   1) pump fees were charged twice: the exit ratio from checkExit (calcSellSol / entry) is already
//      net of pump's 1% in + 1% out, and roundTripCosts added another 1% + 1% on top;
//   2) a position whose curve completed was "sold" at the dead curve's last price. Now it is priced
//      from the PumpSwap pool quote (read-only) — or, without a quote, NOT booked as a sale.
//
// Fails without the fix: netRatioExitCosts does not exist; a flat exit costs 2% more; the dry run
// books a sale at the frozen curve price where there is no pool.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

// Pin every cost input: the expectations are exact numbers.
const COSTS = { CU_PRICE: "1500000", CU_LIMIT: "300000", SLIPPAGE_ASSUMED_BPS: "50" };
Object.assign(process.env, COSTS);

const { netRatioExitCosts, roundTripCosts, txCostSol, COSTS_SCHEME } = await import("../lib/fees.mjs");
const { readJournal } = await import("../lib/journal.mjs");
const { MINT } = await import("./mocks/grad-ws-mock.mjs");

// ---------------------------------------------------------------------------------------------
// The calculation
// ---------------------------------------------------------------------------------------------
{
  const BUY = 0.02;
  const TX = txCostSol();
  const slip = (BUY * 50) / 10000 + (BUY * 50) / 10000; // 50 bps on each leg
  const flat = netRatioExitCosts({ entrySol: BUY, ratio: 1.0 });
  asrt(flat.pnlSol === 0 && near(flat.receivedSol, BUY), "ratio 1.0: the fee-net proceeds equal the entry");
  asrt(flat.costs.feeSol === 0, "no pump fee is added on top of a fee-net ratio");
  asrt(near(flat.costs.netPnl, -(slip + 2 * TX)), `dry exit at ratio 1.0: net = -(slip + tx x2) = ${-(slip + 2 * TX)}, got ${flat.costs.netPnl}`);
  // What the dry run charged before: another pump 1% + 1%.
  const before = roundTripCosts({ buySol: BUY, ratio: 1.0 });
  asrt(near(before.netPnl - flat.costs.netPnl, -(BUY * 0.02)), "the old model took an extra 2% (pump fees twice)");

  const win = netRatioExitCosts({ entrySol: BUY, ratio: 1.5 });
  asrt(near(win.pnlSol, 0.01) && near(win.receivedSol, 0.03), "ratio 1.5: +50% before slippage / network costs");
  asrt(near(win.costs.netPnl, 0.01 - (BUY * 50) / 10000 - (0.03 * 50) / 10000 - 2 * TX), "slippage on both legs + two network fees, nothing else");
  asrt(near(win.costs.costSol, win.pnlSol - win.costs.netPnl), "costs = gross - net");
  asrt(COSTS_SCHEME.startsWith("v2.3"), `COSTS_SCHEME bumped to v2.3 (v2 prefix kept), got ${COSTS_SCHEME}`);
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.slice(src.indexOf("async function sellPosition"), src.indexOf("// Bounded retries: at most SELL_MAX_ATTEMPTS"));
  asrt(/if \(DRY_RUN\) \{/.test(fn) && /netRatioExitCosts\(\{ entrySol, ratio: mult \}\)/.test(fn), "the dry branch costs come from netRatioExitCosts");
  asrt(!/roundTripCosts\(/.test(src), "graduation no longer calls roundTripCosts (pump fees on a fee-net ratio)");
  asrt(!/pos\.lastPrice && pos\.entryPrice \? pos\.lastPrice \/ pos\.entryPrice/.test(src) && !/valuing at last known price/.test(src), "no exit is valued at the dead curve's last price any more");
  asrt(/ammSellQuote\(connection, mintPk, pos\.tokens\)/.test(fn), "a completed curve is priced from the PumpSwap pool quote");
  asrt(/reason: "dry: no AMM quote"/.test(fn) && !/lossAssumed/.test(fn), 'no quote -> stuck row "dry: no AMM quote", without lossAssumed');
  asrt(/sellPosition\(mint, mintPk, pos, null, \{ final: true \}\)/.test(src), "the stop path asks the pool too (no frozen-price fallback)");
  asrt(!/sendTxWithRetry|sendRawTransaction|simulateTx/.test(fn), "the dry branch is read-only (no simulation, no send)");
}

// ---------------------------------------------------------------------------------------------
// End to end: the bot buys (dry) on a live curve, the curve completes, the exit is priced
// ---------------------------------------------------------------------------------------------
async function runGrad(name, extra) {
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), `grad-dry-${name}-`));
  const env = cleanEnv({
    RPC_URL: "http://127.0.0.1:1",
    RPC_MOCK: path.join(here, "mocks", "rpc-mock-amm.mjs"),
    RPC_AMM_MINTS: MINT,
    RPC_AMM_COMPLETE_AFTER_MS: "1500", // live long enough to be bought, complete at the first exit poll
    WS_MOCK: path.join(here, "mocks", "grad-ws-mock.mjs"),
    KEYS_DIR: makeTempKeys(),
    JOURNAL_DIR: jdir,
    GRAD_BUY_SOL: "0.02",
    GRAD_MIN_FILL_PCT: "92",
    GRAD_MAX_FILL_PCT: "97",
    MIN_HOLDERS: "0",
    GRAD_MAX_POSITIONS: "3",
    ...COSTS,
    ...extra,
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "--dry-run"], { cwd: root, env });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (out += String(b)));
  await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 45_000);
    child.on("exit", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  const records = readJournal(jdir);
  fs.rmSync(jdir, { recursive: true, force: true });
  asrt(/\[DRY RUN\] position tracked/.test(out), `[${name}] the dry run bought on the live curve`);
  asrt(!/TypeError|ReferenceError/.test(out), `[${name}] no exception: ${(out.match(/(TypeError|ReferenceError).*/) || [""])[0]}`);
  return { out, records };
}

const [pool, noPool] = await Promise.all([
  runGrad("pool", { RPC_AMM_POOL: "1", GRAD_MAX_SEC: "8" }),
  runGrad("nopool", { SELL_MAX_ATTEMPTS: "2", GRAD_MAX_SEC: "12" }),
]);

{
  const { out, records } = pool;
  asrt(/GRADUATED|bonding curve gone/.test(out), "[pool] the bot saw the curve complete");
  const m = out.match(/\[DRY RUN\] PumpSwap quote: ([\d.]+) SOL for (\d+) tokens \(pool fees (\d+) bps inside\)/);
  asrt(!!m, "[pool] the exit is priced from a PumpSwap quote");
  const solOut = Number(m[1]);
  const tokens = BigInt(m[2]);
  // The same quote, recomputed against the same fixture with the bot's own function.
  Object.assign(process.env, { RPC_AMM_MINTS: MINT, RPC_AMM_POOL: "1" });
  const mock = await import("./mocks/rpc-mock-amm.mjs");
  const { ammSellQuote } = await import("../lib/pumpswap.mjs");
  const q = await ammSellQuote(mock.connection, new PublicKey(MINT), tokens);
  asrt(near(solOut, Number(q.solOut) / 1e9, 1e-9) && Number(m[3]) === q.feeBps, `[pool] it is the pool's quote for the position's tokens (${Number(q.solOut) / 1e9}), got ${solOut}`);
  const ratio = Number(q.solOut) / (0.02 * 1e9);
  const sold = out.match(/\[DRY RUN\] sold on (\w+): ([+-][\d.]+)% \(([+-][\d.]+) SOL before slippage\/network costs ([\d.]+)\)/);
  asrt(sold && sold[1] === "pumpswap", `[pool] sold on pumpswap, got ${sold && sold[1]}`);
  asrt(near(Number(sold[2]), Math.round((ratio - 1) * 1000) / 10, 0.06), `[pool] booked at the pool ratio ${(ratio * 100).toFixed(1)}% of the entry, got ${sold[2]}%`);
  const exp = netRatioExitCosts({ entrySol: 0.02, ratio });
  asrt(near(Number(sold[3]), Math.round(exp.pnlSol * 1e4) / 1e4, 1.01e-4) && near(Number(sold[4]), exp.costs.costSol, 1e-6), "[pool] pnl and costs come from the fee-net model (no pump fee added)");
  asrt(/buys \/ sells\s+: 1 \/ 1/.test(out), "[pool] one buy, one sale in the session summary");
  asrt(!records.some((r) => r.type === "stuck"), "[pool] nothing is stuck");
}
{
  const { out, records } = noPool;
  asrt(/no PumpSwap quote for .* attempt 1\/2, next try in 2s; position kept/.test(out), "[nopool] the first miss keeps the position (the pool may still appear)");
  asrt(!/\[DRY RUN\] sold/.test(out), "[nopool] NO sale is booked without a quote (old: sold at the dead curve's last price)");
  asrt(/curve complete and no PumpSwap quote — NOT booked as a sale/.test(out), "[nopool] the reason is logged");
  const stuck = records.filter((r) => r.type === "stuck");
  asrt(stuck.length === 1 && stuck[0].reason === "dry: no AMM quote" && stuck[0].mode === "DRY" && stuck[0].venue === "pumpswap", `[nopool] one stuck row "dry: no AMM quote", got ${JSON.stringify(stuck.map((s) => s.reason))}`);
  asrt(stuck[0].lossAssumed === undefined && stuck[0].pnlSol === undefined, "[nopool] a dry stuck row carries no assumed loss (the limits are not touched)");
  asrt(stuck[0].attempts === 2 && stuck[0].mint === MINT && Number(stuck[0].tokens) > 0, "[nopool] attempts, mint and tokens are journaled");
  asrt(/buys \/ sells\s+: 1 \/ 0/.test(out) && /no exit recorded/.test(out), "[nopool] the summary shows one buy, no sale, one unresolved position");
}

console.log(JSON.stringify({ flatNet: netRatioExitCosts({ entrySol: 0.02, ratio: 1 }).costs.netPnl, pool: "priced", nopool: "stuck (no result)" }));
console.log("PASS: graduation dry exit — no double pump fee; migrated positions priced from the pool or not booked");
