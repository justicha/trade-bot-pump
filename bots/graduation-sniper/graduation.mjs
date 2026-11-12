#!/usr/bin/env node
// Graduation Sniper: покупает токены перед graduation (миграцией с bonding curve на PumpSwap AMM)
//
// Стратегия: мониторит bonding curve reserves из V3 trade events.
// Когда virtual_sol_reserves приближается к порогу graduation (~85 SOL),
// покупает токен. После graduation цена обычно растёт из-за:
// - Ликвидность на PumpSwap AMM
// - Листинг на Jupiter (больше видимость)
// - FOMO от статуса "graduated"
// - Fee distribution для холдеров
//
// Использование: node bots/graduation-sniper/graduation.mjs [--live]   (по умолчанию dry-run; --live включает реальную торговлю)
//
// Конфиг через ENV или .env:
//   GRAD_BUY_SOL=0.1              — сумма покупки
//   GRAD_MIN_FILL_PCT=92          — минимальный % заполнения для покупки
//   GRAD_TAKE_PROFIT=1.5          — продать при 1.5x
//   GRAD_STOP_LOSS=0.7            — стоп-лосс при 0.7x
//   GRAD_TIMEOUT_SEC=300          — таймаут позиции (5 мин)
//   GRAD_MAX_POSITIONS=3          — макс. позиций
//   GRAD_COOLDOWN_SEC=30          — пауза между покупками

import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { TradeJournal } from "../../lib/journal.mjs";
import { newSessionId, paramsHash, gitSha } from "../../lib/runmeta.mjs";
import { describeTxError, isCurveCompleteError } from "../../lib/pump-errors.mjs";
import { previewExit, readExecution, simulateTx } from "../../lib/exec.mjs";
import { checkBuyGate } from "../../lib/buy-gate.mjs";
import { exitDepth } from "../../lib/buy-checks.mjs";
import { checkMintExtensions, mayhemReason } from "../../lib/token-safety.mjs";
import { preBuyCheck, simulateCurveSell } from "../../lib/prebuy-sim.mjs";
import { readGradStrategy } from "../../lib/grad-config.mjs";
import { createAtaCloser } from "../../lib/close-ata.mjs";
import { DEFAULT_DAILY_LOSS_LIMIT_SOL, dailyLossBlocked, netSolForDay } from "../../lib/daily-loss.mjs";
import { exitDecision, positionsToSell } from "../../lib/exit-plan.mjs";
import { mskDateKey } from "../../lib/time.mjs";
import { readJournal } from "../../lib/journal.mjs";
import { BUY_SKIP_REASON } from "../../lib/buy-skip-reasons.mjs";
import { planSellParts } from "../../lib/sell-plan.mjs";
import { ammSellOnce, chooseSellVenue, isDrySell } from "../../lib/amm-sell.mjs";
import { curvePrice, gradFillPct } from "../../lib/curve.mjs";
import { canEnterMint } from "../../lib/entry-gate.mjs";
import { SLIPPAGE_BPS, DRY_RUN, LIVE, numOr } from "../../lib/config.mjs";
import { TradeGuard } from "../../lib/guards.mjs";
import { log as logger } from "../../lib/logger.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../../lib/constants.mjs";
import { parseLogEvents } from "../../lib/events.mjs";
import {
  buyIx,
  calcBuyTokens,
  calcSellSol,
  ensureGlobalFeeState,
  getBondingCurveState,
  getPrice,
  refreshGlobalFeeState,
  sellIx,
  solToLamports,
  userAtaIx,
} from "../../lib/pumpfun.mjs";
import { connection, getSOLBalance, sendTxWithRetry, rpcStats } from "../../lib/rpc.mjs";
import { netRatioExitCosts } from "../../lib/fees.mjs";
import { ammSellQuote } from "../../lib/pumpswap.mjs";
import { SessionLedger } from "../../lib/session.mjs";
import { recordStuck } from "../../lib/stuck.mjs";
import { applyLiveSell, balanceBeforeSell, liveEntry } from "../../lib/live-pnl.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

// Numeric config via numOr: an invalid value (e.g. copied from .env.example with an inline
// comment) fails loudly with the variable name instead of silently becoming NaN.
const BUY_SOL = numOr(process.env.GRAD_BUY_SOL, 0.1, "GRAD_BUY_SOL");
// Band and exits come from lib/grad-config.mjs — the same reader the shadow lab's variant J uses,
// so the paper "live config" can never drift from what this bot trades. Env chain and defaults are
// unchanged: MIN_FILL || GRAD_MIN_FILL_PCT (92), MAX_FILL || GRAD_MAX_FILL_PCT (97),
// MIN_HOLDERS || GRAD_MIN_HOLDERS (7), GRAD_TAKE_PROFIT (1.5), GRAD_STOP_LOSS (0.7),
// GRAD_TIMEOUT_SEC (300).
const GRAD_STRATEGY = readGradStrategy();
const MIN_FILL_PCT = GRAD_STRATEGY.minFillPct;
const MAX_FILL_PCT = GRAD_STRATEGY.maxFillPct;
const MIN_HOLDERS = GRAD_STRATEGY.minHolders;
// 0 = disabled. The stream has no balances, so a non-zero value can never be verified yet.
const MAX_TOP10_SHARE = numOr(process.env.MAX_TOP10_SHARE, 0, "MAX_TOP10_SHARE");
const TAKE_PROFIT = GRAD_STRATEGY.takeProfit;
const STOP_LOSS = GRAD_STRATEGY.stopLoss;
const TIMEOUT_SEC = GRAD_STRATEGY.timeoutSec;
const MAX_POSITIONS = numOr(process.env.GRAD_MAX_POSITIONS, 3, "GRAD_MAX_POSITIONS");
const COOLDOWN_SEC = numOr(process.env.GRAD_COOLDOWN_SEC, 30, "GRAD_COOLDOWN_SEC");
const POLL_MS = 3000;
// --- step-2 reliability knobs ---------------------------------------------------------------
const EXIT_MIN_RATIO = numOr(process.env.EXIT_MIN_RATIO, 0.9, "EXIT_MIN_RATIO"); // skip an entry whose own exit < 90% of the buy
const SELL_MAX_ATTEMPTS = numOr(process.env.SELL_MAX_ATTEMPTS, 3, "SELL_MAX_ATTEMPTS");
const SELL_MAX_SLIPPAGE = numOr(process.env.SELL_MAX_SLIPPAGE, 2000, "SELL_MAX_SLIPPAGE"); // bps
const BUY_SLIPPAGE_BPS = numOr(process.env.BUY_SLIPPAGE_BPS, SLIPPAGE_BPS, "BUY_SLIPPAGE_BPS");
// DRY_SELL=yes (AUDIT_SELL.md §5): build + simulate + journal a PumpSwap sell but never send it.
// This is NOT --dry-run: LIVE still applies, so BUYS ARE STILL REAL while sells are only simulated.
// It exists to prove the live AMM path on a cheap position before allowing a real AMM exit.
const DRY_SELL = isDrySell();
// An entry that never settles (a hung RPC call used to hang forever) must not block every other
// mint: after this long the slot is released and an ALERT is printed.
const OPENING_STALE_SEC = numOr(process.env.OPENING_STALE_SEC, 120, "OPENING_STALE_SEC");
// Daily loss limit (task 5): realised PnL for the current Moscow day, summed from the journal. Once
// the net reaches -DAILY_LOSS_LIMIT_SOL new buys stop; open positions keep being managed and sold.
const DAILY_LOSS_LIMIT_SOL = numOr(process.env.DAILY_LOSS_LIMIT_SOL, DEFAULT_DAILY_LOSS_LIMIT_SOL, "DAILY_LOSS_LIMIT_SOL");
// Exit behaviour (task 6). SELL_ON_EXIT=yes + --live: sell the session's own positions on SIGINT.
// Without it the bot only reports what is open. The whole exit is bounded by EXIT_TIMEOUT_SEC.
const SELL_ON_EXIT = /^(1|yes|true)$/i.test(String(process.env.SELL_ON_EXIT ?? "").trim());
const EXIT_TIMEOUT_MS = numOr(process.env.EXIT_TIMEOUT_SEC, 60, "EXIT_TIMEOUT_SEC") * 1000;
// Test hook, same idea as SNIPER_MAX_SEC: GRAD_MAX_SEC>0 stops the bot through the same finish()
// path the SIGINT handler uses (a real Ctrl+C cannot be delivered to a child on Windows).
const GRAD_MAX_SEC = numOr(process.env.GRAD_MAX_SEC, 0, "GRAD_MAX_SEC");

const VIRTUAL_SOL_AT_GRADUATION = 85_000_000_000n;

// --- session metadata / journal / single-instance lock -------------------------------------
const journal = new TradeJournal({ bot: "graduation-sniper" });
const SESSION_ID = newSessionId("grad");
const PARAMS_HASH = paramsHash({
  BUY_SOL, MIN_FILL_PCT, MAX_FILL_PCT, MIN_HOLDERS, MAX_TOP10_SHARE, TAKE_PROFIT, STOP_LOSS, TIMEOUT_SEC, MAX_POSITIONS, COOLDOWN_SEC,
  EXIT_MIN_RATIO, SELL_MAX_ATTEMPTS, SELL_MAX_SLIPPAGE, BUY_SLIPPAGE_BPS,
});
const GIT_SHA = gitSha();
// A mint is bought at most once per session; a completed curve is blacklisted for good.
const attempted = new Set();
// Mints whose live buy was refused by the buy gate — logged and journaled once, not on every event.
const buyBlockedNotified = new Set();
const blacklistPath = path.join(journal.dir, "graduation-blacklist.json");
const blacklist = new Set(
  (() => {
    try { return JSON.parse(fs.readFileSync(blacklistPath, "utf8")).mints || []; } catch { return []; }
  })(),
);
function saveBlacklist() {
  try {
    fs.mkdirSync(journal.dir, { recursive: true });
    fs.writeFileSync(blacklistPath, JSON.stringify({ mints: [...blacklist] }));
  } catch { /* best effort */ }
}
const LOCK_PATH = path.join(journal.dir, ".graduation.lock");
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}
function acquireInstanceLock() {
  try {
    fs.mkdirSync(journal.dir, { recursive: true });
  } catch { /* dir exists */ }
  // Atomic capture: "wx" fails if another instance created the lock first — the TOCTOU window
  // between "read" and "write" is gone for the common case.
  try {
    const fd = fs.openSync(LOCK_PATH, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return;
  } catch (e) {
    if (e.code !== "EEXIST") return; // best effort
  }
  // The lock exists: only a dead PID may be replaced.
  const existing = fs.readFileSync(LOCK_PATH, "utf8").trim();
  const pid = Number(existing);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
    console.error(`FATAL: another graduation-sniper is already running (PID ${pid}). Refusing to start to avoid duplicate trades.`);
    process.exit(1);
  }
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    // Re-read: if a simultaneous starter raced us and its PID is alive, we must not run twice.
    const reread = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const other = Number(reread);
    if (Number.isInteger(other) && other !== process.pid && processAlive(other)) {
      console.error(`FATAL: another graduation-sniper is already running (PID ${other}). Refusing to start to avoid duplicate trades.`);
      process.exit(1);
    }
  } catch { /* best effort */ }
}
function releaseInstanceLock() {
  try { if (fs.readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH); } catch { /* gone */ }
}

const wallet = loadKeypair();
// Live fee/buyback recipients from pump's `global` account (pump.fun rotates them; buy needs them).
await refreshGlobalFeeState().catch((e) => console.warn(`[fee-state] ${e.message}`));
const positions = new Map();
// Mints THIS session bought and journaled. The exit path may only sell these — never a token that
// merely sits in the wallet (bought by hand or by another bot).
const boughtMints = new Set();
const watchlist = new Map();
// Entry bookkeeping: `opening` blocks concurrent buys of the same mint, `openingSince` lets the
// watchdog release a slot whose RPC call never came back, `aboveBand` makes "fill > MAX_FILL" loud.
const openingSince = new Map();
const aboveBand = new Set();
let lastSlotWarn = 0;
const SLOT_WARN_MS = 30_000; // one line per 30s is enough: the stream can fire many events per second
function warnSlot(msg) {
  const now = Date.now();
  if (now - lastSlotWarn < SLOT_WARN_MS) return;
  lastSlotWarn = now;
  log(`  skip: ${msg}`);
}
let lastBuyTime = 0;
let totalPnl = 0;
// Realised PnL of the current Moscow day (seeded from the journal below, kept in step by
// recordResult). Only new BUYS look at it — sells must always be allowed.
let dayNetSol = 0;
// Seeded from the journal so a restart on the same day does not reset the limit.
dayNetSol = netSolForDay(readJournal(journal.dir), mskDateKey());
let totalTrades = 0;
let wins = 0;

// Session ledger: spent / received / net for the end-of-session report (lib/session.mjs).
// In LIVE the starting balance is captured so the report reconciles the bot's own accounting
// against the real wallet delta (fees, failed txs and unsold tokens all show up there).
const START_SOL = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;
const session = new SessionLedger({
  label: "GRADUATION SNIPER",
  mode: LIVE ? "LIVE" : "DRY RUN",
  startSol: START_SOL,
});
// Positions that cannot be sold (graduated, no pool yet / curve sell impossible) — listed
// separately in the report instead of silently disappearing.
const stuck = new Set();

function log(msg) {
  logger.info(msg);
}

// After a FULL live sale the empty token ATA is closed to get its rent back (lib/close-ata.mjs):
// a separate transaction, in the background, best effort — it can never fail or delay a sale, and
// it does not change any trade's pnlSol. DRY RUN: does nothing.
const ataCloser = createAtaCloser({
  connection,
  wallet,
  live: LIVE,
  session,
  journal,
  log,
  warn: (m) => logger.warn(m),
  meta: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA },
});

const guard = new TradeGuard();

// --- Stop machinery ---------------------------------------------------------
// A breached limit must END the session, not leave a bot that keeps scanning and logging
// "skip: trading halted" on every token. limit -> close positions -> session report.
let stopping = false; // no new work is accepted
let exited = false; // report printed, process is on its way out
let stopReason = "";

// opts.guardPnlSol: a live sale's PnL before network fees — what MAX_CONSEC_LOSSES classifies by
// (lib/guards.mjs). The day's net below always moves by pnlSol (net of fees: real money).
function recordResult(pnlSol, opts) {
  guard.recordResult(pnlSol, opts);
  // Track today's realised PnL for the daily loss limit (buy gate only, never a sell gate).
  dayNetSol = Math.round((dayNetSol + (Number(pnlSol) || 0)) * 1e9) / 1e9;
  if (guard.halted) requestStop(guard.haltReason || "loss limit reached");
}

function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  setImmediate(() => { void finish(reason); });
}

// Mints with a buy in flight. buyToken() is async and the position is only recorded after the
// send, so overlapping WS events could buy the same mint twice and overshoot MAX_POSITIONS
// (check → await → set race). The WS handler puts the mint here BEFORE calling buyToken(), so
// buyToken() must NOT re-check `opening.has(mint)` — it would always see itself and never buy.
const opening = new Set();

// Fill of the curve, in percent of the 85 SOL graduation threshold.
//
// The old formula used virtualSolReserves / 85. That is wrong: on a normal curve the invariant is
// virtualSolReserves = realSolReserves + 30 SOL (verified on-chain: 71.717 - 41.717 = 30.000), and
// graduation happens when REAL reserves reach 85 SOL, i.e. at ~115 SOL virtual. Dividing the
// virtual number by 85 overstates the fill by ~35%: a "92%" reading was really ~56% real.
function getFillPct(realSolReserves) {
  return gradFillPct(realSolReserves);
}

// Distinct buyers per mint, counted from the trade stream since the mint was first sighted.
// It is a LOWER BOUND (a mint may already have holders before we see it) — journaled as such.
const holdersSeen = new Map(); // mint -> Set(user)

// One place that records a refused buy: the legacy `candidate` row (action: skip) plus a
// `buy_skipped` row with the machine-readable reason and the numbers behind it. Every reason in
// BUY_SKIP_REASON ends up here, so `journal` can answer "why did it not buy".
function skipBuy(candidate, reason, extra = {}) {
  journal.write({ ...candidate, action: "skip", reason });
  journal.write({
    type: "buy_skipped",
    sessionId: SESSION_ID,
    paramsHash: PARAMS_HASH,
    gitSha: GIT_SHA,
    mint: candidate.mint,
    reason,
    fillPct: candidate.fillPct,
    ...extra,
  });
}

async function buyToken(mint, fillPct, virtualSolReserves, virtualTokenReserves, meta = {}) {
  if (positions.size >= MAX_POSITIONS) return;
  if (positions.has(mint)) return; // `opening` is owned by the WS handler: it holds the slot while buyToken runs
  if (blacklist.has(mint) || attempted.has(mint)) return;
  if (Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) return;

  const mintPk = new PublicKey(mint);
  const quotePrice = (Number(virtualSolReserves) / Number(virtualTokenReserves)) * 1e-3;
  const holders = meta.holders ?? null;
  const candidate = {
    type: "candidate",
    sessionId: SESSION_ID,
    paramsHash: PARAMS_HASH,
    gitSha: GIT_SHA,
    mint,
    fillPct,
    fillBasis: "realSolReserves/85",
    holders,
    holdersSource: "stream-since-first-sighting (lower bound)",
    top10Share: null, // нет данных: в потоке нет балансов токенов
    spotSolPerToken: quotePrice,
  };

  // A live entry must not open a position the bot may be unable to close: the PumpSwap exit is
  // still unverified (LIVE_CONFIRM_AMM, AUDIT_SELL.md V7), so live buys stay blocked until the
  // operator confirms the AMM path. Dry run is untouched (it sends nothing).
  const buyGate = checkBuyGate({ live: LIVE, confirmAmm: process.env.LIVE_CONFIRM_AMM });
  if (!buyGate.ok) {
    // Once per mint: the handler runs on every event, the blocking reason will not change.
    if (!buyBlockedNotified.has(mint)) {
      buyBlockedNotified.add(mint);
      const reason = `buy blocked: ${buyGate.reason}`;
      log(`  ${reason}`);
      journal.write({ ...candidate, action: "skip", reason });
    }
    return; // no position is opened, nothing is signed or sent
  }

  // Daily loss limit: a bad day stops new buys, never the management of open positions.
  const dailyLoss = dailyLossBlocked({ netSol: dayNetSol, limitSol: DAILY_LOSS_LIMIT_SOL });
  if (dailyLoss.blocked) {
    if (!buyBlockedNotified.has(`loss:${mint}`)) {
      buyBlockedNotified.add(`loss:${mint}`);
      skipBuy(candidate, dailyLoss.reason, { netSolToday: dailyLoss.netSol, limitSol: dailyLoss.limitSol });
      log(`  skip: ${dailyLoss.reason} (today ${dailyLoss.netSol.toFixed(4)} SOL, limit ${dailyLoss.limitSol})`);
    }
    return;
  }

  // Holder gate: the count grows over time, so a miss does NOT mark the mint as attempted.
  if (MIN_HOLDERS > 0 && (holders ?? 0) < MIN_HOLDERS) {
    journal.write({ ...candidate, action: "skip", reason: `holders ${holders ?? 0} < ${MIN_HOLDERS}` });
    return;
  }
  if (MAX_TOP10_SHARE > 0) {
    journal.write({ ...candidate, action: "skip", reason: "top10 share unavailable (stream has no balances)" });
    return;
  }

  const gate = guard.checkOpen(BUY_SOL);
  if (!gate.ok) {
    log(`  skip: ${gate.reason}`);
    journal.write({ ...candidate, action: "skip", reason: gate.reason });
    if (gate.terminal) requestStop(gate.reason); // session over -> finish with the summary
    return;
  }
  guard.reserve(BUY_SOL); // synchronous reservation closes the concurrent-event race

  try {
    const state = await getBondingCurveState(mintPk, 0);
    if (!state || state.complete) {
      guard.release(BUY_SOL);
      attempted.add(mint);
      blacklist.add(mint);
      saveBlacklist();
      log(`  bonding curve already complete or unavailable (blacklisted)`);
      journal.write({ ...candidate, action: "skip", reason: state ? "curve complete" : "curve unavailable" });
      return;
    }

    // Mayhem Mode breaks the curve invariant the sell math relies on (and the exit quote with it).
    const mayhem = mayhemReason({ curveMayhem: state.isMayhemMode });
    if (mayhem) {
      skipBuy(candidate, mayhem, { isMayhem: true });
      guard.release(BUY_SOL);
      attempted.add(mint);
      log(`  skip: ${mayhem}`);
      return;
    }

    // Token-2022 extensions: transfer fee / hook / permanent delegate / non-transferable can make
    // the position unsellable or silently taxed. An unreadable mint is refused, never assumed safe.
    const mintInfo = await connection.getAccountInfo(mintPk).catch(() => null);
    const mintSafety = checkMintExtensions({ ownerProgram: mintInfo?.owner ?? null, data: mintInfo?.data ?? null });
    if (!mintSafety.ok) {
      skipBuy(candidate, mintSafety.reason, { extensions: mintSafety.extensions });
      guard.release(BUY_SOL);
      attempted.add(mint);
      log(`  skip: ${mintSafety.reason}`);
      return;
    }
    if (mintSafety.extensions.length > 0) candidate.tokenExtensions = mintSafety.extensions;

    // Exit preview, used two ways:
    //   1) exit depth — the bot must be able to sell what it buys (WELDERS: it could not);
    //   2) the older EXIT_MIN_RATIO guard, kept as is.
    const prev = previewExit(state, BUY_SOL);
    const exitRatio = prev.ok ? prev.ratio : null;
    const entryLamports = BigInt(Math.floor(BUY_SOL * 1e9));
    const depth = exitDepth({ solOutLamports: prev.ok ? prev.solOut : 0n, entryLamports });
    const skipReason = !prev.ok
      ? prev.reason
      : !prev.payable
        ? "curve cannot pay the exit (rSol < out)"
        : !depth.ok
          ? depth.reason
          : prev.ratio < EXIT_MIN_RATIO
            ? `exit ratio ${prev.ratio.toFixed(3)} < ${EXIT_MIN_RATIO}`
            : null;
    if (skipReason) {
      skipBuy(candidate, skipReason, {
        exitRatio,
        buySol: BUY_SOL,
        expectedExitSol: prev.ok ? Number(prev.solOut) / 1e9 : null,
        minExitSol: Number(depth.minOutLamports) / 1e9,
        realSolReserves: Number(state.realSolReserves) / 1e9,
      });
      guard.release(BUY_SOL);
      attempted.add(mint);
      log(`  skip: ${skipReason}`);
      return;
    }
    journal.write({ ...candidate, action: "enter", exitRatio, reason: null });

    // The buy arguments, computed ONCE: the simulation below and the real buy use the same numbers.
    const expectedTokens = calcBuyTokens(state, BUY_SOL);
    const minTokens = (expectedTokens * BigInt(10000 - BUY_SLIPPAGE_BPS)) / 10000n;
    // Slippage headroom on max_sol_cost: without it any upward tick means Custom 6002.
    const maxSolCost = solToLamports(BUY_SOL * (1 + BUY_SLIPPAGE_BPS / 10000));
    // Never build a buy with a stale fee recipient: retry the global read right here.
    await ensureGlobalFeeState().catch((e) => log(`  fee state refresh failed: ${e.message}`));

    // Before spending anything, prove the exit: simulate BUY + SELL of the same tokens in ONE
    // transaction (lib/prebuy-sim.mjs). A sell alone can never pass — the wallet holds no tokens
    // before the buy (that was "6023 NotEnoughTokensToSell" on every candidate: the bot never
    // bought). LIVE: a failed simulation blocks the buy. DRY RUN: informational only, journaled
    // as `preBuySim`, and skipped when the wallet could not even afford the simulated buy.
    const pre = await preBuyCheck({
      live: LIVE,
      maxSolCost,
      getBalanceSol: () => getSOLBalance(wallet.publicKey),
      simulate: () => simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, buy: { solAmount: BUY_SOL, maxSolCost } }),
    });
    const preSell = pre.sim;
    journal.write({
      ...candidate,
      type: "prebuy_sim",
      mode: LIVE ? "LIVE" : "DRY",
      preBuySim: pre.preBuySim,
      blocked: pre.block,
      tokens: minTokens.toString(),
      maxSolCost: Number(maxSolCost) / 1e9,
      expectedExitSol: preSell?.quote != null ? Number(preSell.quote) / 1e9 : null,
      unitsConsumed: preSell?.units ?? null,
      // Program logs only when the simulation failed: that is where the reason lives.
      logs: preSell && !preSell.ok ? preSell.logs : undefined,
      balanceSol: pre.balanceSol,
    });
    if (pre.block) {
      skipBuy(candidate, `${BUY_SKIP_REASON.curveSellSimulation}: ${preSell.reason}`, {
        preBuySim: pre.preBuySim,
        tokens: minTokens.toString(),
        expectedExitSol: preSell.quote != null ? Number(preSell.quote) / 1e9 : null,
        logs: preSell.logs,
        unitsConsumed: preSell.units ?? null,
        sent: false,
      });
      guard.release(BUY_SOL);
      attempted.add(mint);
      log(`  skip: curve sell simulation failed: ${preSell.reason}`);
      for (const line of preSell.logs) log(`    ${line}`);
      return;
    }
    if (pre.preBuySim === "ok") {
      log(`  buy+sell simulation ok: exit ${(Number(preSell.quote) / 1e9).toFixed(6)} SOL for ${minTokens.toString()} tokens`);
    } else {
      // DRY RUN only (LIVE returned above): the entry is NOT refused.
      log(`  [DRY RUN] pre-buy simulation ${pre.preBuySim} — informational, entry not blocked`);
    }



    log(`*** PRE-GRADUATION BUY ***`);
    log(`  mint: ${mint}`);
    log(`  fill: ${fillPct.toFixed(1)}% | spot ${quotePrice.toExponential(3)} | exit preview ${(exitRatio * 100).toFixed(1)}%`);
    log(`  buying ${BUY_SOL} SOL`);

    // A stop that arrived while we were planning must win: nothing is signed after Ctrl+C.
    if (stopping) {
      guard.release(BUY_SOL);
      log("  stop requested while planning the buy — not sending");
      return;
    }

    if (DRY_RUN) {
      positions.set(mint, {
        tokens: prev.tokensOut,
        entrySolSol: BUY_SOL,
        entryPrice: quotePrice,
        entryTime: Date.now(),
        fillAtEntry: fillPct,
        attempts: 0,
      });
      boughtMints.add(mint);
      lastBuyTime = Date.now();
      session.buy(BUY_SOL);
      attempted.add(mint);
      log(`  [DRY RUN] position tracked`);
      return;
    }

    // expectedTokens / minTokens / maxSolCost and the fee state: computed above, before the
    // simulation, so the simulated buy and this one are built from the same numbers.
    const ixs = [
      ...computeBudgetIxs(),
      userAtaIx(wallet.publicKey, mintPk),
      buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens, {
        creator: state.creator ? new PublicKey(state.creator) : undefined,
        isMayhem: !!state.isMayhemMode,
        maxSolCost,
      }),
    ];
    // Last check before the signature: a stop during the RPC round trip above wins.
    if (stopping) {
      guard.release(BUY_SOL);
      log("  stop requested before signing the buy — not sending");
      return;
    }
    const tx = await buildVersionedTx(wallet, ixs);
    // Same pre-send simulation as the sell: a doomed buy must not be broadcast (it would pay the fee).
    const sim = await simulateTx(tx);
    if (!sim.ok) {
      guard.release(BUY_SOL);
      attempted.add(mint);
      const why = describeTxError(sim.err);
      log(`  buy simulation failed: ${why} — not sending`);
      journal.write({ ...candidate, type: "buy_attempt", simulationResult: "fail", sent: false, error: why });
      return;
    }
    const sig = await sendTxWithRetry(tx, { skipPreflight: true });
    // Entry price = ACTUAL execution (tokens that arrived / SOL that left), not the pre-trade quote.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    // Entry WITHOUT the network fee and WITHOUT the token-ATA rent (the rent is tracked apart).
    const entry = liveEntry(ex, BUY_SOL);
    const entrySol = entry.entrySolSol;
    const tokens = ex.found && ex.tokensReceived > 0n ? ex.tokensReceived : expectedTokens;
    const entryPrice = Number(tokens) > 0 ? entrySol / (Number(tokens) / 1e6) : quotePrice;
    positions.set(mint, {
      tokens,
      ...entry, // entrySolSol, entrySource, buyFeeSol, ataRentSol, ataRentKnown
      entryPrice,
      entryTime: Date.now(),
      fillAtEntry: fillPct,
      attempts: 0,
    });
    lastBuyTime = Date.now();
    attempted.add(mint);
    boughtMints.add(mint); // this session's own position: the only kind the exit path may sell
    session.buy(entrySol);
    session.ataRent(entry.ataRentSol);
    journal.trade({
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
      gitSha: GIT_SHA,
      mint,
      side: "buy",
      sig,
      solSpent: entrySol,
      ataRentSol: entry.ataRentSol,
      ataRentKnown: entry.ataRentKnown,
      tokens: tokens.toString(),
      entryPrice,
      fillPct,
      exitRatioPreview: exitRatio,
      priceSource: ex.found ? "chain-meta" : "quote-fallback",
      simulationResult: "ok",
      unitsConsumed: sim.units,
    });
    log(`  bought! entry ${entryPrice.toExponential(3)} SOL/token (${ex.found ? "actual" : "quote"})`);
  } catch (err) {
    // C2: sendTxWithRetry can throw AFTER the tx was sent (network error in confirmTransaction)
    // even though it landed. If the chain shows the tokens arrived, record the position instead of
    // releasing the reserve and dropping the position — the money WAS spent.
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensReceived > 0n) {
        const entry = liveEntry(ex, BUY_SOL);
        const entrySol = entry.entrySolSol;
        const entryPrice = Number(ex.tokensReceived) > 0 ? entrySol / (Number(ex.tokensReceived) / 1e6) : quotePrice;
        positions.set(mint, {
          tokens: ex.tokensReceived,
          ...entry, // entrySolSol, entrySource, buyFeeSol, ataRentSol, ataRentKnown
          entryPrice,
          entryTime: Date.now(),
          fillAtEntry: fillPct,
          attempts: 0,
        });
        lastBuyTime = Date.now();
        attempted.add(mint);
    boughtMints.add(mint); // this session's own position: the only kind the exit path may sell
        session.buy(entrySol);
        session.ataRent(entry.ataRentSol);
        journal.trade({
          sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mint, side: "buy", sig: err.sig,
          solSpent: entrySol, ataRentSol: entry.ataRentSol, ataRentKnown: entry.ataRentKnown,
          tokens: ex.tokensReceived.toString(), entryPrice, fillPct,
          exitRatioPreview: exitRatio, priceSource: "chain-meta", simulationResult: "ok", unitsConsumed: null,
        });
        log(`  bought! (reconciled after confirm error) entry ${entryPrice.toExponential(3)} SOL/token`);
        return;
      }
    }
    guard.release(BUY_SOL);
    attempted.add(mint);
    if (isCurveCompleteError(err)) {
      blacklist.add(mint);
      saveBlacklist();
    }
    const why = describeTxError(err);
    log(`  buy failed: ${why}`);
    journal.write({ ...candidate, type: "buy_failed", error: why });
  }
}

async function checkExit(mint) {
  const pos = positions.get(mint);
  if (!pos) return;

  const mintPk = new PublicKey(mint);
  const elapsed = (Date.now() - pos.entryTime) / 1000;

  try {
    const state = await getBondingCurveState(mintPk, 0);
    if (!state) {
      log(`  ${mint.slice(0, 12)}: bonding curve gone (graduated?) — PumpSwap route`);
      await sellPosition(mint, mintPk, pos, null);
      return;
    }
    if (state.complete) {
      log(`  ${mint.slice(0, 12)}: *** GRADUATED! *** selling on PumpSwap`);
      await sellPosition(mint, mintPk, pos, null);
      return;
    }

    // Exit value from the SELL QUOTE (net of the 1% sell fee) over the ACTUAL entry SOL —
    // a spot ratio would ignore fees/slippage and is what produced the bogus "instant SL".
    const quoteSol = calcSellSol(state, pos.tokens);
    pos.lastPrice = curvePrice(state);
    const entryLamports = BigInt(Math.floor((pos.entrySolSol ?? BUY_SOL) * 1e9));
    const ratio = Number(quoteSol) / Number(entryLamports);
    const pct = ((ratio - 1) * 100).toFixed(1);

    if (ratio >= TAKE_PROFIT) {
      log(`  ${mint.slice(0, 12)}: TP ${pct}% net`);
      await sellPosition(mint, mintPk, pos, ratio);
    } else if (ratio <= STOP_LOSS) {
      log(`  ${mint.slice(0, 12)}: SL ${pct}% net`);
      await sellPosition(mint, mintPk, pos, ratio);
    } else if (elapsed >= TIMEOUT_SEC) {
      log(`  ${mint.slice(0, 12)}: timeout ${elapsed.toFixed(0)}s, ${pct}% net`);
      await sellPosition(mint, mintPk, pos, ratio);
    }
  } catch (err) {
    log(`  check error ${mint.slice(0, 12)}: ${describeTxError(err)}`);
  }
}

function markStuck(mint, pos, reason, extra = {}) {
  const attempts = extra.attempts ?? pos.attempts ?? 0;
  const venue = extra.venue ?? null;
  const tag = [venue ? `venue=${venue}` : null, `attempts=${attempts}/${SELL_MAX_ATTEMPTS}`].filter(Boolean).join(" ");
  stuck.add(`${mint.slice(0, 12)}: ${tag} — ${reason}`);
  session.drop(`${mint.slice(0, 12)}: STUCK ${reason}`);
  // The limits must see a stuck position: the REMAINING entry (partial sells already reduced
  // pos.entrySolSol) is booked as an assumed loss — journal row `pnlSol` + `lossAssumed: true`,
  // TradeGuard (MAX_CONSEC_LOSSES) and today's net (daily loss limit) via recordResult.
  const lossSol = recordStuck({
    journal,
    recordResult,
    mint,
    pos,
    buySol: BUY_SOL,
    reason,
    fields: {
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
      gitSha: GIT_SHA,
      venue,
      attempts,
      maxAttempts: SELL_MAX_ATTEMPTS,
    },
  });
  // The reason and the attempt count are part of the message: "retries stopped" alone hid the fact
  // that nothing had ever been retried (AUDIT_SELL.md §2).
  const tail =
    attempts >= SELL_MAX_ATTEMPTS
      ? `retries stopped after ${attempts}/${SELL_MAX_ATTEMPTS} attempts`
      : `no further automatic retry (${attempts}/${SELL_MAX_ATTEMPTS} attempts used)`;
  log(`  ALERT: ${mint.slice(0, 12)} STUCK (${tag}): ${reason} — ${tail}, use scripts/rescue-sell.mjs`);
  log(`  STUCK booked as an assumed loss of ${lossSol.toFixed(6)} SOL for the limits (tokens are still in the wallet)`);
  positions.delete(mint);
}

// A venue that cannot be priced right now (AMM gate, missing pool) is NOT a failed sell attempt and
// must not delete the position at attempts=0 — that was the "silent STUCK" of AUDIT_SELL.md §2. It
// burns one of SELL_MAX_ATTEMPTS, backs off, stays in the book, and only becomes STUCK when the
// budget is gone. The gate itself is untouched: nothing is sent while LIVE_CONFIRM_AMM !== "yes".
function deferSell(mint, pos, venue, reason) {
  const attempt = (pos.attempts || 0) + 1;
  pos.attempts = attempt;
  const backoffMs = 2000 * 2 ** (attempt - 1);
  pos.nextSellAt = Date.now() + backoffMs;
  journal.write({
    type: "sell_deferred",
    sessionId: SESSION_ID,
    paramsHash: PARAMS_HASH,
    gitSha: GIT_SHA,
    mint,
    venue,
    reason,
    attempt,
    maxAttempts: SELL_MAX_ATTEMPTS,
    nextRetryMs: backoffMs,
    tokens: (pos.tokens ?? 0n).toString(),
    sent: false,
  });
  if (attempt >= SELL_MAX_ATTEMPTS) {
    markStuck(mint, pos, reason, { venue, attempts: attempt });
    return;
  }
  log(
    `  sell deferred (${venue}): ${reason} — attempt ${attempt}/${SELL_MAX_ATTEMPTS}, next try in ${Math.round(backoffMs / 1000)}s; position kept`,
  );
}

// DRY_SELL=yes inside a DRY RUN: price and SIMULATE the real PumpSwap sell so the journal records
// what a live exit would have done. Read-only RPC calls only — this branch cannot send anything
// (drySell: true is passed as well). The LIVE_CONFIRM_AMM gate is not consulted here because there
// is no send to gate; the LIVE path still passes live: LIVE and enforces it.
async function dryRunAmmProbe(mint, mintPk, pos) {
  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata).catch(() => null);
    const total = info ? BigInt(info.value.amount) : 0n;
    if (total === 0n) return;
    const state = await getBondingCurveState(mintPk, 0).catch(() => null);
    if (chooseSellVenue(state) !== "pumpswap") return;
    const r = await ammSellOnce({
      connection,
      wallet,
      mint,
      mintPk,
      total,
      attempt: 1,
      slip: 500,
      live: false,
      confirmAmm: process.env.LIVE_CONFIRM_AMM,
      drySell: true,
      journal,
      log,
      meta: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, maxAttempts: SELL_MAX_ATTEMPTS },
    });
    if (r.status === "sim_fail") log(`  [DRY SELL] the AMM sell would FAIL: ${r.why}`);
    else if (r.status === "no_pool") log("  [DRY SELL] no canonical pool for this mint (V3)");
    else if (r.status === "dry") log(`  [DRY SELL] the AMM sell would return ~${(Number(r.quote) / 1e9).toFixed(6)} SOL`);
  } catch (e) {
    log(`  [DRY SELL] probe failed: ${describeTxError(e)}`);
  }
}

// `final`: the last call for this position (session stop) — no retry is possible after it.
async function sellPosition(mint, mintPk, pos, ratio, { final = false } = {}) {
  if (DRY_RUN) {
    // DRY_SELL=yes: also simulate the REAL PumpSwap exit (journal: sell_sim / sell_attempt / sell_dry).
    if (DRY_SELL) await dryRunAmmProbe(mint, mintPk, pos);
    const entrySol = pos.entrySolSol ?? BUY_SOL;
    let mult = ratio;
    let venue = "curve";
    if (mult == null) {
      // The curve is complete / gone: its last price is not an exit price (it is the highest the
      // curve ever had, and nothing can be sold on it). Price the paper exit from the PumpSwap
      // pool instead — read-only (getAccountInfo / getTokenAccountBalance). It used to be valued at
      // pos.lastPrice of the dead curve, which overstated every migrated position.
      if (!final && (pos.nextSellAt || 0) > Date.now()) return;
      venue = "pumpswap";
      const q = await ammSellQuote(connection, mintPk, pos.tokens).catch(() => null);
      if (!q || !(q.solOut > 0n)) {
        // No pool / no quote: NOT a sale. Same patience as the live path (SELL_MAX_ATTEMPTS with
        // backoff), then the position is reported as stuck — without a result and, this being a
        // dry run, without an assumed loss for the limits.
        const attempt = (pos.attempts || 0) + 1;
        pos.attempts = attempt;
        if (!final && attempt < SELL_MAX_ATTEMPTS) {
          const backoffMs = 2000 * 2 ** (attempt - 1);
          pos.nextSellAt = Date.now() + backoffMs;
          log(`  [DRY RUN] no PumpSwap quote for ${mint.slice(0, 12)} — attempt ${attempt}/${SELL_MAX_ATTEMPTS}, next try in ${Math.round(backoffMs / 1000)}s; position kept`);
          return;
        }
        stuck.add(`${mint.slice(0, 12)}: dry: no AMM quote`);
        journal.write({
          type: "stuck",
          sessionId: SESSION_ID,
          paramsHash: PARAMS_HASH,
          gitSha: GIT_SHA,
          mode: "DRY",
          mint,
          venue,
          reason: "dry: no AMM quote",
          attempts: attempt,
          maxAttempts: SELL_MAX_ATTEMPTS,
          tokens: (pos.tokens ?? 0n).toString(),
          entrySolSol: entrySol,
        });
        session.drop(`${mint.slice(0, 12)}: dry: no AMM quote (curve complete, pool not priced)`);
        log(`  [DRY RUN] ${mint.slice(0, 12)}: curve complete and no PumpSwap quote — NOT booked as a sale (stuck, no result)`);
        positions.delete(mint);
        return;
      }
      // What the pool pays for the position (after the pool's own fees) over the entry.
      mult = Number(q.solOut) / (entrySol * 1e9);
      log(`  [DRY RUN] PumpSwap quote: ${(Number(q.solOut) / 1e9).toFixed(9)} SOL for ${pos.tokens.toString()} tokens (pool fees ${q.feeBps} bps inside)`);
    }
    // `mult` is already NET of the venue fees on both venues: calcSellSol(tokens) / entry on the
    // curve (tokens bought after pump's 1%, proceeds after pump's 1%), pool quote / entry on
    // PumpSwap. Only the assumed slippage and the two network fees are costs on top of it —
    // charging pump 1% + 1% again (as before) took about 2% off every dry trade.
    const { pnlSol, receivedSol, costs } = netRatioExitCosts({ entrySol, ratio: mult });
    recordResult(pnlSol);
    session.sell(receivedSol, pnlSol, costs);
    totalTrades++;
    totalPnl += pnlSol;
    if (pnlSol > 0) wins++;
    log(`  [DRY RUN] sold on ${venue}: ${mult >= 1 ? "+" : ""}${((mult - 1) * 100).toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL before slippage/network costs ${costs.costSol.toFixed(6)})`);
    positions.delete(mint);
    return;
  }

  // Bounded retries: at most SELL_MAX_ATTEMPTS, exponential backoff, growing slippage, and every
  // attempt is a DIFFERENT tx (slippage changes) — never the same failing payload on repeat.
  if ((pos.nextSellAt || 0) > Date.now()) return;
  if ((pos.attempts || 0) >= SELL_MAX_ATTEMPTS) return;

  const attempt = (pos.attempts || 0) + 1;
  const slip = Math.min(SELL_MAX_SLIPPAGE, 500 * 2 ** (attempt - 1)); // 500 -> 1000 -> 2000 bps
  let venue = "curve";
  let quote = null;
  let sig = null;
  // Token balance BEFORE this sale. Declared here so the catch (a sale that landed despite a
  // confirm error) can measure the sold share against it — see balanceBeforeSell.
  let total = null;
  // Simulation result of THIS attempt; the AMM path returns its own (already journaled) one.
  let sim = { ok: true, err: null, logs: [], units: null };
  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    total = BigInt(info.value.amount);
    if (total === 0n) {
      session.drop(`${mint.slice(0, 12)}: no tokens in wallet`);
      positions.delete(mint);
      return;
    }

    const state = await getBondingCurveState(mintPk, 0);
    venue = chooseSellVenue(state); // curve while the curve is live, PumpSwap once it is complete/gone
    let ixs = null;
    let amountRaw = total;
    if (venue === "curve") {
      // Never send a sell the curve cannot pay: plan parts so each payout fits realSolReserves.
      const plan = planSellParts(state, total, { capRatio: 0.95, minPartRaw: 1_000_000n });
      if (plan.parts.length === 0) {
        markStuck(mint, pos, `rSol ${(Number(state.realSolReserves) / 1e9).toFixed(6)} cannot pay any part (${plan.reason})`);
        return;
      }
      const part = plan.parts[0];
      amountRaw = part.amountRaw;
      quote = part.quoteOut;
      const minSol = (quote * BigInt(10000 - slip)) / 10000n;
      ixs = [
        ...computeBudgetIxs(),
        sellIx(wallet.publicKey, mintPk, amountRaw, minSol, {
          creator: state.creator ? new PublicKey(state.creator) : undefined,
          isMayhem: !!state.isMayhemMode,
        }),
      ];
      if (plan.restRaw > 0n) {
        log(
          `  partial sell: ${(Number(amountRaw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} of ${(Number(total) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens (rSol ${(Number(state.realSolReserves) / 1e9).toFixed(6)} SOL)`,
        );
      }
    } else {
      // PumpSwap: the whole attempt (gate -> quote -> build -> simulate -> journal -> send) lives in
      // lib/amm-sell.mjs so the simulation result and the expected SOL are journaled BEFORE the send
      // and DRY_SELL can stop it at the last moment. Account list unchanged (V1/V2 unverified).
      const amm = await ammSellOnce({
        connection,
        wallet,
        mint,
        mintPk,
        total,
        attempt,
        slip,
        live: LIVE,
        confirmAmm: process.env.LIVE_CONFIRM_AMM,
        drySell: DRY_SELL,
        journal,
        log,
        meta: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, maxAttempts: SELL_MAX_ATTEMPTS },
      });
      if (amm.status === "gate" || amm.status === "no_pool") {
        // Not a failed sell: the position stays in the book, see deferSell.
        deferSell(mint, pos, venue, amm.reason);
        return;
      }
      if (amm.status === "sim_fail") {
        pos.attempts = attempt;
        if (attempt >= SELL_MAX_ATTEMPTS) markStuck(mint, pos, `simulation: ${amm.why}`, { venue, attempts: attempt });
        else pos.nextSellAt = Date.now() + 2000 * 2 ** (attempt - 1);
        return;
      }
      if (amm.status === "dry") {
        // Nothing was sent: no sale to record, no PnL, position untouched. Back off so a DRY_SELL run
        // does not journal the same simulation every poll.
        pos.nextSellAt = Date.now() + 30_000;
        return;
      }
      sig = amm.sig;
      quote = amm.quote;
      amountRaw = amm.amountRaw;
      sim = amm.sim;
    }

    // Curve path: build + simulate + send here (the AMM path already sent inside ammSellOnce and
    // journaled its simulation result before doing so).
    if (venue === "curve") {
      const tx = await buildVersionedTx(wallet, ixs);
      // Pre-send simulation: a doomed tx burns the fee and, for a sell, keeps the position hostage.
      sim = await simulateTx(tx);
      if (!sim.ok) {
        pos.attempts = attempt;
        const why = describeTxError(sim.err);
        journal.write({
          type: "sell_attempt",
          sessionId: SESSION_ID,
          paramsHash: PARAMS_HASH,
          gitSha: GIT_SHA,
          mint,
          venue,
          attempt,
          slippageBps: slip,
          amountRaw: amountRaw.toString(),
          balanceRaw: total.toString(),
          quoteOut: Number(quote) / 1e9,
          realSolReserves: state ? Number(state.realSolReserves) / 1e9 : null,
          simulationResult: "fail",
          error: why,
          logs: sim.logs ?? [],
          unitsConsumed: sim.units ?? null,
          sent: false,
        });
        log(`  sell simulation failed (${venue}): ${why} — not sending`);
        if (attempt >= SELL_MAX_ATTEMPTS) markStuck(mint, pos, `simulation: ${why}`, { venue, attempts: attempt });
        else pos.nextSellAt = Date.now() + 2000 * 2 ** (attempt - 1);
        return;
      }
      sig = await sendTxWithRetry(tx, { skipPreflight: true });
    }

    // Actual execution (wallet delta), falling back to the quote if the meta lags. One shared
    // calculation for every bot (lib/live-pnl.mjs): PnL against the SOLD share of the entry (H4),
    // net of both real network fees; the ledger gets the gross figures + the real fees as costs.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, quoteSol: Number(quote) / 1e9, soldRaw: amountRaw, totalRaw: total });
    const pnlActual = sale.acc.pnlSol;
    recordResult(pnlActual, { guardPnlSol: sale.guardPnlSol });
    session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
    totalTrades++;
    totalPnl += pnlActual;
    if (pnlActual > 0) wins++;
    journal.trade({
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
      gitSha: GIT_SHA,
      mint,
      side: "sell",
      sig,
      venue,
      pnlSol: pnlActual,
      // entrySolSol, entrySource, solReceived, buyFeeSol, sellFeeSol, feesActual, ataRentSol (on
      // the sale that CLOSES the position only), ataRentKnown — same fields as the sniper.
      ...sale.fields,
      amountRaw: amountRaw.toString(),
      balanceRaw: total.toString(),
      quoteOut: Number(quote) / 1e9,
      realSolReserves: state ? Number(state.realSolReserves) / 1e9 : null,
      attempts: attempt,
      slippageBps: slip,
      simulationResult: "ok",
      unitsConsumed: sim.units,
      priceSource: ex.found ? "chain-meta" : "quote-fallback",
    });
    log(`  sold on ${venue}: ${pnlActual >= 0 ? "+" : ""}${pnlActual.toFixed(4)} SOL (${ex.found ? "actual" : "quote"}, slip ${slip} bps)`);
    if (!sale.closed) {
      // Partial fill: keep the position with what is left (tokens, the remaining entry share AND
      // the remaining share of the buy fee); the next cycle re-reads the curve.
      Object.assign(pos, sale.remainder, { attempts: 0, nextSellAt: 0 });
      log(`  remaining ${(Number(pos.tokens) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens kept for the next cycle`);
    } else {
      positions.delete(mint);
      // The sale is confirmed and booked: now (and only now) try to close the empty ATA.
      ataCloser.schedule(mint, { venue });
    }
  } catch (err) {
    // C2: the sell may have landed even though confirmTransaction failed. If the chain shows the
    // tokens left the wallet, record the sale (proportional entry) instead of retrying a sell that
    // already happened (a retry would sell the remaining tokens or fail).
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensSold > 0n) {
        const soldRaw = ex.tokensSold;
        // The balance read BEFORE the sale (pos.tokens only if it was never read). It used to be
        // `pos.tokens + soldRaw`: pos.tokens is not reduced yet, so a full sale looked like half of
        // a double-sized position — PnL overstated by half the entry and a phantom position kept.
        const totalRaw = balanceBeforeSell({ balanceRaw: total, posTokens: pos.tokens, soldRaw });
        const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, quoteSol: Number(quote) / 1e9, soldRaw, totalRaw });
        const pnlActual = sale.acc.pnlSol;
        recordResult(pnlActual, { guardPnlSol: sale.guardPnlSol });
        session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
        totalTrades++;
        totalPnl += pnlActual;
        if (pnlActual > 0) wins++;
        journal.trade({
          sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mint, side: "sell", sig: err.sig, venue,
          pnlSol: pnlActual, ...sale.fields, amountRaw: soldRaw.toString(), balanceRaw: totalRaw.toString(),
          quoteOut: Number(quote) / 1e9, realSolReserves: null, attempts: attempt, slippageBps: slip,
          simulationResult: "ok", unitsConsumed: null, priceSource: "chain-meta", reconciled: true,
        });
        log(`  sold (reconciled after confirm error): ${pnlActual >= 0 ? "+" : ""}${pnlActual.toFixed(4)} SOL`);
        if (!sale.closed) {
          Object.assign(pos, sale.remainder, { attempts: 0, nextSellAt: 0 });
          log(`  remaining ${(Number(pos.tokens) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens kept for the next cycle`);
        } else {
          positions.delete(mint);
          ataCloser.schedule(mint, { venue });
        }
        return;
      }
    }
    pos.attempts = attempt;
    const why = describeTxError(err);
    journal.write({
      type: "sell_failed",
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
      gitSha: GIT_SHA,
      mint,
      venue,
      attempt,
      slippageBps: slip,
      error: why,
      sig: err.sig ?? null,
    });
    log(`  sell attempt ${attempt}/${SELL_MAX_ATTEMPTS} failed (${venue}): ${why}`);
    if (attempt >= SELL_MAX_ATTEMPTS) markStuck(mint, pos, why, { venue, attempts: attempt });
    else pos.nextSellAt = Date.now() + 2000 * 2 ** (attempt - 1);
  }
}

// Position monitoring loop. Skip a cycle if the previous one is still running: with RPC latency
// a cycle can exceed POLL_MS, and two overlapping cycles could sell the same position twice
// (same guard as bots/sniper/sniper.mjs).
let checking = false;
async function monitorPositions() {
  if (stopping) return; // shutdown in progress
  if (checking) return;
  checking = true;
  try {
    for (const [mint] of positions) {
      await checkExit(mint);
    }
  } finally {
    checking = false;
  }
}
const pollTimer = setInterval(monitorPositions, POLL_MS);

// Final shutdown: stop listening, close open positions (simulated in DRY RUN), print the session report
// (spent / received / net) and exit. Idempotent — a second call is a no-op.
async function finish(reason = stopReason || "stopped") {
  if (exited) return;
  exited = true;
  stopping = true;
  stopReason = reason;
  log(`\n=== STOPPING: ${reason} ===`);
  await ws.close().catch(() => {}); // wait for the socket: exiting mid-close trips a libuv assertion
  clearInterval(pollTimer);
  clearInterval(cleanupTimer);
  // Close every open position at stop. In LIVE that is a real bonding-curve sell; in DRY RUN
  // there is nothing on-chain, but we still simulate the close (sellPosition has a DRY_RUN
  // branch) so the session report shows a complete PnL instead of "still open at stop".
  if (positions.size > 0) {
    // Only the session's OWN buys are touched (boughtMints): a token that merely sits in the wallet
    // is never sold by the bot, no matter what happens at shutdown.
    const mine = positionsToSell({ positions, boughtMints });
    log(`  ${mine.length} open position(s) from this session${DRY_RUN ? " [DRY RUN: simulated]" : ""}...`);
    // Live exits are bounded by EXIT_TIMEOUT_SEC (60s default); a dry run keeps the short drain.
    const deadline = Date.now() + (LIVE && SELL_ON_EXIT ? EXIT_TIMEOUT_MS : 8000);
    for (const { mint, pos } of mine) {
      if (Date.now() > deadline) break;
      try {
        const mintPk = new PublicKey(mint);
        const state = await getBondingCurveState(mintPk, 0);
        const venue = chooseSellVenue(state);
        const decision = exitDecision({
          live: LIVE,
          sellOnExit: SELL_ON_EXIT,
          venue,
          confirmAmm: process.env.LIVE_CONFIRM_AMM,
        });
        const entryLamports = BigInt(Math.floor((pos.entrySolSol ?? BUY_SOL) * 1e9));
        const ratio =
          state && !state.complete && pos.tokens
            ? Number(calcSellSol(state, pos.tokens)) / Number(entryLamports)
            : null;
        if (!decision.sell) {
          // Not "stuck": a deliberate refusal, journaled with the reason so the summary explains it.
          log(`  ${mint.slice(0, 12)}: NOT selling (${decision.reason}), venue=${venue}`);
          journal.write({
            type: "exit_skipped",
            sessionId: SESSION_ID,
            paramsHash: PARAMS_HASH,
            gitSha: GIT_SHA,
            mint,
            venue,
            reason: decision.reason,
            tokens: (pos.tokens ?? 0n).toString(),
            entrySolSol: pos.entrySolSol ?? BUY_SOL,
            lastRatio: ratio,
          });
          continue;
        }
        if (DRY_RUN && ratio == null) {
          // The curve is complete / gone. The paper exit is priced from the PumpSwap pool, or not
          // booked at all (it used to be valued at the dead curve's last price). `final`: no retry.
          log(`  ${mint.slice(0, 12)}: curve complete/gone — pricing the exit from the PumpSwap pool (DRY RUN)`);
          await sellPosition(mint, mintPk, pos, null, { final: true });
        } else {
          await sellPosition(mint, mintPk, pos, ratio); // real path: curve, or PumpSwap when complete
        }
      } catch (err) {
        log(`  close failed ${mint.slice(0, 8)}: ${describeTxError(err)}`);
      }
    }
    // Whatever is still open (exit timeout, skipped venue, failed simulation) is listed here and
    // then reported by the B11 block below — never silently dropped.
    const leftOpen = [...positions.keys()];
    if (leftOpen.length > 0) {
      log(`  exit finished with ${leftOpen.length} position(s) still open: ${leftOpen.map((m) => m.slice(0, 8)).join(", ")}`);
      journal.write({
        type: "exit_report",
        sessionId: SESSION_ID,
        paramsHash: PARAMS_HASH,
        gitSha: GIT_SHA,
        live: LIVE,
        sellOnExit: SELL_ON_EXIT,
        reason,
        remaining: leftOpen,
        sessionPositions: [...boughtMints],
      });
    }
  }
  // B11: capture the open-at-stop state BEFORE any deletion — the summary must show the real
  // position count/spend, not zeros.
  const openAtStop = [...positions.entries()].map(([mint, pos]) => ({ mint, spentSol: pos.entrySolSol ?? BUY_SOL }));
  for (const [mint, pos] of [...positions]) {
    stuck.add(`${mint.slice(0, 12)}: open at stop`);
    if (LIVE) {
      // The bot stops managing this position (the next session only touches its own buys), so for
      // the limits it is an assumed loss — the daily loss limit must see it after a restart today.
      recordStuck({
        journal, recordResult, mint, pos, buySol: BUY_SOL, reason: "open at stop",
        fields: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, attempts: pos.attempts || 0 },
      });
    } else {
      journal.write({ type: "stuck", sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mint, reason: "open at stop", attempts: pos.attempts || 0 });
    }
    session.drop(`${mint.slice(0, 12)}: still open at stop`);
    positions.delete(mint);
  }
  // ATA closes still in flight must be in the ledger before the wallet is read (bounded wait).
  const closesLeft = (await ataCloser.drain()).pending;
  if (closesLeft) log(`  ${closesLeft} ATA close(s) still unconfirmed at stop — not in the summary`);
  const endSol = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;
  session.report({
    reason,
    openPositions: openAtStop.length,
    endSol,
    openSpentSol: openAtStop.reduce((a, p) => a + p.spentSol, 0),
    rpc: rpcStats.snapshot(),
    stuck: [...stuck],
  });
  releaseInstanceLock();
  process.exit(0);
}

// Main
acquireInstanceLock(); // one instance per journal dir: duplicate bots buy the same mint twice
log("=== GRADUATION SNIPER ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Config: buy=${BUY_SOL} SOL, fill>=${MIN_FILL_PCT}%, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x, timeout=${TIMEOUT_SEC}s`);
log(`Reliability: exit>${EXIT_MIN_RATIO}, sell attempts<=${SELL_MAX_ATTEMPTS}, max slippage ${SELL_MAX_SLIPPAGE} bps, buy slippage ${BUY_SLIPPAGE_BPS} bps`);
log(`Filters: fill ${MIN_FILL_PCT}-${MAX_FILL_PCT}% (of 85 SOL REAL reserves), holders>=${MIN_HOLDERS}, top10=${MAX_TOP10_SHARE > 0 ? MAX_TOP10_SHARE : "off"}`);
log(`Max positions: ${MAX_POSITIONS}, cooldown: ${COOLDOWN_SEC}s`);
if (LIVE) log("MODE: LIVE — real transactions will be sent");
else log("MODE: DRY RUN (no real transactions) — pass --live to trade");
if (DRY_SELL) {
  log("SELLS: DRY_SELL=yes — PumpSwap sells are built, simulated and journaled but NEVER sent.");
  if (LIVE) log("WARNING: LIVE is still on — BUYS ARE REAL while sells are only simulated.");
}
log(`Session: ${SESSION_ID} | params ${PARAMS_HASH} | git ${GIT_SHA || "n/a"} | journal ${journal.dir}`);

const ws = new SolanaWs();
await ws.connect();

// Test hook (same idea as SNIPER_MAX_SEC): stop through the very path SIGINT uses, so the exit
// behaviour can be tested on a platform where a child cannot receive a real Ctrl+C.
if (GRAD_MAX_SEC > 0) {
  log(`Test hook: stopping after ${GRAD_MAX_SEC}s (GRAD_MAX_SEC)`);
  setTimeout(() => requestStop(`max seconds (${GRAD_MAX_SEC}s)`), GRAD_MAX_SEC * 1000);
}

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  if (stopping) return; // session stopped: ignore late events
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  let events;
  try { events = parseLogEvents(value.logs); } catch { return; }
  for (const ev of events) {
    if (ev.type !== "trade") continue;
    // C4: per-event direction from the payload byte; a sell in a mixed tx must not drive the entry.
    if (!ev.isBuy) continue;
    // The reserve snapshot is required to price the fill; short payloads have it undefined.
    if (ev.realSolReserves == null || ev.realSolReserves === 0n) continue;

    try {
      // Distinct buyers since the mint was first sighted (lower bound, see holdersSeen).
      let buyerSet = holdersSeen.get(ev.mint);
      if (!buyerSet) {
        buyerSet = new Set();
        holdersSeen.set(ev.mint, buyerSet);
      }
      buyerSet.add(ev.user);
      const holders = buyerSet.size;

      // Real fill: rSol / 85 SOL (vSol would overstate it by ~35%).
      const fillPct = getFillPct(ev.realSolReserves);

      // Fill above the band is NOT a bug: the bot refuses the last MAX_FILL..100% before migration.
      // It used to do that silently, which read as "the bot died at 97%".
      if (fillPct > MAX_FILL_PCT) {
        if (!aboveBand.has(ev.mint)) {
          aboveBand.add(ev.mint);
          log(
            `ABOVE BAND: ${ev.mint.slice(0, 12)} fill=${fillPct.toFixed(1)}% > MAX_FILL=${MAX_FILL_PCT}% — too close to migration, no entry`,
          );
        }
      } else {
        aboveBand.delete(ev.mint);
      }

      if (fillPct >= MIN_FILL_PCT && fillPct <= MAX_FILL_PCT) {
        const prev = watchlist.get(ev.mint);
        if (!prev || fillPct > prev.fillPct) {
          watchlist.set(ev.mint, { fillPct, ts: Date.now() });
          log(
            `WATCHLIST: ${ev.mint.slice(0, 12)} fill=${fillPct.toFixed(1)}% rSol=${(Number(ev.realSolReserves) / 1e9).toFixed(2)} holders=${holders}`,
          );
        }

        const gate = canEnterMint({ positions, opening, attempted, mint: ev.mint, maxPositions: MAX_POSITIONS });
        if (gate.ok) {
          opening.add(ev.mint);
          openingSince.set(ev.mint, { since: Date.now(), running: true });
          try {
            await buyToken(ev.mint, fillPct, ev.virtualSolReserves, ev.virtualTokenReserves, { holders });
          } finally {
            opening.delete(ev.mint);
            openingSince.delete(ev.mint);
          }
        } else if (gate.reason === "full") {
          // Say it out loud. With GRAD_MAX_POSITIONS=1 a single open position used to silence the
          // bot completely: every new candidate was dropped without a log line or a journal record.
          warnSlot(
            `no free slot (${positions.size} open, ${opening.size} opening) — ${ev.mint.slice(0, 8)} ignored at fill=${fillPct.toFixed(1)}%`,
          );
        } else if (gate.reason === "in-flight") {
          warnSlot(
            `entry already in flight for ${ev.mint.slice(0, 8)} (${Math.round((Date.now() - (openingSince.get(ev.mint)?.since || Date.now())) / 1000)}s)`,
          );
        }
      }
    } catch { /* malformed Program data payload: skip this line, keep the subscription alive */ }
    // H2: no `break` — process EVERY trade event in the tx (routers emit several; the last one
    // carries the latest reserves and drives the highest fill).
  }
});

log("\nListening for near-graduation tokens...\n");

// Cleanup old watchlist entries every minute
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [mint, info] of watchlist) {
    if (now - info.ts > 600_000) watchlist.delete(mint);
  }
  // Watchdog: an entry whose RPC call never settled used to hold the `opening` slot forever, so
  // with GRAD_MAX_POSITIONS=1 every later candidate was dropped silently. Release it and say so —
  // but NEVER release a slot whose buyToken is still running (H3: that allowed a duplicate buy).
  for (const [mint, rec] of openingSince) {
    if (now - rec.since > OPENING_STALE_SEC * 1000) {
      if (rec.running) {
        log(
          `ALERT: entry for ${mint.slice(0, 8)} still in flight after ${Math.round((now - rec.since) / 1000)}s — slot kept (running buy)`,
        );
        continue;
      }
      opening.delete(mint);
      openingSince.delete(mint);
      log(
        `ALERT: entry for ${mint.slice(0, 8)} did not settle in ${Math.round((now - rec.since) / 1000)}s — slot released`,
      );
    }
  }
  // Holder sets are only useful while a mint is a live candidate.
  if (holdersSeen.size > 5_000) {
    const keep = new Set([...watchlist.keys(), ...positions.keys(), ...opening]);
    for (const mint of holdersSeen.keys()) if (!keep.has(mint)) holdersSeen.delete(mint);
  }
  // Heartbeat: proves the process is alive AND shows why nothing is bought. Silence must never be
  // the only signal that something is wrong.
  if (!stopping) {
    log(
      `HEARTBEAT: watchlist=${watchlist.size} positions=${positions.size} opening=${opening.size} ` +
        `freeSlots=${Math.max(0, MAX_POSITIONS - positions.size - opening.size)} ` +
        `rpc=${rpcStats.calls} (429 x${rpcStats.retries429}, errors ${rpcStats.errors})`,
    );
  }
}, 60_000);

process.on("SIGINT", () => {
  // First Ctrl+C: stop buying IMMEDIATELY (buyToken checks `stopping` before it signs anything),
  // then close this session's own positions and print the report (finish is idempotent).
  // Second Ctrl+C while the shutdown is running: leave immediately.
  stopping = true;
  if (exited) {
    log("\nsecond Ctrl+C — exiting now");
    process.exit(0);
  }
  void finish("manual stop (Ctrl+C)");
});
process.on("SIGTERM", () => {
  // Process managers send SIGTERM: run the same graceful shutdown (summary + lock release).
  if (!exited) void finish("SIGTERM");
});
