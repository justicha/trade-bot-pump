// Task C, item 5: the price/cost model on synthetic trajectories.
//
// These are the numbers every journal metric depends on, so they are pinned here:
//   * the launch (floor) price of a standard pump.fun curve in RAW units
//   * what checkCurve accepts and refuses (floor / ceiling / price anomalies)
//   * TP and SL firing at the right ratio, with the costs of a round trip
//   * slippage monotonicity and the exact fee arithmetic
import { metricsOf, curvePrice, checkCurve, CURVE_BOUNDS, rawSolPerTokenToWhole, RAW_TO_WHOLE } from "../lib/curve.mjs";
import { getPrice } from "../lib/pumpfun.mjs";
import { roundTripCosts, PUMP_FEE_BPS, txCostSol } from "../lib/fees.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// ---- launch / floor price ----------------------------------------------------
{
  const launch = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n };
  const rawPrice = getPrice(launch); // SOL per RAW unit — what the journal stores as entrySol
  asrt(near(rawPrice, 2.7959e-5, 1e-3), `launch RAW price ~2.796e-5, got ${rawPrice}`);
  const whole = curvePrice(launch); // SOL per WHOLE token
  asrt(near(whole, 2.7959e-8, 1e-3), `launch price per whole token ~2.796e-8, got ${whole}`);
  asrt(near(rawSolPerTokenToWhole(rawPrice), whole, 1e-9), "rawSolPerTokenToWhole() == curvePrice() for the launch state");
  asrt(RAW_TO_WHOLE === 1e-3, "the raw->whole factor is 1e-3");
  const m = metricsOf(launch);
  asrt(near(m.tokensPerSol, 1.073e9 / 30, 1e-9), `tokensPerSol = 1.073e9/30, got ${m.tokensPerSol}`);
}

// ---- what the filter accepts and refuses -------------------------------------
{
  const launch = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, complete: false };
  asrt(checkCurve(launch).ok, "a pristine launch curve passes");

  const belowFloor = { virtualSolReserves: 9_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, complete: false };
  const r1 = checkCurve(belowFloor);
  asrt(!r1.ok && /below the 10 SOL floor/.test(r1.reason), "9 SOL virtual is refused by the floor: " + r1.reason);

  const aboveCeiling = { virtualSolReserves: 1_428_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, complete: false };
  const r2 = checkCurve(aboveCeiling);
  asrt(!r2.ok && /above the ceiling/.test(r2.reason), "1428 SOL virtual is refused by the ceiling: " + r2.reason);

  const complete = { ...launch, complete: true };
  asrt(!checkCurve(complete).ok, "a complete curve is refused");

  const zeroTok = { virtualSolReserves: 30_000_000_000n, virtualTokenReserves: 0n, complete: false };
  asrt(!checkCurve(zeroTok).ok, "zero token reserves are refused");
  asrt(CURVE_BOUNDS.vSolMin === 10e9 && CURVE_BOUNDS.vSolMax === 1_000e9, "bounds are 10..1000 SOL of virtual SOL");
}

// ---- TP / SL on a synthetic ratio path ---------------------------------------
{
  const TP = 2.0;
  const SL = 0.5;
  const path = [1.0, 1.15, 1.4, 1.9, 2.05, 1.2, 0.9, 0.49];
  const firstTp = path.find((r) => r >= TP);
  const firstSl = path.find((r) => r <= SL);
  asrt(firstTp === 2.05, `TP fires at the first ratio >= 2.0, got ${firstTp}`);
  asrt(firstSl === 0.49, `SL fires at the first ratio <= 0.5, got ${firstSl}`);
  // the TP comes first on this path, so the trade must be a take-profit, not a stop-loss
  asrt(path.indexOf(firstTp) < path.indexOf(firstSl), "on this path TP is reached before SL");
}

// ---- costs and slippage ------------------------------------------------------
{
  const buySol = 0.02;
  const ratio = 2;
  const c = roundTripCosts({ buySol, ratio, slippageBps: 100, txSol: 0.0002 });
  const grossOut = buySol * ratio; // 0.04
  const fee = (buySol * PUMP_FEE_BPS) / 1e4 + (grossOut * PUMP_FEE_BPS) / 1e4; // 1% in + 1% out
  const slip = (buySol * 100) / 1e4 + (grossOut * 100) / 1e4; // 1% each leg
  const txs = 0.0002 * 2;
  asrt(near(c.feeSol, fee), `fee = 1% in + 1% out, got ${c.feeSol} vs ${fee}`);
  asrt(near(c.slipSol, slip), `slippage = 1% each leg, got ${c.slipSol} vs ${slip}`);
  asrt(near(c.txSol, txs), `tx cost = 2 legs, got ${c.txSol}`);
  asrt(near(c.costSol, fee + slip + txs), `costSol sums the parts, got ${c.costSol}`);
  asrt(near(c.netPnl, grossOut - buySol - fee - slip - txs), `netPnl subtracts everything, got ${c.netPnl}`);
  asrt(c.netPnl < grossOut - buySol, "net is smaller than gross");

  // monotone in slippage
  const nets = [50, 100, 200].map((bps) => roundTripCosts({ buySol, ratio, slippageBps: bps, txSol: 0.0002 }).netPnl);
  asrt(nets[0] > nets[1] && nets[1] > nets[2], `netPnl decreases with slippage: ${nets.join(" > ")}`);

  // a break-even gross ratio must be > 1 because of the fees
  const be = roundTripCosts({ buySol, ratio: 1, slippageBps: 50, txSol: 0.0002 });
  asrt(be.netPnl < 0, `ratio 1.0 is a loss after costs, got ${be.netPnl}`);
  asrt(txCostSol({ cuPrice: 0, cuLimit: 0 }) > 0, "even with zero priority fee a tx costs the base fee");
}

// ---- entry premium (what the journal stores) --------------------------------
{
  const LAUNCH_RAW = 30e9 / 1.073e15;
  const premium = (entryRaw) => entryRaw / LAUNCH_RAW - 1;
  asrt(near(premium(LAUNCH_RAW), 0, 1e-12), "an entry at the launch price has premium 0");
  asrt(near(premium(LAUNCH_RAW * 1.2), 0.2, 1e-12), "1.2x the launch price is premium 20%");
  asrt(premium(LAUNCH_RAW * 0.5) < 0, "an entry below the launch price has a negative premium");
}

console.log("PASS: launch price, checkCurve floors/ceilings, TP/SL triggers, costs, slippage and premium behave");
