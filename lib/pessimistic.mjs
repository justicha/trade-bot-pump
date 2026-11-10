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
export function pessimisticRoundTrip({ buySol, ratio, delayMs = null, bpsPerSol = 200, rng = Math.random } = {}) {
  const d = delayMs ?? executionDelay({ rng });
  const slipBps = DEFAULT_SLIPPAGE_ASSUMED_BPS + sizeSlippageBps(buySol, { bpsPerSol });
  const costs = roundTripCosts({ buySol, ratio, slippageBps: slipBps });
  return { delayMs: d, slipBps, ...costs };
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
