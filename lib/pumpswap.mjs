import { PublicKey } from "@solana/web3.js";
import { PUMPSWAP_PROGRAM, PUMPSWAP_TRADE_PREFIX, PUMPSWAP_FEE_PREFIX } from "./constants.mjs";
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


// ---- the pool's REAL fee: the fee program's FeeConfig, tiers by market cap ---------------------
//
// GlobalConfig's lp/protocol/creator bps (20 + 5 + 5 = 30) are NOT what a canonical pump pool
// charges. The sell reads `fee_config` = PDA(["fee_config", pump-amm program id]) of the fee
// program (account 19 of the sell instruction) and takes the tier of the pool's market cap:
//   market cap = (quote vault + pool.virtual_quote_reserves) * base mint supply / base vault,
//                on the reserves BEFORE the trade;
//   tier       = the last one whose threshold <= market cap (the first when below all of them);
//   each of the three fees is rounded UP on the gross quote amount, then subtracted.
// Checked read-only against mainnet on 2026-11-13: 210 real SellEvents of 13 canonical pools —
// gross, tier and net reproduce the event to the lamport (scripts/amm-fee.test.mjs replays 10 of
// them from scripts/fixtures/amm-sell-events.json). Right after a migration the market cap sits
// around the first threshold (420 SOL), so a sale pays 2 + 93 + 30 = 125 bps below it and
// 20 + 5 + 95 = 120 bps above it.
export const AMM_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const AMM_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMPSWAP_PROGRAM.toBuffer()],
  AMM_FEE_PROGRAM,
)[0];
// sha256("account:FeeConfig")[0..8]
const FEE_CONFIG_DISCRIMINATOR = Buffer.from("8f3492bbdb7b4c9b", "hex");
// Used only when the chain cannot be read: the most expensive tier seen on mainnet (the first one,
// 125 bps). A quote that is too LOW only lowers min_quote_amount_out; one that is too high makes
// the sale fail on slippage.
export const AMM_FALLBACK_FEES = Object.freeze({ lpFeeBps: 2, protocolFeeBps: 93, creatorFeeBps: 30 });
const FEE_CONFIG_TTL_MS = 5 * 60_000;
const MAX_FEE_TIERS = 64;

const feesTotalBps = (f) => f.lpFeeBps + f.protocolFeeBps + f.creatorFeeBps;
const saneFees = (f) =>
  [f.lpFeeBps, f.protocolFeeBps, f.creatorFeeBps].every((b) => Number.isInteger(b) && b >= 0 && b <= 10_000) &&
  feesTotalBps(f) < 10_000;

// FeeConfig (borsh after the 8-byte discriminator): bump u8 @8, admin @9, flat_fees @41
// (lp, protocol, creator — u64 each), fee_tiers Vec @65: { market_cap_lamports_threshold u128,
// fees }. More fields follow (a second tier list that pools quoted in another token use) — a
// SOL pool does not need them. Returns null for anything that is not a plausible FeeConfig, so a
// wrong account can never turn into a fee of 0.
export function decodeFeeConfig(d) {
  try {
    if (!d || d.length < 69 || !Buffer.from(d.subarray(0, 8)).equals(FEE_CONFIG_DISCRIMINATOR)) return null;
    const fees = (o) => ({
      lpFeeBps: Number(d.readBigUInt64LE(o)),
      protocolFeeBps: Number(d.readBigUInt64LE(o + 8)),
      creatorFeeBps: Number(d.readBigUInt64LE(o + 16)),
    });
    const flatFees = fees(41);
    const n = d.readUInt32LE(65);
    if (n < 1 || n > MAX_FEE_TIERS || d.length < 69 + n * 40 || !saneFees(flatFees)) return null;
    const feeTiers = [];
    for (let i = 0; i < n; i++) {
      const o = 69 + i * 40;
      const tier = { thresholdLamports: d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n), ...fees(o + 16) };
      if (!saneFees(tier)) return null;
      if (i > 0 && tier.thresholdLamports <= feeTiers[i - 1].thresholdLamports) return null;
      feeTiers.push(tier);
    }
    return { flatFees, feeTiers };
  } catch {
    return null;
  }
}

// Market cap of the pool in lamports, on the reserves before the trade. `quoteReserve` already
// includes pool.virtual_quote_reserves.
export function poolMarketCapLamports({ baseReserve, quoteReserve, supply }) {
  if (!(baseReserve > 0n)) return 0n;
  return (quoteReserve * supply) / baseReserve;
}

// The tier of a market cap: the last threshold that is <= it; below every threshold — the first.
export function pickFeeTier(feeTiers, marketCapLamports) {
  let tier = feeTiers[0];
  for (const t of feeTiers) if (marketCapLamports >= t.thresholdLamports) tier = t;
  return tier;
}

// Gross quote amount minus the three fees, each rounded UP like the program does.
export function ammNetOut(grossOut, fees) {
  const fee = (bps) => (grossOut * BigInt(bps) + 9999n) / 10000n;
  const net = grossOut - fee(fees.lpFeeBps) - fee(fees.protocolFeeBps) - fee(fees.creatorFeeBps);
  return net > 0n ? net : 0n;
}

// FeeConfig changes only when pump changes its fee schedule: one read per connection per 5 min.
// Failures are not cached (the next quote tries again).
const feeConfigCache = new WeakMap(); // connection -> { at, value }
async function readFeeConfig(connection, now) {
  const hit = feeConfigCache.get(connection);
  if (hit && now - hit.at < FEE_CONFIG_TTL_MS) return hit.value;
  const info = await Promise.resolve()
    .then(() => connection.getAccountInfo(AMM_FEE_CONFIG))
    .catch(() => null);
  if (!info?.data || !info.owner?.equals?.(AMM_FEE_PROGRAM)) return null;
  const value = decodeFeeConfig(info.data);
  if (value) feeConfigCache.set(connection, { at: now, value });
  return value;
}

// Fees of one sale. source "onchain" = the tier of the pool's market cap from the chain's
// FeeConfig; "fallback" = something could not be read, so the most expensive known tier is used
// (never a cheaper one than the chain might charge).
export function ammSellFees({ feeConfig, baseReserve, quoteReserve, supply }) {
  if (!feeConfig) return { ...AMM_FALLBACK_FEES, source: "fallback", marketCapLamports: null };
  if (!(supply > 0n)) {
    const worst = feeConfig.feeTiers.reduce((a, t) => (feesTotalBps(t) > feesTotalBps(a) ? t : a), AMM_FALLBACK_FEES);
    return { lpFeeBps: worst.lpFeeBps, protocolFeeBps: worst.protocolFeeBps, creatorFeeBps: worst.creatorFeeBps, source: "fallback", marketCapLamports: null };
  }
  const marketCapLamports = poolMarketCapLamports({ baseReserve, quoteReserve, supply });
  const t = pickFeeTier(feeConfig.feeTiers, marketCapLamports);
  return { lpFeeBps: t.lpFeeBps, protocolFeeBps: t.protocolFeeBps, creatorFeeBps: t.creatorFeeBps, source: "onchain", marketCapLamports };
}

// Expected SOL out of selling `rawTokens` into the pool: constant product on the quote reserves
// (vault + virtual), minus the pool's real lp + protocol + creator fees (see above). Returns null
// when the pool is missing.
//   feeBps    — total fee the quote subtracted
//   feeSource — "onchain" | "fallback" (FeeConfig or the mint supply could not be read: the quote
//               then assumes the most expensive tier)
// The creator fee is charged even for a pool without a coin creator (the SDK waives it there):
// not seen on a pump pool, and the cautious side for min_quote_amount_out.
export async function ammSellQuote(connection, mint, rawTokens, globalConfig = null, { feeConfig = null, now = Date.now() } = {}) {
  const pool = canonicalPool(mint);
  const pi = await connection.getAccountInfo(pool).catch(() => null);
  if (!pi || pi.data.length < 287) return null;
  const p = decodePool(pi.data);
  const [bv, qv, sup, fc] = await Promise.all([
    connection.getTokenAccountBalance(p.baseVault).catch(() => null),
    connection.getTokenAccountBalance(p.quoteVault).catch(() => null),
    Promise.resolve()
      .then(() => connection.getTokenSupply(mint))
      .catch(() => null),
    feeConfig ?? readFeeConfig(connection, now),
  ]);
  if (!bv || !qv) return null;
  const baseReserve = BigInt(bv.value.amount);
  const quoteReserve = BigInt(qv.value.amount);
  const gross = quoteReserve + (p.virtualQuoteReserves > 0n ? p.virtualQuoteReserves : 0n);
  const out = (gross * rawTokens) / (baseReserve + rawTokens);
  let g = globalConfig;
  if (!g) {
    // Only the fee RECIPIENTS of the sell instruction come from here now; its bps are not the
    // pool's fee (see above).
    const gc = await connection.getAccountInfo(AMM_GLOBAL_CONFIG).catch(() => null);
    g = gc ? decodeGlobalConfig(gc.data) : { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipients: [], reservedFeeRecipient: null, reservedFeeRecipients: [], buybackFeeRecipients: [] };
  }
  let supply = 0n;
  try {
    supply = sup?.value?.amount != null ? BigInt(sup.value.amount) : 0n;
  } catch {
    supply = 0n;
  }
  const fees = ammSellFees({ feeConfig: fc, baseReserve, quoteReserve: gross, supply });
  const feeBps = feesTotalBps(fees);
  const net = ammNetOut(out, fees);
  return { pool, p, g, feeBps, fees, feeSource: fees.source, marketCapLamports: fees.marketCapLamports, grossOut: out, solOut: net };
}

