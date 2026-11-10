// Fixture RPC for scripts/smoke.test.mjs (RPC_MOCK=<this file>): no network at all.
//
// getAccountInfo returns a 166-byte pump.fun BondingCurve account whose price RISES on every call
// (x1.9), so a position opened on one call is past the 2x take-profit on the next poll — that is
// how the smoke test gets a real exit without waiting. Layout: 8 discriminator,
// virtualTokenReserves(8), virtualSolReserves(16), realTokenReserves(24), realSolReserves(32),
// tokenTotalSupply(40), complete(48), creator(49..81), is_mayhem_mode(81).
// The curve bytes above are reused for every address in this fixture, so they need a PublicKey
// import for the mint owner.
import { PublicKey } from "@solana/web3.js";

const V_TOK = 1_073_000_000_000_000n;
let calls = 0;

function curveAccount() {
  calls += 1;
  const vSol = BigInt(Math.round(30e9 * Math.pow(1.9, calls % 6))); // bounded, always plausible
  const vTok = V_TOK;
  const data = Buffer.alloc(166);
  data.writeBigUInt64LE(vTok, 8);
  data.writeBigUInt64LE(vSol, 16);
  data.writeBigUInt64LE(vTok - 279_900_000_000_000n, 24);
  data.writeBigUInt64LE(vSol - 30_000_000_000n > 0n ? vSol - 30_000_000_000n : 0n, 32);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  data[48] = 0; // not complete
  data[81] = 0; // is_mayhem_mode
  return data;
}

export const connection = {
  async getAccountInfo() {
    // The same curve bytes are served for every address in this fixture. `owner` is the classic
    // SPL token program so the graduation bot's mint-safety gate (Token-2022 extensions) treats
    // the fixture mint as plain SPL — a null owner means "unverified" and would block every buy.
    return {
      data: curveAccount(),
      executable: false,
      lamports: 1,
      owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    };
  },
  // The bot simulates a curve sell before it buys; this fixture always says "would succeed".
  async simulateTransaction() {
    return { value: { err: null, logs: ["Program log: fixture simulation ok"], unitsConsumed: 1000 } };
  },
  async getBalance() {
    return 2_000_000_000; // 2 SOL, enough for the session caps used by the test
  },
  async getTokenAccountBalance() {
    return { value: { amount: "40000000", decimals: 6, uiAmount: 40 } };
  },
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  },
  // buildVersionedTx() needs a block height (it recomputes the expiry from it).
  async getBlockHeight() {
    return 466_900_000;
  },
  async getSlot() {
    return 466_900_000;
  },
};

export function callCount() {
  return calls;
}
