#!/usr/bin/env node
// Ground truth for the event layout: find the EXACT byte offset of the on-chain reserves.
//
//   node scripts/dump-layout.mjs            # 45s of samples
//
// For each collected payload it fetches the bonding-curve account and searches the buffer for
// the exact 8-byte little-endian values of virtual_sol_reserves / virtual_token_reserves.
// No heuristics: either the bytes are there (and we print where) or they are not.
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM } from "../lib/constants.mjs";
import { getBondingCurveState } from "../lib/pumpfun.mjs";
import { describe, parseTrade } from "../lib/events.mjs";
import { SolanaWs } from "../lib/ws.mjs";

const SECONDS = Number(process.env.SECONDS || 45);
const MAX_PER_LEN = Number(process.env.MAX_PER_LEN || 3);
const collected = new Map();
const queue = [];
let inFlight = 0;

function findU64(buf, value) {
  const hits = [];
  if (!value || value <= 0n) return hits;
  const needle = Buffer.alloc(8);
  needle.writeBigUInt64LE(value);
  for (let i = 0; i + 8 <= buf.length; i++) if (buf.compare(needle, 0, 8, i, i + 8) === 0) hits.push(i);
  return hits;
}

async function analyse(buf) {
  const ev = parseTrade(buf);
  if (!ev) return;
  const chain = await getBondingCurveState(new PublicKey(ev.mint), 0).catch(() => null);
  if (!chain?.virtualSolReserves || !chain?.virtualTokenReserves) return;
  const vSolHits = findU64(buf, chain.virtualSolReserves);
  const vTokHits = findU64(buf, chain.virtualTokenReserves);
  const pair = vSolHits.filter((o) => vTokHits.includes(o + 8));
  console.log(
    `len=${String(buf.length).padStart(3)}  vSol@[${vSolHits.join(",") || "-"}]  vTok@[${vTokHits.join(",") || "-"}]  ` +
      `adjacent pair@${pair.length ? pair.join(",") : "none"}  |  parser(97/105) sane=${Number(buf.readBigUInt64LE(97)) > 0}`,
  );
}

function pump() {
  while (queue.length && inFlight < 3) {
    const buf = queue.shift();
    inFlight += 1;
    analyse(buf)
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

const ws = new SolanaWs();
await ws.connect();
console.log(`looking for exact reserve offsets for ${SECONDS}s...`);

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
    if (raw.length < 8 || describe(raw).type !== "trade-v3") continue;
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

console.log("\n=== sample payload head (first 120 bytes, hex) ===");
for (const [len, list] of [...collected.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`len=${len}: ${list[0].subarray(0, 120).toString("hex")}`);
}
