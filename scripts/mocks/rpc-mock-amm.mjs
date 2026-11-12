// Fixture RPC (RPC_MOCK=<this file>) for a mint whose bonding curve has COMPLETED and may have a
// PumpSwap pool. Read-only by construction: sendRawTransaction throws (inherited from rpc-mock).
//
// Environment:
//   RPC_AMM_MINTS             comma-separated mints this fixture knows (required)
//   RPC_AMM_CURVE             "complete" (default) | "gone" — what the curve account looks like
//   RPC_AMM_COMPLETE_AFTER_MS the curve is live for this long after its first read (default 0), so
//                             a bot can still BUY on it before it "migrates"
//   RPC_AMM_POOL              "1" — the canonical pool exists; anything else — no pool
//   RPC_AMM_BASE / RPC_AMM_QUOTE  pool reserves (raw tokens / lamports)
//
// Every other address gets the plain live curve of rpc-mock.mjs. The global config is NOT served,
// so lib/pumpswap.mjs ammSellQuote uses its fallback fee split (20 + 5 + 5 = 30 bps).
import { PublicKey } from "@solana/web3.js";
import { connection as base } from "./rpc-mock.mjs";
import { AMM_GLOBAL_CONFIG, canonicalPool } from "../../lib/pumpswap-sell.mjs";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const key = (seed) => new PublicKey(Buffer.alloc(32, seed));
export const BASE_VAULT = key(0xb1);
export const QUOTE_VAULT = key(0xb2);
export const BASE_RESERVE = BigInt(process.env.RPC_AMM_BASE || "200000000000000"); // 2.0e14 raw tokens
export const QUOTE_RESERVE = BigInt(process.env.RPC_AMM_QUOTE || "16400000000"); // 16.4 SOL

const mints = (process.env.RPC_AMM_MINTS || "").split(",").filter(Boolean).map((m) => new PublicKey(m));
const curveOf = (mint) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP)[0];
const curves = new Map(mints.map((m) => [curveOf(m).toBase58(), m]));
const pools = new Map(mints.map((m) => [canonicalPool(m).toBase58(), m]));
const completeAfterMs = Number(process.env.RPC_AMM_COMPLETE_AFTER_MS || 0);
const firstRead = new Map();
export const calls = { curve: 0, pool: 0, vault: 0 };

// PoolState, only the fields lib/pumpswap-sell.mjs decodePool reads.
function poolAccount(mint) {
  const d = Buffer.alloc(300);
  mint.toBuffer().copy(d, 43); // base mint
  WSOL.toBuffer().copy(d, 75); // quote mint
  BASE_VAULT.toBuffer().copy(d, 139);
  QUOTE_VAULT.toBuffer().copy(d, 171);
  key(0x0c).toBuffer().copy(d, 211); // coin creator
  // is_mayhem 243 = 0, is_cashback 244 = 0, virtual quote reserves 245 = 0, creator fee bps 261 = 0
  return d;
}

export const connection = {
  ...base,
  async getAccountInfo(address) {
    const a = address.toBase58();
    if (curves.has(a)) {
      calls.curve += 1;
      if (!firstRead.has(a)) firstRead.set(a, Date.now());
      const info = await base.getAccountInfo(address);
      if (Date.now() - firstRead.get(a) < completeAfterMs) return info; // still trading
      if (process.env.RPC_AMM_CURVE === "gone") return null;
      info.data[48] = 1; // complete
      return info;
    }
    if (pools.has(a)) {
      calls.pool += 1;
      if (process.env.RPC_AMM_POOL !== "1") return null;
      return { data: poolAccount(pools.get(a)), executable: false, lamports: 1, owner: PUMP };
    }
    if (address.equals(AMM_GLOBAL_CONFIG)) return null;
    return base.getAccountInfo(address);
  },
  async getTokenAccountBalance(address) {
    if (address.equals(BASE_VAULT)) {
      calls.vault += 1;
      return { value: { amount: BASE_RESERVE.toString(), decimals: 6 } };
    }
    if (address.equals(QUOTE_VAULT)) {
      calls.vault += 1;
      return { value: { amount: QUOTE_RESERVE.toString(), decimals: 9 } };
    }
    return base.getTokenAccountBalance(address);
  },
};
