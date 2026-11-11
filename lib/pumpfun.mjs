import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ATA_PROGRAM,
  PUMP_EVENT_AUTH,
  PUMP_FEE_CONFIG,
  PUMP_FEE_PROGRAM,
  PUMP_FEE_RECIPIENT_FALLBACK,
  PUMP_GLOBAL,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL,
} from "./constants.mjs";
import { connection, rpcCall } from "./rpc.mjs";
import { CURVE_CACHE_MS } from "./config.mjs";
import { toBase58Safe } from "./events.mjs";

// D13: caches to cut redundant work / RPC. Keyed by mint (base58), capped in size so a
// long-running bot watching many mints can't grow memory without bound.
const CACHE_CAP = 5000;
function cacheSet(map, key, val) {
  map.set(key, val);
  if (map.size > CACHE_CAP) map.delete(map.keys().next().value); // evict oldest (insertion order)
}

// pump.fun bonding curve PDA (deterministic — cached per mint)
const _bcCache = new Map();
export function getBondingCurve(mint) {
  const key = mint.toBase58();
  let bc = _bcCache.get(key);
  if (!bc) {
    bc = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PUMP_PROGRAM,
    )[0];
    cacheSet(_bcCache, key, bc);
  }
  return bc;
}

// Associated bonding curve token account (Token-2022) — deterministic, cached per mint
const _bcAtaCache = new Map();
export function getBondingCurveATA(bondingCurve, mint) {
  const key = mint.toBase58();
  let ata = _bcAtaCache.get(key);
  if (!ata) {
    ata = getAssociatedTokenAddressSync(mint, bondingCurve, true, TOKEN_2022_PROGRAM);
    cacheSet(_bcAtaCache, key, ata);
  }
  return ata;
}

// Fetch bonding curve state, memoized for `ttlMs` (D13). Pass ttlMs=0 to bypass the cache.
const _stateCache = new Map();
export async function getBondingCurveState(mint, ttlMs = CURVE_CACHE_MS, priority = 3) {
  const key = mint.toBase58();
  if (ttlMs > 0) {
    const hit = _stateCache.get(key);
    if (hit && Date.now() - hit.ts < ttlMs) return hit.state;
  }
  const bc = getBondingCurve(mint);
  const info = await rpcCall(() => connection.getAccountInfo(bc), { priority });
  let state = null;
  if (info && info.data.length >= 73) {
    const d = info.data;
    // offset 8: discriminator already skipped by anchor
    // Layout: virtualTokenReserves (u64), virtualSolReserves (u64), realTokenReserves (u64), realSolReserves (u64), tokenTotalSupply (u64), complete (bool)
    // Layout (verified against live accounts, len 166):
    //   8 virtualTokenReserves, 16 virtualSolReserves, 24 realTokenReserves,
    //   32 realSolReserves, 40 tokenTotalSupply, 48 complete (bool),
    //   49..81 creator (pubkey), 81 is_mayhem_mode (bool), 82.. padding
    state = {
      address: bc,
      virtualTokenReserves: d.readBigUInt64LE(8),
      virtualSolReserves: d.readBigUInt64LE(16),
      realTokenReserves: d.readBigUInt64LE(24),
      realSolReserves: d.readBigUInt64LE(32),
      tokenTotalSupply: d.readBigUInt64LE(40),
      complete: d[48] === 1,
      creator: d.length >= 81 ? toBase58Safe(d.subarray(49, 81)) : null,
      isMayhemMode: d.length >= 82 ? d[81] === 1 : null,
    };
  }
  // D13: never cache a null (missing curve) result.
  if (ttlMs > 0 && state) cacheSet(_stateCache, key, { ts: Date.now(), state });
  return state;
}

// SOL per RAW unit (1e6 raw = 1 token, 1e9 lamports = 1 SOL) — the raw reserve ratio vSol/vTok.
// This is NOT a whole-token price: a whole token costs 1000x less (SOL-per-raw * 1e-3). Use
// lib/curve.mjs metricsOf(state).price (or rawSolPerTokenToWhole) for a human price; getPrice stays
// the raw ratio so internal ratio math (price / entryPrice) remains unit-consistent.
export function getPrice(state) {
  return Number(state.virtualSolReserves) / Number(state.virtualTokenReserves);
}

// SOL amount -> lamports without float drift (0.07 * 1e9 is 69999999.99999999 in a double).
export function solToLamports(sol) {
  if (typeof sol === "bigint") return sol;
  return BigInt(Math.round(Number(sol) * 1e9));
}

// Calculate tokens received for a given SOL amount (buy)
export function calcBuyTokens(state, solAmount) {
  const solLamports = solToLamports(solAmount);
  const fee = solLamports / 100n; // 1% fee
  const netSol = solLamports - fee;
  const tokens =
    (state.virtualTokenReserves * netSol) / (state.virtualSolReserves + netSol);
  return tokens;
}

// Full sell quote with the split the program uses: gross from the curve, then the 1% fee.
// The GROSS is what leaves the curve's reserves — that is the number to compare with
// realSolReserves before sending (a net-only check underestimates the payout).
export function calcSellQuote(state, tokenAmount) {
  const amount = typeof tokenAmount === "bigint" ? tokenAmount : BigInt(Math.trunc(Number(tokenAmount)));
  const gross = (state.virtualSolReserves * amount) / (state.virtualTokenReserves + amount);
  const fee = gross / 100n; // 1% fee
  return { gross, fee, net: gross - fee };
}

// Calculate SOL received for a given token amount (sell)
export function calcSellSol(state, tokenAmount) {
  const sol =
    (state.virtualSolReserves * tokenAmount) / (state.virtualTokenReserves + tokenAmount);
  const fee = sol / 100n; // 1% fee
  return sol - fee;
}

// --- Global fee/buyback state ---------------------------------------------------------------
// pump.fun rotates the fee recipient and the buyback recipient; both live in the `global`
// account. Read it once at startup (and refresh on long-running bots) so buy/sell use live
// values instead of a hardcoded wallet.
let _globalFeeState = null;

export async function refreshGlobalFeeState() {
  // Throttled and retried like every other RPC call. This used to be a single unthrottled read: one
  // transient 429/timeout made every later buy fall back to a stale fee recipient.
  const info = await rpcCall(() => connection.getAccountInfo(PUMP_GLOBAL), { priority: 1, retries: 3 });
  if (!info || info.data.length < 1088) throw new Error("pump global account unavailable/short");
  const d = info.data;
  const at = (o) => new PublicKey(d.subarray(o, o + 32));
  _globalFeeState = {
    feeRecipient: at(41),
    feeRecipients: Array.from({ length: 7 }, (_, i) => at(162 + i * 32)),
    reservedFeeRecipient: at(483),
    reservedFeeRecipients: Array.from({ length: 7 }, (_, i) => at(516 + i * 32)),
    buybackFeeRecipients: Array.from({ length: 8 }, (_, i) => at(741 + i * 32)),
    ts: Date.now(),
  };
  return _globalFeeState;
}

export function getGlobalFeeState() {
  return _globalFeeState;
}

// The startup read can still fail (a transient RPC error). The buy path calls this before building
// a transaction, so a stale fee recipient is never used when one retry can fix it. Cached: at most
// one extra RPC per process.
export async function ensureGlobalFeeState() {
  return _globalFeeState ?? refreshGlobalFeeState();
}

function feeStateOrFallback() {
  return (
    _globalFeeState || {
      feeRecipient: PUMP_FEE_RECIPIENT_FALLBACK,
      feeRecipients: [],
      reservedFeeRecipient: PUMP_FEE_RECIPIENT_FALLBACK,
      reservedFeeRecipients: [],
      buybackFeeRecipients: [],
    }
  );
}

// Random pick from the correct list (mirrors pump-sdk `getFeeRecipient`): mayhem coins use the
// reserved recipients, everything else the normal recipients.
function pickFeeRecipient(fs, isMayhem) {
  const list = isMayhem
    ? [fs.reservedFeeRecipient, ...fs.reservedFeeRecipients]
    : [fs.feeRecipient, ...fs.feeRecipients];
  const usable = list.filter((k) => k && !k.equals(PublicKey.default));
  if (!usable.length) return fs.feeRecipient;
  return usable[Math.floor(Math.random() * usable.length)];
}

// `bonding-curve-v2` PDA: a trailing readonly account required by current buy/sell.
const _bcV2Cache = new Map();
export function getBondingCurveV2(mint) {
  const key = mint.toBase58();
  let v2 = _bcV2Cache.get(key);
  if (!v2) {
    v2 = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve-v2"), mint.toBuffer()],
      PUMP_PROGRAM,
    )[0];
    cacheSet(_bcV2Cache, key, v2);
  }
  return v2;
}

// creator_vault PDA = ["creator-vault", bonding_curve.creator] under pump.fun.
const _vaultCache = new Map();
export function getCreatorVault(creator) {
  const key = creator.toBase58();
  let vault = _vaultCache.get(key);
  if (!vault) {
    vault = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), creator.toBuffer()],
      PUMP_PROGRAM,
    )[0];
    cacheSet(_vaultCache, key, vault);
  }
  return vault;
}

// The current `buy` requires `associated_user` to already exist, so create it idempotently in
// the same transaction (no-op when it is already there).
export function userAtaIx(user, mint) {
  const ata = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM);
  return createAssociatedTokenAccountIdempotentInstruction(user, ata, user, mint, TOKEN_2022_PROGRAM);
}

// Current `buy` (sha256("global:buy")[0..8] = 66063d1201daebea).
// 16 accounts from the official IDL, plus the 2 buyback accounts the deployed program also wants.
// opts: { creator (required), feeRecipient?, buybackFeeRecipient? }
export function buyIx(user, mint, solAmount, minTokens, opts = {}) {
  if (!opts.creator) {
    throw new Error("buyIx: opts.creator is required (needed for the creator_vault account)");
  }
  const bc = getBondingCurve(mint);
  const bcAta = getBondingCurveATA(bc, mint);
  const userAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM);
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    PUMP_PROGRAM,
  );
  const fs = feeStateOrFallback();
  const feeRecipient = opts.feeRecipient ?? pickFeeRecipient(fs, !!opts.isMayhem);
  const buyback = opts.buybackFeeRecipient ?? fs.buybackFeeRecipients?.[0] ?? null;

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bc, isSigner: false, isWritable: true },
    { pubkey: bcAta, isSigner: false, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: getCreatorVault(opts.creator), isSigner: false, isWritable: true },
    { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
  ];
  keys.push({ pubkey: getBondingCurveV2(mint), isSigner: false, isWritable: false });
  if (buyback) {
    keys.push({ pubkey: buyback, isSigner: false, isWritable: true });
  }

  const disc = Buffer.from("66063d1201daebea", "hex"); // sha256("global:buy")[0..8]
  const data = Buffer.alloc(26); // disc + amount(u64) + max_sol_cost(u64) + OptionBool(false)×2
  disc.copy(data, 0);
  // NOTE (audit BUG 08): per the official IDL `amount` is the TOKEN amount to buy and
  // `max_sol_cost` is the SOL ceiling. So the bot buys exactly `minTokens` (the quote reduced by
  // the slippage) and normally spends LESS than the nominal buy size — which is why the entry must
  // be taken from readExecution, never from BUY_SOL. NOT verified on-chain yet
  // (scripts/verify-buy-semantics.mjs, read-only simulations). The instruction bytes are FROZEN
  // until that verification; scripts/buyix-layout.test.mjs pins the current layout.
  data.writeBigUInt64LE(minTokens, 8);
  // max_sol_cost: without headroom ANY upward move of the curve between quote and landing makes
  // the buy fail with Custom 6002 (TooMuchSolRequired). Callers pass a slippage-padded cap.
  // Default uses solToLamports (round, not floor): floor() could leave a 1-lamport-short cap for
  // values like 0.001 / 0.07 that don't represent exactly in a double (M1).
  data.writeBigUInt64LE(opts.maxSolCost ?? solToLamports(solAmount), 16);
  data[24] = 1; // OptionBool track_volume = Some(true)
  data[25] = 0; // OptionBool partial_fill = Some(false)

  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data });
}

// Current `sell` (sha256("global:sell")[0..8] = 33e685a4017f83ad).
// 14 accounts per the official IDL: creator_vault comes BEFORE token_program.
// opts: { creator (required), feeRecipient? }
export function sellIx(user, mint, tokenAmount, minSol, opts = {}) {
  if (!opts.creator) {
    throw new Error("sellIx: opts.creator is required (needed for the creator_vault account)");
  }
  const bc = getBondingCurve(mint);
  const bcAta = getBondingCurveATA(bc, mint);
  const userAta = getAssociatedTokenAddressSync(mint, user, false, TOKEN_2022_PROGRAM);
  const fs = feeStateOrFallback();
  const feeRecipient = opts.feeRecipient ?? pickFeeRecipient(fs, !!opts.isMayhem);
  const buyback = opts.buybackFeeRecipient ?? fs.buybackFeeRecipients?.[0] ?? null;

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: true },
    { pubkey: feeRecipient, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bc, isSigner: false, isWritable: true },
    { pubkey: bcAta, isSigner: false, isWritable: true },
    { pubkey: userAta, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: getCreatorVault(opts.creator), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTH, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: getBondingCurveV2(mint), isSigner: false, isWritable: false },
  ];
  if (buyback) {
    keys.push({ pubkey: buyback, isSigner: false, isWritable: true });
  }

  const disc = Buffer.from("33e685a4017f83ad", "hex"); // sha256("global:sell")[0..8]
  const data = Buffer.alloc(24);
  disc.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minSol, 16);

  return new TransactionInstruction({ programId: PUMP_PROGRAM, keys, data });
}
