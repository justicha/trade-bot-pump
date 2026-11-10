// Fixture for scripts/exec.test.mjs: getTransaction returns null for "MISSING" (meta lag) and a
// sell meta for "SELL" (tokens left the wallet, SOL arrived).
import { PublicKey } from "@solana/web3.js";

export const OWNER = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MINT = "So11111111111111111111111111111111111111112";

export const connection = {
  async getTransaction(sig) {
    if (sig === "MISSING") return null;
    return {
      transaction: {
        message: {
          staticAccountKeys: [new PublicKey(OWNER), new PublicKey(MINT), new PublicKey("11111111111111111111111111111111")],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [2_000_049_000, 0, 0], // SOL arrived (net of fee)
        preTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "1000000" } }],
        postTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "0" } }],
      },
    };
  },
};
