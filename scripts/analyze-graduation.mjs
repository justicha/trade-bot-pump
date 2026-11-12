#!/usr/bin/env node
// Offline report for the graduation shadow lab (bots/graduation-sniper/shadow.mjs).
//
//   node scripts/analyze-graduation.mjs [journal.jsonl]
//
// Reads every `gshadow_trade` line and reports them GROUPED BY `costsScheme`: netPct produced by
// different accounting models (v2 charged the buy slippage twice, v3-single-slip charges it once)
// is not the same quantity, so the epochs are never averaged together. Lines written before the
// field existed are reported as "legacy".
//
// Inside a group each variant is split by TIME into a fit half and a hold-out half, and
// n / win% / mean / median / PF / maxDD / exit mix are printed. A 95% bootstrap CI is given only
// for n >= 30; rows with n < 200 are marked "no conclusion" — the acceptance rule is the lower CI
// bound > 0 on the SECOND half; the honest possible verdict is "no positive expectancy".
//
// The sample block exists because the variants trade the SAME mints: 66 trades once turned out to
// be 8 distinct mints, so "trades per variant" overstates the independent evidence by an order of
// magnitude. Below 30 distinct mints the report refuses to read as a verdict at all.
import fs from "node:fs";
import path from "node:path";
import { summarize } from "../lib/gradstats.mjs";
import { ROOT } from "../lib/config.mjs";

const MIN_INDEPENDENT_MINTS = 30;

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

// ---- epoch split: one table per accounting scheme -----------------------------------------
const LEGACY = "legacy (no costsScheme)";
const schemeOf = (t) => (typeof t.costsScheme === "string" && t.costsScheme.trim() ? t.costsScheme : LEGACY);
const byScheme = new Map();
for (const t of trades) {
  const key = schemeOf(t);
  if (!byScheme.has(key)) byScheme.set(key, []);
  byScheme.get(key).push(t);
}

const pct = (x) => (x == null ? "n/a" : `${x.toFixed(2)}%`);
const ci = (c) => (c ? `[${c.lo.toFixed(2)}; ${c.hi.toFixed(2)}]` : "n/a");
const pf = (x) => (x == null ? "n/a" : x === Infinity ? "inf" : x.toFixed(2));

console.log(`graduation shadow: ${trades.length} trade(s) from ${files.length} file(s) | candidates seen: ${candidates.size}`);
if (byScheme.size > 1) {
  console.log(`смешаны версии учёта (${byScheme.size}): ${[...byScheme].map(([k, v]) => `${k}=${v.length}`).join(" | ")}`);
  console.log("таблицы ниже разделены по схеме; общая таблица НЕ выводится — netPct разных схем несравнимы");
}

// ---- one table per epoch -----------------------------------------------------------------
function reportGroup(scheme, list) {
  // split each variant's own series in half by TIME (fit = first, hold-out = second)
  list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const mints = new Set(list.map((t) => t.mint));
  const per = new Map();
  for (const t of list) per.set(t.variant, (per.get(t.variant) || 0) + 1);

  console.log(`\n=== costsScheme: ${scheme} — ${list.length} trade(s) ===`);
  console.log(
    `samples: unique mints ${mints.size} | candidates ${candidates.size} | per variant: ${[...per].sort().map(([v, n]) => `${v}=${n}`).join(" ")}`,
  );
  if (mints.size < MIN_INDEPENDENT_MINTS) {
    console.log(`WARNING: уникальных mints ${mints.size} < ${MIN_INDEPENDENT_MINTS} — наблюдения сильно коррелированы, вердикт не делать`);
  }

  // Exit venues (v4-amm-exit rows): where each position was priced. A migrated position without a
  // pool quote has NO result (netPct null) — it is counted, shown, and kept OUT of every average:
  // Number(null) is 0, and averaging it in would silently book an unknown outcome as break-even.
  const venues = new Map();
  for (const t of list) if (t.exitVenue) venues.set(t.exitVenue, (venues.get(t.exitVenue) || 0) + 1);
  if (venues.size) {
    console.log(`exit venues: ${["curve", "amm", "amm-unpriced"].filter((k) => venues.has(k)).map((k) => `${k}=${venues.get(k)}`).join(" ")}`);
  }
  const priced = (t) => t.netPct !== null && t.netPct !== undefined && Number.isFinite(Number(t.netPct));
  const unpriced = list.filter((t) => !priced(t));
  if (unpriced.length) {
    const perV = new Map();
    for (const t of unpriced) perV.set(t.variant, (perV.get(t.variant) || 0) + 1);
    console.log(
      `UNPRICED: ${unpriced.length} of ${list.length} trade(s) have no result (curve completed, no pool quote) — excluded from the statistics below: ${[...perV].sort().map(([v, n]) => `${v}=${n}`).join(" ")}`,
    );
    console.log("          these positions could NOT be sold at a known price; the table is optimistic by exactly that much");
  }

  const byVariant = new Map();
  for (const t of list) {
    if (!priced(t)) continue;
    if (!byVariant.has(t.variant)) byVariant.set(t.variant, []);
    byVariant.get(t.variant).push(t);
  }

  const rows = [];
  for (const [variant, vl] of [...byVariant].sort()) {
    const nets = vl.map((t) => Number(t.netPct));
    const reasons = vl.map((t) => String(t.reason || "unknown"));
    const mid = Math.floor(vl.length / 2);
    const fit = vl.slice(0, mid);
    const hold = vl.slice(mid);
    rows.push({
      variant,
      all: summarize(nets, { reasons }),
      fit: summarize(fit.map((t) => Number(t.netPct)), { reasons: fit.map((t) => String(t.reason)) }),
      hold: summarize(hold.map((t) => Number(t.netPct)), { reasons: hold.map((t) => String(t.reason)) }),
    });
  }
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
  const verdict =
    anyHoldCi ? "positive lower CI on the hold-out half for at least one variant" : "no positive expectancy in any variant";
  console.log(`VERDICT (${scheme}): ${verdict}${allSmall ? " (n<200 everywhere: a screening result, not a profitability conclusion)" : ""}`);
  if (mints.size < MIN_INDEPENDENT_MINTS) {
    console.log(`VERDICT (${scheme}): withheld — ${mints.size} distinct mints < ${MIN_INDEPENDENT_MINTS}, the trades are not independent.`);
  }
}

// One table per accounting epoch, biggest first. A combined table is deliberately NOT printed when
// more than one scheme is present (see the header): averaging v2 and v3 netPct would be a lie.
for (const [scheme, list] of [...byScheme].sort((a, b) => b[1].length - a[1].length)) reportGroup(scheme, list);

console.log(`\nvariant I (enter after migration): нет данных — the trade stream carries no AMM price.`);

