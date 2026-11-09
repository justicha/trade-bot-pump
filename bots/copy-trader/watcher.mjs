#!/usr/bin/env node
// Копи-трейдер: следит за кошельками успешных трейдеров и повторяет их сделки (V3 API)
//
// Использование: node bots/copy-trader/watcher.mjs [--live]   (по умолчанию dry-run; --live включает реальную торговлю)
//
// Конфиг через ENV или .env:
//   COPY_TARGETS=addr1,addr2,...  — кошельки для копирования
//   COPY_BUY_SOL=0.05            — сумма покупки (фиксированная)
//   COPY_SELL_PCT=100             — процент продажи при продаже целью
//   COPY_MAX_POSITIONS=5          — максимум одновременных позиций

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SLIPPAGE_BPS, DRY_RUN, LIVE } from "../../lib/config.mjs";
import { TradeGuard } from "../../lib/guards.mjs";
import { log as logger } from "../../lib/logger.mjs";
import {
  PUMP_PROGRAM,
  TOKEN_2022_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
} from "../../lib/constants.mjs";
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
import { connection, getSOLBalance, sendTxWithRetry } from "../../lib/rpc.mjs";
import { simulateThenSend } from "../../lib/send.mjs";
import { roundTripCosts } from "../../lib/fees.mjs";
import { SessionLedger } from "../../lib/session.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

const BUY_SOL = Number(process.env.COPY_BUY_SOL || 0.05);
const SELL_PCT = Number(process.env.COPY_SELL_PCT || 100);
const MAX_POSITIONS = Number(process.env.COPY_MAX_POSITIONS || 5);
const TARGETS = (process.env.COPY_TARGETS || "").split(",").filter(Boolean);

let totalPnl = 0;
let totalTrades = 0;

// Session ledger: spent / received / net for the end-of-session report (lib/session.mjs).
const session = new SessionLedger({ label: "COPY TRADER", mode: LIVE ? "LIVE" : "DRY RUN" });

if (!TARGETS.length) {
  console.log("Set COPY_TARGETS=addr1,addr2,... in .env");
  process.exit(1);
}

const wallet = loadKeypair();
// Live fee/buyback recipients from pump's `global` account (pump.fun rotates them; buy needs them).
await refreshGlobalFeeState().catch((e) => console.warn(`[fee-state] ${e.message}`));
const targetSet = new Set(TARGETS);
const positions = new Map(); // mint → { entryPrice, entryTime, copiedFrom }
const recentTxs = new Set(); // dedup

function log(msg) {
  logger.info(msg);
}

const guard = new TradeGuard();

// --- Stop machinery ---------------------------------------------------------
// A breached limit must END the session, not leave a bot that keeps scanning and logging
// "skip: trading halted" forever. limit -> close positions -> session report.
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

function parseV3TradeEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  return { mint, solAmount, tokenAmount, user };
}

function parseTradeEvents(logs) {
  let isBuy = false, isSell = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    if (SELL_INSTRUCTIONS.has(m[1])) isSell = true;
  }

  const events = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const parsed = parseV3TradeEvent(raw);
      if (!parsed) continue;
      events.push({ ...parsed, isBuy: isBuy && !isSell });
    } catch { /* malformed Program data payload: skip this line, keep parsing the rest */ }
  }
  return events;
}

// Mints with a buy in flight. Counted in the position-cap check so concurrent WS callbacks
// (several targets, several trades per notification) can't overshoot MAX_POSITIONS or buy the
// same mint twice (check → await → set race). Same fix as bots/sniper/sniper.mjs.
const opening = new Set();

async function copyBuy(mint, copiedFrom) {
  if (opening.has(mint)) return;
  if (positions.has(mint)) return;
  if (positions.size + opening.size >= MAX_POSITIONS) return;
  opening.add(mint);
  try {
    await copyBuyUnlocked(mint, copiedFrom);
  } finally {
    opening.delete(mint);
  }
}

async function copyBuyUnlocked(mint, copiedFrom) {
  if (positions.size >= MAX_POSITIONS) return;
  if (positions.has(mint)) return;

  const mintPk = new PublicKey(mint);
  const state = await getBondingCurveState(mintPk, 0);
  if (!state || state.complete) return;

  const entryPrice = getPrice(state);
  const expectedTokens = calcBuyTokens(state, BUY_SOL);
  const minTokens = (expectedTokens * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

  log(`COPY BUY from ${copiedFrom.slice(0, 8)}...`);
  log(`  mint: ${mint.slice(0, 12)}... | ${BUY_SOL} SOL -> ~${(Number(expectedTokens) / 1e6).toFixed(0)} tokens`);

  const gate = guard.checkOpen(BUY_SOL);
  if (!gate.ok) {
    log(`  skip: ${gate.reason}`);
    if (gate.terminal) requestStop(gate.reason); // session over -> finish with the summary
    return;
  }
  guard.reserve(BUY_SOL); // synchronous reservation closes the concurrent-event race

  if (DRY_RUN) {
    positions.set(mint, { entryPrice, entryTime: Date.now(), copiedFrom });
    session.buy(BUY_SOL);
    log(`  [DRY RUN] tracked`);
    return;
  }

  try {
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
    const tx = await buildVersionedTx(wallet, ixs);
    await simulateThenSend(tx);
    positions.set(mint, { entryPrice, entryTime: Date.now(), copiedFrom });
    session.buy(BUY_SOL);
    log(`  copied`);
  } catch (err) {
    guard.release(BUY_SOL);
    log(`  copy buy failed: ${err.message}`);
  }
}

async function copySell(mint, copiedFrom) {
  const pos = positions.get(mint);
  if (!pos) return;

  const mintPk = new PublicKey(mint);
  log(`COPY SELL from ${copiedFrom.slice(0, 8)}...`);

  if (DRY_RUN) {
    const state = await getBondingCurveState(mintPk, 0);
    if (state) {
      const sellPrice = getPrice(state);
      const ratio = sellPrice / pos.entryPrice;
      const costs = roundTripCosts({ buySol: BUY_SOL, ratio });
      const pnlPct = ((sellPrice / pos.entryPrice) - 1) * 100;
      const pnlSol = BUY_SOL * (pnlPct / 100);
      recordResult(pnlSol);
      session.sell(BUY_SOL + pnlSol, pnlSol, costs);
      totalTrades++;
      log(`  [DRY RUN] would sell: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
    }
    positions.delete(mint);
    return;
  }

  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    const total = BigInt(info.value.amount);
    if (total === 0n) {
      session.drop(`${mint.slice(0, 8)}: no tokens in wallet`);
      positions.delete(mint);
      return;
    }

    const sellAmount = SELL_PCT >= 100 ? total : (total * BigInt(SELL_PCT)) / 100n;
    const state = await getBondingCurveState(mintPk, 0);
    if (!state || state.complete) {
      log(`  bonding curve unavailable`);
      session.drop(`${mint.slice(0, 8)}: bonding curve gone`);
      positions.delete(mint);
      return;
    }

    const expectedSol = calcSellSol(state, sellAmount);
    const minSol = (expectedSol * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

    const ixs = [
      ...computeBudgetIxs(),
      sellIx(wallet.publicKey, mintPk, sellAmount, minSol, {
        creator: state.creator ? new PublicKey(state.creator) : undefined,
        isMayhem: !!state.isMayhemMode,
      }),
    ];
    const tx = await buildVersionedTx(wallet, ixs);
    await simulateThenSend(tx);

    const sellPrice = getPrice(state);
    const ratio = sellPrice / pos.entryPrice;
    const pnlPct = ((sellPrice / pos.entryPrice) - 1) * 100;
    const pnlSol = Number(expectedSol) / 1e9 - BUY_SOL;
    const costs = roundTripCosts({ buySol: BUY_SOL, ratio, pumpFeeBps: 0 });
    recordResult(pnlSol);
    session.sell(Number(expectedSol) / 1e9, pnlSol, costs);
    totalPnl += pnlSol;
    totalTrades++;
    log(`  sold: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${totalTrades} trades, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    if (SELL_PCT >= 100) positions.delete(mint);
  } catch (err) {
    log(`  copy sell failed: ${err.message}`);
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
  if (LIVE && positions.size > 0) {
    log(`  closing ${positions.size} open position(s) before exit...`);
    for (const [mint, pos] of [...positions]) {
      try { await copySell(mint, pos.copiedFrom); }
      catch (err) { log(`  close failed ${mint.slice(0, 8)}: ${err.message}`); }
    }
  }
  for (const [mint] of [...positions]) session.drop(`${mint.slice(0, 8)}: still open at stop`);
  const endSol = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;
  session.report({ reason, openPositions: positions.size, endSol, openSpentSol: positions.size * BUY_SOL });
  process.exit(0);
}

// Main
log("=== COPY TRADER (V3) ===");
log(`Wallet: ${wallet.publicKey.toBase58()}`);
log(`Targets: ${TARGETS.map((t) => t.slice(0, 12) + "...").join(", ")}`);
log(`Config: buy=${BUY_SOL} SOL, sell=${SELL_PCT}%, max=${MAX_POSITIONS} positions`);
if (LIVE) log(`MODE: LIVE — real transactions will be sent`);
else log(`MODE: DRY RUN (no real transactions) — pass --live to trade`);

const ws = new SolanaWs();
await ws.connect();

for (const target of TARGETS) {
  ws.subscribeLogs(target, async (result) => {
    if (stopping) return; // session stopped: ignore late events
    const { value } = result;
    if (!value?.logs) return;

    const lastLog = value.logs[value.logs.length - 1] || "";
    if (!lastLog.includes("success")) return;

    const hasPump = value.logs.some((l) => l.includes(PUMP_PROGRAM.toBase58()));
    if (!hasPump) return;

    const sig = value.signature;
    if (recentTxs.has(sig)) return;
    recentTxs.add(sig);
    if (recentTxs.size > 10000) {
      const iter = recentTxs.values();
      for (let i = 0; i < 5000; i++) recentTxs.delete(iter.next().value);
    }

    const trades = parseTradeEvents(value.logs);
    for (const trade of trades) {
      if (trade.isBuy) {
        await copyBuy(trade.mint, target);
      } else {
        await copySell(trade.mint, target);
      }
    }
  });
  log(`Subscribed to ${target.slice(0, 12)}...`);
}

log("\nListening for target wallet trades...\n");

process.on("SIGINT", () => {
  void finish("manual stop (Ctrl+C)");
});
