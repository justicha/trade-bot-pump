// PumpSwap AMM sell: pool derivation, account/state decoders and the `sell` instruction.
//
// Single source of truth (AUDIT_SELL.md §4): this code used to exist TWICE — as part of
// lib/pumpswap.mjs and again, line for line, inside scripts/rescue-sell.mjs. A layout fix had to be
// made in two places; now there is one.
//
// Layouts and accounts come from the official pump-amm IDL (@pump-fun/pump-sdk/idl/pump_amm.json).
// That IDL is NOT in this repository, so the account list is a transcription, not a checked
// artifact: TODO(verify) V1/V2/V6 in AUDIT_SELL.md — confirm against a real sell tx or the IDL.
// The instruction discriminator is verified offline: sha256("global:sell")[0..8].
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

const AMM_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const AMM_GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_PROGRAM)[0];
const AMM_EVENT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP_PROGRAM)[0];
const AMM_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMPSWAP_PROGRAM.toBuffer()],
  AMM_FEE_PROGRAM,
)[0];
// WSOL is a classic SPL token; pump mints are Token-2022.
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// sha256("global:sell")[0..8] — Anchor instruction discriminator, checked offline (AUDIT_SELL.md §3.1).
export const AMM_SELL_DISCRIMINATOR = Buffer.from("33e685a4017f83ad", "hex");
// sell takes exactly these accounts in this order (AUDIT_SELL.md §3.2); V1/V2 unverified.
export const AMM_SELL_ACCOUNT_COUNT = 21;

// Canonical pump pool of `mint`: PDA(["pool", u16(0), pool-authority, mint, WSOL]).
export function canonicalPool(mint) {
  const authority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([0, 0]), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

export function readI128(d, o) {
  const lo = d.readBigUInt64LE(o);
  const hi = d.readBigInt64LE(o + 8);
  return lo + (hi << 64n);
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

// An owner that is NOT on the ed25519 curve is a PDA (creator vault authority, fee recipient
// vault, …). getAssociatedTokenAddressSync THROWS TokenOwnerOffCurveError for such an owner
// unless allowOwnerOffCurve is true — that is what broke ammSellIx on PDA-owned fee accounts.
// Wallets are on-curve, so for them the flag stays false exactly as before.
// (Address derivation itself does not depend on the flag: it only relaxes the owner check.)
function ataFor(mint, owner, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, owner, !PublicKey.isOnCurve(owner.toBytes()), tokenProgram);
}

// PumpSwap `sell` (21 accounts per the IDL, args base_amount_in + min_quote_amount_out).
// NOTE (audit BUG 13): the v1 `sell` has no buyback accounts — cashback pools (is_cashback_coin)
// may require `sell_v2` (user_volume_accumulator + buyback_fee_recipient). Not verified on-chain;
// AMM sells stay gated behind LIVE_CONFIRM_AMM=yes. The account list is deliberately unchanged
// until V1/V2 are confirmed: see AUDIT_SELL.md §8.
export function ammSellIx(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut) {
  const feeRecipient = pickProtocolFeeRecipient(g, p.isMayhem);
  const creatorAuth = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), p.coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
  // Both owners below can be PDAs: creatorAuth always, the fee recipient when the global config
  // points at a vault. ataFor keeps the wallet case (user ATAs) unchanged.
  const creatorVaultAta = ataFor(p.quoteMint, creatorAuth, TOKEN_PROGRAM);
  const feeRecipientAta = ataFor(p.quoteMint, feeRecipient, TOKEN_PROGRAM);
  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: AMM_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: ataFor(baseMint, user, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: ataFor(p.quoteMint, user, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: p.baseVault, isSigner: false, isWritable: true },
    { pubkey: p.quoteVault, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: feeRecipientAta, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: AMM_EVENT_AUTH, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: creatorAuth, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_PROGRAM, isSigner: false, isWritable: false },
  ];
  const data = Buffer.alloc(24);
  AMM_SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(baseAmountIn, 8);
  data.writeBigUInt64LE(minQuoteOut, 16);
  return { programId: PUMPSWAP_PROGRAM, keys, data };
}
