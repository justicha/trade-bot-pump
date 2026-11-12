// RPC mock for scripts/close-empty-atas.test.mjs: a wallet with two EMPTY token accounts (one per
// token program), one account that still holds tokens and an empty WSOL account.
//
// Anything that would build, simulate or send a transaction prints a marker line, so the test can
// prove that a plan-only run never got that far.
import { PublicKey } from "@solana/web3.js";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

const key = (seed) => new PublicKey(Buffer.alloc(32, seed));
const data = (mint, owner, amount) => {
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  buf[108] = 1;
  return buf;
};
const marker = (name) => console.log(`MOCK_CALL ${name}`);

export const connection = {
  async getTokenAccountsByOwner(owner, filter) {
    const row = (seed, mint, amount, lamports, program) => ({
      pubkey: key(seed),
      account: { owner: program, lamports, data: data(mint, owner, amount) },
    });
    if (filter.programId.equals(TOKEN_2022)) {
      return { value: [row(11, key(21), 0, 2_074_080, TOKEN_2022), row(12, key(22), 5_000_000, 2_074_080, TOKEN_2022)] };
    }
    if (filter.programId.equals(TOKEN)) {
      return { value: [row(13, key(23), 0, 2_039_280, TOKEN), row(14, WSOL, 0, 2_039_280, TOKEN)] };
    }
    return { value: [] };
  },
  async getLatestBlockhash() {
    marker("getLatestBlockhash");
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  },
  async getBlockHeight() {
    marker("getBlockHeight");
    return 1;
  },
  async simulateTransaction() {
    marker("simulateTransaction");
    return { value: { err: null, logs: [], unitsConsumed: 0 } };
  },
  async sendRawTransaction() {
    marker("sendRawTransaction");
    throw new Error("mock: sendRawTransaction must never be called");
  },
};
