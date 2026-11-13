// pump.fun event decoding, shared by the bots and the validation tooling.
//
// The V3 trade event (prefix bddb7fd34ee661ee) layout, verified field by field:
//   0..8    discriminator
//   8..40   mint
//   40..48  sol_amount        (lamports)
//   48..56  token_amount      (raw units, 1e6 = 1 token)
//   56       is_buy           (bool)
//   57..89  user
//   89..97  timestamp         (ms)          — only present when len >= 97
//   97..105 virtual_sol_reserves            — only present when len >= 113
//   105..113 virtual_token_reserves
//   113..121 real_sol_reserves              — only present when len >= 129
//   121..129 real_token_reserves
//
// Older/newer payload variants exist (88/89/113/129 bytes), so every field is read only when
// the buffer is long enough. Nothing here throws on short or unknown payloads.
// Instruction-name sets for the tx-wide hint in parseLogEvents (the payload byte remains primary).
import { BUY_INSTRUCTIONS, SELL_INSTRUCTIONS } from "./constants.mjs";

export const EVENT_PREFIXES = {
  bddb7fd34ee661ee: "trade-v3",
  "1b72a94ddeeb6376": "create-v2",
  "67f4521f2cf57777": "pumpswap-trade",
  "3e2f370aa503dc2a": "pumpswap-fee",
  e445a52e51cb9a1d: "trade-v2-legacy",
};

const TRADE_V3 = "bddb7fd34ee661ee";

export function prefixHex(data) {
  return data.length >= 8 ? data.subarray(0, 8).toString("hex") : "";
}

// { prefix, type, len } — for histograms and unknown-payload triage.
export function describe(data) {
  const prefix = prefixHex(data);
  return { prefix, type: EVENT_PREFIXES[prefix] || "unknown", len: data.length };
}

// Raw reserves -> usability. A pump.fun curve can never have 0 lamports of virtual SOL.
// Measured on live data (scripts/dump-layout.mjs, exact byte match against the on-chain
// account): payloads of length 390/391/403/405/425/439 DO carry the reserves at 97/105.
// Payloads of length 401 carry the same structure but with ZERO reserves (no snapshot), so they
// cannot be priced and the caller must fall back to the last known price.
export function reservesOf(data) {
  if (data.length < 113) return null;
  const vSol = data.readBigUInt64LE(97);
  const vTok = data.readBigUInt64LE(105);
  if (vSol === 0n || vTok === 0n) return { vSol, vTok, realSol: null, realTok: null, usable: false };
  return {
    vSol,
    vTok,
    realSol: data.length >= 121 ? data.readBigUInt64LE(113) : null,
    realTok: data.length >= 129 ? data.readBigUInt64LE(121) : null,
    usable: true,
  };
}

// Parsed trade payload (any length >= 89). `reserves` is null when the buffer is too short and
// `reserves.usable === false` when the payload has no reserve snapshot.
export function parseTrade(data) {
  if (data.length < 89) return null;
  if (prefixHex(data) !== TRADE_V3) return null;
  const mint = data.subarray(8, 40);
  const user = data.subarray(57, 89);
  const reserves = reservesOf(data);
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  return {
    prefix: TRADE_V3,
    len: data.length,
    mintBytes: mint,
    userBytes: user,
    mint: toBase58Safe(mint),
    user: toBase58Safe(user),
    solAmount,
    tokenAmount,
    // The price the trade ACTUALLY executed at: SOL paid per whole token. This is independent of
    // the reserve snapshot, and it is the only price that stays trustworthy for payloads whose
    // virtual_sol_reserves does not belong to the same curve point (see diag-390: 84-165x the
    // trade amount on one router's legacy Buy/Sell). For every other payload it agrees with
    // vSol/vTok to well under 1%.
    tradePriceSol: tokenAmount > 0 && solAmount > 0 ? solAmount / tokenAmount : null,
    // is_buy lives in the payload (byte 56). Measured against the instruction name on 3090 live
    // events it disagreed 2 times, so the byte is the primary source and the instruction name
    // only a fallback. Callers can pass their own hint and see both values.
    isBuyByte: data[56] === 1,
    isBuy: data[56] === 1,
    timestampMs: data.length >= 97 ? Number(data.readBigUInt64LE(89)) : null,
    reserves,
    hasReserves: Boolean(reserves && reserves.usable),
  };
}

// Direction with the payload byte preferred over the instruction name.
export function tradeDirection(ev, instructionIsBuy = null) {
  if (!ev) return null;
  if (ev.isBuyByte !== null && ev.isBuyByte !== undefined) {
    if (instructionIsBuy !== null && instructionIsBuy !== ev.isBuyByte) {
      return { isBuy: ev.isBuyByte, disagreed: true, instructionIsBuy };
    }
    return { isBuy: ev.isBuyByte, disagreed: false, instructionIsBuy };
  }
  return { isBuy: instructionIsBuy, disagreed: false, instructionIsBuy };
}

// Parse one pump.fun transaction's log lines into `{type:"trade"|"create"}` events (C4/C1).
//   - trade direction comes from the payload's is_buy byte (primary); the tx-wide instruction-name
//     hint is kept as `instructionIsBuy` and a disagreement is logged (2/3090 measured).
//   - create events come from the CreateV2 payload's `creator` field — NOT from the first trade's
//     user. A CreateV2 tx with no trade event still yields its create (the old parsers dropped it).
// Reserve fields are flattened (virtualSolReserves/.../realTokenReserves) so bot call sites keep
// their current shapes; a short payload simply has them undefined.
export function parseLogEvents(logs, { log } = {}) {
  let instructionIsBuy = null;
  for (const line of logs) {
    if (typeof line !== "string") continue;
    const m = /Instruction: (\w+)/.exec(line);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) { instructionIsBuy = true; break; }
    if (SELL_INSTRUCTIONS.has(m[1])) { instructionIsBuy = false; break; }
  }
  const events = [];
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8) continue;
    const prefix = prefixHex(raw);
    if (prefix === TRADE_V3) {
      const t = parseTrade(raw);
      if (!t) continue;
      const dir = tradeDirection(t, instructionIsBuy);
      if (dir.disagreed && log) {
        log(`[parse] trade direction: payload byte=${dir.isBuy ? "buy" : "sell"} vs instruction=${dir.instructionIsBuy ? "buy" : "sell"}`);
      }
      events.push({
        type: "trade",
        ...t,
        isBuy: dir.isBuy,
        instructionIsBuy: dir.instructionIsBuy,
        virtualSolReserves: t.reserves ? t.reserves.vSol : undefined,
        virtualTokenReserves: t.reserves ? t.reserves.vTok : undefined,
        realSolReserves: t.reserves ? t.reserves.realSol : undefined,
        realTokenReserves: t.reserves ? t.reserves.realTok : undefined,
      });
    } else if (prefix === CREATE_V2) {
      const c = parseCreate(raw);
      if (!c) continue;
      events.push({
        type: "create",
        mint: c.mint,
        creator: c.creator,
        bondingCurve: c.bondingCurve,
        launchParamsOk: c.launchParamsOk,
        // The create's own on-chain time (unix seconds): lets a bot tell a fresh launch from the
        // backlog a socket hands over after the process stood still (lib/stall-guard.mjs).
        timestampSec: c.timestampSec,
        ts: Date.now(),
      });
    }
  }
  return events;
}


// Minimal base58 encoder so this module stays dependency-free (the bots import bs58 already,
// but the validator and the tests should be able to run without it).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function toBase58Safe(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}


// ---- create-v2 ---------------------------------------------------------------
const CREATE_V2 = "1b72a94ddeeb6376";

// Anchor struct: discriminator, then String fields are u32 length + utf8 bytes, so the payload
// length varies with the token name/symbol/uri (measured: 343-367 bytes).
// Layout verified on 216 live payloads: the four reserve fields come out as exactly the
// documented pump.fun launch start (1.073e15 virtual tokens, 30 SOL virtual, 793.1e12 real
// tokens, 1e15 supply) — the parser is anchored on numbers, not on a guessed offset.
//   name, symbol, uri                     (String)
//   mint, bonding_curve, user, creator    (32 bytes each)
//   timestamp (u64, seconds)
//   virtual_token_reserves, virtual_sol_reserves, real_token_reserves, token_total_supply (u64)
//   tail: variable-length flags/extra fields, kept raw (the mayhem flag is validated against the
//   curve account by scripts/mayhem-report.mjs instead of being guessed here)
export const LAUNCH_RESERVES = {
  vTok: 1_073_000_000_000_000n,
  vSol: 30_000_000_000n,
  rTok: 793_100_000_000_000n,
  supply: 1_000_000_000_000_000n,
};

export function parseCreate(data) {
  if (!data || data.length < 8 + 12 + 32 * 4 + 8 * 5) return null;
  if (prefixHex(data) !== CREATE_V2) return null;
  try {
    let o = 8;
    const str = () => {
      const len = data.readUInt32LE(o);
      o += 4;
      if (len > 512) throw new Error("implausible string length");
      const s = data.subarray(o, o + len).toString("utf8");
      o += len;
      return s;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    const mint = toBase58Safe(data.subarray(o, o + 32));
    o += 32;
    const bondingCurve = toBase58Safe(data.subarray(o, o + 32));
    o += 32;
    const user = toBase58Safe(data.subarray(o, o + 32));
    o += 32;
    const creator = toBase58Safe(data.subarray(o, o + 32));
    o += 32;
    const timestampSec = Number(data.readBigUInt64LE(o));
    o += 8;
    const vTok = data.readBigUInt64LE(o);
    o += 8;
    const vSol = data.readBigUInt64LE(o);
    o += 8;
    const rTok = data.readBigUInt64LE(o);
    o += 8;
    const supply = data.readBigUInt64LE(o);
    o += 8;
    return {
      prefix: CREATE_V2,
      len: data.length,
      name,
      symbol,
      uri,
      mint,
      bondingCurve,
      user,
      creator,
      timestampSec,
      reserves: { vTok, vSol, rTok, supply },
      // Launch-parameter check: a create payload that does not carry the documented start
      // reserves is a different layout, so callers fall back to the account anchor.
      launchParamsOk:
        vTok === LAUNCH_RESERVES.vTok &&
        vSol === LAUNCH_RESERVES.vSol &&
        rTok === LAUNCH_RESERVES.rTok &&
        supply === LAUNCH_RESERVES.supply,
      tail: data.subarray(o),
      tailHex: data.subarray(o).toString("hex"),
    };
  } catch {
    return null; // a malformed create must never throw
  }
}
