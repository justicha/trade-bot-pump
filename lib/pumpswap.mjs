import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ATA_PROGRAM,
  PUMP_PROGRAM,
  PUMPSWAP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL,
} from "./constants.mjs";
import { PUMPSWAP_TRADE_PREFIX, PUMPSWAP_FEE_PREFIX } from "./constants.mjs";

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

// --- PumpSwap AMM (graduated tokens): pool derivation, exit quote and the sell instruction -----
// Layouts and accounts come from the official pump-amm IDL (@pump-fun/pump-sdk/idl/pump_amm.json).
const AMM_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const AMM_GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_PROGRAM)[0];
const AMM_EVENT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP_PROGRAM)[0];
const AMM_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMPSWAP_PROGRAM.toBuffer()],
  AMM_FEE_PROGRAM,
)[0];
// WSOL is a classic SPL token; pump mints are Token-2022.
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Canonical pump pool of `mint`: PDA(["pool", u16(0), pool-authority, mint, WSOL]).
export function canonicalPool(mint) {
  const authority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([0, 0]), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

function readI128(d, o) {
  return d.readBigUInt64LE(o) + (d.readBigInt64LE(o + 8) << 64n);
}

// PoolState (borsh after the 8-byte discriminator), offsets from the IDL field order.
export function decodePool(d) {
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  return {
    baseMint: pk(43),
    quoteMint: pk(75),
    baseVault: pk(139),
    quoteVault: pk(171),
    coinCreator: pk(211),
    isMayhem: d[243] === 1,
    isCashback: d[244] === 1,
    virtualQuoteReserves: readI128(d, 245),
    creatorFeeBps: d.readBigUInt64LE(261),
  };
}

// GlobalConfig (borsh WITH the 8-byte discriminator, like decodePool above). Offsets from the
// official pump-amm IDL type `GlobalConfig`:
//   admin@8 lp_fee_basis_points@40 protocol_fee_basis_points@48 disable_flags@56
//   protocol_fee_recipients[8]@57 coin_creator_fee_basis_points@313 admin_set_coin_creator_authority@321
//   whitelist_pda@353 reserved_fee_recipient@385 mayhem_mode_enabled@417 reserved_fee_recipients[8]@418
//   is_cashback_enabled@674 buyback_fee_recipients[8]@675 …
export function decodeGlobalConfig(d) {
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  return {
    lpFeeBps: Number(d.readBigUInt64LE(40)),
    protocolFeeBps: Number(d.readBigUInt64LE(48)),
    protocolFeeRecipients: Array.from({ length: 8 }, (_, i) => pk(57 + i * 32)),
    coinCreatorFeeBps: Number(d.readBigUInt64LE(313)),
    reservedFeeRecipient: pk(385),
    reservedFeeRecipients: Array.from({ length: 8 }, (_, i) => pk(418 + i * 32)),
    buybackFeeRecipients: Array.from({ length: 8 }, (_, i) => pk(675 + i * 32)),
  };
}

// pump-amm's sell `protocol_fee_recipient` is chosen exactly like pump.fun's buy fee recipient
// (pump-sdk swap/fees.ts getFeeRecipient): mayhem coins use the reserved list, everything else the
// normal list, picked at random from the LIVE global config — never a hardcoded wallet.
export function pickProtocolFeeRecipient(g, isMayhem) {
  const list = isMayhem ? [g.reservedFeeRecipient, ...g.reservedFeeRecipients] : g.protocolFeeRecipients;
  const live = list.filter((p) => p && !p.equals(PublicKey.default));
  if (live.length === 0) throw new Error("AMM global config has no fee recipient");
  return live[Math.floor(Math.random() * live.length)];
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

// PumpSwap `sell` (21 accounts per the IDL, args base_amount_in + min_quote_amount_out).
export function ammSellIx(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut) {
  const feeRecipient = pickProtocolFeeRecipient(g, p.isMayhem);
  const creatorAuth = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), p.coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: AMM_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(baseMint, user, false, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(p.quoteMint, user, false, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: p.baseVault, isSigner: false, isWritable: true },
    { pubkey: p.quoteVault, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(p.quoteMint, feeRecipient, false, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: AMM_EVENT_AUTH, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(p.quoteMint, creatorAuth, true, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: creatorAuth, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_PROGRAM, isSigner: false, isWritable: false },
  ];
  const data = Buffer.alloc(24);
  Buffer.from("33e685a4017f83ad", "hex").copy(data, 0); // sha256("global:sell")[0..8]
  data.writeBigUInt64LE(baseAmountIn, 8);
  data.writeBigUInt64LE(minQuoteOut, 16);
  return { programId: PUMPSWAP_PROGRAM, keys, data };
}
