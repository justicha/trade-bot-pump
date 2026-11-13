import "./lib/test-env.mjs";
// Task 8 (M6 + P5): bounded sell retries in the sniper and the copy-trader, and the copy-trader's
// max-hold safety exit.
//
//   M6 sniper      a failed LIVE sell used to be retried by the 2 s poll forever — no counter, no
//                  backoff, no STUCK; the limits never saw the position.
//   M6 copy-trader a failed LIVE sell was only logged; nothing retried until the target sold again.
//   P5 copy-trader a position whose target never sells is sold by the bot after COPY_MAX_HOLD_SEC.
//
// A real `--live` run cannot be spawned (lib/rpc.mjs refuses RPC_MOCK with --live, and tests never
// send). So the policy lives in lib/sell-retry.mjs, and the bots' OWN sell functions are executed
// here: their source is cut out of the bot file and run with every dependency replaced by a mock or
// by the real lib (applyLiveSell, recordStuck, TradeGuard, the journal). `Date` is replaced too —
// that is the fake clock. No network, no keys, no transaction.
//
// Fails without the fix: lib/sell-retry.mjs does not exist; with the old bot source the sniper
// sends on every poll forever and the copy-trader never retries and has no exit timer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const { TradeGuard } = await import("../lib/guards.mjs");
const { TradeJournal, readJournal } = await import("../lib/journal.mjs");
const { netSolForDay, dailyLossBlocked } = await import("../lib/daily-loss.mjs");
const { recordStuck } = await import("../lib/stuck.mjs");
const { applyLiveSell, balanceBeforeSell } = await import("../lib/live-pnl.mjs");
const { roundTripCosts } = await import("../lib/fees.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const { getPrice, calcSellSol } = await import("../lib/pumpfun.mjs");
const { TOKEN_2022_PROGRAM } = await import("../lib/constants.mjs");
const { mskDateKey } = await import("../lib/time.mjs");
const {
  DEFAULT_SELL_MAX_ATTEMPTS, SELL_BACKOFF_BASE_MS, sellBackoffMs, sellDue, noteSellFailure, clearSellRetry, createSellRetry,
} = await import("../lib/sell-retry.mjs");

const TODAY = mskDateKey();
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
const count = (s, re) => (s.match(re) || []).length;
const cut = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  asrt(a >= 0 && b > a, `${what}: source markers found`);
  return src.slice(a, b);
};

// ---------------------------------------------------------------------------------------------
// 1. lib/sell-retry.mjs — the policy itself
// ---------------------------------------------------------------------------------------------
{
  asrt(DEFAULT_SELL_MAX_ATTEMPTS === 3 && SELL_BACKOFF_BASE_MS === 2000, "default 3 attempts, 2 s base backoff");
  asrt(sellBackoffMs(1) === 2000 && sellBackoffMs(2) === 4000 && sellBackoffMs(3) === 8000, "backoff 2000 x 2^(n-1)");
  // The same numbers graduation-sniper uses (its own copy is not touched by this task).
  const grad = read("bots/graduation-sniper/graduation.mjs");
  asrt(/const SELL_MAX_ATTEMPTS = numOr\(process\.env\.SELL_MAX_ATTEMPTS, 3, "SELL_MAX_ATTEMPTS"\);/.test(grad), "graduation: SELL_MAX_ATTEMPTS default is 3 — the lib default matches it");
  asrt(count(grad, /2000 \* 2 \*\* \(attempt - 1\)/g) >= 3, "graduation: backoff is 2000 * 2 ** (attempt - 1) — the lib formula matches it");
  asrt(!/sell-retry/.test(grad), "graduation is not switched to the helper (left untouched)");

  const pos = {};
  asrt(sellDue(pos, 1000) === true && sellDue(null, 1000) === true, "a position that never failed is due");
  const f1 = noteSellFailure(pos, { maxAttempts: 3, now: 1000 });
  asrt(f1.attempt === 1 && f1.stuck === false && f1.backoffMs === 2000 && pos.attempts === 1 && pos.nextSellAt === 3000, "1st failure: attempt 1, retry at now + 2000");
  asrt(sellDue(pos, 2999) === false && sellDue(pos, 3000) === true, "not due before nextSellAt, due at it");
  const f2 = noteSellFailure(pos, { maxAttempts: 3, now: 3000 });
  asrt(f2.attempt === 2 && f2.backoffMs === 4000 && pos.nextSellAt === 7000, "2nd failure: retry at now + 4000");
  const f3 = noteSellFailure(pos, { maxAttempts: 3, now: 7000 });
  asrt(f3.attempt === 3 && f3.stuck === true && f3.backoffMs === 0, "3rd failure of 3: budget gone");
  asrt(noteSellFailure({}, { maxAttempts: 0, now: 0 }).stuck === true && noteSellFailure({}, { maxAttempts: 1, now: 0 }).stuck === true, "maxAttempts 0 / 1: the first failure is final");
  const cleared = clearSellRetry({ attempts: 2, nextSellAt: 9, pendingExit: true, entrySolSol: 0.01 });
  asrt(cleared.attempts === 0 && cleared.nextSellAt === 0 && cleared.pendingExit === false && cleared.entrySolSol === 0.01, "clearSellRetry: fresh budget, nothing else touched");

  // A failure reported for a position that is no longer in the book (a concurrent sale closed it)
  // must not be counted and must never become an assumed loss.
  const positions = new Map();
  const live = { entrySolSol: 0.05 };
  positions.set("M", live);
  let booked = 0;
  const rows = [];
  const r = createSellRetry({ maxAttempts: 1, positions, journal: { write: (x) => rows.push(x) }, recordResult: () => { booked += 1; }, buySol: 0.05, now: () => 0 });
  const stale = r.fail("M", { entrySolSol: 0.05 }, new Error("x"));
  asrt(stale.stale === true && booked === 0 && rows.length === 0 && positions.has("M"), "stale position: no row, no loss, the live position stays");
  const real = r.fail("M", live, new Error("boom"));
  asrt(real.stuck === true && booked === 1 && !positions.has("M"), "the live position with maxAttempts 1: STUCK on the first failure");
  asrt(rows.length === 2 && rows[0].type === "sell_failed" && rows[1].type === "stuck" && rows[1].lossAssumed === true && rows[1].pnlSol === -0.05, "rows: sell_failed, then stuck with the assumed loss");

  // The code of the helper, without its comments.
  const lib = read("lib/sell-retry.mjs").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  asrt(!/sendRawTransaction|simulateThenSend|sendTxWithRetry|buildVersionedTx|createBurn|burnChecked/.test(lib), "lib/sell-retry.mjs builds and sends nothing");
  asrt(!/pnlSol\s*[:=]/.test(lib) && !/applyLiveSell|liveSellAccounting/.test(lib), "lib/sell-retry.mjs computes no PnL of its own (recordStuck books the assumed loss)");
}

// ---------------------------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------------------------
const BUY_SOL = 0.05;
const FEE = 0.000455;
const RENT = 0.00207408;
const BAL = 40_000_000n;
const V_TOK = 1_073_000_000_000_000n;
const P0 = 30e9 / 1.073e15;
const T0 = 1_800_000_000_000;
const TARGET = Keypair.generate().publicKey.toBase58();
const stateAt = (mult, complete = false) => ({
  virtualSolReserves: BigInt(Math.round(30e9 * mult)),
  virtualTokenReserves: V_TOK,
  realSolReserves: 5_000_000_000n,
  complete,
  creator: null,
  isMayhemMode: false,
});
const proceedsFor = (amount) => Math.round((0.06 * Number(amount)) / Number(BAL) * 1e9) / 1e9;
const exSold = (amount) => ({
  found: true, feeSol: FEE, solDeltaSol: proceedsFor(amount), solReceivedSol: proceedsFor(amount), rentReturnedSol: 0,
  tokensDelta: -amount, tokensReceived: 0n, tokensSold: amount, err: null,
});
// A tx that LANDED and FAILED: the fee is gone, no tokens left the wallet.
const exFailed = () => ({
  found: true, feeSol: FEE, solDeltaSol: -FEE, solReceivedSol: 0, rentReturnedSol: 0,
  tokensDelta: 0n, tokensReceived: 0n, tokensSold: 0n, err: { InstructionError: [2, { Custom: 6003 }] },
});

// One isolated bot "world": fake clock, real guard / journal / ledger, mocked chain.
//   plan(n) -> outcome of send number n (0-based): "ok" | "fail" (landed, failed on-chain) |
//              "landed" (confirm error but the sale is on-chain) | "sim" (simulation refused)
function mkWorld({ maxAttempts = 3, maxConsecLosses = 3, plan = () => "ok", bot = "t" } = {}) {
  const w = {
    clock: { t: T0 },
    logs: [],
    results: [],
    stops: [],
    sends: [], // clock time of every simulateThenSend call
    amounts: [], // token amount of every sell instruction built
    closes: [],
    balance: BAL,
    mult: 2.5,
    complete: false,
    plan,
    positions: new Map(),
    mint: Keypair.generate().publicKey.toBase58(),
    wallet: { publicKey: Keypair.generate().publicKey },
    guard: new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses }),
    journal: new TradeJournal({ bot, dir: fs.mkdtempSync(path.join(os.tmpdir(), "sell-retry-journal-")) }),
    session: new SessionLedger({ label: "T", mode: "LIVE" }),
    failCalls: 0,
  };
  w.FakeDate = class FakeDate extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(w.clock.t);
    }
    static now() {
      return w.clock.t;
    }
  };
  w.log = (m) => w.logs.push(String(m));
  w.recordResult = (pnlSol, opts) => {
    w.results.push({ pnlSol, opts });
    w.guard.recordResult(pnlSol, opts);
    if (w.guard.halted) w.stops.push(w.guard.haltReason);
  };
  const retry = createSellRetry({
    maxAttempts,
    positions: w.positions,
    journal: w.journal,
    recordResult: w.recordResult,
    session: w.session,
    log: w.log,
    buySol: BUY_SOL,
    fields: { sessionId: "S1", mode: "LIVE" },
    now: () => w.clock.t,
  });
  // The real helper behind a counter, so "the DRY RUN never reaches it" can be asserted.
  w.sellRetry = { ...retry, fail: (...a) => { w.failCalls += 1; return retry.fail(...a); } };
  w.rows = (type) => readJournal(w.journal.dir).filter((r) => !type || r.type === type);
  // Every dependency a sell function of either bot may touch.
  w.deps = {
    Date: w.FakeDate,
    positions: w.positions,
    PublicKey,
    log: w.log,
    getBondingCurveState: async () => stateAt(w.mult, w.complete),
    getPrice,
    calcSellSol,
    roundTripCosts,
    BUY_SOL,
    SLIPPAGE_BPS: 500,
    recordResult: w.recordResult,
    recordStuck,
    session: w.session,
    journal: w.journal,
    getAssociatedTokenAddressSync,
    wallet: w.wallet,
    TOKEN_2022_PROGRAM,
    connection: { getTokenAccountBalance: async () => ({ value: { amount: w.balance.toString() } }) },
    computeBudgetIxs: () => [],
    sellIx: (_owner, _mint, amount) => {
      w.amounts.push(amount);
      return { amount };
    },
    buildVersionedTx: async (_wallet, ixs) => ({ ixs }),
    simulateThenSend: async () => {
      const n = w.sends.length;
      w.sends.push(w.clock.t);
      const outcome = w.plan(n);
      const amount = w.amounts[w.amounts.length - 1];
      if (outcome === "ok") {
        w.balance -= amount;
        return "SIG_OK";
      }
      if (outcome === "landed") {
        w.balance -= amount;
        throw Object.assign(new Error("network error: connection reset"), { sig: "SIG_LANDED" });
      }
      if (outcome === "sim") throw new Error("simulation failed: instruction 2: custom program error 6003");
      throw Object.assign(new Error('tx SIG_FAIL failed on-chain: {"InstructionError":[2,{"Custom":6003}]}'), { sig: "SIG_FAIL" });
    },
    readExecution: async (sig) => {
      if (sig === "SIG_OK" || sig === "SIG_LANDED") return exSold(w.amounts[w.amounts.length - 1]);
      if (sig === "SIG_FAIL") return exFailed();
      return { found: false };
    },
    applyLiveSell,
    balanceBeforeSell,
    ataCloser: { schedule: (mint, o) => w.closes.push({ mint, ...o }) },
    sellRetry: w.sellRetry,
    stopping: false,
    SELL_MAX_ATTEMPTS: maxAttempts,
  };
  // A missing dependency would surface as "X is not defined" inside the bot's own catch.
  w.assertClean = (label) => asrt(!w.logs.some((l) => /is not defined|is not a function|Cannot read/.test(l)), `${label}: the bot code ran against complete mocks (${w.logs.find((l) => /is not defined|is not a function|Cannot read/.test(l))})`);
  return w;
}

function load(code, deps, exportsExpr) {
  const names = Object.keys(deps);
  return new Function(...names, `"use strict";\n${code}\nreturn ${exportsExpr};`)(...names.map((n) => deps[n]));
}

// Call fn() every stepMs of fake time, `ticks` times (the bots' 2 s timers, at a finer grain).
async function tick(w, fn, { stepMs = 500, ticks = 1 } = {}) {
  for (let i = 0; i < ticks; i++) {
    w.clock.t += stepMs;
    await fn();
  }
}

// ---------------------------------------------------------------------------------------------
// 2. SNIPER — the real executeSell + checkPositions from bots/sniper/sniper.mjs
// ---------------------------------------------------------------------------------------------
const sniperSrc = read("bots/sniper/sniper.mjs");
const sniperCode =
  cut(sniperSrc, "async function executeSell(", "function costsCosts(", "sniper executeSell") +
  "\n" +
  cut(sniperSrc, "let checking = false;", "// Reserve the cooldown + opening slot", "sniper checkPositions");

function mkSniper(opts = {}) {
  const w = mkWorld({ ...opts, bot: "sniper" });
  w.exits = [];
  const deps = {
    ...w.deps,
    DRY_RUN: opts.dry === true,
    streamAgeMs: () => null,
    recordExit: (mint, pos, info) => w.exits.push({ mint, pos, ...info }),
    totalPnl: 0,
    totalTrades: 0,
    wins: 0,
    fmtUsd: () => "n/a",
    solPerTokenToUsd: () => null,
    rawSolPerTokenToWhole: (x) => x,
    SESSION_ID: "S1",
    PARAMS_HASH: "P1",
    GIT_SHA: "G1",
    samplePostExit: async () => {},
    resolvePrice: async () => ({ price: P0 * w.mult, source: "stream", ageMs: 0, state: null }),
    confirmExitPrice: async () => ({ price: getPrice(stateAt(w.mult)), state: stateAt(w.mult) }),
    TAKE_PROFIT: 2,
    STOP_LOSS: 0.5,
    TIMEOUT_SEC: 120,
    PHANTOM_THROTTLE_MS: 5000,
    phantomLogged: new Map(),
    round9: (x) => Math.round(x * 1e9) / 1e9,
  };
  Object.assign(w, load(sniperCode, deps, "{ executeSell, checkPositions, stats: () => ({ totalPnl, totalTrades, wins }) }"));
  // pos.tokens is the bot's own estimate from the buy; the wallet (BAL) is what actually gets sold
  // and what a failed attempt must journal.
  w.pos = {
    tokens: BAL + 7n, entryPrice: P0, entrySolSol: 0.05, entrySource: "chain-meta", buyFeeSol: FEE,
    ataRentSol: RENT, ataRentKnown: true, entryTime: T0, peak: 1, mayhemMode: false,
  };
  w.positions.set(w.mint, w.pos);
  return w;
}
// What a normal (first-try) full sale of that position books.
const sniperRef = applyLiveSell(
  { entrySolSol: 0.05, entrySource: "chain-meta", buyFeeSol: FEE, ataRentSol: RENT, ataRentKnown: true },
  { buySol: BUY_SOL, ex: exSold(BAL), quoteSol: Number(calcSellSol(stateAt(2.5), BAL)) / 1e9, soldRaw: BAL, totalRaw: BAL },
);
const exitFacts = (e) => JSON.stringify({ pnlSol: e.pnlSol, costs: e.costs, live: e.live, ratio: e.ratio, priceSource: e.priceSource });

// 2a. control: the sale succeeds at once
let sniperControl;
{
  const w = mkSniper();
  await w.checkPositions();
  asrt(w.sends.length === 1 && w.exits.length === 1 && !w.positions.has(w.mint), "[sniper control] one send, one exit, position closed");
  asrt(w.exits[0].pnlSol === sniperRef.acc.pnlSol && w.exits[0].reason === "take-profit 2.5x", `[sniper control] pnlSol from applyLiveSell (${sniperRef.acc.pnlSol}), got ${w.exits[0].pnlSol}`);
  asrt(w.failCalls === 0 && w.rows().length === 0 && w.pos.attempts === undefined, "[sniper control] a successful sale leaves no retry state and no row");
  w.assertClean("[sniper control]");
  sniperControl = w;
}

// 2b. fails once, then goes through: one sale, the same PnL, exactly 2 sends, not before the backoff
{
  const w = mkSniper({ plan: (n) => (n === 0 ? "fail" : "ok") });
  await w.checkPositions(); // t0: attempt 1 lands and fails on-chain
  asrt(w.sends.length === 1 && w.exits.length === 0 && w.positions.get(w.mint) === w.pos, "[sniper retry] the failed sale keeps the position");
  asrt(w.pos.attempts === 1 && w.pos.nextSellAt === T0 + 2000, `[sniper retry] attempt 1, next sale not before t0+2000 (got ${w.pos.nextSellAt - T0})`);
  asrt(w.logs.some((l) => /^ {2}sell failed: tx SIG_FAIL failed on-chain/.test(l)), "[sniper retry] the original 'sell failed' line is still logged");

  // The old code sold again on EVERY poll. Three polls inside the backoff: nothing is sent, but
  // the position is still tracked (the peak follows the price).
  w.mult = 3;
  await tick(w, w.checkPositions, { stepMs: 500, ticks: 3 }); // t0+500 … t0+1500
  w.clock.t = T0 + 1999;
  await w.checkPositions();
  asrt(w.sends.length === 1, `[sniper retry] no send before the backoff is over (sends ${w.sends.length})`);
  asrt(Math.abs(w.pos.peak - 3) < 1e-9, `[sniper retry] the position is still tracked while it backs off (peak ${w.pos.peak})`);
  w.mult = 2.5;

  w.clock.t = T0 + 2000;
  await w.checkPositions();
  asrt(w.sends.length === 2 && w.sends[1] === T0 + 2000, "[sniper retry] the 2nd send happens at t0+2000");
  asrt(w.exits.length === 1 && !w.positions.has(w.mint), "[sniper retry] exactly one sale is booked, position closed");
  asrt(exitFacts(w.exits[0]) === exitFacts(sniperControl.exits[0]), "[sniper retry] the retried sale is booked exactly like a first-try sale (pnlSol, costs, live fields)");
  asrt(w.results.length === 1 && w.results[0].pnlSol === sniperRef.acc.pnlSol && w.results[0].opts.guardPnlSol === sniperRef.guardPnlSol, "[sniper retry] the guard gets one result: pnlSol + guardPnlSol");
  asrt(w.session.sells === 1 && w.session.unresolved.length === 0 && w.stats().totalTrades === 1, "[sniper retry] ledger: one sell, nothing dropped");
  asrt(w.closes.length === 1 && w.closes[0].mint === w.mint && w.closes[0].venue === "curve", "[sniper retry] the ATA close is scheduled once, after the sale");

  const failed = w.rows("sell_failed");
  asrt(failed.length === 1 && w.rows("stuck").length === 0, `[sniper retry] journal: one sell_failed row, no stuck (got ${failed.length})`);
  const r = failed[0];
  asrt(r.mint === w.mint && r.attempt === 1 && r.maxAttempts === 3 && r.nextRetryMs === 2000 && r.sig === "SIG_FAIL", "[sniper retry] sell_failed: mint, attempt, maxAttempts, nextRetryMs, sig");
  asrt(/failed on-chain/.test(r.error) && r.exitReason === "take-profit 2.5x" && r.tokens === BAL.toString() && r.venue === "curve" && r.sessionId === "S1" && r.bot === "sniper", "[sniper retry] sell_failed: error, exit reason, wallet tokens, run metadata");

  await tick(w, w.checkPositions, { stepMs: 2000, ticks: 5 });
  asrt(w.sends.length === 2 && w.exits.length === 1, "[sniper retry] nothing more is sent after the sale");
  w.assertClean("[sniper retry]");
}

// 2c. always fails: exactly SELL_MAX_ATTEMPTS sends, then STUCK with an assumed loss the limits see
{
  const w = mkSniper({ plan: () => "fail", maxConsecLosses: 1 });
  await w.checkPositions(); // t0
  await tick(w, w.checkPositions, { stepMs: 500, ticks: 120 }); // 60 s of polling, 4x finer than the bot
  asrt(w.sends.length === 3, `[sniper stuck] exactly SELL_MAX_ATTEMPTS (3) sends in 60 s of polling, got ${w.sends.length}`);
  asrt(JSON.stringify(w.sends.map((t) => t - T0)) === "[0,2000,6000]", `[sniper stuck] sends at 0, +2 s, +4 s more (backoff), got ${JSON.stringify(w.sends.map((t) => t - T0))}`);
  asrt(!w.positions.has(w.mint) && w.exits.length === 0 && w.closes.length === 0, "[sniper stuck] position removed; no sale booked; the ATA is NOT closed (tokens are still there)");
  asrt(w.balance === BAL && w.amounts.every((a) => a === BAL), "[sniper stuck] the tokens stay in the wallet (nothing burned, only sells were built)");

  const failed = w.rows("sell_failed");
  asrt(failed.length === 3 && JSON.stringify(failed.map((r) => [r.attempt, r.nextRetryMs])) === "[[1,2000],[2,4000],[3,null]]", `[sniper stuck] three sell_failed rows with the backoff, got ${JSON.stringify(failed.map((r) => [r.attempt, r.nextRetryMs]))}`);
  const stuck = w.rows("stuck");
  asrt(stuck.length === 1, `[sniper stuck] one stuck row, got ${stuck.length}`);
  const s = stuck[0];
  asrt(s.lossAssumed === true && s.pnlSol === -0.05 && s.entrySolSol === 0.05, `[sniper stuck] the remaining entry is the assumed loss (pnlSol ${s.pnlSol}, lossAssumed ${s.lossAssumed})`);
  asrt(s.attempts === 3 && s.maxAttempts === 3 && s.tokens === BAL.toString() && /^sell failed 3\/3: /.test(s.reason) && s.exitReason === "take-profit 2.5x" && s.mode === "LIVE", "[sniper stuck] stuck row: attempts, tokens, reason, exit reason");
  asrt(s.ataRentSol === RENT, "[sniper stuck] the locked ATA rent is journaled apart from the loss");

  asrt(w.results.length === 1 && w.results[0].pnlSol === -0.05 && w.results[0].opts === undefined, "[sniper stuck] the guard is told once: -entry, classified by pnlSol");
  asrt(w.guard.consecLosses === 1 && w.guard.halted === true && w.stops.length === 1, "[sniper stuck] MAX_CONSEC_LOSSES sees the loss (limit 1 -> halted, stop requested)");
  const net = netSolForDay(readJournal(w.journal.dir), TODAY);
  asrt(net === -0.05, `[sniper stuck] the day's net from the journal is -0.05, got ${net}`);
  asrt(dailyLossBlocked({ netSol: net, limitSol: 0.05 }).blocked === true, "[sniper stuck] a daily loss limit of 0.05 blocks new buys");
  asrt(w.logs.some((l) => /ALERT: .* STUCK \(attempts=3\/3\).*scripts\/rescue-sell\.mjs/.test(l)), "[sniper stuck] ALERT names the attempts and points at rescue-sell");
  asrt(w.session.unresolved.length === 1 && /STUCK sell failed 3\/3/.test(w.session.unresolved[0]) && w.session.sells === 0, "[sniper stuck] the session report lists it as unresolved, not as a sale");

  const before = w.sends.length;
  await tick(w, w.checkPositions, { stepMs: 2000, ticks: 30 });
  asrt(w.sends.length === before && w.rows("stuck").length === 1 && w.results.length === 1, "[sniper stuck] after STUCK not a single further send, row or loss");
  w.assertClean("[sniper stuck]");
}

// 2d. a refused simulation is a failed attempt too (nothing was sent, so no signature)
{
  const w = mkSniper({ plan: () => "sim" });
  await w.checkPositions();
  const r = w.rows("sell_failed");
  asrt(r.length === 1 && r[0].sig === null && /simulation failed/.test(r[0].error) && w.pos.attempts === 1, "[sniper sim] simulation failure: attempt counted, sig null");
}

// 2e. reconciled branch (C2): the confirm failed but the sale is on-chain — NOT a failed attempt
{
  const w = mkSniper({ plan: () => "landed" });
  await w.checkPositions();
  asrt(w.sends.length === 1 && w.exits.length === 1 && !w.positions.has(w.mint), "[sniper reconciled] the landed sale is booked and closes the position");
  asrt(w.exits[0].reason === "take-profit 2.5x (reconciled)" && w.exits[0].pnlSol === sniperRef.acc.pnlSol, "[sniper reconciled] booked as a reconciled sale with the same PnL");
  asrt(w.failCalls === 0 && w.rows("sell_failed").length === 0 && w.rows("stuck").length === 0 && w.pos.attempts === undefined, "[sniper reconciled] no attempt counted, no sell_failed, no stuck");
  asrt(w.guard.consecLosses === 0 && w.closes.length === 1, "[sniper reconciled] a winning sale for the guard; ATA close scheduled");
  await tick(w, w.checkPositions, { stepMs: 2000, ticks: 5 });
  asrt(w.sends.length === 1, "[sniper reconciled] nothing is re-sent");
  w.assertClean("[sniper reconciled]");
}

// 2f. the budget is per position and survives a pause between triggers
{
  const w = mkSniper({ plan: () => "fail" });
  await w.checkPositions(); // attempt 1
  w.mult = 1.2; // price falls back: no rule fires
  await tick(w, w.checkPositions, { stepMs: 2000, ticks: 5 });
  asrt(w.sends.length === 1 && w.pos.attempts === 1 && w.positions.has(w.mint), "[sniper budget] no trigger -> no sale, the attempt count is kept");
  w.mult = 2.5;
  await tick(w, w.checkPositions, { stepMs: 500, ticks: 40 });
  asrt(w.sends.length === 3 && !w.positions.has(w.mint), `[sniper budget] the remaining 2 attempts are used, then STUCK (sends ${w.sends.length})`);
}

// 2g. DRY RUN is unchanged: same exit, same numbers, the retry helper is never reached
{
  const w = mkSniper({ dry: true, plan: () => "fail" });
  await w.checkPositions();
  const ratio = getPrice(stateAt(2.5)) / P0;
  const costs = roundTripCosts({ buySol: BUY_SOL, ratio });
  asrt(w.sends.length === 0 && w.amounts.length === 0, "[sniper dry] nothing is built or sent");
  asrt(w.exits.length === 1 && w.exits[0].pnlSol === costs.netPnl && w.exits[0].reason === "take-profit 2.5x" && w.exits[0].priceSource === "account", `[sniper dry] exit booked with roundTripCosts netPnl (${costs.netPnl}), got ${w.exits[0]?.pnlSol}`);
  asrt(w.results.length === 1 && w.results[0].pnlSol === costs.netPnl && w.results[0].opts === undefined, "[sniper dry] guard result as before");
  asrt(w.session.sells === 1 && Math.abs(w.session.receivedSol - BUY_SOL * ratio) < 1e-9, "[sniper dry] ledger as before");
  asrt(!w.positions.has(w.mint) && w.failCalls === 0 && w.rows().length === 0 && w.pos.attempts === undefined && w.pos.nextSellAt === undefined, "[sniper dry] no retry state, no new rows");
  asrt(w.logs.some((l) => /\[DRY RUN\] would sell: /.test(l)), "[sniper dry] the usual dry-run line");
  w.assertClean("[sniper dry]");
  // …and the dry branch of the source itself does not mention the helper.
  const dryBranch = cut(sniperSrc, "  if (DRY_RUN) {\n    // A confirmed exit already carries", "  // Wallet balance read before this attempt", "sniper dry branch");
  asrt(!/sellRetry|attempts|nextSellAt/.test(dryBranch), "[sniper dry] the DRY branch of executeSell has no retry code");
}

// 2h. sniper wiring
{
  asrt(/import \{ createSellRetry, DEFAULT_SELL_MAX_ATTEMPTS \} from "\.\.\/\.\.\/lib\/sell-retry\.mjs";/.test(sniperSrc), "sniper imports the helper");
  asrt(/const SELL_MAX_ATTEMPTS = numOr\(process\.env\.SELL_MAX_ATTEMPTS, DEFAULT_SELL_MAX_ATTEMPTS, "SELL_MAX_ATTEMPTS"\);/.test(sniperSrc), "sniper: the same env var SELL_MAX_ATTEMPTS, the shared default");
  const ctor = cut(sniperSrc, "const sellRetry = createSellRetry({", "});", "sniper sellRetry");
  asrt(/maxAttempts: SELL_MAX_ATTEMPTS/.test(ctor) && /positions,/.test(ctor) && /journal,/.test(ctor) && /recordResult,/.test(ctor) && /session,/.test(ctor) && /buySol: BUY_SOL/.test(ctor), "sniper: the helper gets the book, the journal, the bot's recordResult (guard + stop), the ledger and BUY_SOL");
  const sell = cut(sniperSrc, "async function executeSell(", "function costsCosts(", "sniper executeSell");
  asrt(count(sell, /sellRetry\.fail\(/g) === 1 && count(sniperSrc, /sellRetry\.fail\(/g) === 1, "sniper: one failure hook");
  const hook = sell.indexOf("sellRetry.fail(");
  asrt(sell.lastIndexOf("(reconciled after confirm error)", hook) > 0 && sell.lastIndexOf("return;", hook) > sell.lastIndexOf("(reconciled after confirm error)", hook), "sniper: the hook sits after the reconciled branch has returned");
  asrt(sell.indexOf("log(`  no tokens in wallet`);") < hook && sell.indexOf('"curve complete: no AMM sell in this bot"') < hook, "sniper: 'no tokens in wallet' and 'curve complete' are separate, earlier branches");
  const poll = cut(sniperSrc, "let checking = false;", "// Reserve the cooldown + opening slot", "sniper checkPositions");
  const gate = poll.indexOf("if (!sellRetry.due(pos)) continue;");
  asrt(gate > poll.indexOf("if (candRatio > (pos.peak || 1)) pos.peak = candRatio;") && gate < poll.indexOf("await confirmExitPrice(mint)") && gate < poll.indexOf("await executeSell("), "sniper: the backoff gate is after the price/peak tracking and before the confirm + sell");
  asrt(!/SELL_MAX_ATTEMPTS/.test(cut(sniperSrc, "const PARAMS_HASH = paramsHash({", "});", "sniper paramsHash")), "sniper: paramsHash input is unchanged (DRY journals stay comparable)");
}

// ---------------------------------------------------------------------------------------------
// 3. COPY-TRADER — the real copySell / checkExits from bots/copy-trader/watcher.mjs
// ---------------------------------------------------------------------------------------------
const copySrc = read("bots/copy-trader/watcher.mjs");
const copyCode = cut(copySrc, "// ---- exit: sell + bounded retries + max-hold (M6, P5)", "// Final shutdown", "copy-trader exit section");

function mkCopy(opts = {}) {
  const w = mkWorld({ ...opts, bot: "copy-trader" });
  const dry = opts.dry === true;
  const deps = {
    ...w.deps,
    DRY_RUN: dry,
    SELL_PCT: opts.sellPct ?? 100,
    MAX_HOLD_SEC: opts.maxHoldSec ?? 1800,
    totalPnl: 0,
    totalTrades: 0,
  };
  Object.assign(w, load(copyCode, deps, "{ copySell, checkExits, selling, stats: () => ({ totalPnl, totalTrades }) }"));
  w.pos = dry
    ? { entryPrice: P0, entrySolSol: BUY_SOL, entryTime: T0, copiedFrom: TARGET }
    : { entryPrice: P0, entrySolSol: 0.05, entrySource: "chain-meta", buyFeeSol: FEE, ataRentSol: RENT, ataRentKnown: true, entryTime: T0, copiedFrom: TARGET };
  w.positions.set(w.mint, w.pos);
  return w;
}
const copyRef = applyLiveSell(
  { entrySolSol: 0.05, entrySource: "chain-meta", buyFeeSol: FEE, ataRentSol: RENT, ataRentKnown: true },
  { buySol: BUY_SOL, ex: exSold(BAL), quoteSol: Number(calcSellSol(stateAt(2.5), BAL)) / 1e9, soldRaw: BAL, totalRaw: BAL },
);

// 3a. control: the target sells, our sale goes through
{
  const w = mkCopy();
  await w.copySell(w.mint, TARGET);
  asrt(w.sends.length === 1 && !w.positions.has(w.mint) && w.results.length === 1 && w.results[0].pnlSol === copyRef.acc.pnlSol, "[copy control] one send, booked through applyLiveSell, position closed");
  asrt(w.logs.includes(`COPY SELL from ${TARGET.slice(0, 8)}...`), "[copy control] the log line of a target-driven sale is unchanged");
  asrt(w.failCalls === 0 && w.rows().length === 0 && w.closes.length === 1, "[copy control] no retry state, no rows; ATA close scheduled");
  w.assertClean("[copy control]");
}

// 3b. the sale fails -> the exit timer retries it, WITHOUT another sale by the target
{
  const w = mkCopy({ plan: (n) => (n === 0 ? "fail" : "ok") });
  await w.copySell(w.mint, TARGET); // the target sold; our sale lands and fails
  asrt(w.sends.length === 1 && w.positions.get(w.mint) === w.pos && w.results.length === 0, "[copy retry] the failed sale keeps the position");
  asrt(w.pos.pendingExit === true && w.pos.attempts === 1 && w.pos.nextSellAt === T0 + 2000 && w.pos.exitReason === "target sold", "[copy retry] position marked pendingExit, attempt 1, retry at t0+2000");

  await tick(w, w.checkExits, { stepMs: 500, ticks: 3 });
  w.clock.t = T0 + 1999;
  await w.checkExits();
  asrt(w.sends.length === 1, "[copy retry] the timer does not sell before the backoff is over");
  asrt(!w.logs.some((l) => /is backing off/.test(l)) && w.logs.filter((l) => /^COPY SELL/.test(l)).length === 1, "[copy retry] the timer itself waits for the backoff (it does not even start a sale)");
  // The target sells once more inside the backoff: no extra attempt is burned.
  await w.copySell(w.mint, TARGET);
  asrt(w.sends.length === 1 && w.pos.attempts === 1 && w.logs.some((l) => /is backing off after a failed attempt/.test(l)), "[copy retry] another target sale inside the backoff does not send");

  w.clock.t = T0 + 2000;
  await w.checkExits(); // no new target sale — the timer alone
  asrt(w.sends.length === 2 && w.sends[1] === T0 + 2000, `[copy retry] the timer retries at t0+2000 (sends ${w.sends.length})`);
  asrt(!w.positions.has(w.mint) && w.results.length === 1 && w.results[0].pnlSol === copyRef.acc.pnlSol && w.results[0].opts.guardPnlSol === copyRef.guardPnlSol, "[copy retry] the retried sale is booked exactly like a first-try sale");
  asrt(w.session.sells === 1 && w.closes.length === 1 && w.stats().totalTrades === 1, "[copy retry] ledger: one sell; ATA close scheduled once");
  asrt(w.logs.some((l) => l === `COPY SELL from ${TARGET.slice(0, 8)}... (retry 2/3: target sold)`), "[copy retry] the retry is visible in the log");
  const failed = w.rows("sell_failed");
  asrt(failed.length === 1 && failed[0].attempt === 1 && failed[0].maxAttempts === 3 && failed[0].nextRetryMs === 2000 && failed[0].sig === "SIG_FAIL" && failed[0].copiedFrom === TARGET && failed[0].exitReason === "target sold" && failed[0].tokens === BAL.toString() && failed[0].bot === "copy-trader", "[copy retry] sell_failed row: attempt, backoff, sig, copiedFrom, exit reason, tokens");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 5 });
  asrt(w.sends.length === 2 && w.rows("stuck").length === 0, "[copy retry] nothing more is sent");
  w.assertClean("[copy retry]");
}

// 3c. always fails -> exactly SELL_MAX_ATTEMPTS sends, then STUCK the limits see
{
  const w = mkCopy({ plan: () => "fail", maxConsecLosses: 1 });
  await w.copySell(w.mint, TARGET);
  await tick(w, w.checkExits, { stepMs: 500, ticks: 120 });
  asrt(JSON.stringify(w.sends.map((t) => t - T0)) === "[0,2000,6000]", `[copy stuck] 3 sends at 0, +2 s, +4 s more; got ${JSON.stringify(w.sends.map((t) => t - T0))}`);
  const stuck = w.rows("stuck");
  asrt(stuck.length === 1 && stuck[0].lossAssumed === true && stuck[0].pnlSol === -0.05 && stuck[0].attempts === 3 && stuck[0].maxAttempts === 3 && stuck[0].copiedFrom === TARGET && stuck[0].tokens === BAL.toString(), "[copy stuck] stuck row: assumed loss of the entry, attempts, copiedFrom, tokens");
  asrt(w.rows("sell_failed").length === 3, "[copy stuck] three sell_failed rows");
  asrt(!w.positions.has(w.mint) && w.closes.length === 0 && w.balance === BAL, "[copy stuck] position removed, ATA not closed, tokens still in the wallet");
  asrt(w.guard.consecLosses === 1 && w.guard.halted === true && w.stops.length === 1, "[copy stuck] MAX_CONSEC_LOSSES sees the loss");
  const net = netSolForDay(readJournal(w.journal.dir), TODAY);
  asrt(net === -0.05 && dailyLossBlocked({ netSol: net, limitSol: 0.05 }).blocked === true, `[copy stuck] the day's net is -0.05 and a 0.05 daily limit blocks (net ${net})`);
  asrt(w.logs.some((l) => /ALERT: .* STUCK \(attempts=3\/3\).*scripts\/rescue-sell\.mjs/.test(l)), "[copy stuck] ALERT with the rescue hint");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 30 });
  await w.copySell(w.mint, TARGET);
  asrt(w.sends.length === 3 && w.results.length === 1, "[copy stuck] after STUCK nothing is sent, not even on a new target sale");
  w.assertClean("[copy stuck]");
}

// 3d. reconciled branch: the confirm failed, the sale is on-chain — not a failure
{
  const w = mkCopy({ plan: () => "landed" });
  await w.copySell(w.mint, TARGET);
  asrt(w.sends.length === 1 && !w.positions.has(w.mint) && w.results.length === 1 && w.results[0].pnlSol === copyRef.acc.pnlSol, "[copy reconciled] the landed sale is booked and closes the position");
  asrt(w.failCalls === 0 && w.rows().length === 0 && w.pos.pendingExit === undefined && w.pos.attempts === undefined && w.closes.length === 1, "[copy reconciled] no attempt, no rows, no pendingExit");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 5 });
  asrt(w.sends.length === 1, "[copy reconciled] the timer has nothing to retry");
}

// 3e. one sale per mint at a time: two triggers together sell once
{
  const w = mkCopy();
  await Promise.all([w.copySell(w.mint, TARGET), w.copySell(w.mint, TARGET), w.checkExits()]);
  asrt(w.sends.length === 1 && w.results.length === 1 && w.failCalls === 0 && w.selling.size === 0, `[copy queue] concurrent triggers: one send, one booking (sends ${w.sends.length})`);
}

// 3f. SELL_PCT < 100: a retried partial sale leaves a normal open remainder with a fresh budget
{
  const w = mkCopy({ sellPct: 50, plan: (n) => (n === 0 ? "fail" : "ok") });
  await w.copySell(w.mint, TARGET);
  w.clock.t = T0 + 2000;
  await w.checkExits();
  asrt(w.sends.length === 2 && w.amounts[1] === BAL / 2n && w.positions.get(w.mint) === w.pos, "[copy partial] the retry sells the COPY_SELL_PCT share; the position stays");
  asrt(w.pos.pendingExit === false && w.pos.attempts === 0 && w.pos.nextSellAt === 0 && w.pos.tokens === BAL / 2n && Math.abs(w.pos.entrySolSol - 0.025) < 1e-9, "[copy partial] remainder: not pending, fresh budget, half the entry");
  asrt(w.closes.length === 0, "[copy partial] a partial sale does not close the ATA");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 10 });
  asrt(w.sends.length === 2, "[copy partial] the remainder is not sold by the timer (until max-hold)");
}

// ---------------------------------------------------------------------------------------------
// 4. P5 — COPY_MAX_HOLD_SEC (safety net, default 1800 s)
// ---------------------------------------------------------------------------------------------
const HOLD_MS = 1800 * 1000;
const dryPnl = (mult) => {
  const pnlPct = (getPrice(stateAt(mult)) / P0 - 1) * 100;
  return BUY_SOL * (pnlPct / 100);
};

// 4a. DRY RUN: the target never sells -> closed by the timeout exactly once, at the curve price
{
  const w = mkCopy({ dry: true });
  w.mult = 1.4;
  w.clock.t = T0 + HOLD_MS - 1;
  await w.checkExits();
  asrt(w.positions.has(w.mint) && w.results.length === 0, "[max-hold dry] one millisecond before the limit: still open");
  w.clock.t = T0 + HOLD_MS;
  await Promise.all([w.checkExits(), w.checkExits()]);
  asrt(!w.positions.has(w.mint) && w.results.length === 1, `[max-hold dry] closed at the limit, exactly once (results ${w.results.length})`);
  asrt(w.results[0].pnlSol === dryPnl(1.4) && w.results[0].opts === undefined && w.session.sells === 1, `[max-hold dry] valued like any dry exit of this bot (${dryPnl(1.4)}), got ${w.results[0].pnlSol}`);
  asrt(w.logs.some((l) => /max hold 1800s reached/.test(l)) && w.logs.includes(`COPY SELL from ${TARGET.slice(0, 8)}... (max-hold timeout)`), "[max-hold dry] the reason is in the log");
  asrt(w.sends.length === 0 && w.rows().length === 0, "[max-hold dry] nothing sent, no rows");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 20 });
  asrt(w.results.length === 1 && w.session.sells === 1, "[max-hold dry] later ticks do not close it again");
  w.assertClean("[max-hold dry]");
}

// 4b. COPY_MAX_HOLD_SEC=0: off — the position is never closed by the timer
{
  const w = mkCopy({ dry: true, maxHoldSec: 0 });
  w.clock.t = T0 + 10 * HOLD_MS;
  await w.checkExits();
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 20 });
  asrt(w.positions.has(w.mint) && w.results.length === 0 && !w.logs.some((l) => /max hold/.test(l)), "[max-hold off] 0 disables the timeout");
  asrt(w.pos.pendingExit === undefined && w.pos.exitFull === undefined, "[max-hold off] the position is not even marked");
}

// 4c. the target sells before the limit: the normal exit; the timeout never fires
{
  const w = mkCopy({ dry: true });
  w.mult = 1.4;
  w.clock.t = T0 + 100_000;
  await w.checkExits();
  await w.copySell(w.mint, TARGET);
  asrt(!w.positions.has(w.mint) && w.results.length === 1 && w.results[0].pnlSol === dryPnl(1.4), "[max-hold early] the target's sale closes the position as before");
  asrt(w.logs.includes(`COPY SELL from ${TARGET.slice(0, 8)}...`) && w.logs.some((l) => /\[DRY RUN\] would sell: \+40\.0%/.test(l)), "[max-hold early] the usual dry-run lines");
  w.clock.t = T0 + HOLD_MS;
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 20 });
  asrt(w.results.length === 1 && w.session.sells === 1 && !w.logs.some((l) => /max hold/.test(l)), "[max-hold early] the timeout does not fire afterwards");
  w.assertClean("[max-hold early]");
}

// 4d. LIVE: the timeout sells the WHOLE balance (even with COPY_SELL_PCT=50) through the same path
{
  const w = mkCopy({ sellPct: 50 });
  w.clock.t = T0 + HOLD_MS;
  await w.checkExits();
  asrt(w.sends.length === 1 && w.amounts[0] === BAL && !w.positions.has(w.mint), `[max-hold live] the whole balance is sold (amount ${w.amounts[0]})`);
  asrt(w.results.length === 1 && w.results[0].pnlSol === copyRef.acc.pnlSol && w.closes.length === 1 && w.rows().length === 0, "[max-hold live] booked through applyLiveSell like any sale; ATA close scheduled");
  await tick(w, w.checkExits, { stepMs: 2000, ticks: 10 });
  asrt(w.sends.length === 1, "[max-hold live] sold once");
  w.assertClean("[max-hold live]");
}

// 4e. LIVE: a failing timeout sale uses the same bounded retries, then STUCK
{
  const w = mkCopy({ plan: () => "fail" });
  w.clock.t = T0 + HOLD_MS;
  await w.checkExits();
  await tick(w, w.checkExits, { stepMs: 500, ticks: 120 });
  asrt(JSON.stringify(w.sends.map((t) => t - T0 - HOLD_MS)) === "[0,2000,6000]", `[max-hold stuck] 3 attempts with the backoff, got ${JSON.stringify(w.sends.map((t) => t - T0 - HOLD_MS))}`);
  const stuck = w.rows("stuck");
  asrt(stuck.length === 1 && stuck[0].lossAssumed === true && stuck[0].pnlSol === -0.05 && stuck[0].exitReason === "max-hold timeout", "[max-hold stuck] STUCK with the assumed loss, exit reason max-hold timeout");
  asrt(w.rows("sell_failed").every((r) => r.exitReason === "max-hold timeout") && !w.positions.has(w.mint), "[max-hold stuck] every failed attempt carries the reason");
}

// 4f. LIVE: the curve is complete at the timeout -> the existing STUCK branch (no AMM sell here)
{
  const w = mkCopy();
  w.complete = true;
  w.clock.t = T0 + HOLD_MS;
  await w.checkExits();
  const stuck = w.rows("stuck");
  asrt(w.sends.length === 0 && stuck.length === 1 && stuck[0].reason === "curve complete: no AMM sell in this bot" && stuck[0].lossAssumed === true && !w.positions.has(w.mint), "[max-hold complete] completed curve: STUCK as before, nothing sent");
  asrt(w.failCalls === 0 && w.rows("sell_failed").length === 0, "[max-hold complete] not a failed attempt");
}

// 4g. DRY RUN, target-driven exit: identical to before (and the retry helper is never reached)
{
  const w = mkCopy({ dry: true, plan: () => "fail" });
  w.mult = 0.8;
  await w.copySell(w.mint, TARGET);
  asrt(w.results.length === 1 && w.results[0].pnlSol === dryPnl(0.8) && w.session.sells === 1 && Math.abs(w.session.receivedSol - (BUY_SOL + dryPnl(0.8))) < 1e-9, "[copy dry] guard + ledger exactly as before");
  asrt(!w.positions.has(w.mint) && w.sends.length === 0 && w.failCalls === 0 && w.rows().length === 0, "[copy dry] nothing sent, no retry, no rows");
  const dryBranch = cut(copyCode, "  if (DRY_RUN) {", "  // Token balance BEFORE this sale", "copy-trader dry branch");
  asrt(!/sellRetry|attempts|pendingExit|exitFull/.test(dryBranch), "[copy dry] the DRY branch of copySell has no retry code");
}

// 4h. copy-trader wiring
{
  asrt(/import \{ createSellRetry, DEFAULT_SELL_MAX_ATTEMPTS \} from "\.\.\/\.\.\/lib\/sell-retry\.mjs";/.test(copySrc), "copy-trader imports the helper");
  asrt(/const SELL_MAX_ATTEMPTS = numOr\(process\.env\.SELL_MAX_ATTEMPTS, DEFAULT_SELL_MAX_ATTEMPTS, "SELL_MAX_ATTEMPTS"\);/.test(copySrc), "copy-trader: the same env var SELL_MAX_ATTEMPTS, the shared default");
  asrt(/const MAX_HOLD_SEC = numOr\(process\.env\.COPY_MAX_HOLD_SEC, 1800, "COPY_MAX_HOLD_SEC"\);/.test(copySrc), "copy-trader: COPY_MAX_HOLD_SEC, default 1800, validated by numOr");
  const ctor = cut(copySrc, "const sellRetry = createSellRetry({", "});", "copy-trader sellRetry");
  asrt(/maxAttempts: SELL_MAX_ATTEMPTS/.test(ctor) && /positions,/.test(ctor) && /journal,/.test(ctor) && /recordResult,/.test(ctor) && /session,/.test(ctor) && /buySol: BUY_SOL/.test(ctor), "copy-trader: the helper gets the book, the journal, recordResult, the ledger and BUY_SOL");
  asrt(count(copySrc, /sellRetry\.fail\(/g) === 1, "copy-trader: one failure hook");
  asrt(/exitTimer = setInterval\(\(\) => void checkExits\(\), EXIT_POLL_MS\);/.test(copySrc) && /const EXIT_POLL_MS = 2000;/.test(copySrc), "copy-trader: the exit timer runs every 2 s");
  const fin = cut(copySrc, "async function finish(", "// Main", "copy-trader finish");
  asrt(/if \(exitTimer\) clearInterval\(exitTimer\);/.test(fin) && /copySell\(mint, pos\.copiedFrom, \{ reason: "stop", final: true \}\)/.test(fin), "copy-trader: finish() stops the timer and makes one final attempt");
  asrt(/if \(stopping \|\| exitChecking\) return;/.test(copyCode), "copy-trader: the timer does nothing while the bot is stopping");
  asrt(!/TAKE_PROFIT|STOP_LOSS|take-profit|stop-loss/.test(copySrc), "copy-trader: no TP/SL was added");
  asrt(!/ammSell|pumpswap-sell|amm-sell/.test(copySrc), "copy-trader: no AMM sell was added");
}

console.log(JSON.stringify({ maxAttempts: DEFAULT_SELL_MAX_ATTEMPTS, backoffMs: [1, 2, 3].map(sellBackoffMs), sniperSendsUntilStuck: 3, copyMaxHoldSec: 1800 }));
console.log("PASS: bounded sell retries (sniper, copy-trader): backoff, STUCK as an assumed loss for the limits, reconciled sale is not a failure, DRY RUN unchanged; copy-trader max-hold exit");
