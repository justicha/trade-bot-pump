#!/usr/bin/env node
// Offline replay of the raw capture through the same consumer path the bots use:
// payload -> parseTrade -> reserves -> price -> CurveConsistency gate -> HolderTracker gate.
//
//   node scripts/replay-raw.mjs                       # data/raw
//   node scripts/replay-raw.mjs --raw data/raw/2026-11-08-04.jsonl.gz
//   REPLAY_MIN_HOLDERS=4 node scripts/replay-raw.mjs
//
// Why: after a parser change you want the exact same bytes replayed instead of a fresh live
// stream. Nothing here talks to the network, so the numbers are reproducible.
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { parseTrade } from "../lib/events.mjs";
import { CurveConsistency } from "../lib/consistency.mjs";
import { HolderTracker } from "../lib/holders.mjs";
import { metricsOf } from "../lib/curve.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const TARGET = argOf("--raw", RAW_DIR);
const MIN_HOLDERS = Number(process.env.REPLAY_MIN_HOLDERS || 4);
const MIN_SLOTS = Number(process.env.REPLAY_MIN_SLOTS || 1);

const prices = new CurveConsistency();
const holders = new HolderTracker({ minHolders: MIN_HOLDERS, minSlots: MIN_SLOTS, minDelayMs: 0, waitMs: 60_000 });

const byLen = new Map();
const bucket = (len) => {
  if (!byLen.has(len)) byLen.set(len, { len, events: 0, priced: 0, gated: 0, noReserves: 0 });
  return byLen.get(len);
};

let events = 0;
let priced = 0;
let gated = 0;
let entries = 0;
let notOrganic = 0;
const mints = new Set();

for await (const rec of replayRaw(TARGET)) {
  const buf = payloadOf(rec);
  if (!buf) continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  events += 1;
  mints.add(ev.mint);
  const b = bucket(ev.len);
  b.events += 1;

  if (!ev.hasReserves) {
    b.noReserves += 1;
  } else {
    const m = metricsOf({ virtualSolReserves: ev.reserves.vSol, virtualTokenReserves: ev.reserves.vTok });
    if (m) {
      b.priced += 1;
      const res = prices.check(ev.mint, ev.reserves.vSol, ev.reserves.vTok);
      if (!res.ok) {
        b.gated += 1;
        gated += 1;
      } else {
        priced += 1;
      }
    }
  }

  holders.track(ev.mint, { at: rec.ts, slot: rec.slot });
  const snap = holders.apply(ev.mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: rec.ts, slot: rec.slot });
  if (snap?.ready) {
    if (holders.organic(snap)) {
      entries += 1;
      holders.drop(ev.mint);
    } else {
      notOrganic += 1;
      holders.drop(ev.mint);
    }
  }
}

const pctf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
console.log(`=== REPLAY ${TARGET} ===`);
console.log(`trade events: ${events}   mints: ${mints.size}`);
console.log(`prices accepted by the k gate: ${priced} (${pctf(priced, priced + gated)})   rejected: ${gated} (${pctf(gated, priced + gated)})`);
console.log(`entry gate (>=${MIN_HOLDERS} holders): organic entries ${entries}, rejected ${notOrganic}`);

console.log("\n per payload length:");
console.log("  len   events   priced   k-rejected   no reserves");
for (const b of [...byLen.values()].sort((x, y) => y.events - x.events)) {
  console.log(
    `  ${String(b.len).padStart(4)}  ${String(b.events).padStart(7)}  ${String(b.priced).padStart(7)}  ${String(b.gated).padStart(11)}  ${String(b.noReserves).padStart(11)}`,
  );
}
