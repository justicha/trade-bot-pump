// PumpSwap stream helpers that need no RPC (KODING #21): the canonical pool PDA and the decoders of
// the pool's BuyEvent / SellEvent as logged ("Program data: ...").
//
// One copy: lib/pumpswap.mjs re-exports parsePumpSwapEvent and lib/pumpswap-sell.mjs re-exports
// canonicalPool from here, so the existing imports keep working. This module imports only
// @solana/web3.js (PublicKey) and lib/constants.mjs: the mint census (read-only, zero RPC) can use it.
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM, PUMPSWAP_PROGRAM, PUMPSWAP_TRADE_PREFIX, PUMPSWAP_FEE_PREFIX, WSOL } from "./constants.mjs";

// Canonical pump pool of `mint`: PDA(["pool", u16(0), pool-authority, mint, WSOL]).
export function canonicalPool(mint) {
  const authority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([0, 0]), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

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

// ---- the full trade event: reserves, amounts, virtual quote reserves -------------------------------
// Offsets = 8-byte discriminator + borsh field sizes in the IDL order (pump-public-docs
// idl/pump_amm.json, read 2026-11-16; no padding). Shared prefix of both events:
//   timestamp i64 @8, base_amount_out|in u64 @16, max_quote_in|min_quote_out @24,
//   user_base_token_reserves @32, user_quote_token_reserves @40,
//   pool_base_token_reserves @48, pool_quote_token_reserves @56   (BEFORE the trade; the quote one is
//                                                                   the vault, without the virtual part)
//   quote_amount_in|out @64 (the constant-product amount), lp_fee_basis_points @72, lp_fee @80,
//   protocol_fee_basis_points @88, protocol_fee @96,
//   quote_amount_in_with_lp_fee (buy) | quote_amount_out_without_lp_fee (sell) @104,
//   user_quote_amount_in|out @112, pool @120, user @152, user_base_token_account @184,
//   user_quote_token_account @216, protocol_fee_recipient @248, its token account @280,
//   coin_creator @312, coin_creator_fee_basis_points @344, coin_creator_fee @352.
// SellEvent then: cashback_fee_basis_points @360, cashback @368, buyback_fee_basis_points @376,
//   buyback_fee @384, virtual_quote_reserves i128 @392, can_boost bool @408, base_supply u64 @409, ...
//   (the same offsets scripts/amm-fee.test.mjs replays to the lamport).
// BuyEvent then: track_volume bool @360, total_unclaimed_tokens @361, total_claimed_tokens @369,
//   current_sol_volume @377, last_update_timestamp @385, min_base_amount_out @393,
//   ix_name string @401 (u32 length + bytes: "buy" | "buy_exact_quote_in"), and after it
//   cashback_fee_basis_points, cashback, buyback_fee_basis_points, buyback_fee (4 x u64),
//   virtual_quote_reserves i128, can_boost bool, base_supply u64 — so those offsets move with the
//   name's length: virtual_quote_reserves @ 401 + 4 + len + 32.
const IX_NAME_MAX = 64;

function i128(d, o) {
  return d.readBigUInt64LE(o) + (d.readBigInt64LE(o + 8) << 64n);
}

// Every amount is a BigInt in raw units (lamports / raw tokens). Null for anything that is not a
// PumpSwap Buy/SellEvent or is too short. `virtualQuote` / `baseSupply` are null when the tail that
// holds them is missing (a shorter, older event): the price cannot be computed then.
export function parsePumpSwapTrade(data) {
  if (!data || data.length < 360) return null;
  const head = data.subarray(0, 8);
  let side;
  if (head.equals(PUMPSWAP_TRADE_PREFIX)) side = "buy";
  else if (head.equals(PUMPSWAP_FEE_PREFIX)) side = "sell";
  else return null;
  try {
    const u = (o) => data.readBigUInt64LE(o);
    const ev = {
      side,
      timestampSec: Number(data.readBigInt64LE(8)),
      baseAmount: u(16), // out (buy) / in (sell)
      poolBase: u(48), // before the trade
      poolQuote: u(56), // before the trade, vault only
      quoteAmount: u(64), // constant-product amount: in (buy) / out (sell), before lp fee
      lpFee: u(80),
      protocolFee: u(96),
      quoteWithLp: u(104), // buy: quote_amount_in_with_lp_fee; sell: quote_amount_out_without_lp_fee
      userQuote: u(112), // buy: paid by the user with every fee; sell: received by the user
      pool: new PublicKey(data.subarray(120, 152)).toBase58(),
      user: new PublicKey(data.subarray(152, 184)).toBase58(),
      coinCreator: new PublicKey(data.subarray(312, 344)).toBase58(),
      coinCreatorFee: u(352),
      virtualQuote: null,
      baseSupply: null,
      ixName: null,
    };
    let vq = null;
    if (side === "sell") vq = 392;
    else if (data.length >= 405) {
      const len = data.readUInt32LE(401);
      if (len <= IX_NAME_MAX && data.length >= 405 + len) {
        ev.ixName = data.subarray(405, 405 + len).toString("utf8");
        vq = 405 + len + 32;
      }
    }
    if (vq !== null && data.length >= vq + 16 + 1 + 8) {
      ev.virtualQuote = i128(data, vq);
      ev.baseSupply = u(vq + 17);
    }
    return ev;
  } catch {
    return null;
  }
}

// ---- CreatePoolEvent: the pool's opening reserves (KODING #21b) --------------------------------------
// pump-public-docs idl/pump_amm.json (read 2026-11-17), fixed layout, 344 bytes:
//   discriminator b1310cd2a076a774, timestamp i64 @8, index u16 @16, creator @18, base_mint @50,
//   quote_mint @82, base_mint_decimals u8 @114, quote_mint_decimals u8 @115, base_amount_in u64 @116,
//   quote_amount_in u64 @124, pool_base_amount u64 @132, pool_quote_amount u64 @140,
//   minimum_liquidity @148, initial_liquidity @156, lp_token_amount_out @164, pool_bump u8 @172,
//   pool @173, lp_mint @205, user_base_token_account @237, user_quote_token_account @269,
//   coin_creator @301, is_mayhem_mode bool @333, creator_fee_bps u64 @334, can_edit_creator_fee @342,
//   is_holder_reward @343.
// The event has no virtual quote reserves field: on a pump migration pool_quote_amount is the whole
// effective quote (vault + the virtual part split off right after the create; checked on a real
// migration: 84.990360291 SOL = 67.405854747 vault + 17.584505544 virtual at the first trade).
export const PUMPSWAP_CREATE_POOL_PREFIX = Buffer.from("b1310cd2a076a774", "hex");
export function parsePumpSwapCreatePool(data) {
  if (!data || data.length < 344 || !data.subarray(0, 8).equals(PUMPSWAP_CREATE_POOL_PREFIX)) return null;
  try {
    const u = (o) => data.readBigUInt64LE(o);
    const pk = (o) => new PublicKey(data.subarray(o, o + 32)).toBase58();
    return {
      timestampSec: Number(data.readBigInt64LE(8)),
      index: data.readUInt16LE(16),
      creator: pk(18),
      baseMint: pk(50),
      quoteMint: pk(82),
      baseDecimals: data[114],
      quoteDecimals: data[115],
      baseIn: u(116),
      quoteIn: u(124),
      poolBase: u(132),
      poolQuote: u(140),
      pool: pk(173),
      coinCreator: pk(301),
      isMayhem: data[333] === 1,
    };
  } catch {
    return null;
  }
}

// SOL per whole token (decimals 9 / 6), the unit of the census curve prices:
// (lamports / 1e9) / (raw / 1e6) = lamports / raw * 1e-3.
export function quotePerBase(quoteLamports, baseRaw) {
  const q = Number(quoteLamports);
  const b = Number(baseRaw);
  if (!(b > 0) || !(q > 0)) return null;
  return (q / b) * 1e-3;
}

// Pool price BEFORE and AFTER the trade. The pool's constant product runs on
// (vault + virtual_quote_reserves) x base vault (lib/pumpswap.mjs ammSellQuote reproduces real sales
// to the lamport on exactly that). After the trade:
//   buy:  base - base_amount_out, quote vault + quote_amount_in_with_lp_fee (the lp fee stays in
//         the pool; protocol / creator fees go to their recipients)
//   sell: base + base_amount_in,  quote vault - quote_amount_out_without_lp_fee
// Checked against the next event's own "before" reserves on the live stream (KODING_REPORT_21): the
// base side is always exact; the quote vault is exact in ~80 % of consecutive pairs, in the rest it is
// higher by coin_creator_fee + buyback_fee (+-2 lamports: those fees stay in the vault in some pools,
// and the event does not say which) — a price error <= (those fees) / (vault + virtual), < 0.1 %.
// `quoteAfter` is the vault (real SOL) after the trade, without the virtual part.
export function poolTradePrices(ev) {
  if (!ev || ev.virtualQuote === null) return null;
  const v = ev.virtualQuote > 0n ? ev.virtualQuote : 0n;
  const before = quotePerBase(ev.poolQuote + v, ev.poolBase);
  let baseAfter;
  let quoteAfter;
  if (ev.side === "buy") {
    baseAfter = ev.poolBase - ev.baseAmount;
    quoteAfter = ev.poolQuote + ev.quoteWithLp;
  } else {
    baseAfter = ev.poolBase + ev.baseAmount;
    quoteAfter = ev.poolQuote - ev.quoteWithLp;
  }
  if (baseAfter <= 0n || quoteAfter < 0n) return null;
  const after = quotePerBase(quoteAfter + v, baseAfter);
  if (before === null || after === null) return null;
  return { before, after, quoteBefore: ev.poolQuote, quoteAfter, baseAfter };
}
