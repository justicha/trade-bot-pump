// Cost model for paper (dry-run) accounting: what a round trip actually costs.
//
// Without this the session report showed a +1.6% "profit" that is inside the noise: pump.fun
// takes 1% on the way in AND 1% on the way out, every transaction pays a base fee plus the
// priority fee, and the fill is worse than the curve mid price by some slippage.
//
// Every number here is a stated assumption, not a promise: SLIPPAGE_ASSUMED_BPS defaults to
// 50 (0.5% adverse per leg) and can be set in .env.
import { CU_LIMIT, CU_PRICE } from "./config.mjs";

export const PUMP_FEE_BPS = 100; // pump.fun: 1% on buy input and 1% on sell proceeds
export const BASE_TX_FEE_LAMPORTS = 5000; // one signature, 5000 lamports
export const DEFAULT_SLIPPAGE_ASSUMED_BPS = Number(process.env.SLIPPAGE_ASSUMED_BPS ?? 50);

// Version of the cost model that produces costsSol / pnlSol. Written into every journal line so
// that a journal spanning a change in the model never mixes epochs silently. Bump it whenever the
// arithmetic below changes (fees, tx cost, slippage assumption).
export const COSTS_SCHEME = "v2: pump 100+100 bps, tx=5000+priority, slip=assumed(50 bps default)";

export function priorityFeeLamports({ cuPrice = CU_PRICE, cuLimit = CU_LIMIT } = {}) {
  return Math.ceil((Number(cuPrice) * Number(cuLimit)) / 1e6);
}

// Base network fee + priority fee for ONE transaction, in SOL.
export function txCostSol(opts = {}) {
  return (BASE_TX_FEE_LAMPORTS + priorityFeeLamports(opts)) / 1e9;
}

const bps = (x, b) => (x * b) / 10_000;

// Cost of a round trip (buy then sell) for a paper trade.
//   buySol : SOL put into the buy
//   ratio  : exit price / entry price from the curve (the "gross" multiple, already including
//            the curve's own price impact)
// Returns every component so the report can show where the money went.
export function roundTripCosts({
  buySol,
  ratio,
  pumpFeeBps = PUMP_FEE_BPS,
  slippageBps = DEFAULT_SLIPPAGE_ASSUMED_BPS,
  txSol = txCostSol(),
  legs = 2,
} = {}) {
  const grossOut = buySol * ratio;
  const buyFee = bps(buySol, pumpFeeBps);
  const sellFee = bps(grossOut, pumpFeeBps);
  const buySlip = bps(buySol, slippageBps);
  const sellSlip = bps(grossOut, slippageBps);
  const txs = txSol * legs;

  const feeSol = buyFee + sellFee;
  const slipSol = buySlip + sellSlip;
  const netPnl = grossOut - buySol - feeSol - slipSol - txs;

  return {
    grossPnl: grossOut - buySol,
    feeSol,
    slipSol,
    txSol: txs,
    costSol: feeSol + slipSol + txs,
    netPnl,
    // Effective multiple after all costs (used for "return %" in the replay).
    netRatio: buySol > 0 ? (buySol + netPnl) / buySol : 1,
  };
}

// Same, for a partial exit: only the sold part pays the sell-side costs.
export function partialExitCosts({ sellSol, tokenShare, pumpFeeBps = PUMP_FEE_BPS, slippageBps = DEFAULT_SLIPPAGE_ASSUMED_BPS }) {
  const feeSol = bps(sellSol, pumpFeeBps);
  const slipSol = bps(sellSol, slippageBps);
  const txSol = txCostSol();
  return { feeSol, slipSol, txSol, costSol: feeSol + slipSol + txSol, netSol: sellSol - feeSol - slipSol - txSol, tokenShare };
}
