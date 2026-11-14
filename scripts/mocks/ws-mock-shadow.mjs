// Fixture socket for the graduation shadow lab (WS_MOCK=<this file>): lets the REAL handler in
// bots/graduation-sniper/shadow.mjs run against synthetic pump.fun trade events, with no network.
//
// The trade payload is the 405-byte trade-v3 event the bot parses, and unlike scripts/mocks/
// ws-mock.mjs it also fills `realSolReserves` (offset 113) — that field is what the graduation
// lab turns into a fill percentage, so without it no mint ever becomes a candidate.
//
// Scenario (WS_MOCK_SCENARIO):
//   "single"   — 16 distinct buyers below MIN_FILL, then one 93% buy (all variants enter), then 96%.
//   "reappear" — the same, then three filler mints push mintState past SHADOW_MAX_MINTS, then the
//                first mint trades again: it must NOT be opened a second time.
//
//   "migrate"  — the 93% entry, then a trade that fills the curve to 100%: the curve is finished and
//                the stream goes silent (scripts/gshadow-amm.test.mjs).
//   "live-band" — three mints for the per-variant bands and the event handling:
//                BAND_MINT  6 buyers, the 6th at 80%  -> only variant J (live band 75–90) may open;
//                HIGH_MINT  17 buyers, then 93%       -> A–H open, J must not (above its MAX_FILL);
//                MULTI_MINT ONE transaction with a sell event (60%) and then a buy event (93%):
//                           both events must be processed, and only the buy counts as a holder.
//
//   "stale"    — the 93% entry event carries a timestamp WS_MOCK_STALE_LAG_SEC (default 600) in the
//                past: the backlog a socket delivers after the process stood still. Nothing may open.
//   "stall"    — the 93% entry, the trade that fills the curve to 100%, and then THIS PROCESS IS
//                BLOCKED for WS_MOCK_STALL_MS (default 5000): Atomics.wait on the bot's own event
//                loop (the mock runs inside the bot), which is exactly what a paused console does
//                to console.log. No timer fires and no RPC answer is read meanwhile.
//   "momentum" — MOM_MINT climbs 10% -> 78% within a second (variant L enters); SLOW_MINT goes
//                73% -> 75.5%, waits, and reaches 76% (+3 pp over the window: L must not enter,
//                J does); LATE_MINT 24 buyers then 90% (variant K: fill 88–95, holders >= 20).
//   "entry-lag" — events younger than SHADOW_LATE_SEC but WS_MOCK_ENTRY_LAG_SEC (default 20) old
//                (revision 6, SHADOW_ENTRY_MAX_LAG_SEC): FIRST_MINT 16 fresh buyers, then 93% and,
//                1.5 s later, 94% — both lagged; MOM_MINT 6 lagged buyers 10..60%, then a FRESH 78%
//                (L's momentum history is lagged only); then FIRST_MINT 95% fresh.
//   "features" — revision 7 (scripts/gshadow-rev7.test.mjs): create events (a serial creator, a
//                copycat name), FEAT_MINT traded by its creator, a wash wallet and a whale before
//                the 93% entry, and NOCREATE_MINT whose creator is only in its trade events.
//
// Event timestamps (offset 89, unix seconds) are the wall clock at the moment the notification is
// built: the lab compares them with its own clock and drops stale events.
//
// Fill percentages are of the 85 SOL real graduation reserve (lib/curve.mjs gradFillPct).
import { EventEmitter } from "node:events";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const V_TOK = 1_073_000_000_000_000; // 1.073B whole tokens in raw units
const LAUNCH_VSOL = 30e9; // virtual SOL at launch, in lamports
const REAL_SOL_100 = 85e9; // grading reserve at 100% fill, in lamports

function encodeB58(bytes) {
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

function decodeB58(s) {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros += 1;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = B58.indexOf(s[i]);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < bytes.length && i < 32; i++) out[32 - 1 - i] = bytes[i];
  return out;
}

// Deterministic 32-byte key from a seed, so the same mint/user is reproducible across runs.
function fakeKey(seed, salt = 0) {
  const bytes = Buffer.alloc(32);
  let x = seed * 2654435761 + salt * 40503 + 1;
  for (let i = 0; i < 32; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (x >> 7) & 0xff;
  }
  return encodeB58(bytes);
}

// 405-byte trade-v3 payload. shadow.mjs reads: mint 8..40, sol amount 40..48, user 57..89,
// virtualSol 97, virtualToken 105, realSol 113, and (revision 7, features only) the creator at
// 177..209 (pump.fun IDL TradeEvent: fee_recipient 129, fee_basis_points 161, fee 169, creator 177,
// creator_fee_basis_points 209). Without `creator` the tail stays zero, exactly as before.
const nowSec = () => Math.floor(Date.now() / 1000);
export function tradePayload({ mint, user, realSol, isBuy = true, ts = nowSec(), solLamports = 20_000_000, creator = null }) {
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  decodeB58(mint).copy(buf, 8);
  decodeB58(user).copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(Math.round(solLamports)), 40); // sol amount
  buf.writeBigUInt64LE(BigInt(40_000_000_000), 48); // token amount (informational)
  buf[56] = isBuy ? 1 : 0;
  buf.writeBigUInt64LE(BigInt(Math.round(ts)), 89);
  buf.writeBigUInt64LE(BigInt(Math.round(LAUNCH_VSOL + realSol)), 97);
  buf.writeBigUInt64LE(BigInt(V_TOK), 105);
  buf.writeBigUInt64LE(BigInt(Math.round(realSol)), 113);
  if (creator) {
    buf.writeBigUInt64LE(95n, 161); // fee_basis_points
    decodeB58(creator).copy(buf, 177);
    buf.writeBigUInt64LE(30n, 209); // creator_fee_basis_points
  }
  return buf;
}

// create-v2 payload, serialised like the program does (lib/events.mjs parseCreate): three anchor
// strings (u32 length + utf8), mint, bonding_curve, user, creator, timestamp (s), four u64 reserves.
export function createPayload({ mint, creator, name, symbol, ts = nowSec() }) {
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    return b;
  };
  return Buffer.concat([
    Buffer.from("1b72a94ddeeb6376", "hex"),
    str(name),
    str(symbol),
    str("https://example.invalid/meta.json"),
    decodeB58(mint),
    decodeB58(fakeKey(1, 99)), // bonding curve (not read)
    decodeB58(creator), // user
    decodeB58(creator),
    u64(Math.round(ts)),
    u64(1_073_000_000_000_000n),
    u64(30_000_000_000n),
    u64(793_100_000_000_000n),
    u64(1_000_000_000_000_000n),
    Buffer.from([0, 0]),
  ]);
}

const OK = (signature, logs) => ({ context: { slot: 0 }, value: { signature, err: null, logs } });
const DATA = (p) => `Program data: ${p.toString("base64")}`;

export const FIRST_MINT = fakeKey(101, 7);
export const BAND_MINT = fakeKey(202, 7);
export const HIGH_MINT = fakeKey(303, 7);
export const MULTI_MINT = fakeKey(404, 7);
export const MOM_MINT = fakeKey(505, 7);
export const SLOW_MINT = fakeKey(606, 7);
export const LATE_MINT = fakeKey(707, 7);
// "features" (revision 7): who is behind the token.
export const FEAT_MINT = fakeKey(808, 7);
export const COPY_MINT = fakeKey(909, 7);
export const SERIAL_MINT = fakeKey(1010, 7);
export const NOCREATE_MINT = fakeKey(1111, 7);
export const CREATOR = fakeKey(8_888, 1);
export const OTHER_CREATOR = fakeKey(8_889, 1);
export const TRADE_CREATOR = fakeKey(8_890, 1);
export const WASH = fakeKey(8_891, 1);
export const WHALE = fakeKey(8_892, 1);
export const FEAT_ENTRY_BUYER = fakeKey(8_893, 1);

export function buildNotifications({ scenario = process.env.WS_MOCK_SCENARIO || "single" } = {}) {
  const out = [];
  let seq = 0;
  // A notification with one create-v2 event (revision 7 features). `ageSec`: its on-chain time.
  const pushCreate = (mint, creator, name, symbol, { delayMs = 60, ageSec = 0 } = {}) => {
    seq += 1;
    const n = seq;
    out.push({
      delayMs,
      payload: () => OK(`sig-shadow-${n}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Create",
        DATA(createPayload({ mint, creator, name, symbol, ts: nowSec() - ageSec })),
        `Program ${PUMP} success`,
      ]),
    });
  };
  // A trade with a chosen wallet, side, size and creator field.
  const pushTrade = (mint, fillPct, { user, isBuy = true, sol = 0.02, creator = null, delayMs = 60 } = {}) => {
    seq += 1;
    const n = seq;
    out.push({
      delayMs,
      payload: () => OK(`sig-shadow-${n}`, [
        `Program ${PUMP} invoke [1]`,
        `Program log: Instruction: ${isBuy ? "Buy" : "Sell"}`,
        DATA(tradePayload({ mint, user, isBuy, realSol: (fillPct / 100) * REAL_SOL_100, solLamports: sol * 1e9, creator })),
        `Program ${PUMP} success`,
      ]),
    });
  };
  // The payload is built when the notification is SENT (a function), so its timestamp is the
  // wall clock of that moment, minus `lagSec` for the stale-backlog scenario.
  const push = (mint, fillPct, { delayMs = 60, lagSec = 0, blockMs = 0 } = {}) => {
    seq += 1;
    const n = seq;
    out.push({
      delayMs,
      blockMs,
      payload: () => OK(`sig-shadow-${n}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Buy",
        DATA(tradePayload({ mint, user: fakeKey(9_000 + n, 5), realSol: (fillPct / 100) * REAL_SOL_100, ts: nowSec() - lagSec })),
        `Program ${PUMP} success`,
      ]),
    });
  };

  if (scenario === "features") {
    // Creates (on-chain ages in the past): FEAT_MINT "Solana AI" by CREATOR 100 s ago; a copycat
    // "SOLANA  ai!" by another wallet 50 s ago (same normalized name); the copycat's twin 2 h ago
    // (outside the 30 min window); two more launches by CREATOR, 1 h and 25 h ago (only the first
    // is inside 24 h).
    pushCreate(fakeKey(1313, 7), CREATOR, "Old", "OLD", { ageSec: 90_000 });
    pushCreate(fakeKey(1212, 7), OTHER_CREATOR, "Solana AI", "SAI", { ageSec: 7200 });
    pushCreate(SERIAL_MINT, CREATOR, "Other", "OTH", { ageSec: 3600 });
    pushCreate(FEAT_MINT, CREATOR, "Solana AI", "SAI", { ageSec: 100 });
    pushCreate(COPY_MINT, OTHER_CREATOR, "SOLANA  ai!", "SAI2", { ageSec: 50 });
    // FEAT_MINT: the creator buys 1 SOL, 15 wallets buy 0.5 SOL, a wash wallet trades 10 times
    // (2 SOL each, buy/sell), the creator sells 0.4 SOL, a whale sells 3 SOL, then the 93% entry.
    const c = { creator: CREATOR };
    pushTrade(FEAT_MINT, 5, { user: CREATOR, sol: 1, ...c });
    for (let i = 1; i <= 15; i++) pushTrade(FEAT_MINT, 5 + i * 5, { user: fakeKey(8_000 + i, 2), sol: 0.5, ...c });
    for (let i = 0; i < 10; i++) pushTrade(FEAT_MINT, 81 + i * 0.25, { user: WASH, isBuy: i % 2 === 0, sol: 2, ...c, delayMs: 20 });
    pushTrade(FEAT_MINT, 85, { user: CREATOR, isBuy: false, sol: 0.4, ...c });
    pushTrade(FEAT_MINT, 84, { user: WHALE, isBuy: false, sol: 3, ...c });
    pushTrade(FEAT_MINT, 93, { user: FEAT_ENTRY_BUYER, sol: 0.3, ...c, delayMs: 120 }); // A–H + J open here
    // NOCREATE_MINT: no create seen; the trade events carry the creator (fallback source "trade").
    for (let i = 1; i <= 8; i++) pushTrade(NOCREATE_MINT, i * 10, { user: fakeKey(8_100 + i, 2), sol: 0.1, creator: TRADE_CREATOR });
    pushTrade(NOCREATE_MINT, 93, { user: fakeKey(8_200, 2), sol: 0.1, creator: TRADE_CREATOR, delayMs: 120 });
    pushTrade(FEAT_MINT, 96, { user: fakeKey(8_201, 2), sol: 0.2, ...c, delayMs: 120 }); // a later price
    return out;
  }

  if (scenario === "momentum") {
    for (let i = 1; i <= 6; i++) push(MOM_MINT, i * 10); // 6 buyers, 10..60% within half a second
    push(MOM_MINT, 78, { delayMs: 120 }); // +68 pp inside the window: L enters
    for (let i = 0; i < 6; i++) push(SLOW_MINT, 73 + i * 0.5); // 6 buyers, 73..75.5%: +2.5 pp at most
    push(SLOW_MINT, 76, { delayMs: 2600 }); // 2.6 s later (window 2 s): +3 pp over the window
    for (let i = 1; i <= 24; i++) push(LATE_MINT, i * 3); // 24 buyers, 3..72%
    push(LATE_MINT, 90, { delayMs: 120 }); // 25 holders at 90%: K's band
    return out;
  }

  if (scenario === "live-band") {
    for (let i = 1; i <= 5; i++) push(BAND_MINT, i * 10); // 5 buyers, 10..50%
    push(BAND_MINT, 80, { delayMs: 120 }); // the 6th buyer, inside 75–90
    for (let i = 1; i <= 16; i++) push(HIGH_MINT, i * 4); // 16 buyers, 4..64%
    push(HIGH_MINT, 93, { delayMs: 120 }); // above J's MAX_FILL, inside the lab's 92+
    // One transaction, two trade events of the same mint: a SELL at 60% and then a BUY at 93%.
    // The instruction log says "Buy" for the whole tx on purpose: the holder count must follow each
    // event's own is_buy flag.
    seq += 1;
    out.push({
      delayMs: 120,
      payload: OK(`sig-shadow-${seq}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Buy",
        DATA(tradePayload({ mint: MULTI_MINT, user: fakeKey(7_001, 5), realSol: 0.6 * REAL_SOL_100, isBuy: false })),
        DATA(tradePayload({ mint: MULTI_MINT, user: fakeKey(7_002, 5), realSol: 0.93 * REAL_SOL_100, isBuy: true })),
        `Program ${PUMP} success`,
      ]),
    });
    return out;
  }

  // 16 distinct buyers below MIN_FILL: the mint accumulates holders without entering, which is what
  // lets the holder-gated variants (B 7, C 15, G 7) open on the crossing event.
  for (let i = 1; i <= 16; i++) push(FIRST_MINT, i * 5);

  if (scenario === "entry-lag") {
    const lagSec = Number(process.env.WS_MOCK_ENTRY_LAG_SEC || 20);
    push(FIRST_MINT, 93, { delayMs: 120, lagSec }); // in the buy band, but lagged
    push(FIRST_MINT, 94, { delayMs: 1500, lagSec }); // lagged again, after the first report
    for (let i = 1; i <= 6; i++) push(MOM_MINT, i * 10, { lagSec }); // lagged momentum history
    push(MOM_MINT, 78, { delayMs: 120 }); // fresh, in L's band
    push(FIRST_MINT, 95, { delayMs: 1500 }); // fresh: whoever has not entered may enter now
    return out;
  }
  if (scenario === "stale") {
    push(FIRST_MINT, 93, { delayMs: 120, lagSec: Number(process.env.WS_MOCK_STALE_LAG_SEC || 600) });
    return out;
  }
  push(FIRST_MINT, 93, { delayMs: 120 }); // >= MIN_FILL (92): every variant decides here
  // "flat" stops right here on purpose: no later price event, so the exit price IS the entry price
  // and the gross ratio must be exactly 1 — that is how the buy-slippage accounting is measured.
  if (scenario === "stall") {
    push(FIRST_MINT, 100, { delayMs: 120, blockMs: Number(process.env.WS_MOCK_STALL_MS || 5000) });
    return out;
  }
  if (scenario === "migrate") {
    push(FIRST_MINT, 100, { delayMs: 120 }); // the trade that completes the curve; nothing follows
    return out;
  }
  if (scenario !== "flat") push(FIRST_MINT, 96, { delayMs: 120 }); // a later price, so the exit is not exactly at entry

  if (scenario === "reappear") {
    // Three mints that never reach MIN_FILL: they only occupy mintState, so the cap is exceeded.
    // The first one is late on purpose: with SHADOW_HOLD_SEC=1 the position opened above has
    // already closed by timeout, which is what makes the spent mint evictable.
    for (let i = 0; i < 3; i++) push(fakeKey(500 + i, 3), 10 + i, { delayMs: i === 0 ? 2500 : 80 });
    // Late enough for at least one 1s timer tick to have pruned the spent first mint.
    push(FIRST_MINT, 98, { delayMs: 1600 });
  }
  return out;
}

export class MockSocket extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.readyState = 1; // OPEN
    this.subId = 0;
    this.timers = [];
    this.notifications = opts.notifications || buildNotifications();
    setTimeout(() => this.emit("open"), 0);
  }

  send(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method && typeof msg.id === "number") {
      this.subId += 1;
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: this.subId }));
      if (msg.method === "logsSubscribe") this._schedule();
    }
  }

  _schedule() {
    let acc = 200;
    for (const n of this.notifications) {
      acc += n.delayMs;
      this.timers.push(
        setTimeout(() => {
          const result = typeof n.payload === "function" ? n.payload() : n.payload;
          this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: this.subId, result } }));
          // "stall": freeze the whole process, the way a blocked console write does.
          if (n.blockMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n.blockMs);
        }, acc),
      );
    }
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.readyState = 3; // CLOSED
    setTimeout(() => this.emit("close"), 0);
  }
}

export function createSocket(url) {
  return new MockSocket(url);
}
