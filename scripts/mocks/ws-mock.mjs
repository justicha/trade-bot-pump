// Fixture socket for scripts/smoke.test.mjs: replays a synthetic pump.fun stream through the REAL
// notification handler in bots/sniper/sniper.mjs (WS_MOCK=<this file>).
//
// The stream is: 3 creates, 5 buys each from 5 distinct wallets in 2 slots (so the holder gate
// fires), then a sell. Every trade payload is a 405-byte trade-v3 event; the last buys of each
// token come through a Mayhem CPI so the isMayhem path is exercised too. Log lines are shaped
// exactly like the real ones: invoke / "Program log: Instruction: X" / "Program data:" / success.
import { EventEmitter } from "node:events";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MAYHEM = "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const V_TOK = 1_073_000_000_000_000;

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

// Deterministic, realistic-looking 32-byte key from a seed.
function fakeKey(seed, salt = 0) {
  const bytes = Buffer.alloc(32);
  let x = seed * 2654435761 + salt * 40503 + 1;
  for (let i = 0; i < 32; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (x >> 7) & 0xff;
  }
  return encodeB58(bytes);
}

// 405-byte trade-v3 payload: discriminator, mint, sol, token, isBuy, user, ts, reserves.
function tradePayload({ mint, user, sol, token, isBuy, ts, vSol, vTok }) {
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  decodeB58(mint).copy(buf, 8);
  decodeB58(user).copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(Math.round(sol * 1e9)), 40);
  buf.writeBigUInt64LE(BigInt(Math.round(token * 1e6)), 48);
  buf[56] = isBuy ? 1 : 0;
  buf.writeBigUInt64LE(BigInt(Math.round(ts)), 89);
  buf.writeBigUInt64LE(BigInt(Math.round(vSol)), 97);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok)), 105);
  return buf;
}

const OK = (signature, logs) => ({ context: { slot: 0 }, value: { signature, err: null, logs } });
const DATA = (p) => `Program data: ${p.toString("base64")}`;

export function buildNotifications({ mints = 3, buysPerMint = 5, startTs = Date.now() } = {}) {
  const out = [];
  let slot = 466_900_000;
  let ts = startTs;
  for (let m = 1; m <= mints; m++) {
    const mint = fakeKey(100 + m, 7);
    const vTok = V_TOK;
    const vSol = 30_000_000_000 + m * 2_000_000_000;
    out.push({
      delayMs: 150,
      payload: OK(`sig-create-${m}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Create",
        DATA(tradePayload({ mint, user: fakeKey(m, 1), sol: 0, token: 0, isBuy: true, ts, vSol, vTok })),
        `Program ${PUMP} success`,
      ]),
    });
    for (let i = 0; i < buysPerMint; i++) {
      ts += 400;
      slot += i % 2; // buyers land in two different slots, so the organic gate can fire
      const user = fakeKey(m * 10 + i, 3);
      const trade = DATA(tradePayload({ mint, user, sol: 0.02, token: 40_000, isBuy: true, ts, vSol: vSol + i * 1_000_000_000, vTok }));
      const viaMayhem = i >= buysPerMint - 2; // the last two come through a Mayhem CPI
      const logs = viaMayhem
        ? [`Program ${MAYHEM} invoke [1]`, "Program log: Instruction: Route", `Program ${PUMP} invoke [2]`, "Program log: Instruction: Buy", trade, `Program ${PUMP} success`, `Program ${MAYHEM} success`]
        : [`Program ${PUMP} invoke [1]`, "Program log: Instruction: Buy", trade, `Program ${PUMP} success`];
      out.push({ delayMs: 120, payload: OK(`sig-buy-${m}-${i}`, logs) });
    }
    ts += 400;
    out.push({
      delayMs: 120,
      payload: OK(`sig-sell-${m}`, [
        `Program ${PUMP} invoke [1]`,
        "Program log: Instruction: Sell",
        DATA(tradePayload({ mint, user: fakeKey(m * 10, 3), sol: 0.03, token: 50_000, isBuy: false, ts, vSol, vTok })),
        `Program ${PUMP} success`,
      ]),
    });
  }
  return out;
}

export class MockSocket extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.readyState = 1; // OPEN, same constant SolanaWs compares against
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
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: this.subId })); // subscription ack
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

