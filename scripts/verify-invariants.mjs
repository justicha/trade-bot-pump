#!/usr/bin/env node
// Internal consistency check of the parsed events вЂ” no RPC, no wallet, read-only.
//
//   node scripts/verify-invariants.mjs          # 90s of stream
//   SECONDS=60 MINTS=200 node scripts/verify-invariants.mjs
//
// For CONSECUTIVE events of the same mint it checks the constant-product invariant of the
// bonding curve (x * y = k) and whether reserve DELTAS match the trade amounts of the second
// event:
//   k = vSol * vTok stays constant through a trade (the fee is taken from the SOL input);
//   buy : vSol up by ~amount*(1-fee), vTok down by the minted tokens; sell: the opposite.
// A clean parse gives drift ~0 (integer rounding only). A systematic violation for one payload
// length means the offsets are wrong for that layout.
import { PUMP_PROGRAM } from "../lib/constants.mjs";
import { parseTrade } from "../lib/events.mjs";
import { SolanaWs } from "../lib/ws.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const SECONDS = Number(process.env.SECONDS || 90);
const MINTS = Number(process.env.MINTS || 300);
const MAX_EVENTS_PER_MINT = Number(process.env.MAX_EVENTS || 24);

const streams = new Map();
const byLen = new Map();
const allStats = { pairs: 0, kDrift1ppm: 0, kDrift100ppm: 0, kDrift1000ppm: 0, dirMismatch: 0, amountMismatch: 0, skippedNoReserves: 0 };

function bucket(len) {
  let b = byLen.get(len);
  if (!b) {
    b = { len, pairs: 0, kDrift1ppm: 0, kDrift100ppm: 0, kDrift1000ppm: 0, dirMismatch: 0, amountMismatch: 0, driftPpmSum: 0 };
    byLen.set(len, b);
  }
  return b;
}

function onEvent(ev) {
  if (!ev) return;
  if (!ev.hasReserves) {
    allStats.skippedNoReserves += 1;
    return;
  }
  let list = streams.get(ev.mint);
  if (!list) {
    if (streams.size >= MINTS) return;
    list = [];
    streams.set(ev.mint, list);
  }
  if (list.length >= MAX_EVENTS_PER_MINT) return;
  list.push({
    len: ev.len,
    vSol: BigInt(ev.reserves.vSol),
    vTok: BigInt(ev.reserves.vTok),
    solLamports: BigInt(Math.round(ev.solAmount * 1e9)),
    tokenRaw: BigInt(Math.round(ev.tokenAmount * 1e6)),
    isBuy: ev.isBuyByte,
  });
}

const ws = new SolanaWs();
await ws.connect();
console.log(`collecting events for ${SECONDS}s (max ${MINTS} mints)...`);

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
    onEvent(parseTrade(raw));
  }
});

await new Promise((r) => setTimeout(r, SECONDS * 1000));
await ws.close().catch(() => {});
// ---- analysis ---------------------------------------------------------------
const absBig = (x) => (x < 0n ? -x : x);
const worst = [];

for (const [, events] of streams) {
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    const k1 = a.vSol * a.vTok;
    const k2 = b.vSol * b.vTok;
    if (k1 === 0n) continue;

    const driftPpm = Number((absBig(k2 - k1) * 1_000_000n) / k1);
    const st = bucket(b.len);
    st.pairs += 1;
    st.driftPpmSum += driftPpm;
    allStats.pairs += 1;
    if (driftPpm > 1) {
      st.kDrift1ppm += 1;
      allStats.kDrift1ppm += 1;
    }
    if (driftPpm > 100) {
      st.kDrift100ppm += 1;
      allStats.kDrift100ppm += 1;
    }
    if (driftPpm > 1000) {
      st.kDrift1000ppm += 1;
      allStats.kDrift1000ppm += 1;
      if (worst.length < 12) {
        worst.push({
          lenPrev: a.len,
          len: b.len,
          isBuy: b.isBuy,
          vSolPrev: String(a.vSol),
          vTokPrev: String(a.vTok),
          vSol: String(b.vSol),
          vTok: String(b.vTok),
          dSol: String(b.vSol - a.vSol),
          dTok: String(b.vTok - a.vTok),
          solLamports: String(b.solLamports),
          tokenRaw: String(b.tokenRaw),
          driftPpm,
        });
      } else {
        const min = worst.reduce((m, w) => (w.driftPpm < m.driftPpm ? w : m), worst[0]);
        if (driftPpm > min.driftPpm) {
          const i = worst.indexOf(min);
          worst[i] = {
            lenPrev: a.len,
            len: b.len,
            isBuy: b.isBuy,
            vSolPrev: String(a.vSol),
            vTokPrev: String(a.vTok),
            vSol: String(b.vSol),
            vTok: String(b.vTok),
            dSol: String(b.vSol - a.vSol),
            dTok: String(b.vTok - a.vTok),
            solLamports: String(b.solLamports),
            tokenRaw: String(b.tokenRaw),
            driftPpm,
          };
        }
      }
    }

    const dSol = b.vSol - a.vSol;
    const dTok = b.vTok - a.vTok;
    const dirOk = b.isBuy === null ? true : b.isBuy ? dSol > 0n && dTok < 0n : dSol < 0n && dTok > 0n;
    if (!dirOk) {
      st.dirMismatch += 1;
      allStats.dirMismatch += 1;
    }

    // reserve delta vs the trade amounts carried by the same event (1% fee from the SOL input)
    const netIn = (b.solLamports * 9900n) / 10000n;
    const solMismatch = dSol > 0n ? absBig(dSol - netIn) * 100n > netIn : absBig(dSol) * 100n > netIn * 105n;
    const tokMismatch = absBig(absBig(dTok) - b.tokenRaw) * 100n > b.tokenRaw;
    if (solMismatch || tokMismatch) {
      st.amountMismatch += 1;
      allStats.amountMismatch += 1;
    }
  }
}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(2)}%` : "n/a");
const sorted = [...byLen.values()].sort((x, y) => y.pairs - x.pairs);

console.log("\n=== x*y = k INVARIANT between consecutive events of the same mint ===");
console.log(`mints: ${streams.size}   pairs checked: ${allStats.pairs}   skipped (no reserves): ${allStats.skippedNoReserves}`);
console.log(
  `k drift >1ppm: ${allStats.kDrift1ppm} (${pct(allStats.kDrift1ppm, allStats.pairs)})   ` +
    `>100ppm: ${allStats.kDrift100ppm} (${pct(allStats.kDrift100ppm, allStats.pairs)})   ` +
    `>1000ppm: ${allStats.kDrift1000ppm} (${pct(allStats.kDrift1000ppm, allStats.pairs)})`,
);
console.log(`direction mismatch: ${allStats.dirMismatch} (${pct(allStats.dirMismatch, allStats.pairs)})`);
console.log(`reserve delta vs trade amounts: ${allStats.amountMismatch} (${pct(allStats.amountMismatch, allStats.pairs)})`);

console.log("\n by payload length:");
console.log("  len    pairs   k>1ppm   k>100ppm   k>1000ppm   dir-bad   amount-bad   avg drift(ppm)");
for (const b of sorted) {
  console.log(
    `  ${String(b.len).padStart(4)}  ${String(b.pairs).padStart(7)}  ${String(b.kDrift1ppm).padStart(7)}  ` +
      `${String(b.kDrift100ppm).padStart(9)}  ${String(b.kDrift1000ppm).padStart(10)}  ${String(b.dirMismatch).padStart(8)}  ` +
      `${String(b.amountMismatch).padStart(11)}  ${(b.driftPpmSum / Math.max(1, b.pairs)).toFixed(1).padStart(13)}`,
  );
}

const out = path.join(ROOT, "data", "research", "invariants.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, mints: streams.size, all: allStats, byLen: sorted, worst }, null, 2),
);

if (worst.length) {
  console.log("\n worst k-drift pairs (reserve delta vs the trade amounts of the second event):");
  for (const w of worst.slice(0, 6)) {
    console.log(
      `  len ${w.lenPrev}->${w.len} isBuy=${w.isBuy} drift=${w.driftPpm}ppm dSol=${w.dSol} dTok=${w.dTok} ` +
        `amounts: sol=${w.solLamports} tok=${w.tokenRaw}`,
    );
  }
}
console.log(`\nwritten: ${out}`);
