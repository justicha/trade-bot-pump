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
import { connection, getSOLBalance, sendTxWithRetry } from "../../lib/rpc.mjs";
import { simulateThenSend } from "../../lib/send.mjs";
import { readExecution } from "../../lib/exec.mjs";
import { roundTripCosts } from "../../lib/fees.mjs";
import { SessionLedger } from "../../lib/session.mjs";
import { TradeJournal } from "../../lib/journal.mjs";
import { recordStuck } from "../../lib/stuck.mjs";
import { applyLiveSell, balanceBeforeSell, liveEntry } from "../../lib/live-pnl.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../../lib/tx.mjs";
import { loadKeypair } from "../../lib/wallet.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

// Numeric config via numOr: an invalid value (e.g. COPY_MAX_POSITIONS=abc) must fail loudly with
// the variable name, never silently become NaN. A NaN MAX_POSITIONS used to make the position-cap
// check `positions.size + opening.size >= NaN` always false — i.e. the cap was silently disabled.
const BUY_SOL = numOr(process.env.COPY_BUY_SOL, 0.05, "COPY_BUY_SOL");
const SELL_PCT = numOr(process.env.COPY_SELL_PCT, 100, "COPY_SELL_PCT");
const MAX_POSITIONS = numOr(process.env.COPY_MAX_POSITIONS, 5, "COPY_MAX_POSITIONS");
const TARGETS = (process.env.COPY_TARGETS || "").split(",").filter(Boolean);

let totalPnl = 0;
let totalTrades = 0;

// Session ledger: spent / received / net for the end-of-session report (lib/session.mjs).
const session = new SessionLedger({ label: "COPY TRADER", mode: LIVE ? "LIVE" : "DRY RUN" });
// Journal: only STUCK rows for now (same writer and directory as the sniper).
const journal = new TradeJournal({ bot: "copy-trader" });

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

// opts.guardPnlSol: a live sale's PnL before network fees — what MAX_CONSEC_LOSSES classifies by
// (lib/guards.mjs). Without it (dry run, STUCK) the guard sees pnlSol, as before.
function recordResult(pnlSol, opts) {
  guard.recordResult(pnlSol, opts);
  if (guard.halted) requestStop(guard.haltReason || "loss limit reached");
}

function requestStop(reason) {
  if (stopping) return;
  stopping = true;
  stopReason = reason;
  setImmediate(() => { void finish(reason); });
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
    positions.set(mint, { entryPrice, entrySolSol: BUY_SOL, entryTime: Date.now(), copiedFrom });
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
    const sig = await simulateThenSend(tx);
    // C5: entry from ACTUAL execution (tokens that arrived / SOL that left), falling back to the
    // quote if the transaction meta is not available yet.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);
    const entry = liveEntry(ex, BUY_SOL); // ATA rent is tracked apart, not inside the entry
    const spent = entry.entrySolSol;
    const actualEntry = ex.found && ex.tokensReceived > 0n ? spent / (Number(ex.tokensReceived) / 1e6) : entryPrice;
    positions.set(mint, { entryPrice: actualEntry, ...entry, entryTime: Date.now(), copiedFrom });
    session.buy(spent);
    session.ataRent(entry.ataRentSol);
    log(`  copied${ex.found ? "" : " (quote-fallback)"}`);
  } catch (err) {
    // C2: the buy may have landed even though confirmTransaction failed. If the chain shows the
    // tokens arrived, record the position instead of releasing the reserve (the money was spent).
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensReceived > 0n) {
        const entry = liveEntry(ex, BUY_SOL);
        const spent = entry.entrySolSol;
        positions.set(mint, { entryPrice: entryPrice, ...entry, entryTime: Date.now(), copiedFrom });
        session.buy(spent);
        session.ataRent(entry.ataRentSol);
        log(`  copied (reconciled after confirm error, ${ex.tokensReceived} tokens)`);
        return;
      }
    }
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

  // Token balance BEFORE this sale; the catch (a sale that landed despite a confirm error) measures
  // the sold share against it.
  let total = null;
  try {
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
    const info = await connection.getTokenAccountBalance(ata);
    total = BigInt(info.value.amount);
    if (total === 0n) {
      session.drop(`${mint.slice(0, 8)}: no tokens in wallet`);
      positions.delete(mint);
      return;
    }

    const sellAmount = SELL_PCT >= 100 ? total : (total * BigInt(SELL_PCT)) / 100n;
    const state = await getBondingCurveState(mintPk, 0);
    if (!state || state.complete) {
      // No AMM sell in this bot: the tokens stay in the wallet. Journal it as STUCK and book the
      // remaining entry as an assumed loss so MAX_CONSEC_LOSSES sees it (lib/stuck.mjs).
      const why = state ? "curve complete: no AMM sell in this bot" : "curve unavailable: no AMM sell in this bot";
      const lossSol = recordStuck({
        journal, recordResult, mint, pos: { ...pos, tokens: total }, buySol: BUY_SOL, reason: why,
        fields: { mode: "LIVE", copiedFrom },
      });
      log(`  STUCK ${mint.slice(0, 8)}: ${why} — booked as an assumed loss of ${lossSol.toFixed(6)} SOL, use scripts/rescue-sell.mjs`);
      session.drop(`${mint.slice(0, 8)}: STUCK ${why}`);
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
    const sig = await simulateThenSend(tx);
    // C5: received SOL from the chain (fee excluded), falling back to the quote if meta lags.
    const ex = await readExecution(sig, wallet.publicKey, mintPk);

    const sellPrice = getPrice(state);
    const pnlPct = ((sellPrice / pos.entryPrice) - 1) * 100;
    // The same calculation as the sniper and graduation-sniper (lib/live-pnl.mjs applyLiveSell):
    // PnL against the SOLD share of the entry (H4), net of both real network fees; the ledger
    // gets the gross figures + the real fees as costs (no estimated tx fee / assumed slippage).
    const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, quoteSol: Number(expectedSol) / 1e9, soldRaw: sellAmount, totalRaw: total });
    const pnlSol = sale.acc.pnlSol;
    recordResult(pnlSol, { guardPnlSol: sale.guardPnlSol });
    session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
    totalPnl += pnlSol;
    totalTrades++;
    log(`  sold: ${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL)`);
    log(`  session: ${totalTrades} trades, PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL`);
    // SELL_PCT < 100 leaves a remainder: its entry share and its share of the buy fee stay open.
    if (sale.closed) positions.delete(mint);
    else Object.assign(pos, sale.remainder);
  } catch (err) {
    // C2: the sell may have landed even though confirmTransaction failed. If the chain shows the
    // tokens left the wallet, record the sale instead of leaving the position open to be re-sold.
    if (err.sig) {
      const ex = await readExecution(err.sig, wallet.publicKey, mintPk).catch(() => null);
      if (ex && ex.found && ex.tokensSold > 0n) {
        // Same calculation as the normal path, against the balance read BEFORE the sale. It used
        // to book the FULL entry even for a SELL_PCT<100 partial sale, leave entrySolSol untouched
        // for the remainder, and substitute BUY_SOL (break-even) when nothing arrived.
        const soldRaw = ex.tokensSold;
        const totalRaw = balanceBeforeSell({ balanceRaw: total, posTokens: pos.tokens, soldRaw });
        const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex, soldRaw, totalRaw });
        const pnlSol = sale.acc.pnlSol;
        recordResult(pnlSol, { guardPnlSol: sale.guardPnlSol });
        session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
        totalPnl += pnlSol;
        totalTrades++;
        log(`  sold (reconciled after confirm error): ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL`);
        if (sale.closed) positions.delete(mint);
        else Object.assign(pos, sale.remainder);
        return;
      }
    }
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
  // H9: openSpentSol = sum of REMAINING entry shares (partial sells reduce pos.entrySolSol), so
  // the session NET (received - closedSpent) does not mix partial-sell proceeds with open spend.
  session.report({ reason, openPositions: positions.size, endSol, openSpentSol: [...positions.values()].reduce((a, p) => a + (p.entrySolSol ?? BUY_SOL), 0) });
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

    const events = parseLogEvents(value.logs);
    for (const ev of events) {
      if (ev.type !== "trade") continue;
      // H1: only the subscribed target's OWN trades. A tx that merely mentions the target (e.g. as a
      // fee recipient) carries trades of other wallets — copying those was the bug.
      if (ev.user !== target) continue;
      if (ev.isBuy) {
        await copyBuy(ev.mint, target);
      } else {
        await copySell(ev.mint, target);
      }
    }
  });
  log(`Subscribed to ${target.slice(0, 12)}...`);
}

log("\nListening for target wallet trades...\n");

process.on("SIGINT", () => {
  void finish("manual stop (Ctrl+C)");
});
process.on("SIGTERM", () => {
  // Process managers send SIGTERM: run the same graceful shutdown.
  if (!exited) void finish("SIGTERM");
});
