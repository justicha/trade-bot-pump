#!/usr/bin/env node
// census_path checker (KODING #24): reads census files (.jsonl or .jsonl.gz), read-only, no network.
//
//   node scripts/census-path-check.mjs data/census/census-2026-11-23.jsonl [more files...]
//
// Prints: census_path rows (by final, resumed / cut / truncated / outOfOrder / with holes), buckets
// p50 / p90 / max, the milestone consistency check of EVERY path row against the census_mint row of
// the same mint and part (lib/census-path.mjs checkMilestones; mismatches listed), the bytes of the
// census_path lines (plain and gzip -9) and per hour of the census_mem upSec, and the census_mem
// rssMB / path* fields (first, max, last).
import fs from "node:fs";
import zlib from "node:zlib";
import { checkMilestones } from "../lib/census-path.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/census-path-check.mjs <census .jsonl | .jsonl.gz> ...");
  process.exit(1);
}

const lines = [];
for (const f of files) {
  let buf = fs.readFileSync(f);
  if (f.endsWith(".gz")) buf = zlib.gunzipSync(buf);
  for (const l of buf.toString("utf8").split("\n")) if (l.trim()) lines.push(l);
}

const paths = [];
const pathLines = [];
const mints = new Map(); // mint -> [census_mint rows in order]
const mem = [];
let bad = 0;
for (const l of lines) {
  let r;
  try {
    r = JSON.parse(l);
  } catch {
    bad += 1;
    continue;
  }
  if (r.type === "census_path") {
    paths.push(r);
    pathLines.push(l);
  } else if (r.type === "census_mint") {
    if (!mints.has(r.mint)) mints.set(r.mint, []);
    mints.get(r.mint).push(r);
  } else if (r.type === "census_mem") mem.push(r);
}

// The census_mint row of the same part: the one with the same `final` and resumed flag, nearest before.
// Rows come out in the order census_mint, census_path; match by index of parts.
const used = new Map();
function partner(p) {
  const list = mints.get(p.mint) || [];
  const k = used.get(p.mint) || 0;
  for (let i = k; i < list.length; i++) {
    if (list[i].final === p.final && !!list[i].resumed === !!p.resumed) {
      used.set(p.mint, i + 1);
      return list[i];
    }
  }
  return null;
}

const q = (arr, x) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(x * s.length))];
};
const count = (f) => paths.filter(f).length;
const byFinal = {};
for (const p of paths) byFinal[p.final] = (byFinal[p.final] || 0) + 1;
let checked = 0;
let skipped = 0;
let noPartner = 0;
const mismatches = [];
for (const p of paths) {
  const r = partner(p);
  if (!r) {
    noPartner += 1;
    continue;
  }
  const c = checkMilestones(p, r);
  checked += c.checked;
  skipped += c.skipped;
  for (const m of c.mismatches) mismatches.push({ mint: p.mint, ...m });
}
const plain = pathLines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
const gz = pathLines.length ? zlib.gzipSync(pathLines.join("\n") + "\n", { level: 9 }).length : 0;
const allPlain = lines.reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);
const allGz = zlib.gzipSync(lines.join("\n") + "\n", { level: 9 }).length;
const upSec = mem.length ? Math.max(...mem.map((m) => m.upSec || 0)) : 0;
const perH = (x) => (upSec > 0 ? (x / (upSec / 3600)).toFixed(0) : "n/a");
const mb = (x) => (x / 1048576).toFixed(2);
const buckets = paths.map((p) => p.buckets ?? p.t.length);

console.log(`files ${files.length}, lines ${lines.length}${bad ? `, unparsable ${bad}` : ""}, run ${upSec ? (upSec / 3600).toFixed(2) : "?"} h (census_mem upSec)`);
console.log(`census_path rows ${paths.length} (mints ${new Set(paths.map((p) => p.mint)).size}) | final ${JSON.stringify(byFinal)} | resumed ${count((p) => p.resumed)}, thresholdBefore ${count((p) => p.thresholdBefore)}, cut ${count((p) => p.cut)}, truncated ${count((p) => p.truncated)}, outOfOrder ${count((p) => p.outOfOrder)}, with holes ${count((p) => p.holes?.length)}, mayhem ${count((p) => p.mayhem === true)}, quoteMint ${count((p) => p.quoteMint)}`);
console.log(`buckets per row p50 ${q(buckets, 0.5)}, p90 ${q(buckets, 0.9)}, max ${buckets.length ? Math.max(...buckets) : null}, total ${buckets.reduce((s, x) => s + x, 0)}`);
console.log(`milestones checked ${checked}, mismatches ${mismatches.length} (skipped ${skipped}: outside the path part; path rows without a census_mint partner ${noPartner})`);
for (const m of mismatches.slice(0, 50)) console.log(`  mismatch ${m.mint} m${m.m}: milestone.sec ${m.milestoneSec}, first bucket with h >= m ${m.bucketSec}`);
console.log(`size census_path: ${mb(plain)} MB plain, ${mb(gz)} MB gzip -9 | per hour ${perH(plain)} B plain, ${perH(gz)} B gz | rows/h ${perH(paths.length)}`);
// Per-day estimate from the bucket rate: in a run the stop flushes every live buffer, so the buckets of
// the run's census_path rows ~ the buckets recorded per hour of stream (pre-threshold buckets of mints
// that cross after the stop are missing: a slight undercount).
const totalBuckets = buckets.reduce((s, x) => s + x, 0);
if (upSec > 0 && totalBuckets > 0) {
  const bph = totalBuckets / (upSec / 3600);
  console.log(`estimate per day: ${(bph * 24).toFixed(0)} buckets x ${(plain / totalBuckets).toFixed(1)} B plain (${(gz / totalBuckets).toFixed(1)} B gz) = ${mb(bph * 24 * (plain / totalBuckets))} MB plain, ${mb(bph * 24 * (gz / totalBuckets))} MB gz; rows/day ${(paths.length / (upSec / 86400)).toFixed(0)}`);
}
console.log(`size whole file(s): ${mb(allPlain)} MB plain, ${mb(allGz)} MB gzip -9 | per hour ${perH(allPlain)} B plain, ${perH(allGz)} B gz`);
if (mem.length) {
  const pick = (m) => ({ upSec: m.upSec, rssMB: m.rssMB, heapMB: m.heapMB, liveMints: m.liveMints, pathMints: m.pathMints, pathBuckets: m.pathBuckets, pathRows: m.pathRows, pathBytes: m.pathBytes });
  const maxRss = mem.reduce((a, m) => (m.rssMB > a.rssMB ? m : a), mem[0]);
  console.log(`census_mem first ${JSON.stringify(pick(mem[0]))}`);
  console.log(`census_mem max rss ${JSON.stringify(pick(maxRss))}`);
  console.log(`census_mem last ${JSON.stringify(pick(mem[mem.length - 1]))}`);
}
