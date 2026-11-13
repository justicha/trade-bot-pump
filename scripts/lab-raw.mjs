#!/usr/bin/env node
// Lab on raw data (step 1 + step 2): the same capture files, one execution model, a grid of
// latency x slippage, and a set of entry policies side by side.
//
//   node scripts/lab-raw.mjs                     # data/raw
//   node scripts/lab-raw.mjs --rpc-flags 40      # resolve is_mayhem_mode (byte 81) for gated mints
//
// Variants (entry policy; exits are the sniper's own: TP 2.0x, SL 0.5x, timeout 120 s):
//   N   buy nothing (the zero line, so every other row has a reference)
//   A0  current logic: >= 4 distinct holders, >= 1 slot, no delay
//   M   A0 but only Mayhem tokens (class control)
//   B0  A0 but only NON-Mayhem tokens
//   B1  B0 + holders/buyers counted WITHOUT Mayhem wallets and trades, >= 4 unique buyers,
//       >= 2 slots
//   B2  B1 + time stop: exit at 40 s if the price is below +30%
//
// Execution model, identical for every variant: decision at the gate moment, fill at the first
// price at least `latency` ms later, exits on the first later price that hits a rule. Costs come
// from lib/fees.mjs with the slippage of the grid cell. No position cap and no per-slot sharing:
// this is a measurement of policies, not a portfolio simulation.
import fs from "node:fs";
import path from "node:path";
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { HolderTracker } from "../lib/holders.mjs";
import { roundTripCosts } from "../lib/fees.mjs";
import { bootstrapCI } from "../lib/research.mjs";
import { isMayhemCaller, isMayhemPath, MAYHEM_PROGRAM_ID } from "../lib/mayhem.mjs";
import { ROOT } from "../lib/config.mjs";
import { fmtMsk, mskIso } from "../lib/time.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const RPC_FLAGS = Number(argOf("--rpc-flags", "0"));
const FLAG_CACHE = path.join(ROOT, "data", "research", "mayhem-flags.json");
const LATENCIES = [300, 600, 1200];
const SLIPPAGES = [50, 100, 200];
const MIN_HOLDERS = 4;
const TP = 2.0;
const SL = 0.5;
const TIMEOUT_SEC = 120;
const TIME_STOP_SEC = 40;
const TIME_STOP_MIN_RATIO = 1.3;
const BUY_SOL = 0.02;
const HOLDOUT_SHARE = 0.3; // the last 30% of exits, same split as lib/research.mjs
const TARGET_HOLDOUT = 300;
const BLOCK_MS = 10 * 60 * 1000; // "10-minute blocks" for the block bootstrap
const FREEZE_FILE = path.join(ROOT, "data", "research", "frozen.json");
const FREEZE_LATENCY = 600; // the frozen verdict is judged at these two settings only
const FREEZE_SLIPPAGE = 100;

// ---- load -------------------------------------------------------------------
const perMint = new Map();
let windowFrom = Infinity;
let windowTo = -Infinity;
let tradeEvents = 0;
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
    m.creator = c.creator;
    perMint.set(c.mint, m);
    windowFrom = Math.min(windowFrom, rec.ts);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  tradeEvents += 1;
  windowFrom = Math.min(windowFrom, rec.ts);
  windowTo = Math.max(windowTo, rec.ts);
  const m = perMint.get(ev.mint) || { mint: ev.mint, events: [] };
  m.events.push({
    ts: rec.ts,
    slot: rec.slot,
    isBuy: ev.isBuyByte,
    solAmount: ev.solAmount,
    tokenAmount: ev.tokenAmount,
    user: ev.user,
    hasReserves: ev.hasReserves,
    vSol: ev.reserves?.vSol ?? null,
    vTok: ev.reserves?.vTok ?? null,
    mayhem: isMayhemCaller(rec.outer) || isMayhemPath(rec.path),
  });
  perMint.set(ev.mint, m);
}
const windowHours = (windowTo - windowFrom) / 3600_000;
console.log(`=== LAB ON RAW (${RAW_TARGET}) ===`);

// ---- prices + gates per mint -------------------------------------------------
const priceAt = (timeline, atMs) => {
  let best = null;
  for (const p of timeline) {
    if (p.ts <= atMs) best = p;
    else break;
  }
  return best ? best.price : null;
};

const gateTracker = () => new HolderTracker({ minHolders: MIN_HOLDERS, minSlots: 1, minDelayMs: 0, waitMs: 60_000 });
const strictTracker = () => new HolderTracker({ minHolders: MIN_HOLDERS, minSlots: 2, minDelayMs: 0, waitMs: 60_000 });

const mints = [];
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

  // A0 gate over all trades
  const t1 = gateTracker();
  let gateTs = null;
  for (const ev of list) {
    t1.track(mint, { at: ev.ts, slot: ev.slot });
    const snap = t1.apply(mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: ev.ts, slot: ev.slot });
    if (snap && snap.ready && t1.organic(snap)) {
      gateTs = ev.ts;
      break;
    }
  }
  // B1 gate: Mayhem wallets and trades removed, >= 4 buyers from >= 2 slots
  const t2 = strictTracker();
  let gateStrictTs = null;
  for (const ev of list) {
    if (ev.mayhem) continue;
    t2.track(mint, { at: ev.ts, slot: ev.slot });
    const snap = t2.apply(mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: ev.ts, slot: ev.slot });
    if (snap && snap.ready && t2.organic(snap)) {
      gateStrictTs = ev.ts;
      break;
    }
  }
  mints.push({ mint, timeline, gateTs, gateStrictTs, tradeMayhem: list.some((e) => e.mayhem), mayhemTrades: list.filter((e) => e.mayhem).length });
}

// ---- is_mayhem_mode from the curve account (byte 81) ------------------------
const flagCache = (() => {
  try {
    return JSON.parse(fs.readFileSync(FLAG_CACHE, "utf8"));
  } catch {
    return {};
  }
})();
if (RPC_FLAGS > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  const gated = mints.filter((m) => m.gateTs !== null && flagCache[m.mint] === undefined).slice(0, RPC_FLAGS);
  console.log(`\n  resolving is_mayhem_mode for ${gated.length} gated mint(s) via getAccountInfo...`);
  for (const m of gated) {
    try {
      const info = await connection.getAccountInfo(getBondingCurve(new PublicKey(m.mint)));
      flagCache[m.mint] = info && info.data.length > 81 ? info.data[81] === 1 : null;
    } catch {
      flagCache[m.mint] = null;
    }
  }
  fs.mkdirSync(path.dirname(FLAG_CACHE), { recursive: true });
  fs.writeFileSync(FLAG_CACHE, JSON.stringify(flagCache, null, 2));
}
let flagAgree = 0;
let flagChecked = 0;
for (const m of mints) {
  const f = flagCache[m.mint];
  m.accountFlag = typeof f === "boolean" ? f : null;
  if (m.accountFlag !== null) {
    flagChecked += 1;
    if (m.accountFlag === m.tradeMayhem) flagAgree += 1;
  }
  // the user's definition: the account flag OR any Mayhem trade in the stream
  m.mayhem = m.accountFlag === true || m.tradeMayhem;
}
console.log(`  is_mayhem_mode resolved for ${flagChecked} mint(s), agrees with trade evidence ${flagAgree}/${flagChecked}`);

// ---- block bootstrap ---------------------------------------------------------
// Trades of one token are not independent: they share a launch, a creator, a moment in time. A
// plain per-trade bootstrap therefore understates the CI. Two clusterings are computed next to it:
// 10-minute time blocks (drift, market regime) and creator clusters (one wallet launching many
// tokens). The number of blocks/clusters is the effective number of independent observations.
function groupBy(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, list }));
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cluster bootstrap of the mean: resample GROUPS, take every trade inside the sampled group.
function clusterBootstrapCI(trades, keyFn, { resamples = 2000, alpha = 0.05, seed = 11 } = {}) {
  const groups = groupBy(trades, keyFn);
  if (!groups.length) return { n: 0, units: 0, lo: 0, hi: 0, mean: 0 };
  const rand = rng(seed);
  const means = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[Math.floor(rand() * groups.length)];
      for (const t of g.list) {
        sum += t.pnlPct;
        count += 1;
      }
    }
    means.push(count ? sum / count : 0);
  }
  means.sort((a, b) => a - b);
  const pick = (q) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))];
  const all = trades.map((t) => t.pnlPct);
  return { n: all.length, units: groups.length, mean: all.reduce((a, b) => a + b, 0) / all.length, lo: pick(alpha / 2), hi: pick(1 - alpha / 2) };
}

const blockKey = (t) => Math.floor(t.exitTs / BLOCK_MS);
const creatorKey = (t) => t.creator || `unknown:${t.mint}`;

function runTrade({ timeline, decisionTs, latencyMs, slippageBps, timeStop }) {
  const fill = timeline.find((p) => p.ts >= decisionTs + latencyMs);
  if (!fill || !(fill.price > 0)) return null;
  const entryPrice = fill.price;
  let exit = null;
  for (const p of timeline) {
    if (p.ts <= fill.ts) continue;
    const ratio = p.price / entryPrice;
    const heldSec = (p.ts - fill.ts) / 1000;
    if (ratio >= TP) exit = { ts: p.ts, price: p.price, reason: "take-profit" };
    else if (ratio <= SL) exit = { ts: p.ts, price: p.price, reason: "stop-loss" };
    else if (heldSec >= TIMEOUT_SEC) exit = { ts: p.ts, price: p.price, reason: "timeout" };
    else if (timeStop && heldSec >= TIME_STOP_SEC && ratio < TIME_STOP_MIN_RATIO) exit = { ts: p.ts, price: p.price, reason: "time-stop-40s" };
    if (exit) break;
  }
  if (!exit) {
    const last = timeline[timeline.length - 1];
    exit = { ts: last.ts, price: last.price, reason: "end of window" };
  }
  const ratio = exit.price / entryPrice;
  const costs = roundTripCosts({ buySol: BUY_SOL, ratio, slippageBps });
  return {
    entryTs: fill.ts,
    exitTs: exit.ts,
    reason: exit.reason,
    ratio,
    pnlSol: costs.netPnl,
    pnlPct: (costs.netPnl / BUY_SOL) * 100,
  };
}


// ---- run the grid ------------------------------------------------------------
// ---- freeze / preregistration ----------------------------------------------
// `--freeze B2 --control A0 --control N` locks the choice, the parameters and the cost scheme into
// data/research/frozen.json. From then on only tokens whose decision happens AFTER that timestamp
// count, and the verdict has a fixed, pre-declared bar. That is what stops "the best variant" from
// being picked after seeing the results.
const freezeIdx = argv.indexOf("--freeze");
const freezeChoice = freezeIdx >= 0 ? argv[freezeIdx + 1] : null;
const freezeControls = argv.reduce((acc, a, i) => (a === "--control" && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
if (freezeChoice) {
  const frozen = {
    frozenAt: Date.now(),
    frozenAtIso: new Date().toISOString(),
    frozenAtMsk: mskIso(),
    codeVersion: process.env.GIT_COMMIT || null,
    choice: freezeChoice,
    controls: freezeControls,
    params: { MIN_HOLDERS, TP, SL, TIMEOUT_SEC, TIME_STOP_SEC, TIME_STOP_MIN_RATIO, BUY_SOL, BLOCK_MS },
    verdictRule: { minTrades: 300, minHours: 72, requireAllUtcHours: true, alpha: 0.01, latencyMs: FREEZE_LATENCY, slippageBps: FREEZE_SLIPPAGE, ci: "block-bootstrap by 10-minute blocks" },
    costsScheme: (await import("../lib/fees.mjs")).COSTS_SCHEME,
  };
  fs.mkdirSync(path.dirname(FREEZE_FILE), { recursive: true });
  fs.writeFileSync(FREEZE_FILE, JSON.stringify(frozen, null, 2));
  console.log(`\nfrozen: ${freezeChoice} (controls ${freezeControls.join(", ") || "none"}) -> ${FREEZE_FILE}`);
  console.log("from now on only decisions after this timestamp count; run without --freeze to evaluate");
  process.exit(0);
}
const frozen = fs.existsSync(FREEZE_FILE) ? JSON.parse(fs.readFileSync(FREEZE_FILE, "utf8")) : null;
if (frozen) console.log(`\n  frozen at ${frozen.frozenAtIso}: choice ${frozen.choice}, controls ${(frozen.controls || []).join(", ")} — only later decisions count`);

const VARIANTS = ["N", "A0", "M", "B0", "B1", "B2"];


const picks = {
  N: () => null,
  A0: (m) => m.gateTs,
  M: (m) => (m.mayhem ? m.gateTs : null),
  B0: (m) => (!m.mayhem ? m.gateTs : null),
  B1: (m) => (!m.mayhem ? m.gateStrictTs : null),
  B2: (m) => (!m.mayhem ? m.gateStrictTs : null),
};

const rows = [];
for (const variant of VARIANTS) {
  for (const latencyMs of LATENCIES) {
    for (const slippageBps of SLIPPAGES) {
      const trades = [];
      for (const m of mints) {
        const decisionTs = picks[variant](m);
        if (!decisionTs) continue;
        if (frozen && decisionTs <= frozen.frozenAt) continue; // preregistration: only later decisions
        const t = runTrade({ timeline: m.timeline, decisionTs, latencyMs, slippageBps, timeStop: variant === "B2" });
        if (t) trades.push({ ...t, mint: m.mint, mayhem: m.mayhem, creator: m.creator || null });
      }
      const pcts = trades.map((t) => t.pnlPct);
      const ci = bootstrapCI(pcts, { resamples: 2000, seed: 42 });
      const ciBlock = clusterBootstrapCI(trades, blockKey, { resamples: 2000, alpha: 0.05, seed: 11 });
      const ciBlock99 = clusterBootstrapCI(trades, blockKey, { resamples: 2000, alpha: 0.01, seed: 12 });
      const ciCreator = clusterBootstrapCI(trades, creatorKey, { resamples: 2000, alpha: 0.05, seed: 13 });
      const sorted = pcts.slice().sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const mean = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
      // max drawdown on the net equity curve, ordered by exit time
      let equity = 0;
      let peak = 0;
      let maxDD = 0;
      for (const t of trades.slice().sort((a, b) => a.exitTs - b.exitTs)) {
        equity += t.pnlSol;
        peak = Math.max(peak, equity);
        maxDD = Math.max(maxDD, peak - equity);
      }
      // hold-out: the last 30% of exits, so the estimate is about future trades
      const byTime = trades.slice().sort((a, b) => a.exitTs - b.exitTs);
      const cut = Math.floor(byTime.length * (1 - HOLDOUT_SHARE));
      const test = byTime.slice(cut);
      const ratePerHour = windowHours > 0 ? test.length / windowHours : 0;
      rows.push({
        variant,
        latencyMs,
        slippageBps,
        n: trades.length,
        meanPct: mean,
        medianPct: median,
        tpShare: trades.length ? trades.filter((t) => t.reason === "take-profit").length / trades.length : 0,
        bigLossShare: trades.length ? trades.filter((t) => t.pnlPct <= -50).length / trades.length : 0,
        maxDrawdownSol: maxDD,
        ciLo: ci.lo,
        ciHi: ci.hi,
        blockLo: ciBlock.lo,
        blockHi: ciBlock.hi,
        blockLo99: ciBlock99.lo,
        blockHi99: ciBlock99.hi,
        blocks: ciBlock.units,
        creatorLo: ciCreator.lo,
        creatorHi: ciCreator.hi,
        creators: ciCreator.units,
        nHoldout: test.length,
        holdoutPerHour: ratePerHour,
        hoursTo300: ratePerHour > 0 ? TARGET_HOLDOUT / ratePerHour : null,
        meanHoldout: test.length ? test.reduce((a, b) => a + b.pnlPct, 0) / test.length : 0,
      });
    }
  }
}

const pf = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
console.log("\n(1) variants x latency x slippage (after costs, % of 0.02 SOL)");
console.log("  var  lat   slip     n    mean%  median%    tp%  <-50%    maxDD       CI(plain)        CI(10-min blocks)      CI(creator)      B/C");
for (const r of rows) {
  console.log(
    `  ${r.variant.padEnd(3)} ${String(r.latencyMs).padStart(4)} ${String(r.slippageBps).padStart(5)} ${String(r.n).padStart(6)} ` +
      `${pf(r.meanPct).padStart(8)} ${pf(r.medianPct).padStart(8)} ${pf(r.tpShare * 100, 0).padStart(6)} ${pf(r.bigLossShare * 100, 0).padStart(6)} ${pf(r.maxDrawdownSol, 4).padStart(7)} ` +
      `[${pf(r.ciLo).padStart(6)}..${pf(r.ciHi).padStart(5)}] [${pf(r.blockLo).padStart(7)}..${pf(r.blockHi).padStart(6)}] [${pf(r.creatorLo).padStart(7)}..${pf(r.creatorHi).padStart(6)}] ${r.blocks}/${r.creators}`,
  );
}

// ---- freeze verdict ---------------------------------------------------------
if (frozen) {
  console.log("\n(1b) frozen evaluation (only decisions after the freeze, 600 ms / 100 bps)");
  const needHours = frozen.verdictRule?.minHours ?? 72;
  const needTrades = frozen.verdictRule?.minTrades ?? 300;
  const evalMints = mints.filter((m) => {
    const ts = picks[frozen.choice](m);
    return ts && ts > frozen.frozenAt;
  });
  const coveredHours = new Set(evalMints.map((m) => new Date(picks[frozen.choice](m)).getUTCHours()));
  const spanHours = evalMints.length ? (Math.max(...evalMints.map((m) => picks[frozen.choice](m))) - frozen.frozenAt) / 3600_000 : 0;
  console.log(`  decisions after the freeze: ${evalMints.length}, hours since the freeze: ${spanHours.toFixed(2)}, UTC hours covered: ${coveredHours.size}/24`);
  console.log("  variant   n    mean%   median%   99% CI (10-min blocks)        plain 95% CI          creator 95% CI");
  let passed = false;
  for (const variant of [frozen.choice, ...(frozen.controls || [])]) {
    const trades = [];
    for (const m of mints) {
      const decisionTs = picks[variant](m);
      if (!decisionTs || decisionTs <= frozen.frozenAt) continue;
      const t = runTrade({ timeline: m.timeline, decisionTs, latencyMs: FREEZE_LATENCY, slippageBps: FREEZE_SLIPPAGE, timeStop: variant === "B2" });
      if (t) trades.push({ ...t, mint: m.mint, mayhem: m.mayhem, creator: m.creator || null });
    }
    const pcts = trades.map((t) => t.pnlPct);
    const plain = bootstrapCI(pcts, { resamples: 2000, seed: 42 });
    const blk99 = clusterBootstrapCI(trades, blockKey, { resamples: 3000, alpha: 0.01, seed: 12 });
    const cre = clusterBootstrapCI(trades, creatorKey, { resamples: 2000, alpha: 0.05, seed: 13 });
    const sorted = pcts.slice().sort((a, b) => a - b);
    const mean = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : 0;
    console.log(
      `  ${variant.padEnd(8)} ${String(trades.length).padStart(4)} ${pf(mean).padStart(7)} ${pf(sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0).padStart(8)}   ` +
        `[${pf(blk99.lo).padStart(7)}..${pf(blk99.hi).padStart(6)}] (B=${blk99.units})  [${pf(plain.lo).padStart(6)}..${pf(plain.hi).padStart(5)}]  [${pf(cre.lo).padStart(6)}..${pf(cre.hi).padStart(5)}] (C=${cre.units})`,
    );
    if (variant === frozen.choice) {
      const okTrades = trades.length >= needTrades;
      const okHours = spanHours >= needHours && coveredHours.size === 24;
      const okCI = blk99.lo > 0;
      console.log(`    gate: trades ${trades.length}/${needTrades} ${okTrades ? "ok" : "NOT met"}, window ${spanHours.toFixed(1)}/${needHours} h ${okHours ? "ok" : "NOT met"} (UTC hours ${coveredHours.size}/24), 99% block CI lo ${pf(blk99.lo)} ${okCI ? "> 0" : "<= 0"}`);
      passed = okTrades && okHours && okCI;
    }
  }
  console.log(`\n=== VERDICT: ${passed ? "an edge" : "no stable edge"} ===`);
  if (!passed) console.log("  (verdict requires >=300 trades after the freeze, >=72 h covering all UTC hours, and a 99% block-bootstrap CI lower bound above zero)");
}


const HORIZONS = [30, 60, 120];
console.log("\n(2) price after the A0 gate fires (ratio to the price at the gate moment)");
console.log("  class      horizon   tokens   mean    median   >1x    >2x      95% CI of the mean");
const step2 = {};
for (const klass of ["plain", "mayhem"]) {
  const set = mints.filter((m) => m.gateTs !== null && (klass === "mayhem") === m.mayhem);
  for (const h of HORIZONS) {
    const vals = [];
    for (const m of set) {
      const p0 = priceAt(m.timeline, m.gateTs);
      const p1 = priceAt(m.timeline, m.gateTs + h * 1000);
      if (p0 && p1) vals.push(p1 / p0);
    }
    const ci = bootstrapCI(vals, { resamples: 2000, seed: 7 });
    const sorted = vals.slice().sort((a, b) => a - b);
    const out = {
      tokens: set.length,
      n: vals.length,
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
      median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
      shareAbove1: vals.length ? vals.filter((v) => v > 1).length / vals.length : 0,
      shareAbove2: vals.length ? vals.filter((v) => v > 2).length / vals.length : 0,
      ciLo: ci.lo,
      ciHi: ci.hi,
    };
    step2[`${klass}_${h}s`] = out;
    console.log(
      `  ${klass.padEnd(8)} +${String(h).padStart(3)}s ${String(out.tokens).padStart(8)} ${pf(out.mean, 3).padStart(7)} ${pf(out.median, 3).padStart(9)} ` +
        `${pf(out.shareAbove1 * 100, 0).padStart(5)}% ${pf(out.shareAbove2 * 100, 0).padStart(5)}%   [${pf(out.ciLo, 3)}..${pf(out.ciHi, 3)}]`,
    );
  }
}
console.log(`\n  window: ${windowHours.toFixed(2)} h of capture (${new Date(windowFrom).toISOString()} .. ${new Date(windowTo).toISOString()})`);
console.log(`  mints: ${mints.length}, passed A0 gate: ${mints.filter((m) => m.gateTs !== null).length}, passed B1 gate: ${mints.filter((m) => m.gateStrictTs !== null).length}`);

const out = path.join(ROOT, "data", "research", "lab-raw.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      raw: { path: RAW_TARGET, trades: tradeEvents, mints: mints.length, windowFrom, windowTo, windowHours },
      mayhem: { programId: MAYHEM_PROGRAM_ID, accountFlagResolved: flagChecked, agreements: flagAgree, mintsMayhem: mints.filter((m) => m.mayhem).length },
      grid: rows,
      step2,
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${out}`);

console.log(`  ${tradeEvents} trades, ${perMint.size} mints, window ${fmtMsk(new Date(windowFrom))} .. ${fmtMsk(new Date(windowTo))} (${windowHours.toFixed(2)} h)`);
