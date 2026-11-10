// Fixture WS for scripts/copy-filter.test.mjs: one tx with TWO buy trades — the subscribed target's
// own buy on mint A, and a FOREIGN wallet's buy on mint B. The copy-trader must copy only the
// target's trade (H1).
import { EventEmitter } from "node:events";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
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
function fakeKey(seed, salt = 0) {
  const bytes = Buffer.alloc(32);
  let x = seed * 2654435761 + salt * 40503 + 1;
  for (let i = 0; i < 32; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (x >> 7) & 0xff;
  }
  return encodeB58(bytes);
}

export const TARGET = fakeKey(1, 1);
export const FOREIGN = fakeKey(2, 1);
export const MINT_A = fakeKey(100, 1);
export const MINT_B = fakeKey(200, 1);

function tradePayload({ mint, user, sol, token, isBuy, vSol, vTok }) {
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  decodeB58(mint).copy(buf, 8);
  decodeB58(user).copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(Math.round(sol * 1e9)), 40);
  buf.writeBigUInt64LE(BigInt(Math.round(token * 1e6)), 48);
  buf[56] = isBuy ? 1 : 0;
  buf.writeBigUInt64LE(BigInt(Math.round(vSol)), 97);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok)), 105);
  return buf;
}

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DATA = (p) => `Program data: ${p.toString("base64")}`;
const notification = {
  context: { slot: 0 },
  value: {
    signature: "sig-copy-h1",
    err: null,
    logs: [
      `Program ${PUMP} invoke [1]`,
      "Program log: Instruction: Buy",
      DATA(tradePayload({ mint: MINT_A, user: TARGET, sol: 0.02, token: 40000, isBuy: true, vSol: 31e9, vTok: 1.073e15 })),
      DATA(tradePayload({ mint: MINT_B, user: FOREIGN, sol: 0.03, token: 50000, isBuy: true, vSol: 32e9, vTok: 1.073e15 })),
      `Program ${PUMP} success`,
    ],
  },
};

export class MockSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.subId = 0;
    setTimeout(() => this.emit("open"), 0);
  }
  send(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method && typeof msg.id === "number") {
      this.subId += 1;
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: this.subId }));
      if (msg.method === "logsSubscribe") {
        setTimeout(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: this.subId, result: notification } })), 20);
      }
    }
  }
  close() { this.readyState = 3; setTimeout(() => this.emit("close"), 0); }
  terminate() { this.readyState = 3; this.emit("close"); }
}
export function createSocket(url) { return new MockSocket(url); }
