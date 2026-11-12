// Pre-buy exit simulation for the bonding-curve path.
//
// The bot buys on the curve, so before it spends anything it asks the chain the only question that
// matters: "would selling what I am about to buy actually go through?"
//
// The first version simulated a SELL alone. The wallet holds no tokens before the buy, so the
// program always answered 6023 NotEnoughTokensToSell (`Left: 0`, `Right: <tokens>`) and the
// graduation bot never bought anything, dry or live. Creating the ATA first (commit 7e2b3d9) only
// changed the error from AccountNotInitialized to 6023.
//
// Now the simulated transaction is the BUY followed by the SELL of the same tokens (`buy` option).
// Instructions of one transaction run in order, so the sell sees the tokens the buy just delivered.
// Nothing is sent: the transaction is only simulated. The instruction bytes are the bot's own
// buyIx / sellIx, untouched.
//
// Dependencies are injectable so the decision can be tested without a chain.
import { PublicKey } from "@solana/web3.js";
import { CU_LIMIT } from "./config.mjs";
import { buyIx, calcSellSol, sellIx, userAtaIx } from "./pumpfun.mjs";
import { buildVersionedTx, computeBudgetIxs } from "./tx.mjs";
import { simulateTx } from "./exec.mjs";
import { describeTxError } from "./pump-errors.mjs";

// A dry run may hold no SOL at all: then a simulated buy fails on the BALANCE, which says nothing
// about the curve. Below maxSolCost + this margin (fees, ATA rent) the dry simulation is skipped.
export const DRY_SIM_BALANCE_MARGIN_SOL = 0.01;

// Curve state right after buying exactly `tokens` (constant product, SOL in rounded up). Used to
// quote the sell leg of the buy+sell simulation: the sell runs on the post-buy reserves.
export function stateAfterBuy(state, tokens) {
  const t = BigInt(tokens);
  if (t <= 0n || t >= state.virtualTokenReserves) return null;
  const solIn = (state.virtualSolReserves * t) / (state.virtualTokenReserves - t) + 1n;
  return {
    ...state,
    virtualSolReserves: state.virtualSolReserves + solIn,
    virtualTokenReserves: state.virtualTokenReserves - t,
    realSolReserves: state.realSolReserves == null ? state.realSolReserves : state.realSolReserves + solIn,
    realTokenReserves: state.realTokenReserves == null ? state.realTokenReserves : state.realTokenReserves - t,
  };
}

/**
 * Simulate a curve sell of `tokens`.
 *
 *   buy: { solAmount, maxSolCost } — REQUIRED before a buy (the wallet holds no tokens yet): the
 *        transaction first buys exactly `tokens` with the same arguments the real buy uses, then
 *        sells them. Without `buy` only the sell is simulated, which is valid only for a wallet
 *        that already holds the tokens.
 *
 * @returns {Promise<{ok: boolean, reason?: string, quote?: bigint, minOut?: bigint, logs: string[], units?: number|null, withBuy?: boolean}>}
 */
export async function simulateCurveSell({ wallet, mintPk, state, tokens, slipBps = 500, buy = null, deps = {} }) {
  const D = { calcSellSol, buyIx, sellIx, userAtaIx, computeBudgetIxs, buildVersionedTx, simulateTx, describeTxError, ...deps };
  if (!state?.creator) return { ok: false, reason: "creator unknown (cannot build the sell)", logs: [] };
  if (!tokens || BigInt(tokens) <= 0n) return { ok: false, reason: "no tokens to sell", logs: [] };
  const amount = BigInt(tokens);

  // With the buy leg the sell runs on the post-buy reserves; quote it there.
  const sellState = buy ? stateAfterBuy(state, amount) ?? state : state;
  const quote = D.calcSellSol(sellState, amount);
  const minOut = (quote * BigInt(10000 - slipBps)) / 10000n;
  let creator;
  try {
    creator = new PublicKey(state.creator);
  } catch {
    // A malformed/zero creator (some on-chain curves) must not crash the buy path.
    return { ok: false, reason: "creator unknown (invalid public key)", logs: [] };
  }
  const opts = { creator, isMayhem: !!state.isMayhemMode };
  const ixs = [
    // Buy + sell in one transaction needs more compute than the buy alone; a simulation pays
    // nothing, so the limit is doubled to keep "out of compute" from posing as a curve failure.
    ...(buy ? D.computeBudgetIxs(undefined, 2 * CU_LIMIT) : D.computeBudgetIxs()),
    // The buy creates the user ATA idempotently; both legs need that same ATA.
    D.userAtaIx(wallet.publicKey, mintPk),
    ...(buy ? [D.buyIx(wallet.publicKey, mintPk, buy.solAmount, amount, { ...opts, maxSolCost: buy.maxSolCost })] : []),
    D.sellIx(wallet.publicKey, mintPk, amount, minOut, opts),
  ];
  const tx = await D.buildVersionedTx(wallet, ixs);
  const sim = await D.simulateTx(tx);
  const logs = sim.logs ?? [];
  const withBuy = !!buy;
  if (!sim.ok) return { ok: false, reason: D.describeTxError(sim.err), quote, minOut, logs, units: sim.units ?? null, withBuy };
  return { ok: true, quote, minOut, logs, units: sim.units ?? null, withBuy };
}

/**
 * The pre-buy decision: run the buy+sell simulation and say whether the entry must be refused.
 *
 *   LIVE    — a failed (or impossible) simulation BLOCKS the buy.
 *   DRY RUN — informational only, never blocks: a paper run must not depend on the wallet's
 *             balance. With less than maxSolCost + DRY_SIM_BALANCE_MARGIN_SOL in the wallet the
 *             simulation is skipped (it could only fail on the balance).
 *
 *   simulate      () => simulateCurveSell({ ..., buy }) — the caller builds the call
 *   maxSolCost    lamports the simulated buy may spend (the dry balance pre-check)
 *   getBalanceSol () => wallet balance in SOL (read-only); dry run only
 *
 * `preBuySim` is the journal value: "ok" | "fail:<reason>" | "skipped:<reason>".
 *
 * @returns {Promise<{block: boolean, preBuySim: string, sim: object|null, balanceSol?: number, needSol?: number}>}
 */
export async function preBuyCheck({ live, maxSolCost, getBalanceSol = null, simulate }) {
  if (!live) {
    const needSol = Number(maxSolCost) / 1e9 + DRY_SIM_BALANCE_MARGIN_SOL;
    let balanceSol = null;
    try {
      balanceSol = getBalanceSol ? await getBalanceSol() : null;
    } catch {
      balanceSol = null;
    }
    if (!Number.isFinite(balanceSol)) return { block: false, preBuySim: "skipped:balance-unavailable", sim: null };
    if (balanceSol < needSol) return { block: false, preBuySim: "skipped:low-balance", sim: null, balanceSol, needSol };
  }
  let sim;
  try {
    sim = await simulate();
  } catch (e) {
    // The simulation could not even be built/sent to the RPC: live cannot prove the exit -> no buy.
    const why = String(e?.message || e);
    return live
      ? { block: true, preBuySim: `fail:${why}`, sim: { ok: false, reason: why, logs: [] } }
      : { block: false, preBuySim: `skipped:error: ${why}`, sim: null };
  }
  if (sim.ok) return { block: false, preBuySim: "ok", sim };
  return { block: !!live, preBuySim: `fail:${sim.reason}`, sim };
}
