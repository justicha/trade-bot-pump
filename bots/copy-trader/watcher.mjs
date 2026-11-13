#!/usr/bin/env node
// Copy trader: watches successful traders' wallets and repeats their trades (V3 API)
//
// Usage: node bots/copy-trader/watcher.mjs [--live]   (dry-run by default; --live enables real trading)
//
// Config via ENV or .env:
//   COPY_TARGETS=addr1,addr2,...  — wallets to copy
//   COPY_BUY_SOL=0.05            — buy amount (fixed)
//   COPY_SELL_PCT=100             — percent sold when the target sells
//   COPY_MAX_POSITIONS=5          — max concurrent positions
//   COPY_MAX_HOLD_SEC=1800        — safety net: if the target has not sold within N seconds of our buy,
//                                   the bot sells the whole remainder itself; 0 = off. Not a strategy (no TP/SL).
//   SELL_MAX_ATTEMPTS=3           — max sell attempts per position (backoff 2 s, 4 s, ...), then STUCK

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
import { createSellRetry, DEFAULT_SELL_MAX_ATTEMPTS } from "../../lib/sell-retry.mjs";
import { resolveTokensGone } from "../../lib/late-sale.mjs";
import { createStallGuard } from "../../lib/stall-guard.mjs";
import { applyLiveSell, balanceBeforeSell, liveEntry } from "../../lib/live-pnl.mjs";
import { createAtaCloser } from "../../lib/close-ata.mjs";
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
// P5 (human decision 2026-11-12): safety net against a position that never exits. If the target has
// not sold within COPY_MAX_HOLD_SEC of OUR buy, the bot sells on its own. 0 = off. This is not a
// strategy exit — there is still no TP/SL here; the target's sale stays the main exit.
const MAX_HOLD_SEC = numOr(process.env.COPY_MAX_HOLD_SEC, 1800, "COPY_MAX_HOLD_SEC");
// M6: a failed LIVE sell is retried at most SELL_MAX_ATTEMPTS times (backoff 2 s, 4 s, …), then the
// position is STUCK (lib/sell-retry.mjs). The same env var and default as graduation-sniper.
const SELL_MAX_ATTEMPTS = numOr(process.env.SELL_MAX_ATTEMPTS, DEFAULT_SELL_MAX_ATTEMPTS, "SELL_MAX_ATTEMPTS");
const EXIT_POLL_MS = 2000; // exit timer: sell retries + max-hold check (same cadence as the sniper poll)

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

// After a FULL live sale the empty token ATA is closed to get its rent back (lib/close-ata.mjs):
// a separate transaction, in the background, best effort — it can never fail or delay a sale, and
// it does not change any trade's pnlSol. A SELL_PCT < 100 sale leaves tokens: nothing is closed.
// DRY RUN: does nothing.
const ataCloser = createAtaCloser({ connection, wallet, live: LIVE, session, journal, log, warn: (m) => logger.warn(m) });

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

// M6: bounded retries of a failed LIVE sell — counts the attempt, journals `sell_failed`, backs
// off, and after SELL_MAX_ATTEMPTS books the position as STUCK (assumed loss for the limits) and
// removes it from the book. A DRY RUN never fails a sell, so it never gets here.
const sellRetry = createSellRetry({
  maxAttempts: SELL_MAX_ATTEMPTS,
  positions,
  journal,
  recordResult,
  session,
  log,
  buySol: BUY_SOL,
  fields: { mode: "LIVE" },
});
// Stall guard (lib/stall-guard.mjs): a paused console window freezes the whole process. When it is
// back, the stall is journaled and the exit timer runs at once (a max-hold deadline or a sell retry
// that came due during the pause; the sale is quoted from the curve account). A target BUY that is
// older than STALL_GUARD_SEC is backlog and is not copied; a target SELL still closes our position
// — through copySell, which reads the wallet and the curve from the chain.
const stallGuard = createStallGuard({
  journal,
  log,
  positions,
  onStall: () => {
    void checkExits();
  },
});
let exitTimer = null; // set in Main, cleared in finish()

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

// ---- exit: sell + bounded retries + max-hold (M6, P5) --------------------------------------------
// One sale per mint at a time. A sale can now start from three places — the target's own sale (WS),
// the exit timer (retry / max-hold) and finish() — and two of them running together would read the
// same balance and sell it twice (the loser's failure would then be counted against a position
// that was already sold). Calls for the same mint are queued; the later one finds the position
// gone, or sells what is left.
const selling = new Map(); // mint -> tail of that mint's sale queue

function copySell(mint, copiedFrom, opts = {}) {
  const prev = selling.get(mint) || Promise.resolve();
  // The queue entry is removed as soon as the last queued sale of the mint settles.
  const run = prev
    .then(() => copySellOnce(mint, copiedFrom, opts))
    .finally(() => {
      if (selling.get(mint) === tail) selling.delete(mint);
    });
  const tail = run.catch(() => {}); // the queue itself never rejects
  selling.set(mint, tail);
  return run;
}

// opts.reason — why we sell when it is not the target's own sale ("max-hold timeout", "stop");
// opts.retry  — the exit timer repeating a failed sale;
// opts.final  — the stop path: one last attempt, the retry backoff is not waited out.
async function copySellOnce(mint, copiedFrom, { reason = null, retry = false, final = false } = {}) {
  const pos = positions.get(mint);
  if (!pos) return;
  // M6: a failed sale is backing off. The exit timer retries it at nextSellAt; another sale by the
  // target in between must not burn the attempt budget without the pause.
  if (!final && !sellRetry.due(pos)) {
    log(`  sell of ${mint.slice(0, 8)} is backing off after a failed attempt — the exit timer retries it`);
    return;
  }

  const mintPk = new PublicKey(mint);
  const why = retry ? `retry ${(pos.attempts || 0) + 1}/${SELL_MAX_ATTEMPTS}: ${reason || "target sold"}` : reason;
  log(`COPY SELL from ${copiedFrom.slice(0, 8)}...${why ? ` (${why})` : ""}`);

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
      // An earlier attempt that "failed" may have landed after all. Look for it among the failed
      // attempts' signatures (read-only) and book it as the sale it is; if none landed, the
      // position is closed as STUCK with an assumed loss — never dropped without a row.
      log("  no tokens in wallet");
      const gone = await resolveTokensGone({
        connection,
        owner: wallet.publicKey,
        mint,
        mintPk,
        pos,
        positions,
        buySol: BUY_SOL,
        readExecution,
        applyLiveSell,
        recordResult,
        session,
        journal,
        ataCloser,
        final: stopping || final,
        now: Date.now(),
        log,
        stuckFields: { mode: "LIVE", copiedFrom, venue: "curve" },
        onSale: (sale, { sig, soldRaw, totalRaw }) => {
          const pnlSol = sale.acc.pnlSol;
          totalPnl += pnlSol;
          totalTrades++;
          // This bot journals no row for an ordinary sale; a sale that is known only from the
          // chain gets one, so it can be traced to the attempt that carried it.
          journal.write({
            type: "sell_reconciled",
            mode: "LIVE",
            mint,
            copiedFrom,
            venue: "curve",
            reconciledFromSig: sig,
            pnlSol,
            ...sale.fields,
            amountRaw: soldRaw.toString(),
            balanceRaw: totalRaw.toString(),
            priceSource: "chain-meta",
          });
          log(`  sold (an earlier attempt landed late, ${sig.slice(0, 8)}…): ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL`);
        },
      });
      // The chain could not be asked: keep the position on its way out so the exit timer asks again.
      if (gone.status === "retry") {
        pos.pendingExit = true;
        pos.exitReason = pos.exitReason || reason || "target sold";
      }
      return;
    }

    // P5: a max-hold exit sells everything — a COPY_SELL_PCT share would leave a remainder that the
    // safety net exists to prevent.
    const sellAll = pos.exitFull === true || SELL_PCT >= 100;
    const sellAmount = sellAll ? total : (total * BigInt(SELL_PCT)) / 100n;
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
    // Full sale, confirmed and booked: now (and only now) try to close the empty ATA.
    if (sale.closed) ataCloser.schedule(mint, { venue: "curve" });
    // A partial sale went through: the remainder is no longer on its way out, fresh retry budget.
    if (!sale.closed) releaseExit(pos);
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
        if (sale.closed) ataCloser.schedule(mint, { venue: "curve" });
        if (!sale.closed) releaseExit(pos);
        return;
      }
    }
    log(`  copy sell failed: ${err.message}`);
    // M6: not a landed sale (that returned above). Count the attempt and back off; the position is
    // now "on its way out" (pendingExit) and the exit timer repeats the sale without waiting for
    // the target to sell again. When the budget (SELL_MAX_ATTEMPTS) is gone it becomes STUCK.
    const stopSale = reason === "stop";
    const exitReason = (stopSale ? null : reason) || pos.exitReason || "target sold";
    const res = sellRetry.fail(mint, pos, err, { reason: stopSale ? "stop" : exitReason, tokens: total, extra: { copiedFrom } });
    if (!res.stale && !res.stuck) {
      pos.pendingExit = true;
      pos.exitReason = exitReason;
    }
  }
}

// A partial sale closed part of the position: what is left is a normal open position again.
function releaseExit(pos) {
  sellRetry.reset(pos); // attempts 0, no backoff, pendingExit false
  pos.exitFull = false;
  pos.exitReason = null;
}

// Exit timer (every EXIT_POLL_MS), DRY RUN and LIVE:
//   P5 — a position held for COPY_MAX_HOLD_SEC without a sale by the target is sold by the bot
//        itself (the usual copySell; the whole balance);
//   M6 — a position whose sale failed (pendingExit) is sold again once its backoff is over.
// One cycle at a time; a mint with a sale in flight is skipped.
let exitChecking = false;
async function checkExits() {
  if (stopping || exitChecking) return;
  exitChecking = true;
  try {
    for (const [mint, pos] of [...positions]) {
      if (stopping) break;
      if (positions.get(mint) !== pos) continue; // closed while this cycle was running
      if (selling.has(mint)) continue; // a sale of this mint is in flight
      if (MAX_HOLD_SEC > 0 && !pos.exitFull && Date.now() - pos.entryTime >= MAX_HOLD_SEC * 1000) {
        pos.pendingExit = true;
        pos.exitFull = true;
        pos.exitReason = "max-hold timeout";
        log(`  max hold ${MAX_HOLD_SEC}s reached for ${mint.slice(0, 8)}: the target has not sold — selling`);
      }
      if (!pos.pendingExit || !sellRetry.due(pos)) continue;
      try {
        await copySell(mint, pos.copiedFrom, { reason: pos.exitReason || "target sold", retry: (pos.attempts || 0) > 0 });
      } catch (err) {
        log(`  exit check error ${mint.slice(0, 8)}: ${err.message}`);
      }
    }
  } finally {
    exitChecking = false;
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
  if (exitTimer) clearInterval(exitTimer);
  stallGuard.stop();
  if (LIVE && positions.size > 0) {
    log(`  closing ${positions.size} open position(s) before exit...`);
    for (const [mint, pos] of [...positions]) {
      try { await copySell(mint, pos.copiedFrom, { reason: "stop", final: true }); }
      catch (err) { log(`  close failed ${mint.slice(0, 8)}: ${err.message}`); }
    }
  }
  for (const [mint] of [...positions]) session.drop(`${mint.slice(0, 8)}: still open at stop`);
  // ATA closes still in flight must be in the ledger before the wallet is read (bounded wait).
  const closesLeft = (await ataCloser.drain()).pending;
  if (closesLeft) log(`  ${closesLeft} ATA close(s) still unconfirmed at stop — not in the summary`);
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
log(`Exit safety: max hold ${MAX_HOLD_SEC > 0 ? `${MAX_HOLD_SEC}s` : "off"} (COPY_MAX_HOLD_SEC), sell attempts <= ${SELL_MAX_ATTEMPTS} (SELL_MAX_ATTEMPTS)`);
log(`Console: ${stallGuard.banner()}`);

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
    // Backlog after a stall: the target's trade is older than STALL_GUARD_SEC.
    const backlog = stallGuard.isStale(events);
    for (const ev of events) {
      if (ev.type !== "trade") continue;
      // H1: only the subscribed target's OWN trades. A tx that merely mentions the target (e.g. as a
      // fee recipient) carries trades of other wallets — copying those was the bug.
      if (ev.user !== target) continue;
      if (ev.isBuy) {
        if (backlog) continue; // an old buy is not copied (the price it was made at is gone)
        await copyBuy(ev.mint, target);
      } else {
        await copySell(ev.mint, target);
      }
    }
  });
  log(`Subscribed to ${target.slice(0, 12)}...`);
}

// Exit timer: sell retries (M6) + max-hold safety (P5). Skips itself while the bot is stopping.
exitTimer = setInterval(() => void checkExits(), EXIT_POLL_MS);
stallGuard.start();

log("\nListening for target wallet trades...\n");

process.on("SIGINT", () => {
  void finish("manual stop (Ctrl+C)");
});
process.on("SIGTERM", () => {
  // Process managers send SIGTERM: run the same graceful shutdown.
  if (!exited) void finish("SIGTERM");
});
