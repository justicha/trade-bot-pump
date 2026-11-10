// Fixture for scripts/tx-confirm-loss.test.mjs: send succeeds, confirmTransaction throws a network
// error, and getTransaction reports the tokens DID arrive — the reconciliation path must read the
// landed fill and keep the position instead of releasing the reserve.
import { PublicKey } from "@solana/web3.js";

export const SIG = "5" + "1".repeat(87);
export const OWNER = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MINT = "So11111111111111111111111111111111111111112";

export const connection = {
  async sendRawTransaction() {
    return SIG;
  },
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  },
  async getBlockHeight() {
    return 100;
  },
  async confirmTransaction() {
    throw new Error("network error: connection reset");
  },
  async getTransaction(sig) {
    if (sig !== SIG) return null;
    return {
      transaction: {
        message: {
          staticAccountKeys: [new PublicKey(OWNER), new PublicKey(MINT), new PublicKey("11111111111111111111111111111111")],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        // Owner spent 25000 lamports total (20000 trade + 5000 fee).
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_999_975_000, 0, 0],
        preTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "0" } }],
        postTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "700000" } }],
      },
    };
  },
};
