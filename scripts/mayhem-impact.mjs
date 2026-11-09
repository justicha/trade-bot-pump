#!/usr/bin/env node
// Mayhem impact (step 5): what changes if Mayhem's trades are removed from the picture?
//
//   node scripts/mayhem-impact.mjs              # data/raw
//
// Descriptive statistics only — nothing here chooses or tunes a strategy.
// For every mint two books are kept: one with all trades, one with Mayhem's trades removed.
//   * holders / unique buyers / slots at the end of the observed window
//   * the moment the sniper's gate (>= MIN_HOLDERS distinct positive wallets) would fire
//   * the price 30/60/120 s after that moment, as a multiple of the price at that moment
//     (prices come from the rebuilt curve, scripts/coverage.mjs variant F)
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { isMayhemCaller, isMayhemPath } from "../lib/mayhem.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const MIN_HOLDERS = Number(argOf("--min-holders", "4"));
const HORIZONS = [30, 60, 120];

const perMint = new Map();
for await (const rec of replayRaw(RAW_TARGET)) {
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);
  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (!c || !c.launchParamsOk) continue;
    const m = perMint.get(c.mint) || { mint: c.mint, events: [] };
    m.createdAt = rec.ts;
    m.fromCreate = true;
    perMint.set(c.mint, m);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  const m = perMint.get(ev.mint) || { mint: ev.mint, events: [] };
  m.events.push({
    ts: rec.ts,
    slot: rec.slot,
    isBuy: ev.isBuyByte,
    tokenAmount: ev.tokenAmount,
    solAmount: ev.solAmount,
    user: ev.user,
    hasReserves: ev.hasReserves,
    vSol: ev.reserves?.vSol ?? null,
    vTok: ev.reserves?.vTok ?? null,
    mayhem: isMayhemCaller(rec.outer) || isMayhemPath(rec.path),
  });
  perMint.set(ev.mint, m);
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};
const fmt = (x, digits = 2) => (x === null || x === undefined ? "n/a" : x.toFixed(digits));

// One book per mint: all trades, or all trades except Mayhem's.
function book(mint, excludeMayhem) {
  const m = perMint.get(mint);
  const balances = new Map();
  const buyers = new Set();
  const slots = new Set();
  let gateTs = null;
  let trades = 0;
  for (const ev of m.events) {
    if (excludeMayhem && ev.mayhem) continue;
    trades += 1;
    const delta = ev.isBuy ? ev.tokenAmount : -ev.tokenAmount;
    balances.set(ev.user, (balances.get(ev.user) || 0) + delta);
    if (ev.isBuy && delta > 0) buyers.add(ev.user);
    if (ev.slot !== null) slots.add(ev.slot);
    if (gateTs === null) {
      let holders = 0;
      for (const v of balances.values()) if (v > 0) holders += 1;
      if (holders >= MIN_HOLDERS) gateTs = ev.ts;
    }
  }
  let holders = 0;
  for (const v of balances.values()) if (v > 0) holders += 1;
  return { holders, buyers: buyers.size, slots: slots.size, gateTs, trades };
}

const priceAt = (timeline, atMs) => {
  let best = null;
  for (const p of timeline) {
    if (p.ts <= atMs) best = p;
    else break;
  }
  return best ? best.price : null;
};

// ---- collect -----------------------------------------------------------------
const rows = [];
for (const [mint, m] of perMint) {
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  const rb = new CurveRebuild({ reanchorOnLargeErrorPpm: 1000 });
  if (m.fromCreate) {
    rb.seedFromCreate(mint, { ts: m.createdAt });
  } else {
    const f = list.find((e) => e.hasReserves);
    if (!f) continue;
    rb.seed(mint, { vSol: f.vSol, vTok: f.vTok, ts: f.ts, source: "snapshot" });
  }
  const timeline = [];
  for (const ev of list) {
    rb.apply(mint, { isBuy: ev.isBuy, solAmount: ev.solAmount, tokenAmount: ev.tokenAmount, ts: ev.ts });
    if (ev.hasReserves) rb.compare(mint, { vSol: ev.vSol, vTok: ev.vTok });
    const p = rb.priceOf(mint);
    if (p && Number.isFinite(p) && p > 0) timeline.push({ ts: ev.ts, price: p });
  }
  const all = book(mint, false);
  const noMay = book(mint, true);
  const ratios = {};
  for (const h of HORIZONS) {
    const base = all.gateTs;
    const p0 = base ? priceAt(timeline, base) : null;
    const p1 = base ? priceAt(timeline, base + h * 1000) : null;
    ratios[h] = p0 && p1 ? p1 / p0 : null;
  }
  rows.push({ mint, mayhem: list.some((e) => e.mayhem), all, noMay, ratios, mayhemTrades: list.filter((e) => e.mayhem).length, trades: list.length });
}

const cls = { mayhem: rows.filter((r) => r.mayhem), plain: rows.filter((r) => !r.mayhem) };
const pctf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
console.log(`=== MAYHEM IMPACT (${rows.length} mints, gate >= ${MIN_HOLDERS} holders) ===`);

console.log("\n(1) how much of the stream is Mayhem");
for (const [name, set] of Object.entries(cls)) {
  const trades = set.reduce((s, r) => s + r.trades, 0);
  const mayTrades = set.reduce((s, r) => s + r.mayhemTrades, 0);
  console.log(`  ${name.padEnd(7)} tokens ${String(set.length).padStart(4)} (${pctf(set.length, rows.length)})  trades ${String(trades).padStart(6)}  of them Mayhem ${String(mayTrades).padStart(6)} (${pctf(mayTrades, trades)})`);
}

console.log("\n(2) holders / unique buyers / slots at the end of the window (medians)");
console.log("  class      n   holders  w/o Mayhem   buyers  w/o Mayhem   slots  w/o Mayhem");
for (const [name, set] of Object.entries(cls)) {
  console.log(
    `  ${name.padEnd(7)} ${String(set.length).padStart(4)} ${fmt(median(set.map((r) => r.all.holders)), 1).padStart(9)} ${fmt(median(set.map((r) => r.noMay.holders)), 1).padStart(12)} ` +
      `${fmt(median(set.map((r) => r.all.buyers)), 1).padStart(8)} ${fmt(median(set.map((r) => r.noMay.buyers)), 1).padStart(12)} ${fmt(median(set.map((r) => r.all.slots)), 1).padStart(7)} ${fmt(median(set.map((r) => r.noMay.slots)), 1).padStart(12)}`,
  );
}

console.log(`\n(3) would the gate (>= ${MIN_HOLDERS} holders) fire without Mayhem's trades?`);
for (const [name, set] of Object.entries(cls)) {
  const withGate = set.filter((r) => r.all.gateTs !== null).length;
  const noGate = set.filter((r) => r.noMay.gateTs !== null).length;
  console.log(`  ${name.padEnd(7)} with Mayhem ${withGate}/${set.length} (${pctf(withGate, set.length)})   without Mayhem ${noGate}/${set.length} (${pctf(noGate, set.length)})`);
}

console.log("\n(4) price after the gate fires (multiple of the price at that moment)");
console.log("  class   horizon     n     p25   median    p75   share > 1");
for (const [name, set] of Object.entries(cls)) {
  for (const h of HORIZONS) {
    const vals = set.map((r) => r.ratios[h]).filter((x) => Number.isFinite(x));
    if (!vals.length) continue;
    const sorted = vals.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    console.log(
      `  ${name.padEnd(7)} +${String(h).padStart(3)}s ${String(vals.length).padStart(6)} ${fmt(q(0.25)).padStart(7)} ${fmt(q(0.5)).padStart(8)} ${fmt(q(0.75)).padStart(6)}   ` +
        `${((vals.filter((v) => v > 1).length / vals.length) * 100).toFixed(0)}%`,
    );
  }
}
console.log("\n  descriptive only: medians over one capture window, not an edge, and no strategy parameter is touched");

