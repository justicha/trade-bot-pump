#!/usr/bin/env node
// Replay / comparison of the strategy variants collected by bots/research/lab.mjs.
//
//   node bots/research/replay.mjs                      # all journals in data/research/variants
//   node bots/research/replay.mjs <dir-with-jsonl>
//   REPLAY_MIN_TRADES=100 node bots/research/replay.mjs
//
// Rules (deliberately strict):
//   * thresholds are chosen on the FIRST 70% of the trades (by time),
//   * every variant is judged ONCE on the LAST 30%,
//   * a variant "wins" only with >= REPLAY_MIN_TRADES test trades AND a bootstrap CI lower
//     bound above 0 after costs. Otherwise the verdict is "устойчивого перевеса нет".
import fs from "node:fs";
import path from "node:path";
import { readJournal, excludeDegraded } from "../../lib/journal.mjs";
import { ROOT } from "../../lib/config.mjs";
import { evaluateVariant, chooseByTuning, slippageSensitivity, latencySensitivity, evaluateFrozen } from "../../lib/research.mjs";

// --freeze <variant> must not be mistaken for a directory argument
const ARGS = process.argv.slice(2);
const FREEZE_IDX = ARGS.indexOf("--freeze");
const FREEZE_TARGET = FREEZE_IDX >= 0 ? ARGS[FREEZE_IDX + 1] : null;
const SKIP_IDX = FREEZE_IDX >= 0 ? FREEZE_IDX + 1 : -1; // the freeze target is not a directory
const dir = ARGS.find((a, i) => !a.startsWith("--") && i !== SKIP_IDX) || path.join(ROOT, "data", "research", "variants");
const MIN_TRADES = Number(process.env.REPLAY_MIN_TRADES || 300);
const TEST_FRACTION = Number(process.env.REPLAY_TEST_FRACTION || 0.7);
const RESAMPLES = Number(process.env.REPLAY_RESAMPLES || 2000);

if (!fs.existsSync(dir)) {
  console.log(`No data: ${dir} is missing. Collect first: node bots/research/lab.mjs`);
  process.exit(0);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
if (!files.length) {
  console.log(`No journals in ${dir}. Collect first: node bots/research/lab.mjs`);
  process.exit(0);
}

// variant -> trades (one line per closed paper trade). Trades from RPC-degraded sessions (a 429
// share > 5%) are excluded, otherwise throttling would silently distort the comparison.
const byVariant = new Map();
let excludedDegraded = 0;
for (const f of files) {
  const recs = readJournal(path.join(dir, f));
  const deg = excludeDegraded(recs);
  excludedDegraded += deg.excludedCount;
  for (const rec of deg.records) {
    if (rec.type !== "exit" && rec.type !== "trade") continue;
    const name = rec.variant || path.basename(f, ".jsonl");
    if (!byVariant.has(name)) byVariant.set(name, []);
    byVariant.get(name).push(rec);
  }
}
if (excludedDegraded) console.log(`excluded ${excludedDegraded} trade(s) from RPC-degraded sessions`);

// ---- anti-peeking: --freeze <variant> -------------------------------------
const FROZEN_PATH = path.join(ROOT, "data", "research", "frozen.json");
const freezeArg = FREEZE_TARGET;
let frozen = null;
try {
  frozen = JSON.parse(fs.readFileSync(FROZEN_PATH, "utf8"));
} catch {
  frozen = null;
}

if (freezeArg) {
  const trades = byVariant.get(freezeArg) || [];
  const record = {
    variant: freezeArg,
    frozenAt: Date.now(),
    frozenIso: new Date().toISOString(),
    params: { minTrades: MIN_TRADES, testFraction: TEST_FRACTION, resamples: RESAMPLES },
    tradesSeen: trades.length,
  };
  fs.mkdirSync(path.dirname(FROZEN_PATH), { recursive: true });
  fs.writeFileSync(FROZEN_PATH, JSON.stringify(record, null, 2));
  console.log(`frozen: ${freezeArg} at ${record.frozenIso} (${trades.length} trades seen so far)`);
  console.log("next: collect more data, then run replay again - only trades closed after this moment are judged.");
  process.exit(0);
}

const results = [...byVariant.entries()]
  .map(([name, trades]) => evaluateVariant(name, trades, { testFraction: TEST_FRACTION, minTrades: MIN_TRADES, resamples: RESAMPLES }))
  .sort((a, b) => b.test.meanPct - a.test.meanPct);

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 8) => String(v).padStart(n);

console.log("=== VARIANT REPLAY (after 1% fee in + 1% out, priority fee, slippage) ===");
console.log(`journals: ${files.length}   tuning = first ${Math.round(TEST_FRACTION * 100)}% of trades by time, test = last ${Math.round((1 - TEST_FRACTION) * 100)}%`);
console.log(
  "\n" +
    pad("variant", 9) +
    num("n tune") +
    num("n test") +
    num("mean%") +
    num("CI low") +
    num("CI high") +
    num("median%") +
    num("TP%") +
    num("<-50%") +
    num("maxDD") +
    "  verdict",
);
for (const r of results) {
  const t = r.test;
  console.log(
    pad(r.variant, 9) +
      num(r.nTuning) +
      num(r.nTest) +
      num(t.meanPct.toFixed(2)) +
      num(t.ciLo.toFixed(2)) +
      num(t.ciHi.toFixed(2)) +
      num(t.medianPct.toFixed(2)) +
      num(t.tpShare.toFixed(1)) +
      num(t.bigLossShare.toFixed(1)) +
      num(t.maxDrawdownSol.toFixed(4)) +
      "  " +
      (r.pass ? "PASS" : `no (${r.reason})`),
  );
}

// F-sweep: pick the stop-loss on tuning data, then report its hold-out numbers once.
const sweep = results.filter((r) => /^F/.test(r.variant));
if (sweep.length) {
  const best = chooseByTuning(sweep);
  console.log(
    `\nstop-loss sweep: best on tuning = ${best?.variant} (${best?.tuning.meanPct}% on ${best?.nTuning} trades)` +
      ` -> hold-out: ${best?.test.meanPct}% [${best?.test.ciLo}..${best?.test.ciHi}] on ${best?.nTest} trades`,
  );
}

console.log("\n=== SENSITIVITY: slippage (bps per leg), after 1%+1% fees and tx costs ===");
for (const [name, trades] of [...byVariant.entries()].sort()) {
  if (trades.length < 2) continue;
  const rows = slippageSensitivity(trades, [50, 100, 200]);
  const fmt = rows.map((r) => `${r.slippageBps}bps: mean ${r.meanPct.toFixed(2)}% / med ${r.medianPct.toFixed(2)}%`).join("   ");
  console.log(`  ${name.padEnd(8)} n=${String(trades.length).padStart(4)}   ${fmt}`);
}

const latRows = latencySensitivity(byVariant);
if (latRows.length) {
  console.log("\n=== SENSITIVITY: execution latency (variants named <name>@<ms>) ===");
  for (const r of latRows) {
    console.log(`  ${r.base.padEnd(6)} ${String(r.latencyMs).padStart(5)}ms   n=${String(r.n).padStart(4)}  mean ${r.meanPct.toFixed(2)}%  median ${r.medianPct.toFixed(2)}%`);
  }
} else {
  console.log("\n(no latency grid in the journals: run lab with LAB_LATENCY_GRID=300,600,1200)");
}

if (frozen && !freezeArg) {
  const trades = byVariant.get(frozen.variant) || [];
  const ev = evaluateFrozen(trades, frozen, { minTrades: MIN_TRADES });
  console.log(`\n=== FROZEN ${frozen.variant} (locked at ${new Date(frozen.frozenAt).toISOString()}) ===`);
  console.log(`  trades closed after the freeze: ${ev.n}   mean ${ev.stats.meanPct}%   99% CI [${ev.stats.ciLo}..${ev.stats.ciHi}]`);
  console.log(`  median ${ev.stats.medianPct}%   TP share ${ev.stats.tpShare}%   >50% losses ${ev.stats.bigLossShare}%   maxDD ${ev.stats.maxDrawdownSol} SOL`);
  console.log(`  verdict: ${ev.pass ? "PASS (99% CI above 0 on post-freeze trades)" : `no - ${ev.reason}`}`);
}

const winners = results.filter((r) => r.pass);
console.log("");
if (!winners.length) {
  console.log("ВЕРДИКТ: устойчивого перевеса нет.");
  const closest = results[0];
  if (closest) {
    console.log(
      `  ближе всех: ${closest.variant} — средняя ${closest.test.meanPct}%, CI [${closest.test.ciLo}..${closest.test.ciHi}], тест-сделок ${closest.nTest} (нужно ${MIN_TRADES})`,
    );
  }
  console.log("  нужно больше данных (собрать ещё прогонов) и/или другие гипотезы, а не подкрутка порогов.");
} else {
  console.log(`ВЕРДИКТ: прошли критерий: ${winners.map((w) => w.variant).join(", ")} — на hold-out данных, с комиссиями.`);
  console.log("  это статистика прошлого, а не гарантия будущего: решение всё равно за лимитами размера позиции.");
}
