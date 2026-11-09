#!/usr/bin/env node
// Shadow-variant report (step 4). Reads the journal + the hold tick trajectories and evaluates
// V0-V7. V4 (partial 50% @1.5x + trailing) and V5 (timeout 180 s) replay on FRESH ticks only.
//
//   node scripts/shadow.mjs [sessionId] [--sha <gitSha>]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal, dedupeTrades } from "../lib/journal.mjs";
import { evaluateShadow, shadowLines, LAUNCH_RAW } from "../lib/shadow.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.JOURNAL_DIR || path.join(ROOT, "data", "journal");
const args = process.argv.slice(2);
const shaIdx = args.indexOf("--sha");
const sha = shaIdx >= 0 ? args[shaIdx + 1] : null;
const sid = args.filter((a, i) => a !== "--sha" && (shaIdx < 0 || i !== shaIdx + 1))[0] || null;

const allRows = readJournal(dir);
const { records, duplicates } = dedupeTrades(allRows);
const trades = records.filter((r) => r.type === "trade" && (!sid || r.sessionId === sid) && (!sha || r.gitSha === sha));

// hold tick trajectories: mint -> [{ t, ratio, stale, ageMs }] sorted by t
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
      ticks.get(j.mint).push({ t: Number(j.t), ratio: Number(j.ratio), stale: j.stale === true, ageMs: j.ageMs ?? null });
    }
  }
} catch {
  /* no ticks yet */
}
for (const [, s] of ticks) s.sort((a, b) => a.t - b.t);

if (!trades.length) {
  console.error(`no trades${sha ? ` for gitSha ${sha}` : ""}`);
  process.exit(1);
}

if (duplicates.length) {
  console.error(`(dedupe: removed ${duplicates.length} duplicate(s))`);
  for (const d of duplicates.slice(0, 12)) {
    console.error(`  - ${d.mint.slice(0, 10)} kept=${(d.keptSessionId || "n/a").slice(-12)} dup=${(d.dupSessionId || "n/a").slice(-12)} gap=${d.gapMs ?? "n/a"}ms`);
  }
  if (duplicates.length > 12) console.error(`  ... and ${duplicates.length - 12} more`);
}

const { variants, checkedVariants } = evaluateShadow(trades, { floorPrice: LAUNCH_RAW, ticks });
const { h, rows } = shadowLines({ variants, checkedVariants });
const w = h.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
console.log(`# SHADOW variants V0-V7 — ${trades.length} trades${sha ? `, gitSha ${sha}` : ""}`);
console.log(`> floor ${LAUNCH_RAW.toExponential(4)} SOL/raw (30 SOL / 1.073e9); CI for n>=30; verdicts only for n>=200; ${checkedVariants} variants checked.`);
console.log("| " + h.map((c, i) => c.padEnd(w[i])).join(" | ") + " |");
console.log("|" + h.map((c, i) => "-".repeat(w[i] + 2)).join("|") + "|");
for (const r of rows) console.log("| " + r.map((c, i) => String(c).padEnd(w[i])).join(" | ") + " |");

console.log("\n## no-data (V4/V5: positions with no fresh tick trajectory)");
for (const v of variants) {
  if (v.id === "V4" || v.id === "V5") {
    console.log(`- ${v.id}: ${v.noData} of ${v.n + v.noData} entered (${v.noDataShare === null ? "n/a" : (v.noDataShare * 100).toFixed(0)}%) could not be replayed — no data`);
  }
}

const verdicts = variants.filter((v) => v.verdict);
console.log(verdicts.length ? "\n## verdicts (n>=200)" : "\n## verdicts: none (n < 200 on every variant)");
for (const v of verdicts) console.log(`- ${v.id}: ${v.verdict}`);
console.log(`\n> multiple-comparisons: ${checkedVariants} variants checked; accept only if 95% CI lower bound > 0 AND it survives Bonferroni (alpha/${checkedVariants}).`);
