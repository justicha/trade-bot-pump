#!/usr/bin/env node
// Discover where the reserves really live for each pump.fun payload length.
//
//   node scripts/probe-layout.mjs            # 60s collection, per-length offset discovery
//
// Method: for every event whose offset 97 does not yield a sane price, fetch the bonding-curve
// account (authoritative price) and scan every 8-byte-aligned offset pair (o, o+8) inside the
// payload. The pair whose ratio matches the on-chain price within 0.5% is the reserve offset for
// that payload length. The tool prints a length -> offset table, which lib/events.mjs then uses.
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM } from "../lib/constants.mjs";
import { getBondingCurveState } from "../lib/pumpfun.mjs";
import { describe, parseTrade } from "../lib/events.mjs";
import { SolanaWs } from "../lib/ws.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const SECONDS = Number(process.env.SECONDS || 60);
const MAX_PER_LEN = Number(process.env.MAX_PER_LEN || 4);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

const collected = new Map(); // len -> [Buffer]
const resolved = new Map(); // len -> Map(offset -> hits)
const queue = [];
let inFlight = 0;

function bestOffset(buf, chainPrice) {
  let best = null;
  for (let o = 8; o + 16 <= buf.length; o += 8) {
    const vSol = Number(buf.readBigUInt64LE(o));
    const vTok = Number(buf.readBigUInt64LE(o + 8));
    if (!(vSol > 0) || !(vTok > 0)) continue;
    const p = vSol / vTok;
    const diff = Math.abs(p - chainPrice) / chainPrice;
    if (diff < 0.005 && (!best || o < best.offset)) best = { offset: o, diff };
  }
  return best;
}

async function check(buf) {
  const ev = parseTrade(buf);
  if (!ev) return null;
  const chain = await getBondingCurveState(new PublicKey(ev.mint), 0).catch(() => null);
  if (!chain?.virtualSolReserves || !chain?.virtualTokenReserves) return null;
  const chainPrice = Number(chain.virtualSolReserves) / Number(chain.virtualTokenReserves);
  const hit = bestOffset(buf, chainPrice);
  if (!hit) return null;

  const m = resolved.get(buf.length) || new Map();
  m.set(hit.offset, (m.get(hit.offset) || 0) + 1);
  resolved.set(buf.length, m);

  // where our current parser looks (97) vs the discovered offset
  const cur = Number(buf.readBigUInt64LE(97));
  const curTok = Number(buf.readBigUInt64LE(105));
  return { len: buf.length, offset: hit.offset, diff: hit.diff, current97Sane: cur > 0 && curTok > 0 };
}

function pump() {
  while (queue.length && inFlight < CONCURRENCY) {
    const buf = queue.shift();
    inFlight += 1;
    check(buf)
      .then((r) => {
        if (r) console.log(`  len=${r.len} reserves@${r.offset} (matches chain, diff ${(r.diff * 100).toFixed(3)}%), offset97 sane=${r.current97Sane}`);
      })
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

const ws = new SolanaWs();
await ws.connect();
console.log(`scanning payload layouts for ${SECONDS}s...`);

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  if (!String(value.logs[value.logs.length - 1] || "").includes("success")) return;
  for (const line of value.logs) {
    if (!line.startsWith("Program data: ")) continue;
    let raw;
    try {
      raw = Buffer.from(line.slice(14), "base64");
    } catch {
      continue;
    }
    if (raw.length < 8) continue;
    const d = describe(raw);
    if (d.type !== "trade-v3") continue;
    const list = collected.get(raw.length) || [];
    if (list.length >= MAX_PER_LEN) continue;
    list.push(raw);
    collected.set(raw.length, list);
    queue.push(raw);
    pump();
  }
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));
await ws.close().catch(() => {});
while (inFlight > 0 || queue.length > 0) await new Promise((r) => setTimeout(r, 200));

console.log("\n=== offsets that reproduce the on-chain price ===");
const table = {};
for (const [len, m] of [...resolved.entries()].sort((a, b) => a[0] - b[0])) {
  const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  table[len] = top[0];
  console.log(`  len=${String(len).padStart(4)}  reserves @ ${String(top[0]).padStart(3)}   (${top[1]} confirmations)`);
}
const missing = [...collected.keys()].filter((l) => !resolved.has(l));
if (missing.length) console.log(`  no match found for lengths: ${missing.join(", ")}`);

const out = path.join(ROOT, "data", "research", "event_layouts.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, offsets: table }, null, 2));
console.log(`\nwritten: ${out}`);
