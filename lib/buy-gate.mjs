// Gate for a LIVE entry (graduation-sniper).
//
// Why: a buy only makes sense if the bot can also get out. The post-migration exit goes through
// PumpSwap, whose account layout is still unverified on-chain (AUDIT_SELL.md §8, V1/V2/V7 — the
// program currently rejects the sell with Custom 6062 InvalidPoolV2). A live buy that opens a
// position the bot cannot close is a one-way trade, so live entries are blocked until the AMM exit
// is confirmed with LIVE_CONFIRM_AMM=yes.
//
// A dry run never sends anything, so it is not affected.
export const BUY_BLOCK_REASON = "LIVE_CONFIRM_AMM not set, PumpSwap sell path unverified";

export function checkBuyGate({ live, confirmAmm }) {
  if (!live) return { ok: true };
  if (confirmAmm !== "yes") return { ok: false, reason: BUY_BLOCK_REASON };
  return { ok: true };
}
