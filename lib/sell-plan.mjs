// Sell planning for a curve whose REAL SOL reserves cannot cover the whole position.
//
// Fact behind it: selling 100% of a position failed 40+ times with Custom 6024 (Overflow) while
// a manual 75% sell went through. FMosXPu8L1cm: quote 0.0509 SOL vs realSolReserves 0.000786 —
// the program computes fees against reserves it cannot pay from, and overflows instead of
// failing cleanly. The fix is to never send a sell whose payout exceeds the real reserves,
// splitting the position into parts that fit and re-reading the curve between parts.
//
// Ordering: the solver is offline; every part is simulated against the state the previous part
// would leave, so the real send must re-read the curve (the caller does that per cycle).
import { calcSellQuote } from "./pumpfun.mjs";

// How much of the position the reserves can pay: net out <= realSolReserves * capRatio.
export function maxSellableRaw(state, { capRatio = 0.95 } = {}) {
  const cap = (state.realSolReserves * BigInt(Math.round(capRatio * 10000))) / 10000n;
  if (cap <= 0n) return 0n;
  if (BigInt(state.virtualTokenReserves) <= 0n) return 0n;
  // Binary search on the token amount (monotone: more tokens -> larger gross).
  let lo = 0n;
  let hi = state.virtualTokenReserves;
  for (let i = 0; i < 64 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    const { net } = calcSellQuote(state, mid);
    if (net <= cap) lo = mid;
    else hi = mid;
  }
  return lo;
}

// State after selling `amountRaw` into the curve (what the next part would see).
export function stepSellState(state, amountRaw) {
  const { gross } = calcSellQuote(state, amountRaw);
  return {
    ...state,
    virtualSolReserves: state.virtualSolReserves - gross,
    virtualTokenReserves: state.virtualTokenReserves + amountRaw,
    realSolReserves: state.realSolReserves - gross,
    realTokenReserves: state.realTokenReserves + amountRaw,
  };
}

// Split `balanceRaw` into parts that the curve can pay, plus the remainder it cannot.
// Returns { parts: [{amountRaw, quoteOut, gross}], restRaw, reason }.
export function planSellParts(state, balanceRaw, { capRatio = 0.95, minPartRaw = 1_000_000n, maxParts = 12 } = {}) {
  const parts = [];
  let remaining = balanceRaw;
  let s = state;
  for (let i = 0; i < maxParts && remaining > 0n; i++) {
    const fit = maxSellableRaw(s, { capRatio });
    const amountRaw = fit < remaining ? fit : remaining;
    if (amountRaw < minPartRaw) {
      return {
        parts,
        restRaw: remaining,
        reason: parts.length ? "curve drained for the remainder" : "curve cannot pay even the minimum part",
      };
    }
    const q = calcSellQuote(s, amountRaw);
    parts.push({ amountRaw, quoteOut: q.net, gross: q.gross });
    s = stepSellState(s, amountRaw);
    remaining -= amountRaw;
  }
  return { parts, restRaw: remaining, reason: remaining > 0n ? "part limit reached" : null };
}
