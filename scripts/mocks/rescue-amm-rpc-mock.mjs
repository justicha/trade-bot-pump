// Fixture RPC for scripts/rescue-amm-quote.test.mjs (RPC_MOCK=<this file>): the migrated mint of
// rpc-mock-amm.mjs (curve complete, canonical pool, fallback fee tier), plus what the rescue /
// probe scripts need on top of it. No network; sendRawTransaction throws (inherited).
//
//   RESCUE_HOLD_RAW   raw tokens of the first RPC_AMM_MINTS mint the wallet holds (default 0)
//
// - getTokenAccountsByOwner: that one Token-2022 holding.
// - AMM GlobalConfig: served WITH fee recipients (rpc-mock-amm serves none, so a sell instruction
//   could not be built) and with the 20 + 5 + 5 = 30 bps the old copies of the quote subtracted.
// - simulateTransaction: reports the compute-unit limit and price the transaction REQUESTED in its
//   logs, so a test can read them from the output of a script it spawned.
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { connection as amm } from "./rpc-mock-amm.mjs";
import { AMM_GLOBAL_CONFIG } from "../../lib/pumpswap-sell.mjs";

export { BASE_RESERVE, QUOTE_RESERVE } from "./rpc-mock-amm.mjs";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const key = (seed) => new PublicKey(Buffer.alloc(32, seed));
const mints = (process.env.RPC_AMM_MINTS || "").split(",").filter(Boolean);
const holdRaw = BigInt(process.env.RESCUE_HOLD_RAW || "0");

// GlobalConfig, only the fields lib/pumpswap-sell.mjs decodeGlobalConfig reads.
function globalConfigAccount() {
  const d = Buffer.alloc(931);
  d.writeBigUInt64LE(20n, 40); // lp fee bps
  d.writeBigUInt64LE(5n, 48); // protocol fee bps
  d.writeBigUInt64LE(5n, 313); // coin creator fee bps
  for (let i = 0; i < 8; i++) {
    key(0x77).toBuffer().copy(d, 57 + i * 32); // protocol fee recipients
    key(0x88).toBuffer().copy(d, 675 + i * 32); // buyback fee recipients
  }
  return d;
}

export const connection = {
  ...amm,
  async getAccountInfo(address) {
    if (address.equals(AMM_GLOBAL_CONFIG)) return { data: globalConfigAccount(), executable: false, lamports: 1, owner: key(0x01) };
    return amm.getAccountInfo(address);
  },
  async getTokenAccountsByOwner(owner, filter) {
    if (!filter?.programId?.equals(TOKEN_2022) || !mints.length || holdRaw === 0n) return { value: [] };
    const d = Buffer.alloc(165);
    new PublicKey(mints[0]).toBuffer().copy(d, 0);
    owner.toBuffer().copy(d, 32);
    d.writeBigUInt64LE(holdRaw, 64);
    return { value: [{ pubkey: key(0xa7), account: { data: [d.toString("base64"), "base64"] } }] };
  },
  async simulateTransaction(tx) {
    const keys = tx.message.staticAccountKeys;
    let limit = null;
    let price = null;
    for (const ix of tx.message.compiledInstructions) {
      if (!keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
      const data = Buffer.from(ix.data);
      if (data[0] === 2) limit = data.readUInt32LE(1);
      if (data[0] === 3) price = Number(data.readBigUInt64LE(1));
    }
    return { value: { err: null, logs: [`Program log: fixture cu_limit=${limit} cu_price=${price}`], unitsConsumed: 80_000 } };
  },
};
