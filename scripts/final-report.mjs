#!/usr/bin/env node
// Final validation report (step 6). Filters to ONE gitSha, splits by time into first (tuning) and
// second (validation) halves, evaluates V0-V7 in optimistic AND pessimistic cost models, and applies
// the acceptance criterion (95% CI lo > 0 in pessimistic on the validation half, n >= MIN_N).
//
//   node scripts/final-report.mjs                 # newest gitSha in the journal
//   node scripts/final-report.mjs --sha <gitSha>
//   MIN_N=200 PESS_DELAY_MS=500 node scripts/final-report.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal, dedupeTrades } from "../lib/journal.mjs";
import { evaluateShadow, shadowLines, LAUNCH_RAW } from "../lib/shadow.mjs";
import { pessimisticRoundTrip } from "../lib/pessimistic.mjs";
import { bootstrapCI } from "../lib/research.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.JOURNAL_DIR || path.join(ROOT, "data", "journal");
const args = process.argv.slice(2);
const shaIdx = args.indexOf("--sha");
const shaArg = shaIdx >= 0 ? args[shaIdx + 1] : null;
const MIN_N = Number(process.env.MIN_N || 200);
const PESS_DELAY = Number(process.env.PESS_DELAY_MS || 500);
const CHECKED = 8;

// ---- load journal + hold ticks ----
const { records } = dedupeTrades(readJournal(dir));
const trades = records.filter((r) => r.type === "trade");
const ticks = new Map();
try {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith("ticks-") || !f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      if (j.phase !== "hold") continue;
      if (!ticks.has(j.mint)) ticks.set(j.mint, []);
      ticks.get(j.mint).push({ t: Number(j.t), ratio: Number(j.ratio), stale: j.stale === true });
    }
  }
} catch { /* no ticks */ }
for (const [, s] of ticks) s.sort((a, b) => a.t - b.t);

// ---- target gitSha (arg, else the one with the newest trade) ----
const latestBySha = new Map();
for (const t of trades) {
  const g = t.gitSha || "n/a";
  const at = String(t.sellAt || t.ts || "");
  if (!latestBySha.has(g) || at > latestBySha.get(g)) latestBySha.set(g, at);
}
const sha = shaArg || [...latestBySha.entries()].sort((a, b) => String(b[1]).localeCompare(String(a[1])))[0]?.[0] || null;
const mine = trades.filter((t) => (t.gitSha || "n/a") === sha).sort((a, b) => String(a.sellAt || "").localeCompare(String(b.sellAt || "")));
if (!mine.length) {
  console.error(`no trades for gitSha ${sha}`);
  process.exit(1);
}

// ---- time split ----
const cut = Math.floor(mine.length / 2);
const H1 = mine.slice(0, cut);
const H2 = mine.slice(cut);

// ---- pessimistic transform (fixed delay for reproducibility) ----
const toPess = (list) =>
  list.map((t) => {
    const buySol = Number(t.buySol);
    const ratio = Number(t.ratio);
    if (!(buySol > 0) || !Number.isFinite(ratio)) return t;
    return { ...t, pnlSol: pessimisticRoundTrip({ buySol, ratio, delayMs: PESS_DELAY }).netPnl };
  });
const pessCost = ({ buySol, ratio, legs = 2 }) => pessimisticRoundTrip({ buySol, ratio, delayMs: PESS_DELAY, legs });

function evalHalf(list, mode) {
  const input = mode === "pessimistic" ? toPess(list) : list;
  const costFn = mode === "pessimistic" ? pessCost : undefined;
  return evaluateShadow(input, { floorPrice: LAUNCH_RAW, ticks, costFn, minNForCI: 30, minNForVerdict: MIN_N });
}

function printTable(title, res) {
  const { h, rows } = shadowLines(res);
  const w = h.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  console.log(`\n## ${title}`);
  console.log("| " + h.map((c, i) => c.padEnd(w[i])).join(" | ") + " |");
  console.log("|" + h.map((c, i) => "-".repeat(w[i] + 2)).join("|") + "|");
  for (const r of rows) console.log("| " + r.map((c, i) => String(c).padEnd(w[i])).join(" | ") + " |");
}

console.log(`# FINAL REPORT — gitSha ${sha}, ${mine.length} trades, ${CHECKED} variants checked`);
console.log(`> halves split at sellAt median; pessimistic = next-tick ${PESS_DELAY}ms + size slippage + full costs; CI for n>=30; MIN_N=${MIN_N}.`);
printTable(`Half 1 (tuning, n=${H1.length}) — optimistic`, evalHalf(H1, "optimistic"));
printTable(`Half 1 (tuning, n=${H1.length}) — pessimistic`, evalHalf(H1, "pessimistic"));
printTable(`Half 2 (validation, n=${H2.length}) — optimistic`, evalHalf(H2, "optimistic"));
const secondPes = evalHalf(H2, "pessimistic");
printTable(`Half 2 (validation, n=${H2.length}) — pessimistic`, secondPes);

// ---- V4/V5 no-data (>30% => conclusion impossible) ----
console.log("\n## V4/V5 no-data (>30% => вывод невозможен)");
for (const v of secondPes.variants) {
  if (v.id !== "V4" && v.id !== "V5") continue;
  const share = v.noDataShare === null ? 0 : v.noDataShare;
  console.log(`- ${v.id}: noData ${v.noData}/${v.n + v.noData} (${(share * 100).toFixed(0)}%)${share > 0.3 ? " — вывод невозможен" : ""}`);
}

// ---- aggregate helper ----
function breakdownLine(list) {
  const vals = list.map((t) => (Number(t.buySol) > 0 ? (Number(t.pnlSol) / Number(t.buySol)) * 100 : null)).filter(Number.isFinite);
  const wins = list.filter((t) => Number(t.pnlSol) > 0).length;
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const ci = vals.length >= 30 ? bootstrapCI(vals, { resamples: 2000, seed: 42 }) : null;
  return { n: list.length, winPct: list.length ? (wins / list.length) * 100 : null, mean, ci };
}

// ---- by hour of day (Brussels), half 2, pessimistic V0 ----
console.log("\n## By hour (Brussels, half 2, pessimistic V0)");
console.log("| hour | n | win% | meanNet% | CI95 |");
console.log("|---|---|---|---|---|");
{
  const pess = toPess(H2);
  const groups = new Map();
  for (const t of pess) {
    const h = t.buyHour === undefined || t.buyHour === null ? "n/a" : String(t.buyHour).padStart(2, "0");
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(t);
  }
  for (const h of [...groups.keys()].sort()) {
    const b = breakdownLine(groups.get(h));
    console.log(`| ${h} | ${b.n} | ${b.winPct === null ? "n/a" : b.winPct.toFixed(0)} | ${b.mean === null ? "n/a" : b.mean.toFixed(1)} | ${b.ci ? `[${b.ci.lo.toFixed(1)}..${b.ci.hi.toFixed(1)}]` : "n/a"} |`);
  }
}

// ---- by mayhemMode, half 2, pessimistic ----
console.log("\n## By mayhemMode (half 2, pessimistic V0)");
console.log("| mayhemMode | n | win% | meanNet% | CI95 |");
console.log("|---|---|---|---|---|");
{
  const pess = toPess(H2);
  const groups = [
    ["mayhem(true)", (t) => t.mayhemMode === true],
    ["standard(false)", (t) => t.mayhemMode === false],
    ["unknown", (t) => t.mayhemMode !== true && t.mayhemMode !== false],
  ];
  for (const [label, pred] of groups) {
    const b = breakdownLine(pess.filter(pred));
    console.log(`| ${label} | ${b.n} | ${b.winPct === null ? "n/a" : b.winPct.toFixed(0)} | ${b.mean === null ? "n/a" : b.mean.toFixed(1)} | ${b.ci ? `[${b.ci.lo.toFixed(1)}..${b.ci.hi.toFixed(1)}]` : "n/a"} |`);
  }
}

// ---- acceptance (half 2, pessimistic) ----
console.log(`\n## Acceptance (half 2, pessimistic): n >= ${MIN_N} AND 95% CI lo > 0; Bonferroni alpha/${CHECKED}`);
const alphaB = 0.05 / CHECKED;
let anyAccepted = false;
for (const v of secondPes.variants) {
  if (v.id === "V0") continue;
  const vals = v.netPcts || [];
  const ci95 = vals.length >= 30 ? bootstrapCI(vals, { resamples: 2000, seed: 42 }) : null;
  const ciB = vals.length >= 30 ? bootstrapCI(vals, { resamples: 4000, seed: 42, alpha: alphaB }) : null;
  if (v.n >= MIN_N && ci95 && ci95.lo > 0) anyAccepted = true;
  console.log(`- ${v.id}: n=${v.n}${v.n < MIN_N ? ` (<${MIN_N})` : ""} meanNet=${v.meanNetPct === null ? "n/a" : v.meanNetPct.toFixed(1)}` +
    ` | 95% [${ci95 ? `${ci95.lo.toFixed(1)}..${ci95.hi.toFixed(1)}` : "n/a"}] ${ci95 && ci95.lo > 0 ? "PASS" : "fail"}` +
    ` | Bonf [${ciB ? `${ciB.lo.toFixed(1)}..${ciB.hi.toFixed(1)}` : "n/a"}] ${ciB && ciB.lo > 0 ? "PASS" : "fail"}`);
}
console.log(
  anyAccepted
    ? "\nRESULT: at least one variant passes the 95% bar on half 2 (pessimistic)."
    : `\nRESULT: положительного ожидания нет ни в одном варианте (half 2, pessimistic, n>=${MIN_N}, 95% CI lo > 0).`,
);

