#!/usr/bin/env node
// Parser validation on live data (read-only, no wallet, no transactions).
//
//   node scripts/validate-parser.mjs                 # 250 samples / 4 min max
//   SAMPLES=100 SECONDS=90 node scripts/validate-parser.mjs
//
// For every sampled V3 trade event it compares the price decoded from the event reserves
// (offsets 97..113) with the price read from the bonding-curve ACCOUNT right after the
// notification, prints the worst rows, the share of events off by > 1%, and a histogram of
// every pump.fun payload it sees (prefix + length) to identify payloads we cannot price.
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM, BUY_INSTRUCTIONS, SELL_INSTRUCTIONS } from "../lib/constants.mjs";
import { getBondingCurveState } from "../lib/pumpfun.mjs";
import { describe, parseTrade } from "../lib/events.mjs";
import { SolanaWs } from "../lib/ws.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const TARGET = Number(process.env.SAMPLES || 250);
const MAX_SECONDS = Number(process.env.SECONDS || 240);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const OUT = path.join(ROOT, "data", "research", "parser_validation.json");

const hist = new Map();
const layoutByLen = new Map();
const samples = [];
const seenMints = new Set();
const queue = [];
let inFlight = 0;
let decoded = 0;
let isBuyMismatch = 0;
let isBuyChecked = 0;

async function compare(ev) {
  const chain = await getBondingCurveState(new PublicKey(ev.mint), 0).catch(() => null);
  if (!chain || !chain.virtualTokenReserves || !chain.virtualSolReserves) return null;
  const evV = Number(ev.reserves.vSol);
  const evT = Number(ev.reserves.vTok);
  const chV = Number(chain.virtualSolReserves);
  const chT = Number(chain.virtualTokenReserves);
  if (!(evV > 0) || !(evT > 0) || !(chV > 0) || !(chT > 0)) {
    return { mint: ev.mint, len: ev.len, eventPrice: null, chainPrice: chV / chT, diffPct: null, unusable: true };
  }
  const eventPrice = evV / evT;
  const chainPrice = chV / chT;
  return { mint: ev.mint, len: ev.len, eventPrice, chainPrice, diffPct: ((eventPrice - chainPrice) / chainPrice) * 100, unusable: false };
}

function pump() {
  while (queue.length && inFlight < CONCURRENCY) {
    const ev = queue.shift();
    inFlight += 1;
    compare(ev)
      .then((row) => {
        if (row) samples.push(row);
      })
      .catch(() => {})
      .finally(() => {
        inFlight -= 1;
        pump();
      });
  }
}

function onEvent(data, instructionIsBuy) {
  const d = describe(data);
  hist.set(`${d.type}:${d.len}`, (hist.get(`${d.type}:${d.len}`) || 0) + 1);

  const ev = parseTrade(data);
  if (!ev) return;
  decoded += 1;

  const layout = layoutByLen.get(ev.len) || { total: 0, usable: 0, zeroVsol: 0 };
  layout.total += 1;
  if (ev.reserves && Number(ev.reserves.vSol) > 0 && Number(ev.reserves.vTok) > 0) layout.usable += 1;
  else if (ev.reserves && Number(ev.reserves.vSol) === 0) layout.zeroVsol += 1;
  layoutByLen.set(ev.len, layout);

  if (ev.isBuy !== null && instructionIsBuy !== null) {
    isBuyChecked += 1;
    if (ev.isBuy !== instructionIsBuy) isBuyMismatch += 1;
  }

  if (!ev.reserves || !(Number(ev.reserves.vSol) > 0) || !(Number(ev.reserves.vTok) > 0)) return;
  if (seenMints.has(ev.mint)) return;
  if (samples.length + inFlight >= TARGET) return;
  seenMints.add(ev.mint);
  queue.push(ev);
  pump();
}

const ws = new SolanaWs();
await ws.connect();
console.log(`collecting up to ${TARGET} priced events (max ${MAX_SECONDS}s)...`);

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  if (!String(value.logs[value.logs.length - 1] || "").includes("success")) return;

  let isBuy = null;
  for (const line of value.logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    else if (SELL_INSTRUCTIONS.has(m[1])) isBuy = false;
  }

  for (const line of value.logs) {
    if (!line.startsWith("Program data: ")) continue;
    let raw;
    try {
      raw = Buffer.from(line.slice(14), "base64");
    } catch {
      continue;
    }
    if (raw.length < 8) continue;
    onEvent(raw, isBuy);
  }
});

const started = Date.now();
while (Date.now() - started < MAX_SECONDS * 1000 && samples.length < TARGET) {
  await new Promise((r) => setTimeout(r, 500));
}
await ws.close().catch(() => {});
while (inFlight > 0 || queue.length > 0) await new Promise((r) => setTimeout(r, 200));
// ---- report -----------------------------------------------------------------
const usable = samples.filter((s) => s && !s.unusable && Number.isFinite(s.diffPct));
const bad = usable.filter((s) => Math.abs(s.diffPct) > 1);
const absDiffs = usable.map((s) => Math.abs(s.diffPct)).sort((a, b) => a - b);
const median = absDiffs.length ? absDiffs[Math.floor(absDiffs.length / 2)] : 0;
const p90 = absDiffs.length ? absDiffs[Math.floor(absDiffs.length * 0.9)] : 0;
const unusableCount = samples.filter((s) => s && s.unusable).length;
const pctOf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

console.log("\n=== 1. PARSER vs ON-CHAIN CURVE ===");
console.log(`sampled events: ${samples.length}   compared: ${usable.length}   unusable reserves: ${unusableCount}`);
console.log(
  `median |diff|: ${median.toFixed(3)}%   p90 |diff|: ${p90.toFixed(3)}%   >1%: ${bad.length} (${pctOf(bad.length, usable.length)})`,
);
console.log("\n worst rows:");
console.log("  mint          len   event price       chain price       diff%");
for (const s of usable.slice().sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct)).slice(0, 10)) {
  console.log(
    `  ${s.mint.slice(0, 10)}  ${String(s.len).padStart(4)}  ${s.eventPrice.toExponential(5)}  ${s.chainPrice.toExponential(5)}  ${s.diffPct.toFixed(2).padStart(9)}`,
  );
}
console.log(`\n is_buy byte vs instruction: checked ${isBuyChecked}, mismatches ${isBuyMismatch}`);

console.log("\n=== 2. PAYLOAD HISTOGRAM (prefix + length) ===");
for (const [key, n] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  const [type, len] = key.split(":");
  console.log(`  ${String(n).padStart(6)}  ${type.padEnd(18)} len=${len}`);
}
console.log("\n trade-v3 layouts by length:");
for (const [len, l] of [...layoutByLen.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(
    `  len=${String(len).padStart(4)}  total=${String(l.total).padStart(5)}  usable reserves=${String(l.usable).padStart(5)}  vSol==0: ${l.zeroVsol}`,
  );
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      decoded,
      sampled: samples.length,
      usable: usable.length,
      shareOver1Pct: usable.length ? bad.length / usable.length : null,
      medianAbsDiffPct: median,
      p90AbsDiffPct: p90,
      isBuyMismatch,
      isBuyChecked,
      histogram: Object.fromEntries(hist),
      layouts: Object.fromEntries(layoutByLen),
      rows: samples.slice(0, 500),
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${OUT}`);
