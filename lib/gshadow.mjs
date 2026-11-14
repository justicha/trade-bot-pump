// Pure logic of the graduation shadow lab (bots/graduation-sniper/shadow.mjs): the variant table,
// the entry / exit rules and the journal rows. No I/O here, so every number can be tested without
// a stream or an RPC.
import { pessimisticRoundTrip, sizeSlippageBps, SHADOW_COSTS_SCHEME } from "./pessimistic.mjs";

// Revision of the lab's RULES (not of its cost model — that is costsScheme, see
// lib/pessimistic.mjs: v5-amm-fee changed the AMM fee inside the quote, not a rule, so the
// revision stayed at 5),
// journaled as `shadowRev` on every gshadow_open / gshadow_trade. Rows without the field were
// written before revision 5 and can contain freeze artifacts: a position that nobody watched for
// half an hour, closed at whatever the pool paid afterwards.
//   5 (2026-11-13): a timeout noticed too late is journaled unpriced (closeDecision), a process
//     stall is journaled (gshadow_stall) and marks the positions that lived through it, stale
//     stream events are dropped, variants K / L / M / N.
//   6 (2026-11-14): an event older than SHADOW_ENTRY_MAX_LAG_SEC (default 5 s) opens nothing and
//     does not feed L's momentum history; gshadow_open carries lagSec.
//   7 (2026-11-14): journal only — decisions are byte-for-byte revision 6. gshadow_open carries
//     `feat` (lib/gshadow-features.mjs: creator, launches, copycat names, wallet concentration,
//     60 s flow, price vs the standard curve); migrated gshadow_trade rows carry curveCompleteSec /
//     migNoticedLagSec; a periodic gshadow_mem row. Costs unchanged (costsScheme as before).
export const SHADOW_REV = 7;

// The variant table.
//   minFill / sl / holdSec used to be lab-wide constants (MIN_FILL, SHADOW_SL, SHADOW_HOLD_SEC).
//   They are per-variant now so that J can run the LIVE band and exits next to A–I; A–I get
//   exactly the lab-wide values they always had.
//   J "live config": the band, the holder gate and the exits of bots/graduation-sniper
//   (lib/grad-config.mjs readGradStrategy). It is the only variant that answers "does the config I
//   actually run make money". Not mirrored: MAX_POSITIONS, the cooldown, the Mayhem / Token-2022
//   filters, the exit-ratio gate and the pre-buy simulation of the live bot.
//   K–N (revision 5) carry their own parameters in every row, like J:
//   K "late entry"        fill 88–95, holders >= 20 — fixed numbers, not the lab-wide ones
//   L "momentum"          fill 75–90, holders >= 5, and the fill grew by >= momentum.pp points
//                         over the last momentum.sec seconds (fillGainPp below)
//   M "live, SL 0.5"      J with a wider stop
//   N "exit on migration" J, but a migrated position is closed at the FIRST pool quote
export function buildVariants({ minFill, sl, holdSec, live, momentum = { pp: 5, sec: 60 } }) {
  const lab = { minFill, sl, holdSec };
  const variants = {
    A: { label: "baseline", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    B: { label: "MIN_HOLDERS 7", minHolders: 7, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    C: { label: "MIN_HOLDERS 15", minHolders: 15, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    D: { label: "MAX_FILL 95", minHolders: 0, maxFill: 95, exitCheck: false, tp: 1.5, ...lab },
    E: { label: "MAX_FILL 97", minHolders: 0, maxFill: 97, exitCheck: false, tp: 1.5, ...lab },
    F: { label: "exit check >=0.9", minHolders: 0, maxFill: 100, exitCheck: true, tp: 1.5, ...lab },
    G: { label: "B+E+F", minHolders: 7, maxFill: 97, exitCheck: true, tp: 1.5, ...lab },
    H: { label: "TP 1.3", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.3, ...lab },
    I: { label: "enter after migration", postMigration: true, tp: 1.5, ...lab },
  };
  if (live) {
    variants.J = {
      label: "live config",
      minHolders: live.minHolders,
      maxFill: live.maxFillPct,
      exitCheck: false,
      tp: live.takeProfit,
      minFill: live.minFillPct,
      sl: live.stopLoss,
      holdSec: live.timeoutSec,
      journalParams: true, // its rows carry the parameters they were produced with
    };
  }
  const fixed = { exitCheck: false, tp: 1.5, sl: 0.7, holdSec: 300, journalParams: true };
  variants.K = { label: "late entry 88-95, holders>=20", minHolders: 20, minFill: 88, maxFill: 95, ...fixed };
  variants.L = {
    label: "momentum",
    minHolders: 5,
    minFill: 75,
    maxFill: 90,
    ...fixed,
    momentum: { pp: Number(momentum.pp), sec: Number(momentum.sec) },
  };
  if (live) {
    variants.M = { ...variants.J, label: "live config, SL 0.5", sl: 0.5 };
    variants.N = { ...variants.J, label: "live config, exit on migration", exitOnMigration: true };
  }
  return variants;
}

// Variants that trade. `only` (SHADOW_VARIANTS, e.g. "ABCDEFGHJ") narrows the set; empty = all.
export function activeVariantIds(variants, only = "") {
  const pick = String(only || "").toUpperCase().replace(/[^A-Z]/g, "");
  return Object.keys(variants).filter((id) => !variants[id].postMigration && (!pick || pick.includes(id)));
}

// A mint becomes a candidate at the LOWEST minFill of the active variants: with one lab-wide
// threshold (92) variant J (e.g. 75–90) would never see its own band.
export function candidateThreshold(variants, ids = activeVariantIds(variants)) {
  return Math.min(...ids.map((id) => variants[id].minFill));
}

// Entry filter of one variant (the holder count and the fill of the event being processed).
// `gainPp` is only read by a momentum variant: null (no history yet) never enters.
export function variantAccepts(v, { fill, holders, gainPp = null }) {
  if (v.postMigration) return false;
  if (v.momentum && !(gainPp !== null && gainPp >= v.momentum.pp)) return false;
  return fill >= v.minFill && fill <= v.maxFill && holders >= v.minHolders;
}

// The parameters a variant's rows were produced with (journaled for J and K–N). The two extra keys
// appear only on the variants that have them, so J's object is exactly what it always was.
export function variantParams(v) {
  return {
    minFill: v.minFill,
    maxFill: v.maxFill,
    minHolders: v.minHolders,
    tp: v.tp ?? 1.5,
    sl: v.sl,
    holdSec: v.holdSec,
    ...(v.momentum ? { momentumPp: v.momentum.pp, momentumSec: v.momentum.sec } : {}),
    ...(v.exitOnMigration ? { exitOnMigration: true } : {}),
  };
}

// ---- momentum (variant L): fill history of one mint ------------------------------------------
// At most one sample per second, and exactly one sample at or before the start of the window is
// kept (it is the "fill `windowMs` ago"), so a hot mint costs ~60 numbers, not thousands.
export function pushFillSample(hist, t, fill, windowMs) {
  const last = hist[hist.length - 1];
  if (last && t - last.t < 1000) return hist;
  hist.push({ t, fill });
  while (hist.length >= 2 && hist[1].t <= t - windowMs) hist.shift();
  return hist;
}

// Growth of the fill, in percentage points, over the last `windowMs`: the current fill minus the
// fill the mint had `windowMs` ago (the latest sample at or before that moment). A mint first seen
// less than a window ago is measured from its oldest sample — growth over the part of the window
// that was observed. No sample at all -> null: the history is unknown, not zero.
export function fillGainPp(hist, now, fill, windowMs) {
  const cutoff = now - windowMs;
  let ref = null;
  for (const h of hist) {
    if (h.t <= cutoff) ref = h;
    else {
      if (!ref) ref = h;
      break;
    }
  }
  return ref ? fill - ref.fill : null;
}

// ---- watching the clock ------------------------------------------------------------------------
// Everything in this block exists because of one observed failure: the lab's process stood still
// for 22–39 minutes (a paused console blocks console.log, and with it the whole event loop), three
// times, each time right after a curve completed. Nothing was evaluated meanwhile; when the
// process came back the first pool quote was half an hour late and the positions were journaled
// as "sl -97%" at holdSec 2008 with a 300 s timeout. A real exit would have happened at the
// timeout, at a price nobody recorded — so the honest row has no result.

// A timeout noticed more than `lateMs` after its deadline. 0 / Infinity switch the rule off.
export function isLate({ heldMs, holdMs, lateMs }) {
  return lateMs > 0 && heldMs - holdMs > lateMs;
}

// One decision for an open position at one evaluation (null = keep it open).
//   venue "curve"  the curve trades; ratio = stream price / entry price
//   venue "amm"    the curve is finished; ratio = last pool quote / buy size, or null while the
//                  pool has not been priced
// In this order:
//   late       -> "timeout" on "<venue>-unpriced" with late: true — whatever price is at hand now
//                 is not the price at the deadline;
//   no price   -> nothing before the deadline (the pool may still appear), "timeout" unpriced at it;
//   N's rule   -> a migrated position leaves at the first quote ("migration-exit");
//   otherwise  -> TP / SL / timeout (exitReason).
export function closeDecision({ venue, ratio = null, tp = 1.5, sl, heldMs, holdMs, lateMs = Infinity, exitOnMigration = false }) {
  if (isLate({ heldMs, holdMs, lateMs })) return { reason: "timeout", venue: `${venue}-unpriced`, late: true };
  if (ratio === null || !Number.isFinite(ratio)) return heldMs >= holdMs ? { reason: "timeout", venue: `${venue}-unpriced` } : null;
  if (venue === "amm" && exitOnMigration) return { reason: "migration-exit", venue };
  const reason = exitReason({ ratio, tp, sl, heldMs, holdMs });
  return reason ? { reason, venue } : null;
}

// stallGapMs (the gap between two timer ticks when it is long enough to be a stall) and
// eventLagMs (how old a trade event is by its own on-chain timestamp, bytes 89..97 of the trade-v3
// payload) moved to lib/stall-guard.mjs — the live bots use the same two rules now (KODING №10 C).
// Re-exported so the lab and its tests keep importing them from here.
export { stallGapMs, eventLagMs } from "./stall-guard.mjs";

// ---- entry freshness (revision 6) --------------------------------------------------------------
// A stream event 1–30 s old is not dropped (SHADOW_LATE_SEC keeps it for fill / price / exits),
// but it must not OPEN a position: its price can be from before a crash that already happened on
// chain (HZfcyx…: opened 20 s late at the pre-crash price, then a fake "-90% SL"). The live bot
// re-reads the curve before buying, so it would never have bought at that price.
//
// SHADOW_ENTRY_MAX_LAG_SEC -> milliseconds; unset / "" = 5 s, 0 (or a negative / non-number) = off.
export function entryMaxLagMs(raw, defSec = 5) {
  const sec = raw === undefined || raw === null || raw === "" ? defSec : Number(raw);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

// May an event with this lag open a position? Strictly more than the limit is too late; 0 = off.
export function entryTooLate(lagMs, maxLagMs) {
  return maxLagMs > 0 && lagMs > maxLagMs;
}

// Exit rule: take-profit, stop-loss, timeout — in that order, as before.
export function exitReason({ ratio, tp = 1.5, sl, heldMs, holdMs }) {
  if (ratio >= tp) return "tp";
  if (ratio <= sl) return "sl";
  if (heldMs >= holdMs) return "timeout";
  return null;
}

// Tokens the paper position holds, for pricing an exit on PumpSwap after the curve completed.
//
// This is the curve's constant product for `buySol` WITHOUT pump's 1% buy fee (lib/pumpfun.mjs
// calcBuyTokens takes the fee off first). On purpose: the cost model charges that 1% itself
// (pessimisticRoundTrip, buy side "as before"), so pricing fee-net tokens AND charging the fee
// would count it twice. The curve exits of this lab work the same way: a gross price ratio, fees
// in the cost model.
export function ammEntryTokens({ virtualSolReserves, virtualTokenReserves }, buySol) {
  const lamports = BigInt(Math.round(Number(buySol) * 1e9));
  if (lamports <= 0n || !(virtualSolReserves > 0n) || !(virtualTokenReserves > 0n)) return 0n;
  return (BigInt(virtualTokenReserves) * lamports) / (BigInt(virtualSolReserves) + lamports);
}

// ratio of an AMM exit: what the pool pays for the position (after the pool's own fees) over the
// buy size. TP / SL / timeout of a migrated position are checked against it.
export function ammRatio(solOutLamports, buySol) {
  const buy = Number(buySol) * 1e9;
  return buy > 0 ? Number(solOutLamports) / buy : 0;
}

const round = (x, p) => Math.round(x * p) / p;

// gshadow_open row. `lagMs`: age of the stream event that triggered the entry (lagSec, one
// decimal; null when the caller did not know it). `feat`: revision-7 features of that moment
// (lib/gshadow-features.mjs buildFeatures), null when not collected — always present, last.
export function openRow({ variantId, v, mint, fill, holders, spot, buySol, tokens, gainPp = null, lagMs = null, feat = null }) {
  return {
    type: "gshadow_open",
    costsScheme: SHADOW_COSTS_SCHEME,
    shadowRev: SHADOW_REV,
    variant: variantId,
    label: v.label,
    mint,
    fill,
    holders,
    lagSec: lagMs !== null && Number.isFinite(lagMs) ? round(lagMs / 1000, 10) : null,
    entryPrice: spot,
    spot,
    slipBps: 50 + sizeSlippageBps(buySol),
    buySol,
    tokens: tokens.toString(),
    ...(v.momentum && gainPp !== null ? { gainPp: round(gainPp, 100) } : {}),
    ...(v.journalParams ? { params: variantParams(v) } : {}),
    feat: feat ?? null,
  };
}

// gshadow_trade row. One builder for the kinds of exit:
//   venue "curve"        price from the curve stream; pump 1% in + 1% out (as in v3)
//   venue "amm"          the curve completed; `amm` = { solOut (lamports), feeBps, feeSource, ageMs }
//                        from the pool quote. ratio = solOut / buySol, no pump sell fee.
//                        ammFeeSource "fallback" = the pool's fee tier could not be read and the
//                        quote assumed the most expensive one (the row is slightly pessimistic)
//   venue "amm-unpriced" the curve completed and the pool could not be priced: the trade is kept
//                        (a missing row would hide the position) but carries NO result —
//                        netSol / netPct / ratio null, unconfirmed true. Never the frozen curve price.
//   venue "curve-unpriced" the same "no result" row for a position that was still on the curve: its
//                        timeout was noticed too late (closeDecision `late`), so the stream price at
//                        hand is not the price it would have been sold at. migrated false.
// `extra` is merged last-but-accounting: it can add flags, never overwrite the numbers.
export function tradeRow({ pos, v, reason, venue, price = null, amm = null, buySol, now, extra = {}, rng }) {
  const base = {
    type: "gshadow_trade",
    costsScheme: SHADOW_COSTS_SCHEME,
    shadowRev: SHADOW_REV,
    variant: pos.variant,
    mint: pos.mint,
    entryPrice: pos.entryPrice,
  };
  const tail = {
    holdSec: Math.round((now - pos.at) / 1000),
    reason,
    buySol,
    ...(v?.journalParams ? { params: variantParams(v) } : {}),
  };
  if (venue === "amm-unpriced" || venue === "curve-unpriced") {
    return {
      ...base,
      exitPrice: null,
      ratio: null,
      ...tail,
      ...extra,
      netSol: null,
      netPct: null,
      exitVenue: venue,
      migrated: venue === "amm-unpriced",
      unconfirmed: true,
      tokens: String(pos.tokens ?? ""),
    };
  }
  const isAmm = venue === "amm";
  const ratio = isAmm ? ammRatio(amm.solOut, buySol) : price / pos.entryPrice;
  const rt = pessimisticRoundTrip({ buySol, ratio, exitVenue: isAmm ? "amm" : "curve", ...(rng ? { rng } : {}) });
  return {
    ...base,
    exitPrice: isAmm ? null : price,
    ratio: round(ratio, 1e6),
    ...tail,
    ...extra,
    netSol: round(rt.netPnl, 1e9),
    netPct: round((rt.netPnl / buySol) * 100, 100),
    slipBps: rt.slipBps,
    delayMs: rt.delayMs,
    exitVenue: isAmm ? "amm" : "curve",
    migrated: isAmm,
    ...(isAmm
      ? { ammSolOut: Number(amm.solOut) / 1e9, ammFeeBps: amm.feeBps ?? null, ammFeeSource: amm.feeSource ?? null, ammQuoteAgeMs: amm.ageMs ?? null, tokens: String(pos.tokens ?? "") }
      : {}),
  };
}
