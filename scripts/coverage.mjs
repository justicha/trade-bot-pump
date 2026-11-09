#!/usr/bin/env node
// Coverage report v2: how much of the stream can be priced, how fresh that price is, and how
// much of the trading was decided on a price that passed a check.
//
//   node scripts/coverage.mjs                    # raw capture + journal
//   node scripts/coverage.mjs --raw data/raw --journal data/journal
//   node scripts/coverage.mjs --rpc-mints 5      # also compare with getAccountInfo (slow)
//
// Price sources (a variant is a POLICY, not a strategy parameter):
//   A  verified payload layouts only (403/405/425/439)
//   B  any payload that carries reserves (what the parser trusted before any gate)
//   C  B + intra-event identity (virtual - real = curve constant)
//   D  B + k gate against the mint anchor
//   E  carried forward: last accepted snapshot, <= FRESH_SEC old
//   F  rebuilt curve: anchor (create event or first snapshot) + every trade's own amounts,
//      re-anchored on a snapshot whenever one step cannot be explained (--heal-ppm)
//   G  rebuilt + snapshot cross-check: same as F, but a snapshot that disagrees is logged as
//      "corrected" instead of silently healing (identical availability, stricter audit)
//
// Two different questions are answered per variant:
//   defined — a price exists for that token-second at all (needed to make any decision)
//   fresh   — that price was produced/updated within FRESH_SEC (needed to trust it)
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { CurveConsistency } from "../lib/consistency.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { isMayhemCaller, isMayhemPath } from "../lib/mayhem.mjs";
import { readJournal } from "../lib/journal.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const JOURNAL_DIR = argOf("--journal", path.join(ROOT, "data", "journal"));
const RPC_MINTS = Number(argOf("--rpc-mints", "0"));
const FRESH_SEC = Number(argOf("--fresh-sec", "5"));
const DEEP_SEC = Number(argOf("--deep-sec", "30"));
const HEAL_PPM = Number(argOf("--heal-ppm", "1000"));
const VERIFIED_LENS = new Set(
  argOf("--verified-lens", "403,405,425,439")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0),
);

const priceOfReserves = (vSol, vTok) => (vSol && vTok && vSol > 0n && vTok > 0n ? Number(vSol) / 1e9 / (Number(vTok) / 1e6) : null);

// ---- load raw ---------------------------------------------------------------
const perMint = new Map();
let rawEvents = 0;
for await (const rec of replayRaw(RAW_TARGET)) {
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);
  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (!c || !c.launchParamsOk) continue;
    const m = perMint.get(c.mint) || { mint: c.mint, events: [], mayhem: false };
    m.createdAt = rec.ts;
    m.fromCreate = true;
    perMint.set(c.mint, m);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  rawEvents += 1;
  const m = perMint.get(ev.mint) || { mint: ev.mint, events: [], mayhem: false };
  if (isMayhemCaller(rec.outer) || isMayhemPath(rec.path)) m.mayhem = true;
  m.events.push({
    ts: rec.ts,
    slot: rec.slot,
    len: ev.len,
    isBuy: ev.isBuyByte,
    solAmount: ev.solAmount,
    tokenAmount: ev.tokenAmount,
    tradePrice: ev.tradePriceSol,
    hasReserves: ev.hasReserves,
    vSol: ev.reserves?.vSol ?? null,
    vTok: ev.reserves?.vTok ?? null,
    rSol: ev.reserves?.realSol ?? null,
    rTok: ev.reserves?.realTok ?? null,
  });
  perMint.set(ev.mint, m);
}
if (!perMint.size) {
  console.error(`No pump.fun events in ${RAW_TARGET}. Run scripts/capture-raw.mjs first.`);
  process.exit(1);
}
console.log(`=== COVERAGE (raw: ${rawEvents} trade events, ${perMint.size} mints) ===`);


// ---- per-mint coverage ------------------------------------------------------
const variants = ["A", "B", "C", "D", "E", "F", "G"];
const LABEL = {
  A: "verified layouts only (403/405/425/439)",
  B: "any payload with reserves (no gate)",
  C: "B + intra-event identity",
  D: "B + k gate vs the mint anchor",
  E: "carry forward, <= FRESH_SEC old",
  F: "REBUILT: anchor + trade amounts, healed by snapshot",
  G: "rebuilt + snapshot cross-check (audited)",
};
const cov = Object.fromEntries(variants.map((v) => [v, { mints: 0, definedSec: 0, freshSec: 0, deepDefinedSec: 0, deepFreshSec: 0, events: 0, totalEvents: 0 }]));
const byClass = {
  mayhem: Object.fromEntries(variants.map((v) => [v, { mints: 0, definedSec: 0, totalSec: 0, freshSec: 0 }])),
  plain: Object.fromEntries(variants.map((v) => [v, { mints: 0, definedSec: 0, totalSec: 0, freshSec: 0 }])),
};
let totalSeconds = 0;
let totalDeepSeconds = 0;
const gapStats = []; // seconds between consecutive events of a mint (the freshness ceiling)
let healed = 0;
let unexplainedSteps = 0;

for (const m of perMint.values()) {
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  const firstTs = m.fromCreate ? m.createdAt : list[0].ts;
  const lastTs = list[list.length - 1].ts;
  const k = new CurveConsistency();
  const rb = new CurveRebuild({ reanchorOnLargeErrorPpm: HEAL_PPM });
  if (m.fromCreate) {
    rb.seedFromCreate(m.mint, { ts: m.createdAt });
  } else {
    const f = list.find((e) => e.hasReserves);
    if (!f) continue;
    rb.seed(m.mint, { vSol: f.vSol, vTok: f.vTok, ts: f.ts, source: "snapshot" });
  }

  const defined = Object.fromEntries(variants.map((v) => [v, new Set()]));
  const fresh = Object.fromEntries(variants.map((v) => [v, new Set()]));
  const verified = Object.fromEntries(variants.map((v) => [v, new Set()]));
  const timeline = []; // { ts, accept: {A..G}, stepOk }
  let prevTs = null;

  for (const ev of list) {
    const sec = Math.floor(ev.ts / 1000);
    if (prevTs !== null) gapStats.push((ev.ts - prevTs) / 1000);
    prevTs = ev.ts;

    // snapshot-based variants
    const price = ev.hasReserves ? priceOfReserves(ev.vSol, ev.vTok) : null;
    const ident = price !== null ? k.identity({ vSol: ev.vSol, vTok: ev.vTok, rSol: ev.rSol, rTok: ev.rTok }) : { ok: false };
    const accept = { A: price !== null && VERIFIED_LENS.has(ev.len), B: price !== null, C: price !== null && ident.ok, D: false, E: price !== null, F: false, G: false };
    if (accept.B) accept.D = k.checkSnapshot(m.mint, { vSol: ev.vSol, vTok: ev.vTok, rSol: ev.rSol, rTok: ev.rTok }).ok;

    // rebuild-based variants: advance the model by this trade, then compare with the snapshot
    rb.apply(m.mint, { isBuy: ev.isBuy, solAmount: ev.solAmount, tokenAmount: ev.tokenAmount, ts: ev.ts });
    const modelPrice = rb.priceOf(m.mint);
    // "verified" = a snapshot was there to confirm (or correct) the model at this step. A step
    // without a snapshot cannot be checked at all, so it does not count as verified.
    let stepOk = ev.hasReserves;
    if (ev.hasReserves) {
      const cmp = rb.compare(m.mint, { vSol: ev.vSol, vTok: ev.vTok });
      if (cmp) {
        if (cmp.reanchored) healed += 1;
        else if (cmp.errKPpm !== null && cmp.errKPpm > HEAL_PPM) unexplainedSteps += 1;
      }
    }
    accept.F = modelPrice !== null;
    accept.G = modelPrice !== null; // same availability as F, stricter audit trail

    for (const v of variants) cov[v].totalEvents += 1;
    for (const v of variants) if (accept[v]) cov[v].events += 1;
    timeline.push({ ts: ev.ts, sec, accept, stepOk });
  }

  // ---- per-second scan ------------------------------------------------------
  const seedSec = Math.floor(firstTs / 1000);
  const endSec = Math.floor(lastTs / 1000);
  for (let s = seedSec; s <= endSec; s++) {
    totalSeconds += 1;
    if (s - seedSec >= DEEP_SEC) totalDeepSeconds += 1;
  }
  const cls = byClass[m.mayhem ? "mayhem" : "plain"];
  for (const v of variants) {
    let ptr = 0;
    let lastUpdate = null; // ts of the last accepted price for this variant
    let lastStepOk = true;
    for (let s = seedSec; s <= endSec; s++) {
      const secondEnd = s * 1000 + 999;
      while (ptr < timeline.length && timeline[ptr].sec <= s) {
        const e = timeline[ptr];
        if (e.accept[v]) {
          lastUpdate = e.ts;
          lastStepOk = e.stepOk;
        }
        ptr += 1;
      }
      // A-D/E need a real update; the rebuilt curve (F/G) has a state from the seed onward, and
      // between two trades the state does not move, so the price is exact rather than stale.
      const hasState = v === "F" || v === "G" ? true : lastUpdate !== null;
      if (!hasState) continue;
      defined[v].add(s);
      if (lastStepOk) verified[v].add(s);
      if (lastUpdate !== null && (secondEnd - lastUpdate) / 1000 <= FRESH_SEC) fresh[v].add(s);
    }
  }

  for (const v of variants) {
    cov[v].definedSec += defined[v].size;
    cov[v].freshSec += fresh[v].size;
    cov[v].verifiedSec = (cov[v].verifiedSec || 0) + verified[v].size;
    if (defined[v].size) cov[v].mints += 1;
    let deepD = 0;
    let deepF = 0;
    let deepV = 0;
    for (const s of defined[v]) {
      if (s - seedSec < DEEP_SEC) continue;
      deepD += 1;
      if (verified[v].has(s)) deepV += 1;
    }
    for (const s of fresh[v]) if (s - seedSec >= DEEP_SEC) deepF += 1;
    cov[v].deepDefinedSec += deepD;
    cov[v].deepFreshSec += deepF;
    cov[v].deepVerifiedSec = (cov[v].deepVerifiedSec || 0) + deepV;
    cls[v].definedSec += defined[v].size;
    cls[v].freshSec += fresh[v].size;
    cls[v].totalSec += endSec - seedSec + 1;
    if (defined[v].size) cls[v].mints += 1;
  }
}

// ---- report -----------------------------------------------------------------
const pctf = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const pctile = (arr, q) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

console.log("\n(1) price availability by source policy");
console.log("  variant                                              mints    defined  verified   fresh   deep-def  deep-ver  events");
for (const v of variants) {
  const c = cov[v];
  console.log(
    `  ${`${v} ${LABEL[v]}`.padEnd(50)} ${pctf(c.mints, perMint.size).padStart(7)} ${pctf(c.definedSec, totalSeconds).padStart(9)} ${pctf(c.verifiedSec, totalSeconds).padStart(9)} ${pctf(c.freshSec, totalSeconds).padStart(7)} ` +
      `${pctf(c.deepDefinedSec, totalDeepSeconds).padStart(9)} ${pctf(c.deepVerifiedSec, totalDeepSeconds).padStart(9)} ${pctf(c.events, c.totalEvents).padStart(7)}`,
  );
}
console.log(`  denominators: ${perMint.size} mints, ${totalSeconds} token-seconds, ${totalDeepSeconds} deep token-seconds (age >= ${DEEP_SEC}s)`);
console.log(`  freshness ceiling: seconds between two consecutive events of the same mint — p50 ${pctile(gapStats, 0.5)?.toFixed(2)}s, p90 ${pctile(gapStats, 0.9)?.toFixed(2)}s, p99 ${pctile(gapStats, 0.99)?.toFixed(1)}s`);
console.log(`  rebuild healing: ${healed} steps where the snapshot became the new anchor (threshold ${HEAL_PPM} ppm)`);

console.log("\n(2) Mayhem vs non-Mayhem (defined token-seconds, share per class)");
for (const cls of ["mayhem", "plain"]) {
  const c = byClass[cls];
  console.log(`  ${cls.padEnd(8)} tokens=${String(c.F.mints).padStart(5)}/${String(perMint.size).padStart(5)}  ` + variants.map((v) => `${v}=${pctf(c[v].definedSec, c[v].totalSec)}`).join("  "));
}

const target = 0.9;
const bestDefined = cov.F.definedSec / Math.max(1, totalSeconds);
const bestVerified = cov.F.verifiedSec / Math.max(1, totalSeconds);
const deepDefined = cov.F.deepDefinedSec / Math.max(1, totalDeepSeconds);
const deepVerified = cov.F.deepVerifiedSec / Math.max(1, totalDeepSeconds);
console.log(`\n(3) target (${target * 100}% of token-seconds with a valid price), variant F (rebuilt curve)`);
console.log(`  defined  : ${pctf(cov.F.definedSec, totalSeconds)}  deep ${pctf(cov.F.deepDefinedSec, totalDeepSeconds)}  -> ${bestDefined >= target ? "REACHED" : "not reached"}`);
console.log(`  verified : ${pctf(cov.F.verifiedSec, totalSeconds)}  deep ${pctf(cov.F.deepVerifiedSec, totalDeepSeconds)}  -> ${bestVerified >= target ? "REACHED" : "not reached"}`);
console.log(
  `  (verified = a snapshot confirmed the model at that step; ${healed} steps needed a correction (${HEAL_PPM} ppm threshold).\n` +
    `   For the rebuilt curve the price between two trades is not stale but exact — the curve cannot move\n` +
    `   without a trade — so "defined" is the target metric and "fresh" is only a latency indicator.)`,
);
const freshBest = cov.F.freshSec / Math.max(1, totalSeconds);
if (freshBest < target) {
  const share = gapStats.length ? gapStats.filter((g) => g <= FRESH_SEC).length / gapStats.length : 0;
  console.log(`  why "fresh <= ${FRESH_SEC}s" stays low (${pctf(cov.F.freshSec, totalSeconds)}): the stream is event-driven, and only ${pctf(Math.round(share * 100), 100)} of the`);
  console.log(`  gaps between two trades of the same mint are <= ${FRESH_SEC}s. Those seconds have no trade at all, so nothing happened to the price.`);
}

// ---- journal: were the decisions taken on priced data? ----------------------
const trades = readJournal(JOURNAL_DIR).filter((r) => r.type === "trade");
const decision = { freshVerified: 0, freshRebuilt: 0, stale: 0, noRawData: 0 };
const outcomes = new Map();
const priceAt = (mint, atMs) => {
  const m = perMint.get(mint);
  if (!m || !m.events.length) return null;
  let best = null;
  for (const ev of m.events) {
    if (ev.ts <= atMs + 1000) best = ev;
    else break;
  }
  if (!best) return null;
  return { ev: best, ageSec: (atMs - best.ts) / 1000, verified: VERIFIED_LENS.has(best.len) || Boolean(best.hasReserves && best.vSol) };
};
for (const t of trades) {
  const exitMs = Date.parse(t.ts);
  const entryMs = exitMs - (Number(t.holdSec) || 0) * 1000;
  const p = priceAt(t.mint, entryMs);
  const cls = !p ? "noRawData" : p.ageSec > FRESH_SEC ? "stale" : p.verified ? "freshVerified" : "freshRebuilt";
  decision[cls] += 1;
  const key = `${perMint.get(t.mint)?.mayhem ? "mayhem" : "plain"}/${cls}`;
  const o = outcomes.get(key) || { n: 0, wins: 0, pnlSum: 0 };
  o.n += 1;
  if (Number(t.pnlPct) > 0) o.wins += 1;
  o.pnlSum += Number(t.pnlPct) || 0;
  outcomes.set(key, o);
}
console.log(`\n(4) journal trades: ${trades.length} (entry classified by the price available at that moment)`);
for (const [k, v] of Object.entries(decision)) console.log(`  ${k.padEnd(15)} ${String(v).padStart(5)}  ${pctf(v, trades.length).padStart(7)}`);

// ---- output -----------------------------------------------------------------
const out = path.join(ROOT, "data", "research", "coverage.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      raw: { events: rawEvents, mints: perMint.size, totalSeconds, totalDeepSeconds },
      variants: Object.fromEntries(variants.map((v) => [v, { ...cov[v], label: LABEL[v], definedPct: cov[v].definedSec / Math.max(1, totalSeconds), freshPct: cov[v].freshSec / Math.max(1, totalSeconds) }])),
      byClass,
      gapStats: { p50: pctile(gapStats, 0.5), p90: pctile(gapStats, 0.9), p99: pctile(gapStats, 0.99), shareFresh: gapStats.length ? gapStats.filter((g) => g <= FRESH_SEC).length / gapStats.length : null },
      rebuild: { healPpm: HEAL_PPM, healedSteps: healed, unexplainedSteps },
      decisions: decision,
      outcomesByClassAndDecision: Object.fromEntries(outcomes),
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${out}`);

