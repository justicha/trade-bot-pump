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
import { toBase58Safe } from "../../lib/events.mjs";
import { MockSocket, createPayload, tradePayload } from "./ws-mock-shadow.mjs";

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
  create(MODE_MINT, MODE_CREATOR, MODE_LAUNCHER, "Mode Coin", 505);
  trade(MODE_MINT, 2, { user: key(130), slot: 506 });
  trade(MODE_MINT, 5, { user: key(131), slot: 506 });
  trade(UNSEEN_MINT, 30, { user: key(140), slot: 507 });
  trade(UNSEEN_MINT, 55, { user: key(141), slot: 508 });
  trade(MIG_MINT, 100, { user: key(122), sol: 18, slot: 509 });
  // After the complete row: a trailing event must not open a new row.
  trade(MIG_MINT, 100, { user: key(123), sol: 0.01, slot: 510 });
  return out;
}

export function createSocket(url) {
  return new MockSocket(url, { notifications: buildNotifications() });
}
