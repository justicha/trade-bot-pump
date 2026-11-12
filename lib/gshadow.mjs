// Pure logic of the graduation shadow lab (bots/graduation-sniper/shadow.mjs): the variant table,
// the entry / exit rules and the journal rows. No I/O here, so every number can be tested without
// a stream or an RPC.
import { pessimisticRoundTrip, sizeSlippageBps, SHADOW_COSTS_SCHEME } from "./pessimistic.mjs";

// The variant table.
//   minFill / sl / holdSec used to be lab-wide constants (MIN_FILL, SHADOW_SL, SHADOW_HOLD_SEC).
//   They are per-variant now so that J can run the LIVE band and exits next to A–I; A–I get
//   exactly the lab-wide values they always had.
//   J "live config": the band, the holder gate and the exits of bots/graduation-sniper
//   (lib/grad-config.mjs readGradStrategy). It is the only variant that answers "does the config I
//   actually run make money". Not mirrored: MAX_POSITIONS, the cooldown, the Mayhem / Token-2022
//   filters, the exit-ratio gate and the pre-buy simulation of the live bot.
export function buildVariants({ minFill, sl, holdSec, live }) {
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
  return variants;
}

export const activeVariantIds = (variants) => Object.keys(variants).filter((id) => !variants[id].postMigration);

// A mint becomes a candidate at the LOWEST minFill of the active variants: with one lab-wide
// threshold (92) variant J (e.g. 75–90) would never see its own band.
export function candidateThreshold(variants) {
  return Math.min(...activeVariantIds(variants).map((id) => variants[id].minFill));
}

// Entry filter of one variant (the holder count and the fill of the event being processed).
export function variantAccepts(v, { fill, holders }) {
  if (v.postMigration) return false;
  return fill >= v.minFill && fill <= v.maxFill && holders >= v.minHolders;
}

// The parameters a variant's rows were produced with (journaled for variant J).
export function variantParams(v) {
  return { minFill: v.minFill, maxFill: v.maxFill, minHolders: v.minHolders, tp: v.tp ?? 1.5, sl: v.sl, holdSec: v.holdSec };
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

// gshadow_open row.
export function openRow({ variantId, v, mint, fill, holders, spot, buySol, tokens }) {
  return {
    type: "gshadow_open",
    costsScheme: SHADOW_COSTS_SCHEME,
    variant: variantId,
    label: v.label,
    mint,
    fill,
    holders,
    entryPrice: spot,
    spot,
    slipBps: 50 + sizeSlippageBps(buySol),
    buySol,
    tokens: tokens.toString(),
    ...(v.journalParams ? { params: variantParams(v) } : {}),
  };
}

// gshadow_trade row. One builder for the three kinds of exit:
//   venue "curve"        price from the curve stream; pump 1% in + 1% out (as in v3)
//   venue "amm"          the curve completed; `amm` = { solOut (lamports), feeBps, ageMs } from the
//                        pool quote. ratio = solOut / buySol, no pump sell fee
//   venue "amm-unpriced" the curve completed and the pool could not be priced: the trade is kept
//                        (a missing row would hide the position) but carries NO result —
//                        netSol / netPct / ratio null, unconfirmed true. Never the frozen curve price.
// `extra` is merged last-but-accounting: it can add flags, never overwrite the numbers.
export function tradeRow({ pos, v, reason, venue, price = null, amm = null, buySol, now, extra = {}, rng }) {
  const base = {
    type: "gshadow_trade",
    costsScheme: SHADOW_COSTS_SCHEME,
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
  if (venue === "amm-unpriced") {
    return {
      ...base,
      exitPrice: null,
      ratio: null,
      ...tail,
      ...extra,
      netSol: null,
      netPct: null,
      exitVenue: "amm-unpriced",
      migrated: true,
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
      ? { ammSolOut: Number(amm.solOut) / 1e9, ammFeeBps: amm.feeBps ?? null, ammQuoteAgeMs: amm.ageMs ?? null, tokens: String(pos.tokens ?? "") }
      : {}),
  };
}
