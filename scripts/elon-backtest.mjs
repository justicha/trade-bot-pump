#!/usr/bin/env node
// elon-watch Part A3 (KODING #25): offline join of @elonmusk posts with census mints. READ ONLY.
//
//   node scripts/elon-backtest.mjs agents/census-2026-11-19.jsonl.gz ... [--posts data/elon/posts.jsonl]
//        [--out data/elon/backtest-events.jsonl]
//
// Unit of observation = keyword EVENT (post id x keyword norm, lib/elon-match.mjs keywordEvents); the same
// keyword again within 24 h is repeat: true and counted once. Matches: census_mint rows (deduplicated by
// mint, the row with the largest maxFill) with createSeen and a name, created in [post - 6 h, post + 30 min]
// (symbol / name / whole word / Levenshtein <= 1 at length >= 5).
//
// BIAS (PROMPT N1): census_mint carries name / symbol ONLY in full rows (maxFill >= 25). Compact rows
// (most mints) have no name, so this backtest sees only tokens that reached fill 25 %: counts of matches,
// "share migrated", "best match reached 50 / 85" and any pick rule are biased UPWARD. It answers only "did
// a >= 25 % token with the word appear, and how fast". No pick-rule conclusion from it.
// Paper entries (lags L = 3 / 10 / 30 / 60 s) need a census_path row (path runs of 2026-11-23 only, so n
// is tiny, PROMPT N2): decision = max(post + L, create + 1 s), entry = the close of the first path bucket at
// or after decision + 1 s, then lib/elon-paper.mjs evalPathEntry (curve impact both legs + the
// pessimistic cost model, ELON_COSTS_SCHEME), exits at +1 / +5 / +15 / +30 min, max multiple in 30 min.
// The same fill >= 25 condition applies to path rows (a path row exists only past fill 25): look-ahead.
// Events are counted only where the census covered [post - 10 min, post + 30 min] (no gap > 10 min
// between consecutive creates).
if (process.argv.includes("--live")) {
  console.error("[elon-backtest] read-only; --live is not accepted.");
  process.exit(1);
}
const fs = await import("node:fs");
const path = await import("node:path");
const zlib = await import("node:zlib");
const readline = await import("node:readline");
const { ROOT } = await import("../lib/config.mjs");
const { extractKeywords } = await import("../lib/elon-keywords.mjs");
const M = await import("../lib/elon-match.mjs");
const P = await import("../lib/elon-paper.mjs");
const { loadPostsCache } = await import("../lib/x-source.mjs");
const { bootstrapCI } = await import("../lib/research.mjs");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const DIR = process.env.ELON_DIR ? path.resolve(process.env.ELON_DIR) : path.join(ROOT, "data", "elon");
const postsFile = opt("--posts", path.join(DIR, "posts.jsonl"));
const outFile = opt("--out", path.join(DIR, "backtest-events.jsonl"));
const BUY_SOL = Number(process.env.SHADOW_BUY_SOL || 0.02);
const LAGS = [3, 10, 30, 60];
const HORIZONS = [60, 300, 900, 1800];
const COVER_GAP_SEC = 600;
if (!files.length) {
  console.error("usage: node scripts/elon-backtest.mjs <census .jsonl / .jsonl.gz files...> [--posts file] [--out file]");
  process.exit(1);
}

// ---- census ----------------------------------------------------------------------------------------------
const best = new Map(); // mint -> census_mint row with the largest maxFill (named rows only)
const paths = new Map(); // mint -> [census_path rows]
const createSecs = [];
let rows = 0;
for (const f of files) {
  const input = f.endsWith(".gz") ? fs.createReadStream(f).pipe(zlib.createGunzip()) : fs.createReadStream(f);
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!line.includes('"census_')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === "census_mint") {
      rows += 1;
      if (r.createSeen && Number.isFinite(r.createSec)) createSecs.push(r.createSec);
      if (!r.createSeen || typeof r.name !== "string") continue;
      const cur = best.get(r.mint);
      if (!cur || (r.maxFill ?? 0) > (cur.maxFill ?? 0)) best.set(r.mint, r);
    } else if (r.type === "census_path") {
      const l = paths.get(r.mint) || [];
      l.push(r);
      paths.set(r.mint, l);
    }
  }
}
createSecs.sort((a, b) => a - b);
const cover = [];
for (const s of createSecs) {
  const last = cover[cover.length - 1];
  if (last && s - last[1] <= COVER_GAP_SEC) last[1] = s;
  else cover.push([s, s]);
}
const covered = (from, to) => cover.some(([a, b]) => a <= from && b >= to);
const idx = M.createTokenIndex();
for (const r of best.values()) M.indexAdd(idx, { mint: r.mint, name: r.name, symbol: r.symbol, createSec: r.createSec, maxFill: r.maxFill, migrated: r.migrated, uniqueTraders: r.uniqueTraders, devBuySol: r.devBuySol, launches24h: r.launches24h, launcher: r.launcher, mayhem: r.mayhem ?? null, quoteMint: r.quoteMint ?? null, milestones: r.milestones ? Object.fromEntries(Object.entries(r.milestones).map(([k, v]) => [k, v.secFromCreate])) : null });
const cov = cover.filter(([a, b]) => b - a >= 3600).map(([a, b]) => `${new Date(a * 1000).toISOString().slice(0, 16)}..${new Date(b * 1000).toISOString().slice(0, 16)}`);
console.log(`[elon-backtest] census: ${files.length} file(s), ${rows} census_mint rows, ${best.size} named mints (fill >= 25 only), ${[...paths.values()].reduce((a, l) => a + l.length, 0)} census_path rows (${paths.size} mints) | covered windows >= 1 h: ${cov.join(", ") || "none"}`);

// ---- posts / events -----------------------------------------------------------------------------------------
const posts = [...loadPostsCache(postsFile).values()].filter((p) => Number.isFinite(p.postMs));
if (!posts.length) {
  console.log(`[elon-backtest] no posts in ${postsFile} (run scripts/elon-fetch.mjs first). n = 0: no profitability verdict.`);
  process.exit(0);
}
const events = M.keywordEvents(posts, extractKeywords);
const kinds = {};
for (const p of posts) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
console.log(`[elon-backtest] posts ${posts.length} ${JSON.stringify(kinds)} ${new Date(Math.min(...posts.map((p) => p.postMs))).toISOString()} .. ${new Date(Math.max(...posts.map((p) => p.postMs))).toISOString()} | keyword events ${events.length} (repeat ${events.filter((e) => e.repeat).length})`);

const pathFor = (mint, sec) => {
  const l = paths.get(mint);
  if (!l) return null;
  return l.find((r) => r.t?.length && r.t0 + r.t[0] <= sec + 60 && r.t0 + (r.endT ?? 0) >= sec) || l[0];
};
const matchOut = (m, postSec) => ({
  mint: m.entry.mint,
  name: m.entry.name,
  symbol: m.entry.symbol,
  kind: m.kind,
  dtSec: m.entry.createSec - postSec,
  maxFill: m.entry.maxFill,
  migrated: m.entry.migrated,
  uniqueTraders: m.entry.uniqueTraders,
  devBuySol: m.entry.devBuySol,
  launches24h: m.entry.launches24h,
  mayhem: m.entry.mayhem,
  ...(m.entry.quoteMint ? { quoteMint: m.entry.quoteMint } : {}),
  milestones: m.entry.milestones,
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const out = fs.createWriteStream(outFile);
const counted = [];
let uncovered = 0;
for (const ev of events) {
  const isCovered = covered(ev.postSec - 600, ev.postSec + 1800);
  const { before, after, generic } = M.matchEvent(idx, ev);
  const paper = {};
  for (const L of LAGS) {
    paper[L] = [];
    for (const m of after) {
      const decision = Math.max(ev.postSec + L, m.entry.createSec + 1);
      const row = pathFor(m.entry.mint, decision);
      if (!row) continue;
      const r = P.evalPathEntry(row, { entryFromSec: decision + 1, buySol: BUY_SOL, horizons: HORIZONS });
      paper[L].push({ mint: m.entry.mint, dtSec: m.entry.createSec - ev.postSec, ...r });
    }
  }
  const rec = {
    eventId: ev.eventId,
    postId: ev.postId,
    postSec: ev.postSec,
    kind: ev.kind,
    kw: ev.kw,
    norm: ev.norm,
    reason: ev.reason,
    weight: ev.weight,
    repeat: ev.repeat,
    covered: isCovered,
    generic,
    matchesBefore: before.length,
    matchesAfter: after.length,
    firstAfterSec: after.length ? after[0].entry.createSec - ev.postSec : null,
    before: before.slice(-20).map((m) => matchOut(m, ev.postSec)),
    after: after.slice(0, 50).map((m) => matchOut(m, ev.postSec)),
    paper,
  };
  out.write(JSON.stringify(rec) + "\n");
  if (!isCovered) uncovered += 1;
  else if (!ev.repeat) counted.push(rec);
}
await new Promise((r) => out.end(r));

// ---- summary ----------------------------------------------------------------------------------------------------
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const n = counted.length;
const withAny = counted.filter((e) => e.matchesBefore + e.matchesAfter > 0);
const withAfter = counted.filter((e) => e.matchesAfter > 0);
const nonGeneric = withAfter.filter((e) => !e.generic);
const bestFill = (e) => Math.max(...e.after.map((m) => m.maxFill ?? 0));
const firstSecs = withAfter.map((e) => e.firstAfterSec).sort((a, b) => a - b);
console.log("");
console.log(`=== keyword events (covered by the census, repeats counted once): n = ${n}  (not covered: ${uncovered})`);
console.log(`  with >= 1 match (before or after the post): ${withAny.length} (${pct(withAny.length, n)})`);
console.log(`  with >= 1 match created AFTER the post (<= 30 min): ${withAfter.length} (${pct(withAfter.length, n)}); not generic: ${nonGeneric.length}; generic: ${withAfter.length - nonGeneric.length}`);
console.log(`  of those: any after-match migrated ${pct(withAfter.filter((e) => e.after.some((m) => m.migrated)).length, withAfter.length)} | best after-match reached fill 50: ${pct(withAfter.filter((e) => bestFill(e) >= 50).length, withAfter.length)}, 85: ${pct(withAfter.filter((e) => bestFill(e) >= 85).length, withAfter.length)}`);
console.log(`  post -> first matching create (s): p10 ${P.quantile(firstSecs, 0.1)} | median ${P.quantile(firstSecs, 0.5)} | p90 ${P.quantile(firstSecs, 0.9)}`);
console.log(`  after-matches per event: median ${P.quantile(withAfter.map((e) => e.matchesAfter).sort((a, b) => a - b), 0.5)}, max ${Math.max(0, ...withAfter.map((e) => e.matchesAfter))}`);
console.log("  BIAS: only tokens that reached fill 25 % have a name in the census (compact rows have none): the shares above are biased upward; no pick-rule conclusion (PROMPT N1).");
const byReason = {};
for (const e of withAfter) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
console.log(`  events with an after-match by keyword reason: ${JSON.stringify(byReason)}`);

const boot = (v) => bootstrapCI(v);
const line = (label, vals) => {
  const s = P.distSummary(vals, { bootstrap: boot });
  return `  ${label.padEnd(26)} n ${String(s.n).padStart(3)} | mean ${s.mean ?? "-"} | median ${s.median ?? "-"} | >0 ${s.posShare ?? "-"} | best ${s.best ?? "-"} | worst ${s.worst ?? "-"}${s.ci ? ` | ci95 [${s.ci.lo}, ${s.ci.hi}]` : ""}`;
};
console.log("");
console.log(`=== paper on census_path (curve impact + ${P.ELON_COSTS_SCHEME.split(":")[0]}, buy ${BUY_SOL} SOL; only matches with a path row, i.e. fill >= 25 — look-ahead)`);
for (const L of LAGS) {
  const first = withAfter.map((e) => e.paper[L].find((x) => x.entrySec !== null)).filter(Boolean);
  const all = withAfter.flatMap((e) => e.paper[L].filter((x) => x.entrySec !== null));
  console.log(` lag ${L} s: events with a priced first match ${first.length}, all priced matches ${all.length}`);
  for (const h of HORIZONS) console.log(line(`first, exit +${h / 60} min netPct`, first.map((x) => x.exits[h]?.netPct)));
  console.log(line("first, max mult (30 min)", first.map((x) => x.maxMult)));
  console.log(line("first, netPct at the max", first.map((x) => x.maxNetPct)));
  console.log(line("all, exit +5 min netPct", all.map((x) => x.exits[300]?.netPct)));
}
console.log("");
console.log(`n = ${n} keyword events${n < 200 ? " (< 200): no profitability verdict" : ""}. Rows: ${outFile}`);
