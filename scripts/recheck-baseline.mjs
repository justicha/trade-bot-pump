#!/usr/bin/env node
// Re-check the old sniper baseline (data/journal) with the corrected price basis and costs.
//
//   node scripts/recheck-baseline.mjs
//
// Why: the journal was written while getPrice() was treated as "SOL per token" — it is really
// SOL per RAW unit, so a token price was 1000x off. Some trades were priced from an implausible
// curve state (the "0.02 SOL -> 405-801M tokens" class): those "take-profits" are artifacts.
// A trade is flagged when its implied tokens-per-SOL lands outside a wide sanity band
// (normal pump.fun launch is ~35.7M tokens/SOL, graduation ~8M).
import { readJournal, splitByScheme } from "../lib/journal.mjs";
import { roundTripCosts } from "../lib/fees.mjs";
import { rawSolPerTokenToWhole } from "../lib/curve.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(ROOT, "data", "journal");
// Three bands around the measured reality (launch ~35.7M tokens/SOL, graduation ~8M):
// tight (2x either side), medium (4x), loose (10x). A conclusion that survives all three
// does not depend on the threshold.
const BANDS = [
  { name: "tight", min: 1.8e7, max: 7.1e7 },
  { name: "medium", min: 8.9e6, max: 1.43e8 },
  { name: "loose", min: 3.57e6, max: 3.57e8 },
];
const BAND = BANDS[1];
const records = readJournal(DIR);
const byScheme = splitByScheme(records);
const trades = byScheme.v2; // v1 lines (pre-costsScheme) are excluded, not mixed in
if (byScheme.v1Count > 0) {
  console.log(`excluded ${byScheme.v1Count} trade line(s) without a v2 costsScheme (old cost model "v1") — they are NOT averaged with v2`);
}

if (!trades.length) {
  console.log(`No trades in ${DIR}. Nothing to re-check.`);
  process.exit(0);
}

const rows = trades.map((t) => {
  const entryWhole = rawSolPerTokenToWhole(Number(t.entrySol)); // raw unit price -> price per whole token
  const exitWhole = rawSolPerTokenToWhole(Number(t.exitSol));
  const tokensPerSol = entryWhole > 0 ? 1 / entryWhole : null;
  const artifact = !(tokensPerSol >= BAND.min && tokensPerSol <= BAND.max);
  const ratio = Number(t.ratio);
  const costs = Number.isFinite(ratio) && ratio > 0 ? roundTripCosts({ buySol: Number(t.buySol) || 0.02, ratio }) : null;
  return {
    mint: t.mint,
    exitReason: t.exitReason,
    recordedPnlPct: Number(t.pnlPct),
    recordedPnlSol: Number(t.pnlSol),
    entryWhole,
    exitWhole,
    tokensPerSol,
    artifact,
    ratio,
    netPnlSol: costs ? costs.netPnl : null,
    netPct: costs ? (costs.netPnl / (Number(t.buySol) || 0.02)) * 100 : null,
    holdersAtEntry: t.holdersAtEntry ?? null,
    holdSec: t.holdSec ?? null,
  };
});

console.log("\n=== artifacts and PnL under three different sanity bands ===");
console.log("  band     tokens/SOL window           artifacts   clean   wins     gross SOL      after costs");
for (const band of BANDS) {
  const keep = rows.filter((r) => r.tokensPerSol >= band.min && r.tokensPerSol <= band.max);
  const drop = rows.length - keep.length;
  const gross = keep.reduce((a, b) => a + (b.recordedPnlSol || 0), 0);
  const net = keep.reduce((a, b) => a + (b.netPnlSol || 0), 0);
  const wins = keep.filter((r) => r.recordedPnlPct > 0).length;
  console.log(
    (`  ${band.name.padEnd(8)} ${band.min.toExponential(2)}..${band.max.toExponential(2)}`).padEnd(38) +
      `${String(drop).padStart(9)}   ${String(keep.length).padStart(7)}   ${String(wins).padStart(4)}   ` +
      `${gross >= 0 ? "+" : ""}${gross.toFixed(6)}   ${net >= 0 ? "+" : ""}${net.toFixed(6)}`,
  );
}

const clean = rows.filter((r) => !r.artifact);
const artifacts = rows.filter((r) => r.artifact);
const takes = rows.filter((r) => r.recordedPnlPct > 0);
const takeArtifacts = takes.filter((r) => r.artifact);
const sum = (xs, k) => xs.reduce((a, b) => a + (Number(b[k]) || 0), 0);
const sol = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(6)} SOL`;

console.log("=== BASELINE RE-CHECK (data/journal, variant A = sniper) ===");
console.log(`trades: ${rows.length}   price artifacts: ${artifacts.length} (${((artifacts.length / rows.length) * 100).toFixed(1)}%)`);
console.log(`sanity band: ${BAND.min.toExponential(1)}..${BAND.max.toExponential(1)} tokens/SOL`);

console.log("\n recorded (old basis)                 clean subset (artifacts removed)");
console.log(`  wins:        ${String(takes.length).padStart(3)}                       wins:        ${String(clean.filter((r) => r.recordedPnlPct > 0).length).padStart(3)}`);
console.log(`  losses:      ${String(rows.length - takes.length).padStart(3)}                       losses:      ${String(clean.length - clean.filter((r) => r.recordedPnlPct > 0).length).padStart(3)}`);
console.log(`  sum pnl:     ${sol(sum(rows, "recordedPnlSol")).padStart(16)}      sum pnl:     ${sol(sum(clean, "recordedPnlSol")).padStart(16)}`);
console.log(`  after costs: ${sol(sum(clean, "netPnlSol")).padStart(16)}   (recomputed with 1%+1%, priority fee, slippage)`);

console.log(`\n"take-profit" trades: ${takes.length}, of them priced from a broken curve state: ${takeArtifacts.length}`);
console.log(`money attributed to those artifacts: ${sol(sum(takeArtifacts, "recordedPnlSol"))}`);

console.log("\n worst artifacts:");
for (const r of artifacts.slice(0, 8)) {
  console.log(
    `  ${String(r.mint).slice(0, 10)}  tokens/SOL=${r.tokensPerSol ? Math.round(r.tokensPerSol).toExponential(2) : "n/a"}` +
      `  price=${r.entryWhole.toExponential(2)}  recorded ${r.recordedPnlPct.toFixed(1)}%  (${r.exitReason})`,
  );
}

// A conclusion needs clean prices. When more than a tenth of the trades are priced from a
// state that cannot be true, "net positive" and "net negative" are both unprovable — say so
// instead of printing a number that looks like a verdict.
const questionableShare = rows.length ? artifacts.length / rows.length : 0;
const cleanNet = sum(clean, "netPnlSol");
const verdict =
  questionableShare > 0.1
    ? "вывод недоказуем"
    : cleanNet > 0
      ? "плюс (на чистых сделках, после издержек)"
      : "минус (на чистых сделках, после издержек)";
console.log(`\n=== ВЕРДИКТ: ${verdict} ===`);
console.log(
  `  цены под вопросом: ${artifacts.length}/${rows.length} (${(questionableShare * 100).toFixed(1)}%)` +
    (questionableShare > 0.1 ? " > 10% — числа выше нельзя читать как плюс или минус" : " <= 10%"),
);
console.log(`  чистая выборка: ${clean.length} сделок, ${sol(cleanNet)}, ${clean.filter((r) => r.recordedPnlPct > 0).length} в плюс`);

const out = path.join(ROOT, "data", "research", "baseline_recheck.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      band: BAND,
      trades: rows.length,
      artifacts: artifacts.length,
      questionableShare,
      verdict,
      takes: takes.length,
      takeArtifacts: takeArtifacts.length,
      recordedSumSol: sum(rows, "recordedPnlSol"),
      cleanRecordedSumSol: sum(clean, "recordedPnlSol"),
      cleanNetAfterCostsSol: sum(clean, "netPnlSol"),
      rows,
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${out}`);
