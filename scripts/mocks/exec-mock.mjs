// Fixture for scripts/exec.test.mjs: getTransaction returns null for "MISSING" (meta lag) and a
// sell meta for "SELL" (tokens left the wallet, SOL arrived).
import { PublicKey } from "@solana/web3.js";

export const OWNER = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// A non-WSOL base mint: the WSOL account plays a separate role (quote / closed ATA) in the meta.
export const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const connection = {
  async getTransaction(sig) {
    if (sig === "MISSING") return null;
    if (sig === "SELL_RENT") {
      // An AMM sell that closed a WSOL ATA which already existed: the wallet got proceeds PLUS the
      // 2_039_280 lamport rent back. readExecution must not count the rent as proceeds.
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
          postBalances: [2_000_000_000 + 100_000_000 + 2_039_280, 0, 0],
          preTokenBalances: [
            { owner: OWNER, mint: MINT, uiTokenAmount: { amount: "1000000" } },
            { owner: OWNER, mint: "So11111111111111111111111111111111111111112", uiTokenAmount: { amount: "40000000" } },
          ],
          postTokenBalances: [{ owner: OWNER, mint: MINT, uiTokenAmount: { amount: "0" } }],
        },
      };
    }
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
