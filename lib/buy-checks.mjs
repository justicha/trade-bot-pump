// Pre-buy safety decisions for the graduation sniper — pure functions, no RPC.
//
// Why this exists: a buy is only worth sending if the bot can actually get out. WELDERS
// (FMosXPu8…pump) showed the failure mode — the position could not be sold because the curve had
// almost no real liquidity left. These checks run BEFORE any transaction is signed.
import { BUY_SKIP_REASON } from "./buy-skip-reasons.mjs";

// Exit depth: the expected SOL out of selling everything the bot is about to buy must be at least
// this share of the buy. 0.9 x 0.02 SOL = 0.018 SOL with the default buy size.
export const MIN_EXIT_RATIO = 0.9;

/**
 * @param {bigint|number} solOutLamports expected exit (net, from previewExit)
 * @param {bigint|number} entryLamports   what the buy costs
 * @returns {{ok: boolean, minOutLamports: bigint, reason: string|null}}
 */
export function exitDepth({ solOutLamports, entryLamports, minRatio = MIN_EXIT_RATIO }) {
  const entry = BigInt(entryLamports);
  const minOut = (entry * BigInt(Math.round(minRatio * 10000))) / 10000n;
  const out = BigInt(solOutLamports ?? 0);
  const ok = out >= minOut && minOut > 0n;
  return { ok, minOutLamports: minOut, reason: ok ? null : BUY_SKIP_REASON.insufficientExitDepth };
}
