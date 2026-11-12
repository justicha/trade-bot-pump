#!/usr/bin/env node
// Снайпер: покупает новые токены на pump.fun при появлении BondingCurveV3,
// продаёт по take-profit / stop-loss / timeout (V3 API)
//
// Использование: node bots/sniper/sniper.mjs [--live]   (по умолчанию dry-run; --live включает реальную торговлю)
//
// Конфиг через ENV или .env:
//   SNIPER_BUY_SOL=0.1          — сколько SOL на покупку
//   SNIPER_TAKE_PROFIT=2.0      — продать при 2x
//   SNIPER_STOP_LOSS=0.5        — продать если цена упала до 0.5x
//   SNIPER_TIMEOUT_SEC=120      — продать через 120 секунд
//   SNIPER_MAX_POSITIONS=3      — максимум одновременных позиций
//   SNIPER_MIN_DEV_BUY=0.5      — минимальная покупка dev'а (SOL)
//   SNIPER_COOLDOWN_SEC=10      — пауза между покупками

import { PublicKey } from "@solana/web3.js";
import path from "node:path";
import fs from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  userAtaIx,
} from "../../lib/pumpfun.mjs";
import { connection, getSOLBalance, sendTxWithRetry, rpcStats } from "../../lib/rpc.mjs";
import { simulateThenSend } from "../../lib/send.mjs";
import { SessionLedger } from "../../lib/session.mjs";
import { HolderTracker } from "../../lib/holders.mjs";
import { getSolUsd, fmtUsd, solPerTokenToUsd } from "../../lib/solprice.mjs";
import { TradeJournal } from "../../lib/journal.mjs";
import { checkCurve, metricsOf, rawSolPerTokenToWhole } from "../../lib/curve.mjs";
import { readExecution } from "../../lib/exec.mjs";
import { roundTripCosts } from "../../lib/fees.mjs";
import { applyLiveSell, liveEntry } from "../../lib/live-pnl.mjs";
import { recordStuck } from "../../lib/stuck.mjs";
import { createAtaCloser } from "../../lib/close-ata.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import { MAYHEM_PROGRAM_ID } from "../../lib/mayhem.mjs";
import { brusselsIso, hourInZone, weekdayInZone, MSK_TZ, mskDateKey } from "../../lib/time.mjs";
import { newSessionId, paramsHash, gitSha } from "../../lib/runmeta.mjs";
import { TickLog } from "../../lib/ticks.mjs";
import { evaluateShadow, shadowLines } from "../../lib/shadow.mjs";
import { loadCreatorRegistry, noteCreatorLaunch, creatorLaunches30m, saveCreatorRegistry } from "../../lib/creators.mjs";
import { HolderTickLog } from "../../lib/holderticks.mjs";

// Config — numeric values via numOr: an invalid value (e.g. copied from .env.example with an
// inline comment) fails loudly with the variable name instead of silently becoming NaN.
const BUY_SOL = numOr(process.env.SNIPER_BUY_SOL, 0.1, "SNIPER_BUY_SOL");
const TAKE_PROFIT = numOr(process.env.SNIPER_TAKE_PROFIT, 2.0, "SNIPER_TAKE_PROFIT");
const STOP_LOSS = numOr(process.env.SNIPER_STOP_LOSS, 0.5, "SNIPER_STOP_LOSS");
const TIMEOUT_SEC = numOr(process.env.SNIPER_TIMEOUT_SEC, 120, "SNIPER_TIMEOUT_SEC");
const MAX_POSITIONS = numOr(process.env.SNIPER_MAX_POSITIONS, 3, "SNIPER_MAX_POSITIONS");
const MIN_DEV_BUY = numOr(process.env.SNIPER_MIN_DEV_BUY, 0, "SNIPER_MIN_DEV_BUY");
const COOLDOWN_SEC = numOr(process.env.SNIPER_COOLDOWN_SEC, 10, "SNIPER_COOLDOWN_SEC");
// Holder gate: buy only after N distinct wallets hold tokens (0 = buy at create, old behaviour)
const MIN_HOLDERS = numOr(process.env.SNIPER_MIN_HOLDERS, 4, "SNIPER_MIN_HOLDERS");
const HOLDER_WAIT_SEC = numOr(process.env.SNIPER_HOLDER_WAIT_SEC, 45, "SNIPER_HOLDER_WAIT_SEC");
// Organic crowd: distinct slots and a minimum delay after the create (1 / 0 = old behaviour).
// The research lab is what decides whether these should be > 1 / > 0 for real money.
const MIN_SLOTS = numOr(process.env.SNIPER_MIN_SLOTS, 1, "SNIPER_MIN_SLOTS");
const MIN_DELAY_MS = numOr(process.env.SNIPER_MIN_DELAY_MS, 0, "SNIPER_MIN_DELAY_MS");
// Journal: after a sell, keep sampling the price for N seconds to see what was left on the table.
const POST_EXIT_SEC = numOr(process.env.SNIPER_POST_EXIT_SEC, 300, "SNIPER_POST_EXIT_SEC");
const POLL_MS = 2000;

let totalPnl = 0;
let totalTrades = 0;
let wins = 0;

// Session ledger: spent / received / net for the end-of-session report (lib/session.mjs).
const session = new SessionLedger({ label: "SNIPER", mode: LIVE ? "LIVE" : "DRY RUN" });

const wallet = loadKeypair();
// Live fee/buyback recipients from pump's `global` account (pump.fun rotates them; buy needs them).
await refreshGlobalFeeState().catch((e) => console.warn(`[fee-state] ${e.message}`));
const positions = new Map(); // mint → { tokens, entryPrice, entryTime }
let lastBuyTime = 0;

// A: treat each mint only once, at first sighting. The V3 log stream re-reports the
// same mint as a "create" on later trades, which previously caused duplicate buys of
// the same token and an RPC flood (HTTP 429). Capped so memory stays bounded.
const seenMints = new Set();
const SEEN_MINT_CAP = 50_000;
function markSeen(mint) {
  seenMints.add(mint);
  if (seenMints.size > SEEN_MINT_CAP) {
    const it = seenMints.values();
    for (let i = 0; i < SEEN_MINT_CAP / 2; i++) seenMints.delete(it.next().value);
  }
}

function log(msg) {
  logger.info(msg);
}

const guard = new TradeGuard();

// --- Stop machinery ---------------------------------------------------------
// A breached limit must END the session. Before this, the bot stayed alive after
// MAX_CONSEC_LOSSES and printed "skip: trading halted" for every new token — the limit
// repeated forever instead of finishing. Now: limit -> close everything -> session report.
let stopping = false; // no new work is accepted
let exited = false; // report printed, process is on its way out
let draining = false; // the tick drain is running: a second Ctrl+C aborts it immediately
let stopReason = "";
let summaryWritten = false; // SESSION SUMMARY + session_summary record/file already emitted
let manualStopCloses = 0; // positions closed at stop with exitReason "manual stop"
const CLOSE_TIMEOUT_MS = 15000; // close-open-positions safety budget

// opts.guardPnlSol: a live sale's PnL before network fees — what MAX_CONSEC_LOSSES classifies by
// (lib/guards.mjs). Without it (dry run, STUCK) the guard sees pnlSol, as before.
function recordResult(pnlSol, opts) {
  guard.recordResult(pnlSol, opts);
  if (guard.halted) requestStop(guard.haltReason || "loss limit reached");
}

// Deferred with setImmediate so the trade that triggered the stop can finish its bookkeeping.
function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  setImmediate(() => { void finish(reason); });
}

// Mints with a buy in flight. Counted in the position-cap check so concurrent WS
// callbacks can't overshoot MAX_POSITIONS (check→await→set race).
const opening = new Set();
const blockedLogged = new Set(); // mints already reported as 'not organic'
const skippedLogged = new Set(); // mints already journaled as skipped (slot / cooldown)
const mayhemMints = new Set(); // mints that a Mayhem-routed trade has touched (journal flag only)

// Holder gate: a token held by 2-3 wallets is usually the dev plus his own wallets. Buy only
// once SNIPER_MIN_HOLDERS distinct wallets hold a positive balance.
const holders = new HolderTracker({ minHolders: MIN_HOLDERS, waitMs: HOLDER_WAIT_SEC * 1000, minSlots: MIN_SLOTS, minDelayMs: MIN_DELAY_MS });

// Trade journal (data/journal/*.jsonl): what the bot saw, entered, exited, and what the price
// did afterwards. This is the data used to tune the strategy.
const journal = new TradeJournal({ bot: "sniper" });

// Single-instance lock: two bots writing the same journal produce duplicate trades (each buys the
// same mint). The lock stores our PID; a second start refuses when that PID is still alive.
const LOCK_PATH = path.join(journal.dir, ".sniper.lock");
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
    if (e.code !== "EEXIST") {
      log(`warning: could not create instance lock: ${e.message}`);
      return;
    }
  }
  // The lock exists: only a dead PID may be replaced.
  const existing = fs.readFileSync(LOCK_PATH, "utf8").trim();
  const pid = Number(existing);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
    log(`FATAL: another sniper instance is already running (PID ${pid}, lock ${LOCK_PATH}). Refusing to start to avoid duplicate trades.`);
    process.exit(1);
  }
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    // Re-read: if a simultaneous starter raced us and its PID is alive, we must not run twice.
    const reread = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const other = Number(reread);
    if (Number.isInteger(other) && other !== process.pid && processAlive(other)) {
      log(`FATAL: another sniper instance is already running (PID ${other}, lock ${LOCK_PATH}). Refusing to start to avoid duplicate trades.`);
      process.exit(1);
    }
  } catch (err) {
    log(`warning: could not write instance lock: ${err.message}`);
  }
}
function releaseInstanceLock() {
  try {
    if (fs.readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH);
  } catch { /* already gone */ }
}
const entryMeta = new Map(); // mint -> { devBuySol, holdersAtEntry }
const postExit = new Map(); // mint -> price samples taken after the sell
const closedTrades = []; // every closed trade's journal line, for the in-session shadow report (item 5)

// ---- run metadata (stamped into every journal line) -------------------------
const SESSION_ID = newSessionId("sniper");
const GIT_SHA = gitSha();
const PARAMS_HASH = paramsHash({
  BUY_SOL, TAKE_PROFIT, STOP_LOSS, TIMEOUT_SEC, MAX_POSITIONS, COOLDOWN_SEC,
  MIN_HOLDERS, MIN_SLOTS, MIN_DELAY_MS, HOLDER_WAIT_SEC, MIN_DEV_BUY, POST_EXIT_SEC, SLIPPAGE_BPS,
});
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
// Launch price of a standard pump.fun curve in RAW units (30 SOL virtual / 1.073e9 tokens).
// Recorded as the price basis used for the premium metric; source is marked "assumed" because the
// on-chain value is verified separately (task C).
const START_PRICE_RAW = 30e9 / 1.073e15;
const START_PRICE_SOURCE = "assumed:30SOL/1.073e9";

// Holder milestones + price trajectory (step 3): written to holders-<date>.jsonl so the shadow
// analysis can evaluate entries at 4/6/8/10 holders and partial/trailing exits from tick data.
const holderTicks = new HolderTickLog({ dir: journal.dir, sessionId: SESSION_ID, log });
async function recordHolderMilestones(mint, newly) {
  let state = null;
  try { state = await getBondingCurveState(new PublicKey(mint), 0, 3); } catch { state = null; }
  const price = state ? getPrice(state) : null;
  for (const n of newly) holderTicks.writeMilestone(mint, n, { price, source: state ? "account" : "none" });
}

// ---- instrumentation only (never feeds a decision) --------------------------
// Per-mint buy/sell counters and unique buyers, for the tick log.
const mintStats = new Map(); // mint -> { buys, sells, buyers:Set }
// Latest curve reserves from the WebSocket stream: the price source for the poll / ticks / post-exit
// sampler. This is what removes the RPC flood (the account is read once for the token type, not on
// every tick).
const curveStream = new Map(); // mint -> { vSol: BigInt, vTok: BigInt, ts: number }
const STALE_MS = numOr(process.env.SNIPER_STALE_MS, 2000, "SNIPER_STALE_MS");
function streamPrice(mint) {
  const s = curveStream.get(mint);
  if (!s || !s.vTok) return null;
  return Number(s.vSol) / Number(s.vTok);
}
function streamAgeMs(mint) {
  const s = curveStream.get(mint);
  return s ? Date.now() - s.ts : null;
}
// Account-price cache for the stale fallback (item 2): at most one account read per STALE_MS per
// mint. `state` is kept so a confirmed exit can reuse the same fetch (no double priority-0 RPC).
const accountPriceCache = new Map(); // mint -> { price, ts, state }
const PHANTOM_THROTTLE_MS = 5000;
const phantomLogged = new Map(); // mint -> last phantom ts
function statsOf(mint) {
  const s = mintStats.get(mint);
  if (!s) return { buys: 0, sells: 0, buyers: 0 };
  return { buys: s.buys, sells: s.sells, buyers: s.buyers.size };
}
// Creator registry (disk-backed): which creator launched which mint, and how many launches the
// creator has made in the last 30 minutes. Persisted to data/creators.json so the counter survives
// a restart.
const creatorOf = new Map(); // mint -> creator
const creatorRegistry = loadCreatorRegistry(); // creator -> [ts, ...]
function noteLaunch(mint, creator, ts) {
  if (!creator) return;
  creatorOf.set(mint, creator);
  noteCreatorLaunch(creatorRegistry, creator, ts);
}
function launches30m(mint) {
  const creator = creatorOf.get(mint);
  return creatorLaunches30m(creatorRegistry, creator);
}

// Tick log: 1 line per second per held position and per post-exit window.
// TICKS=0 disables it entirely (the trading path does not depend on it).
const TICKS_ENABLED = process.env.TICKS !== "0";
const ticks = TICKS_ENABLED
  ? new TickLog({ dir: path.dirname(journal.file()), sessionId: SESSION_ID, log })
  : { track() {}, untrack() {}, start() {}, close() {}, drain: async () => ({ closed: true, remaining: 0, elapsedMs: 0 }), get size() { return 0; }, written: 0 };
if (TICKS_ENABLED) {
  ticks.start(async (mint) => {
    const entry = ticks.entries.get(mint);
    if (!entry) return null;
    // Price from the stream, not RPC: no getAccountInfo per tick. ageMs/stale mark how fresh the
    // stream event is (the shadow V4/V5 replay uses only fresh ticks).
    const price = streamPrice(mint);
    if (!price) return null;
    const s = curveStream.get(mint);
    const ageMs = streamAgeMs(mint);
    return {
      ratio: price / entry.entryPrice,
      vSol: s?.vSol ?? null,
      vTok: s?.vTok ?? null,
      ageMs,
      stale: ageMs === null || ageMs > STALE_MS,
      ...statsOf(mint),
    };
  });
}

async function executeBuy(mint) {
  const mintPk = new PublicKey(mint);
  const state = await getBondingCurveState(mintPk, 0, 1); // priority 1 = entry
  if (!state || state.complete) {
    log(`  skip: bonding curve unavailable`);
    return;
  }

  // Refuse implausible curve states: they produced the 405-801M token entries in the log.
  const sanity = checkCurve(state, { buySol: BUY_SOL });
  if (!sanity.ok) {
    log(`  skip: ${sanity.reason}`);
    session.drop(`${mint.slice(0, 8)}: ${sanity.reason}`);
    journal.write({
      type: "reject",
      mint,
      reason: sanity.reason,
      mode: DRY_RUN ? "DRY" : "LIVE",
      // Both sides of the curve, in raw units, plus where the numbers came from. Task C could not
      // reconcile the old reject values (0.2-9.6 SOL) with the live account, because only vSol/vTok
      // and no source were recorded. Now every value is attributable.
      vSol: String(state.virtualSolReserves),
      vTok: String(state.virtualTokenReserves),
      rSol: state.realSolReserves === undefined || state.realSolReserves === null ? null : String(state.realSolReserves),
      rTok: state.realTokenReserves === undefined || state.realTokenReserves === null ? null : String(state.realTokenReserves),
      source: "account:getBondingCurveState",
      mayhemMode: state.isMayhemMode === undefined ? null : state.isMayhemMode,
      mayhemRouter: mayhemMints.has(mint),
      sessionId: SESSION_ID,
      paramsHash: PARAMS_HASH,
    });
    return;
  }

  const entryPrice = getPrice(state);
  const expectedTokens = calcBuyTokens(state, BUY_SOL);
  const minTokens = (expectedTokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  const solUsd = await getSolUsd();
  // humans (and dollars) price a WHOLE token: getPrice() returns SOL per raw unit, which is
  // 1000x larger and made the old '$ per token' value 1000x too big.
  const m = metricsOf(state);
  const entryUsd = solPerTokenToUsd(m ? m.price : null, solUsd);
  const supply = state.tokenTotalSupply ? Number(state.tokenTotalSupply) / 1e6 : null;
  const mcapUsd = entryUsd && supply ? entryUsd * supply : null;
  const meta = entryMeta.get(mint) || {};

  log(`  buying ${BUY_SOL} SOL -> ~${(Number(expectedTokens) / 1e6).toFixed(0)} tokens`);
  log(`  entry price: ${m ? m.price.toExponential(3) : "n/a"} SOL/token = ${fmtUsd(entryUsd)}/token (SOL ${fmtUsd(solUsd)}, mcap ${fmtUsd(mcapUsd)})`);

  const gate = guard.checkOpen(BUY_SOL);
  if (!gate.ok) {
    log(`  skip: ${gate.reason}`);
    if (gate.terminal) requestStop(gate.reason); // session is over -> finish with the summary
    return;
  }
  guard.reserve(BUY_SOL); // synchronous reservation closes the concurrent-event race

  const posRec = {
    tokens: expectedTokens,
    entryPrice,
    // SOL the buy itself took. Nominal until a live buy lands; then readExecution's actual spend
    // (without network fee and ATA rent) replaces it — see lib/live-pnl.mjs.
    entrySolSol: BUY_SOL,
    entrySource: DRY_RUN ? "dry-run" : "quote-fallback",
    buyFeeSol: null, // actual network fee of the buy (null = unknown)
    ataRentSol: 0, // rent locked in the token ATA created by the buy
    ataRentKnown: false,
    entryTime: Date.now(),
    entryUsd,
    solUsd,
    holdersAtEntry: meta.holdersAtEntry ?? null,
    devBuySol: meta.devBuySol ?? null,
    peak: 1, // best price multiple seen while holding
    // journal context (instrumentation only)
    creator: creatorOf.get(mint) ?? null,
    creatorLaunches30m: launches30m(mint),
    entryVSol: state.virtualSolReserves,
    entryRSol: state.realSolReserves,
    // curve type decided from the ACCOUNT before entry (byte 81), not from the trade routing
    mayhemMode: state.isMayhemMode === undefined ? null : state.isMayhemMode,
    mayhemRouter: mayhemMints.has(mint),
  };

  if (DRY_RUN) {
    positions.set(mint, posRec);
    lastBuyTime = Date.now();
    session.buy(BUY_SOL);
    ticks.track(mint, { phase: "hold", entryPrice });
    log(`  [DRY RUN] would buy — position tracked`);
    return;
  }

  // Never send a live buy with a stale fee recipient: retry the global read right here.
  await ensureGlobalFeeState().catch((e) => log(`  fee state refresh failed: ${e.message}`));
  const ixs = [
    ...computeBudgetIxs(),
    userAtaIx(wallet.publicKey, mintPk),
    buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens, {
      creator: state.creator ? new PublicKey(state.creator) : undefined,
      isMayhem: !!state.isMayhemMode,
    }),
  ];

  try {
    const tx = await buildVersionedTx(wallet, ixs);
    const sig = await simulateThenSend(tx);
    // C5: entry from ACTUAL execution (tokens that arrived / SOL that left), not the quote.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    // Actual entry (no network fee, no ATA rent) or the nominal size flagged "quote-fallback".
    Object.assign(posRec, liveEntry(ex, BUY_SOL));
    if (ex.found && ex.tokensReceived > 0n) {
      const spent = posRec.entrySolSol;
      posRec.tokens = ex.tokensReceived;
      posRec.entryPrice = Number(ex.tokensReceived) > 0 ? spent / (Number(ex.tokensReceived) / 1e6) : entryPrice;
      positions.set(mint, posRec);
      lastBuyTime = Date.now();
      session.buy(spent);
      session.ataRent(posRec.ataRentSol);
      ticks.track(mint, { phase: "hold", entryPrice: posRec.entryPrice });
      log(`  position opened (actual ${ex.tokensReceived} tokens for ${spent.toFixed(6)} SOL, ATA rent ${posRec.ataRentSol.toFixed(6)})`);
    } else {
      positions.set(mint, posRec);
      lastBuyTime = Date.now();
      session.buy(posRec.entrySolSol);
      session.ataRent(posRec.ataRentSol);
      ticks.track(mint, { phase: "hold", entryPrice });
      log(`  position opened (quote-fallback)`);
    }
  } catch (err) {
    // C2: the tx may have been sent and confirmed even though confirmTransaction failed. If the
    // chain shows the tokens arrived, record the position instead of releasing the reserve and
    // dropping it — the money WAS spent.
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensReceived > 0n) {
        posRec.tokens = ex.tokensReceived;
        Object.assign(posRec, liveEntry(ex, BUY_SOL));
        const spent = posRec.entrySolSol;
        posRec.entryPrice = Number(ex.tokensReceived) > 0 ? spent / (Number(ex.tokensReceived) / 1e6) : posRec.entryPrice;
        positions.set(mint, posRec);
        lastBuyTime = Date.now();
        session.buy(spent);
        session.ataRent(posRec.ataRentSol);
        ticks.track(mint, { phase: "hold", entryPrice: posRec.entryPrice });
        log(`  buy confirmed on-chain despite confirm error (${ex.tokensReceived} tokens) — position opened`);
        return;
      }
    }
    guard.release(BUY_SOL);
    log(`  buy failed: ${err.message}`);
  }
}

async function executeSell(mint, reason, exitInfo = null) {
  const pos = positions.get(mint);
  if (!pos) return;

  const mintPk = new PublicKey(mint);
  log(`  selling ${mint.slice(0, 8)}... (${reason})`);

  if (DRY_RUN) {
    // A confirmed exit already carries the account price/state (item 1): reuse it, don't re-read.
    let state = exitInfo?.state || null;
    let sellPrice = exitInfo?.price ?? null;
    let ratio = exitInfo?.ratio ?? null;
    let priceSource = exitInfo?.source ?? null;
    let priceAgeMs = exitInfo?.ageMs ?? null;
    if (!state) {
      state = await getBondingCurveState(mintPk, 0, 0);
      if (state) { sellPrice = getPrice(state); ratio = sellPrice / pos.entryPrice; priceSource = "account"; priceAgeMs = streamAgeMs(mint); }
    }
    if (state && sellPrice !== null && ratio !== null) {
      const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
      // Curve mid prices are gross: charge 1% in + 1% out, adverse slippage and the tx fees.
      const costs = roundTripCosts({ buySol: BUY_SOL, ratio });
      const pnlSol = costs.netPnl;
      const pnlPct = (pnlSol / BUY_SOL) * 100;
      recordExit(mint, pos, {
        exitPrice: sellPrice,
        ratio,
        pnlSol,
        holdSec: Number(holdSec),
        reason,
        costs,
        exitVSol: state.virtualSolReserves,
        exitRSol: state.realSolReserves,
        priceSource,
        priceAgeMs,
      });
      recordResult(pnlSol);
      session.sell(BUY_SOL * ratio, costs.grossPnl, costs);
      totalTrades++;
      if (pnlPct > 0) wins++;
      log(`  [DRY RUN] would sell: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% net of costs (gross ${((ratio - 1) * 100).toFixed(1)}%, costs ${costs.costSol.toFixed(5)} SOL, exit ${fmtUsd(solPerTokenToUsd(rawSolPerTokenToWhole(sellPrice), pos.solUsd))}), held ${holdSec}s`);
      log(`  session: ${totalTrades} trades, ${wins}W/${totalTrades - wins}L`);
    } else {
      // Curve account gone (graduated/rugged): no price to value the exit at. Say it out loud
      // instead of dropping the position silently.
      log(`  no curve state for ${mint.slice(0, 8)} — position dropped without an exit price`);
      session.drop(`${mint.slice(0, 8)}: curve state unavailable`);
    }
    positions.delete(mint);
    return;
  }

  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const tokenAmount = BigInt(info.value.amount);

    if (tokenAmount === 0n) {
      log(`  no tokens in wallet`);
      session.drop(`${mint.slice(0, 8)}: no tokens in wallet`);
      positions.delete(mint);
      return;
    }

    const state = await getBondingCurveState(mintPk, 0, 0);
    if (!state || state.complete) {
      // The curve is closed and this bot has no AMM sell: the tokens stay in the wallet. That used
      // to be a silent drop — invisible to MAX_CONSEC_LOSSES. Now it is a journaled STUCK whose
      // entry is booked as an assumed loss (lib/stuck.mjs).
      const why = state ? "curve complete: no AMM sell in this bot" : "curve unavailable: no AMM sell in this bot";
      const lossSol = recordStuck({
        journal,
        recordResult,
        mint,
        pos: { ...pos, tokens: tokenAmount },
        buySol: BUY_SOL,
        reason: why,
        fields: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mode: "LIVE", exitReason: reason },
      });
      log(`  STUCK ${mint.slice(0, 8)}: ${why} — booked as an assumed loss of ${lossSol.toFixed(6)} SOL, use scripts/rescue-sell.mjs`);
      session.drop(`${mint.slice(0, 8)}: STUCK ${why}`);
      positions.delete(mint);
      return;
    }

    const expectedSol = calcSellSol(state, tokenAmount);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, tokenAmount, minSol, {
        creator: state.creator ? new PublicKey(state.creator) : undefined,
        isMayhem: !!state.isMayhemMode,
      }),
    ];

    const tx = await buildVersionedTx(wallet, ixs);
    const sig = await simulateThenSend(tx);
    // C5: received SOL from the chain (the wallet delta, i.e. already NET of this tx's network
    // fee), falling back to the quote if meta lags.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);

    const sellPrice = getPrice(state);
    const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
    const buyAt = new Date(pos.entryTime);
    const sellAt = new Date();
    // PnL from ACTUALS — the same calculation as graduation-sniper and copy-trader
    // (lib/live-pnl.mjs applyLiveSell): proceeds - actual entry - both real network fees. No
    // estimated tx fee and no assumed slippage. One curve sell tx sells the whole balance or
    // fails, so sold = total here.
    const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, quoteSol: Number(expectedSol) / 1e9, soldRaw: tokenAmount, totalRaw: tokenAmount });
    const { acc } = sale;
    const { pnlSol, costs } = acc;
    const pnlPct = acc.shareEntry > 0 ? (pnlSol / acc.shareEntry) * 100 : 0;
    recordExit(mint, pos, {
      exitPrice: sellPrice,
      ratio: sellPrice / pos.entryPrice,
      pnlSol,
      holdSec: Number(holdSec),
      reason,
      costs,
      exitVSol: state.virtualSolReserves,
      exitRSol: state.realSolReserves,
      priceSource: ex.found ? "chain-meta" : "quote-fallback",
      priceAgeMs: streamAgeMs(mint),
      live: sale.fields,
    });
    recordResult(pnlSol, { guardPnlSol: sale.guardPnlSol });
    session.sell(acc.ledger.receivedSol, acc.ledger.pnlSol, costs);
    totalPnl += pnlSol;
    totalTrades++;
    if (pnlSol > 0) wins++;
    log(`  sold: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL), held ${holdSec}s  buy ${buyAt.toISOString()} sell ${sellAt.toISOString()}`);
    log(`  session: ${totalTrades} trades, ${wins}W/${totalTrades - wins}L, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    positions.delete(mint);
    // The sale is confirmed and booked: now (and only now) try to close the empty ATA.
    ataCloser.schedule(mint, { venue: "curve" });
  } catch (err) {
    // C2: the sell may have landed even though confirmTransaction failed. If the chain shows the
    // tokens left the wallet, record the exit instead of leaving the position open to be re-sold.
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensSold > 0n) {
        const st = await getBondingCurveState(mintPk, 0, 0).catch(() => null);
        const sellPrice = st ? getPrice(st) : pos.entryPrice;
        const ratio = sellPrice / pos.entryPrice;
        // The chain value is a fact even when nothing arrived (proceeds below the fee): never
        // replace it with BUY_SOL, which booked such a sale as break-even. The sniper sells the
        // whole balance in one tx, so the landed sale closes the position (sold = total).
        const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, soldRaw: ex.tokensSold, totalRaw: ex.tokensSold });
        const { acc } = sale;
        const { pnlSol, costs } = acc;
        const holdSec = ((Date.now() - pos.entryTime) / 1000).toFixed(0);
        recordExit(mint, pos, {
          exitPrice: sellPrice,
          ratio,
          pnlSol,
          holdSec: Number(holdSec),
          reason: `${reason} (reconciled)`,
          costs,
          exitVSol: st ? st.virtualSolReserves : null,
          exitRSol: st ? st.realSolReserves : null,
          priceSource: "chain-meta",
          priceAgeMs: streamAgeMs(mint),
          live: sale.fields,
        });
        recordResult(pnlSol, { guardPnlSol: sale.guardPnlSol });
        session.sell(acc.ledger.receivedSol, acc.ledger.pnlSol, costs);
        totalPnl += pnlSol;
        totalTrades++;
        if (pnlSol > 0) wins++;
        positions.delete(mint);
        log(`  sold (reconciled after confirm error): ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL`);
        ataCloser.schedule(mint, { venue: "curve" });
        return;
      }
    }
    log(`  sell failed: ${err.message}`);
  }
}

function costsCosts(c) {
  return c ? Math.round(Number(c.costSol || 0) * 1e9) / 1e9 : null;
}

function round9(x) {
  return Math.round(x * 1e9) / 1e9;
}

// One journal line per closed trade, then watch what the price does without us.
// `costs` is optional here: it used to be read from an enclosing scope that no longer has it,
// which threw on every exit ("costs is not defined") and left the position open forever.
// `live`: journal fields of a LIVE sale (lib/live-pnl.mjs liveSellFields) — actual entry/proceeds
// and the real network fees.
function recordExit(mint, pos, { exitPrice, ratio, pnlSol, holdSec, reason, costs, exitVSol = null, exitRSol = null, priceSource = null, priceAgeMs = null, unconfirmed = false, live = null }) {
  entryMeta.delete(mint);
  const sellAt = new Date();
  const buyAt = new Date(pos.entryTime);
  const line = {
    mode: DRY_RUN ? "DRY" : "LIVE",
    mint,
    buySol: BUY_SOL,
    entrySol: pos.entryPrice,
    entryUsd: pos.entryUsd ?? null,
    exitSol: exitPrice,
    exitUsd: solPerTokenToUsd(rawSolPerTokenToWhole(exitPrice), pos.solUsd),
    solUsd: pos.solUsd ?? null,
    ratio: round9(ratio),
    peakRatio: round9(pos.peak || 1),
    pnlPct: round9((ratio - 1) * 100),
    pnlSol: round9(pnlSol),
    holdSec,
    // Timing, in UTC and in Europe/Brussels (lib/time.mjs). buyAt/sellAt stay ISO-8601 so a parser
    // can compare them directly; the Brussels pair and the hour/weekday are for humans.
    buyAt: buyAt.toISOString(),
    sellAt: sellAt.toISOString(),
    buyAtBrussels: brusselsIso(buyAt),
    sellAtBrussels: brusselsIso(sellAt),
    buyHour: hourInZone(buyAt, MSK_TZ),
    buyWeekday: weekdayInZone(buyAt, MSK_TZ),
    exitReason: reason,
    holdersAtEntry: pos.holdersAtEntry ?? null,
    devBuySol: pos.devBuySol ?? null,
    costsSol: costsCosts(costs),
    isMayhem: mayhemMints.has(mint),
    mayhemRouter: mayhemMints.has(mint),
    mayhemMode: pos.mayhemMode === undefined ? null : pos.mayhemMode,
    // net% written explicitly so a consumer never has to derive it from pnlPct (which is gross)
    pnlPctNet: Math.round((pnlSol / BUY_SOL) * 10000) / 100,
    // context for the analysis (instrumentation only, none of it feeds a decision)
    creator: pos.creator ?? null,
    creatorLaunches30m: pos.creatorLaunches30m ?? null,
    curveType: pos.mayhemMode === true ? "mayhem" : pos.mayhemMode === false ? "standard" : mayhemMints.has(mint) ? "mayhem(router)" : "standard",
    startPrice: START_PRICE_RAW,
    startPriceSource: START_PRICE_SOURCE,
    virtualSolReserves: pos.entryVSol === undefined ? null : String(pos.entryVSol),
    realSolReserves: pos.entryRSol === undefined ? null : String(pos.entryRSol),
    exitVirtualSolReserves: exitVSol === null || exitVSol === undefined ? null : String(exitVSol),
    exitRealSolReserves: exitRSol === null || exitRSol === undefined ? null : String(exitRSol),
    priceSource,
    priceAgeMs: priceAgeMs === null || priceAgeMs === undefined ? null : Math.round(priceAgeMs),
    unconfirmed: unconfirmed === true,
    ...(live || {}),
    sessionId: SESSION_ID,
    paramsHash: PARAMS_HASH,
    gitSha: GIT_SHA,
  };
  closedTrades.push(line);
  // A journal failure must never keep a position open: log it and carry on with the exit.
  try {
    journal.trade(line);
  } catch (err) {
    log(`  journal write failed (${mint.slice(0, 8)}): ${err.message}`);
  }
  if (!POST_EXIT_SEC) {
    ticks.untrack(mint);
    return;
  }
  const now = Date.now();
  postExit.set(mint, {
    startAt: now,
    until: now + POST_EXIT_SEC * 1000,
    lastAt: 0,
    entryPrice: pos.entryPrice,
    exitRatio: ratio,
    best: ratio,
    solUsd: pos.solUsd ?? null,
  });
  // tick log: switch this mint from the hold window to the full post-exit window
  ticks.untrack(mint);
  ticks.track(mint, { phase: "post", entryPrice: pos.entryPrice, until: now + POST_EXIT_SEC * 1000 });
}

// Sample prices of tokens we already sold: the "closed too early?" data.
async function samplePostExit() {
  if (postExit.size === 0) return;
  const now = Date.now();
  for (const [mint, rec] of postExit) {
    try {
      if (now - rec.lastAt >= 5000) {
        rec.lastAt = now;
        // Price from the stream, not RPC.
        const price = streamPrice(mint);
        if (price) {
          const ratio = price / rec.entryPrice;
          if (ratio > rec.best) rec.best = ratio;
        }
      }
      if (now >= rec.until) {
        postExit.delete(mint);
        journal.postExit({
          mint,
          exitRatio: round9(rec.exitRatio),
          bestRatioAfterExit: round9(rec.best),
          windowSec: Math.round((now - rec.startAt) / 1000),
          solUsd: rec.solUsd ?? null,
        });
        log(`  after exit ${mint.slice(0, 8)}: peak ${rec.best.toFixed(2)}x vs exit ${rec.exitRatio.toFixed(2)}x -> journal`);
      }
    } catch {
      /* sampling is best effort */
    }
  }
}

// Resolve the current price for a position (item 2): fresh stream if the last event is < STALE_MS,
// otherwise the account (priority 2, throttled to one read per STALE_MS per mint). Returns
// { price, source, ageMs, state } or null.
async function resolvePrice(mint, { priority = 2 } = {}) {
  const s = curveStream.get(mint);
  const age = s ? Date.now() - s.ts : null;
  if (s && s.vTok && age !== null && age <= STALE_MS) {
    return { price: Number(s.vSol) / Number(s.vTok), source: "stream", ageMs: age, state: null };
  }
  const c = accountPriceCache.get(mint);
  if (c && Date.now() - c.ts < STALE_MS) {
    return { price: c.price, source: "account", ageMs: age, state: c.state };
  }
  let state = null;
  try { state = await getBondingCurveState(new PublicKey(mint), 0, priority); } catch { state = null; }
  if (!state) return null;
  const price = getPrice(state);
  accountPriceCache.set(mint, { price, ts: Date.now(), state });
  return { price, source: "account", ageMs: age, state };
}

// The account is the source of truth for the exit price (item 1): a stream trigger is only acted
// on after this confirms the ratio on-chain. Priority 0 = exit (highest).
async function confirmExitPrice(mint) {
  let state = null;
  try { state = await getBondingCurveState(new PublicKey(mint), 0, 0); } catch { state = null; }
  if (!state) return null;
  return { price: getPrice(state), state };
}

let checking = false;
async function checkPositions() {
  // C: skip if a previous cycle is still running. With 429-induced delays a cycle can
  // exceed POLL_MS, which previously let two cycles overlap and double-sell a position.
  if (stopping) return; // shutdown in progress
  if (checking) return;
  checking = true;
  try {
    await samplePostExit();
    for (const [mint, pos] of positions) {
      try {
        const now = Date.now();
        const holdSec = (now - pos.entryTime) / 1000;

        // Candidate price: fresh stream, else the account (stale fallback, item 2).
        const cand = await resolvePrice(mint, { priority: 2 });
        if (!cand) continue;
        const candRatio = cand.price / pos.entryPrice;
        if (candRatio > (pos.peak || 1)) pos.peak = candRatio;

        let rule = null;
        let detail = "";
        if (candRatio >= TAKE_PROFIT) { rule = "take-profit"; detail = `${candRatio.toFixed(1)}x`; }
        else if (candRatio <= STOP_LOSS) { rule = "stop-loss"; detail = `${candRatio.toFixed(2)}x`; }
        else if (holdSec >= TIMEOUT_SEC) { rule = "timeout"; detail = `${holdSec.toFixed(0)}s`; }
        if (!rule) continue;

        // CONFIRM on-chain before acting (item 1). The stream can spike (esp. the Mayhem SOL side)
        // while the account is unchanged: that is a phantom trigger, not an exit.
        const confirm = await confirmExitPrice(mint);
        let exit = { price: cand.price, ratio: candRatio, source: cand.source, ageMs: cand.ageMs, state: null };
        if (confirm) {
          const confirmedRatio = confirm.price / pos.entryPrice;
          exit = { price: confirm.price, ratio: confirmedRatio, source: "account", ageMs: cand.ageMs, state: confirm.state };
          const reached =
            rule === "take-profit" ? confirmedRatio >= TAKE_PROFIT
            : rule === "stop-loss" ? confirmedRatio <= STOP_LOSS
            : true; // timeout is time-based
          if (!reached) {
            if (now - (phantomLogged.get(mint) || 0) >= PHANTOM_THROTTLE_MS) {
              phantomLogged.set(mint, now);
              journal.write({
                type: "phantom",
                mint,
                rule,
                streamRatio: round9(candRatio),
                accountRatio: round9(confirmedRatio),
                entryPrice: round9(pos.entryPrice),
                mayhemMode: pos.mayhemMode === undefined ? null : pos.mayhemMode,
                sessionId: SESSION_ID,
                paramsHash: PARAMS_HASH,
                gitSha: GIT_SHA,
              });
              log(`  phantom ${rule} ${candRatio.toFixed(2)}x not confirmed by account (${confirmedRatio.toFixed(2)}x) - holding ${mint.slice(0, 8)}`);
            }
            continue;
          }
        }

        await executeSell(mint, `${rule} ${detail}`, exit);
      } catch (err) {
        log(`  check error ${mint.slice(0, 8)}: ${err.message}`);
      }
    }
  } finally {
    checking = false;
  }
}

// Reserve the cooldown + opening slot synchronously (so concurrent WS callbacks cannot
// overshoot MAX_POSITIONS), then buy.
async function buyNow(mint) {
  lastBuyTime = Date.now();
  opening.add(mint);
  try {
    await executeBuy(mint);
  } finally {
    opening.delete(mint);
  }
}

// ---- clean shutdown helpers --------------------------------------------------

// Last price we actually saw for a mint (stream, else the account cache). Used only to value a
// position whose curve account has gone at stop time.
function lastKnownPrice(mint) {
  const s = curveStream.get(mint);
  if (s && s.vTok) return Number(s.vSol) / Number(s.vTok);
  const c = accountPriceCache.get(mint);
  return c ? c.price : null;
}
function lastKnownPriceSource(mint) {
  const s = curveStream.get(mint);
  if (s && s.vTok) return "stream";
  return accountPriceCache.has(mint) ? "account" : null;
}

// Value one open position at the curve account (priority 0) and journal it as a normal trade with
// exitReason "manual stop". If the account is gone, fall back to the last known price (unconfirmed).
async function closePositionAtStop(mint, { unconfirmed = false } = {}) {
  const pos = positions.get(mint);
  if (!pos) return;
  const mintPk = new PublicKey(mint);
  let state = null;
  if (!unconfirmed) {
    try { state = await getBondingCurveState(mintPk, 0, 0); } catch { state = null; }
  }
  if (state) {
    const price = getPrice(state);
    await executeSell(mint, "manual stop", { price, ratio: price / pos.entryPrice, source: "account", ageMs: null, state });
    // M2: count a manual stop only when the position was actually closed (executeSell can fail in
    // LIVE and leave the position open; the fallback pass below then closes it unconfirmed).
    if (!positions.has(mint)) manualStopCloses += 1;
    return;
  }
  // LIVE with no curve account: the position was NOT sold. Never record it as a confirmed sale
  // or credit the session ledger with money that was never received — the tokens stay in the
  // wallet (scripts/rescue-sell.mjs can find them).
  if (!DRY_RUN) {
    log(`  [stop] ${mint.slice(0, 8)} curve unavailable — NOT sold (STUCK: tokens remain in wallet)`);
    // Assumed loss for the limits (lib/stuck.mjs): the daily loss limit must see this position
    // when the bot is restarted on the same day.
    recordStuck({
      journal, recordResult, mint, pos, buySol: BUY_SOL, reason: "stop: curve unavailable, not sold",
      fields: { sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, mode: "LIVE" },
    });
    session.drop(`${mint.slice(0, 8)}: unsold at stop (curve unavailable)`);
    positions.delete(mint);
    return;
  }
  const price = lastKnownPrice(mint) ?? pos.entryPrice;
  const ratio = price / pos.entryPrice;
  const holdSec = Math.round((Date.now() - pos.entryTime) / 1000);
  const costs = roundTripCosts({ buySol: BUY_SOL, ratio });
  log(`  [stop] ${mint.slice(0, 8)} account unavailable - valued at last-known price ${ratio.toFixed(2)}x (unconfirmed)`);
  recordExit(mint, pos, {
    exitPrice: price, ratio, pnlSol: costs.netPnl, holdSec,
    reason: "manual stop", costs, exitVSol: null, exitRSol: null,
    priceSource: lastKnownPriceSource(mint), priceAgeMs: null, unconfirmed: true,
  });
  recordResult(costs.netPnl);
  session.sell(BUY_SOL * ratio, costs.grossPnl, costs);
  totalTrades += 1;
  if (costs.netPnl > 0) wins += 1;
  positions.delete(mint);
  manualStopCloses += 1;
}

async function closeOpenPositions() {
  const mints = [...positions.keys()];
  if (!mints.length) return;
  log(`  closing ${mints.length} open position(s) at stop...`);
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  for (const mint of mints) {
    if (!positions.has(mint)) continue;
    if (Date.now() >= deadline) break;
    try { await closePositionAtStop(mint); }
    catch (err) { log(`  close failed ${mint.slice(0, 8)}: ${err.message}`); }
  }
  // Safety: anything still open past the deadline is valued at the last known price.
  for (const mint of [...positions.keys()]) {
    await closePositionAtStop(mint, { unconfirmed: true }).catch(() => {});
  }
}

// Idempotent: print the SESSION SUMMARY exactly once, write type:"session_summary" to the journal
// and a readable copy to data/journal/summary-<sessionId>.txt.
function writeSessionSummary(reason, { endSol = null, rpc = null, audit = null, openAtStop = null } = {}) {
  if (summaryWritten) return;
  summaryWritten = true;
  // B11: open positions are counted from the snapshot taken at stop time (before closeOpenPositions
  // deleted them), so the summary reflects reality instead of a hard-coded zero.
  const openPositions = openAtStop ? openAtStop.length : positions.size;
  const openSpentSol = openAtStop ? openAtStop.reduce((a, p) => a + p.spentSol, 0) : positions.size * BUY_SOL;
  const summary = session.report({ reason, openPositions, endSol, openSpentSol });
  const payload = {
    sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, reason,
    ...summary, bestSol: session.bestSol, worstSol: session.worstSol,
    manualStopCloses, rpc: rpc ?? null, audit: audit ?? null,
  };
  journal.write({ type: "session_summary", ...payload });
  try {
    fs.mkdirSync(journal.dir, { recursive: true });
    const lines = [
      `sessionId: ${SESSION_ID}`,
      `gitSha: ${GIT_SHA}`,
      `paramsHash: ${PARAMS_HASH}`,
      `reason: ${reason}`,
      `mode: ${summary.mode}`,
      `durationMs: ${summary.durationMs}`,
      `buys: ${summary.buys} / sells: ${summary.sells}`,
      `spentSol: ${summary.spentSol}`,
      `receivedSol: ${summary.receivedSol}`,
      `netSol: ${summary.netSol}`,
      `costsSol: ${summary.costsSol}`,
      `netAfterCostsSol: ${summary.netAfterCostsSol}`,
      `wins: ${summary.wins} / losses: ${summary.losses}`,
      `bestSol: ${session.bestSol}`,
      `worstSol: ${session.worstSol}`,
      `openPositions: ${summary.openPositions}`,
      `closedAtStop: ${manualStopCloses}`,
    ];
    fs.writeFileSync(path.join(journal.dir, `summary-${SESSION_ID}.txt`), lines.join("\n") + "\n");
  } catch (err) {
    log(`  summary file write failed: ${err.message}`);
  }
}

// Final shutdown: stop listening, close open positions (LIVE), print the session report
// (spent / received / net) and exit. Idempotent — a second call is a no-op.
async function finish(reason = stopReason || "stopped") {
  if (exited) return;
  exited = true;
  stopping = true;
  stopReason = reason;
  log(`\n=== STOPPING: ${reason} ===`);
  await ws.close().catch(() => {}); // wait for the socket: exiting mid-close trips a libuv assertion
  clearInterval(pollTimer);
  clearInterval(auditTimer);
  clearInterval(holderTrajTimer);
  if (holderTimer) clearInterval(holderTimer);
  holders.clear(); // cancel every watched mint: no new entries after the stop signal
  // B11: capture the open-at-stop state BEFORE any deletion — the summary must show the real
  // position count/spend, not zeros.
  const openAtStop = [...positions.entries()].map(([mint, pos]) => ({ mint, spentSol: pos.entrySolSol ?? BUY_SOL }));
  await closeOpenPositions(); // close ALL open positions first (exitReason "manual stop")
  // Flush the post-exit window of trades that were still being sampled.
  for (const [mint, rec] of [...postExit]) {
    journal.postExit({
      mint,
      exitRatio: round9(rec.exitRatio),
      bestRatioAfterExit: round9(rec.best),
      windowSec: Math.round((Date.now() - rec.startAt) / 1000),
      solUsd: rec.solUsd ?? null,
      truncated: true,
    });
    postExit.delete(mint);
  }
  // ATA closes still in flight must be in the ledger before the wallet is read (bounded wait).
  const closesLeft = (await ataCloser.drain()).pending;
  if (closesLeft) log(`  ${closesLeft} ATA close(s) still unconfirmed at stop — not in the summary`);
  const endSol = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;
  // RPC health into the summary + a session record so a throttled session can be excluded later.
  const rs = rpcStats.snapshot();
  const share = rs.calls ? `${((rs.retries429 / rs.calls) * 100).toFixed(1)}%` : "0.0%";
  log(`RPC: ${rs.calls} calls, ${rs.retries429} rate-limited (${share}), ${rs.errors} errors, max delay ${rs.maxDelayMs}ms -> ${rs.degraded ? "DEGRADED" : "ok"}`);
  journal.write({ type: "session", sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, degraded: rs.degraded, rpc: rs, reason });

  // stream-vs-account audit summary (item 3)
  {
    const over1p = audit.checked ? ((audit.over1 / audit.checked) * 100).toFixed(1) : "0.0";
    const over5p = audit.checked ? ((audit.over5 / audit.checked) * 100).toFixed(1) : "0.0";
    const mOver1p = audit.mayhemChecked ? ((audit.mayhemOver1 / audit.mayhemChecked) * 100).toFixed(1) : "0.0";
    const mOver5p = audit.mayhemChecked ? ((audit.mayhemOver5 / audit.mayhemChecked) * 100).toFixed(1) : "0.0";
    log(`AUDIT: ${audit.checked} checks over ${audit.rounds} rounds - >1% ${audit.over1} (${over1p}%), >5% ${audit.over5} (${over5p}%) | mayhem ${audit.mayhemChecked} checks: >1% ${audit.mayhemOver1} (${mOver1p}%), >5% ${audit.mayhemOver5} (${mOver5p}%)`);
    journal.write({ type: "audit", sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, ...audit });
  }

  // shadow variants (item 5): paper strategies on the same feed, one virtual wallet each. V4/V5
  // need the 1/s hold tick trajectory, so they are computed post-hoc by scripts/shadow.mjs.
  {
    const { variants, checkedVariants } = evaluateShadow(closedTrades, { floorPrice: START_PRICE_RAW });
    log(`SHADOW variants (paper, same feed; ${checkedVariants} checked — V4/V5 via scripts/shadow.mjs):`);
    const { h, rows } = shadowLines({ variants, checkedVariants });
    const w = h.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
    log("  " + h.map((c, i) => c.padEnd(w[i])).join("  "));
    rows.forEach((r, idx) => {
      log("  " + r.map((c, i) => String(c).padEnd(w[i])).join("  "));
      journal.write({ type: "shadow", sessionId: SESSION_ID, paramsHash: PARAMS_HASH, gitSha: GIT_SHA, ...variants[idx] });
    });
  }

  // SESSION SUMMARY printed BEFORE any tick drain, then drain the tick windows (bounded by
  // SNIPER_DRAIN_MAX_SEC, default 10s) with a countdown.
  writeSessionSummary(reason, { endSol, rpc: rs, audit: { ...audit }, openAtStop });
  const drainSec = Number(process.env.SNIPER_DRAIN_MAX_SEC ?? 10);
  if (drainSec > 0 && ticks.size > 0) {
    log(`[ticks] ${ticks.size} window(s) open - draining up to ${drainSec}s (Ctrl+C again to exit now)`);
    draining = true;
    let left = drainSec;
    const countdown = setInterval(() => { if (left > 0) log(`[ticks] drain ${left}s left`); left -= 1; }, 1000);
    const drained = await ticks.drain({ maxMs: drainSec * 1000 });
    clearInterval(countdown);
    draining = false;
    log(`[ticks] drained ${Math.round(drained.elapsedMs / 1000)}s, ${drained.remaining} window(s) unfinished (${ticks.written} tick lines written)`);
  }
  ticks.close();
  saveCreatorRegistry(creatorRegistry);
  releaseInstanceLock();
  process.exit(0);
}

// Main loop
acquireInstanceLock(); // refuse to start if another instance is already running (duplicate trades)
log("=== SNIPER BOT (V3) ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Config: buy=${BUY_SOL} SOL, TP=${TAKE_PROFIT}x, SL=${STOP_LOSS}x, timeout=${TIMEOUT_SEC}s`);
log(`Max positions: ${MAX_POSITIONS}, cooldown: ${COOLDOWN_SEC}s`);
if (LIVE) log(`MODE: LIVE — real transactions will be sent`);
else log(`MODE: DRY RUN (no real transactions) — pass --live to trade`);
if (MIN_DEV_BUY) log(`Filter: dev buy >= ${MIN_DEV_BUY} SOL`);
if (MIN_HOLDERS) log(`Filter: >= ${MIN_HOLDERS} holders within ${HOLDER_WAIT_SEC}s (no instant buy at create)`);
const startupSolUsd = await getSolUsd();
log(`SOL/USD: ${fmtUsd(startupSolUsd)}${startupSolUsd ? "" : " (unknown — dollar values print n/a)"}`);
log(`Journal: data/journal/${mskDateKey()}.jsonl, post-exit window ${POST_EXIT_SEC}s`);
log(`Session: ${SESSION_ID} | params ${PARAMS_HASH} | git ${GIT_SHA || "n/a"}`);

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  if (stopping) return; // session stopped: ignore late events
  const now = Date.now();
  const slot = result?.context?.slot ?? null; // organic() counts DISTINCT buy slots
  const { value } = result;
  if (!value?.logs) return;
  // Mayhem detection for the journal: the calling program only shows up in the invoke stack.
  // Must come after `value` is read (it was placed above and threw "Cannot access 'value'
  // before initialization" on every notification).
  const viaMayhem = value.logs.some((l) => typeof l === "string" && l.includes(MAYHEM_PROGRAM_ID));

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  let events;
  try {
    events = parseLogEvents(value.logs);
  } catch (err) {
    log(`  parse error (ignored): ${err.message}`);
    return;
  }
  const creates = events.filter((e) => e.type === "create");

  // Instrumentation: per-mint trade counters for the tick log. Counted for every mint, not only for
  // the watched ones, and capped so a long run cannot grow memory without bound.
  for (const ev of events) {
    if (ev.type !== "trade") continue;
    const s = mintStats.get(ev.mint) || { buys: 0, sells: 0, buyers: new Set() };
    if (ev.isBuy) {
      s.buys += 1;
      if (ev.user) s.buyers.add(ev.user);
    } else {
      s.sells += 1;
    }
    mintStats.set(ev.mint, s);
    // stream price: the payload carries the post-trade reserves (equals the account for standard
    // tokens, which is what we verified in task C). This is the ongoing price source.
    if (ev.virtualSolReserves && ev.virtualTokenReserves) {
      curveStream.set(ev.mint, { vSol: BigInt(ev.virtualSolReserves), vTok: BigInt(ev.virtualTokenReserves), ts: now });
    }
  }
  while (mintStats.size > 5000) mintStats.delete(mintStats.keys().next().value);
  while (curveStream.size > 5000) curveStream.delete(curveStream.keys().next().value);

  for (const create of creates) {
    if (seenMints.has(create.mint)) continue;
    markSeen(create.mint);
    // Instrumentation: these two early exits are the biggest source of sample bias (a token that
    // never even gets tracked). Journal them so the analysis can count what was skipped and why.
    if (positions.size + opening.size >= MAX_POSITIONS) {
      if (!skippedLogged.has(create.mint)) {
        skippedLogged.add(create.mint);
        journal.write({ type: "skip", mint: create.mint, reason: "create dropped: no free position slot", holders: 0, mayhemRouter: false, mayhemMode: null, sessionId: SESSION_ID, paramsHash: PARAMS_HASH });
      }
      continue;
    }
    if (Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) {
      if (!skippedLogged.has(create.mint)) {
        skippedLogged.add(create.mint);
        journal.write({ type: "skip", mint: create.mint, reason: "create dropped: cooldown", holders: 0, mayhemRouter: false, mayhemMode: null, sessionId: SESSION_ID, paramsHash: PARAMS_HASH });
      }
      continue;
    }
    if (positions.has(create.mint)) continue;

    // Journal context: dev buy and (later) holder count at entry.
    const devTrade = events.find(
      (e) => e.type === "trade" && e.isBuy && e.mint === create.mint && e.user === create.creator,
    );
    const devBuySol = devTrade?.solAmount ?? null;
    if (MIN_DEV_BUY && (!devTrade || devTrade.solAmount < MIN_DEV_BUY)) {
      log(`skip: dev buy ${devBuySol?.toFixed(3) || 0} < ${MIN_DEV_BUY}`);
      continue;
    }
    entryMeta.set(create.mint, { devBuySol, holdersAtEntry: null });
    noteLaunch(create.mint, create.creator, now); // creator registry (journal context only)

    // Holder gate: never buy the create event blindly, wait for real holders instead.
    if (holders.enabled) {
      holders.track(create.mint, { at: now, slot, creator: create.creator });
      holderTicks.noteCreate(create.mint, now);
      log(`\nWATCHING: ${create.mint}`);
      log(`  creator: ${create.creator} | waiting for ${MIN_HOLDERS} holders (max ${HOLDER_WAIT_SEC}s)`);
      continue;
    }

    log(`\nSNIPING: ${create.mint}`);
    log(`  creator: ${create.creator}`);

    await buyNow(create.mint);
  }

  // Holder gate: every trade on a watched mint updates that wallet's net token balance.
  if (!holders.enabled) return;
  for (const ev of events) {
    if (ev.type !== "trade" || !holders.watching(ev.mint)) continue;
    const res = holders.apply(ev.mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: now, slot });
    if (viaMayhem) mayhemMints.add(ev.mint);
    if (!res) continue;
    const newly = holderTicks.noteHolders(ev.mint, res.holders, now);
    if (newly.length) void recordHolderMilestones(ev.mint, newly);
    if (!holders.organic(res)) {
      if (res.ready && !blockedLogged.has(ev.mint)) {
        blockedLogged.add(ev.mint);
        log(`  skip ${ev.mint.slice(0, 8)}: ${res.holders} holders but not organic (slots ${res.slots}<${MIN_SLOTS}, age ${Math.round(res.msSinceCreate)}ms<${MIN_DELAY_MS}ms)`);
      }
      continue;
    }

    if (positions.has(ev.mint) || opening.has(ev.mint)) {
      holders.drop(ev.mint); // already bought this mint
      continue;
    }
    // Slot or cooldown busy: keep watching - the next trade retries, prune() drops it later.
    // The reason is recorded so the drop log never claims "holders < 4" for a mint that
    // actually had enough holders (that was a real bug).
    if (positions.size + opening.size >= MAX_POSITIONS) {
      holders.markBlocked(ev.mint, "no free position slot");
      if (!skippedLogged.has(ev.mint)) {
        skippedLogged.add(ev.mint);
        journal.write({ type: "skip", mint: ev.mint, reason: "no free position slot", holders: res.holders, mayhemRouter: mayhemMints.has(ev.mint), mayhemMode: null, sessionId: SESSION_ID, paramsHash: PARAMS_HASH });
      }
      continue;
    }
    if (Date.now() - lastBuyTime < COOLDOWN_SEC * 1000) {
      holders.markBlocked(ev.mint, "cooldown");
      if (!skippedLogged.has(ev.mint)) {
        skippedLogged.add(ev.mint);
        journal.write({ type: "skip", mint: ev.mint, reason: "cooldown", holders: res.holders, mayhemRouter: mayhemMints.has(ev.mint), mayhemMode: null, sessionId: SESSION_ID, paramsHash: PARAMS_HASH });
      }
      continue;
    }

    holders.drop(ev.mint);

    entryMeta.set(ev.mint, { ...(entryMeta.get(ev.mint) || {}), holdersAtEntry: res.holders });
    log(`\nSNIPING: ${ev.mint}`);
    log(`  ${res.holders} holders reached (>= ${MIN_HOLDERS})`);
    await buyNow(ev.mint);
  }
});

// ---- stream-vs-account audit (item 3) --------------------------------------
// Every AUDIT_INTERVAL_MS, compare the stream price with a fresh account read for each held
// position and count how often they disagree by >1% / >5%, split by mayhemMode.
const AUDIT_INTERVAL_MS = 10000;
const audit = { rounds: 0, checked: 0, over1: 0, over5: 0, mayhemChecked: 0, mayhemOver1: 0, mayhemOver5: 0 };
async function runAudit() {
  if (stopping) return;
  audit.rounds += 1;
  let checked = 0, over1 = 0, over5 = 0, mChecked = 0, mOver1 = 0, mOver5 = 0;
  for (const [mint, pos] of positions) {
    const s = curveStream.get(mint);
    if (!s || !s.vTok) continue;
    const streamP = Number(s.vSol) / Number(s.vTok);
    let state = null;
    try { state = await getBondingCurveState(new PublicKey(mint), 0, 2); } catch { state = null; }
    if (!state) continue;
    const accountP = getPrice(state);
    if (!(accountP > 0)) continue;
    const mayhem = pos.mayhemMode === true;
    const disc = Math.abs(streamP - accountP) / accountP;
    checked += 1; audit.checked += 1;
    if (mayhem) { mChecked += 1; audit.mayhemChecked += 1; }
    if (disc > 0.01) { over1 += 1; audit.over1 += 1; if (mayhem) { mOver1 += 1; audit.mayhemOver1 += 1; } }
    if (disc > 0.05) { over5 += 1; audit.over5 += 1; if (mayhem) { mOver5 += 1; audit.mayhemOver5 += 1; } }
  }
  if (checked > 0) {
    log(`[audit] stream-vs-account: >1% ${over1}/${checked} (${((over1 / checked) * 100).toFixed(1)}%), >5% ${over5}/${checked} (${((over5 / checked) * 100).toFixed(1)}%) | mayhem: >1% ${mOver1}/${mChecked}, >5% ${mOver5}/${mChecked}`);
  }
}

// Price monitor interval
const pollTimer = setInterval(checkPositions, POLL_MS);
const auditTimer = setInterval(() => void runAudit(), AUDIT_INTERVAL_MS);
// Holder price trajectory (step 3): 1/s stream-price samples for 150s after a token reaches 4
// holders. Zero RPC — the stream price is already captured.
const holderTrajTimer = setInterval(() => {
  if (stopping) return;
  for (const mint of holderTicks.activeTrajectoryMints()) {
    const price = streamPrice(mint);
    if (price) holderTicks.sampleTrajectory(mint, price, { source: "stream" });
  }
}, 1000);

// Opt-in auto-stop for bounded runs and the smoke test: SNIPER_MAX_SEC=12 stops the session after
// 12 s and prints the normal session summary. Unset (the default) = run until Ctrl+C.
const MAX_SEC = numOr(process.env.SNIPER_MAX_SEC, 0, "SNIPER_MAX_SEC");
if (MAX_SEC > 0) setTimeout(() => void finish(`max runtime reached (${MAX_SEC}s)`), MAX_SEC * 1000);

// Expire watched mints that never gathered enough holders (scam / dud tokens).
const holderTimer = holders.enabled
  ? setInterval(() => {
      for (const d of holders.prune()) {
        const why = d.ready
          ? `ready at ${d.holdersAtReady} holders but never entered (${d.blocked || "slot/cooldown"})`
          : `${d.holders} holders < ${MIN_HOLDERS}`;
        log(`  dropped ${d.mint.slice(0, 8)}: ${why} after ${Math.round(d.waitedMs / 1000)}s watch`);
        // Journal the non-entry too: without it the sample is silently biased towards tokens that
        // happened to get a free slot.
        journal.write({
          type: "skip",
          mint: d.mint,
          reason: d.ready ? `ready but not entered (${d.blocked || "slot/cooldown"})` : `${d.holders} holders < ${MIN_HOLDERS}`,
          holders: d.holders,
          waitedSec: Math.round(d.waitedMs / 1000), mayhemRouter: mayhemMints.has(d.mint), mayhemMode: null,
          sessionId: SESSION_ID,
          paramsHash: PARAMS_HASH,
        });
      }
    }, 5000)
  : null;

log("\nListening for new tokens...\n");

process.on("SIGINT", () => {
  // Second Ctrl+C: if the summary has not been printed yet, print it, then exit immediately.
  if (exited) {
    if (!summaryWritten) writeSessionSummary("manual stop (Ctrl+C)", {});
    log(`[stop] second Ctrl+C - exiting now (${ticks.size} tick window(s) not finished)`);
    releaseInstanceLock();
    process.exit(0);
  }
  void finish("manual stop (Ctrl+C)");
});
process.on("SIGTERM", () => {
  if (!exited) void finish("SIGTERM");
});
