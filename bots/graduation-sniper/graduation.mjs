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
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { TradeJournal } from "../../lib/journal.mjs";
import { newSessionId, paramsHash, gitSha } from "../../lib/runmeta.mjs";
import { describeTxError, isCurveCompleteError } from "../../lib/pump-errors.mjs";
import { previewExit, readExecution, simulateTx } from "../../lib/exec.mjs";
import { planSellParts } from "../../lib/sell-plan.mjs";
import { ammSellIx, ammSellQuote, TOKEN_PROGRAM } from "../../lib/pumpswap.mjs";
import { curvePrice, gradFillPct } from "../../lib/curve.mjs";
import { SLIPPAGE_BPS, DRY_RUN, LIVE } from "../../lib/config.mjs";
import { TradeGuard } from "../../lib/guards.mjs";
import { log as logger } from "../../lib/logger.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import {
  buyIx,
  calcBuyTokens,
  calcSellSol,
  getBondingCurveState,
  getPrice,
  refreshGlobalFeeState,
  sellIx,
  userAtaIx,
} from "../../lib/pumpfun.mjs";
import { connection, getSOLBalance, sendTxWithRetry, rpcStats } from "../../lib/rpc.mjs";
import { roundTripCosts } from "../../lib/fees.mjs";
import { SessionLedger, roundSol } from "../../lib/session.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

const BUY_SOL = Number(process.env.GRAD_BUY_SOL || 0.1);
const MIN_FILL_PCT = Number(process.env.MIN_FILL || process.env.GRAD_MIN_FILL_PCT || 92);
const MAX_FILL_PCT = Number(process.env.MAX_FILL || process.env.GRAD_MAX_FILL_PCT || 97);
const MIN_HOLDERS = Number(process.env.MIN_HOLDERS || process.env.GRAD_MIN_HOLDERS || 7);
// 0 = disabled. The stream has no balances, so a non-zero value can never be verified yet.
const MAX_TOP10_SHARE = Number(process.env.MAX_TOP10_SHARE || 0);
const TAKE_PROFIT = Number(process.env.GRAD_TAKE_PROFIT || 1.5);
const STOP_LOSS = Number(process.env.GRAD_STOP_LOSS || 0.7);
const TIMEOUT_SEC = Number(process.env.GRAD_TIMEOUT_SEC || 300);
const MAX_POSITIONS = Number(process.env.GRAD_MAX_POSITIONS || 3);
const COOLDOWN_SEC = Number(process.env.GRAD_COOLDOWN_SEC || 30);
const POLL_MS = 3000;
// --- step-2 reliability knobs ---------------------------------------------------------------
const EXIT_MIN_RATIO = Number(process.env.EXIT_MIN_RATIO || 0.9); // skip an entry whose own exit < 90% of the buy
const SELL_MAX_ATTEMPTS = Number(process.env.SELL_MAX_ATTEMPTS || 3);
const SELL_MAX_SLIPPAGE = Number(process.env.SELL_MAX_SLIPPAGE || 2000); // bps
const BUY_REJECT_COOLDOWN_MS = 60_000; // after a failed buy, do not touch this mint for a minute
const BUY_SLIPPAGE_BPS = Number(process.env.BUY_SLIPPAGE_BPS || SLIPPAGE_BPS);

const VIRTUAL_SOL_AT_GRADUATION = 85_000_000_000n;

// --- session metadata / journal / single-instance lock -------------------------------------
const journal = new TradeJournal({ bot: "graduation-sniper" });
const SESSION_ID = newSessionId("grad");
const PARAMS_HASH = paramsHash({
  BUY_SOL, MIN_FILL_PCT, TAKE_PROFIT, STOP_LOSS, TIMEOUT_SEC, MAX_POSITIONS, COOLDOWN_SEC,
  EXIT_MIN_RATIO, SELL_MAX_ATTEMPTS, SELL_MAX_SLIPPAGE, BUY_SLIPPAGE_BPS,
});
const GIT_SHA = gitSha();
// A mint is bought at most once per session; a completed curve is blacklisted for good.
const attempted = new Set();
const buyFailUntil = new Map();
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
    const existing = fs.readFileSync(LOCK_PATH, "utf8").trim();
    if (existing) {
      const pid = Number(existing);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
        console.error(`FATAL: another graduation-sniper is already running (PID ${pid}). Refusing to start to avoid duplicate trades.`);
        process.exit(1);
      }
    }
  } catch { /* no lock yet */ }
  try { fs.writeFileSync(LOCK_PATH, String(process.pid)); } catch { /* best effort */ }
}
function releaseInstanceLock() {
  try { if (fs.readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH); } catch { /* gone */ }
}

const wallet = loadKeypair();
// Live fee/buyback recipients from pump's `global` account (pump.fun rotates them; buy needs them).
await refreshGlobalFeeState().catch((e) => console.warn(`[fee-state] ${e.message}`));
const positions = new Map();
const watchlist = new Map();
let lastBuyTime = 0;
let totalPnl = 0;
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

const guard = new TradeGuard();

// --- Stop machinery ---------------------------------------------------------
// A breached limit must END the session, not leave a bot that keeps scanning and logging
// "skip: trading halted" on every token. limit -> close positions -> session report.
let stopping = false; // no new work is accepted
let exited = false; // report printed, process is on its way out
let stopReason = "";

function recordResult(pnlSol) {
  guard.recordResult(pnlSol);
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
// (check → await → set race). Same fix as bots/sniper/sniper.mjs.
const opening = new Set();

function parseV3TradeEvent(data) {
  if (data.length < 129) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  const virtualSolReserves = data.readBigUInt64LE(97);
  const virtualTokenReserves = data.readBigUInt64LE(105);
  const realSolReserves = data.readBigUInt64LE(113);
  const realTokenReserves = data.readBigUInt64LE(121);
  return {
    mint, solAmount, tokenAmount, user,
    virtualSolReserves, virtualTokenReserves,
    realSolReserves, realTokenReserves,
  };
}

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

async function buyToken(mint, fillPct, virtualSolReserves, virtualTokenReserves, meta = {}) {
  if (positions.size >= MAX_POSITIONS) return;
  if (positions.has(mint) || opening.has(mint)) return;
  if (blacklist.has(mint) || attempted.has(mint)) return;
  if ((buyFailUntil.get(mint) || 0) > Date.now()) return;
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

    // Exit preview: a buy moves the curve, then the sell pays its own 1% fee. If an immediate
    // round trip already returns < EXIT_MIN_RATIO of the buy (or the curve cannot pay it), skip.
    const prev = previewExit(state, BUY_SOL);
    const exitRatio = prev.ok ? prev.ratio : null;
    const skipReason = !prev.ok
      ? prev.reason
      : !prev.payable
        ? "curve cannot pay the exit (rSol < out)"
        : prev.ratio < EXIT_MIN_RATIO
          ? `exit ratio ${prev.ratio.toFixed(3)} < ${EXIT_MIN_RATIO}`
          : null;
    journal.write({ ...candidate, action: skipReason ? "skip" : "enter", exitRatio, reason: skipReason });
    if (skipReason) {
      guard.release(BUY_SOL);
      attempted.add(mint);
      log(`  skip: ${skipReason}`);
      return;
    }

    log(`*** PRE-GRADUATION BUY ***`);
    log(`  mint: ${mint}`);
    log(`  fill: ${fillPct.toFixed(1)}% | spot ${quotePrice.toExponential(3)} | exit preview ${(exitRatio * 100).toFixed(1)}%`);
    log(`  buying ${BUY_SOL} SOL`);

    if (DRY_RUN) {
      positions.set(mint, {
        tokens: prev.tokensOut,
        entrySolSol: BUY_SOL,
        entryPrice: quotePrice,
        entryTime: Date.now(),
        fillAtEntry: fillPct,
        attempts: 0,
      });
      lastBuyTime = Date.now();
      session.buy(BUY_SOL);
      attempted.add(mint);
      log(`  [DRY RUN] position tracked`);
      return;
    }

    const expectedTokens = calcBuyTokens(state, BUY_SOL);
    const minTokens = (expectedTokens * BigInt(10000 - BUY_SLIPPAGE_BPS)) / 10000n;
    // Slippage headroom on max_sol_cost: without it any upward tick means Custom 6002.
    const maxSolCost = BigInt(Math.floor(BUY_SOL * 1e9 * (1 + BUY_SLIPPAGE_BPS / 10000)));
    const ixs = [
      ...computeBudgetIxs(),
      userAtaIx(wallet.publicKey, mintPk),
      buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens, {
        creator: state.creator ? new PublicKey(state.creator) : undefined,
        isMayhem: !!state.isMayhemMode,
        maxSolCost,
      }),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    // Same pre-send simulation as the sell: a doomed buy must not be broadcast (it would pay the fee).
    const sim = await simulateTx(tx);
    if (!sim.ok) {
      guard.release(BUY_SOL);
      attempted.add(mint);
      buyFailUntil.set(mint, Date.now() + BUY_REJECT_COOLDOWN_MS);
      const why = describeTxError(sim.err);
      log(`  buy simulation failed: ${why} — not sending`);
      journal.write({ ...candidate, type: "buy_attempt", simulationResult: "fail", sent: false, error: why });
      return;
    }
    const sig = await sendTxWithRetry(tx, { skipPreflight: true });
    // Entry price = ACTUAL execution (tokens that arrived / SOL that left), not the pre-trade quote.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    const entrySol = ex.found && ex.solSpentSol > 0 ? ex.solSpentSol : BUY_SOL;
    const tokens = ex.found && ex.tokensReceived > 0n ? ex.tokensReceived : expectedTokens;
    const entryPrice = Number(tokens) > 0 ? entrySol / (Number(tokens) / 1e6) : quotePrice;
    positions.set(mint, {
      tokens,
      entrySolSol: entrySol,
      entryPrice,
      entryTime: Date.now(),
      fillAtEntry: fillPct,
      attempts: 0,
    });
    lastBuyTime = Date.now();
    attempted.add(mint);
    session.buy(entrySol);
    journal.trade({
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
      gitSha: GIT_SHA,
      mint,
      side: "buy",
      sig,
      solSpent: entrySol,
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
    guard.release(BUY_SOL);
    buyFailUntil.set(mint, Date.now() + BUY_REJECT_COOLDOWN_MS);
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

function markStuck(mint, pos, reason) {
  stuck.add(`${mint.slice(0, 12)}: ${reason}`);
  session.drop(`${mint.slice(0, 12)}: STUCK ${reason}`);
  journal.write({
    type: "stuck",
    sessionId: SESSION_ID,
    paramsHash: PARAMS_HASH,
    gitSha: GIT_SHA,
    mint,
    reason,
    attempts: pos.attempts || 0,
    tokens: (pos.tokens ?? 0n).toString(),
  });
  log(`  ALERT: ${mint.slice(0, 12)} STUCK (${reason}) — retries stopped, use scripts/rescue-sell.mjs`);
  positions.delete(mint);
}

async function sellPosition(mint, mintPk, pos, ratio) {
  if (DRY_RUN) {
    const mult = ratio ?? (pos.lastPrice && pos.entryPrice ? pos.lastPrice / pos.entryPrice : 1);
    const entrySol = pos.entrySolSol ?? BUY_SOL;
    const pnlSol = entrySol * (mult - 1);
    const costs = roundTripCosts({ buySol: entrySol, ratio: mult });
    recordResult(pnlSol);
    session.sell(entrySol + pnlSol, pnlSol, costs);
    totalTrades++;
    totalPnl += pnlSol;
    if (pnlSol > 0) wins++;
    log(`  [DRY RUN] sold: ${mult >= 1 ? "+" : ""}${((mult - 1) * 100).toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
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
  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const total = BigInt(info.value.amount);
    if (total === 0n) {
      session.drop(`${mint.slice(0, 12)}: no tokens in wallet`);
      positions.delete(mint);
      return;
    }

    const state = await getBondingCurveState(mintPk, 0);
    let ixs;
    let amountRaw = total;
    if (state && !state.complete) {
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
      venue = "pumpswap";
      // The AMM layout is built from the IDL but has not landed on-chain yet: gated in live mode.
      if (LIVE && process.env.LIVE_CONFIRM_AMM !== "yes") {
        markStuck(mint, pos, "PumpSwap sell UNVERIFIED (set LIVE_CONFIRM_AMM=yes to try)");
        return;
      }
      const q = await ammSellQuote(connection, mintPk, total);
      if (!q) {
        markStuck(mint, pos, "no venue (curve complete, no pool)");
        return;
      }
      quote = q.solOut;
      const minOut = (quote * BigInt(10000 - slip)) / 10000n;
      const userWsol = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM);
      ixs = [
        ...computeBudgetIxs(),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM),
        ammSellIx(wallet.publicKey, mintPk, q.pool, q.p, q.g, total, minOut),
        createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM),
      ];
    }

    const tx = await buildVersionedTx(wallet, ixs);
    // Pre-send simulation: a doomed tx burns the fee and, for a sell, keeps the position hostage.
    const sim = await simulateTx(tx);
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
        sent: false,
      });
      log(`  sell simulation failed (${venue}): ${why} — not sending`);
      if (attempt >= SELL_MAX_ATTEMPTS) markStuck(mint, pos, `simulation: ${why}`);
      else pos.nextSellAt = Date.now() + 2000 * 2 ** (attempt - 1);
      return;
    }

    const sig = await sendTxWithRetry(tx, { skipPreflight: true });
    // Received SOL from the chain (fee excluded), falling back to the quote if meta lags.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    const receivedSol = ex.found && ex.solReceivedSol > 0 ? ex.solReceivedSol : Number(quote) / 1e9;
    const entrySol = pos.entrySolSol ?? BUY_SOL;
    const pnlActual = roundSol(receivedSol - entrySol);
    recordResult(pnlActual);
    session.sell(receivedSol, pnlActual, roundTripCosts({ buySol: entrySol, ratio: receivedSol / entrySol, pumpFeeBps: 0 }));
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
      solReceived: receivedSol,
      pnlSol: pnlActual,
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
    if (amountRaw < total) {
      // Partial fill: keep the position with what is left; the next cycle re-reads the curve.
      pos.tokens = total - amountRaw;
      pos.attempts = 0;
      pos.nextSellAt = 0;
      log(`  remaining ${(Number(pos.tokens) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} tokens kept for the next cycle`);
    } else {
      positions.delete(mint);
    }
  } catch (err) {
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
    });
    log(`  sell attempt ${attempt}/${SELL_MAX_ATTEMPTS} failed (${venue}): ${why}`);
    if (attempt >= SELL_MAX_ATTEMPTS) markStuck(mint, pos, why);
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
    log(`  closing ${positions.size} open position(s) before exit${DRY_RUN ? " [DRY RUN: simulated]" : ""}...`);
    // Short drain: the exit must not hang on a slow/graduated mint. Whatever is left afterwards
    // is reported as STUCK (listed separately in the summary), never silently dropped.
    const deadline = Date.now() + 8000;
    for (const [mint, pos] of [...positions]) {
      if (Date.now() > deadline) break;
      try {
        const mintPk = new PublicKey(mint);
        const state = await getBondingCurveState(mintPk, 0);
        const entryLamports = BigInt(Math.floor((pos.entrySolSol ?? BUY_SOL) * 1e9));
        const ratio =
          state && !state.complete && pos.tokens
            ? Number(calcSellSol(state, pos.tokens)) / Number(entryLamports)
            : null;
        if (DRY_RUN && ratio == null) {
          if (pos.lastPrice == null) {
            log(`  ${mint.slice(0, 12)}: no price at stop, dropping`);
            session.drop(`${mint.slice(0, 12)}: no price at stop`);
            positions.delete(mint);
            continue;
          }
          log(`  ${mint.slice(0, 12)}: curve gone, valuing at last known price (DRY RUN)`);
          await sellPosition(mint, mintPk, pos, pos.lastPrice / pos.entryPrice);
        } else {
          await sellPosition(mint, mintPk, pos, ratio); // real path: curve, or PumpSwap when complete
        }
      } catch (err) {
        log(`  close failed ${mint.slice(0, 8)}: ${describeTxError(err)}`);
      }
    }
  }
  for (const [mint, pos] of [...positions]) {
    stuck.add(`${mint.slice(0, 12)}: open at stop`);
    journal.write({ type: "stuck", sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mint, reason: "open at stop", attempts: pos.attempts || 0 });
    session.drop(`${mint.slice(0, 12)}: still open at stop`);
    positions.delete(mint);
  }
  const endSol = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;
  session.report({
    reason,
    openPositions: positions.size,
    endSol,
    openSpentSol: positions.size * BUY_SOL,
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
log(`Session: ${SESSION_ID} | params ${PARAMS_HASH} | git ${GIT_SHA || "n/a"} | journal ${journal.dir}`);

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  if (stopping) return; // session stopped: ignore late events
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  let isBuy = false;
  for (const l of value.logs) {
    const m = l.match(/Instruction: (\w+)/);
    if (m && BUY_INSTRUCTIONS.has(m[1])) { isBuy = true; break; }
  }
  if (!isBuy) return;

  for (const l of value.logs) {
    if (!l.startsWith("Program data: ")) continue;
    const data = Buffer.from(l.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const ev = parseV3TradeEvent(data);
      if (!ev) continue;

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

      if (fillPct >= MIN_FILL_PCT && fillPct <= MAX_FILL_PCT) {
        const prev = watchlist.get(ev.mint);
        if (!prev || fillPct > prev.fillPct) {
          watchlist.set(ev.mint, { fillPct, ts: Date.now() });
          log(
            `WATCHLIST: ${ev.mint.slice(0, 12)} fill=${fillPct.toFixed(1)}% rSol=${(Number(ev.realSolReserves) / 1e9).toFixed(2)} holders=${holders}`,
          );
        }

        if (
          !positions.has(ev.mint) &&
          !opening.has(ev.mint) &&
          positions.size + opening.size < MAX_POSITIONS
        ) {
          opening.add(ev.mint);
          try {
            await buyToken(ev.mint, fillPct, ev.virtualSolReserves, ev.virtualTokenReserves, { holders });
          } finally {
            opening.delete(ev.mint);
          }
        }
      }
    } catch { /* malformed Program data payload: skip this line, keep the subscription alive */ }
    break;
  }
});

log("\nListening for near-graduation tokens...\n");

// Cleanup old watchlist entries every minute
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [mint, info] of watchlist) {
    if (now - info.ts > 600_000) watchlist.delete(mint);
  }
  // Holder sets are only useful while a mint is a live candidate.
  if (holdersSeen.size > 5_000) {
    const keep = new Set([...watchlist.keys(), ...positions.keys(), ...opening]);
    for (const mint of holdersSeen.keys()) if (!keep.has(mint)) holdersSeen.delete(mint);
  }
}, 60_000);

process.on("SIGINT", () => {
  // First Ctrl+C: close positions, print the summary, then exit (finish is idempotent).
  // Second Ctrl+C while the shutdown is running: leave immediately.
  if (stopping) {
    log("\nsecond Ctrl+C — exiting now");
    process.exit(0);
  }
  void finish("manual stop (Ctrl+C)");
});
