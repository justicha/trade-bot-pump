#!/usr/bin/env node
// Graduation shadow lab (DRY RUN ONLY): one candidate stream, one virtual wallet per variant.
//
// It never sends a transaction. It follows pump.fun trade events, turns every mint that reaches
// the lowest variant threshold (% of REAL reserves) into a candidate, and lets each variant decide
// whether to "enter". Entries/exits are priced pessimistically (200-800 ms delay, size slippage,
// pump fees, priority + tx fee) through lib/pessimistic.mjs; every trade is journaled for
// scripts/analyze-graduation.mjs.
//
//   node bots/graduation-sniper/shadow.mjs               # until Ctrl+C
//   $env:SHADOW_MAX_SEC='60'; node bots/graduation-sniper/shadow.mjs
//
// A stop (Ctrl+C, SIGTERM or SHADOW_MAX_SEC) closes every open position and journals it, so a run
// never loses the trades that were live when it ended. Each (variant, mint) pair is opened at most
// once per session, and journaled lines carry `costsScheme` so the report can keep accounting
// epochs apart.
//
// After MIGRATION the curve stream goes silent and its last price is the highest the curve ever
// had. Closing a position at that frozen price (what this lab did before) overstated every
// migrated mint. Now a position whose curve completed is priced from the PumpSwap pool quote
// (read-only RPC, lib/pumpswap.mjs ammSellQuote); if the pool cannot be priced the trade is
// journaled WITHOUT a result (exitVenue "amm-unpriced") — never at an invented price.
//
// Variant J is the live graduation config (lib/grad-config.mjs). Variant I (enter after migration)
// still reports "no data": the stream carries no AMM entry price. K / L / M / N are described in
// lib/gshadow.mjs buildVariants; SHADOW_VARIANTS (e.g. "ABCDEFGHJ") narrows the set that trades.
//
// The lab also watches its own clock (SHADOW_LATE_SEC, default 30; 0 = off). On Windows a paused
// console (a click that starts a text selection, a scroll, Pause) blocks console.log and with it
// the whole process — it once stood still for 22–39 minutes right after a migration and then
// booked "sl -97%" on a 300 s timeout. Now: a gap between two timer ticks is journaled
// (gshadow_stall) and marks the positions that lived through it (stallSec); a timeout noticed
// later than SHADOW_LATE_SEC after its deadline is journaled WITHOUT a result (late: true); a
// stream event older than SHADOW_LATE_SEC (the backlog the socket delivers after a stall) is
// dropped instead of being traded on as if it were the present.
import { PublicKey } from "@solana/web3.js";
import { LIVE } from "../../lib/config.mjs";
import { PUMP_PROGRAM, TRADE_EVENT_PREFIX } from "../../lib/constants.mjs";
import { gradFillPct } from "../../lib/curve.mjs";
import { previewExit } from "../../lib/exec.mjs";
import { getBondingCurveState } from "../../lib/pumpfun.mjs";
import { ammSellQuote } from "../../lib/pumpswap.mjs";
import { connection, rpcCall } from "../../lib/rpc.mjs";
import { readGradStrategy } from "../../lib/grad-config.mjs";
import {
  activeVariantIds,
  ammEntryTokens,
  ammRatio,
  buildVariants,
  candidateThreshold,
  closeDecision,
  eventLagMs,
  fillGainPp,
  isLate,
  openRow,
  pushFillSample,
  stallGapMs,
  tradeRow,
  variantAccepts,
} from "../../lib/gshadow.mjs";
import { TradeJournal } from "../../lib/journal.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

if (LIVE) {
  console.error("[shadow] refuses to run with --live: this is a paper lab.");
  process.exit(1);
}

const MIN_FILL = Number(process.env.MIN_FILL || 92);
const BUY_SOL = Number(process.env.SHADOW_BUY_SOL || 0.02);
const SL = Number(process.env.SHADOW_SL || 0.7);
const HOLD_SEC = Number(process.env.SHADOW_HOLD_SEC || 300);
const MAX_SEC = Number(process.env.SHADOW_MAX_SEC || 0);
// Upper bound on remembered mints. Reaching it must never cost us a live position or a trade —
// see the prune block in the tick timer.
const MAX_MINTS = Number(process.env.SHADOW_MAX_MINTS || 20_000);
// A mint with an open position and no trade event for this long is checked for migration (the
// stream cannot tell "nobody trades" from "the curve is finished").
const STALE_MS = Number(process.env.SHADOW_STALE_SEC || 15) * 1000;
// A migrated position asks the pool for a quote at most this often.
const AMM_POLL_MS = Number(process.env.SHADOW_AMM_POLL_MS || 5000);
// "The lab was not watching" threshold for the three clock guards (see the header). 0 = off.
const LATE_SEC = Number(process.env.SHADOW_LATE_SEC === undefined || process.env.SHADOW_LATE_SEC === "" ? 30 : process.env.SHADOW_LATE_SEC);
const LATE_MS = Number.isFinite(LATE_SEC) && LATE_SEC > 0 ? LATE_SEC * 1000 : 0;
// Variant L: the fill must have grown by this many percentage points over this many seconds.
const MOMENTUM = { pp: Number(process.env.SHADOW_MOMENTUM_PP || 5), sec: Number(process.env.SHADOW_MOMENTUM_SEC || 60) };
const journal = new TradeJournal({ bot: "graduation-shadow" });

// A–I keep the lab-wide MIN_FILL / SHADOW_SL / SHADOW_HOLD_SEC; J reads the live graduation config.
const VARIANTS = buildVariants({ minFill: MIN_FILL, sl: SL, holdSec: HOLD_SEC, live: readGradStrategy(), momentum: MOMENTUM });
const ACTIVE_VARIANTS = activeVariantIds(VARIANTS, process.env.SHADOW_VARIANTS);
if (ACTIVE_VARIANTS.length === 0) {
  console.error(`[shadow] SHADOW_VARIANTS="${process.env.SHADOW_VARIANTS}" selects no variant (known: ${activeVariantIds(VARIANTS).join("")}).`);
  process.exit(1);
}
const CANDIDATE_MIN_FILL = candidateThreshold(VARIANTS, ACTIVE_VARIANTS);
// The fill history of a mint is kept only when a momentum variant trades, and only this far back.
const MOMENTUM_WINDOW_MS = Math.max(0, ...ACTIVE_VARIANTS.map((id) => (VARIANTS[id].momentum ? VARIANTS[id].momentum.sec * 1000 : 0)));

const mintState = new Map(); // mint -> { buyers:Set, entered:Set, fill, rSol, price, vsol, vtok, lastEventAt, migrated }
const open = new Map(); // `${variant}:${mint}` -> position
// Every (variant, mint) pair opened at least once this session. mintState is bounded and a mint can
// be evicted and then reappear; `entered`, which lives ON that state, dies with it, so without this
// session-wide set the mint would be opened a second time and counted twice in the report.
const openedKeys = new Set();
// Stream events dropped as stale since the last report (see flushStale).
const stale = { events: 0, maxLagMs: 0, flushedAt: 0 };

// trade-v3 event: mint 8..40, is_buy 56, user 57..89, timestamp 89 (unix seconds = block time),
// virtualSol 97, virtualToken 105, realSol 113.
function parseEvent(data) {
  if (data.length < 129) return null;
  try {
    return {
      mint: new PublicKey(data.subarray(8, 40)).toBase58(),
      isBuy: data[56] === 1,
      user: new PublicKey(data.subarray(57, 89)).toBase58(),
      timestampSec: Number(data.readBigInt64LE(89)),
      virtualSolReserves: data.readBigUInt64LE(97),
      virtualTokenReserves: data.readBigUInt64LE(105),
      realSolReserves: data.readBigUInt64LE(113),
    };
  } catch {
    return null;
  }
}

const priceOf = (s) => (Number(s.virtualSolReserves) / Number(s.virtualTokenReserves)) * 1e-3;
const log0 = (m) => console.log(`[shadow] ${m}`);

function enter(variantId, v, mint, s, gainPp = null) {
  const key = `${variantId}:${mint}`;
  if (openedKeys.has(key) || open.has(key) || s.entered.has(variantId)) return;
  const spot = priceOf(s);
  if (!(spot > 0)) return;
  openedKeys.add(key);
  s.entered.add(variantId);
  // Entry is the curve spot. The buy slippage is charged ONCE, inside pessimisticRoundTrip at the
  // exit; moving this price up by slipBps as well charged it twice (see SHADOW_COSTS_SCHEME).
  // `tokens` is what the position would hold: needed to ask the pool for a quote after migration.
  const tokens = ammEntryTokens(s, BUY_SOL);
  const pos = { variant: variantId, mint, entryPrice: spot, at: Date.now(), spot, tokens, mode: "curve", amm: null };
  open.set(key, pos);
  journal.write(openRow({ variantId, v, mint, fill: s.fill, holders: s.buyers.size, spot, buySol: BUY_SOL, tokens, gainPp }));
}

// `gainPp`: growth of the mint's fill over the momentum window (null without history) — only a
// momentum variant (L) reads it.
function tryEnter(variantId, v, mint, s, gainPp = null) {
  const key = `${variantId}:${mint}`;
  // `openedKeys` first: an already-opened (variant, mint) must not even start the exit-check RPC
  // when a long-evicted mint reappears in the stream.
  if (openedKeys.has(key) || open.has(key) || s.entered.has(variantId)) return;
  if (!variantAccepts(v, { fill: s.fill, holders: s.buyers.size, gainPp })) return;
  if (!v.exitCheck) {
    enter(variantId, v, mint, s, gainPp);
    return;
  }
  getBondingCurveState(new PublicKey(mint), 0, 3)
    .then((state) => {
      if (state && !state.complete) {
        const prev = previewExit(state, BUY_SOL);
        if (!prev.ok || prev.ratio < 0.9) return;
      }
      enter(variantId, v, mint, s);
    })
    .catch(() => {});
}

// One place that journals a closed position.
// `venue`: "curve" | "amm" | "amm-unpriced" | "curve-unpriced".
// `extra` carries per-exit flags (e.g. `unconfirmed: true` when the stop had no price); it can
// never overwrite the accounting fields (lib/gshadow.mjs tradeRow). A position that lived through
// a process stall says so in its row (`stallSec`): its prices were not watched for that long.
function closePos(key, pos, reason, { venue = "curve", price = null, extra } = {}) {
  const now = Date.now();
  const amm = venue === "amm" ? { solOut: pos.amm.solOut, feeBps: pos.amm.feeBps, feeSource: pos.amm.feeSource, ageMs: now - pos.amm.at } : null;
  const flags = { ...(pos.stallMs ? { stallSec: Math.round(pos.stallMs / 1000) } : {}), ...extra };
  journal.write(tradeRow({ pos, v: VARIANTS[pos.variant], reason, venue, price, amm, buySol: BUY_SOL, now, extra: flags }));
  open.delete(key);
}

// Close by a lib/gshadow.mjs closeDecision. A late timeout carries how late it was noticed.
function closeBy(key, pos, d, { price = null, heldMs, holdMs }) {
  closePos(key, pos, d.reason, {
    venue: d.venue,
    price,
    extra: d.late ? { late: true, lateSec: Math.round((heldMs - holdMs) / 1000) } : undefined,
  });
}

// ---- migration: curve finished -> the position is priced from the PumpSwap pool ---------------

// Read-only, rate-limited view of the RPC for ammSellQuote (getAccountInfo / getTokenAccountBalance
// / getTokenSupply — the supply picks the pool's fee tier).
const quoteRpc = {
  getAccountInfo: (a) => rpcCall(() => connection.getAccountInfo(a), { priority: 3 }),
  getTokenAccountBalance: (a) => rpcCall(() => connection.getTokenAccountBalance(a), { priority: 3 }),
  getTokenSupply: (m) => rpcCall(() => connection.getTokenSupply(m), { priority: 3 }),
};
let ammGlobalConfig = null; // decoded once; the pool fee split does not change during a session
const quoteCache = new Map(); // `${mint}:${tokens}` -> { at, promise } — variants share one request

// Pool quote for a position (null = no pool / unreadable: the caller must NOT invent a price).
function quoteAmm(pos) {
  const k = `${pos.mint}:${pos.tokens}`;
  const now = Date.now();
  const hit = quoteCache.get(k);
  if (hit && now - hit.at < AMM_POLL_MS) return hit.promise;
  const promise = ammSellQuote(quoteRpc, new PublicKey(pos.mint), pos.tokens, ammGlobalConfig)
    .then((q) => {
      if (!q || !(q.solOut > 0n)) return null;
      // Cache the fee config only when it really came from the chain (the fallback has no recipients).
      if (!ammGlobalConfig && q.g?.protocolFeeRecipients?.length) ammGlobalConfig = q.g;
      return { solOut: q.solOut, feeBps: q.feeBps, feeSource: q.feeSource, at: Date.now(), ratio: ammRatio(q.solOut, BUY_SOL) };
    })
    .catch(() => null);
  quoteCache.set(k, { at: now, promise });
  return promise;
}

// Is the curve of this mint finished? Asked only for mints with an open position, when the stream
// says "100% filled" or has been silent for SHADOW_STALE_SEC. One request in flight per mint.
function checkMigration(mint, s, now) {
  if (s.migrated || s.checking) return;
  const recheckMs = s.fill >= 100 ? 2000 : STALE_MS;
  if (now - (s.checkedAt || 0) < recheckMs) return;
  s.checking = true;
  getBondingCurveState(new PublicKey(mint), 0, 3)
    .then((state) => {
      if (!state || state.complete) {
        s.migrated = true;
        log0(`${mint.slice(0, 8)}: curve ${state ? "complete" : "gone"} — open positions are priced from the PumpSwap pool`);
      } else {
        // The chain says the curve still trades: the stream price stays valid.
        s.curveAlive = true;
      }
    })
    .catch(() => {})
    .finally(() => {
      s.checking = false;
      s.checkedAt = Date.now();
    });
}

// The stream said the curve reached 100% and the chain has not contradicted it: the last curve
// price is not an exit price any more.
const curveFinished = (s) => !!s && (s.migrated || (s.fill >= 100 && !s.curveAlive));

// TP / SL / timeout of a migrated position, against the pool quote. A position that reaches its
// timeout without ever getting a quote is closed unpriced; so is one whose timeout is noticed too
// late (the quote at hand is not the price at the deadline). Variant N leaves at the first quote.
function evaluateAmm(key, pos, v) {
  if (!open.has(key)) return;
  const heldMs = Date.now() - pos.at;
  const holdMs = v.holdSec * 1000;
  const d = closeDecision({
    venue: "amm",
    ratio: pos.amm ? pos.amm.ratio : null,
    tp: v.tp,
    sl: v.sl,
    heldMs,
    holdMs,
    lateMs: LATE_MS,
    exitOnMigration: !!v.exitOnMigration,
  });
  if (d) closeBy(key, pos, d, { heldMs, holdMs });
}

function tickAmm(key, pos, v, now) {
  if (pos.quoting) {
    // A quote in flight settles within seconds and then evaluates the position itself. One that
    // does not must not keep the position open past its deadline for ever.
    if (isLate({ heldMs: now - pos.at, holdMs: v.holdSec * 1000, lateMs: LATE_MS })) evaluateAmm(key, pos, v);
    return;
  }
  if (now - (pos.ammPolledAt || 0) < AMM_POLL_MS) {
    evaluateAmm(key, pos, v); // between polls: the timeout still applies (with the last quote)
    return;
  }
  pos.quoting = true;
  pos.ammPolledAt = now;
  quoteAmm(pos)
    .then((q) => {
      if (q) pos.amm = q;
    })
    .finally(() => {
      pos.quoting = false;
      evaluateAmm(key, pos, v);
    });
}

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  if (!(value.logs[value.logs.length - 1] || "").includes("success")) return;
  // EVERY trade event of the transaction is processed (a tx can carry several: a router hop, a
  // bundle). The old handler returned after the first one and lost the rest — including, when the
  // last event was the one that crossed the band, the candidate itself.
  for (const l of value.logs) {
    if (!l.startsWith("Program data: ")) continue;
    const data = Buffer.from(l.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    const ev = parseEvent(data);
    if (!ev) continue;
    // An event older than SHADOW_LATE_SEC is not the present: it is the backlog the socket hands
    // over after the process stood still. Its price and fill must not open or close anything.
    if (LATE_MS > 0) {
      const lagMs = eventLagMs(ev.timestampSec, Date.now());
      if (lagMs > LATE_MS) {
        stale.events += 1;
        stale.maxLagMs = Math.max(stale.maxLagMs, lagMs);
        continue;
      }
    }
    let s = mintState.get(ev.mint);
    if (!s) {
      s = { buyers: new Set(), entered: new Set(), fill: 0, rSol: 0n, price: 0 };
      mintState.set(ev.mint, s);
    }
    // Buyer = the event's own is_buy flag (byte 56), not "the tx has a Buy instruction somewhere".
    if (ev.isBuy) s.buyers.add(ev.user);
    s.virtualSolReserves = ev.virtualSolReserves;
    s.virtualTokenReserves = ev.virtualTokenReserves;
    s.rSol = ev.realSolReserves;
    s.fill = gradFillPct(ev.realSolReserves);
    s.price = priceOf(s);
    s.lastEventAt = Date.now();
    if (s.fill < 100) s.curveAlive = false; // only a fresh check can vouch for a 100% curve
    // Momentum (variant L): how much the fill grew over the window, measured BEFORE this event is
    // added to the history. Tracked for every mint — the reference point is usually below the
    // candidate threshold.
    let gainPp = null;
    if (MOMENTUM_WINDOW_MS > 0) {
      s.hist ??= [];
      gainPp = fillGainPp(s.hist, s.lastEventAt, s.fill, MOMENTUM_WINDOW_MS);
      pushFillSample(s.hist, s.lastEventAt, s.fill, MOMENTUM_WINDOW_MS);
    }
    if (s.fill >= CANDIDATE_MIN_FILL) {
      journal.write({ type: "gshadow_candidate", mint: ev.mint, fill: s.fill, holders: s.buyers.size, price: s.price });
      for (const id of ACTIVE_VARIANTS) tryEnter(id, VARIANTS[id], ev.mint, s, gainPp);
    }
  }
});

log0("Listening for candidates in the shadow lab...");
log0(
  `variants ${ACTIVE_VARIANTS.join("")} | candidate threshold ${CANDIDATE_MIN_FILL}% | J live config: fill ${VARIANTS.J.minFill}-${VARIANTS.J.maxFill}%, holders>=${VARIANTS.J.minHolders}, TP ${VARIANTS.J.tp}, SL ${VARIANTS.J.sl}, hold ${VARIANTS.J.holdSec}s`,
);
log0(
  `clock guards ${LATE_MS > 0 ? `${LATE_MS / 1000}s (stall / late timeout / stale events)` : "OFF"}` +
    (MOMENTUM_WINDOW_MS > 0 ? ` | L momentum +${MOMENTUM.pp}pp / ${MOMENTUM.sec}s` : "") +
    " | do not select text in this window: a paused console freezes the lab",
);

// Rate-limited (once a minute): the tick runs every second, and a run that sits permanently at the
// cap would otherwise flood the log. Never throttled into silence about a prune, though — that is
// the interesting event.
let capLogAt = 0;
function capLog(pruned) {
  const now = Date.now();
  if (now - capLogAt < 60_000) return;
  capLogAt = now;
  log0(
    `mintState cap ${MAX_MINTS}: pruned ${pruned} spent mint(s), ${mintState.size} held` +
      (mintState.size > MAX_MINTS ? " — nothing else is prunable, active entries are never dropped" : ""),
  );
}

// ---- clock guards ---------------------------------------------------------------------------
// The tick below runs every second. When it does not, the process was not running (paused console,
// sleep, a debugger): nothing was priced meanwhile. The gap is journaled, and every position that
// was open across it remembers how long it went unwatched.
let lastTickAt = Date.now();

function noteStall(gapMs, now) {
  for (const pos of open.values()) pos.stallMs = (pos.stallMs || 0) + gapMs;
  journal.write({ type: "gshadow_stall", stallSec: Math.round(gapMs / 1000), open: open.size, at: new Date(now - gapMs).toISOString() });
  return `STALL: the process did not run for ${Math.round(gapMs / 1000)}s (paused console? sleep?) with ${open.size} open position(s) — overdue ones are journaled without a result`;
}

// Dropped stale events are reported in bulk, at most every 10 s (a backlog arrives as a burst).
function flushStale(now) {
  if (stale.events === 0 || now - stale.flushedAt < 10_000) return null;
  const maxLagSec = Math.round(stale.maxLagMs / 1000);
  journal.write({ type: "gshadow_stale_events", events: stale.events, maxLagSec });
  const line = `dropped ${stale.events} stream event(s) older than ${LATE_MS / 1000}s (max lag ${maxLagSec}s) — a backlog after a stall; if this never stops, check the system clock`;
  stale.events = 0;
  stale.maxLagMs = 0;
  stale.flushedAt = now;
  return line;
}

const timer = setInterval(() => {
  const now = Date.now();
  // Journal first, console last: the console is the thing that can block.
  const notes = [];
  const gapMs = stallGapMs(now, lastTickAt, LATE_MS);
  lastTickAt = now;
  if (gapMs) notes.push(noteStall(gapMs, now));
  for (const [key, pos] of [...open]) {
    const v = VARIANTS[pos.variant];
    const s = mintState.get(pos.mint);
    const heldMs = now - pos.at;
    const holdMs = v.holdSec * 1000;
    if (pos.mode !== "amm" && s) {
      // 100% in the stream, or silence: ask the chain whether the curve is finished.
      if (s.fill >= 100 || now - (s.lastEventAt || pos.at) >= STALE_MS) checkMigration(pos.mint, s, now);
      if (s.migrated) pos.mode = "amm";
    }
    if (pos.mode === "amm") {
      tickAmm(key, pos, v, now);
      continue;
    }
    // A curve that reported 100% is not a venue any more: wait for the check, do not price on it.
    // The plain deadline is not applied while waiting (a pool quote is usually seconds away), but
    // a wait that outlives the deadline by SHADOW_LATE_SEC ends without a result — before, a
    // failing check kept such a position open for ever.
    if (curveFinished(s)) {
      if (isLate({ heldMs, holdMs, lateMs: LATE_MS })) closeBy(key, pos, { reason: "timeout", venue: "amm-unpriced", late: true }, { heldMs, holdMs });
      continue;
    }
    const price = s?.price;
    const d = closeDecision({ venue: "curve", ratio: price > 0 ? price / pos.entryPrice : null, tp: v.tp ?? 1.5, sl: v.sl, heldMs, holdMs, lateMs: LATE_MS });
    if (d) closeBy(key, pos, d, { price: d.venue === "curve" ? price : null, heldMs, holdMs });
  }
  const staleNote = flushStale(now);
  if (staleNote) notes.push(staleNote);
  for (const [k, c] of quoteCache) if (now - c.at > 60_000) quoteCache.delete(k);
  // Keep mintState bounded WITHOUT ever dropping something that can still trade. A mint is only
  // evicted when nothing can reference it any more: no open position AND every pre-migration
  // variant has already opened it. Evicting on size alone resurrected a closed mint and produced a
  // duplicate `gshadow_open` (one mint was opened 5 times in a 3h run). If the cap is still
  // exceeded after pruning, memory is allowed to grow and the condition is logged — never solved by
  // deleting an active entry.
  if (mintState.size > MAX_MINTS) {
    const live = new Set([...open.values()].map((p) => p.mint));
    let pruned = 0;
    for (const mint of [...mintState.keys()]) {
      if (live.has(mint)) continue;
      if (!ACTIVE_VARIANTS.every((id) => openedKeys.has(`${id}:${mint}`))) continue;
      mintState.delete(mint);
      pruned += 1;
    }
    if (pruned > 0 || mintState.size > MAX_MINTS) capLog(pruned);
  }
  for (const n of notes) log0(n);
}, 1000);

// ---- stop path ------------------------------------------------------------------------------
// A stop must journal what it closes. The old handler called process.exit(0) with positions still
// in `open`, so every trade that was live when the operator hit Ctrl+C silently disappeared from
// the report (one real run ended with 8 opens and 0 closes for the same mint). All three stop
// paths — SIGINT, SIGTERM and SHADOW_MAX_SEC — go through this single function, and it is
// idempotent: a second signal arriving while the socket is closing must not write the same
// positions twice.
let stopping = false;

// A position whose mint no longer carries a usable price is STILL journaled, because a missing
// trade is worse than an imperfect one: the report would silently lose the position.
//   curve position without a price -> `unconfirmed: true`, its entry price as the exit (as before)
//   migrated position              -> the last pool quote, or "amm-unpriced" (no result at all)
function closeAllAtStop(stopReason) {
  let closed = 0;
  let unconfirmed = 0;
  for (const [key, pos] of [...open]) {
    const s = mintState.get(pos.mint);
    if (pos.mode === "amm" || curveFinished(s)) {
      if (pos.amm) closePos(key, pos, stopReason, { venue: "amm" });
      else {
        closePos(key, pos, stopReason, { venue: "amm-unpriced" });
        unconfirmed += 1;
      }
      closed += 1;
      continue;
    }
    const price = s?.price;
    const priced = Number(price) > 0;
    closePos(key, pos, stopReason, { price: priced ? price : pos.entryPrice, extra: priced ? undefined : { unconfirmed: true } });
    closed += 1;
    if (!priced) unconfirmed += 1;
  }
  return { closed, unconfirmed };
}

// Last chance for migrated positions to get a pool quote before they are closed (bounded: a stop
// must not hang on a slow RPC).
async function finalAmmQuotes() {
  const pending = [];
  for (const pos of open.values()) {
    if (pos.mode !== "amm" && !curveFinished(mintState.get(pos.mint))) continue;
    quoteCache.delete(`${pos.mint}:${pos.tokens}`); // a fresh quote, not the cached one
    pending.push(quoteAmm(pos).then((q) => { if (q) pos.amm = q; }));
  }
  if (!pending.length) return;
  await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 4000))]);
}

async function finishShadow(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const stopReason = reason === "sigterm" ? "shutdown" : "manual stop";
  await finalAmmQuotes().catch(() => {});
  const { closed, unconfirmed } = closeAllAtStop(stopReason);
  log0(`=== SHADOW STOP (${reason}) ===`);
  log0(`open at stop: ${closed} position(s) closed as "${stopReason}"${unconfirmed ? `, ${unconfirmed} unconfirmed (no price)` : ""}`);
  log0(`journal: ${journal.file()}`);
  await ws.close().catch(() => {});
  process.exit(0);
}

if (MAX_SEC > 0) setTimeout(() => finishShadow("max-sec"), MAX_SEC * 1000);

process.on("SIGINT", () => finishShadow("sigint"));
process.on("SIGTERM", () => finishShadow("sigterm"));
