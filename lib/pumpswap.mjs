import { PublicKey } from "@solana/web3.js";
import { PUMPSWAP_TRADE_PREFIX, PUMPSWAP_FEE_PREFIX } from "./constants.mjs";
import { AMM_GLOBAL_CONFIG, canonicalPool, decodeGlobalConfig, decodePool } from "./pumpswap-sell.mjs";

// The pool/state decoders and the `sell` instruction live in lib/pumpswap-sell.mjs — ONE copy,
// shared with scripts/rescue-sell.mjs (AUDIT_SELL.md §4). Re-exported so existing imports of
// lib/pumpswap.mjs keep working.
export {
  AMM_GLOBAL_CONFIG,
  AMM_SELL_ACCOUNT_COUNT,
  AMM_SELL_DISCRIMINATOR,
  TOKEN_PROGRAM,
  ammSellIx,
  canonicalPool,
  decodeGlobalConfig,
  decodePool,
  pickProtocolFeeRecipient,
  readI128,
} from "./pumpswap-sell.mjs";

// PumpSwap BuyEvent/SellEvent (layout from pump-fun/pump-public-docs IDL `types`).
// base_amount u64@16 (out=buy/in=sell), user_quote_amount_in/out u64@112 (WITH fees),
// pool@120, user@152, user_base_token_account@184.
// 67f4521f2cf57777=BuyEvent, 3e2f370aa503dc2a=SellEvent.
export function parsePumpSwapEvent(data) {
  if (data.length < 216) return null;
  const p = data.subarray(0, 8);
  let side = null;
  if (p.equals(PUMPSWAP_TRADE_PREFIX)) side = "buy";
  else if (p.equals(PUMPSWAP_FEE_PREFIX)) side = "sell";
  else return null;
  try {
    const baseAmount = Number(data.readBigUInt64LE(16));
    const quoteAmount = Number(data.readBigUInt64LE(112));
    const pool = new PublicKey(data.subarray(120, 152)).toBase58();
    const user = new PublicKey(data.subarray(152, 184)).toBase58();
    const userBaseTokenAccount = new PublicKey(data.subarray(184, 216)).toBase58();
    return { side, baseAmount, quoteAmount, pool, user, userBaseTokenAccount };
  } catch { return null; }
}

// pool -> mint via the tx's user_base_token_account. Returns null (unresolved) if unknown — we
// never substitute the pool address for the mint. Fallback: the event user's own token-balance
// mints (non-WSOL); if exactly one, that is the base token of the swap.
export function resolvePswapMint(ev, acctMintMap, ownerMints) {
  const direct = acctMintMap && acctMintMap[ev.userBaseTokenAccount];
  if (direct) return direct;
  const ms = ownerMints && ownerMints[ev.user];
  if (ms && ms.length === 1) return ms[0];
  return null;
}


// Expected SOL out of selling `rawTokens` into the pool (constant product on the virtual quote
// reserves, minus lp+protocol+creator fees). Returns null when the pool is missing.
export async function ammSellQuote(connection, mint, rawTokens, globalConfig = null) {
  const pool = canonicalPool(mint);
  const pi = await connection.getAccountInfo(pool).catch(() => null);
  if (!pi || pi.data.length < 287) return null;
  const p = decodePool(pi.data);
  const [bv, qv] = await Promise.all([
    connection.getTokenAccountBalance(p.baseVault).catch(() => null),
    connection.getTokenAccountBalance(p.quoteVault).catch(() => null),
  ]);
  if (!bv || !qv) return null;
  const baseReserve = BigInt(bv.value.amount);
  const quoteReserve = BigInt(qv.value.amount);
  const gross = quoteReserve + (p.virtualQuoteReserves > 0n ? p.virtualQuoteReserves : 0n);
  const out = (gross * rawTokens) / (baseReserve + rawTokens);
  let g = globalConfig;
  if (!g) {
    const gc = await connection.getAccountInfo(AMM_GLOBAL_CONFIG).catch(() => null);
    g = gc ? decodeGlobalConfig(gc.data) : { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipients: [], reservedFeeRecipient: null, reservedFeeRecipients: [], buybackFeeRecipients: [] };
  }
  const feeBps = g.lpFeeBps + g.protocolFeeBps + (p.creatorFeeBps > 0n ? Number(p.creatorFeeBps) : g.coinCreatorFeeBps);
  const net = (out * BigInt(10000 - feeBps)) / 10000n;
  return { pool, p, g, feeBps, grossOut: out, solOut: net };
}

