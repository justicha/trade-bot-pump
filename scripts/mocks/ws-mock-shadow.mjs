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

// 405-byte trade-v3 payload. shadow.mjs reads: mint 8..40, user 57..89, virtualSol 97,
// virtualToken 105, realSol 113.
function tradePayload({ mint, user, realSol, isBuy = true, ts = 1_760_000_000 }) {
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  decodeB58(mint).copy(buf, 8);
  decodeB58(user).copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(20_000_000), 40); // sol amount (informational)
  buf.writeBigUInt64LE(BigInt(40_000_000_000), 48); // token amount (informational)
  buf[56] = isBuy ? 1 : 0;
  buf.writeBigUInt64LE(BigInt(Math.round(ts)), 89);
  buf.writeBigUInt64LE(BigInt(Math.round(LAUNCH_VSOL + realSol)), 97);
  buf.writeBigUInt64LE(BigInt(V_TOK), 105);
  buf.writeBigUInt64LE(BigInt(Math.round(realSol)), 113);
  return buf;
}

const OK = (signature, logs) => ({ context: { slot: 0 }, value: { signature, err: null, logs } });
const DATA = (p) => `Program data: ${p.toString("base64")}`;

export const FIRST_MINT = fakeKey(101, 7);
export const BAND_MINT = fakeKey(202, 7);
export const HIGH_MINT = fakeKey(303, 7);
export const MULTI_MINT = fakeKey(404, 7);

export function buildNotifications({ scenario = process.env.WS_MOCK_SCENARIO || "single" } = {}) {
  const out = [];
  let seq = 0;
  const push = (mint, fillPct, { delayMs = 60 } = {}) => {
    seq += 1;
    out.push({
      delayMs,
      payload: OK(`sig-shadow-${seq}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Buy",
        DATA(tradePayload({ mint, user: fakeKey(9_000 + seq, 5), realSol: (fillPct / 100) * REAL_SOL_100, ts: 1_760_000_000 + seq * 400 })),
        `Program ${PUMP} success`,
      ]),
    });
  };

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

  push(FIRST_MINT, 93, { delayMs: 120 }); // >= MIN_FILL (92): every variant decides here
  // "flat" stops right here on purpose: no later price event, so the exit price IS the entry price
  // and the gross ratio must be exactly 1 — that is how the buy-slippage accounting is measured.
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
          this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: this.subId, result: n.payload } }));
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
