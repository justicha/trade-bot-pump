import "./lib/test-env.mjs";
// Mint census (KODING #19): lib/mint-census.mjs logic on synthetic stream logs, and the real
// scripts/mint-census.mjs process on a fixture socket with a fixture HTTP "RPC" that must see zero
// requests. No network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const C = await import("../lib/mint-census.mjs");
const { createPayload, tradePayload } = await import("./mocks/ws-mock-shadow.mjs");
const W = await import("./mocks/ws-mock-census.mjs");
const key = W.key;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};

// ---- synthetic stream helpers ---------------------------------------------------------------------
const T0 = 1_794_000_000; // on-chain seconds (2026-11)
const REAL_100 = 85e9;
const DATA = (p) => `Program data: ${p.toString("base64")}`;
const priceAt = (fill) => Number(((30e9 + (fill / 100) * REAL_100) / 1_073_000_000_000_000 * 1e-3).toPrecision(6));

function feeder(cfg = {}) {
  const census = C.createCensus({ startedAtMs: T0 * 1000, ...cfg });
  return {
    census,
    create(mint, { creator, user = creator, name = "Coin", ts = T0, slot = 1 } = {}) {
      return C.handleLogs(census, [DATA(createPayload({ mint, creator, user, name, symbol: "C", ts })), "Program x success"], { slot, nowMs: ts * 1000 + 400 });
    },
    trade(mint, fill, { user = key(999), isBuy = true, sol = 0.1, ts = T0, slot = 2 } = {}) {
      return C.handleLogs(census, [DATA(tradePayload({ mint, user, isBuy, realSol: (fill / 100) * REAL_100, solLamports: sol * 1e9, ts })), "Program x success"], { slot, nowMs: ts * 1000 + 700 });
    },
  };
}

// ---- 1. milestone crossing ------------------------------------------------------------------------
{
  const f = feeder();
  const m = key(1001);
  f.create(m, { creator: key(1), ts: T0 });
  f.trade(m, 20, { ts: T0 + 5 });
  f.trade(m, 60, { ts: T0 + 9 });
  const rec = f.census.live.get(m);
  assert.deepEqual(Object.keys(rec.milestones), ["25", "50"], "a jump 20 -> 60 records 25 and 50");
  assert.equal(rec.milestones["25"].sec, T0 + 9);
  assert.equal(rec.milestones["50"].sec, T0 + 9);
  assert.equal(rec.milestones["25"].fill, 60);
  assert.equal(rec.milestones["25"].secFromCreate, 9);
  f.trade(m, 22, { ts: T0 + 12 });
  f.trade(m, 61, { ts: T0 + 15 });
  assert.equal(f.census.live.get(m).milestones["25"].sec, T0 + 9, "each milestone recorded once (not on the second crossing)");
  assert.equal(f.census.live.get(m).milestones["50"].sec, T0 + 9);
  // the snapshot carries the rev-7 feat names
  const feat = rec.milestones["50"].feat;
  for (const k of ["buySol60", "sellSol60", "buys60", "sells60", "maxSell60Sol", "topWalletVolShare", "top5NetShare", "creatorBuySol", "creatorSellSol", "sameNameRecent", "uniqueTraders", "trades"]) assert.ok(k in feat, `feat.${k}`);
  assert.ok(!("name" in feat) && !("creator" in feat), "per-mint constants are on the row, not in every milestone");
  ok("milestone crossing: a 20 -> 60 jump records 25 and 50 at that event, each once; feat names = rev 7");
}

// ---- 2. minFillAfter / ratioMinAfter / secTo100 ---------------------------------------------------
{
  const f = feeder();
  const m = key(1002);
  f.create(m, { creator: key(2), ts: T0 });
  f.trade(m, 30, { ts: T0 + 10 });
  f.trade(m, 60, { ts: T0 + 20 });
  f.trade(m, 35, { ts: T0 + 40, isBuy: false });
  f.trade(m, 70, { ts: T0 + 60 });
  const rows = f.trade(m, 100, { ts: T0 + 100 });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.migrated, true);
  assert.equal(r.final, "complete");
  assert.equal(r.completeSec, T0 + 100);
  assert.equal(r.milestones["25"].minFillAfter, 30, "25: nothing went below its own event's fill 30");
  assert.equal(r.milestones["25"].ratioMinAfter, 1);
  assert.equal(r.milestones["50"].minFillAfter, 35, "50: the drop to 35 after 60");
  assert.ok(Math.abs(r.milestones["50"].ratioMinAfter - priceAt(35) / priceAt(60)) < 1e-3, `ratioMinAfter ${r.milestones["50"].ratioMinAfter}`);
  assert.equal(r.milestones["50"].minSecAfter, T0 + 40);
  assert.equal(r.milestones["25"].secTo100, 90);
  assert.equal(r.milestones["50"].secTo100, 80);
  assert.equal(r.milestones["100"].secTo100, 0);
  assert.deepEqual(Object.keys(r.milestones), ["25", "50", "75", "85", "92", "97", "100"], "the 70 -> 100 jump records 75 85 92 97 100");

  const g = feeder();
  const n = key(1003);
  g.create(n, { creator: key(3), ts: T0 });
  g.trade(n, 55, { ts: T0 + 10 });
  g.trade(n, 20, { ts: T0 + 30, isBuy: false });
  const [s] = C.finishAll(g.census);
  assert.equal(s.milestones["50"].secTo100, null, "never complete -> secTo100 null");
  assert.equal(s.milestones["50"].minFillAfter, 20);
  ok("minFillAfter / ratioMinAfter / secTo100 on rise-drop-complete; never-complete -> secTo100 null");
}

// ---- 3. finish rules ------------------------------------------------------------------------------
{
  const f = feeder({ idleSec: 1800 });
  const idle = key(1004);
  const other = key(1005);
  f.create(idle, { creator: key(4), ts: T0 });
  f.trade(idle, 10, { ts: T0 + 1 });
  f.trade(other, 3, { ts: T0 + 1800 });
  assert.equal(C.sweepIdle(f.census).length, 0, "1799 s of stream time without an event: still live");
  f.trade(other, 4, { ts: T0 + 1801 });
  const rows = C.sweepIdle(f.census);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mint, idle);
  assert.equal(rows[0].final, "idle");
  assert.ok(!f.census.live.has(idle) && !f.census.feats.mints.has(idle), "live state dropped with the final row");
  // idle full row says migrated: false
  const big = key(1006);
  f.create(big, { creator: key(5), ts: T0 + 1801 });
  f.trade(big, 40, { ts: T0 + 1802 });
  f.trade(other, 5, { ts: T0 + 3700 });
  const r2 = C.sweepIdle(f.census).find((x) => x.mint === big);
  assert.equal(r2.migrated, false);
  assert.equal(r2.final, "idle");
  // reappear after the idle row -> a new row with resumed: true
  f.trade(idle, 30, { ts: T0 + 3701 });
  const [sd] = C.finishAll(f.census).filter((x) => x.mint === idle);
  assert.equal(sd.resumed, true);
  assert.equal(sd.createSeen, true, "the resumed row keeps the create");
  assert.equal(sd.final, "shutdown");
  assert.equal(sd.partial, true);
  assert.equal(sd.migrated, null, "a partial row does not guess the outcome");
  assert.equal(sd.trades, 2, "trades continue across the resume");
  assert.deepEqual(Object.keys(sd.milestones), ["25"], "the resumed part records 25 (crossed after the 10 % idle row)");
  // shutdown -> partial rows for ALL live mints
  const g = feeder();
  g.create(key(1007), { creator: key(6), ts: T0 });
  g.trade(key(1008), 50, { ts: T0 + 1 });
  g.trade(key(1009), 2, { ts: T0 + 2 });
  const all = C.finishAll(g.census);
  assert.equal(all.length, 3);
  assert.ok(all.every((x) => x.final === "shutdown" && x.partial === true));
  assert.equal(g.census.live.size, 0);
  // after a complete row, a trailing event opens nothing
  const h = feeder();
  const mm = key(1010);
  h.create(mm, { creator: key(7), ts: T0 });
  assert.equal(h.trade(mm, 100, { ts: T0 + 3 }).length, 1);
  h.trade(mm, 100, { ts: T0 + 4 });
  assert.equal(h.census.live.size, 0, "no new row after migration");
  ok("finish rules: complete -> migrated; idle 1800 s -> idle; shutdown -> partial for all; reappear -> resumed");
}

// ---- 4. compact vs full; create not seen ---------------------------------------------------------
{
  const f = feeder();
  const small = key(1011);
  const exact = key(1012);
  f.create(small, { creator: key(8), ts: T0 });
  f.trade(small, 24.9, { user: key(8), ts: T0 + 1 });
  f.create(exact, { creator: key(9), ts: T0 });
  f.trade(exact, 25, { ts: T0 + 2 });
  const rows = C.finishAll(f.census);
  const c = rows.find((x) => x.mint === small);
  const full = rows.find((x) => x.mint === exact);
  const compactKeys = ["type", "censusRev", "mint", "createSec", "createSeen", "launcher", "isCreator", "launches24h", "devBuySol", "hourUtc", "maxFill", "trades", "uniqueTraders", "lastSec", "final", "maxLagSec", "partial"];
  assert.deepEqual(Object.keys(c), compactKeys, "compact row = the listed fields only");
  assert.equal(c.maxFill, 24.9);
  assert.ok(full.milestones && full.milestones["25"], "maxFill 25 -> full row with snapshots");
  // create not seen: never guessed
  const g = feeder();
  const u = key(1013);
  g.trade(u, 30, { user: key(50), ts: T0 });
  g.trade(u, 55, { user: key(51), ts: T0 + 5 });
  const [r] = C.finishAll(g.census);
  assert.equal(r.createSeen, false);
  for (const k of ["launcher", "isCreator", "launches24h", "devBuySol", "createSec"]) assert.equal(r[k], null, `${k} null without the create`);
  assert.equal(r.firstSeenFill, 30);
  assert.deepEqual(Object.keys(r.milestones), ["50"], "25 was not seen crossing (first seen at 30): absent, not invented");
  assert.equal(r.milestones["50"].secFromCreate, null);
  ok("compact vs full by maxFill threshold; create not seen -> createSeen false, launcher null, no invented milestone");
}

// ---- 4b. payloads without a reserve snapshot: fill unknown, never 0 --------------------------------
{
  const f = feeder();
  const zero = (mint, ts) => {
    const p = tradePayload({ mint, user: key(70), realSol: 0.3 * REAL_100, ts });
    p.fill(0, 97, 121); // the zero-reserve payloads seen live (lengths 390/391/401/405)
    return C.handleLogs(f.census, [DATA(p), "Program x success"], { nowMs: ts * 1000 + 300 });
  };
  const only = key(1030);
  const mixed = key(1031);
  zero(only, T0);
  zero(only, T0 + 1);
  zero(mixed, T0);
  f.trade(mixed, 12, { ts: T0 + 2 });
  const launched = key(1032);
  f.create(launched, { creator: key(71), ts: T0 });
  const rows = C.finishAll(f.census);
  const by = (m) => rows.find((x) => x.mint === m);
  assert.equal(by(only).maxFill, null, "only unpriced trades: maxFill unknown (null), not 0");
  assert.equal(by(only).unpricedTrades, 2);
  assert.equal(by(only).trades, 2);
  assert.equal(by(mixed).maxFill, 12);
  assert.equal(by(mixed).unpricedTrades, 1);
  assert.equal(by(launched).maxFill, 0, "a create without trades is at its launch fill 0");
  assert.ok(!("unpricedTrades" in by(launched)));
  ok("zero-reserve payloads: maxFill null when no trade was priced; unpricedTrades counted");
}

// ---- 5. launcher fields, dev buy ------------------------------------------------------------------
{
  const f = feeder();
  const L = key(60);
  const solo = key(1014);
  f.create(solo, { creator: L, user: L, ts: T0, slot: 77 });
  f.trade(solo, 2, { user: L, sol: 1.5, ts: T0, slot: 77 }); // create slot
  f.trade(solo, 3, { user: L, sol: 0.5, ts: T0 + 8, slot: 79 }); // within 10 s
  f.trade(solo, 4, { user: L, sol: 2, ts: T0 + 30, slot: 90 }); // too late
  f.trade(solo, 5, { user: key(61), sol: 3, ts: T0 + 1, slot: 78 }); // not the dev
  const mode = key(1015);
  f.create(mode, { creator: key(62), user: key(63), ts: T0 + 40 });
  // serial: 25 h ago (not counted), 2 h ago, 1 h ago, now -> 3 in 24 h
  const S = key(64);
  f.create(key(1016), { creator: S, ts: T0 - 25 * 3600 });
  f.create(key(1017), { creator: S, ts: T0 - 2 * 3600 });
  f.create(key(1018), { creator: key(65), user: S, ts: T0 - 3600 });
  const ser = key(1019);
  f.create(ser, { creator: S, ts: T0 + 50 });
  const rows = C.finishAll(f.census);
  const by = (m) => rows.find((x) => x.mint === m);
  assert.equal(by(solo).launcher, L);
  assert.equal(by(solo).isCreator, true);
  assert.equal(by(solo).launches24h, 1);
  assert.equal(by(solo).devBuySol, 2, "1.5 in the create slot + 0.5 within 10 s; not the +30 s buy, not another wallet");
  assert.equal(by(mode).launcher, key(63), "launcher = create user, not creator");
  assert.equal(by(mode).isCreator, false);
  assert.equal(by(ser).launches24h, 3, "3 creates in 24 h (the 25 h one is not counted)");
  assert.equal(by(key(1016)).launches24h, 1);
  ok("launcher fields: user = creator vs user != creator; 3 creates in 24 h; 25 h ago not counted; dev buy window");
}

// ---- 6. stall marking, UTC rollover, env validation -----------------------------------------------
{
  const f = feeder();
  f.trade(key(1020), 30, { ts: T0 });
  const st = C.noteStall(f.census, 45_000, T0 * 1000 + 50_000);
  assert.equal(st.type, "census_stall");
  assert.equal(st.stallSec, 45);
  f.trade(key(1021), 3, { ts: T0 + 60 });
  C.clearStall(f.census);
  f.trade(key(1022), 3, { ts: T0 + 61 });
  const rows = C.finishAll(f.census);
  assert.equal(rows.find((x) => x.mint === key(1020)).stall, true);
  assert.equal(rows.find((x) => x.mint === key(1021)).stall, true, "a mint starting during the drain is marked");
  assert.equal(rows.find((x) => x.mint === key(1022)).stall, undefined);
  ok("stall: live mints and mints starting before clearStall carry stall: true");

  const dir = tmp("census-roll-");
  let now = Date.parse("2026-11-15T23:59:59.500Z");
  const w = C.createWriter(dir, { now: () => now });
  w.write({ type: "census_mint", mint: "a" });
  now = Date.parse("2026-11-16T00:00:00.200Z");
  w.write({ type: "census_mint", mint: "b" });
  assert.deepEqual(fs.readdirSync(dir).sort(), ["census-2026-11-15.jsonl", "census-2026-11-16.jsonl"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "census-2026-11-16.jsonl"), "utf8")).mint, "b");
  fs.rmSync(dir, { recursive: true, force: true });
  ok("UTC date rollover writes to the next file");

  assert.deepEqual(C.parseCensusEnv({}).milestones, [25, 50, 75, 85, 92, 97, 100]);
  assert.deepEqual(C.parseCensusEnv({ CENSUS_MILESTONES: "10, 20,30" }).milestones, [10, 20, 30]);
  for (const [k, v] of [["CENSUS_MILESTONES", "25,abc"], ["CENSUS_MILESTONES", "50,25"], ["CENSUS_MILESTONES", "0,50"], ["CENSUS_MILESTONES", "50,101"], ["CENSUS_IDLE_SEC", "0"], ["CENSUS_IDLE_SEC", "1.5"], ["CENSUS_FULL_MIN_FILL", "150"], ["CENSUS_MAX_SEC", "x"], ["CENSUS_GAP_SEC", "0"], ["CENSUS_GAP_SEC", "ten"]]) {
    assert.throws(() => C.parseCensusEnv({ [k]: v }), new RegExp(k), `${k}=${v} rejected`);
  }
  ok("env validation (lib): milestones, idle, full threshold, max sec");
}

// ---- 6b. stream gaps (#19b) -----------------------------------------------------------------------
{
  const f = feeder();
  const before = key(1040); // live at the gap start
  const climber = key(1041); // live at the gap start; crosses 25 inside the window, 50 after it
  f.trade(before, 3, { ts: T0 });
  f.trade(climber, 10, { ts: T0 });
  const last = f.census.lastEventMs;
  assert.equal(last, T0 * 1000 + 700);
  assert.equal(C.checkGap(f.census, last + 9_000, 10), false, "9 s of silence: no gap");
  assert.equal(C.inGapWindow(f.census, last + 9_000), false);
  assert.equal(C.checkGap(f.census, last + 10_000, 10), true, "10 s of silence: gap open");
  assert.equal(C.checkGap(f.census, last + 11_000, 10), false, "an open gap is opened once");
  // the next event closes it: 40 s of silence
  const closeRows = f.trade(climber, 30, { ts: T0 + 40 });
  const g = closeRows.find((r) => r.type === "census_gap");
  assert.ok(g, "census_gap row when the gap closes");
  assert.equal(g.gapSec, 40);
  assert.equal(g.liveMints, 2);
  assert.equal(g.startedAt, new Date(last).toISOString());
  assert.equal(g.endedAt, new Date((T0 + 40) * 1000 + 700).toISOString());
  const near = key(1042);
  const far = key(1043);
  f.trade(near, 5, { ts: T0 + 70 }); // first seen 30 s after the close
  f.trade(far, 5, { ts: T0 + 111 }); // 70.3 s after
  f.trade(climber, 55, { ts: T0 + 112 }); // 50 outside the window
  const mem = C.memRow(f.census, (T0 + 120) * 1000);
  assert.equal(mem.gaps, 1);
  assert.equal(mem.gapSecTotal, 40);
  assert.equal(C.closeGapAtStop(f.census, (T0 + 120) * 1000), null, "no open gap at the stop: no row");
  const rows = C.finishAll(f.census);
  const by = (m) => rows.find((x) => x.mint === m);
  assert.equal(by(before).gap, true, "live at the gap start");
  assert.equal(by(climber).gap, true);
  assert.equal(by(near).gap, true, "first seen 30 s after the gap");
  assert.equal(by(far).gap, undefined, "first seen 70 s after the gap: no flag");
  assert.equal(by(climber).milestones["25"].gap, true, "a milestone inside the 60 s window");
  assert.equal(by(climber).milestones["50"].gap, undefined, "a milestone after the window");
  // a gap still open at the stop is written with openAtStop
  const h = feeder();
  h.trade(key(1044), 3, { ts: T0 });
  assert.equal(C.checkGap(h.census, h.census.lastEventMs + 15_000, 10), true);
  const open = C.closeGapAtStop(h.census, h.census.lastEventMs + 25_000);
  assert.equal(open.type, "census_gap");
  assert.equal(open.openAtStop, true);
  assert.equal(open.gapSec, 25);
  assert.equal(C.finishAll(h.census)[0].gap, true);
  // no gap before the first event (the socket is still connecting)
  assert.equal(C.checkGap(feeder().census, T0 * 1000 + 60_000, 10), false);
  ok("stream gaps: 9 s no / 10 s yes; census_gap row; live + first seen within 60 s flagged, 70 s not; milestone in window; open at stop");
}

// ---- 6c. unpriced payload description (#19b) -------------------------------------------------------
{
  const f = feeder();
  const m = key(1050);
  const zeroPayload = (len, ts) => {
    const p = tradePayload({ mint: m, user: key(72), realSol: 0.3 * REAL_100, ts }).subarray(0, len);
    p.fill(0, 97, 121); // zero virtual reserves
    return p;
  };
  const first = zeroPayload(405, T0);
  const feed = (p, ts) => C.handleLogs(f.census, [DATA(p), "Program x success"], { nowMs: ts * 1000 + 300 });
  feed(first, T0);
  feed(zeroPayload(391, T0 + 1), T0 + 1);
  feed(zeroPayload(405, T0 + 2), T0 + 2);
  f.trade(m, 8, { ts: T0 + 3 }); // a priced one (not counted)
  const mem = C.memRow(f.census, (T0 + 4) * 1000);
  assert.deepEqual(mem.unpricedByLen, { 391: 1, 405: 2 });
  const [r] = C.finishAll(f.census);
  assert.equal(r.unpricedTrades, 3);
  assert.deepEqual(r.unpricedLens, [391, 405], "sorted distinct lengths");
  assert.equal(r.unpricedSample, first.subarray(8, 24).toString("hex"), "first unpriced event, bytes 8..24");
  assert.equal(r.unpricedTail, first.subarray(89, 129).toString("hex"), "first unpriced event, bytes 89..129");
  assert.equal(r.unpricedTail.slice(16, 48), "0".repeat(32), "the zero reserves are visible in the tail");
  assert.equal(r.maxFill, 8, "maxFill semantics unchanged");
  // at most 4 distinct lengths
  const g = feeder();
  const n = key(1051);
  for (const len of [390, 391, 401, 403, 405]) {
    const p = tradePayload({ mint: n, user: key(73), realSol: 0, ts: T0 }).subarray(0, len);
    p.fill(0, 97, 121);
    C.handleLogs(g.census, [DATA(p), "Program x success"], { nowMs: T0 * 1000 + 300 });
  }
  assert.deepEqual(C.finishAll(g.census)[0].unpricedLens, [390, 391, 401, 403]);
  ok("unpricedLens / unpricedSample / unpricedTail per mint, unpricedByLen in census_mem, max 4 lengths");
}

// ---- 6d. lib/ws.mjs onOpen observer (reconnect counter) -------------------------------------------
{
  process.env.WS_MOCK = path.join(here, "mocks", "ws-mock-census.mjs"); // read when lib/ws.mjs loads
  const { SolanaWs } = await import("../lib/ws.mjs");
  const ws = new SolanaWs("ws://127.0.0.1:1");
  assert.equal(ws.onOpen, null, "no observer by default");
  let opens = 0;
  ws.onOpen = () => {
    opens += 1;
    throw new Error("an observer error must not break the socket");
  };
  await ws.connect();
  assert.equal(opens, 1);
  ws.ws.emit("close"); // a drop: the socket reconnects by itself (backoff 0.5-1 s)
  const t0 = Date.now();
  while (opens < 2 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.equal(opens, 2, "onOpen called again on the reconnect");
  await ws.close();
  delete process.env.WS_MOCK;
  ok("lib/ws.mjs onOpen: default none, called on connect and reconnect, observer errors swallowed");
}

// ---- 7. the process: static check, fixture RPC sees 0 requests, rows, --live, bad env, lock -------
function importGraph(entry) {
  const seen = new Set();
  const bare = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import\s[^"']*?from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
      else bare.add(spec);
    }
  };
  walk(entry);
  return { files: [...seen].map((f) => path.relative(root, f).replace(/\\/g, "/")), bare: [...bare] };
}
{
  const g = importGraph(path.join(here, "mint-census.mjs"));
  const forbidden = ["lib/rpc.mjs", "lib/send.mjs", "lib/tx.mjs", "lib/wallet.mjs", "lib/exec.mjs", "lib/pumpfun.mjs", "lib/pumpswap.mjs", "lib/pumpswap-sell.mjs", "lib/amm-sell.mjs", "lib/sell-all.mjs", "lib/close-ata.mjs", "lib/enrich.mjs"];
  for (const f of forbidden) assert.ok(!g.files.includes(f), `the census does not import ${f}`);
  assert.ok(g.files.includes("lib/mint-census.mjs") && g.files.includes("lib/events.mjs") && g.files.includes("lib/gshadow-features.mjs") && g.files.includes("lib/ws.mjs"), `reuses the shared libs: ${g.files.join(", ")}`);
  const bad = /\b(Keypair|sendTransaction|sendRawTransaction|signTransaction|sendAndConfirm|getAccountInfo|getTransaction|getSignaturesForAddress|new Connection)\b/;
  for (const f of g.files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!bad.test(src), `${f} has no signing / sending / RPC call: ${(src.match(bad) || [""])[0]}`);
  }
  assert.ok(g.bare.every((b) => ["@solana/web3.js", "ws"].includes(b) || b.startsWith("node:")), `packages: ${g.bare.join(", ")}`);
  ok(`static check: ${g.files.length} modules, none signs / sends / calls RPC`);
}

const censusDir = tmp("census-run-");
let connections = 0;
const server = http.createServer((req, res) => {
  res.writeHead(500);
  res.end();
});
server.on("connection", () => (connections += 1));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseEnv = (extra = {}) => cleanEnv({ RPC_URL: `http://127.0.0.1:${port}`, WS_MOCK: path.join(here, "mocks", "ws-mock-census.mjs"), CENSUS_DIR: censusDir, ...extra });
const script = path.join(here, "mint-census.mjs");

async function runCensus(env, args = []) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });
  return { code, out, err };
}

{
  const { code, out, err } = await runCensus(baseEnv({ CENSUS_MAX_SEC: "3" }));
  assert.equal(code, 0, `census exited 0 (stderr: ${err.split(/\r?\n/)[0]})`);
  assert.ok(!/TypeError|ReferenceError|RangeError|handler error/.test(out + err), `no exception: ${out}${err}`);
  assert.match(out, /read-only, no RPC/);
  assert.match(out, /milestones 25 50 75 85 92 97 100/);
  assert.match(out, /idle 1800s/);
  assert.match(out, /full row at maxFill >= 25/);
  const files = fs.readdirSync(censusDir).filter((f) => f.endsWith(".jsonl"));
  assert.deepEqual(files, [C.censusFileName(Date.now())], "one file named by today's UTC date");
  const rows = fs.readFileSync(path.join(censusDir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mints = rows.filter((r) => r.type === "census_mint");
  const by = (m) => mints.filter((r) => r.mint === m);
  assert.equal(by(W.MIG_MINT).length, 1, "one row for the migrated mint (the trailing event opened none)");
  const mig = by(W.MIG_MINT)[0];
  assert.equal(mig.migrated, true);
  assert.equal(mig.launcher, W.MIG_LAUNCHER);
  assert.equal(mig.isCreator, true);
  assert.equal(mig.devBuySol, 1);
  assert.deepEqual(Object.keys(mig.milestones), ["25", "50", "75", "85", "92", "97", "100"]);
  assert.equal(mig.milestones["50"].minFillAfter, 40);
  assert.equal(mig.milestones["50"].feat.sells60, 0, "the sell came after 50");
  assert.equal(mig.milestones["75"].feat.sells60, 1, "and before 75");
  const mode = by(W.MODE_MINT)[0];
  assert.equal(mode.isCreator, false);
  assert.equal(mode.launcher, W.MODE_LAUNCHER);
  assert.equal(mode.partial, true);
  assert.ok(!("milestones" in mode), "compact row");
  const un = by(W.UNSEEN_MINT)[0];
  assert.equal(un.createSeen, false);
  assert.equal(un.launcher, null);
  assert.deepEqual(Object.keys(un.milestones), ["50"]);
  const mem = rows.filter((r) => r.type === "census_mem");
  assert.equal(mem.length, 1, "a census_mem row at the stop");
  assert.equal(mem[0].rows, 3);
  assert.equal(mem[0].gaps, 0, "no stream gap in a 3 s run");
  assert.equal(mem[0].wsReconnects, 0);
  assert.match(out, /gap after 10s of silence/);
  const fileBytes = fs.statSync(path.join(censusDir, files[0])).size;
  const lastLine = Buffer.byteLength(JSON.stringify(rows[rows.length - 1])) + 1;
  assert.equal(mem[0].bytesWritten, fileBytes - lastLine, "census_mem counts the bytes written before it");
  assert.ok(rows.every((r) => r.ts && r.censusRev === 1));
  assert.equal(connections, 0, `the fixture RPC saw ${connections} connection(s)`);
  assert.ok(!fs.existsSync(path.join(censusDir, ".census.lock")), "the lock is released at the stop");
  ok("process: real recorder on a fixture stream writes the expected rows; fixture RPC counted 0 requests");
}

{
  const live = await runCensus(baseEnv({ CENSUS_MAX_SEC: "2" }), ["--live"]);
  assert.equal(live.code, 1, "--live -> exit 1");
  assert.match(live.err, /read-only/);
  for (const [k, v] of [["CENSUS_MILESTONES", "25,abc"], ["CENSUS_IDLE_SEC", "-5"], ["CENSUS_FULL_MIN_FILL", "x"]]) {
    const r = spawnSync(process.execPath, [script], { cwd: root, env: baseEnv({ [k]: v }), encoding: "utf8" });
    assert.equal(r.status, 1, `${k}=${v} -> exit 1`);
    assert.match(r.stderr, new RegExp(k), `the error names ${k}`);
  }
  fs.writeFileSync(path.join(censusDir, ".census.lock"), String(process.pid)); // a live PID
  const locked = await runCensus(baseEnv({ CENSUS_MAX_SEC: "2" }));
  assert.equal(locked.code, 1, "a second census on the same folder refuses to start");
  assert.match(locked.err, /already running/);
  assert.equal(connections, 0);
  ok("--live -> exit 1; invalid env -> exit 1 naming the variable; instance lock");
}

server.close();
fs.rmSync(censusDir, { recursive: true, force: true });
console.log(`mint-census: ${passed} checks passed`);
