import "./lib/test-env.mjs";
// The graduation shadow lab end to end (real handler, fixture socket + fixture RPC, no network):
//   P1  a position whose curve COMPLETED is closed at the PumpSwap pool quote, not at the frozen
//       last curve price; without a pool it is journaled unpriced (netSol null) — at the timeout
//       and at a stop;
//   P3  variant J trades the live band: a 80% / 6-holder candidate opens only J, a 93% one opens
//       A–H and not J;
//   P5  every trade event of a transaction is processed, and a holder is counted by the event's
//       own is_buy flag.
//
// Fails without the fixes: the old lab closes a migrated position by "timeout" at the last curve
// price (ratio 1.0 / 1.05 instead of the pool's 0.80, or instead of "no result"), has no variant J,
// and drops every event after the first one of a transaction.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const { FIRST_MINT, BAND_MINT, HIGH_MINT, MULTI_MINT } = await import("./mocks/ws-mock-shadow.mjs");
const { readJournal } = await import("../lib/journal.mjs");

const COSTS = { CU_PRICE: "1500000", CU_LIMIT: "300000", SLIPPAGE_ASSUMED_BPS: "50" };
const BUY = 0.02;

async function runShadow(name, overrides) {
  const dir = tmp(`gshadow-${name}-journal-`);
  const env = cleanEnv({
    ROOT: tmp(`gshadow-${name}-root-`), // a fresh ROOT: the developer's .env must not leak in
    RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
    WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
    JOURNAL_DIR: dir,
    SHADOW_BUY_SOL: String(BUY),
    SHADOW_VARIANTS: "ABCDEFGHIJ", // the set these assertions were written for; K–N: scripts/gshadow-rev5.test.mjs
    ...COSTS,
    ...overrides,
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "shadow.mjs")], { cwd: root, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });
  const records = readJournal(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const fatal = /TypeError|ReferenceError|Cannot access .* before initialization|UnhandledPromiseRejection/;
  asrt(code === 0, `[${name}] the shadow lab exited 0 (got ${code}); stderr: ${err.split(/\r?\n/)[0] || ""}`);
  asrt(!fatal.test(err + out), `[${name}] no exception in the run, got: ${(err.match(fatal) || [""])[0]} ${err.split(/\r?\n/)[0] || ""}`);
  return {
    out,
    opens: records.filter((x) => x.type === "gshadow_open"),
    trades: records.filter((x) => x.type === "gshadow_trade"),
    candidates: records.filter((x) => x.type === "gshadow_candidate"),
  };
}

const AMM_RPC = { RPC_MOCK: path.join(here, "mocks", "rpc-mock-amm.mjs"), RPC_AMM_MINTS: FIRST_MINT, MIN_FILL: "92", SHADOW_SL: "0" };
const [withPool, noPool, noPoolStop, band] = await Promise.all([
  // The curve fills to 100% in the stream, the pool exists.
  runShadow("pool", { ...AMM_RPC, RPC_AMM_POOL: "1", WS_MOCK_SCENARIO: "migrate", SHADOW_HOLD_SEC: "4", GRAD_TIMEOUT_SEC: "4", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "12" }),
  // The stream just goes silent after the entry (no 100% event); the curve is complete, no pool.
  runShadow("nopool", { ...AMM_RPC, WS_MOCK_SCENARIO: "flat", SHADOW_STALE_SEC: "1", SHADOW_HOLD_SEC: "4", GRAD_TIMEOUT_SEC: "4", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "12" }),
  // The same, but the run is stopped while the positions are still open.
  runShadow("nopool-stop", { ...AMM_RPC, WS_MOCK_SCENARIO: "flat", SHADOW_STALE_SEC: "1", SHADOW_HOLD_SEC: "3600", GRAD_TIMEOUT_SEC: "3600", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "5" }),
  // Live band for J (MIN_FILL unset: A–I keep the lab default 92).
  runShadow("band", {
    RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
    WS_MOCK_SCENARIO: "live-band",
    GRAD_MIN_FILL_PCT: "75", GRAD_MAX_FILL_PCT: "90", GRAD_MIN_HOLDERS: "5", GRAD_TAKE_PROFIT: "1.5", GRAD_STOP_LOSS: "0.7", GRAD_TIMEOUT_SEC: "300",
    SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5",
  }),
]);

// ---------------------------------------------------------------------------------------------
// P1. Migrated + pool: closed at the pool quote
// ---------------------------------------------------------------------------------------------
{
  // What the pool pays for the position, computed with the bot's own quote function against the
  // same fixture (env must be set before the fixture is imported).
  Object.assign(process.env, COSTS, { RPC_AMM_MINTS: FIRST_MINT, RPC_AMM_POOL: "1" });
  const mock = await import("./mocks/rpc-mock-amm.mjs");
  const { ammSellQuote } = await import("../lib/pumpswap.mjs");
  const { ammEntryTokens } = await import("../lib/gshadow.mjs");
  const { pessimisticRoundTrip } = await import("../lib/pessimistic.mjs");
  const entry = { virtualSolReserves: BigInt(30e9 + 0.93 * 85e9), virtualTokenReserves: 1_073_000_000_000_000n }; // the 93% event
  const tokens = ammEntryTokens(entry, BUY);
  const q = await ammSellQuote(mock.connection, new PublicKey(FIRST_MINT), tokens);
  const expRatio = Number(q.solOut) / (BUY * 1e9);
  const frozenCurveRatio = (30 + 85) / (30 + 0.93 * 85); // what the old lab would have used: 1.0546
  asrt(expRatio > 0.75 && expRatio < 0.85 && q.feeBps === 30, `fixture pool: ratio ~0.80 after 30 bps fees (got ${expRatio.toFixed(4)})`);

  const { opens, trades, out } = withPool;
  asrt(opens.length === 9 && trades.length === 9, `[pool] 9 positions opened and closed (got ${opens.length}/${trades.length})`);
  asrt(opens.every((o) => o.tokens === tokens.toString()), `[pool] the open row carries the position's tokens (${tokens})`);
  asrt(trades.every((t) => t.exitVenue === "amm" && t.migrated === true), `[pool] every exit is priced on the AMM, got ${JSON.stringify([...new Set(trades.map((t) => t.exitVenue))])}`);
  asrt(trades.every((t) => t.reason === "timeout"), `[pool] closed by the hold timeout, got ${JSON.stringify([...new Set(trades.map((t) => t.reason))])}`);
  const t = trades[0];
  asrt(near(t.ratio, Math.round(expRatio * 1e6) / 1e6), `[pool] ratio = pool quote / buySol (${expRatio.toFixed(6)}), got ${t.ratio}`);
  asrt(Math.abs(t.ratio - frozenCurveRatio) > 0.2 && t.ratio < 1, `[pool] NOT the frozen curve price (${frozenCurveRatio.toFixed(4)})`);
  const exp = pessimisticRoundTrip({ buySol: BUY, ratio: expRatio, delayMs: 1, exitVenue: "amm" }).netPnl;
  asrt(near(t.netSol, Math.round(exp * 1e9) / 1e9, 2e-9), `[pool] netSol = AMM cost model (${exp.toFixed(9)}), got ${t.netSol}`);
  const withSellFee = pessimisticRoundTrip({ buySol: BUY, ratio: expRatio, delayMs: 1 }).netPnl;
  asrt(t.netSol > withSellFee + 1e-5, "[pool] no pump sell fee on the AMM exit (better than the curve model by ~1% of the proceeds)");
  asrt(near(t.ammSolOut, Number(q.solOut) / 1e9) && t.ammFeeBps === 30 && t.exitPrice === null && t.tokens === tokens.toString(), "[pool] the row keeps the quote it was priced with");
  asrt(typeof t.costsScheme === "string" && t.costsScheme.startsWith("v4-amm-exit"), "[pool] costsScheme v4-amm-exit");
  asrt(trades.every((x) => x.unconfirmed === undefined && Number.isFinite(x.netPct)), "[pool] a priced exit is not unconfirmed");
  asrt(/curve complete — open positions are priced from the PumpSwap pool/.test(out), "[pool] the switch is logged");
  const j = trades.find((x) => x.variant === "J");
  asrt(j && j.params && j.params.holdSec === 4, "[pool] variant J rows carry their parameters");
}

// ---------------------------------------------------------------------------------------------
// P1. Migrated, no pool: no invented price
// ---------------------------------------------------------------------------------------------
for (const [name, run, reason] of [["nopool", noPool, "timeout"], ["nopool-stop", noPoolStop, "manual stop"]]) {
  const { opens, trades } = run;
  asrt(opens.length === 9 && trades.length === 9, `[${name}] 9 positions opened and journaled (got ${opens.length}/${trades.length})`);
  asrt(trades.every((t) => t.exitVenue === "amm-unpriced" && t.migrated === true), `[${name}] exitVenue amm-unpriced, got ${JSON.stringify([...new Set(trades.map((t) => t.exitVenue))])}`);
  asrt(trades.every((t) => t.netSol === null && t.netPct === null && t.ratio === null && t.exitPrice === null), `[${name}] no result is booked (old lab: ratio 1, netPct -7.63 at the frozen curve price)`);
  asrt(trades.every((t) => t.unconfirmed === true), `[${name}] flagged unconfirmed`);
  asrt(trades.every((t) => t.reason === reason), `[${name}] reason "${reason}", got ${JSON.stringify([...new Set(trades.map((t) => t.reason))])}`);
  asrt(new Set(trades.map((t) => `${t.variant}:${t.mint}`)).size === 9, `[${name}] each position is closed once`);
}
asrt(/9 unconfirmed \(no price\)/.test(noPoolStop.out), "[nopool-stop] the stop summary counts the unpriced positions");
asrt(noPool.trades.every((t) => t.holdSec >= 4), "[nopool] an unpriced position waits for its timeout (the pool may still appear)");

// ---------------------------------------------------------------------------------------------
// P3 + P5. Live band for J; all events of a tx; holders by the event's is_buy
// ---------------------------------------------------------------------------------------------
{
  const { opens, trades, candidates, out } = band;
  const of = (mint) => opens.filter((o) => o.mint === mint).map((o) => o.variant).sort().join("");
  asrt(of(BAND_MINT) === "J", `[band] fill 80 / 6 holders opens ONLY variant J, got "${of(BAND_MINT)}"`);
  asrt(of(HIGH_MINT) === "ABCDEFGH", `[band] fill 93 / 17 holders opens A–H and NOT J (above MAX_FILL 90), got "${of(HIGH_MINT)}"`);
  const jOpen = opens.find((o) => o.mint === BAND_MINT);
  asrt(jOpen.fill === 80 && jOpen.holders === 6 && jOpen.label === "live config", `[band] J open row: fill 80, holders 6 (got ${jOpen.fill}/${jOpen.holders})`);
  asrt(JSON.stringify(jOpen.params) === JSON.stringify({ minFill: 75, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300 }), `[band] J rows carry the live parameters, got ${JSON.stringify(jOpen.params)}`);
  asrt(opens.filter((o) => o.variant !== "J").every((o) => o.params === undefined && o.fill >= 92), "[band] A–I rows are not extended and still need fill >= 92");
  asrt(candidates.some((c) => c.mint === BAND_MINT && c.fill === 80), "[band] the candidate threshold follows J (a 80% candidate is journaled)");
  asrt(!candidates.some((c) => c.fill < 75), "[band] nothing below the lowest minFill is a candidate");
  asrt(/candidate threshold 75%/.test(out) && /J live config: fill 75-90%, holders>=5, TP 1\.5, SL 0\.7, hold 300s/.test(out), "[band] the startup line shows the live config");

  // P5: the tx carried a SELL event (60%) and then a BUY event (93%) of MULTI_MINT.
  const multi = opens.filter((o) => o.mint === MULTI_MINT);
  asrt(multi.length > 0, "[band] the SECOND event of the transaction was processed (old handler returned after the first)");
  asrt(multi.map((o) => o.variant).sort().join("") === "ADEFH", `[band] with 1 holder only the holder-free variants open, got "${multi.map((o) => o.variant).sort().join("")}"`);
  asrt(multi.every((o) => o.holders === 1 && o.fill === 93), `[band] holders = 1: the sell event's user is not a buyer (got ${multi[0].holders})`);
  asrt(trades.length === opens.length && trades.every((t) => t.exitVenue === "curve" && t.migrated === false && t.reason === "manual stop"), "[band] live curves: ordinary curve exits at the stop");
  const jTrade = trades.find((t) => t.variant === "J");
  asrt(jTrade && jTrade.params.maxFill === 90 && Number.isFinite(jTrade.netPct), "[band] J trade row: params + a result");
}

console.log(JSON.stringify({ pool: withPool.trades[0].ratio, nopool: noPool.trades[0].exitVenue, stop: noPoolStop.trades[0].reason, bandJ: band.opens.filter((o) => o.variant === "J").length }));
console.log("PASS: shadow prices migrated positions from the pool (or journals them unpriced); J trades the live band; all tx events are processed");
