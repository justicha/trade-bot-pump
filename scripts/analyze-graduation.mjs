#!/usr/bin/env node
// Offline report for the graduation shadow lab (bots/graduation-sniper/shadow.mjs).
//
//   node scripts/analyze-graduation.mjs [journal.jsonl]
//
// Reads every `gshadow_trade` line, splits each variant by TIME into a fit half and a hold-out
// half, and prints n / win% / mean / median / PF / maxDD / exit mix. A 95% bootstrap CI is given
// only for n >= 30. Rows with n < 200 are marked "no conclusion" — the acceptance rule is the
// lower CI bound > 0 on the SECOND half; the honest possible verdict is "no positive expectancy".
import fs from "node:fs";
import path from "node:path";
import { summarize } from "../lib/gradstats.mjs";
import { ROOT } from "../lib/config.mjs";

const arg = process.argv[2];
const dir = path.join(ROOT, "data", "journal");
const files = arg ? [arg] : fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f));

const trades = [];
const candidates = new Set();
for (const f of files) {
  let text = "";
  try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "gshadow_trade") trades.push(r);
    else if (r.type === "gshadow_candidate") candidates.add(r.mint);
  }
}

if (!trades.length) {
  console.log("graduation shadow: нет данных — no gshadow_trade lines in data/journal.");
  console.log("run: $env:SHADOW_MAX_SEC='3600'; node bots/graduation-sniper/shadow.mjs");
  process.exit(0);
}

// sort by time, then split each variant's own series in half (fit = first, hold-out = second)
trades.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const byVariant = new Map();
for (const t of trades) {
  if (!byVariant.has(t.variant)) byVariant.set(t.variant, []);
  byVariant.get(t.variant).push(t);
}

const rows = [];
for (const [variant, list] of [...byVariant].sort()) {
  const nets = list.map((t) => Number(t.netPct));
  const reasons = list.map((t) => String(t.reason || "unknown"));
  const mid = Math.floor(list.length / 2);
  const fit = list.slice(0, mid);
  const hold = list.slice(mid);
  rows.push({
    variant,
    all: summarize(nets, { reasons }),
    fit: summarize(fit.map((t) => Number(t.netPct)), { reasons: fit.map((t) => String(t.reason)) }),
    hold: summarize(hold.map((t) => Number(t.netPct)), { reasons: hold.map((t) => String(t.reason)) }),
  });
}

const pct = (x) => (x == null ? "n/a" : `${x.toFixed(2)}%`);
const ci = (c) => (c ? `[${c.lo.toFixed(2)}; ${c.hi.toFixed(2)}]` : "n/a");
const pf = (x) => (x == null ? "n/a" : x === Infinity ? "inf" : x.toFixed(2));

console.log(`candidates seen: ${candidates.size} | trades: ${trades.length}`);
console.log("\nvariant  n     win%    mean     median   PF    maxDD    TP/SL/TO       ci95(mean)        verdict(hold-out)");
for (const r of rows) {
  const a = r.all;
  const h = r.hold;
  const verdict = h.n === 0
    ? "no data"
    : h.ci95 == null
      ? `n=${h.n} < 30: no CI`
      : h.ci95.lo > 0
        ? "positive lower bound (still n<200: no conclusion)"
        : "no positive expectancy";
  console.log(
    `${r.variant.padEnd(8)} ${String(a.n).padEnd(5)} ${String(a.winPct ?? "n/a").padEnd(6)} ${pct(a.meanPct).padEnd(8)} ${pct(a.medianPct).padEnd(8)} ${pf(a.profitFactor).padEnd(5)} ${pct(a.maxDdPct).padEnd(8)} ${`${a.tpPct ?? 0}/${a.slPct ?? 0}/${a.timeoutPct ?? 0}`.padEnd(13)} ${ci(a.ci95).padEnd(18)} ${verdict}`,
  );
}

const anyHoldCi = rows.some((r) => r.hold.ci95 && r.hold.ci95.lo > 0);
const allSmall = rows.every((r) => r.all.n < 200);
console.log(
  `\nVERDICT: ${anyHoldCi ? "positive lower CI on the hold-out half for at least one variant" : "положительного ожидания нет ни в одном варианте"}` +
    (allSmall ? " (n<200 everywhere: not a profitability conclusion, only a screening result)" : ""),
);
console.log(`variant I (enter after migration): нет данных — the trade stream carries no AMM price.`);
