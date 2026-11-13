#!/usr/bin/env node
// Journal analyzer — task A-fix.
//
//   node scripts/analyze-journal.mjs                 # all data/journal/*.jsonl
//   node scripts/analyze-journal.mjs <file.jsonl>    # one file
//   OUT_DIR=data/research node scripts/analyze-journal.mjs
//
// NET % = pnlSol / buySol (pnlSol already after costsSol), NOT the gross pnlPct.
// n < 30 -> bootstrap CI is not printed ("n too small"). No external dependencies.
import fs from "node:fs";
import path from "node:path";
import { bootstrapCI } from "../lib/research.mjs";
import { roundTripCosts } from "../lib/fees.mjs";
import { ROOT } from "../lib/config.mjs";
import { excludeDegraded, dedupeTrades } from "../lib/journal.mjs";

const target = process.argv[2] || path.join(ROOT, "data", "journal");
const outDir = process.env.OUT_DIR || path.join(ROOT, "data", "research");
const MIN_N_FOR_CI = 30;

// ---- read every file, count per file, dedupe ---------------------------------
const files = [];
try {
  const st = fs.statSync(target);
  if (st.isFile()) files.push(target);
  else for (const f of fs.readdirSync(target).sort()) if (f.endsWith(".jsonl")) files.push(path.join(target, f));
} catch {
  console.error(`cannot read ${target}`);
  process.exit(1);
}

const fileStats = [];
const allRecords = [];
for (const f of files) {
  let lines = 0;
  let tradesInFile = 0;
  let broken = 0;
  try {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      lines += 1;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        broken += 1;
        continue;
      }
      if (j.type === "trade") tradesInFile += 1;
      allRecords.push(j);
    }
  } catch {
    /* unreadable file: reported below */
  }
  fileStats.push({ file: path.basename(f), lines, trades: tradesInFile, broken });
}

// Dedupe (lib/journal.mjs): mint+sessionId (primary) and mint+buyAt 3s bucket (cross-process
// duplicates from two simultaneously running bots, plus legacy rows without a sessionId).
const { records, removedByGit } = dedupeTrades(allRecords);
const dupTrades = [...removedByGit.values()].reduce((a, b) => a + b, 0);

const _deg = excludeDegraded(records);
const trades = _deg.trades;
const postByMint = new Map();
for (const p of records.filter((r) => r.type === "post_exit")) {
  if (!postByMint.has(p.mint) || (p.ts || "") > (postByMint.get(p.mint).ts || "")) postByMint.set(p.mint, p);
}
const rejects = records.filter((r) => r.type === "reject");

// launch price in RAW units (30 SOL virtual / 1.073e9 tokens) — an ASSUMPTION, checked in slices
const LAUNCH_RAW = 30e9 / 1.073e15;

function versionOf(t) {
  if (t.buyHour !== undefined && t.buyAt !== undefined) return "v3 (+buyHour/buyAt)";
  if (typeof t.costsScheme === "string" && t.costsScheme.startsWith("v2")) return "v2 (costsScheme)";
  return "legacy (no costsSol/isMayhem)";
}

for (const t of trades) {
  t.netPct = Number(t.buySol) > 0 ? (Number(t.pnlSol) / Number(t.buySol)) * 100 : null;
  const pe = postByMint.get(t.mint);
  t.bestRatioAfterExit = pe ? Number(pe.bestRatioAfterExit) : null;
  t.postTruncated = pe ? Boolean(pe.truncated) : null;
  t.postMeasured = Boolean(pe);
  t.exitRatio = Number(t.ratio);
  t.peakRatio = Number(t.peakRatio);
  t.holdersAtEntry = t.holdersAtEntry === undefined ? null : Number(t.holdersAtEntry);
  t.devBuySol = t.devBuySol === undefined ? null : Number(t.devBuySol);
  t.isMayhem = t.isMayhem === undefined ? null : Boolean(t.isMayhem);
  t.buyHour = t.buyHour === undefined ? null : Number(t.buyHour);
  t.entryPremium = Number(t.entrySol) > 0 ? Number(t.entrySol) / LAUNCH_RAW - 1 : null;
  t.version = versionOf(t);
  const r = String(t.exitReason || "");
  t.exitClass = r.startsWith("take-profit") ? "take-profit" : r.startsWith("stop-loss") ? "stop-loss" : r.startsWith("timeout") ? "timeout" : "other";
  // Recalculated net% with the SAME costs scheme (v2) for every row, so legacy rows (no costsSol)
  // become comparable with v2/v3. Identical formula for all: gross - round-trip costs, over buySol.
  const buySol = Number(t.buySol);
  const ratio = Number(t.ratio);
  if (buySol > 0 && Number.isFinite(ratio)) {
    const c = roundTripCosts({ buySol, ratio });
    t.netPctRecalc = ((buySol * (ratio - 1) - c.costSol) / buySol) * 100;
    t.costsRecalc = c.costSol;
  } else {
    t.netPctRecalc = null;
    t.costsRecalc = null;
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[Math.floor(s.length / 2) - 1] + s[Math.floor(s.length / 2)]) / 2;
};

function statsOf(name, list) {
  const values = list.map((t) => t.netPct).filter((x) => Number.isFinite(x));
  const wins = list.filter((t) => Number(t.pnlSol) > 0);
  const losses = list.filter((t) => Number(t.pnlSol) <= 0);
  const grossWin = wins.reduce((s, t) => s + Number(t.pnlSol), 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(Number(t.pnlSol)), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of list.slice().sort((a, b) => (a.sellAt || a.ts || "").localeCompare(b.sellAt || b.ts || ""))) {
    eq += t.netPct ?? 0;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const enough = values.length >= MIN_N_FOR_CI;
  const ci = enough ? bootstrapCI(values, { resamples: 2000, seed: 42 }) : null;
  const peaks = list.map((t) => t.peakRatio).filter((x) => Number.isFinite(x));
  const bests = list.map((t) => t.bestRatioAfterExit).filter((x) => Number.isFinite(x));
  return {
    name, n: list.length, enough,
    winRate: list.length ? wins.length / list.length : null,
    meanNetPct: mean(values), medianNetPct: median(values), profitFactor,
    ciLo: ci ? ci.lo : null, ciHi: ci ? ci.hi : null,
    maxDDNetPct: maxDD, avgPeakRatio: mean(peaks), avgBestRatioAfterExit: mean(bests), bestMeasured: bests.length,
  };
}

const fmt = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const HEADER = ["slice", "n", "win%", "meanNet%", "medianNet%", "PF", "CI95", "maxDD%", "avgPeak", "avgBest"];
const row = (st) => [
  st.name, st.n, fmt(st.winRate * 100), fmt(st.meanNetPct), fmt(st.medianNetPct), fmt(st.profitFactor, 2),
  st.enough ? `[${fmt(st.ciLo)} .. ${fmt(st.ciHi)}]` : "n too small",
  fmt(st.maxDDNetPct), fmt(st.avgPeakRatio, 2), fmt(st.avgBestRatioAfterExit, 2),
];
const csvEscape = (x) => {
  const s = String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const lines = [];
lines.push("# JOURNAL ANALYSIS (NET % = pnlSol / buySol)", "");
lines.push(`_generated ${new Date().toISOString()}_`, "");
lines.push("## Input files", "", "| file | lines | trade lines | broken |", "|---|---|---|---|");
for (const f of fileStats) lines.push(`| ${f.file} | ${f.lines} | ${f.trades} | ${f.broken} |`);
lines.push("");
const dupSummary = [...removedByGit.entries()].map(([g, n]) => `${g}: ${n}`).join(", ") || "none";
lines.push(`trades after dedupe: **${trades.length}** (removed ${dupTrades} duplicate(s) by gitSha: ${dupSummary}), post_exit ${postByMint.size}, rejects ${rejects.length}`, "");
lines.push(`> n < ${MIN_N_FOR_CI} → no bootstrap CI ("n too small").`, "");
lines.push(`> launch-price ASSUMPTION for the premium slice: ${LAUNCH_RAW.toExponential(4)} SOL/raw (30 SOL virtual / 1.073e9 tokens).`, "");

function table(title, sliceStats) {
  if (title) lines.push(`## ${title}`, "");
  lines.push("| " + HEADER.join(" | ") + " |", "|" + HEADER.map(() => "---").join("|") + "|");
  for (const st of sliceStats) lines.push("| " + row(st).join(" | ") + " |");
  lines.push("");
}

function bucket(list, keyFn) {
  const m = new Map();
  for (const t of list) {
    const k = keyFn(t);
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.entries()].map(([k, v]) => statsOf(k, v));
}


// ---- slices -----------------------------------------------------------------
// "as recorded" vs "recalculated with costs v2": legacy rows had no costsSol, so their pnlSol is
// gross. Both numbers are shown; the recalculated one is the comparable total.
const recalcList = trades.map((t) => ({ ...t, netPct: t.netPctRecalc }));
table("Net %: as recorded vs recalculated with the v2 cost scheme (all rows)", [
  statsOf("as recorded (mixed: legacy has no costs)", trades),
  statsOf("recalculated with costs v2 (comparable)", recalcList),
]);
table("Net % as recorded, by journal version", bucket(trades, (t) => t.version));
table("Net % recalculated, by journal version", bucket(recalcList, (t) => t.version));

table("By journal version (versions must not be mixed silently)", bucket(trades, (t) => t.version));

table("By isMayhem", bucket(trades, (t) => (t.isMayhem === null ? "unknown" : t.isMayhem ? "mayhem" : "standard")));

table("By holdersAtEntry", bucket(trades, (t) => {
  if (t.holdersAtEntry === null) return "n/a";
  const h = t.holdersAtEntry;
  if (h === 4) return "4";
  if (h === 5) return "5";
  if (h >= 6 && h <= 9) return "6-9";
  return "10+";
}));

table("By devBuySol", bucket(trades, (t) => {
  if (t.devBuySol === null) return "n/a";
  const d = t.devBuySol;
  if (d < 1) return "<1";
  if (d < 2) return "1-2";
  if (d < 5) return "2-5";
  return ">5";
}));

table("By entry premium vs launch price (by token type)", bucket(trades, (t) => {
  if (t.entryPremium === null) return "n/a";
  const p = t.entryPremium;
  const type = t.isMayhem === true ? "M" : t.isMayhem === false ? "S" : "?";
  const b = p < 0 ? "<0" : p < 0.2 ? "0-20%" : p < 0.35 ? "20-35%" : ">35%";
  return `${type}·${b}`;
}));

table("By exit reason", bucket(trades, (t) => t.exitClass));

table("By buy hour (Brussels)", bucket(trades, (t) => (t.buyHour === null ? "n/a" : String(t.buyHour).padStart(2, "0"))));

table("By session (Brussels, 6h)", bucket(trades, (t) => {
  if (t.buyHour === null) return "n/a";
  const h = t.buyHour;
  if (h < 6) return "00-06";
  if (h < 12) return "06-12";
  if (h < 18) return "12-18";
  return "18-24";
}));

table("By creator", bucket(trades, (t) => (t.creator ? String(t.creator).slice(0, 8) : null)));

// item 4: the rate-limiter rewrite (012af08) is analyzed separately from the previous epoch
// (336b939). gitSha is stamped on every trade line by the bot; older lines without it are "n/a".
table("By gitSha (012af08 vs 336b939 separated)", bucket(trades, (t) => (t.gitSha ? String(t.gitSha) : "n/a")));

// ---- recovery after the exit (hypothesis 5) ---------------------------------
lines.push("## Recovery after the exit: share with bestRatioAfterExit above a threshold", "");
{
  const groups = [
    ["stop-loss", (t) => t.exitClass === "stop-loss"],
    ["mayhem (all exits)", (t) => t.isMayhem === true],
    ["standard (all exits)", (t) => t.isMayhem === false],
    ["take-profit", (t) => t.exitClass === "take-profit"],
  ];
  lines.push("| group | post-exit window | measured | >1.0x | >1.5x | >2.0x |");
  lines.push("|---|---|---|---|---|---|");
  for (const [name, pred] of groups) {
    for (const [wName, wPred] of [["not truncated", (t) => t.postTruncated === false], ["truncated", (t) => t.postTruncated === true]]) {
      const list = trades.filter((t) => pred(t) && Number.isFinite(t.bestRatioAfterExit) && wPred(t));
      if (!list.length) {
        lines.push(`| ${name} | ${wName} | 0 | n/a | n/a | n/a |`);
        continue;
      }
      const share = (thr) => `${((list.filter((t) => t.bestRatioAfterExit > thr).length / list.length) * 100).toFixed(0)}%`;
      lines.push(`| ${name} | ${wName} | ${list.length} | ${share(1.0)} | ${share(1.5)} | ${share(2.0)} |`);
    }
  }
  lines.push("", "> 1.0x = the price after our exit went back above our ENTRY price. This is what the mean bestRatioAfterExit hides.", "");
}


// ---- hindsight upper bound ---------------------------------------------------
lines.push("## Exit-rule replay — HINDSIGHT UPPER BOUND", "");
{
  const withPeak = trades.filter((t) => Number.isFinite(t.peakRatio) && Number.isFinite(t.buySol));
  const atPeak = withPeak.map((t) => ({ ...t, netPct: ((Number(t.buySol) * (t.peakRatio - 1) - Number(t.costsSol || 0)) / Number(t.buySol)) * 100 }));
  const heldAfter = trades.filter((t) => Number.isFinite(t.bestRatioAfterExit) && t.postTruncated === false);
  const atBest = heldAfter.map((t) => ({ ...t, netPct: ((Number(t.buySol) * (t.bestRatioAfterExit - 1) - Number(t.costsSol || 0)) / Number(t.buySol)) * 100 }));
  table("", [
    statsOf("actual (recorded)", trades),
    statsOf("hindsight upper bound: sell at sampled peak", atPeak),
    statsOf("hindsight upper bound: sell at best after exit (full window)", atBest),
  ]);
  lines.push("> UPPER BOUNDS by construction (sampled peak / perfect post-exit exit, recorded costs reused).", "");
  lines.push(`> They do NOT prove that trailing or a partial take-profit helps — that needs the tick trajectory (task B). rows: all ${trades.length}, with peak ${withPeak.length}, full post-exit window ${heldAfter.length}.`, "");
}

// ---- tick log (task B) -------------------------------------------------------
lines.push("## Tick log", "");
{
  const dir = fs.statSync(target).isFile() ? path.dirname(target) : target;
  let tickFiles = [];
  try {
    tickFiles = fs.readdirSync(dir).filter((f) => f.startsWith("ticks-") && f.endsWith(".jsonl"));
  } catch {
    tickFiles = [];
  }
  if (!tickFiles.length) {
    lines.push("- no tick files yet (written from the task-B version on): tick-gap share n/a", "");
  } else {
    const ticks = [];
    for (const f of tickFiles) {
      for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          ticks.push(JSON.parse(line));
        } catch {
          /* skip a broken line */
        }
      }
    }
    const gaps = ticks.filter((t) => t.gap === true);
    const hold = ticks.filter((t) => t.phase === "hold");
    const post = ticks.filter((t) => t.phase === "post");
    const mints = new Set(ticks.map((t) => t.mint));
    lines.push(`- files ${tickFiles.length}, lines ${ticks.length}, mints ${mints.size} (hold ${hold.length}, post ${post.length})`);
    lines.push(`- **ticks with gap > 2 s: ${gaps.length} / ${ticks.length} = ${ticks.length ? ((gaps.length / ticks.length) * 100).toFixed(1) : "n/a"}%** (sampler missed an interval: RPC timeout or event-loop stall)`);
    if (gaps.length) {
      const gs = gaps.map((t) => Number(t.gapSec) || 0).sort((a, b) => a - b);
      lines.push(`- gap length: median ${gs[Math.floor(gs.length / 2)].toFixed(1)}s, max ${gs[gs.length - 1].toFixed(1)}s`);
    }
    lines.push("");
  }
}

// ---- rejects + skips ---------------------------------------------------------
lines.push("## Rejected entries and skipped tokens", "");
{
  const byReason = new Map();
  for (const r of rejects) {
    const raw = String(r.reason || "unknown");
    const key = raw.replace(/[-\d.]+/g, "N"); // group messages that only differ by the number
    if (!byReason.has(key)) byReason.set(key, { n: 0, samples: [] });
    const e = byReason.get(key);
    e.n += 1;
    if (e.samples.length < 3) e.samples.push(raw);
  }
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) lines.push(`- [reject] ${k.trim()} — ${v.n}×   e.g. ${v.samples.join(" | ")}`);

  // skips: tokens that were never entered (slot / cooldown / holder gate). Logged from task B on.
  const skips = records.filter((r) => r.type === "skip");
  const skipByReason = new Map();
  for (const s of skips) skipByReason.set(String(s.reason || "unknown"), (skipByReason.get(String(s.reason || "unknown")) || 0) + 1);
  if (skips.length === 0) {
    lines.push("- [skip] no skip records in this journal (they are written from this version on)");
  } else {
    for (const [k, v] of [...skipByReason.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- [skip] ${k} — ${v}×`);
  }
  lines.push("", `_rejects and skips are listed so the selection bias (tokens without a slot, failing a filter) stays visible: ${rejects.length} rejects, ${skips.length} skips._`, "");
}

// ---- outputs ----------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, "analysis-report.md");
fs.writeFileSync(reportPath, lines.join("\n") + "\n");

const csvHead = ["mint", "version", "isMayhem", "buyHour", "holdersAtEntry", "devBuySol", "entryPremium", "netPct", "pnlPct", "exitClass", "exitReason", "holdSec", "peakRatio", "ratio", "bestRatioAfterExit", "postTruncated"];
const csvRows = [csvHead];
for (const t of trades) {
  csvRows.push([
    t.mint, t.version, t.isMayhem, t.buyHour, t.holdersAtEntry, t.devBuySol,
    fmt(t.entryPremium, 4), fmt(t.netPct, 2), fmt(t.pnlPct, 2), t.exitClass, t.exitReason,
    t.holdSec, fmt(t.peakRatio, 3), fmt(t.exitRatio, 3), fmt(t.bestRatioAfterExit, 3), t.postTruncated,
  ]);
}
const csvPath = path.join(outDir, "analysis-trades.csv");
fs.writeFileSync(csvPath, csvRows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n");

console.log(lines.join("\n"));
console.log(`\nwritten: ${reportPath}`);
console.log(`written: ${csvPath} (${trades.length} rows)`);

