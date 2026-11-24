#!/usr/bin/env node
// elon-watch Part C (KODING #25): report of the elon-watch journal. READ ONLY.
//
//   node scripts/elon-report.mjs                    # every data/elon/YYYY-MM-DD.jsonl[.gz]
//   node scripts/elon-report.mjs file1.jsonl ...    # given journal files
//
// Unit of observation = keyword EVENT (post x keyword); repeat events (the same keyword within 24 h) are
// left out. One table per costsScheme (never mixed) and variant: n = events with a priced paper trade,
// netPct at each exit horizon (mean / median / share > 0 / best / worst, bootstrap ci only at n >= 30).
// basket3 = one result per basket (sum of the legs' netSol / sum of buySol). Also: the detection latency
// histogram, the stream lag, the "ceiling" (best matched token's max multiple after our detection, from
// the elon_path rows) and the 20 latest events with their top matches. n < 200 -> no profitability verdict.
const path = await import("node:path");
const { ROOT } = await import("../lib/config.mjs");
const { readElonRows } = await import("../lib/elon-journal.mjs");
const P = await import("../lib/elon-paper.mjs");
const { bootstrapCI } = await import("../lib/research.mjs");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DIR = process.env.ELON_DIR ? path.resolve(process.env.ELON_DIR) : path.join(ROOT, "data", "elon");
const { files, rows } = readElonRows(args.length ? args : DIR);
const BUY_SOL = Number(process.env.SHADOW_BUY_SOL || 0.02);
console.log(`[elon-report] ${files.length} file(s), ${rows.length} rows`);
if (!rows.length) process.exit(0);

const by = (t) => rows.filter((r) => r.type === t);
const kws = by("elon_kw").filter((r) => r.eventId);
const kwById = new Map(kws.map((k) => [k.eventId, k]));
const posts = by("elon_post");
const postById = new Map(posts.map((p) => [p.postId, p]));
const repeat = (id) => kwById.get(id)?.repeat === true;
const events = kws.filter((k) => !k.repeat);
const matches = by("elon_match");
const pathsRows = by("elon_path");
const paper = by("elon_paper").filter((r) => !repeat(r.eventId));
const fmt = (s) => `n ${String(s.n).padStart(3)} | mean ${s.mean ?? "-"} | median ${s.median ?? "-"} | >0 ${s.posShare ?? "-"} | best ${s.best ?? "-"} | worst ${s.worst ?? "-"}${s.ci ? ` | ci95 [${s.ci.lo}, ${s.ci.hi}]` : ""}`;
const boot = (v) => bootstrapCI(v);

console.log(`posts ${posts.length} | keyword events ${kws.length} (repeat ${kws.length - events.length}) | matches ${matches.length} (after-post ${matches.filter((m) => m.side === "after").length}) | paths ${pathsRows.length} | paper rows ${paper.length}`);
console.log(`events with >= 1 after-post match: ${new Set(matches.filter((m) => m.side === "after" && !repeat(m.eventId)).map((m) => m.eventId)).size} of ${events.length}`);

// ---- variants --------------------------------------------------------------------------------------------------
const schemes = [...new Set(paper.map((r) => r.costsScheme))];
for (const scheme of schemes) {
  const rs = paper.filter((r) => r.costsScheme === scheme);
  const horizons = [...new Set(rs.flatMap((r) => Object.keys(r.exits || {})))].map(Number).sort((a, b) => a - b);
  console.log("");
  console.log(`=== costsScheme: ${scheme}`);
  for (const v of ["first", "linked", "lead30", "lead60", "basket3"]) {
    const vr = rs.filter((r) => r.variant === v);
    if (!vr.length) continue;
    const skipped = vr.filter((r) => r.skip).length;
    const unfilled = vr.filter((r) => r.final === "unfilled").length;
    const shutdown = vr.filter((r) => r.final === "shutdown").length;
    console.log(` ${v}: rows ${vr.length} (skipped ${skipped}, unfilled ${unfilled}, shutdown ${shutdown})`);
    for (const h of horizons) {
      let vals;
      if (v === "basket3") {
        const g = new Map();
        for (const r of vr) {
          if (!r.basket || r.skip || !r.exits?.[h]) continue;
          const x = g.get(r.basket) || { net: 0, buy: 0, legs: 0, missing: 0 };
          x.net += r.exits[h].netSol;
          x.buy += r.buySol;
          x.legs += 1;
          g.set(r.basket, x);
        }
        vals = [...g.values()].map((x) => Math.round((x.net / x.buy) * 1e4) / 100);
      } else vals = vr.filter((r) => !r.skip && r.exits?.[h]).map((r) => r.exits[h].netPct);
      console.log(`   exit +${h / 60} min netPct: ${fmt(P.distSummary(vals, { bootstrap: boot }))}`);
    }
  }
}

// ---- latency ------------------------------------------------------------------------------------------------------------
const hist = (vals, edges, unit) => {
  const c = new Array(edges.length + 1).fill(0);
  for (const v of vals) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i += 1;
    c[i] += 1;
  }
  return c.map((n, i) => `${i === 0 ? `<${edges[0]}` : i === edges.length ? `>=${edges[i - 1]}` : `${edges[i - 1]}-${edges[i]}`}${unit}: ${n}`).join(" | ");
};
const live = posts.filter((p) => p.provider === "api" || p.provider === "stream");
const det = live.map((p) => p.detectLagMs / 1000).filter(Number.isFinite).sort((a, b) => a - b);
console.log("");
console.log(`detect latency (post -> seen, ${live.length} live posts; snowflake ms): p50 ${P.quantile(det, 0.5) ?? "-"} s, p90 ${P.quantile(det, 0.9) ?? "-"} s`);
if (det.length) console.log(`  ${hist(det, [1, 2, 3, 5, 10, 30], " s")}`);
const lagVals = [...matches, ...paper].map((r) => r.streamLagSec).filter(Number.isFinite).sort((a, b) => a - b);
console.log(`stream lag at match / paper decisions (local now - newest on-chain second): n ${lagVals.length}, p50 ${P.quantile(lagVals, 0.5) ?? "-"} s, p90 ${P.quantile(lagVals, 0.9) ?? "-"} s`);
const mem = by("elon_mem");
if (mem.length) {
  const last = mem[mem.length - 1];
  console.log(`last elon_mem: rss ${last.rssMB} MB, index ${last.indexSize}, watches ${last.watches}, stream lag p50 ${last.streamLag?.p50 ?? "-"} p90 ${last.streamLag?.p90 ?? "-"} s, ws reconnects ${last.wsReconnects}`);
}
const cost = by("elon_cost");
if (cost.length) {
  const days = new Map();
  for (const c of cost) days.set(c.day, c);
  console.log(`X spend (estimate): ${[...days.values()].map((c) => `${c.day} $${c.usd} (${c.postsBilled} posts, ${c.userReads} user reads)`).join(", ")}`);
}
const gaps = by("elon_gap");
if (gaps.length) console.log(`gaps: ${JSON.stringify(gaps.reduce((a, g) => ((a[g.source] = (a[g.source] || 0) + 1), a), {}))}`);

// ---- ceiling -----------------------------------------------------------------------------------------------------------------
// Best matched token per event: max multiple within 30 min after (post + detect lag + 1 s), on the elon_path.
const pathsByEvent = new Map();
for (const p of pathsRows) for (const id of p.events || []) (pathsByEvent.get(id) || pathsByEvent.set(id, []).get(id)).push(p);
const ceil = [];
for (const e of events) {
  const det0 = e.postSec + Math.ceil((e.detectLagMs ?? 0) / 1000) + 1;
  let bestRow = null;
  for (const p of pathsByEvent.get(e.eventId) || []) {
    const r = P.evalPathEntry(p, { entryFromSec: det0, buySol: BUY_SOL, horizons: [300, 900] });
    if (r.maxMult !== null && (!bestRow || r.maxMult > bestRow.maxMult)) bestRow = { ...r, mint: p.mint, name: p.name };
  }
  if (bestRow) ceil.push(bestRow);
}
console.log("");
console.log(`ceiling (best matched token per event, entry after our detection, max within 30 min; hindsight, NOT a strategy): events ${ceil.length}`);
console.log(`  max multiple: ${fmt(P.distSummary(ceil.map((c) => c.maxMult)))}`);
console.log(`  netPct at the max: ${fmt(P.distSummary(ceil.map((c) => c.maxNetPct)))}`);

// ---- latest events ----------------------------------------------------------------------------------------------------------------
console.log("");
console.log("20 latest keyword events:");
const latest = [...kws].sort((a, b) => b.postSec - a.postSec || (a.eventId < b.eventId ? -1 : 1)).slice(0, 20);
for (const e of latest) {
  const ms = matches.filter((m) => m.eventId === e.eventId);
  const ps = new Map((pathsByEvent.get(e.eventId) || []).map((p) => [p.mint, p]));
  const top = ms
    .map((m) => ({ m, p: ps.get(m.mint) }))
    .sort((a, b) => (b.p?.maxFill ?? 0) - (a.p?.maxFill ?? 0))
    .slice(0, 3)
    .map(({ m, p }) => `${m.symbol || m.name}(${m.kind},${m.side},dt ${m.dtSec}s,fill ${p?.maxFill ?? "-"}${p?.linked ? ",linked" : ""})`);
  const post = postById.get(e.postId);
  console.log(`  ${new Date(e.postSec * 1000).toISOString().slice(0, 19)} ${e.norm} [${e.reason}${e.repeat ? ",repeat" : ""}${e.generic ? ",generic" : ""}] "${String(post?.text ?? "").replace(/\s+/g, " ").slice(0, 50)}" -> ${ms.length} match(es) ${top.join(" ")}`);
}
const nEv = new Set(paper.filter((r) => !r.skip && r.netPct !== null).map((r) => r.eventId)).size;
console.log("");
console.log(`keyword events with a priced paper trade: ${nEv}${nEv < 200 ? " (< 200): no profitability verdict" : ""}`);
