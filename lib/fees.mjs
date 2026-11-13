// Cost model for paper (dry-run) accounting: what a round trip actually costs.
//
// Without this the session report showed a +1.6% "profit" that is inside the noise: pump.fun
// takes 1% on the way in AND 1% on the way out, every transaction pays a base fee plus the
// priority fee, and the fill is worse than the curve mid price by some slippage.
//
// Every number here is a stated assumption, not a promise: SLIPPAGE_ASSUMED_BPS defaults to
// 50 (0.5% adverse per leg) and can be set in .env.
import { AMM_SELL_CU_LIMIT, CU_LIMIT, CU_PRICE, numOr } from "./config.mjs";

export const PUMP_FEE_BPS = 100; // pump.fun: 1% on buy input and 1% on sell proceeds
export const BASE_TX_FEE_LAMPORTS = 5000; // one signature, 5000 lamports
export const DEFAULT_SLIPPAGE_ASSUMED_BPS = numOr(process.env.SLIPPAGE_ASSUMED_BPS, 50, "SLIPPAGE_ASSUMED_BPS");

// Version of the cost model that produces costsSol / pnlSol. Written into every journal line so
// that a journal spanning a change in the model never mixes epochs silently. Bump it whenever the
// arithmetic below changes (fees, tx cost, slippage assumption).
//
// v2.1 (2026-11-11): the DRY model is unchanged; LIVE rows are now actuals — pnlSol = received -
// actual entry (no estimated tx/slip subtracted), costsSol = real network fees of both legs,
// entry excludes the token-ATA rent (journaled as ataRentSol), STUCK rows carry an assumed loss.
// The "v2" prefix is kept on purpose: lib/journal.mjs splitByScheme, scripts/recheck-baseline.mjs
// and scripts/analyze-journal.mjs select rows with startsWith("v2"); any other prefix would file
// every new row (dry ones included) under the legacy "v1" bucket and silently exclude it.
// v2.2 (2026-11-12): live pnlSol is net of BOTH network fees (buy + sell); graduation-sniper and
// copy-trader live sales are computed from actuals like the sniper (lib/live-pnl.mjs). DRY unchanged.
// v2.3 (2026-11-12): dry graduation-sniper only — an exit after migration is priced from the
// PumpSwap pool quote (not the frozen curve price), and the pump fees are no longer charged twice
// (the exit ratio is already net of them, see netRatioExitCosts). Sniper / copy-trader dry and
// every live row: unchanged.
// v2.4 (2026-11-13): dry graduation-sniper only — the PumpSwap quote that prices an exit after
// migration subtracts the pool's real fee tier (125 / 120 bps, lib/pumpswap.mjs) instead of
// GlobalConfig's 30 bps: v2.3 rows of that kind are overstated by ~0.95% of the proceeds; and the
// network cost of that exit is estimated with AMM_SELL_CU_LIMIT (the limit the AMM sell really
// requests) instead of CU_LIMIT. Curve exits, sniper / copy-trader dry and every live row
// (actuals) are the same as in v2.3.
export const COSTS_SCHEME = "v2.4: dry = pump 100+100 bps, tx=5000+priority, slip=assumed(50 bps default), graduation dry exit ratio is fee-net (AMM quote after migration at the pool's real fee tier, AMM sell tx at AMM_SELL_CU_LIMIT, no double pump fee); live = actuals, pnlSol net of both network fees, slip=0, ATA rent separate";

export function priorityFeeLamports({ cuPrice = CU_PRICE, cuLimit = CU_LIMIT } = {}) {
  return Math.ceil((Number(cuPrice) * Number(cuLimit)) / 1e6);
}

// Base network fee + priority fee for ONE transaction, in SOL.
export function txCostSol(opts = {}) {
  return (BASE_TX_FEE_LAMPORTS + priorityFeeLamports(opts)) / 1e9;
}

// The same for the PumpSwap (AMM) sell transaction, which requests AMM_SELL_CU_LIMIT instead of
// CU_LIMIT. An ESTIMATE for paper trades and for a live sale whose meta cannot be read; a live
// sale that is read from the chain books its actual fee and never this.
export function ammSellTxCostSol(opts = {}) {
  return txCostSol({ cuLimit: AMM_SELL_CU_LIMIT, ...opts });
}

const bps = (x, b) => (x * b) / 10_000;

// Cost of a round trip (buy then sell) for a paper trade.
//   buySol : SOL put into the buy
//   ratio  : exit price / entry price from the curve (the "gross" multiple, already including
//            the curve's own price impact)
//   sellFeeBps : venue fee charged on the proceeds; defaults to pumpFeeBps (a curve sell). Pass 0
//            when the proceeds are already net of the venue's fee (a PumpSwap quote).
//   sellTxSol : network cost of the LAST leg when it differs from the others (a PumpSwap sell has
//            its own CU limit: ammSellTxCostSol()). Default: every leg costs txSol.
// Returns every component so the report can show where the money went.
export function roundTripCosts({
  buySol,
  ratio,
  pumpFeeBps = PUMP_FEE_BPS,
  sellFeeBps = pumpFeeBps,
  slippageBps = DEFAULT_SLIPPAGE_ASSUMED_BPS,
  txSol = txCostSol(),
  legs = 2,
  sellTxSol = null,
} = {}) {
  const grossOut = buySol * ratio;
  const buyFee = bps(buySol, pumpFeeBps);
  const sellFee = bps(grossOut, sellFeeBps);
  const buySlip = bps(buySol, slippageBps);
  const sellSlip = bps(grossOut, slippageBps);
  const txs = sellTxSol == null ? txSol * legs : txSol * (legs - 1) + sellTxSol;

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

// Costs of a paper exit whose `ratio` is ALREADY net of the venue fees: proceeds after the sell
// fee divided by the full entry (tokens bought after the buy fee). That is what the graduation dry
// run has — calcSellSol(tokens) / BUY_SOL on the curve, PumpSwap quote / BUY_SOL after migration.
// Charging the pump 1% + 1% on top of such a ratio counted the fees twice (about -2% per trade).
// Only the assumed slippage and the two network fees are added.
//   pnlSol      result before those costs (what the bot books as the trade's gross pnl)
//   costs       roundTripCosts(...) with no venue fee; costs.netPnl = pnlSol - slip - tx
//   venue "pumpswap": the sell leg is the AMM transaction (AMM_SELL_CU_LIMIT, not CU_LIMIT).
export function netRatioExitCosts({ entrySol, ratio, slippageBps = DEFAULT_SLIPPAGE_ASSUMED_BPS, venue = "curve" } = {}) {
  const costs = roundTripCosts({ buySol: entrySol, ratio, pumpFeeBps: 0, slippageBps, ...(venue === "pumpswap" ? { sellTxSol: ammSellTxCostSol() } : {}) });
  return { pnlSol: entrySol * (ratio - 1), receivedSol: entrySol * ratio, costs };
}

// Same, for a partial exit: only the sold part pays the sell-side costs.
export function partialExitCosts({ sellSol, tokenShare, pumpFeeBps = PUMP_FEE_BPS, slippageBps = DEFAULT_SLIPPAGE_ASSUMED_BPS }) {
  const feeSol = bps(sellSol, pumpFeeBps);
  const slipSol = bps(sellSol, slippageBps);
  const txSol = txCostSol();
  return { feeSol, slipSol, txSol, costSol: feeSol + slipSol + txSol, netSol: sellSol - feeSol - slipSol - txSol, tokenShare };
}
