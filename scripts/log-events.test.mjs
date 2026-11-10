// C4/C1: the shared parseLogEvents must (a) read trade direction from the payload byte, (b) emit a
// create event from the CreateV2 payload's creator even when the tx has NO trade event, and (c)
// keep the instruction-name hint for disagreement visibility.
import "./lib/test-env.mjs";
import { parseLogEvents, toBase58Safe } from "../lib/events.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const key = (ch) => Buffer.alloc(32, ch);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const DATA = (p) => `Program data: ${p.toString("base64")}`;

function tradePayload({ mintKey, userKey, sol, token, isBuy, vSol, vTok, rSol, rTok }) {
  const buf = Buffer.alloc(405);
  Buffer.from("bddb7fd34ee661ee", "hex").copy(buf, 0);
  mintKey.copy(buf, 8);
  userKey.copy(buf, 57);
  buf.writeBigUInt64LE(BigInt(Math.round(sol * 1e9)), 40);
  buf.writeBigUInt64LE(BigInt(Math.round(token * 1e6)), 48);
  buf[56] = isBuy ? 1 : 0;
  buf.writeBigUInt64LE(BigInt(Math.round(vSol)), 97);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok)), 105);
  buf.writeBigUInt64LE(BigInt(Math.round(rSol)), 113);
  buf.writeBigUInt64LE(BigInt(Math.round(rTok)), 121);
  return buf;
}

function createPayload(mintKey, creatorKey) {
  const enc = (s) => {
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
    enc("Test Token"),
    enc("TST"),
    enc("https://example.invalid/meta.json"),
    mintKey, key(8), key(9), creatorKey,
    u64(1794111586),
    u64(1_073_000_000_000_000n),
    u64(30_000_000_000n),
    u64(793_100_000_000_000n),
    u64(1_000_000_000_000_000n),
    Buffer.from([1, 0]),
  ]);
}

const mintKey = key(7);
const creatorKey = key(10);
const userKey = key(20);

// (1) CreateV2-only tx: no trade event, but the create must still be emitted with the payload creator.
{
  const logs = [
    `Program ${PUMP} invoke [1]`,
    "Program log: Instruction: CreateV2",
    DATA(createPayload(mintKey, creatorKey)),
    `Program ${PUMP} success`,
  ];
  const events = parseLogEvents(logs);
  const create = events.find((e) => e.type === "create");
  asrt(create != null, "a create-only tx emits a create event");
  asrt(create.creator === toBase58Safe(creatorKey), "create.creator comes from the payload, not a trade user");
  asrt(events.every((e) => e.type !== "trade"), "no trade events in a create-only tx");
}

// (2) mixed buy+sell tx: direction per event from the byte.
{
  const buy = tradePayload({ mintKey, userKey, sol: 0.02, token: 40000, isBuy: true, vSol: 31e9, vTok: 1.073e15, rSol: 1e9, rTok: 793.1e12 });
  const sell = tradePayload({ mintKey, userKey, sol: 0.01, token: 20000, isBuy: false, vSol: 30e9, vTok: 1.073e15, rSol: 0.5e9, rTok: 793.1e12 });
  const logs = [
    "Program log: Instruction: Buy",
    "Program log: Instruction: Sell",
    DATA(buy),
    DATA(sell),
    `Program ${PUMP} success`,
  ];
  const events = parseLogEvents(logs).filter((e) => e.type === "trade");
  asrt(events.length === 2, `two trade events, got ${events.length}`);
  asrt(events.some((e) => e.isBuy === true), "the buy event is a buy (byte)");
  asrt(events.some((e) => e.isBuy === false), "the sell event is a sell (byte)");
  const buyEv = events.find((e) => e.isBuy === true);
  asrt(buyEv.virtualSolReserves === 31_000_000_000n && buyEv.realSolReserves === 1_000_000_000n, "reserve fields are flattened");
}

// (3) instruction says Sell, payload byte says buy -> byte wins and the disagreement is visible.
{
  const buy = tradePayload({ mintKey, userKey, sol: 0.02, token: 40000, isBuy: true, vSol: 31e9, vTok: 1.073e15, rSol: 1e9, rTok: 793.1e12 });
  const events = parseLogEvents(["Program log: Instruction: Sell", DATA(buy)]);
  const t = events.find((e) => e.type === "trade");
  asrt(t.isBuy === true && t.instructionIsBuy === false, "payload byte wins over the instruction name");
}

console.log("PASS: parseLogEvents reads direction from the byte and emits create events from the payload creator");
