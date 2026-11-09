#!/usr/bin/env node
// Task C — curve/price diagnostics. READ ONLY: nothing here changes a decision.
//
//   node scripts/diag-curve.mjs                 # data/journal + data/raw, small RPC sample
//   node scripts/diag-curve.mjs --rpc 8
//   node scripts/diag-curve.mjs --no-rpc
//
// Sections:
//   1. what the "virtualSolReserves" filter actually reads (reject records joined with the raw
//      capture, plus the live account fields of a few rejected mints)
//   2. curveType from the curve account byte 81 vs the journal's isMayhem (disagreement share)
//   3. start reserves per token type from create-v2 payloads, and why an entry can sit below the
//      assumed launch price of 2.796e-5
//   4. fast stop-losses: what the raw events say happened between buy and sell
import path from "node:path";
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { isMayhemCaller, isMayhemPath, MAYHEM_ACCOUNT_FLAG_OFFSET } from "../lib/mayhem.mjs";
import { readJournal } from "../lib/journal.mjs";
import { ROOT } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RPC_SAMPLE = argv.includes("--no-rpc") ? 0 : Number(argOf("--rpc", "5"));
const LAUNCH_RAW = 30e9 / 1.073e15; // 2.796e-5 SOL per raw unit (30 SOL / 1.073e9 tokens)
const JOURNAL = path.join(ROOT, "data", "journal");

const journal = readJournal(JOURNAL);
const trades = journal.filter((r) => r.type === "trade");
const rejects = journal.filter((r) => r.type === "reject");

// ---- raw capture indexed by mint ---------------------------------------------
const perMint = new Map();
const creates = new Map();
for await (const rec of replayRaw(RAW_DIR)) {
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);
  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (c && c.launchParamsOk) creates.set(c.mint, { vSol: c.reserves.vSol, vTok: c.reserves.vTok, rTok: c.reserves.rTok, supply: c.reserves.supply, len: c.len });
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  const list = perMint.get(ev.mint) || [];
  list.push({
    ts: rec.ts, len: ev.len,
    vSol: ev.reserves?.vSol ?? null, vTok: ev.reserves?.vTok ?? null,
    rSol: ev.reserves?.realSol ?? null, rTok: ev.reserves?.realTok ?? null,
    isBuy: ev.isBuyByte, tokenAmount: ev.tokenAmount, solAmount: ev.solAmount,
    mayhem: isMayhemCaller(rec.outer) || isMayhemPath(rec.path),
  });
  perMint.set(ev.mint, list);
}

const nearest = (mint, ts, windowMs = 60_000) => {
  const list = perMint.get(mint);
  if (!list) return null;
  let best = null;
  for (const e of list) {
    const d = Math.abs(e.ts - ts);
    if (d <= windowMs && (best === null || d < Math.abs(best.ts - ts))) best = e;
  }
  return best;
};
const sol = (lamports) => (lamports === null || lamports === undefined ? null : Number(lamports) / 1e9);
const fmt = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? "n/a" : Number(x).toFixed(d));

// ---- 1. what does the filter read? -------------------------------------------
console.log("=== 1. the 'virtualSolReserves' filter: which field, which units ===");
console.log("code: lib/curve.mjs checkCurve() compares state.virtualSolReserves against bounds.vSolMin/Max");
console.log("      lib/pumpfun.mjs getBondingCurveState(): virtualTokenReserves = account offset 8, virtualSolReserves = offset 16 (lamports)\n");
{
  const rows = [];
  for (const r of rejects) {
    const m = /virtualSolReserves ([\d.]+) SOL (below the ([\d.]+) SOL floor|above the ceiling)/.exec(String(r.reason || ""));
    const ts = Date.parse(r.ts);
    const near = nearest(r.mint, ts);
    rows.push({
      mint: r.mint,
      class: m ? (m[2].startsWith("below") ? "floor" : "ceiling") : "other",
      loggedVSol: sol(r.vSol),
      loggedVTok: r.vTok === undefined ? null : Number(r.vTok) / 1e6,
      rawVSol: near ? sol(near.vSol) : null,
      rawVTok: near ? Number(near.vTok) / 1e6 : null,
      rawRSol: near ? sol(near.rSol) : null,
      rawLen: near ? near.len : null,
      rawMayhem: near ? near.mayhem : null,
    });
  }
  const floor = rows.filter((r) => r.class === "floor");
  const ceil = rows.filter((r) => r.class === "ceiling");
  console.log(`rejects: ${rows.length} (floor ${floor.length}, ceiling ${ceil.length})`);
  console.log("\n  mint      class     logged vSol  logged vTok(whole)   raw vSol   raw rSol   raw len  mayhem  matches?");
  for (const r of rows.slice(0, 10)) {
    const close = r.rawVSol !== null && r.loggedVSol !== null ? Math.abs(r.rawVSol - r.loggedVSol) / Math.max(1e-9, r.rawVSol) < 0.05 : null;
    console.log(
      `  ${r.mint.slice(0, 8)}  ${String(r.class).padEnd(8)} ${fmt(r.loggedVSol, 6).padStart(12)} ${fmt(r.loggedVTok, 0).padStart(18)} ${fmt(r.rawVSol, 3).padStart(10)} ${fmt(r.rawRSol, 3).padStart(10)} ${String(r.rawLen ?? "n/a").padStart(8)}  ${String(r.rawMayhem ?? "n/a").padStart(6)}  ${close === null ? "no raw" : close ? "YES" : "no"}`,
    );
  }
  const withRaw = rows.filter((r) => r.rawVSol !== null);
  const matched = withRaw.filter((r) => Math.abs(r.rawVSol - r.loggedVSol) / Math.max(1e-9, r.rawVSol) < 0.05).length;
  console.log(`\n  logged vSol matches the raw payload vSol in ${matched}/${withRaw.length} rejects with a raw event within 60 s`);
  const attempts = rows.length + trades.length;
  console.log(`  share of entries refused by this filter: ${rows.length}/${attempts} = ${attempts ? ((rows.length / attempts) * 100).toFixed(1) : "n/a"}%`);
  const priced = floor.filter((r) => r.rawVSol !== null && r.rawVTok !== null && r.rawVTok > 0);
  if (priced.length) {
    const v = priced.map((r) => (r.rawVSol / r.rawVTok) * 1e3); // SOL per whole token
    console.log(`  floor rejects with raw data: ${priced.length}, price ${Math.min(...v).toExponential(2)} .. ${Math.max(...v).toExponential(2)} SOL/token`);
    const withReal = priced.filter((r) => r.rawRSol !== null);
    const passReal = withReal.filter((r) => r.rawRSol >= 0.5).length;
    console.log(`  with a REAL-reserve floor (realSol >= 0.5 SOL) instead of the virtual one: ${passReal}/${withReal.length} would be admitted`);
  }
}

if (RPC_SAMPLE > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  console.log(`\n  live curve account fields for up to ${RPC_SAMPLE} rejected mint(s):`);
  for (const r of rejects.slice(0, RPC_SAMPLE)) {
    try {
      const info = await connection.getAccountInfo(getBondingCurve(new PublicKey(r.mint)));
      if (!info) {
        console.log(`    ${r.mint.slice(0, 8)}: no curve account (graduated / closed)`);
        continue;
      }
      const d = info.data;
      const u = (o) => (d.length >= o + 8 ? d.readBigUInt64LE(o) : null);
      console.log(
        `    ${r.mint.slice(0, 8)}: len ${d.length} | @8 vTok ${fmt(Number(u(8)) / 1e6, 0)} | @16 vSol ${fmt(sol(u(16)), 4)} SOL | @24 rTok ${fmt(Number(u(24)) / 1e6, 0)} | @32 rSol ${fmt(sol(u(32)), 4)} SOL | complete ${d[48]} | mayhem ${d[MAYHEM_ACCOUNT_FLAG_OFFSET]}`,
      );
      console.log(`      at reject time: vSol ${fmt(sol(r.vSol), 6)} SOL, vTok ${fmt(Number(r.vTok) / 1e6, 0)}`);
    } catch (err) {
      console.log(`    ${r.mint.slice(0, 8)}: rpc error ${err.message}`);
    }
  }
}

// ---- 2. curveType from the account vs the journal's isMayhem ------------------
if (RPC_SAMPLE > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  console.log("\n=== 2. curveType from the curve account (byte 81) vs the journal's isMayhem ===");
  const byMint = new Map();
  for (const t of trades) if (t.isMayhem !== undefined) byMint.set(t.mint, Boolean(t.isMayhem));
  const sample = [...byMint.keys()].slice(0, RPC_SAMPLE * 6);
  let agree = 0;
  let disagree = 0;
  let unknown = 0;
  const mismatches = [];
  for (const mint of sample) {
    try {
      const info = await connection.getAccountInfo(getBondingCurve(new PublicKey(mint)));
      if (!info || info.data.length <= MAYHEM_ACCOUNT_FLAG_OFFSET) {
        unknown += 1;
        continue;
      }
      const flag = info.data[MAYHEM_ACCOUNT_FLAG_OFFSET] === 1;
      if (flag === byMint.get(mint)) agree += 1;
      else {
        disagree += 1;
        if (mismatches.length < 5) mismatches.push(`${mint.slice(0, 8)}: journal isMayhem=${byMint.get(mint)}, account byte81=${flag}`);
      }
    } catch {
      unknown += 1;
    }
  }
  const total = agree + disagree;
  console.log(`  sampled ${sample.length} mints: account readable ${total}, unavailable ${unknown}`);
  console.log(`  agreement ${agree}/${total} (${total ? ((agree / total) * 100).toFixed(1) : "n/a"}%), disagreement ${disagree}`);
  for (const m of mismatches) console.log(`    ${m}`);
  console.log("  note: the account flag is available BEFORE entry (getBondingCurveState returns isMayhemMode),");
  console.log("        so curveType can be decided from the account instead of from the first Mayhem trade.");
}


// ---- 3. start reserves per token type + entries below the assumed launch price -
console.log("\n=== 3. start reserves from create-v2 payloads, and entries below 2.796e-5 ===");
{
  const mayhemByMint = new Map();
  for (const t of trades) if (t.isMayhem !== undefined) mayhemByMint.set(t.mint, Boolean(t.isMayhem));
  const rows = [...creates.entries()].map(([mint, c]) => ({
    mint,
    mayhem: mayhemByMint.has(mint) ? mayhemByMint.get(mint) : null,
    vSol: Number(c.vSol) / 1e9,
    vTok: Number(c.vTok) / 1e6,
    price: Number(c.vSol) / 1e9 / (Number(c.vTok) / 1e6),
  }));
  const withType = rows.filter((r) => r.mayhem !== null);
  for (const type of [false, true]) {
    const set = withType.filter((r) => r.mayhem === type);
    if (!set.length) {
      console.log(`  ${type ? "mayhem" : "standard"}: no create payloads with a known type in this capture`);
      continue;
    }
    const uniq = [...new Set(set.map((r) => r.price.toExponential(4)))];
    console.log(
      `  ${type ? "mayhem" : "standard"}: ${set.length} create payloads, launch price ${uniq.join(", ")} SOL/token ` +
        `(vSol ${Math.min(...set.map((r) => r.vSol))}..${Math.max(...set.map((r) => r.vSol))} SOL, ` +
        `vTok ${Math.min(...set.map((r) => r.vTok)).toExponential(3)}..${Math.max(...set.map((r) => r.vTok)).toExponential(3)})`,
    );
  }
  const below = trades.filter((t) => Number(t.entrySol) > 0 && Number(t.entrySol) < LAUNCH_RAW);
  console.log(`  journal entries with entrySol < ${LAUNCH_RAW.toExponential(4)}: ${below.length}`);
  const withCreate = below.filter((t) => creates.has(t.mint));
  for (const t of withCreate.slice(0, 8)) {
    const c = creates.get(t.mint);
    const launch = Number(c.vSol) / 1e9 / (Number(c.vTok) / 1e6);
    console.log(`    ${t.mint.slice(0, 8)}: entry ${Number(t.entrySol).toExponential(4)} vs its launch ${launch.toExponential(4)} -> premium ${(((Number(t.entrySol) - launch) / launch) * 100).toFixed(1)}%`);
  }
  console.log(`    ${below.length - withCreate.length} have no create payload (created outside the capture window): launch price cannot be checked offline`);
  console.log("  code: ratio = getPrice(state) / pos.entryPrice; getPrice() = virtualSolReserves / virtualTokenReserves of the ACCOUNT,");
  console.log("        so the ratio is state-based and never derived from the last trade's price.");
}

// ---- 4. fast stop-losses -----------------------------------------------------
console.log("\n=== 4. fast stop-losses (holdSec <= 30): what the raw events say ===");
{
  const fast = trades
    .filter((t) => String(t.exitReason || "").startsWith("stop-loss") && Number(t.holdSec) <= 30)
    .sort((a, b) => Number(a.ratio) - Number(b.ratio));
  console.log(`  ${fast.length} stop-loss trades with holdSec <= 30; showing up to 12 (worst first)`);
  console.log("  mint      hold  ratio  rawEv  sells  biggestSell  vSol->vSol   rSol->rSol   mayhem%  price before -> after");
  let byMayhem = 0;
  let byBigSell = 0;
  let ambiguous = 0;
  for (const t of fast.slice(0, 12)) {
    const list = perMint.get(t.mint) || [];
    const buyMs = Date.parse(t.buyAt || t.ts);
    const sellMs = Date.parse(t.sellAt || t.ts);
    const win = list.filter((e) => e.ts >= buyMs - 1000 && e.ts <= sellMs + 5000);
    const sells = win.filter((e) => !e.isBuy);
    const biggest = sells.reduce((m, e) => Math.max(m, Number(e.solAmount || 0)), 0);
    const first = win[0] || null;
    const last = win[win.length - 1] || null;
    const mayhemShare = win.length ? win.filter((e) => e.mayhem).length / win.length : 0;
    const priceBefore = first && first.vSol && first.vTok ? (Number(first.vSol) / Number(first.vTok)) * 1e3 : null;
    const priceAfter = last && last.vSol && last.vTok ? (Number(last.vSol) / Number(last.vTok)) * 1e3 : null;
    if (mayhemShare >= 0.5) byMayhem += 1;
    else if (biggest > 0 && Number(t.buySol) > 0 && biggest / Number(t.buySol) >= 2) byBigSell += 1;
    else ambiguous += 1;
    console.log(
      `  ${t.mint.slice(0, 8)}  ${String(t.holdSec).padStart(4)}  ${Number(t.ratio).toFixed(2)}  ${String(win.length).padStart(5)}  ${String(sells.length).padStart(5)}  ${fmt(biggest, 4).padStart(11)}  ` +
        `${fmt(first ? sol(first.vSol) : null, 2).padStart(9)}  ${fmt(last ? sol(last.rSol) : null, 6).padStart(9)}  ${(mayhemShare * 100).toFixed(0).padStart(6)}%  ${priceBefore ? priceBefore.toExponential(2) : "n/a"} -> ${priceAfter ? priceAfter.toExponential(2) : "n/a"}`,
    );
  }
  console.log(`\n  shown: ${byMayhem} in a Mayhem-dominated window (its SOL side is unreliable), ${byBigSell} with a single sell >= 2x our buy, ${ambiguous} unexplained.`);
  const noRaw = fast.filter((t) => !(perMint.get(t.mint) || []).length).length;
  console.log(`  ${noRaw} of ${fast.length} fast SL trades have no raw events at all (outside the capture window)`);
}


