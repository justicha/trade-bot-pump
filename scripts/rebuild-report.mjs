#!/usr/bin/env node
// Reconstruction report: can the curve be rebuilt from an anchor + trade amounts, and how well
// does it match the snapshot on each class of payload / each class of token?
//
//   node scripts/rebuild-report.mjs                 # data/raw
//   node scripts/rebuild-report.mjs --rpc-sample 6  # + getAccountInfo spot check
//
// Two models run side by side per mint:
//   open  — anchor once, then advance by the trade amounts and never look at the snapshot
//           (measures how much of the curve the amounts actually explain)
//   heal  — same, but if the error grows past --heal-ppm the snapshot becomes the new anchor
//           (a policy: unmodelled SOL flows exist, so a pure open loop drifts forever)
// Errors are reported in ppm against the snapshot (0 ppm = the model reproduces it exactly).
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { isMayhemCaller, isMayhemPath, MAYHEM_PROGRAM_ID } from "../lib/mayhem.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const RPC_SAMPLE = Number(argOf("--rpc-sample", "0"));
const HEAL_PPM = Number(argOf("--heal-ppm", "50000"));
const GOOD_LENS = new Set([403, 405, 425, 439]);

const perMint = new Map();
let records = 0;
for await (const rec of replayRaw(RAW_TARGET)) {
  records += 1;
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);
  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (!c || !c.launchParamsOk) continue;
    const m = perMint.get(c.mint) || { mint: c.mint, events: [], mayhem: false };
    m.createdAt = rec.ts;
    m.fromCreate = true;
    m.creator = c.creator;
    perMint.set(c.mint, m);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  const m = perMint.get(ev.mint) || { mint: ev.mint, createdAt: rec.ts, events: [], mayhem: false };
  if (isMayhemCaller(rec.outer) || isMayhemPath(rec.path)) m.mayhem = true;
  m.events.push({
    ts: rec.ts,
    slot: rec.slot,
    len: ev.len,
    outer: rec.outer,
    isBuy: ev.isBuyByte,
    solAmount: ev.solAmount,
    tokenAmount: ev.tokenAmount,
    hasReserves: ev.hasReserves,
    vSol: ev.reserves?.vSol ?? null,
    vTok: ev.reserves?.vTok ?? null,
    tradePrice: ev.tradePriceSol,
  });
  perMint.set(ev.mint, m);
}

const pctile = (arr, q) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
const fmt = (x) => (x === null || x === undefined ? "n/a" : String(Math.round(x)));

// ---- 1. trade-amount convention (measured, not assumed) ---------------------
const conv = { sol: [], tok: [] };
for (const m of perMint.values()) {
  if (m.mayhem) continue;
  const list = m.events.filter((e) => e.hasReserves);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (b.solAmount > 0) conv.sol.push(Math.abs(Number(b.vSol - a.vSol)) / 1e9 / b.solAmount);
    if (b.tokenAmount > 0) conv.tok.push(Math.abs(Number(b.vTok - a.vTok)) / 1e6 / b.tokenAmount);
  }
}
console.log(`=== REBUILD REPORT (${records} raw records, ${perMint.size} mints) ===`);
console.log("\n(1) measured convention on non-Mayhem pairs (ratio 1.00 = the model's arithmetic holds):");
console.log(
  `  |dvSol|/solAmount   : p50 ${(pctile(conv.sol, 0.5) * 100).toFixed(2)}%  p10 ${(pctile(conv.sol, 0.1) * 100).toFixed(2)}%  p90 ${(pctile(conv.sol, 0.9) * 100).toFixed(2)}%  n=${conv.sol.length}`,
);
console.log(
  `  |dvTok|/tokenAmount : p50 ${(pctile(conv.tok, 0.5) * 100).toFixed(2)}%  p10 ${(pctile(conv.tok, 0.1) * 100).toFixed(2)}%  p90 ${(pctile(conv.tok, 0.9) * 100).toFixed(2)}%  n=${conv.tok.length}`,
);

// ---- 2. reconstruction error per class -------------------------------------
const classes = {
  "non-Mayhem, good lens": { errK: [], errP: [], stepK: [], stepP: [], unexplained: [], n: 0 },
  "non-Mayhem, other lens": { errK: [], errP: [], stepK: [], stepP: [], unexplained: [], n: 0 },
  "Mayhem, good lens": { errK: [], errP: [], stepK: [], stepP: [], unexplained: [], n: 0 },
  "Mayhem, other lens": { errK: [], errP: [], stepK: [], stepP: [], unexplained: [], n: 0 },
};
const open = new CurveRebuild({ reanchorOnLargeErrorPpm: Number.POSITIVE_INFINITY });
const heal = new CurveRebuild({ reanchorOnLargeErrorPpm: HEAL_PPM });
// `step` re-anchors after every comparison, so its error is the error of ONE step
// (the trades between two snapshots) instead of an accumulated drift.
const step = new CurveRebuild({ reanchorOnLargeErrorPpm: 0 });

for (const m of perMint.values()) {
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  // startIdx = the event whose own trade is already reflected in the anchor we start from.
  let startIdx = -1;
  if (m.fromCreate) {
    open.seedFromCreate(m.mint, { ts: m.createdAt });
    heal.seedFromCreate(m.mint, { ts: m.createdAt });
    step.seedFromCreate(m.mint, { ts: m.createdAt });
    startIdx = -1; // the create anchor is pre-trade: apply every event
  } else {
    const iFirst = list.findIndex((e) => e.hasReserves);
    if (iFirst < 0) continue;
    const first = list[iFirst];
    for (const rb of [open, heal, step]) rb.seed(m.mint, { vSol: first.vSol, vTok: first.vTok, ts: first.ts, source: "snapshot" });
    startIdx = iFirst; // the first snapshot already contains its own trade
  }

  for (let i = startIdx + 1; i < list.length; i++) {
    const e = list[i];
    const amounts = { isBuy: e.isBuy, solAmount: e.solAmount, tokenAmount: e.tokenAmount, ts: e.ts };
    open.apply(m.mint, amounts);
    heal.apply(m.mint, amounts);
    step.apply(m.mint, amounts);
    if (!e.hasReserves) continue;
    const co = open.compare(m.mint, { vSol: e.vSol, vTok: e.vTok });
    heal.compare(m.mint, { vSol: e.vSol, vTok: e.vTok }); // may re-anchor
    const cs = step.compare(m.mint, { vSol: e.vSol, vTok: e.vTok }); // always re-anchors
    if (!co) continue;
    const good = GOOD_LENS.has(e.len);
    const c = classes[`${m.mayhem ? "Mayhem" : "non-Mayhem"}, ${good ? "good lens" : "other lens"}`];
    c.n += 1;
    if (co.errKPpm !== null) c.errK.push(co.errKPpm);
    if (co.errPricePpm !== null) c.errP.push(co.errPricePpm);
    if (cs && cs.errKPpm !== null) c.stepK.push(cs.errKPpm);
    if (cs && cs.errPricePpm !== null) c.stepP.push(cs.errPricePpm);
    c.unexplained.push(co.unexplainedSol);
  }
}

console.log("\n(2) reconstruction error against the event snapshot (ppm):");
console.log("  class                      n      step errK p50   p90   p99     open-loop errK p50     price p50/p90 (step)");
for (const [k, c] of Object.entries(classes)) {
  if (!c.n) continue;
  console.log(
    `  ${k.padEnd(24)} ${String(c.n).padStart(6)}  ${fmt(pctile(c.stepK, 0.5)).padStart(12)}  ${fmt(pctile(c.stepK, 0.9)).padStart(6)}  ${fmt(pctile(c.stepK, 0.99)).padStart(6)}  ` +
      `${fmt(pctile(c.errK, 0.5)).padStart(16)}  ${fmt(pctile(c.stepP, 0.5)).padStart(10)}/${fmt(pctile(c.stepP, 0.9))}`,
  );
}

const mayU = classes["Mayhem, good lens"].unexplained.concat(classes["Mayhem, other lens"].unexplained);
const nonU = classes["non-Mayhem, good lens"].unexplained.concat(classes["non-Mayhem, other lens"].unexplained);
const sumAbs = (a) => a.reduce((s, x) => s + Math.abs(x), 0);
const absAll = (a) => a.map((x) => Math.abs(x));
console.log("\n(3) SOL the snapshot moved that the trades do not explain (per event):");
console.log(`  non-Mayhem: p50 ${pctile(absAll(nonU), 0.5)?.toFixed(6)}  p90 ${pctile(absAll(nonU), 0.9)?.toFixed(6)}  total ${sumAbs(nonU).toFixed(3)} SOL`);
console.log(`  Mayhem    : p50 ${pctile(absAll(mayU), 0.5)?.toFixed(6)}  p90 ${pctile(absAll(mayU), 0.9)?.toFixed(6)}  total ${sumAbs(mayU).toFixed(3)} SOL`);
console.log(`  healer: ${heal.stats.reanchors} re-anchors (threshold ${HEAL_PPM} ppm); seeds create=${open.stats.seedsCreate} account=${open.stats.seedsAccount} snapshot=${open.stats.seedsSnapshot}`);



// ---- 4. price-source comparison against getAccountInfo ----------------------
let rpc = null;
if (RPC_SAMPLE > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  rpc = [];
  const picks = [];
  for (const m of perMint.values()) {
    const last = m.events[m.events.length - 1];
    if (!last || !last.hasReserves) continue;
    picks.push({ mint: m.mint, mayhem: m.mayhem, last });
  }
  picks.sort((a, b) => Number(b.mayhem) - Number(a.mayhem));
  console.log("\n(4) getAccountInfo check. The account holds the state at 'now', so an exact match is only");
  console.log("    possible when the mint's last event is seconds old. The account's own byte 81");
  console.log("    (is_mayhem_mode) is the authoritative test of the token class:");
  for (const p of picks.slice(0, RPC_SAMPLE)) {
    try {
      const info = await connection.getAccountInfo(getBondingCurve(new PublicKey(p.mint)));
      if (!info) {
        console.log(`  ${p.mint.slice(0, 8)} (${p.mayhem ? "mayhem" : "plain"}): no account (migrated?)`);
        continue;
      }
      const accVTok = info.data.readBigUInt64LE(8);
      const accVSol = info.data.readBigUInt64LE(16);
      const accFlag = info.data.length > 81 ? info.data[81] === 1 : null;
      const equal = accVSol === p.last.vSol && accVTok === p.last.vTok;
      rpc.push({ mint: p.mint, tradeEvidenceMayhem: p.mayhem, accountFlagMayhem: accFlag, agree: accFlag === p.mayhem, lastEventEqualsAccount: equal });
      console.log(
        `  ${p.mint.slice(0, 8)}: trade-evidence=${p.mayhem ? "mayhem" : "plain"}, account flag=${accFlag} ` +
          `${accFlag === p.mayhem ? "(agree)" : "(DISAGREE)"} | last event ${equal ? "== account" : "older than account"}`,
      );
    } catch (err) {
      console.log(`  ${p.mint.slice(0, 8)}: rpc error ${err.message}`);
    }
  }
  if (rpc.length) console.log(`  token class agreement: ${rpc.filter((r) => r.agree).length}/${rpc.length}`);
}

// ---- output -----------------------------------------------------------------
const summary = {
  at: new Date().toISOString(),
  records,
  mints: perMint.size,
  mayhemProgram: MAYHEM_PROGRAM_ID,
  mayhemMints: [...perMint.values()].filter((m) => m.mayhem).length,
  convention: { solRatioP50: pctile(conv.sol, 0.5), tokRatioP50: pctile(conv.tok, 0.5), n: conv.sol.length },
  classes: Object.fromEntries(
    Object.entries(classes).map(([k, c]) => [
      k,
      {
        n: c.n,
        // stepK/stepP = error of ONE step (model re-anchored after every comparison); this is the
        // number that says whether the reconstruction explains a trade.
        stepKPpm: { p50: pctile(c.stepK, 0.5), p90: pctile(c.stepK, 0.9), p99: pctile(c.stepK, 0.99) },
        stepPricePpm: { p50: pctile(c.stepP, 0.5), p90: pctile(c.stepP, 0.9) },
        // errK/errP = accumulated open-loop drift over the mint's whole life (context, not a test).
        openLoopKPpm: { p50: pctile(c.errK, 0.5), p90: pctile(c.errK, 0.9) },
        openLoopPricePpm: { p50: pctile(c.errP, 0.5), p90: pctile(c.errP, 0.9) },
        unexplainedSolTotal: sumAbs(c.unexplained),
      },
    ]),
  ),
  healer: { healPpm: HEAL_PPM, reanchors: heal.stats.reanchors, seeds: open.stats },
  rpc,
};
const out = path.join(ROOT, "data", "research", "rebuild.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\nwritten: ${out}`);
