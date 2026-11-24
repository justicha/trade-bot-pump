import "./lib/test-env.mjs";
// Census curve price path (KODING #24): lib/census-path.mjs through lib/mint-census.mjs on synthetic
// stream logs, the offline checker (scripts/census-path-check.mjs) and the real recorder process on
// the fixture socket with CENSUS_PATH on / off. No network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const C = await import("../lib/mint-census.mjs");
const P = await import("../lib/census-path.mjs");
const { createPayload, tradePayload } = await import("./mocks/ws-mock-shadow.mjs");
const W = await import("./mocks/ws-mock-census.mjs");
const S = await import("../lib/pumpswap-stream.mjs");
const { PublicKey } = await import("@solana/web3.js");
const PUMPSWAP_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const key = W.key;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};

const T0 = 1_794_000_000;
const REAL_100 = 85e9;
const DATA = (p) => `Program data: ${p.toString("base64")}`;
const priceAt = (fill) => Number(((30e9 + (fill / 100) * REAL_100) / 1_073_000_000_000_000 * 1e-3).toPrecision(6));
const onlyType = (rows, type) => rows.filter((r) => r.type === type);

function feeder(cfg = {}) {
  const census = C.createCensus({ startedAtMs: T0 * 1000, pathOn: true, ...cfg });
  return {
    census,
    create(mint, { creator = key(7000), user = creator, ts = T0, slot = 1 } = {}) {
      return C.handleLogs(census, [DATA(createPayload({ mint, creator, user, name: "Coin", symbol: "C", ts })), "Program x success"], { slot, nowMs: ts * 1000 + 400 });
    },
    trade(mint, fill, { user = key(999), isBuy = true, sol = 0.1, ts = T0, slot = 2, nowMs = ts * 1000 + 700 } = {}) {
      return C.handleLogs(census, [DATA(tradePayload({ mint, user, isBuy, realSol: (fill / 100) * REAL_100, solLamports: sol * 1e9, ts })), "Program x success"], { slot, nowMs });
    },
    // several events in one transaction (stream order inside one notification)
    tx(events, { ts = T0, slot = 3 } = {}) {
      const logs = events.map((e) => DATA(tradePayload({ mint: e.mint, user: e.user ?? key(999), isBuy: e.isBuy ?? true, realSol: (e.fill / 100) * REAL_100, solLamports: (e.sol ?? 0.1) * 1e9, ts: e.ts ?? ts })));
      return C.handleLogs(census, [...logs, "Program x success"], { slot, nowMs: ts * 1000 + 700 });
    },
  };
}
const pathOf = (rows, mint) => rows.find((r) => r.type === "census_path" && r.mint === mint);
const mintOf = (rows, mint) => rows.find((r) => r.type === "census_mint" && r.mint === mint);

// ---- 1. one second, several events -> one bucket -----------------------------------------------------
{
  const f = feeder();
  const m = key(2001);
  const [A, B, Cw] = [key(2101), key(2102), key(2103)];
  f.create(m, { ts: T0 });
  f.trade(m, 10, { ts: T0 + 1, user: A, sol: 0.5 });
  // second T0 + 2: buy A 20 -> buy B 34 -> sell C 26 -> buy B 30 (stream order); A and B known? A yes
  f.tx(
    [
      { mint: m, fill: 20, user: A, sol: 0.25 },
      { mint: m, fill: 34, user: B, sol: 1.2345678 },
      { mint: m, fill: 26, user: Cw, isBuy: false, sol: 0.3 },
      { mint: m, fill: 30, user: B, sol: 0.1 },
    ],
    { ts: T0 + 2 },
  );
  const rows = C.finishAll(f.census);
  const p = pathOf(rows, m);
  assert.ok(p, "a census_path row (fill 34 >= 25)");
  assert.deepEqual([p.type, p.censusRev, p.pathRev, p.t0, p.t0Source, p.createSeen, p.minFill], ["census_path", 3, 1, T0, "create", true, 25]);
  assert.deepEqual(p.t, [1, 2], "one bucket per second with trades (the create second has none)");
  assert.deepEqual([p.o, p.h, p.l, p.c], [[10, 20], [10, 34], [10, 20], [10, 30]], "o / h / l / c = first / max / min / last in stream order");
  assert.deepEqual([p.nb, p.ns, p.nw], [[1, 3], [0, 1], [1, 2]], "counts; new wallets: A in 1, B and C in 2");
  assert.deepEqual([p.bs, p.ss], [[0.5, 1.5846], [0, 0.3]], "SOL sums, 4 decimals");
  assert.deepEqual(p.pc, [priceAt(10), priceAt(30)], "pc = the last priced event of the second");
  assert.equal(p.thresholdSec, 2);
  assert.equal(p.buckets, 2);
  assert.deepEqual(p.holes, []);
  assert.deepEqual([p.final, p.migrated, p.completeSec, p.endT], ["shutdown", null, null, 2]);
  const keys = ["t", "o", "h", "l", "c", "pc", "nb", "ns", "bs", "ss", "nw"];
  for (const k of keys) assert.equal(p[k].length, p.buckets, `${k}: equal length`);
  ok("several events in one second -> one bucket: o/h/l/c in stream order, nb/ns, bs/ss (4 dp), nw, pc");
}

// ---- 2. threshold: below -> no row; reaching -> the pre-threshold buckets are in -----------------------
{
  const f = feeder({ idleSec: 600 });
  const low = key(2002);
  const high = key(2003);
  const other = key(2004);
  f.create(low, { ts: T0 });
  for (let i = 1; i <= 5; i++) f.trade(low, 3 * i, { ts: T0 + i }); // up to 15
  f.create(high, { ts: T0 });
  for (let i = 1; i <= 6; i++) f.trade(high, 5 * i, { ts: T0 + 10 * i }); // 5 .. 30
  assert.equal(f.census.paths.buffers, 2, "live mints keep a buffer from their first event");
  assert.equal(f.census.paths.buckets, 11);
  f.trade(other, 1, { ts: T0 + 800 });
  const idle = C.sweepIdle(f.census);
  assert.equal(onlyType(idle, "census_mint").length, 2);
  assert.equal(pathOf(idle, low), undefined, "never reached 25 -> no census_path row");
  const p = pathOf(idle, high);
  assert.deepEqual(p.t, [10, 20, 30, 40, 50, 60], "the buckets BEFORE the threshold are there");
  assert.equal(p.thresholdSec, 50, "the first bucket with h >= 25");
  assert.deepEqual([p.final, p.migrated], ["idle", false]);
  assert.equal(p.endT, 800, "covered until the idle finish (stream clock)");
  assert.equal(idle.indexOf(mintOf(idle, high)) + 1, idle.indexOf(p), "the path row follows its census_mint row");
  assert.equal(f.census.paths.buffers, 1, "both buffers dropped (only `other` is live)");
  assert.equal(f.census.paths.counts.pathDropped, 1);
  const mem = C.memRow(f.census, (T0 + 801) * 1000);
  assert.deepEqual([mem.pathMints, mem.pathBuckets, mem.pathRows], [1, 1, 1]);
  assert.equal(mem.pathBytes, JSON.stringify(p).length + 1);
  // CENSUS_PATH_MIN_FILL = 10: the low mint writes too
  const g = feeder({ pathMinFill: 10 });
  g.create(low, { ts: T0 });
  for (let i = 1; i <= 5; i++) g.trade(low, 3 * i, { ts: T0 + i });
  const q = pathOf(C.finishAll(g.census), low);
  assert.deepEqual([q.minFill, q.thresholdSec], [10, 4]);
  ok("threshold: below -> no row, buffer dropped; reaching -> row with pre-threshold buckets, after its census_mint row; census_mem path fields");
}

// ---- 3. milestone consistency with census_mint snapshots ---------------------------------------------
{
  const f = feeder();
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const mints = [];
  for (let k = 0; k < 40; k++) {
    const m = key(2300 + k);
    mints.push(m);
    const seen = k % 4 !== 0; // every 4th: create not seen
    if (seen) f.create(m, { ts: T0 + k });
    let fill = seen ? 0 : 5 + rnd() * 40;
    let ts = T0 + k + 1;
    for (let i = 0; i < 80; i++) {
      fill = Math.max(0, Math.min(99.5, fill + (rnd() - 0.42) * 14));
      // bursts: several events in one second, sometimes with a jump over two milestones
      const n = 1 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) f.trade(m, Math.max(0, Math.min(99.5, fill + (rnd() - 0.5) * 6)), { ts, user: key(2500 + Math.floor(rnd() * 30)), isBuy: rnd() < 0.6 });
      ts += 1 + Math.floor(rnd() * 4);
    }
  }
  const rows = C.finishAll(f.census);
  let checked = 0;
  let paths = 0;
  for (const m of mints) {
    const p = pathOf(rows, m);
    const r = mintOf(rows, m);
    if (!p) {
      assert.ok(!(r.maxFill >= 25), `no path only below the threshold (${r.maxFill})`);
      continue;
    }
    paths += 1;
    const c = P.checkMilestones(p, r);
    assert.deepEqual(c.mismatches, [], `mint ${m}: ${JSON.stringify(c.mismatches)}`);
    checked += c.checked;
    // and the converse for the threshold itself
    if (r.milestones?.["25"]) assert.equal(p.t0 + p.thresholdSec, r.milestones["25"].sec);
  }
  assert.ok(paths >= 25 && checked >= 60, `enough coverage: ${paths} paths, ${checked} milestones checked`);
  // the checker catches a wrong path
  const p = rows.find((x) => x.type === "census_path" && Object.keys(mintOf(rows, x.mint).milestones || {}).length >= 2);
  const bad = { ...p, h: p.h.map((x) => (x !== null && x >= 25 ? 24 : x)) };
  assert.ok(P.checkMilestones(bad, mintOf(rows, p.mint)).mismatches.length >= 1, "a path that never shows the crossing is a mismatch");
  ok(`milestone consistency: ${paths} paths, ${checked} milestones; the first bucket with h >= m is at milestone.sec for every m; checker catches a wrong path`);
}

// ---- 4. MAX_SEC cut and MAX_BUCKETS truncation ----------------------------------------------------------
{
  const f = feeder({ pathMaxSec: 100 });
  const m = key(2010);
  f.create(m, { ts: T0 });
  f.trade(m, 10, { ts: T0 + 5 });
  f.trade(m, 30, { ts: T0 + 20 }); // threshold second T0 + 20
  f.trade(m, 40, { ts: T0 + 120 }); // = threshold + 100: kept
  f.trade(m, 50, { ts: T0 + 121 }); // cut
  f.trade(m, 60, { ts: T0 + 300 });
  const [r, p] = C.finishAll(f.census);
  assert.equal(r.type, "census_mint");
  assert.deepEqual(p.t, [5, 20, 120]);
  assert.equal(p.cut, "maxSec");
  assert.equal(p.endT, 120, "the covered window ends at the cut");
  assert.equal(r.maxFill, 60, "census_mint is not affected by the cut");
  assert.equal(f.census.paths.counts.pathCut, 1);

  const g = feeder({ pathMaxBuckets: 3 });
  const n = key(2011);
  g.create(n, { ts: T0 });
  for (let i = 1; i <= 6; i++) g.trade(n, 8 * i, { ts: T0 + i });
  const [, q] = C.finishAll(g.census);
  assert.deepEqual([q.t, q.h, q.truncated, q.buckets], [[1, 2, 3], [8, 16, 24], true, 3]);
  assert.equal(q.thresholdSec, null, "the threshold came after the cap: the row is written (the mint reached 25), no bucket shows it");
  assert.equal(g.census.paths.counts.pathTruncated, 1);
  // the cut counts from the threshold second even when that second was not bucketed
  const k = feeder({ pathMaxBuckets: 2, pathMaxSec: 10 });
  const z = key(2012);
  k.trade(z, 5, { ts: T0 });
  k.trade(z, 6, { ts: T0 + 1 });
  k.trade(z, 30, { ts: T0 + 2 }); // not bucketed (cap), threshold second T0 + 2
  k.trade(z, 31, { ts: T0 + 13 }); // > T0 + 2 + 10: cut
  const [, zq] = C.finishAll(k.census);
  assert.deepEqual([zq.t, zq.truncated, zq.cut, zq.endT], [[0, 1], true, "maxSec", 12]);
  ok("MAX_SEC: events after threshold + maxSec are not bucketed (cut: maxSec, endT at the cut); MAX_BUCKETS keeps the first buckets (truncated)");
}

// ---- 5. holes: gaps and stalls ----------------------------------------------------------------------------
{
  const f = feeder();
  const m = key(2020);
  const x = key(2021);
  f.create(m, { ts: T0 });
  f.trade(m, 30, { ts: T0 + 10 });
  // a gap: silence from T0 + 10 (local + 0.7 s), detected at 10 s, closed by an event at T0 + 50
  assert.equal(C.checkGap(f.census, (T0 + 21) * 1000, 10), true);
  const closing = f.trade(x, 2, { ts: T0 + 50 });
  assert.equal(onlyType(closing, "census_gap").length, 1);
  f.trade(m, 35, { ts: T0 + 60 });
  // a stall: the timer saw the stream at T0 + 60, then did not run for 45 s
  C.checkGap(f.census, (T0 + 61) * 1000, 10);
  f.trade(m, 36, { ts: T0 + 61 }); // processed after the tick: the stall still starts at the tick's clock
  C.noteStall(f.census, 45_000, (T0 + 106) * 1000);
  f.trade(m, 40, { ts: T0 + 107 });
  const rows = C.finishAll(f.census);
  const p = pathOf(rows, m);
  assert.deepEqual(p.holes, [[10, 50, "gap"], [60, 106, "stall"]], "gap: last second before the silence -> the closing event's second; stall: the tick's clock -> + 45 + 1");
  assert.deepEqual(p.t, [10, 60, 61, 107]);
  // a hole outside the path is not listed; an open gap at the stop ends at from + silence
  const g = feeder();
  const early = key(2022);
  const late = key(2023);
  g.trade(early, 2, { ts: T0 });
  C.checkGap(g.census, (T0 + 15) * 1000, 10);
  g.trade(early, 3, { ts: T0 + 30 }); // closes [0, 30]
  g.trade(late, 40, { ts: T0 + 200 });
  C.checkGap(g.census, (T0 + 215) * 1000, 10);
  const gr = C.closeGapAtStop(g.census, (T0 + 230) * 1000 + 700);
  assert.equal(gr.openAtStop, true);
  const rows2 = C.finishAll(g.census);
  const q = pathOf(rows2, late);
  assert.deepEqual([q.t0Source, q.t0, q.t], ["first", T0 + 200, [0]]);
  assert.deepEqual(q.holes, [[0, 30, "gap"]], "the earlier gap ended before the path started: not listed; the open one: from + 30 s");
  // a pool stream that keeps running through the pump-stream gap does not move the hole (pump clock only)
  const k = feeder();
  const mig = key(2024);
  const live = key(2025);
  k.create(mig, { ts: T0 });
  k.trade(mig, 100, { ts: T0 + 1 }); // completes: its pool is watched
  k.trade(live, 30, { ts: T0 + 2 });
  const pool = S.canonicalPool(new PublicKey(mig)).toBase58();
  const sim = W.poolSim(W.MIG_POOL_START);
  for (const ts of [T0 + 5, T0 + 12, T0 + 18]) {
    const payload = W.pumpSwapPayload(sim.trade({ side: "buy", sol: 0.5, pool, user: key(2026), ts }));
    C.handlePoolLogs(k.census, [`Program ${PUMPSWAP_ID} invoke [1]`, DATA(payload), `Program ${PUMPSWAP_ID} success`], { signature: `p${ts}`, nowMs: ts * 1000 + 500, pool });
    if (ts === T0 + 12) assert.equal(C.checkGap(k.census, (T0 + 12) * 1000 + 800, 10), true, "the pump stream is silent since T0 + 2");
  }
  assert.ok(k.census.streamSec === T0 + 18 && k.census.pumpSec === T0 + 2, "pool events move the stream clock, not the pump clock");
  k.trade(live, 31, { ts: T0 + 25 });
  const kp = pathOf(C.finishAll(k.census), live);
  assert.deepEqual([kp.t0, kp.holes], [T0 + 2, [[0, 23, "gap"]]], "the hole starts at the last pump event's second (T0 + 2), not the pool's T0 + 12");
  ok("holes: gap [last pump second before the silence, closing event's second] (pool events do not move it), stall [tick clock, + length + 1], open-at-stop gap, holes outside the path not listed");
}

// ---- 6. resumed mint, shutdown partial, completion ------------------------------------------------------
{
  const f = feeder({ idleSec: 600 });
  const m = key(2030);
  const other = key(2031);
  f.create(m, { ts: T0 });
  f.trade(m, 30, { ts: T0 + 5 });
  f.trade(m, 20, { ts: T0 + 6, isBuy: false });
  f.trade(other, 1, { ts: T0 + 700 });
  const idle = C.sweepIdle(f.census);
  const p1 = pathOf(idle, m);
  assert.deepEqual([p1.t, p1.final, p1.resumed], [[5, 6], "idle", undefined]);
  // resumes below the threshold: still written (the mint reached it before), only the resumed part
  f.trade(m, 18, { ts: T0 + 900, user: key(999) });
  f.trade(m, 22, { ts: T0 + 905, user: key(2032) });
  const rows = C.finishAll(f.census);
  const p2 = pathOf(rows, m);
  assert.deepEqual([p2.resumed, p2.thresholdBefore, p2.thresholdSec, p2.t, p2.final, p2.partial], [true, true, null, [900, 905], "shutdown", undefined]);
  assert.deepEqual(p2.nw, [1, 1], "new wallets count again in the resumed part (its wallet map starts empty)");
  assert.equal(p2.t0, T0, "same t scale as the first part");
  assert.equal(mintOf(rows, m).resumed, true);
  // a resumed part of a mint that never reached the threshold: nothing
  const g = feeder({ idleSec: 600 });
  const n = key(2033);
  g.trade(n, 3, { ts: T0 });
  g.trade(other, 1, { ts: T0 + 700 });
  C.sweepIdle(g.census);
  g.trade(n, 4, { ts: T0 + 800 });
  assert.equal(pathOf(C.finishAll(g.census), n), undefined);
  // completion: final complete, migrated, completeSec offset; one row each
  const h = feeder();
  const c = key(2034);
  h.create(c, { ts: T0 });
  h.trade(c, 50, { ts: T0 + 3 });
  const done = h.trade(c, 100, { ts: T0 + 9 });
  assert.deepEqual(done.map((r) => r.type), ["census_mint", "census_path"]);
  const pc = done[1];
  assert.deepEqual([pc.final, pc.migrated, pc.completeSec, pc.endT, pc.t, pc.h], ["complete", true, 9, 9, [3, 9], [50, 100]]);
  assert.equal(h.trade(c, 99, { ts: T0 + 10 }).length, 0, "after the completion: no new buffer");
  assert.equal(h.census.paths.buffers, 0);
  ok("resumed: second row, resumed part only, thresholdBefore; never reached -> none; completion: complete / migrated / completeSec offset, no buffer after it");
}

// ---- 7. mayhem / other-quote flags, token-side fill, out-of-order seconds -----------------------------
{
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const f = feeder();
  const feedRaw = (p, ts) => C.handleLogs(f.census, [DATA(p), "Program x success"], { slot: 5, nowMs: ts * 1000 + 300 });
  const ct = (o) => W.curveTradePayload({ user: key(2601), ...o });
  const may = key(2040);
  const usd = key(2041);
  for (const [i, fill] of [10, 30, 60].entries()) feedRaw(ct({ mint: may, ts: T0 + i, vTok: W.vTokAtFill(fill), mayhem: true, sol: { vSol: 1_000_000_000n, realSol: 100_000_000n } }), T0 + i);
  for (const [i, fill] of [20, 40].entries()) feedRaw(ct({ mint: usd, ts: T0 + i, vTok: W.vTokAtFill(fill), quoteMint: USDC }), T0 + i);
  const rows = C.finishAll(f.census);
  const pm = pathOf(rows, may);
  assert.equal(pm.mayhem, true);
  assert.ok(!("quoteMint" in pm));
  assert.deepEqual(pm.h, [10, 30, 60], "mayhem: the token-side fill (as census_mint)");
  assert.ok(pm.pc.every((x) => x > 0), "the SOL price where the event has a SOL snapshot");
  assert.deepEqual(P.checkMilestones(pm, mintOf(rows, may)).mismatches, []);
  const pu = pathOf(rows, usd);
  assert.deepEqual([pu.mayhem, pu.quoteMint, pu.h, pu.pc], [false, USDC, [20, 40], [null, null]], "other quote: token-side fill, no SOL price");

  const g = feeder();
  const o = key(2042);
  g.create(o, { ts: T0 });
  g.trade(o, 10, { ts: T0 + 1 });
  g.trade(o, 20, { ts: T0 + 5 });
  g.trade(o, 30, { ts: T0 + 3 }); // an older second arrives late
  g.trade(o, 12, { ts: T0 + 1 });
  const p = pathOf(C.finishAll(g.census), o);
  assert.deepEqual([p.t, p.o, p.h, p.l, p.c, p.nb], [[1, 3, 5], [10, 30, 20], [12, 30, 20], [10, 30, 20], [12, 30, 20], [2, 1, 1]]);
  assert.deepEqual([p.outOfOrder, p.thresholdSec], [2, 3], "the late second lands in place; the threshold is the earliest bucket with h >= 25");
  // a badFill event (fill > 200 %: not a curve state) counts as a trade without a fill, as in census_mint
  const h = feeder();
  const bf = key(2043);
  h.trade(bf, 30, { ts: T0 });
  h.trade(bf, 5000, { ts: T0 + 1, isBuy: false, sol: 0.2 });
  const [mr, pb] = C.finishAll(h.census);
  assert.equal(mr.maxFill, 30);
  assert.deepEqual([pb.t, pb.h, pb.pc, pb.ns, pb.ss], [[0, 1], [30, null], [priceAt(30), null], [0, 1], [0, 0.2]]);
  ok("mayhem / other-quote flags and token-side fill; out-of-order seconds go into their own bucket (outOfOrder counted)");
}

// ---- 8. CENSUS_PATH=0: the other rows are identical ---------------------------------------------------
{
  const feed = (pathOn) => {
    const f = feeder({ pathOn, idleSec: 600 });
    const out = [];
    const push = (rows) => out.push(...rows);
    const a = key(2050);
    const b = key(2051);
    const c = key(2052);
    push(f.create(a, { ts: T0 }));
    push(f.create(b, { ts: T0 }));
    for (let i = 1; i <= 20; i++) {
      push(f.trade(a, 5 * i, { ts: T0 + i, user: key(2060 + (i % 5)), isBuy: i % 3 !== 0 }));
      push(f.trade(b, Math.min(40, 4 * i), { ts: T0 + i }));
    }
    push(f.trade(c, 3, { ts: T0 + 30 }));
    C.checkGap(f.census, (T0 + 45) * 1000, 10);
    push(f.trade(c, 30, { ts: T0 + 60 }));
    C.noteStall(f.census, 40_000, (T0 + 100) * 1000);
    push(f.trade(b, 26, { ts: T0 + 101 }));
    push(f.trade(c, 1, { ts: T0 + 800 }));
    push(C.sweepIdle(f.census));
    push(C.sweepPoolWatch(f.census));
    push(C.finishAll(f.census));
    push(C.finishPoolsAtStop(f.census));
    const mem = C.memRow(f.census, (T0 + 900) * 1000);
    return { out, mem };
  };
  const on = feed(true);
  const off = feed(false);
  const strip = (rows) => rows.filter((r) => r.type !== "census_path").map((r) => JSON.stringify(r));
  assert.ok(onlyType(on.out, "census_path").length >= 2, "path rows with CENSUS_PATH on");
  assert.equal(onlyType(off.out, "census_path").length, 0);
  assert.ok(onlyType(on.out, "census_pool").length === 1 && onlyType(on.out, "census_gap").length === 1);
  assert.deepEqual(strip(on.out), strip(off.out), "census_mint / census_pool / census_gap rows identical");
  const noVolatile = (m) => {
    const { rssMB, heapMB, ...rest } = m;
    return rest;
  };
  const memOn = noVolatile(on.mem);
  for (const k of Object.keys(memOn)) if (k.startsWith("path")) delete memOn[k];
  assert.deepEqual(memOn, noVolatile(off.mem), "census_mem: the path* fields only");
  assert.ok(!Object.keys(off.mem).some((k) => k.startsWith("path")), "no path* field with CENSUS_PATH=0");
  // env
  const d = C.parseCensusEnv({});
  assert.deepEqual([d.pathOn, d.pathMinFill, d.pathMaxSec, d.pathMaxBuckets], [true, 25, 3600, 4000], "defaults: on, 25, 3600, 4000");
  const e = C.parseCensusEnv({ CENSUS_PATH: "0", CENSUS_PATH_MIN_FILL: "50", CENSUS_PATH_MAX_SEC: "900", CENSUS_PATH_MAX_BUCKETS: "100" });
  assert.deepEqual([e.pathOn, e.pathMinFill, e.pathMaxSec, e.pathMaxBuckets], [false, 50, 900, 100]);
  for (const [k, v] of [["CENSUS_PATH", "2"], ["CENSUS_PATH_MIN_FILL", "0"], ["CENSUS_PATH_MIN_FILL", "101"], ["CENSUS_PATH_MIN_FILL", "x"], ["CENSUS_PATH_MAX_SEC", "0"], ["CENSUS_PATH_MAX_SEC", "1.5"], ["CENSUS_PATH_MAX_BUCKETS", "0"]]) {
    assert.throws(() => C.parseCensusEnv({ [k]: v }), new RegExp(k), `${k}=${v} rejected`);
  }
  ok("CENSUS_PATH=0: census_mint / census_pool / census_gap rows byte-identical, census_mem differs only by path*; env defaults and validation");
}

// ---- 9. the offline checker ------------------------------------------------------------------------------
{
  const f = feeder();
  const m = key(2070);
  f.create(m, { ts: T0 });
  f.trade(m, 30, { ts: T0 + 2 });
  f.trade(m, 60, { ts: T0 + 4 });
  const rows = C.finishAll(f.census);
  const dir = tmp("census-path-check-");
  const file = path.join(dir, "census-x.jsonl");
  const lines = [...rows, { type: "census_mem", rssMB: 100, pathMints: 0, pathBuckets: 0, pathRows: 1, pathBytes: 10, upSec: 3600 }].map((r) => JSON.stringify({ ts: "2026-11-23T00:00:00.000Z", ...r })).join("\n") + "\n";
  fs.writeFileSync(file, lines);
  fs.writeFileSync(file + ".gz", zlib.gzipSync(lines));
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(here, "census-path-check.mjs"), ...args], { cwd: root, env: cleanEnv({}) });
      let out = "";
      child.stdout.on("data", (b) => (out += String(b)));
      child.stderr.on("data", (b) => (out += String(b)));
      child.on("exit", (code) => resolve({ code, out }));
    });
  const a = await run([file]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /census_path rows 1 \(mints 1\)/);
  assert.match(a.out, /milestones checked 2, mismatches 0/);
  const b = await run([file + ".gz"]);
  assert.equal(b.code, 0, b.out);
  assert.match(b.out, /mismatches 0/);
  fs.rmSync(dir, { recursive: true, force: true });
  ok("scripts/census-path-check.mjs: reads .jsonl and .jsonl.gz, counts rows, milestone check");
}

// ---- 10. the process: CENSUS_PATH default on / 0 on the fixture socket ------------------------------------
{
  let connections = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end();
  });
  server.on("connection", () => (connections += 1));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const run = async (extra) => {
    const dir = tmp("census-path-run-");
    const env = cleanEnv({ RPC_URL: `http://127.0.0.1:${port}`, WS_MOCK: path.join(here, "mocks", "ws-mock-census.mjs"), CENSUS_DIR: dir, CENSUS_MAX_SEC: "3", ...extra });
    const child = spawn(process.execPath, [path.join(here, "mint-census.mjs")], { cwd: root, env });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const code = await new Promise((resolve) => {
      const killer = setTimeout(() => child.kill(), 30_000);
      child.on("exit", (c) => {
        clearTimeout(killer);
        resolve(c);
      });
    });
    const rows = fs
      .readdirSync(dir)
      .filter((x) => x.endsWith(".jsonl"))
      .flatMap((x) => fs.readFileSync(path.join(dir, x), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 0, out);
    assert.ok(!/TypeError|ReferenceError|RangeError|handler error/.test(out), out);
    return { out, rows };
  };
  const on = await run({});
  const off = await run({ CENSUS_PATH: "0" });
  assert.match(on.out, /paths: fill >= 25, 3600s after it, <= 4000 s\/mint/);
  assert.match(off.out, /paths: off \(CENSUS_PATH=0\)/);
  const pRows = onlyType(on.rows, "census_path");
  assert.ok(pRows.length >= 2, `path rows in the fixture run: ${pRows.length}`);
  for (const p of pRows) {
    const r = mintOf(on.rows, p.mint);
    assert.deepEqual(P.checkMilestones(p, r).mismatches, []);
    assert.equal(p.final, r.final);
  }
  assert.equal(onlyType(off.rows, "census_path").length, 0);
  // two real-time runs: the clock fields differ (the mock stamps events with the current second), the
  // rest must not (the byte-identical check on a fixed clock is section 8)
  const noClock = (v) => (Array.isArray(v) ? v.map(noClock) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !/sec|lag|hour|^ts$/i.test(k)).map(([k, x]) => [k, noClock(x)])) : v);
  const norm = (rows) => rows.filter((r) => r.type === "census_mint").map((r) => JSON.stringify(noClock(r))).sort();
  assert.deepEqual(norm(on.rows), norm(off.rows), "the process writes the same census_mint rows with CENSUS_PATH=0 (clock fields aside)");
  const memOn = onlyType(on.rows, "census_mem").at(-1);
  assert.equal(memOn.pathRows, pRows.length);
  assert.ok(memOn.pathMints === 0 && memOn.pathBuckets === 0, "all buffers dropped at the stop");
  assert.ok(!("pathRows" in onlyType(off.rows, "census_mem").at(-1)));
  const bad = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "mint-census.mjs")], { cwd: root, env: cleanEnv({ RPC_URL: `http://127.0.0.1:${port}`, WS_MOCK: path.join(here, "mocks", "ws-mock-census.mjs"), CENSUS_DIR: tmp("census-path-bad-"), CENSUS_PATH_MIN_FILL: "0" }) });
    let out = "";
    child.stderr.on("data", (b) => (out += String(b)));
    child.on("exit", (code) => resolve({ code, out }));
  });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /CENSUS_PATH_MIN_FILL/);
  assert.equal(connections, 0, "the fixture RPC saw no request");
  server.close();
  ok("process: default on writes census_path rows consistent with census_mint; CENSUS_PATH=0 same census_mint rows, no path rows / fields; bad env -> exit 1");
}

console.log(`census-path: ${passed} checks passed`);
