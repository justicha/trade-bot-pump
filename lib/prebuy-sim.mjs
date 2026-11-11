// Pre-buy sell simulation for the bonding-curve path (task 3).
//
// The bot buys on the curve, so before it spends anything it asks the chain the only question that
// matters: "would selling everything I am about to buy actually go through?" The transaction is
// built exactly like a real exit (planSellParts is not needed here: the buy amount is known, and a
// full-position curve sell is what sellPosition builds for one part) and only SIMULATED.
//
// Dependencies are injectable so the decision can be tested without a chain.
import { PublicKey } from "@solana/web3.js";
import { calcSellSol, sellIx, userAtaIx } from "./pumpfun.mjs";
import { buildVersionedTx, computeBudgetIxs } from "./tx.mjs";
import { simulateTx } from "./exec.mjs";
import { describeTxError } from "./pump-errors.mjs";

/**
 * @returns {Promise<{ok: boolean, reason?: string, quote?: bigint, minOut?: bigint, logs: string[], units?: number|null}>}
 */
export async function simulateCurveSell({ wallet, mintPk, state, tokens, slipBps = 500, deps = {} }) {
  const D = { calcSellSol, sellIx, userAtaIx, computeBudgetIxs, buildVersionedTx, simulateTx, describeTxError, ...deps };
  if (!state?.creator) return { ok: false, reason: "creator unknown (cannot build the sell)", logs: [] };
  if (!tokens || BigInt(tokens) <= 0n) return { ok: false, reason: "no tokens to sell", logs: [] };

  const quote = D.calcSellSol(state, BigInt(tokens));
  const minOut = (quote * BigInt(10000 - slipBps)) / 10000n;
  let creator;
  try {
    creator = new PublicKey(state.creator);
  } catch {
    // A malformed/zero creator (some on-chain curves) must not crash the buy path.
    return { ok: false, reason: "creator unknown (invalid public key)", logs: [] };
  }
  const ixs = [
    ...D.computeBudgetIxs(),
    // The buy creates the user ATA idempotently; the sell we are about to simulate needs that same
    // ATA. Without it a fresh wallet fails the simulation with AccountNotInitialized on
    // `associated_user` even though the real exit (after the buy) would succeed.
    D.userAtaIx(wallet.publicKey, mintPk),
    D.sellIx(wallet.publicKey, mintPk, BigInt(tokens), minOut, {
      creator,
      isMayhem: !!state.isMayhemMode,
    }),
  ];
  const tx = await D.buildVersionedTx(wallet, ixs);
  const sim = await D.simulateTx(tx);
  const logs = sim.logs ?? [];
  if (!sim.ok) return { ok: false, reason: D.describeTxError(sim.err), quote, minOut, logs, units: sim.units ?? null };
  return { ok: true, quote, minOut, logs, units: sim.units ?? null };
}
