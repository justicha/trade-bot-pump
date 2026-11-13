// Fixture WS for scripts/stall-guard.test.mjs (graduation-sniper, dry run): a stream that makes the
// BOT'S OWN PROCESS stand still, the way a paused Windows console does, and then hands over an old
// event — the backlog a real socket delivers after the pause.
//
//   +200 ms   A: a fresh buy at 95% fill           -> the bot opens a (dry) position
//   +1000 ms  B: a fresh buy at 50% (out of band), then this process is BLOCKED for
//                WS_STALL_BLOCK_MS (default 3500): Atomics.wait on the bot's own event loop
//   +100 ms   C: a buy at 95% fill whose on-chain timestamp is 600 s old (the backlog)
//   +300 ms   D: a fresh buy at 95% fill           -> must still be bought (the guard does not blind)
//
// Every payload is built when it is SENT, so "fresh" means fresh at that moment.
import { EventEmitter } from "node:events";
import { Keypair } from "@solana/web3.js";

const key = (n) => Keypair.fromSeed(Buffer.alloc(32, n)).publicKey;
export const MINT_A = key(11).toBase58();
export const MINT_B = key(12).toBase58();
export const MINT_C = key(13).toBase58();
export const MINT_D = key(14).toBase58();
export const OLD_EVENT_LAG_SEC = 600;

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const V_TOK = 1.073e15;

function tradePayload({ mint, userSeed, fillPct, lagSec = 0 }) {
  const rSol = (fillPct / 100) * 85e9;
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  key(mint).toBuffer().copy(buf, 8);
  buf.writeBigUInt64LE(100_000_000n, 40);
  buf.writeBigUInt64LE(100_000_000_000n, 48);
  buf[56] = 1; // is_buy
  key(userSeed).toBuffer().copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000) - lagSec), 89); // on-chain time, seconds
  buf.writeBigUInt64LE(BigInt(Math.round(rSol + 30e9)), 97);
  buf.writeBigUInt64LE(BigInt(V_TOK), 105);
  buf.writeBigUInt64LE(BigInt(Math.round(rSol)), 113);
  buf.writeBigUInt64LE(BigInt(V_TOK - 1e12), 121);
  return buf;
}

const notification = (sig, p) => () => ({
  context: { slot: 0 },
  value: { signature: sig, err: null, logs: [`Program ${PUMP} invoke [1]`, "Program log: Instruction: Buy", `Program data: ${tradePayload(p).toString("base64")}`, `Program ${PUMP} success`] },
});

const BLOCK_MS = Number(process.env.WS_STALL_BLOCK_MS || 3500);
const PLAN = [
  { delayMs: 200, build: notification("sig-a", { mint: 11, userSeed: 21, fillPct: 95 }) },
  { delayMs: 1000, build: notification("sig-b", { mint: 12, userSeed: 22, fillPct: 50 }), blockMs: BLOCK_MS },
  { delayMs: 100, build: notification("sig-c", { mint: 13, userSeed: 23, fillPct: 95, lagSec: OLD_EVENT_LAG_SEC }) },
  { delayMs: 300, build: notification("sig-d", { mint: 14, userSeed: 24, fillPct: 95 }) },
];

export class MockSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.subId = 0;
    this.timers = [];
    setTimeout(() => this.emit("open"), 0);
  }
  send(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.method || typeof msg.id !== "number") return;
    this.subId += 1;
    this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: this.subId }));
    if (msg.method !== "logsSubscribe") return;
    let acc = 0;
    for (const n of PLAN) {
      acc += n.delayMs;
      this.timers.push(
        setTimeout(() => {
          this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: this.subId, result: n.build() } }));
          // Freeze the whole process, the way a blocked console write does.
          if (n.blockMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n.blockMs);
        }, acc),
      );
    }
  }
  close() {
    for (const t of this.timers) clearTimeout(t);
    this.readyState = 3;
    setTimeout(() => this.emit("close"), 0);
  }
  terminate() {
    for (const t of this.timers) clearTimeout(t);
    this.readyState = 3;
    this.emit("close");
  }
}
export function createSocket(url) {
  return new MockSocket(url);
}
