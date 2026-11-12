// Pessimistic execution model (step 5): a paper trade is assumed to fill on the NEXT tick, i.e.
// 200-800 ms after the decision (plus a slot), with size-dependent adverse slippage on top of the
// curve's own price impact, and the full costs (pump 1% in + 1% out, priority fee, tx fee).
//
// Two modes are always computed so a report can show both:
//   - optimistic: the cost model used elsewhere (roundTripCosts, 50 bps assumed slippage).
//   - pessimistic: next-tick delay + size-dependent slippage + full costs.
import { roundTripCosts, txCostSol, DEFAULT_SLIPPAGE_ASSUMED_BPS, PUMP_FEE_BPS, priorityFeeLamports, BASE_TX_FEE_LAMPORTS } from "./fees.mjs";

export const DELAY_MIN_MS = 200;
export const DELAY_MAX_MS = 800;

// Accounting scheme of the shadow lab's entry/exit model, journaled on every gshadow_open /
// gshadow_trade so a report never averages two epochs.
//   v3-single-slip: the entry price IS the curve spot and the ONE buy-slippage charge comes from
//     roundTripCosts below. v2-era lines moved entryPrice up by the same bps AND let the cost model
//     subtract buySlip again, so every ratio was depressed by ~0.54%: a flat round trip booked
//     ratio 0.994629 / netPct -8.16% instead of ratio 1 / -7.63%.
//   v4-amm-exit (2026-11-12): curve exits are computed exactly as in v3-single-slip. NEW: a
//     position whose curve completed is priced from the PumpSwap pool quote (exitVenue "amm") —
//     ratio = quote / buySol, AMM fees already inside the quote, so NO pump sell fee is charged;
//     without a quote the trade is journaled unpriced (exitVenue "amm-unpriced", netSol null)
//     instead of at the frozen last curve price. Also new: per-variant minFill / sl / holdSec and
//     variant J (the live graduation config). v3 rows of migrated mints are overstated; never mix.
export const SHADOW_COSTS_SCHEME = "v4-amm-exit: v3-single-slip for curve exits; migrated positions priced from the PumpSwap quote without a pump sell fee (or journaled unpriced)";

// Additional adverse slippage (bps) from the order size: a larger order moves the price more.
export function sizeSlippageBps(buySol, { bpsPerSol = 200 } = {}) {
  return Math.round(Number(buySol || 0) * bpsPerSol);
}

// Simulate the execution latency + the slot the fill lands on.
export function executionDelay({ rng = Math.random, delayMinMs = DELAY_MIN_MS, delayMaxMs = DELAY_MAX_MS } = {}) {
  return Math.round(delayMinMs + rng() * (delayMaxMs - delayMinMs));
}

// Pessimistic round trip for one trade. `delayMs` is the simulated next-tick latency and is
// REPORTED for fill timing only — the PnL math uses the assumed slippage plus the size-dependent
// component (execution latency itself is applied separately by lib/strategy.mjs, not here).
//   exitVenue "curve" (default): pump 1% on the buy AND 1% on the sell, as before.
//   exitVenue "amm": the exit is a PumpSwap quote, already net of the pool's lp+protocol+creator
//     fees — so no pump sell fee. The buy side (pump 1% in, slippage, two network fees) is the same.
export function pessimisticRoundTrip({ buySol, ratio, delayMs = null, bpsPerSol = 200, rng = Math.random, exitVenue = "curve" } = {}) {
  const d = delayMs ?? executionDelay({ rng });
  const slipBps = DEFAULT_SLIPPAGE_ASSUMED_BPS + sizeSlippageBps(buySol, { bpsPerSol });
  const costs = roundTripCosts({ buySol, ratio, slippageBps: slipBps, ...(exitVenue === "amm" ? { sellFeeBps: 0 } : {}) });
  return { delayMs: d, slipBps, exitVenue, ...costs };
}

// Both modes side by side, so a consumer never has to recompute the assumptions by hand.
export function bothModes({ buySol, ratio, bpsPerSol = 200, rng = Math.random } = {}) {
  const optimistic = roundTripCosts({ buySol, ratio });
  const pessimistic = pessimisticRoundTrip({ buySol, ratio, bpsPerSol, rng });
  return {
    optimistic: { netPnl: optimistic.netPnl, slipBps: DEFAULT_SLIPPAGE_ASSUMED_BPS },
    pessimistic: { netPnl: pessimistic.netPnl, slipBps: pessimistic.slipBps, delayMs: pessimistic.delayMs },
  };
}

// Aggregate both modes over a list of trades ({ buySol, ratio }), returning netPct totals.
export function bothModesSummary(trades, opts = {}) {
  let optNet = 0;
  let pesNet = 0;
  let buyTotal = 0;
  for (const t of trades) {
    const buySol = Number(t.buySol || 0);
    const ratio = Number(t.ratio || 1);
    if (buySol <= 0) continue;
    const { optimistic, pessimistic } = bothModes({ buySol, ratio, ...opts });
    optNet += optimistic.netPnl;
    pesNet += pessimistic.netPnl;
    buyTotal += buySol;
  }
  const pct = (net) => (buyTotal > 0 ? (net / buyTotal) * 100 : null);
  return {
    n: trades.length,
    optimisticNetSol: Math.round(optNet * 1e9) / 1e9,
    pessimisticNetSol: Math.round(pesNet * 1e9) / 1e9,
    optimisticNetPct: pct(optNet) === null ? null : Math.round(pct(optNet) * 100) / 100,
    pessimisticNetPct: pct(pesNet) === null ? null : Math.round(pct(pesNet) * 100) / 100,
    // cost components, for visibility into what changed
    pumpFeeBps: PUMP_FEE_BPS,
    priorityFeeSol: txCostSol() - BASE_TX_FEE_LAMPORTS / 1e9,
  };
}
