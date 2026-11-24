// Copy-trader position size (human decision 2026-11-24). Pure: no RPC, no clock.
//
// COPY_SIZE_MODE
//   fixed         (default) every copy buy is COPY_BUY_SOL, as before
//   proportional  the copy buy is the SAME SHARE of our wallet that the target spent of its wallet:
//                   fraction = target's SOL into the buy / target's SOL balance before the buy
//                   buySol   = fraction x (our SOL balance - COPY_RESERVE_SOL)
//                 The target's balance before the buy = its balance read right after the trade + the
//                 SOL it put in (the trade event's sol amount; its fees are ignored, a few thousandths).
//                 Example: the target holds 10 SOL and buys for 1 SOL -> fraction 10 % -> with 0.5 SOL
//                 in our wallet (reserve 0.01) we buy 0.049 SOL.
// COPY_RESERVE_SOL (0.01) stays in our wallet for network fees and token-account rent.
// COPY_MIN_BUY_SOL (0.005): a smaller proportional buy is skipped (the fixed costs of a round trip
// would eat it). The trade guard (MAX_TRADE_SOL / MAX_SESSION_SOL) still checks every buy unchanged.

export const SIZE_MODES = ["fixed", "proportional"];

export function parseSizeEnv(env, numOr) {
  const mode = env.COPY_SIZE_MODE === undefined || env.COPY_SIZE_MODE === "" ? "fixed" : env.COPY_SIZE_MODE;
  if (!SIZE_MODES.includes(mode)) throw new Error(`COPY_SIZE_MODE must be fixed or proportional (got "${env.COPY_SIZE_MODE}")`);
  const reserveSol = numOr(env.COPY_RESERVE_SOL, 0.01, "COPY_RESERVE_SOL");
  const minBuySol = numOr(env.COPY_MIN_BUY_SOL, 0.005, "COPY_MIN_BUY_SOL");
  if (reserveSol < 0) throw new Error(`COPY_RESERVE_SOL must be >= 0 (got ${reserveSol})`);
  if (minBuySol < 0) throw new Error(`COPY_MIN_BUY_SOL must be >= 0 (got ${minBuySol})`);
  return { mode, reserveSol, minBuySol };
}

const r9 = (x) => Math.round(x * 1e9) / 1e9;

// -> { ok: true, buySol, fraction } or { ok: false, reason }
export function proportionalBuySol({ targetSpentSol, targetBalanceAfterSol, ourBalanceSol, reserveSol = 0.01, minBuySol = 0.005 }) {
  const spent = Number(targetSpentSol);
  const after = Number(targetBalanceAfterSol);
  const ours = Number(ourBalanceSol);
  if (!(Number.isFinite(spent) && spent > 0)) return { ok: false, reason: `target buy amount unknown (${targetSpentSol})` };
  if (!(Number.isFinite(after) && after >= 0)) return { ok: false, reason: "target balance unknown" };
  if (!(Number.isFinite(ours) && ours >= 0)) return { ok: false, reason: "our balance unknown" };
  const before = after + spent;
  const fraction = Math.min(1, spent / before);
  const usable = Math.max(0, ours - reserveSol);
  const buySol = r9(fraction * usable);
  if (buySol < minBuySol) return { ok: false, fraction, buySol, reason: `proportional buy ${buySol} SOL (${(fraction * 100).toFixed(2)} % of ${r9(usable)} SOL) is below COPY_MIN_BUY_SOL ${minBuySol}` };
  return { ok: true, buySol, fraction };
}
