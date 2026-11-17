// Fixture socket for scripts/mint-census.mjs (WS_MOCK=<this file>): the REAL recorder runs against a
// synthetic pump.fun stream, with no network. Payload builders come from ws-mock-shadow.mjs.
//
// Stream (all on-chain times = the wall clock when the notification is sent):
//   MIG_MINT   created by MIG_LAUNCHER (user = creator), dev buy 1 SOL in the create slot, buys to
//              10 %, one buy that jumps to 60 % (25 and 50 at that event), a sell down to 40 %, 80 %,
//              then 100 % -> a migrated row.
//   MODE_MINT  created by MODE_LAUNCHER for MODE_CREATOR (launcher mode), buys to 5 % -> a compact
//              partial row at the stop.
//   UNSEEN_MINT no create: trades at 30 % and 55 % -> createSeen false, launcher null, firstSeenFill 30,
//              milestone 50 only (25 was not seen crossing); a full partial row at the stop.
//
// Rev 2 (KODING #21): the socket routes by the subscription's `mentions`. The pump program gets the
// stream above; MIG_POOL (the canonical pool of MIG_MINT, subscribed by the census at the completion)
// or the whole PumpSwap program (mode b) gets the pool stream below (buildPoolNotifications);
// logsUnsubscribe is answered `true`. WS_MOCK_CENSUS_LOG=<file> appends every method the socket
// receives ("logsSubscribe <mention>" / "logsUnsubscribe <subId>") so a test can check the lifecycle.
// WS_MOCK_POOL_REJECT=1 answers a pool subscription with a JSON-RPC error (the mode b fallback).
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { PublicKey } from "@solana/web3.js";
import { toBase58Safe } from "../../lib/events.mjs";
import { canonicalPool } from "../../lib/pumpswap-stream.mjs";
import { createPayload, tradePayload } from "./ws-mock-shadow.mjs";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const REAL_SOL_100 = 85e9;

export function key(seed) {
  const b = Buffer.alloc(32);
  let x = seed * 2654435761 + 7;
  for (let i = 0; i < 32; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = (x >> 7) & 0xff;
  }
  b[0] = b[0] || 1;
  return toBase58Safe(b);
}

export const MIG_MINT = key(1);
export const MODE_MINT = key(2);
export const UNSEEN_MINT = key(3);
export const MIG_LAUNCHER = key(11);
export const MODE_LAUNCHER = key(12);
export const MODE_CREATOR = key(13);

const nowSec = () => Math.floor(Date.now() / 1000);
const OK = (signature, slot, logs) => ({ context: { slot }, value: { signature, err: null, logs } });
const DATA = (p) => `Program data: ${p.toString("base64")}`;

export function buildNotifications() {
  const out = [];
  let seq = 0;
  const create = (mint, creator, user, name, slot) => {
    seq += 1;
    const n = seq;
    out.push({
      delayMs: 50,
      payload: () => OK(`sig-census-${n}`, slot, [`Program ${PUMP} invoke [1]`, "Program log: Instruction: Create", DATA(createPayload({ mint, creator, user, name, symbol: name.slice(0, 3).toUpperCase() })), `Program ${PUMP} success`]),
    });
  };
  const trade = (mint, fillPct, { user, isBuy = true, sol = 0.1, slot = 100 } = {}) => {
    seq += 1;
    const n = seq;
    out.push({
      delayMs: 50,
      payload: () => OK(`sig-census-${n}`, slot, [
        `Program ${PUMP} invoke [1]`,
        `Program log: Instruction: ${isBuy ? "Buy" : "Sell"}`,
        DATA(tradePayload({ mint, user, isBuy, realSol: (fillPct / 100) * REAL_SOL_100, solLamports: sol * 1e9, ts: nowSec() })),
        `Program ${PUMP} success`,
      ]),
    });
  };
  create(MIG_MINT, MIG_LAUNCHER, MIG_LAUNCHER, "Census Coin", 500);
  trade(MIG_MINT, 1.2, { user: MIG_LAUNCHER, sol: 1, slot: 500 });
  for (let i = 0; i < 4; i++) trade(MIG_MINT, 3 + i * 2, { user: key(100 + i), slot: 501 });
  trade(MIG_MINT, 60, { user: key(120), sol: 40, slot: 502 });
  trade(MIG_MINT, 40, { user: key(120), isBuy: false, sol: 15, slot: 503 });
  trade(MIG_MINT, 80, { user: key(121), sol: 30, slot: 504 });
  trade(MIG_MINT, 93, { user: key(124), sol: 11, slot: 504 }); // #21b: the pool is pre-subscribed here (fill >= 92)
  create(MODE_MINT, MODE_CREATOR, MODE_LAUNCHER, "Mode Coin", 505);
  trade(MODE_MINT, 2, { user: key(130), slot: 506 });
  trade(MODE_MINT, 5, { user: key(131), slot: 506 });
  trade(UNSEEN_MINT, 30, { user: key(140), slot: 507 });
  trade(UNSEEN_MINT, 55, { user: key(141), slot: 508 });
  trade(MIG_MINT, 100, { user: key(122), sol: 18, slot: 509 });
  // After the complete row: a trailing event must not open a new row.
  trade(MIG_MINT, 100, { user: key(123), sol: 0.01, slot: 510 });
  // #21b (WS_MOCK_PRESUB_DROP=1): a mint that reaches 94 % and never completes -> its pre-subscribed
  // pool is dropped when the mint's row is written (here: at the stop)
  if (process.env.WS_MOCK_PRESUB_DROP === "1") trade(DROP_MINT, 94, { user: key(150), sol: 5, slot: 511 });
  return out;
}
export const DROP_MINT = key(4);

// ---- PumpSwap events (layout: lib/pumpswap-stream.mjs, pump-public-docs IDL) ------------------------
export const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const MIG_POOL = canonicalPool(new PublicKey(MIG_MINT)).toBase58();
export const OTHER_POOL = key(50); // a pool nobody watches (a router hop in the same transaction)
export const POOL_BUYER = key(200);
export const POOL_SELLER = key(201);
const bytes32 = (b58) => new PublicKey(b58).toBuffer();

// A Buy/SellEvent payload. Amounts are BigInt (or integers) in raw units.
export function pumpSwapPayload({ side, ts, baseAmount, poolBase, poolQuote, quoteAmount, lpFee = 0n, protocolFee = 0n, quoteWithLp, userQuote, pool, user, coinCreator = user, virtualQuote = 0n, baseSupply = 1_000_000_000_000_000n, ixName = "buy" }) {
  const name = Buffer.from(ixName, "utf8");
  const vq = side === "sell" ? 392 : 405 + name.length + 32;
  const buf = Buffer.alloc(side === "sell" ? 449 : vq + 16 + 1 + 8 + 24);
  Buffer.from(side === "sell" ? "3e2f370aa503dc2a" : "67f4521f2cf57777", "hex").copy(buf, 0);
  const u = (o, v) => buf.writeBigUInt64LE(BigInt(v), o);
  buf.writeBigInt64LE(BigInt(ts), 8);
  u(16, baseAmount);
  u(48, poolBase);
  u(56, poolQuote);
  u(64, quoteAmount);
  u(72, 2);
  u(80, lpFee);
  u(88, 93);
  u(96, protocolFee);
  u(104, quoteWithLp);
  u(112, userQuote);
  bytes32(pool).copy(buf, 120);
  bytes32(user).copy(buf, 152);
  bytes32(coinCreator).copy(buf, 312);
  if (side === "buy") {
    buf.writeUInt32LE(name.length, 401);
    name.copy(buf, 405);
  }
  const v = BigInt(virtualQuote);
  buf.writeBigUInt64LE(v & 0xffffffffffffffffn, vq);
  buf.writeBigInt64LE(v >> 64n, vq + 8);
  u(vq + 17, baseSupply);
  return buf;
}

// A pool whose constant product runs on (quote vault + virtual) x base, fees 2 (lp) + 93 + 30 bps.
// trade() returns the event fields and moves the reserves like the program does.
export function poolSim({ base, quote, virtual }) {
  const st = { base: BigInt(base), quote: BigInt(quote), virtual: BigInt(virtual) };
  const fee = (x, bps) => (x * BigInt(bps) + 9999n) / 10000n;
  return {
    st,
    trade({ side, sol = 0, tokens = 0n, pool, user, ts, ixName = "buy" }) {
      const B = st.base;
      const Q = st.quote;
      const eff = Q + st.virtual;
      if (side === "buy") {
        const qin = BigInt(Math.round(sol * 1e9));
        const out = (B * qin) / (eff + qin);
        const lp = fee(qin, 2);
        const ev = { side, ts, baseAmount: out, poolBase: B, poolQuote: Q, quoteAmount: qin, lpFee: lp, protocolFee: fee(qin, 93), quoteWithLp: qin + lp, userQuote: qin + lp + fee(qin, 93) + fee(qin, 30), pool, user, virtualQuote: st.virtual, ixName };
        st.base = B - out;
        st.quote = Q + qin + lp;
        return ev;
      }
      const tin = BigInt(tokens);
      const out = (eff * tin) / (B + tin);
      const lp = fee(out, 2);
      const ev = { side, ts, baseAmount: tin, poolBase: B, poolQuote: Q, quoteAmount: out, lpFee: lp, protocolFee: fee(out, 93), quoteWithLp: out - lp, userQuote: out - lp - fee(out, 93) - fee(out, 30), pool, user, virtualQuote: st.virtual };
      st.base = B + tin;
      st.quote = Q - (out - lp);
      return ev;
    },
  };
}

// KODING #21c: a full pump trade-v3 payload (layout: lib/events.mjs + the IDL tail read by
// lib/mint-census.mjs tradeTail) on the standard curve's TOKEN side: virtual tokens `vTok`, real tokens
// vTok - 279.9e12. `sol`: { vSol, realSol } in lamports, or null = an "unpriced" event (zero SOL side,
// as a curve quoted in another mint). `quoteMint`: null = SOL (the default pubkey, as on mainnet).
export const STD_OFFSET = 279_900_000_000_000n;
export const vTokAtFill = (fill) => BigInt(Math.round(1.073e15 / ((fill / 100) * (85 / 30) + 1))); // tokenFill inverse
export function curveTradePayload({ mint, user, isBuy = true, ts, vTok, rTok = null, sol = null, mayhem = false, quoteMint = null, ixName = "buy", solLamports = 10_000_000 }) {
  const name = Buffer.from(ixName, "utf8");
  const tail = 262 + name.length; // mayhem_mode
  const buf = Buffer.alloc(tail + 1 + 32 + 4 + 32 + 8 * 6);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  bytes32(mint).copy(buf, 8);
  buf.writeBigUInt64LE(BigInt(sol ? solLamports : 0), 40);
  buf.writeBigUInt64LE(1_000_000_000n, 48);
  buf[56] = isBuy ? 1 : 0;
  bytes32(user).copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(ts), 89);
  const v = BigInt(vTok);
  buf.writeBigUInt64LE(sol ? BigInt(sol.vSol) : 0n, 97);
  buf.writeBigUInt64LE(v, 105);
  buf.writeBigUInt64LE(sol ? BigInt(sol.realSol) : 0n, 113);
  buf.writeBigUInt64LE(rTok === null ? v - STD_OFFSET : BigInt(rTok), 121);
  buf.writeUInt32LE(name.length, 258);
  name.copy(buf, 262);
  buf[tail] = mayhem ? 1 : 0;
  buf.writeUInt32LE(0, tail + 33); // shareholders: none
  if (quoteMint) bytes32(quoteMint).copy(buf, tail + 37);
  return buf;
}

// The pool of MIG_MINT right after its migration, on the scale of this mock's curve (its virtual
// token reserve is fixed at 1.073e15, so the curve ends at 115e9 / 1.073e15 * 1e-3 = 1.0718e-7 SOL).
export const MIG_POOL_START = { base: 800_000_000_000_000n, quote: 68_300_000_000n, virtual: 17_450_000_000n };

// CreatePoolEvent payload (layout: lib/pumpswap-stream.mjs parsePumpSwapCreatePool), 344 bytes.
export function createPoolPayload({ ts, pool, baseMint, poolBase, poolQuote, coinCreator = baseMint }) {
  const buf = Buffer.alloc(344);
  Buffer.from("b1310cd2a076a774", "hex").copy(buf, 0);
  buf.writeBigInt64LE(BigInt(ts), 8);
  bytes32(baseMint).copy(buf, 50);
  bytes32("So11111111111111111111111111111111111111112").copy(buf, 82);
  buf[114] = 6;
  buf[115] = 9;
  buf.writeBigUInt64LE(BigInt(poolBase), 116);
  buf.writeBigUInt64LE(BigInt(poolQuote), 124);
  buf.writeBigUInt64LE(BigInt(poolBase), 132);
  buf.writeBigUInt64LE(BigInt(poolQuote), 140);
  bytes32(pool).copy(buf, 173);
  bytes32(coinCreator).copy(buf, 301);
  return buf;
}

// Pool stream after the pool subscription (delays in ms, cumulative from the subscription + 200):
//   +100  the migration transaction: CreatePoolEvent with MIG_POOL_START's reserves (the pool open;
//         its quote amount = vault + virtual, as on a real pump migration)
//   +200  a FAILED transaction on the pool (traffic only)
//   +300  POOL_BUYER buys 1 SOL                       (first pool trade, t = 0, at the open reserves)
//   +400  MIG_LAUNCHER sells 2e12 raw tokens           (a launcher sell in the pool)
//   +500  one transaction with an OTHER_POOL event      (ignored, unknownPool)
//   +3400 POOL_SELLER sells 1e12 raw tokens            (past a 2 s watch: ends the watch)
export function buildPoolNotifications() {
  const sim = poolSim(MIG_POOL_START);
  const other = poolSim({ base: 500_000_000_000_000n, quote: 90_000_000_000n, virtual: 0n });
  let n = 0;
  const note = (delayMs, make) => {
    n += 1;
    const k = n;
    return { delayMs, payload: () => OK(`sig-pool-${k}`, 900 + k, [`Program ${PUMPSWAP} invoke [1]`, ...make().map((p) => DATA(pumpSwapPayload(p))), `Program ${PUMPSWAP} success`]) };
  };
  return [
    { delayMs: 100, payload: () => OK("sig-pool-open", 900, [`Program ${PUMP} invoke [1]`, "Program log: Instruction: Migrate", `Program ${PUMPSWAP} invoke [2]`, DATA(createPoolPayload({ ts: nowSec(), pool: MIG_POOL, baseMint: MIG_MINT, poolBase: MIG_POOL_START.base, poolQuote: MIG_POOL_START.quote + MIG_POOL_START.virtual })), `Program ${PUMPSWAP} success`, `Program ${PUMP} success`]) },
    { delayMs: 100, payload: () => ({ context: { slot: 901 }, value: { signature: "sig-pool-failed", err: { InstructionError: [2, { Custom: 6004 }] }, logs: [`Program ${PUMPSWAP} invoke [1]`, "Program log: AnchorError: slippage", `Program ${PUMPSWAP} failed: custom program error: 0x1774`] } }) },
    note(100, () => [sim.trade({ side: "buy", sol: 1, pool: MIG_POOL, user: POOL_BUYER, ts: nowSec() })]),
    note(100, () => [sim.trade({ side: "sell", tokens: 2_000_000_000_000n, pool: MIG_POOL, user: MIG_LAUNCHER, ts: nowSec() })]),
    note(100, () => [other.trade({ side: "buy", sol: 0.5, pool: OTHER_POOL, user: POOL_BUYER, ts: nowSec() })]),
    note(2900, () => [sim.trade({ side: "sell", tokens: 1_000_000_000_000n, pool: MIG_POOL, user: POOL_SELLER, ts: nowSec() })]),
  ];
}

// ---- the socket ----------------------------------------------------------------------------------
class CensusMockSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1; // OPEN
    this.subId = 0;
    this.timers = [];
    this.logFile = process.env.WS_MOCK_CENSUS_LOG || null;
    setTimeout(() => this.emit("open"), 0);
  }

  _log(line) {
    if (this.logFile) fs.appendFileSync(this.logFile, `${line}\n`);
  }

  _play(list, subId, startMs = 200) {
    let acc = startMs;
    for (const n of list) {
      acc += n.delayMs;
      this.timers.push(
        setTimeout(() => {
          if (this.readyState !== 1) return;
          this.emit("message", JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: subId, result: n.payload() } }));
        }, acc),
      );
    }
  }

  send(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    if (msg.method === "logsUnsubscribe") {
      this._log(`logsUnsubscribe ${msg.params?.[0]}`);
      setTimeout(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: true })), 0);
      return;
    }
    if (msg.method !== "logsSubscribe") return;
    const mention = msg.params?.[0]?.mentions?.[0];
    this._log(`logsSubscribe ${mention}`);
    if (mention !== PUMP && process.env.WS_MOCK_POOL_REJECT === "1" && mention !== PUMPSWAP) {
      setTimeout(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "too many subscriptions on this connection" } })), 0);
      return;
    }
    this.subId += 1;
    const subId = this.subId;
    setTimeout(() => this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: subId })), 0);
    if (mention === PUMP) {
      this.pumpSubAt = Date.now();
      this._play(buildNotifications(), subId);
    }
    else if (mention === MIG_POOL) this._play(buildPoolNotifications(), subId);
    // mode b subscribes the whole program at the start: its pool events must come after MIG_MINT completes
    else if (mention === PUMPSWAP) this._play(buildPoolNotifications(), subId, this.pumpSubAt === undefined ? 200 : Math.max(200, this.pumpSubAt + 1500 - Date.now()));
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    this.readyState = 3; // CLOSED
    setTimeout(() => this.emit("close"), 0);
  }
}

export function createSocket(url) {
  return new CensusMockSocket(url);
}
