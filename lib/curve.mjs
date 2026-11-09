// Bonding-curve math + plausibility checks (pure, no RPC).
//
// Why this exists: the dry-run log showed buys of "0.02 SOL -> ~405-801 million tokens" next to
// the normal ~700k. A pump.fun curve starts at 30 SOL virtual / 1.073e9 tokens and only ever
// ADDS real SOL, so virtualSolReserves can never drop below the 30 SOL floor and the price can
// never be 300-1000x cheaper than launch. Numbers like that mean the state we read was not a
// normal curve (wrong account, different mint decimals, already-migrated pool), and every
// token/PnL number computed from it is garbage. checkCurve() refuses such states instead of
// trading on them.
// Graduation fill, measured in REAL SOL reserves (lamports).
//
// Verified on-chain: a normal curve keeps virtualSolReserves = realSolReserves + 30 SOL
// (71.717 - 41.717 = 30.000) and graduates when REAL reserves reach 85 SOL, i.e. at ~115 SOL
// virtual. Dividing the VIRTUAL number by 85 therefore overstates the fill by ~35%: a "92%"
// reading is really ~56% real. Use this helper everywhere fill is reported or compared.
export const GRADUATION_REAL_SOL = 85;
export function gradFillPct(realSolReservesLamports) {
  return (Number(realSolReservesLamports) / (GRADUATION_REAL_SOL * 1e9)) * 100;
}

export const CURVE_BOUNDS = {
  vSolMin: 10e9, // lamports; the curve starts at 30 SOL of virtual reserves
  vSolMax: 1_000e9, // graduation happens near 85-115 SOL
  vTokMin: 1e13, // raw units (6 decimals) = 10M whole tokens
  vTokMax: 2e15, // 2B whole tokens
  // whole tokens bought per 1 SOL: launch ~35.7M, just before graduation ~7-9M,
  // a token that dumped 90% is ~350M. The band is wide on purpose.
  tokensPerSolMin: 500_000,
  tokensPerSolMax: 5_000_000_000,
  // SOL per WHOLE token: launch 2.8e-8, near graduation ~1e-7
  priceMin: 1e-10,
  priceMax: 1e-5,
};

const isPos = (x) => Number.isFinite(x) && x > 0;

// Reserves are raw units: 1 whole token = 1e6 raw, 1 SOL = 1e9 lamports.
// Everything exposed here is in WHOLE tokens and SOL — that is what a human (and a dollar
// price) means by "token price". The raw ratio vSol/vTok is 1000x larger than the real price
// per token, which is how "0.000028 SOL/tok" turned into a 1000x inflated dollar value.
export function curvePrice(state) {
  const m = metricsOf(state);
  return m ? m.price : null;
}

export function metricsOf(state) {
  if (!state) return null;
  const vSol = Number(state.virtualSolReserves);
  const vTok = Number(state.virtualTokenReserves);
  if (!isPos(vSol) || !isPos(vTok)) return null;
  const sol = vSol / 1e9; // SOL
  const whole = vTok / 1e6; // whole tokens
  return { sol, whole, price: sol / whole, tokensPerSol: whole / sol };
}

// Raw unit price -> price per WHOLE token: pump.fun prices a RAW unit (1e6 raw = 1 token,
// 1e9 lamports = 1 SOL), so SOL-per-raw * 1e-3 = SOL-per-whole-token. One constant + one function
// so the factor is never hand-written again (it produced 1000x price errors in the past).
export const RAW_TO_WHOLE = 1e-3;
export function rawSolPerTokenToWhole(rawPrice) {
  return rawPrice * RAW_TO_WHOLE;
}

// Raw token units received for `solAmount` SOL, with pump.fun's 1% buy fee.
// Same formula the bot uses to build the transaction (lib/pumpfun.mjs calcBuyTokens), which
// works in raw units — hence the raw result here and the /1e6 where it is displayed.
export function buyTokensFor(state, solAmount, feeBps = 100) {
  const vSol = Number(state.virtualSolReserves);
  const vTok = Number(state.virtualTokenReserves);
  const lamports = Math.floor(Number(solAmount) * 1e9);
  if (!isPos(vSol) || !isPos(vTok) || !isPos(lamports)) return null;
  const net = lamports - (lamports * feeBps) / 10_000;
  const out = (vTok * net) / (vSol + net);
  return Number.isFinite(out) ? out : null;
}

// Returns { ok, reason, price, tokensPerSol, tokensForBuy } — never throws.
// price = SOL per whole token, tokensPerSol = whole tokens per SOL.
export function checkCurve(state, { buySol = 0, bounds = CURVE_BOUNDS } = {}) {
  const fail = (reason, extra = {}) => ({
    ok: false,
    reason,
    price: extra.price ?? null,
    tokensPerSol: extra.tokensPerSol ?? null,
    tokensForBuy: extra.tokensForBuy ?? null,
  });

  const m = metricsOf(state);
  if (!m) return fail("no usable curve state");

  const vSol = Number(state.virtualSolReserves);
  const vTok = Number(state.virtualTokenReserves);
  const { price, tokensPerSol } = m;

  if (state.complete === true) return fail("curve already complete", { price, tokensPerSol });
  if (vSol < bounds.vSolMin) {
    return fail(`virtualSolReserves ${(vSol / 1e9).toFixed(6)} SOL below the ${bounds.vSolMin / 1e9} SOL floor`, { price, tokensPerSol });
  }
  if (vSol > bounds.vSolMax) return fail(`virtualSolReserves ${(vSol / 1e9).toFixed(0)} SOL above the ceiling`, { price, tokensPerSol });
  if (vTok < bounds.vTokMin) return fail(`virtualTokenReserves ${vTok.toExponential(3)} below the floor`, { price, tokensPerSol });
  if (vTok > bounds.vTokMax) return fail(`virtualTokenReserves ${vTok.toExponential(3)} above the ceiling`, { price, tokensPerSol });
  if (price < bounds.priceMin || price > bounds.priceMax) {
    return fail(`price anomaly: ${price.toExponential(3)} SOL/token outside the plausible band`, { price, tokensPerSol });
  }
  if (tokensPerSol < bounds.tokensPerSolMin || tokensPerSol > bounds.tokensPerSolMax) {
    return fail(`price anomaly: ${Math.round(tokensPerSol)} tokens/SOL outside the plausible band`, { price, tokensPerSol });
  }

  let tokensForBuy = null;
  if (buySol > 0) {
    tokensForBuy = buyTokensFor(state, buySol);
    if (!isPos(tokensForBuy)) return fail("cannot compute tokens for the buy amount", { price, tokensPerSol });
    const perSol = tokensForBuy / 1e6 / Number(buySol); // whole tokens per SOL
    if (perSol < bounds.tokensPerSolMin || perSol > bounds.tokensPerSolMax) {
      return fail(`price anomaly: the order would buy ${Math.round(perSol)} tokens/SOL`, { price, tokensPerSol, tokensForBuy });
    }
  }

  return { ok: true, reason: null, price, tokensPerSol, tokensForBuy };
}

