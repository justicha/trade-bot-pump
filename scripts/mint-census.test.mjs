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
  const compactKeys = ["type", "censusRev", "mint", "createSec", "createSeen", "launcher", "isCreator", "launches24h", "devBuySol", "hourUtc", "maxFill", "trades", "uniqueTraders", "lastSec", "final", "maxLagSec", "partial", "mayhem"];
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

// ==== rev 2 (KODING #21): PumpSwap pool path after the migration ===================================
const S = await import("../lib/pumpswap-stream.mjs");
const PS = await import("../lib/pumpswap.mjs");
const PSS = await import("../lib/pumpswap-sell.mjs");
const CP = await import("../lib/census-pool.mjs");
const { PublicKey } = await import("@solana/web3.js");
const SELLS = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "amm-sell-events.json"), "utf8"));
const BUYS = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "amm-buy-events.json"), "utf8"));
const PUMPSWAP_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const KEY_TEXT = /FIXTUREKEY|api-key/i; // #20's check: no endpoint key in any output
const poolLogs = (payloads) => [`Program ${PUMPSWAP_ID} invoke [1]`, ...payloads.map((p) => DATA(p)), `Program ${PUMPSWAP_ID} success`];

// ---- 8. offsets: real SellEvents (#13 fixture) and real BuyEvents; the old decoder unchanged -----------
{
  assert.ok(!/https?:|api-key/i.test(JSON.stringify(BUYS)), "the buy fixture carries no URL / key");
  // #13's event 0, decoded field by field (amm-fee.test.mjs replays its net 179 923 219 to the lamport)
  const e0 = S.parsePumpSwapTrade(Buffer.from(SELLS.events[0].eventHex, "hex"));
  assert.deepEqual(
    { side: e0.side, ts: e0.timestampSec, baseIn: e0.baseAmount, poolBase: e0.poolBase, poolQuote: e0.poolQuote, out: e0.quoteAmount, lp: e0.lpFee, withoutLp: e0.quoteWithLp, net: e0.userQuote, virtual: e0.virtualQuote, supply: e0.baseSupply, pool: e0.pool },
    { side: "sell", ts: 1794517996, baseIn: 435807628154n, poolBase: 204892145351262n, poolQuote: 68302823496n, out: 182200730n, lp: 36441n, withoutLp: 182164289n, net: 179923219n, virtual: 17539875340n, supply: 998767391279916n, pool: SELLS.events[0].pool },
  );
  assert.equal(S.parsePumpSwapTrade(Buffer.from(SELLS.events[5].eventHex, "hex")).userQuote, 171369616n, "#13 event 5: net 171 369 616");
  for (const f of SELLS.events) {
    const ev = S.parsePumpSwapTrade(Buffer.from(f.eventHex, "hex"));
    const eff = ev.poolQuote + ev.virtualQuote;
    assert.equal(ev.quoteAmount, (eff * ev.baseAmount) / (ev.poolBase + ev.baseAmount), `${f.mint.slice(0, 6)}: gross out = constant product on vault + virtual (reserves before the trade)`);
    assert.equal(ev.quoteWithLp, ev.quoteAmount - ev.lpFee);
    assert.equal(ev.pool, f.pool);
    assert.equal(S.canonicalPool(new PublicKey(f.mint)).toBase58(), f.pool, "the canonical pool PDA (pure) is the event's pool");
    assert.equal(ev.timestampSec, f.blockTime === ev.timestampSec ? f.blockTime : ev.timestampSec);
    assert.ok(Math.abs(ev.timestampSec - f.blockTime) <= 1, "event timestamp = block time");
  }
  // real BuyEvents: virtual_quote_reserves sits after the variable-length ix_name
  const names = new Set();
  for (const f of BUYS.events) {
    const d = Buffer.from(f.eventHex, "hex");
    const ev = S.parsePumpSwapTrade(d);
    names.add(ev.ixName);
    assert.ok(ev.virtualQuote > 0n && ev.baseSupply > 0n, `${ev.ixName}: virtual quote / supply decoded`);
    const ceilIn = (eff) => (eff * ev.baseAmount + (ev.poolBase - ev.baseAmount) - 1n) / (ev.poolBase - ev.baseAmount);
    const curveIn = ev.quoteWithLp - ev.lpFee;
    const diff = ceilIn(ev.poolQuote + ev.virtualQuote) - curveIn;
    assert.ok(diff >= -1n && diff <= 0n, `${ev.ixName}: base out matches the constant product on vault + virtual (diff ${diff})`);
    if (ev.ixName === "buy") assert.equal(ceilIn(ev.poolQuote + ev.virtualQuote), ev.quoteAmount, "buy: quote_amount_in = ceil(eff * out / (base - out)) to the lamport");
    assert.ok(ceilIn(ev.poolQuote) - curveIn < -100n, `${ev.ixName}: without the virtual part the product does not hold`);
    // the name's length moves the field: read it 8 bytes off and the product breaks too
    const off = d.readUInt32LE(401);
    const shifted = d.readBigUInt64LE(405 + off + 32 + 8);
    const d2 = ceilIn(ev.poolQuote + shifted) - curveIn;
    assert.ok(d2 < -1n || d2 > 0n, `${ev.ixName}: an offset 8 bytes off does not reproduce the trade (${d2})`);
  }
  assert.ok(names.has("buy") && names.size >= 3, `several ix_name lengths covered: ${[...names].join(", ")}`);
  // the old decoder: one copy, the same fields and values
  assert.equal(PS.parsePumpSwapEvent, S.parsePumpSwapEvent, "lib/pumpswap.mjs re-exports the one decoder");
  assert.equal(PSS.canonicalPool, S.canonicalPool, "lib/pumpswap-sell.mjs re-exports the one PDA");
  const old = PS.parsePumpSwapEvent(Buffer.from(SELLS.events[0].eventHex, "hex"));
  assert.deepEqual(Object.keys(old), ["side", "baseAmount", "quoteAmount", "pool", "user", "userBaseTokenAccount"]);
  assert.equal(old.side, "sell");
  assert.equal(old.baseAmount, 435807628154);
  assert.equal(old.quoteAmount, 179923219);
  assert.equal(old.pool, SELLS.events[0].pool);
  const oldBuy = PS.parsePumpSwapEvent(Buffer.from(BUYS.events[0].eventHex, "hex"));
  assert.equal(oldBuy.side, "buy");
  assert.equal(oldBuy.quoteAmount, Number(S.parsePumpSwapTrade(Buffer.from(BUYS.events[0].eventHex, "hex")).userQuote));
  ok("offsets: 10 real SellEvents (#13 values, constant product on vault + virtual) and 12 real BuyEvents (4 ix_name lengths); parsePumpSwapEvent unchanged");
}

// ---- 9. one scale: the curve's last price and the first pool price (real fixture) -------------------
{
  const f = SELLS.events.find((e) => e.slot === 468694074); // F31uC9, first minutes after migration
  const ev = S.parsePumpSwapTrade(Buffer.from(f.eventHex, "hex"));
  const census = C.createCensus({ startedAtMs: (ev.timestampSec - 60) * 1000 });
  // the completing curve trade: real end-of-curve reserves (85 SOL real, 30 SOL virtual launch,
  // 279.9M tokens left virtual), timestamp a few seconds before the pool event
  const p = tradePayload({ mint: f.mint, user: key(80), realSol: REAL_100, ts: ev.timestampSec - 5 });
  p.writeBigUInt64LE(279_900_000_000_000n, 105);
  const rows = C.handleLogs(census, [DATA(p), "Program x success"], { nowMs: (ev.timestampSec - 5) * 1000 + 500 });
  assert.equal(rows[0].migrated, true);
  assert.ok(census.pools.byPool.has(f.pool), "the completion starts the watch of the canonical pool");
  C.handlePoolLogs(census, poolLogs([Buffer.from(f.eventHex, "hex")]), { signature: f.signature, nowMs: ev.timestampSec * 1000 + 700 });
  const [row] = C.finishPoolsAtStop(census);
  const curveEnd = Number(((115e9 / 279.9e12) * 1e-3).toPrecision(6));
  assert.equal(row.curveEndPrice, curveEnd);
  assert.ok(row.ratioOpen > 0.97 && row.ratioOpen < 1.03, `first pool price / curve end = ${row.ratioOpen} (one scale)`);
  const vaultOnly = S.quotePerBase(ev.poolQuote, ev.poolBase) / curveEnd;
  assert.ok(vaultOnly < 0.85, `without the virtual quote reserves the pool would look ${vaultOnly.toFixed(3)} of the curve`);
  assert.equal(row.poolDelaySec, 5);
  assert.equal(row.quoteReserveSolAtFirst, 67.3129);
  ok(`scale: curve end ${curveEnd} vs first pool price ${row.firstPoolPrice} -> ratio ${row.ratioOpen} (vault-only would be ${vaultOnly.toFixed(3)})`);
}

// ---- 10. the pool path: ratios, min / max windows, flows, launcher / creator sells, idle, dedupe ------
const MP = W.MIG_POOL_START;
function poolCensus(cfg = {}) {
  const f = feeder({ idleSec: 500, ...cfg });
  const m = key(1101);
  const L = key(1102);
  const Cr = key(1103);
  f.create(m, { creator: Cr, user: L, ts: T0 });
  const done = f.trade(m, 100, { ts: T0 + 100 });
  assert.equal(done[0].migrated, true);
  const pool = S.canonicalPool(new PublicKey(m)).toBase58();
  const sim = W.poolSim(MP);
  let n = 0;
  const send = (fields, { sig = `ps-${++n}`, extra = [] } = {}) => {
    const payload = W.pumpSwapPayload(fields);
    const rows = C.handlePoolLogs(f.census, poolLogs([payload, ...extra]), { signature: sig, nowMs: fields.ts * 1000 + 600 });
    return { rows, prices: S.poolTradePrices(S.parsePumpSwapTrade(payload)), payload };
  };
  const trade = (o) => send(sim.trade({ pool, ...o }));
  return { f, m, L, Cr, pool, sim, send, trade };
}
{
  const { f, L, Cr, pool, trade, send } = poolCensus();
  const A = key(1110);
  const Wh = key(1111);
  const first = T0 + 105;
  const unwatched = [];
  f.census.pools.hooks.unwatch = (p) => unwatched.push(p);
  const curveEnd = priceAt(100);
  const e1 = trade({ side: "buy", sol: 1, user: A, ts: first });
  const e2 = trade({ side: "sell", tokens: 3_000_000_000_000n, user: L, ts: first + 5 });
  // the same transaction again (a second subscription delivering it): processed once
  C.handlePoolLogs(f.census, poolLogs([e2.payload]), { signature: "ps-2", nowMs: (first + 5) * 1000 + 900 });
  const e3 = trade({ side: "sell", tokens: 1_000_000_000_000n, user: Cr, ts: first + 7 });
  // an event of a pool nobody watches, in a transaction that also touches ours: ignored, counted
  send(W.poolSim({ base: 5e14, quote: 9e10, virtual: 0 }).trade({ side: "buy", sol: 2, pool: W.OTHER_POOL, user: A, ts: first + 10 }));
  const e4 = trade({ side: "sell", tokens: 20_000_000_000_000n, user: Wh, ts: first + 65 });
  const e5 = trade({ side: "buy", sol: 0.5, user: A, ts: first + 290 });
  const e6 = trade({ side: "sell", tokens: 40_000_000_000_000n, user: L, ts: first + 301 }); // after 5 m, bigger than e4
  assert.equal(f.census.pools.counts.unknownPool, 1);
  assert.equal(f.census.pools.counts.poolDup, 1);
  // idle: 500 s of stream time after the last pool event (another mint's curve trade moves the clock)
  f.trade(key(1120), 5, { ts: first + 301 + 499 });
  assert.deepEqual(C.sweepPoolWatch(f.census), [], "499 s: still watched");
  f.trade(key(1120), 6, { ts: first + 301 + 500 });
  const [row] = C.sweepPoolWatch(f.census);
  assert.equal(row.type, "census_pool");
  assert.equal(row.censusRev, 3);
  assert.equal(row.final, "idle");
  assert.deepEqual(unwatched, [pool], "the idle end unwatches the pool");
  assert.equal(f.census.pools.byPool.size, 0);
  const R = (x) => Math.round((x / curveEnd) * 1e4) / 1e4;
  assert.equal(row.firstPoolSec, first);
  assert.equal(row.poolDelaySec, 5);
  assert.equal(row.ratioOpen, R(Number(e1.prices.before.toPrecision(6))));
  assert.equal(row.ratio10s, R(e3.prices.after), "10 s: the last price at or before t (after e3 at 7 s)");
  assert.equal(row.ratio30s, R(e3.prices.after));
  assert.equal(row.ratio1m, R(e3.prices.after), "1 m: e4 (65 s) is later");
  assert.equal(row.ratio3m, R(e4.prices.after));
  assert.equal(row.ratio5m, R(e5.prices.after), "5 m: e5 at 290 s, e6 (301 s) is later");
  assert.equal(row.ratio15m, null, "the watch ended at 801 s: 15 m not reached -> null");
  assert.equal(row.ratio60m, null);
  assert.equal(row.observedSec, 801);
  // min / max: opening price at 0 s, then the price after every trade
  const path_ = [[0, e1.prices.before], [0, e1.prices.after], [5, e2.prices.after], [7, e3.prices.after], [65, e4.prices.after], [290, e5.prices.after], [301, e6.prices.after]];
  const mm = (lim) => {
    let min = null;
    let max = null;
    for (const [s, p] of path_) {
      if (s > lim) continue;
      if (!min || p < min[1]) min = [s, p];
      if (!max || p > max[1]) max = [s, p];
    }
    return { min: R(min[1]), minSec: min[0], max: R(max[1]), maxSec: max[0] };
  };
  assert.deepEqual({ min: row.minRatio1m, minSec: row.minSec1m, max: row.maxRatio1m, maxSec: row.maxSec1m }, mm(60));
  assert.deepEqual({ min: row.minRatio5m, minSec: row.minSec5m, max: row.maxRatio5m, maxSec: row.maxSec5m }, mm(300));
  assert.deepEqual({ min: row.minRatioAll, minSec: row.minSecAll, max: row.maxRatioAll, maxSec: row.maxSecAll }, mm(1e9));
  assert.equal(row.minSec5m, 65, "the 5 m minimum is the whale sell at 65 s");
  assert.equal(row.minSecAll, 301, "the whole-watch minimum is the launcher dump at 301 s");
  const solOf = (e) => Number(S.parsePumpSwapTrade(e.payload).userQuote) / 1e9;
  const r4_ = (x) => Math.round(x * 1e4) / 1e4;
  assert.deepEqual(row.flow1m, { trades: 3, buys: 1, sells: 2, buySol: r4_(solOf(e1)), sellSol: r4_(solOf(e2) + solOf(e3)), uniqueTraders: 3 });
  assert.deepEqual(row.flow5m, { trades: 5, buys: 2, sells: 3, buySol: r4_(solOf(e1) + solOf(e5)), sellSol: r4_(solOf(e2) + solOf(e3) + solOf(e4)), uniqueTraders: 4 });
  assert.equal(row.flowAll.trades, 6);
  assert.equal(row.flowAll.uniqueTraders, 4, "A, launcher, creator, whale (the launcher's second sell is not a new trader)");
  assert.equal(row.launcherSellSol5m, r4_(solOf(e2)), "launcher sells in 5 m: e2 only (e6 at 301 s is later)");
  assert.equal(row.creatorSellSol5m, r4_(solOf(e3)), "creator = the create's creator, not the launcher");
  assert.equal(row.largestSellSol3m, r4_(solOf(e4)));
  assert.equal(row.largestSellWallet3m, Wh);
  assert.equal(row.largestSellSec3m, 65);
  assert.equal(row.quoteReserveSolAtFirst, 68.3);
  assert.equal(row.quoteReserveSolEnd, r4_(Number(e6.prices.quoteAfter) / 1e9));
  assert.equal(row.events, 6);
  assert.ok(!("partial" in row));
  // a later event of the ended pool is not a watched pool any more
  trade({ side: "buy", sol: 0.1, user: A, ts: first + 900 });
  assert.equal(f.census.pools.counts.unknownPool, 2);
  const mem = C.memRow(f.census, (first + 900) * 1000);
  assert.equal(mem.poolMode, "a");
  assert.equal(mem.poolRows, 1);
  assert.equal(mem.poolEvents, 6);
  ok("pool path: ratios at 10 s / 1 m / 3 m / 5 m, 15 m not reached -> null; min/max windows; flows; launcher / creator sells in 5 m only; largest sell 3 m; idle end; dedupe; unknown pool counted");
}

// ---- 11. watch end (on the event and by the clock), shutdown partial, no pool event, CENSUS_POOL=0 ---
{
  const { f, trade, pool } = poolCensus({ poolWatchSec: 600 });
  const A = key(1130);
  const first = T0 + 110;
  trade({ side: "buy", sol: 1, user: A, ts: first });
  const mid = trade({ side: "buy", sol: 1, user: A, ts: first + 100 });
  const rows = trade({ side: "sell", tokens: 1e12, user: A, ts: first + 601 }).rows;
  assert.equal(rows.length, 1, "an event past the window ends the watch");
  assert.equal(rows[0].final, "watch");
  assert.equal(rows[0].pool, pool);
  assert.equal(rows[0].observedSec, 600);
  assert.equal(rows[0].ratio5m, Math.round((mid.prices.after / priceAt(100)) * 1e4) / 1e4);
  assert.equal(rows[0].ratio15m, null, "beyond the 600 s watch -> null");
  assert.equal(rows[0].events, 2, "the event past the window is not counted");
  assert.equal(f.census.pools.counts.poolAfterEnd, 1);

  const g = poolCensus({ poolWatchSec: 600, idleSec: 1800 });
  g.trade({ side: "buy", sol: 1, user: A, ts: T0 + 110 });
  g.f.trade(key(1131), 5, { ts: T0 + 110 + 600 + 4 });
  assert.equal(C.sweepPoolWatch(g.f.census).length, 0, "the clock 4 s past the window: still waiting for in-flight events");
  g.f.trade(key(1131), 6, { ts: T0 + 110 + 600 + 5 });
  const [byClock] = C.sweepPoolWatch(g.f.census);
  assert.equal(byClock.final, "watch");
  assert.equal(byClock.ratio5m, byClock.ratio1m, "no event after 0 s: every reached checkpoint = the price after the first trade");
  assert.ok(byClock.ratio1m > 1);

  const h = poolCensus();
  h.trade({ side: "buy", sol: 1, user: A, ts: T0 + 104 });
  h.trade({ side: "sell", tokens: 1e12, user: A, ts: T0 + 107 });
  const [part] = C.finishPoolsAtStop(h.f.census);
  assert.equal(part.final, "shutdown");
  assert.equal(part.partial, true);
  assert.equal(part.ratio10s, null, "the stop came 3 s after the first event: 10 s not reached");
  assert.equal(part.flow1m, null);
  assert.equal(part.flowAll.trades, 2);
  assert.equal(h.f.census.pools.byPool.size, 0);

  const k = poolCensus();
  k.f.trade(key(1132), 5, { ts: T0 + 100 + 500 });
  const [none] = C.sweepPoolWatch(k.f.census);
  assert.equal(none.final, "idle", "no pool event for idleSec after the completion");
  assert.equal(none.firstPoolSec, null);
  assert.equal(none.events, 0);
  assert.equal(none.ratio10s, null);
  assert.equal(none.minRatioAll, null);

  // stall / gap flags reach the pools being watched
  const s = poolCensus();
  C.noteStall(s.f.census, 40_000, (T0 + 120) * 1000);
  assert.equal(C.finishPoolsAtStop(s.f.census)[0].stall, true);

  // CENSUS_POOL=0: rev-1 behaviour (still censusRev 3)
  const off = feeder({ pool: false });
  const m = key(1140);
  off.create(m, { creator: key(1141), ts: T0 });
  const [mig] = off.trade(m, 100, { ts: T0 + 10 });
  assert.equal(mig.censusRev, 3);
  assert.equal(off.census.pools, null);
  assert.deepEqual(C.handlePoolLogs(off.census, poolLogs([W.pumpSwapPayload(W.poolSim(MP).trade({ side: "buy", sol: 1, pool: S.canonicalPool(new PublicKey(m)).toBase58(), user: A, ts: T0 + 11 }))]), { nowMs: (T0 + 11) * 1000 }), []);
  assert.deepEqual(C.finishPoolsAtStop(off.census), []);
  assert.equal(C.memRow(off.census, T0 * 1000).poolMode, "off");
  // census_mint rows: the same keys as rev 1 (only censusRev changed) + #21e mayhem (always present)
  assert.deepEqual(Object.keys(mig), ["type", "censusRev", "mint", "createSec", "createSeen", "launcher", "isCreator", "launches24h", "devBuySol", "hourUtc", "maxFill", "trades", "uniqueTraders", "lastSec", "final", "maxLagSec", "name", "symbol", "creator", "creatorSource", "firstSec", "firstSeenFill", "maxFillSec", "migrated", "completeSec", "milestones", "mayhem"]);

  // env
  const e = C.parseCensusEnv({});
  assert.deepEqual([e.pool, e.poolWatchSec, e.poolMode], [true, 3600, "a"]);
  assert.deepEqual([C.parseCensusEnv({ CENSUS_POOL: "0" }).pool, C.parseCensusEnv({ CENSUS_POOL_MODE: "b" }).poolMode], [false, "b"]);
  for (const [k_, v] of [["CENSUS_POOL", "no"], ["CENSUS_POOL_WATCH_SEC", "0"], ["CENSUS_POOL_WATCH_SEC", "1.5"], ["CENSUS_POOL_MODE", "c"]]) assert.throws(() => C.parseCensusEnv({ [k_]: v }), new RegExp(k_), `${k_}=${v} rejected`);
  ok("watch end on the event / by the clock (+5 s slack); shutdown partial; no pool event -> idle row; stall flag; CENSUS_POOL=0 -> no watch, same census_mint keys; env validation");
}

// ---- 12. subscriptions: subscribe at complete, unsubscribe at the end, reconnect, failover, mode b -------
{
  const WebSocketServer = (await import("ws")).default.Server; // ws@7
  const F = await import("../lib/rpc-failover.mjs");
  // section 6d loaded lib/ws.mjs with WS_MOCK set (read at load time): a second, real instance
  assert.equal(process.env.WS_MOCK, undefined);
  const { SolanaWs } = await import("../lib/ws.mjs?real-socket");
  const PUMP_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms = 5000) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await wait(20);
    return cond();
  };
  // A logs websocket: per connection, the mentions it was asked for and the ids it was told to drop.
  async function server({ rejectPools = false } = {}) {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.conns = [];
    wss.on("connection", (sock) => {
      const c = { sock, subs: [], unsubs: [], ids: new Map() };
      wss.conns.push(c);
      let next = 100 * wss.conns.length;
      sock.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.method === "logsUnsubscribe") {
          c.unsubs.push(c.ids.get(m.params[0]) ?? `unknown ${m.params[0]}`);
          sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: true }));
          return;
        }
        if (m.method !== "logsSubscribe") return;
        const mention = m.params[0].mentions[0];
        c.subs.push(mention);
        if (rejectPools && mention !== PUMP_ID && mention !== PUMPSWAP_ID) {
          sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "subscription limit per connection reached" } }));
          return;
        }
        next += 1;
        c.ids.set(next, mention);
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: next }));
      });
    });
    await new Promise((r) => wss.on("listening", r));
    wss.url = `http://127.0.0.1:${wss.address().port}`;
    return wss;
  }
  // the census glue of scripts/mint-census.mjs: pump subscription, then the pool stream
  function setup(ws, census) {
    const modeRows = [];
    ws.subscribeLogs(PUMP_ID, () => {});
    const stream = CP.attachPoolStream({ ws, pw: census.pools, programId: PUMPSWAP_ID, onLogs: () => {}, onRow: (r) => modeRows.push(r) });
    return { stream, modeRows };
  }
  const completeTwo = (f) => {
    const a = key(1201);
    const b = key(1202);
    for (const m of [a, b]) {
      f.create(m, { creator: key(1203), ts: T0 });
      f.trade(m, 100, { ts: T0 + 20 });
    }
    return [a, b].map((m) => S.canonicalPool(new PublicKey(m)).toBase58());
  };

  // (1) subscribe at the completion, unsubscribe at the watch end, reconnect resubscribes live pools only
  const s1 = await server();
  const ws = new SolanaWs(s1.url.replace("http", "ws"));
  ws.baseReconnectMs = 50;
  await ws.connect();
  const f = feeder({ idleSec: 300 });
  const { stream } = setup(ws, f.census);
  await until(() => s1.conns[0]?.subs.length === 1);
  assert.deepEqual(s1.conns[0].subs, [PUMP_ID], "no pool subscription before a completion");
  const [poolA, poolB] = completeTwo(f);
  assert.ok(await until(() => s1.conns[0].subs.length === 3), "one subscription per completed mint");
  assert.deepEqual(s1.conns[0].subs, [PUMP_ID, poolA, poolB]);
  assert.equal(stream.poolSubs, 2);
  await until(() => [...ws.subs.values()].every((x) => x.subId !== undefined));
  // pool A trades, then goes idle; pool B stays
  C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(W.poolSim(MP).trade({ side: "buy", sol: 1, pool: poolA, user: key(1204), ts: T0 + 25 }))]), { signature: "a1", nowMs: (T0 + 25) * 1000 });
  C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(W.poolSim(MP).trade({ side: "buy", sol: 1, pool: poolB, user: key(1204), ts: T0 + 300 }))]), { signature: "b1", nowMs: (T0 + 300) * 1000 });
  f.trade(key(1205), 3, { ts: T0 + 325 });
  const ended = C.sweepPoolWatch(f.census);
  assert.deepEqual(ended.map((r) => r.pool), [poolA], "pool A idle 300 s -> its row");
  assert.ok(await until(() => s1.conns[0].unsubs.length === 1), "logsUnsubscribe sent");
  assert.deepEqual(s1.conns[0].unsubs, [poolA], "the server dropped exactly pool A's subscription");
  assert.equal(stream.poolSubs, 1);
  assert.ok(![...ws.subs.values()].some((x) => x.params[0].mentions[0] === poolA), "pool A left ws.subs");
  // the socket drops: the reconnect resubscribes the pump program and pool B only
  s1.conns[0].sock.terminate();
  assert.ok(await until(() => s1.conns[1]?.subs.length === 2), "resubscribed after the reconnect");
  assert.deepEqual(s1.conns[1].subs.sort(), [PUMP_ID, poolB].sort(), "after a reconnect only the live pool is resubscribed");
  // an unsubscribe before the server confirmed: sent as soon as the confirmation arrives
  const early = ws.subscribeLogs(key(1206), () => {});
  ws.unsubscribe(early);
  assert.ok(await until(() => s1.conns[1].unsubs.length === 1), "an unconfirmed subscription is dropped on its confirmation");
  assert.deepEqual(s1.conns[1].unsubs, [key(1206)]);
  assert.equal(ws.unsubscribe(early), false, "a second unsubscribe is a no-op");
  await ws.close();
  s1.close();

  // (2) a failover switch moves the stream with the live pools
  const a1 = await server();
  const a2 = await server();
  const fo = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`${a1.url}/?api-key=FIXTUREKEYA,${a2.url}/?api-key=FIXTUREKEYB`), after: 1 });
  const ws2 = new SolanaWs("ws://127.0.0.1:1");
  ws2.baseReconnectMs = 50;
  ws2.useFailover(fo);
  await ws2.connect();
  const g = feeder({ idleSec: 300 });
  setup(ws2, g.census);
  const [gA, gB] = completeTwo(g);
  assert.ok(await until(() => a1.conns[0]?.subs.length === 3));
  g.census.pools.hooks.unwatch(gA); // the watch of A ends (as finishPool would do)
  assert.ok(await until(() => a1.conns[0].unsubs.length === 1));
  fo.fail("ws", "test-limit"); // after: 1 -> switch to #2
  assert.equal(fo.idx, 2);
  assert.ok(await until(() => a2.conns[0]?.subs.length === 2), "resubscribed on #2");
  assert.deepEqual(a2.conns[0].subs.sort(), [PUMP_ID, gB].sort(), "the failover switch keeps the live pool, not the ended one");
  await ws2.close();
  a1.close();
  a2.close();

  // (3) the server refuses pool subscriptions -> mode b, loudly; not an endpoint exhaustion
  const r1 = await server({ rejectPools: true });
  const fo3 = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`${r1.url}/?api-key=FIXTUREKEYR,${a2.url}`), after: 1 });
  const ws3 = new SolanaWs("ws://127.0.0.1:1");
  ws3.useFailover(fo3);
  await ws3.connect();
  const h = feeder();
  const logged = [];
  ws3.subscribeLogs(PUMP_ID, () => {});
  const st3 = CP.attachPoolStream({ ws: ws3, pw: h.census.pools, programId: PUMPSWAP_ID, onLogs: () => {}, log: (m) => logged.push(m), onRow: (r) => logged.push(r) });
  const [hA, hB] = completeTwo(h);
  assert.ok(await until(() => h.census.pools.mode === "b"), "a rejected pool subscription switches to mode b");
  assert.ok(await until(() => r1.conns[0].subs.includes(PUMPSWAP_ID)));
  await wait(100);
  assert.equal(r1.conns[0].subs.filter((x) => x === PUMPSWAP_ID).length, 1, "one program subscription, even with two rejections");
  assert.equal(st3.poolSubs, 1);
  assert.equal(fo3.switches, 0, "a pool subscription error is not an endpoint exhaustion signal");
  assert.ok(logged.some((x) => typeof x === "string" && /mode b/.test(x)), "loud log line");
  const modeRow = logged.find((x) => x?.type === "census_pool_mode");
  assert.deepEqual({ mode: modeRow.mode, watchedPools: modeRow.watchedPools }, { mode: "b", watchedPools: 2 });
  assert.ok(!KEY_TEXT.test(JSON.stringify(logged)), "no key text in the mode row / log");
  assert.ok(h.census.pools.byPool.has(hA) && h.census.pools.byPool.has(hB), "the watches continue (filtered from the program stream)");
  await ws3.close();
  r1.close();

  // (4) #21b: a PENDING pool (fill 93, no completion) survives a reconnect and a failover switch; once
  // dropped (the mint went idle) it is resubscribed by neither
  const p1 = await server();
  const p2 = await server();
  const fo4 = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`${p1.url}/?api-key=FIXTUREKEYC,${p2.url}/?api-key=FIXTUREKEYD`), after: 1 });
  const ws4 = new SolanaWs("ws://127.0.0.1:1");
  ws4.baseReconnectMs = 50;
  ws4.useFailover(fo4);
  await ws4.connect();
  const q = feeder({ idleSec: 300 });
  setup(ws4, q.census);
  const pm = key(1210);
  const pendPool = S.canonicalPool(new PublicKey(pm)).toBase58();
  q.create(pm, { creator: key(1211), ts: T0 });
  q.trade(pm, 93, { ts: T0 + 5 });
  assert.ok(await until(() => p1.conns[0]?.subs.length === 2), "pending pool subscribed at 93 %");
  assert.deepEqual(p1.conns[0].subs, [PUMP_ID, pendPool]);
  p1.conns[0].sock.terminate();
  assert.ok(await until(() => p1.conns[1]?.subs.length === 2), "reconnect");
  assert.deepEqual(p1.conns[1].subs.sort(), [PUMP_ID, pendPool].sort(), "the pending pool is resubscribed after a reconnect");
  fo4.fail("ws", "test-limit");
  assert.ok(await until(() => p2.conns[0]?.subs.length === 2), "failover switch");
  assert.deepEqual(p2.conns[0].subs.sort(), [PUMP_ID, pendPool].sort(), "and after a failover switch");
  await until(() => [...ws4.subs.values()].every((x) => x.subId !== undefined));
  q.trade(key(1212), 3, { ts: T0 + 5 + 300 });
  assert.equal(C.sweepIdle(q.census).find((r) => r.mint === pm).final, "idle");
  assert.ok(await until(() => p2.conns[0].unsubs.length === 1), "dropped -> logsUnsubscribe");
  assert.deepEqual(p2.conns[0].unsubs, [pendPool]);
  assert.ok(![...ws4.subs.values()].some((x) => x.params[0].mentions[0] === pendPool), "the dropped pool left ws.subs");
  p2.conns[0].sock.terminate();
  assert.ok(await until(() => p2.conns[1]?.subs.length >= 1));
  await wait(150);
  assert.deepEqual(p2.conns[1].subs, [PUMP_ID], "a dropped pending pool is not resubscribed");
  await ws4.close();
  p1.close();
  p2.close();
  ok("subscriptions: per pool at the completion, logsUnsubscribe at the end, reconnect / failover resubscribe live pools only, unconfirmed unsubscribe, rejection -> mode b (no failover); #21b pending pool kept over reconnect / failover, dropped one not");
}

// ==== #21b: pre-subscription at fill 92, the pool open, traffic ======================================
// ---- 13. pending watch: subscribed before the completion, kept events, dropped when the mint ends ----
{
  const mk = (cfg = {}) => {
    const f = feeder({ idleSec: 600, ...cfg });
    const watched = [];
    const unwatched = [];
    if (f.census.pools) {
      f.census.pools.hooks.watch = (p) => watched.push(p);
      f.census.pools.hooks.unwatch = (p) => unwatched.push(p);
    }
    return { f, watched, unwatched };
  };
  const A = key(1310);
  const pt = (f, pool, sim, o) => C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(sim.trade({ pool, user: A, ...o }))]), { signature: `t-${o.ts}-${o.side}`, nowMs: o.ts * 1000 + 300, pool });

  // (a) 92 -> subscribed, pending; the first pool trade 1 s after the completing curve event
  {
    const { f, watched } = mk();
    const m = key(1301);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.create(m, { creator: key(1302), ts: T0 });
    f.trade(m, 91.9, { ts: T0 + 10 });
    assert.deepEqual(watched, [], "91.9 %: not yet");
    f.trade(m, 92.5, { ts: T0 + 11 });
    assert.deepEqual(watched, [pool], "92.5 %: the pool is subscribed before it exists");
    assert.equal(f.census.pools.byPool.get(pool).pending, true);
    let mem = C.memRow(f.census, (T0 + 12) * 1000);
    assert.deepEqual([mem.poolPending, mem.poolLive, mem.poolPresubs], [1, 0, 1]);
    assert.deepEqual(C.sweepPoolWatch(f.census), [], "a pending watch has no window");
    f.trade(m, 95, { ts: T0 + 12 });
    assert.equal(watched.length, 1, "subscribed once");
    f.trade(m, 100, { ts: T0 + 20 });
    mem = C.memRow(f.census, (T0 + 21) * 1000);
    assert.deepEqual([mem.poolPending, mem.poolLive, mem.poolWatched], [0, 1, 1], "the completion activates the pending watch");
    const sim = W.poolSim(MP);
    pt(f, pool, sim, { side: "buy", sol: 1, ts: T0 + 21 });
    const [row] = C.finishPoolsAtStop(f.census);
    assert.equal(row.firstPoolSec, T0 + 21, "the first pool trade, 1 s after the completion");
    assert.equal(row.poolDelaySec, 1);
    assert.equal(row.quoteReserveSolAtFirst, 68.3, "the vault at the first trade = the open vault (nothing missed)");
    assert.equal(row.t0, "trade", "no CreatePoolEvent seen -> t0 trade");
    assert.equal(row.poolOpenPrice, null);
  }
  // (b) a pool trade BEFORE the completing curve event reaches us: kept, it is t = 0
  {
    const { f } = mk();
    const m = key(1303);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.create(m, { creator: key(1304), ts: T0 });
    f.trade(m, 96, { ts: T0 + 10 });
    const sim = W.poolSim(MP);
    const first = sim.st.quote;
    pt(f, pool, sim, { side: "buy", sol: 2, ts: T0 + 30 });
    f.trade(m, 100, { ts: T0 + 29 }); // the curve's completing event arrives after the pool trade
    pt(f, pool, sim, { side: "sell", tokens: 1e12, ts: T0 + 31 });
    const [row] = C.finishPoolsAtStop(f.census);
    assert.equal(row.firstPoolSec, T0 + 30, "the pool trade that came before the completion is kept as t = 0");
    assert.equal(row.poolDelaySec, 1);
    assert.equal(row.events, 2);
    assert.equal(row.quoteReserveSolAtFirst, Number(first) / 1e9);
    assert.ok(row.ratioOpen > 0.99 && row.ratioOpen < 1.01, "ratios use the curve end known only at the completion");
    assert.ok(row.maxRatioAll > row.ratioOpen, "price after the 2 SOL buy");
  }
  // (c) reaches 92, then goes idle -> dropped: unsubscribed, no row, counted
  {
    const { f, watched, unwatched } = mk();
    const m = key(1305);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.create(m, { creator: key(1306), ts: T0 });
    f.trade(m, 93, { ts: T0 + 5 });
    f.trade(key(1307), 3, { ts: T0 + 5 + 600 });
    const rows = C.sweepIdle(f.census);
    assert.equal(rows.find((r) => r.mint === m).final, "idle");
    assert.deepEqual([watched, unwatched], [[pool], [pool]], "the idle row drops the pending pool");
    assert.equal(f.census.pools.byPool.size, 0);
    assert.deepEqual(C.sweepPoolWatch(f.census), []);
    assert.deepEqual(C.finishPoolsAtStop(f.census), [], "no census_pool row");
    const mem = C.memRow(f.census, (T0 + 700) * 1000);
    assert.deepEqual([mem.poolPresubDropped, mem.poolPending, mem.poolRows], [1, 0, 0]);
    // the mint comes back and crosses 92 again: subscribed again
    f.trade(m, 94, { ts: T0 + 700 });
    assert.deepEqual(watched, [pool, pool]);
    // shutdown of a pending mint: dropped too, still no row
    C.finishAll(f.census);
    assert.equal(unwatched.length, 2);
    assert.deepEqual(C.finishPoolsAtStop(f.census), []);
    assert.equal(C.memRow(f.census, (T0 + 701) * 1000).poolPresubDropped, 2);
  }
  // (d) CENSUS_POOL_PRESUB_FILL=100: subscribed at the completion only (#21 behaviour)
  {
    const { f, watched } = mk({ poolPresubFill: 100 });
    const m = key(1308);
    f.create(m, { creator: key(1309), ts: T0 });
    f.trade(m, 97, { ts: T0 + 5 });
    assert.deepEqual(watched, [], "100: nothing before the completion");
    f.trade(m, 100, { ts: T0 + 6 });
    assert.deepEqual(watched, [S.canonicalPool(new PublicKey(m)).toBase58()]);
    assert.equal(C.memRow(f.census, (T0 + 7) * 1000).poolPresubs, 0);
    assert.equal(C.parseCensusEnv({}).poolPresubFill, 92);
    assert.equal(C.parseCensusEnv({ CENSUS_POOL_PRESUB_FILL: "100" }).poolPresubFill, 100);
    for (const v of ["49", "101", "x"]) assert.throws(() => C.parseCensusEnv({ CENSUS_POOL_PRESUB_FILL: v }), /CENSUS_POOL_PRESUB_FILL/);
  }
  ok("pre-subscription: at 92 % (pending, no window), activated at the completion, first trade = open vault; a trade before the completion kept; idle / shutdown -> dropped, no row, counted; 100 = at completion");
}

// ---- 14. the pool open: CreatePoolEvent (real fixture offsets) -> poolOpenSec / openRatio / t0 -------
{
  const CR = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "amm-create-pool-events.json"), "utf8"));
  assert.ok(!/https?:|api-key/i.test(JSON.stringify(CR)), "the create fixture carries no URL / key");
  let canonical = 0;
  let realOpenRatio = null;
  for (const c of CR.events) {
    const ev = S.parsePumpSwapCreatePool(Buffer.from(c.eventHex, "hex"));
    assert.ok(ev, "decodes");
    assert.equal(ev.pool, c.pool);
    const first = S.parsePumpSwapTrade(Buffer.from(c.firstTradeHex, "hex"));
    assert.equal(first.pool, c.pool);
    assert.deepEqual([ev.poolBase, ev.poolQuote], [first.poolBase, first.poolQuote + first.virtualQuote], `${c.pool.slice(0, 6)}: the pool's first trade starts from the open reserves (vault + virtual = the open quote)`);
    assert.ok(ev.timestampSec <= first.timestampSec);
    if (S.canonicalPool(new PublicKey(ev.baseMint)).toBase58() === ev.pool) {
      canonical += 1;
      assert.deepEqual([ev.baseDecimals, ev.quoteDecimals, ev.quoteMint], [6, 9, "So11111111111111111111111111111111111111112"], "a pump migration: token / WSOL");
      if (!ev.isMayhem) {
        const open = S.quotePerBase(ev.poolQuote, ev.poolBase);
        const curveEnd = (115e9 / 279.9e12) * 1e-3;
        assert.ok(open / curveEnd > 0.999 && open / curveEnd < 1.001, `pump pool opens at the curve's last price: ${(open / curveEnd).toFixed(5)}`);
        assert.ok(first.virtualQuote > 0n && first.poolQuote < ev.poolQuote, "the virtual part is split off the open quote");
        realOpenRatio = open / curveEnd;
      }
    }
  }
  assert.ok(canonical >= CR.minCanonical, `canonical (pump migration) events in the fixture: ${canonical}`);
  assert.ok(realOpenRatio !== null, "a non-mayhem pump migration is in the fixture");
  // in the census: the open in a pending watch, then the first trade at the open reserves
  const f = feeder();
  const m = key(1401);
  const pool = S.canonicalPool(new PublicKey(m)).toBase58();
  f.create(m, { creator: key(1402), ts: T0 });
  f.trade(m, 95, { ts: T0 + 5 });
  f.trade(m, 100, { ts: T0 + 9 });
  const openLogs = poolLogs([W.createPoolPayload({ ts: T0 + 11, pool, baseMint: m, poolBase: MP.base, poolQuote: MP.quote + MP.virtual })]);
  C.handlePoolLogs(f.census, openLogs, { signature: "open", nowMs: (T0 + 11) * 1000 + 300, pool });
  const sim = W.poolSim(MP);
  C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(sim.trade({ side: "buy", sol: 1, pool, user: key(1403), ts: T0 + 13 }))]), { signature: "t1", nowMs: (T0 + 13) * 1000 + 300, pool });
  const [row] = C.finishPoolsAtStop(f.census);
  assert.equal(row.t0, "create");
  assert.equal(row.poolOpenSec, T0 + 11);
  assert.equal(row.firstTradeAfterOpenSec, 2);
  assert.equal(row.firstTradeAtOpen, true);
  assert.equal(row.quoteReserveSolAtOpen, 85.75, "the open quote = vault + virtual");
  assert.equal(row.quoteReserveSolAtFirst, 68.3, "the vault at the first trade (the virtual part split off)");
  assert.equal(row.poolMayhem, false);
  assert.equal(row.poolOpenPrice, Number(((85.75e9 / 800e12) * 1e-3).toPrecision(6)), "open price = pool_quote_amount / pool_base_amount");
  assert.equal(row.openRatio, Math.round((((85.75e9 / 800e12) * 1e-3) / priceAt(100)) * 1e4) / 1e4);
  assert.equal(row.firstPoolSec, T0 + 13, "t = 0 stays the first pool TRADE");
  assert.equal(C.memRow(f.census, (T0 + 14) * 1000).poolOpens, 1);
  // a trade was missed between the open and the first trade seen -> firstTradeAtOpen false
  const g = feeder();
  const n = key(1404);
  const poolN = S.canonicalPool(new PublicKey(n)).toBase58();
  g.trade(n, 99, { ts: T0 });
  g.trade(n, 100, { ts: T0 + 1 });
  C.handlePoolLogs(g.census, poolLogs([W.createPoolPayload({ ts: T0 + 2, pool: poolN, baseMint: n, poolBase: MP.base, poolQuote: MP.quote + MP.virtual })]), { signature: "o2", nowMs: (T0 + 2) * 1000, pool: poolN });
  const sim2 = W.poolSim(MP);
  sim2.trade({ side: "buy", sol: 3, pool: poolN, user: key(1405), ts: T0 + 3 }); // never delivered
  C.handlePoolLogs(g.census, poolLogs([W.pumpSwapPayload(sim2.trade({ side: "buy", sol: 1, pool: poolN, user: key(1405), ts: T0 + 4 }))]), { signature: "t2", nowMs: (T0 + 4) * 1000, pool: poolN });
  assert.equal(C.finishPoolsAtStop(g.census)[0].firstTradeAtOpen, false);
  ok(`pool open: ${CR.events.length} real CreatePoolEvents (${canonical} pump migrations, open / curve end ${realOpenRatio.toFixed(5)}) start their pool's first trade; t0 create, poolOpenSec, openRatio, firstTradeAtOpen`);
}

// ---- 15. traffic per pool: notes / failedNotes / logKB, by window ------------------------------------
{
  const f = feeder({ idleSec: 3000 });
  const m = key(1501);
  const pool = S.canonicalPool(new PublicKey(m)).toBase58();
  f.create(m, { creator: key(1502), ts: T0 });
  f.trade(m, 100, { ts: T0 + 5 });
  const sim = W.poolSim(MP);
  const failedLogs = [`Program ${PUMPSWAP_ID} invoke [1]`, `Program ${PUMPSWAP_ID} failed: custom program error: 0x1774`];
  const bytesOf = (logs) => logs.reduce((a, l) => a + l.length, 0);
  let bytes = 0;
  const note = (logs, ts, extra = {}) => {
    bytes += bytesOf(logs);
    f.trade(key(1503), 3, { ts }); // moves the stream clock
    return C.handlePoolLogs(f.census, logs, { signature: `n-${ts}-${extra.failed ? "f" : "ok"}`, nowMs: ts * 1000 + 200, pool, ...extra });
  };
  note(failedLogs, T0 + 6, { failed: true }); // before the first trade: "pre"
  const L1 = poolLogs([W.pumpSwapPayload(sim.trade({ side: "buy", sol: 1, pool, user: key(1504), ts: T0 + 7 }))]);
  note(L1, T0 + 7); // t = 0
  note(failedLogs, T0 + 100, { failed: true }); // [0, 5 m)
  note(poolLogs([W.pumpSwapPayload(sim.trade({ side: "sell", tokens: 1e12, pool, user: key(1504), ts: T0 + 7 + 400 }))]), T0 + 7 + 400); // [5, 15 m)
  note(poolLogs([W.pumpSwapPayload(sim.trade({ side: "buy", sol: 0.2, pool, user: key(1505), ts: T0 + 7 + 1000 }))]), T0 + 7 + 1000); // [15, 60 m)
  // mode b attribution: a successful transaction holding this pool's event (no `pool` given)
  const L2 = poolLogs([W.pumpSwapPayload(sim.trade({ side: "buy", sol: 0.1, pool, user: key(1505), ts: T0 + 7 + 1001 }))]);
  bytes += bytesOf(L2);
  C.handlePoolLogs(f.census, L2, { signature: "mode-b", nowMs: (T0 + 7 + 1001) * 1000 });
  const [row] = C.finishPoolsAtStop(f.census);
  assert.deepEqual([row.notes, row.failedNotes], [6, 2]);
  assert.equal(row.logKB, Math.round((bytes / 1024) * 10) / 10);
  assert.deepEqual(Object.keys(row.traffic), ["pre", "m0_5", "m5_15", "m15_60"]);
  assert.deepEqual([row.traffic.pre.notes, row.traffic.pre.failedNotes], [1, 1]);
  assert.deepEqual([row.traffic.m0_5.notes, row.traffic.m0_5.failedNotes], [2, 1]);
  assert.equal(row.traffic.m5_15.notes, 1);
  assert.equal(row.traffic.m15_60.notes, 2);
  assert.equal(C.memRow(f.census, T0 * 1000).poolFailedTx, 2);
  ok("traffic: notes / failedNotes / logKB per pool row; windows pre / 0-5 m / 5-15 m / 15-60 m; mode b counts transactions holding the pool's event");
}

// ---- 16. rev 3 (#21c): fill from the token side (other-quote and mayhem curves) ----------------------
{
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const feedRaw = (f, p, ts) => C.handleLogs(f.census, [DATA(p), "Program x success"], { slot: 5, nowMs: ts * 1000 + 300 });
  const ct = (o) => W.curveTradePayload({ user: key(1601), ...o });
  // the formula: SOL-equivalent fill on the constant-product curve (NOT the share of tokens sold)
  assert.ok(Math.abs(C.tokenFill(1_073_000_000_000_000n)) < 1e-9, "launch -> 0");
  assert.equal(Number(C.tokenFill(279_900_000_000_000n).toFixed(3)), 100.006, "real tokens 0 -> 100.006 (85.005 SOL)");
  const half = 1.073e15 - 0.5 * 793.1e12; // half of the tokens sold
  assert.equal(Number(C.tokenFill(half).toFixed(1)), 20.7, "50 % of the tokens sold = 20.7 % fill");
  for (const fill of [25, 50, 92, 99]) assert.ok(Math.abs(C.tokenFill(W.vTokAtFill(fill)) - fill) < 1e-6);
  // a normal SOL curve: the token side gives the SOL fill (real constant product)
  {
    const vTok = W.vTokAtFill(60);
    const vSol = (30e9 * 1.073e15) / Number(vTok);
    assert.ok(Math.abs(C.tokenFill(vTok) - ((vSol - 30e9) / 85e9) * 100) < 1e-6);
  }

  // (a) SOL-quoted curve with priced and unpriced events (the hypothetical rev-2 case): milestones, presub
  //     at 92 on an unpriced event, completion on an unpriced event
  {
    const f = feeder();
    const watched = [];
    f.census.pools.hooks.watch = (p) => watched.push(p);
    const m = key(1610);
    const solAt = (fill) => {
      const vTok = W.vTokAtFill(fill);
      const vSol = BigInt(Math.round((30e9 * 1.073e15) / Number(vTok)));
      return { vTok, sol: { vSol, realSol: vSol - 30_000_000_000n } };
    };
    f.create(m, { creator: key(1611), ts: T0 });
    feedRaw(f, ct({ mint: m, ts: T0 + 1, ...solAt(30) }), T0 + 1); // priced
    feedRaw(f, ct({ mint: m, ts: T0 + 2, ...solAt(60) }), T0 + 2); // priced
    feedRaw(f, ct({ mint: m, ts: T0 + 3, vTok: W.vTokAtFill(80) }), T0 + 3); // unpriced: token side
    assert.deepEqual(watched, [], "80 %: no presub");
    feedRaw(f, ct({ mint: m, ts: T0 + 4, vTok: W.vTokAtFill(93) }), T0 + 4); // unpriced, 93 %
    assert.equal(watched.length, 1, "presub at 92 on an unpriced event (token side)");
    const rows = feedRaw(f, ct({ mint: m, ts: T0 + 6, vTok: 279_900_000_000_000n }), T0 + 6); // unpriced completion
    const r = rows.find((x) => x.type === "census_mint");
    assert.equal(r.final, "complete", "the completion on an unpriced event counts");
    assert.equal(r.migrated, true);
    assert.equal(r.maxFill, 100.01);
    assert.equal(r.tokenFillEvents, 3);
    assert.deepEqual(Object.keys(r.milestones), ["25", "50", "75", "85", "92", "97", "100"]);
    assert.deepEqual(["25", "50", "75", "85", "92", "100"].map((k) => r.milestones[k].fillSource), ["price", "price", "token", "token", "token", "token"]);
    assert.equal(r.milestones["75"].price, null, "no derived price on a token-side event");
    assert.ok(r.milestones["50"].price > 0);
    assert.equal(r.milestones["75"].ratioMinAfter, null, "a token-side milestone has no price: no ratio (never 0)");
    assert.equal(r.milestones["25"].secTo100, 5);
    assert.ok(!("quoteMint" in r) && r.mayhem === false, "#21e: a parsed non-mayhem tail -> mayhem false");
    const [p] = C.finishPoolsAtStop(f.census);
    assert.deepEqual([p.completeSeen, p.curveEndSource, p.curveEndPrice], [true, "standard", C.STANDARD_CURVE_END], "unpriced completion of a normal SOL curve: the constant curve end");
    assert.equal(C.memRow(f.census, (T0 + 7) * 1000).tokenFill, 3);
  }
  // (b) a curve quoted in another mint (USDC): token-side fill, no SOL price, no pool watch
  {
    const f = feeder();
    const watched = [];
    f.census.pools.hooks.watch = (p) => watched.push(p);
    const m = key(1620);
    for (const [i, fill] of [10, 40, 95].entries()) feedRaw(f, ct({ mint: m, ts: T0 + i, vTok: W.vTokAtFill(fill), quoteMint: USDC, ixName: "buy_exact_quote_in" }), T0 + i);
    assert.deepEqual(watched, [], "another quote mint: no presub (its pool is not the WSOL one)");
    const [r] = feedRaw(f, ct({ mint: m, ts: T0 + 9, vTok: 279_900_000_000_000n, quoteMint: USDC }), T0 + 9);
    assert.deepEqual([r.final, r.migrated, r.quoteMint, r.tokenFillEvents, r.unpricedTrades, r.maxFill], ["complete", true, USDC, 4, 4, 100.01]);
    assert.equal(r.milestones["92"].fillSource, "token");
    assert.equal(f.census.pools.byPool.size, 0, "no pool watch");
    assert.equal(C.memRow(f.census, (T0 + 10) * 1000).poolSkipped, 1);
  }
  // (c) mayhem: priced events whose SOL side is cut (completes with ~0.4 SOL): token-side fill, the
  //     completion seen, pool watched against the completing event's own (tiny) price
  {
    const f = feeder();
    const m = key(1630);
    const may = (fill, realSol, ts) => {
      const vTok = W.vTokAtFill(fill);
      return ct({ mint: m, ts, vTok, mayhem: true, sol: { vSol: realSol + 450_000_000n, realSol } });
    };
    f.create(m, { creator: key(1631), ts: T0 });
    feedRaw(f, may(30, 100_000_000n, T0 + 1), T0 + 1);
    feedRaw(f, may(80, 300_000_000n, T0 + 2), T0 + 2);
    const rows = feedRaw(f, ct({ mint: m, ts: T0 + 3, vTok: 279_900_000_000_000n, mayhem: true, sol: { vSol: 862_452_427n, realSol: 412_206_538n } }), T0 + 3);
    const r = rows.find((x) => x.type === "census_mint");
    assert.equal(r.migrated, true, "mayhem completion at 0.41 SOL raised (SOL fill 0.48 %) is seen");
    assert.equal(r.mayhem, true);
    assert.equal(r.milestones["25"].fillSource, "token");
    assert.ok(r.milestones["25"].price > 0, "a mayhem event keeps its own SOL price");
    const [p] = C.finishPoolsAtStop(f.census);
    assert.deepEqual([p.curveEndSource, p.curveEndPrice], ["price", Number(((862_452_427 / 279.9e12) * 1e-3).toPrecision(6))]);
  }
  // (d) a non-standard token side stays as before: unpriced -> unknown; priced -> the SOL fill
  {
    const f = feeder();
    const u = key(1640);
    feedRaw(f, ct({ mint: u, ts: T0, vTok: 900_000_000_000_000n, rTok: 688_200_000_000_000n }), T0); // offset 211.8e12, unpriced
    const p = key(1641);
    feedRaw(f, ct({ mint: p, ts: T0, vTok: 900_000_000_000_000n, rTok: 688_200_000_000_000n, sol: { vSol: 34_000_000_000n, realSol: 4_250_000_000n } }), T0);
    const g = feeder();
    const mh = key(1642);
    feedRaw(g, ct({ mint: mh, ts: T0, vTok: 900_000_000_000_000n, rTok: 688_200_000_000_000n, mayhem: true }), T0); // mayhem, non-standard, unpriced
    const rows = [...C.finishAll(f.census), ...C.finishAll(g.census)];
    const by = (m) => rows.find((x) => x.mint === m);
    assert.equal(by(u).maxFill, null, "non-standard token side, unpriced: still unknown");
    assert.ok(!("tokenFillEvents" in by(u)));
    assert.equal(by(p).maxFill, 5, "non-standard token side, priced: the SOL fill");
    assert.equal(by(mh).maxFill, null, "mayhem with a non-standard token side stays unpriced");
  }
  // (e) real events of the 2026-11-17 stream (fixture): the tail decodes, the token side agrees
  {
    const FX = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pump-curve-events.json"), "utf8"));
    assert.ok(!/https?:|api-key/i.test(JSON.stringify(FX)), "the curve fixture carries no URL / key");
    const seen = { other: 0, mayhem: 0, plain: 0, nonStd: 0 };
    for (const e of FX.events) {
      const d = Buffer.from(e.hex, "hex");
      const tail = C.tradeTail(d);
      assert.equal(tail.quoteMint, e.quoteMint, `${e.kind}: quote mint`);
      assert.equal(tail.mayhem, e.mayhem, `${e.kind}: mayhem flag`);
      const tok = C.tokenSide(d);
      const vSol = d.readBigUInt64LE(97);
      if (!tok.std) {
        seen.nonStd += 1;
        continue;
      }
      const tf = C.tokenFill(tok.vTok);
      if (vSol === 0n) {
        // other quote: the token side vs the quote side (real quote / (initial virtual quote x 85 / 30))
        seen.other += 1;
        const fq = (Number(e.realQuote) / ((Number(e.virtualQuote) - Number(e.realQuote)) * (85 / 30))) * 100;
        assert.ok(Math.abs(tf - fq) < 0.05, `other quote: token fill ${tf.toFixed(4)} vs quote fill ${fq.toFixed(4)}`);
      } else if (e.mayhem) seen.mayhem += 1;
      else {
        seen.plain += 1;
        const fs_ = (Number(d.readBigUInt64LE(113)) / 85e9) * 100;
        assert.ok(Math.abs(tf - fs_) < 0.001, `normal SOL curve: token fill ${tf.toFixed(5)} = SOL fill ${fs_.toFixed(5)}`);
      }
    }
    assert.ok(seen.other >= 3 && seen.mayhem >= 2 && seen.plain >= 3 && seen.nonStd >= 1, JSON.stringify(seen));
    // the real mayhem completion: SOL fill < 1 %, token side at 0 real tokens -> a migration row
    const f = feeder();
    let row = null;
    for (const e of FX.mayhemCompletion.events) row = feedRaw(f, Buffer.from(e.hex, "hex"), e.ts).find((x) => x.type === "census_mint") ?? row;
    assert.ok(row && row.migrated === true && row.mayhem === true, "the real mayhem completion makes a migration row");
    assert.ok(Number(Buffer.from(FX.mayhemCompletion.events.at(-1).hex, "hex").readBigUInt64LE(113)) < 1e9, "with < 1 SOL raised");
  }
  // (f) the live run's data bugs: a fill that no curve can have (1.8e9 %) and a rounded 100 with tokens left
  {
    const f = feeder();
    const bogus = key(1650);
    f.trade(bogus, (300e9 / REAL_100) * 100, { ts: T0 }); // realSol 300 SOL -> fill 353 %
    const may = key(1651);
    const left = 5_000_000_000n; // 5 000 tokens left on the curve -> tokenFill 99.998 -> r2 100.00
    const near = feedRaw(f, ct({ mint: may, ts: T0 + 1, vTok: 279_900_000_000_000n + left, mayhem: true, sol: { vSol: 700_000_000n, realSol: 300_000_000n } }), T0 + 1);
    assert.deepEqual(near, [], "tokens left: not a completion although the rounded fill is 100.00");
    const done = feedRaw(f, ct({ mint: may, ts: T0 + 2, vTok: 279_900_000_000_000n, mayhem: true, sol: { vSol: 700_000_000n, realSol: 300_000_000n } }), T0 + 2);
    assert.equal(done.find((x) => x.type === "census_mint").migrated, true, "real tokens 0: the completion");
    const [b] = C.finishAll(f.census);
    assert.deepEqual([b.mint, b.maxFill, b.migrated ?? null], [bogus, null, null], "an impossible fill is not a migration");
    assert.equal(C.memRow(f.census, (T0 + 3) * 1000).badFill, 1);
  }
  ok("token-side fill: formula; SOL curve priced + unpriced -> milestones (fillSource), presub at 92 and completion on unpriced events; other quote -> no pool; mayhem completion seen; non-standard stays; real fixture agrees");
}

// ---- 17. rev 3 (#21c): a pending pool activates on its own event without the curve completion --------
{
  const mk = () => {
    const f = feeder({ idleSec: 600 });
    return f;
  };
  const sim = () => W.poolSim(MP);
  // (a) by the CreatePoolEvent: completeSec = its second; the mint row is a migration (completeSeen false)
  {
    const f = mk();
    const m = key(1701);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.create(m, { creator: key(1702), ts: T0 });
    f.trade(m, 93, { ts: T0 + 5 }); // pending; the completion is never delivered
    const rows = C.handlePoolLogs(f.census, poolLogs([W.createPoolPayload({ ts: T0 + 9, pool, baseMint: m, poolBase: MP.base, poolQuote: MP.quote + MP.virtual })]), { signature: "c1", nowMs: (T0 + 9) * 1000, pool });
    const r = rows.find((x) => x.type === "census_mint");
    assert.deepEqual([r.final, r.migrated, r.completeSec, r.completeSeen], ["complete", true, T0 + 9, false], "the mint row: migrated, completion not seen");
    assert.equal(f.census.pools.byPool.get(pool).pending, false);
    const s = sim();
    C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(s.trade({ side: "buy", sol: 1, pool, user: key(1703), ts: T0 + 10 }))]), { signature: "c2", nowMs: (T0 + 10) * 1000, pool });
    const [p] = C.finishPoolsAtStop(f.census);
    assert.deepEqual([p.completeSeen, p.completeSec, p.curveEndSource, p.curveEndPrice, p.t0, p.poolDelaySec], [false, T0 + 9, "standard", C.STANDARD_CURVE_END, "create", 1]);
    const mem = C.memRow(f.census, (T0 + 11) * 1000);
    assert.deepEqual([mem.poolActivatedNoComplete, mem.poolPresubDroppedTraded, mem.migrated], [1, 0, 1]);
  }
  // (b) by a pool trade: completeSec null; the idle end counts from the activation
  {
    const f = mk();
    const m = key(1711);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.trade(m, 95, { ts: T0 });
    const s = sim();
    const rows = C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(s.trade({ side: "buy", sol: 1, pool, user: key(1712), ts: T0 + 3 }))]), { signature: "d1", nowMs: (T0 + 3) * 1000, pool });
    assert.deepEqual(rows.filter((x) => x.type === "census_mint").map((x) => [x.migrated, x.completeSec, x.completeSeen]), [[true, null, false]]);
    f.trade(key(1713), 5, { ts: T0 + 3 + 599 });
    assert.deepEqual(C.sweepPoolWatch(f.census), [], "599 s after the activation: still watched");
    f.trade(key(1713), 6, { ts: T0 + 3 + 600 });
    const [p] = C.sweepPoolWatch(f.census);
    assert.deepEqual([p.final, p.completeSeen, p.completeSec, p.poolDelaySec, p.firstPoolSec, p.events], ["idle", false, null, null, T0 + 3, 1]);
  }
  // (c) a mayhem curve: no constant end -> its last SOL price, with that event's fill
  {
    const f = mk();
    const m = key(1721);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    const vTok = W.vTokAtFill(94);
    C.handleLogs(f.census, [DATA(W.curveTradePayload({ mint: m, user: key(1722), ts: T0, vTok, mayhem: true, sol: { vSol: 700_000_000n, realSol: 300_000_000n } })), "Program x success"], { nowMs: T0 * 1000 });
    assert.ok(f.census.pools.byPool.get(pool)?.pending, "mayhem presub on the token-side fill");
    C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(sim().trade({ side: "buy", sol: 1, pool, user: key(1723), ts: T0 + 2 }))]), { signature: "e1", nowMs: (T0 + 2) * 1000, pool });
    const [p] = C.finishPoolsAtStop(f.census);
    assert.deepEqual([p.curveEndSource, p.curveEndPrice, p.curveEndFill], ["lastPrice", Number(((700_000_000 / Number(vTok)) * 1e-3).toPrecision(6)), 94]);
  }
  // (d) the completion arrives AFTER the activation (two streams): the watch takes the real curve end
  {
    const f = mk();
    const m = key(1731);
    const pool = S.canonicalPool(new PublicKey(m)).toBase58();
    f.create(m, { creator: key(1732), ts: T0 });
    f.trade(m, 96, { ts: T0 + 10 });
    const s = sim();
    const rows = C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(s.trade({ side: "buy", sol: 2, pool, user: key(1733), ts: T0 + 30 }))]), { signature: "f1", nowMs: (T0 + 30) * 1000, pool });
    assert.equal(rows.find((x) => x.type === "census_mint").completeSeen, false);
    f.trade(m, 100, { ts: T0 + 29 }); // the curve's completing event, late
    const [p] = C.finishPoolsAtStop(f.census);
    assert.deepEqual([p.completeSeen, p.lateComplete, p.completeSec, p.curveEndSource, p.curveEndPrice, p.poolDelaySec], [true, true, T0 + 29, "price", priceAt(100), 1]);
    assert.equal(C.memRow(f.census, (T0 + 31) * 1000).poolLateComplete, 1);
  }
  ok("activation without the completion: by CreatePoolEvent (completeSec = its second) / by a pool trade (null), mint row migrated completeSeen false, standard / mayhem lastPrice curve end, late completion fixes the watch, poolPresubDroppedTraded 0");
}

// ---- 18. rev 3 (#21c): the outlier pools — real data, signed virtual quote, poolOdd ------------------
{
  const OJ = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "amm-open-jump-events.json"), "utf8"));
  assert.ok(!/https?:|api-key/i.test(JSON.stringify(OJ)), "the outlier fixture carries no URL / key");
  const J = OJ.jQVZ;
  const ev = (t, i) => Buffer.from(J.txs[t].events[i].hex, "hex");
  const create = S.parsePumpSwapCreatePool(ev(0, 0));
  assert.equal(create.pool, J.pool);
  assert.equal(S.canonicalPool(new PublicKey(J.mint)).toBase58(), J.pool, "the canonical WSOL pool");
  assert.equal(create.quoteMint, "So11111111111111111111111111111111111111112");
  const b1 = S.parsePumpSwapTrade(ev(1, 0));
  const b2 = S.parsePumpSwapTrade(ev(1, 1));
  const b3 = S.parsePumpSwapTrade(ev(2, 0));
  assert.equal(b2.userQuote, 5_390_414_840_783n, "a real 5 390 SOL buy in the opening slot");
  assert.equal(b2.baseAmount, 201_274_388_075_115n);
  assert.equal(String(b3.poolBase), J.txs[1].poolBalancesAfter.base, "decoded base = the pool token account after the tx");
  assert.equal(String(b3.poolQuote), J.txs[1].poolBalancesAfter.quote, "decoded vault = the pool WSOL account after the tx");
  assert.ok(b3.virtualQuote < 0n, "virtual_quote_reserves is negative here");
  // the constant product (vault + virtual) x base grows only by fees across the 5 390 SOL buy — with
  // the SIGNED virtual; clamping it to 0 (rev 2) breaks it by > 0.6 %
  const k = (q, v, b) => Number(q + v) * Number(b);
  const k0 = k(b2.poolQuote, b2.virtualQuote, b2.poolBase);
  const kSigned = k(b3.poolQuote, b3.virtualQuote, b3.poolBase) / k0 - 1;
  const kClamped = k(b3.poolQuote, 0n, b3.poolBase) / k0 - 1;
  assert.ok(kSigned >= 0 && kSigned < 0.005, `signed: k grows by fees only (${(kSigned * 100).toFixed(3)} %)`);
  assert.ok(kClamped > 0.006, `clamped: off by ${(kClamped * 100).toFixed(3)} %`);
  const pr = S.poolTradePrices(b3);
  assert.equal(pr.before, S.quotePerBase(b3.poolQuote + b3.virtualQuote, b3.poolBase), "price with the signed virtual part");
  // in the census: first seen = the trade after the big buy -> poolOdd openJump (data real, not a bug)
  // a standard SOL curve (constant product on the token side) up to its completion: curve end 4.1088e-7
  const stdTrade = (f, mint, fill, ts) => {
    const vTok = fill >= 100 ? 279_900_000_000_000n : W.vTokAtFill(fill);
    const vSol = BigInt(Math.round((30e9 * 1.073e15) / Number(vTok)));
    return C.handleLogs(f.census, [DATA(W.curveTradePayload({ mint, user: key(1801), ts, vTok, sol: { vSol, realSol: vSol - 30_000_000_000n } })), "Program x success"], { nowMs: ts * 1000 + 500 });
  };
  const run = (txs) => {
    const f = feeder();
    stdTrade(f, J.mint, 99, create.timestampSec - 2);
    stdTrade(f, J.mint, 100, create.timestampSec - 1);
    for (const t of txs) C.handlePoolLogs(f.census, poolLogs(t.events.map((e) => Buffer.from(e.hex, "hex"))), { signature: t.signature, nowMs: t.blockTime * 1000 + 500, pool: J.pool });
    return C.finishPoolsAtStop(f.census)[0];
  };
  const late = run([J.txs[2]]);
  assert.deepEqual(late.poolOddReasons, ["openJump"]);
  assert.equal(late.poolOdd, true);
  assert.ok(late.ratioOpen > 3000, `first seen / curve end ${late.ratioOpen}`);
  const all = run(J.txs);
  assert.ok(!("poolOdd" in all), "the whole opening seen: the first trade is at the open, not odd");
  assert.equal(all.t0, "create");
  assert.equal(all.firstTradeAtOpen, true);
  assert.ok(all.maxRatioAll > 3000, "the jump is in the path");
  // F3pz: the migration transaction's logs are truncated; buys inside it never reach the stream
  {
    const F = OJ.F3pz;
    const fc = S.parsePumpSwapCreatePool(Buffer.from(F.txs[0].events[0].hex, "hex"));
    const ft = S.parsePumpSwapTrade(Buffer.from(F.txs[1].events[0].hex, "hex"));
    assert.equal(String(ft.poolQuote), F.txs[0].poolBalancesAfter.quote, "the pool after the migration tx = the next trade's before");
    assert.ok(ft.poolBase < fc.poolBase, "base left the pool inside the migration transaction (no event in the logs)");
    const f = feeder();
    stdTrade(f, F.mint, 100, fc.timestampSec - 1);
    const truncatedLogs = [...poolLogs([Buffer.from(F.txs[0].events[0].hex, "hex")]), "Log truncated"];
    C.handlePoolLogs(f.census, truncatedLogs, { signature: F.txs[0].signature, nowMs: fc.timestampSec * 1000, pool: F.pool });
    C.handlePoolLogs(f.census, poolLogs(F.txs[1].events.map((e) => Buffer.from(e.hex, "hex"))), { signature: F.txs[1].signature, nowMs: F.txs[1].blockTime * 1000 + 500, pool: F.pool });
    const [r] = C.finishPoolsAtStop(f.census);
    assert.equal(r.firstTradeAtOpen, false, "the first trade seen is not at the open reserves");
    assert.equal(r.logTruncatedNotes, 1);
    assert.ok(r.poolOddReasons.includes("openLogTruncated"), "cut logs at the open make the row odd");
    // a cut later in a busy pool is routine: counted, not odd
    const g2 = feeder();
    stdTrade(g2, F.mint, 100, fc.timestampSec - 1);
    C.handlePoolLogs(g2.census, poolLogs(F.txs[1].events.map((e) => Buffer.from(e.hex, "hex"))), { signature: "late-1", nowMs: F.txs[1].blockTime * 1000 + 500, pool: F.pool });
    stdTrade(g2, key(1850), 5, F.txs[1].blockTime + 60); // the stream clock moves on
    C.handlePoolLogs(g2.census, [...poolLogs([]), "Log truncated"], { signature: "late-2", nowMs: (F.txs[1].blockTime + 60) * 1000, pool: F.pool });
    const [r2] = C.finishPoolsAtStop(g2.census);
    assert.equal(r2.logTruncatedNotes, 1);
    assert.ok(!(r2.poolOddReasons || []).includes("openLogTruncated"), "a cut 60 s after the first trade is not odd");
    assert.equal(C.memRow(f.census, Date.now()).poolLogTruncated, 1);
    // the pump stream counts its truncated notifications too
    const g = feeder();
    C.handleLogs(g.census, ["Program x invoke [1]", "Log truncated"], { nowMs: T0 * 1000 });
    assert.equal(C.memRow(g.census, T0 * 1000).logTruncated, 1);
  }
  ok("outliers: real 5 390 SOL opening buy decoded to the lamport (= pool token accounts), signed virtual quote keeps k (clamped breaks it), first seen after it -> poolOdd openJump; truncated migration logs -> openLogTruncated (a later cut only counted)");
}

// ---- 19. #21e: pool traffic budget (phase 1 logs -> phase 2 vaults), vault price, mayhem tri-state ------
const PA = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "amm-pool-accounts.json"), "utf8"));
const acct = (data, slot) => W.accountResult(data, slot);
{
  // (a) the vault derivation on 7 real pools (normal + mayhem): = PoolState @139 / @171; decoders
  const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  assert.equal(PA.pools.length, 7);
  let mayhem = 0;
  for (const x of PA.pools) {
    assert.equal(S.canonicalPool(new PublicKey(x.mint)).toBase58(), x.pool);
    assert.deepEqual(S.poolVaults(x.mint, x.pool), { baseVault: x.baseVault, quoteVault: x.quoteVault }, `${x.mint}: derived vaults`);
    const d = Buffer.from(x.pool_account, "base64");
    const dec = PSS.decodePool(d);
    assert.deepEqual([dec.baseVault.toBase58(), dec.quoteVault.toBase58()], [x.baseVault, x.quoteVault], "the pool account names the same vaults");
    assert.equal(S.poolAccountVirtual(d), dec.virtualQuoteReserves, "virtual @245 = the AMM sell decoder's");
    assert.deepEqual([x.baseOwner, x.quoteOwner], [T22, SPL]);
    assert.equal(S.tokenAccountAmount(Buffer.from(x.base_account, "base64")) > 0n, true);
    if (dec.isMayhem) {
      mayhem += 1;
      assert.ok(dec.virtualQuoteReserves < 0n, "mayhem pools carry a NEGATIVE virtual quote (signed)");
    }
  }
  assert.equal(mayhem, 2);
  assert.equal(S.tokenAccountAmount(Buffer.alloc(71)), null);
  assert.equal(S.poolAccountVirtual(Buffer.alloc(260)), null);
  ok("vaults: derivation = PoolState vaults on 7 real pools (5 normal, 2 mayhem), Token-2022 base / SPL quote; amount @64, signed virtual @245");
}
{
  // (b) phase 2 on a REAL pool (HUZcQqm6..., the 900 MB/h pool of #21c): the census prices the slot from
  // the real base vault, quote vault and pool account exactly as (quote + virtual) / base
  const x = PA.pools.find((p) => p.mint.startsWith("HUZcQqm6"));
  const f = feeder({ idleSec: 5000, poolLogsSec: 30 });
  f.create(x.mint, { creator: key(1901), ts: T0 });
  assert.equal(f.trade(x.mint, 100, { ts: T0 + 10 })[0].migrated, true);
  const pw = f.census.pools;
  const subs = [];
  pw.hooks.watchVaults = (w) => subs.push([w.vault.baseVault, w.vault.quoteVault, w.pool]);
  C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(W.poolSim(MP).trade({ side: "buy", sol: 1, pool: x.pool, user: key(1902), ts: T0 + 12 }))]), { signature: "real-1", nowMs: (T0 + 12) * 1000, pool: x.pool });
  f.trade(key(1903), 3, { ts: T0 + 42 });
  C.sweepPoolWatch(f.census);
  assert.deepEqual(subs, [[x.baseVault, x.quoteVault, x.pool]], "phase 2 subscribes the real vaults + the pool account");
  for (const [kind, b64] of [["pool", x.pool_account], ["base", x.base_account], ["quote", x.quote_account]]) C.handlePoolAccount(f.census, acct(Buffer.from(b64, "base64"), x.slot), { pool: x.pool, kind });
  const base = Buffer.from(x.base_account, "base64").readBigUInt64LE(64);
  const quote = Buffer.from(x.quote_account, "base64").readBigUInt64LE(64);
  const virt = PSS.decodePool(Buffer.from(x.pool_account, "base64")).virtualQuoteReserves;
  const want = ((Number(quote) + Number(virt)) / Number(base)) * 1e-3;
  const w = pw.byPool.get(x.pool);
  assert.ok(Math.abs(w.lastPrice / want - 1) < 1e-12, `vault price ${w.lastPrice} = ${want}`);
  assert.ok(want > 1e-8 && want < 1e-5, "SOL per whole token, the census scale");
  const [row] = C.finishPoolsAtStop(f.census);
  assert.deepEqual([row.phase2, row.logsCutReason, row.logsUntilSec, row.vaults.prices, row.vaults.virtSource], ["vaults", "time", 30, 1, "account"]);
  // (the mock curve ends at 1.07e-7, below this real pool's price: the vault price is the row's max)
  assert.equal(row.maxRatioAll, Math.round((want / row.curveEndPrice) * 1e4) / 1e4, "the vault price enters the row's ratios");
  ok(`vault price from a real fixture: (quote ${Number(quote) / 1e9} + virtual ${Number(virt) / 1e9}) SOL / base -> ${want.toPrecision(4)} SOL per token`);
}
{
  // (c) phase switch by TIME on the mock pool; phase-2 prices drive min / max / checkpoints, logs drive flows
  const { f, m, pool, sim, trade } = poolCensus({ poolLogsSec: 60 });
  const pw = f.census.pools;
  const calls = [];
  pw.hooks.unwatch = (p) => calls.push(["unwatch", p]);
  pw.hooks.watchVaults = (w) => calls.push(["vaults", w.vault.baseVault, w.vault.quoteVault]);
  pw.hooks.unwatchVaults = (p) => calls.push(["unwatchVaults", p]);
  const first = T0 + 105;
  trade({ side: "buy", sol: 1, user: key(1911), ts: first });
  trade({ side: "sell", tokens: 2_000_000_000_000n, user: key(1912), ts: first + 20 });
  f.trade(key(1913), 3, { ts: first + 59 });
  C.sweepPoolWatch(f.census);
  assert.deepEqual(calls, [], "59 s after the first trade: still logs");
  f.trade(key(1913), 3, { ts: first + 60 });
  C.sweepPoolWatch(f.census);
  const v = S.poolVaults(m, pool);
  assert.deepEqual(calls, [["unwatch", pool], ["vaults", v.baseVault, v.quoteVault]], "60 s: logs dropped, vaults subscribed");
  assert.equal(pw.counts.poolLogsCutTime, 1);
  const tradesBefore = pw.byPool.get(pool).fAll.trades;
  trade({ side: "buy", sol: 5, user: key(1914), ts: first + 61 }); // in flight at the cut: ignored
  assert.deepEqual([pw.counts.poolAfterCut, pw.byPool.get(pool).fAll.trades], [1, tradesBefore]);
  // a pumped state, seen only through the vaults (sim.st did not move: the in-flight trade was ignored
  // by the census, but the simulator applied it — use explicit amounts)
  const B = sim.st.base - 30_000_000_000_000n;
  const Q = sim.st.quote + 9_000_000_000n;
  const V = sim.st.virtual;
  f.trade(key(1913), 3, { ts: first + 70 });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(B), 5000), { pool, kind: "base" });
  assert.equal(pw.byPool.get(pool).vault.prices, 0, "base vault alone: no price");
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(Q), 4999), { pool, kind: "quote" });
  assert.equal(pw.byPool.get(pool).vault.prices, 0, "vaults of different slots: no price");
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(Q), 5000), { pool, kind: "quote" });
  const p1 = S.quotePerBase(Q + V, B);
  assert.equal(pw.byPool.get(pool).vault.prices, 1);
  assert.equal(pw.byPool.get(pool).lastPrice, p1);
  // the pool account of the same slot changes the virtual: the slot is priced again with it
  C.handlePoolAccount(f.census, acct(W.poolAccountData(V + 1_000_000_000n), 5000), { pool, kind: "pool" });
  const p2 = S.quotePerBase(Q + V + 1_000_000_000n, B);
  assert.deepEqual([pw.byPool.get(pool).vault.prices, pw.byPool.get(pool).lastPrice, pw.byPool.get(pool).vault.virtSource], [2, p2, "account"]);
  C.handlePoolAccount(f.census, acct(Buffer.alloc(10), 5001), { pool, kind: "base" });
  assert.equal(pw.counts.vaultBadData, 1);
  f.trade(key(1913), 3, { ts: first + 310 });
  const [row] = C.finishPoolsAtStop(f.census);
  assert.deepEqual(calls.at(-1), ["unwatchVaults", pool], "the vaults are dropped with the watch");
  const ce = row.curveEndPrice;
  const r = (x) => Math.round((x / ce) * 1e4) / 1e4;
  assert.deepEqual([row.phase2, row.logsCutReason, row.logsUntilSec], ["vaults", "time", 60]);
  assert.equal(row.maxRatioAll, r(p2), "the vault-phase peak is the max");
  assert.equal(row.ratio5m, r(p2), "a checkpoint after the cut takes the vault price");
  assert.ok(row.ratio1m !== null && row.ratio1m < row.maxRatioAll, "1 m: the logs-phase price");
  assert.equal(row.flowAll.trades, 2, "flows: phase 1 only");
  assert.ok(row.flow1m !== null, "1 m window covered by the logs (cut at 60 s)");
  assert.deepEqual([row.flow5m, row.largestSellSol3m, row.launcherSellSol5m, row.creatorSellSol5m], [null, null, null, null], "windows the logs did not cover are null, never partial");
  assert.deepEqual(row.vaults.notes, { base: 2, quote: 2, pool: 1 });
  assert.deepEqual([row.vaults.prices, row.vaults.p2Notes], [2, 5]);
  assert.ok(row.vaults.KB > 0);
  const mem = C.memRow(f.census, (first + 310) * 1000);
  assert.deepEqual([mem.poolLogsCutTime, mem.poolLogsCutBytes, mem.vaultPrices, mem.vaultNotes], [1, 0, 2, 5]);
  assert.ok(mem.vaultMB > 0);
  ok("phase switch by time: logs until first + CENSUS_POOL_LOGS_SEC, then vaults (paired by slot, pool account = virtual); ratios from both phases, flows phase 1 only, uncovered windows null");
}
{
  // (d) phase switch by BYTES; never before the first trade; never in mode b; CENSUS_POOL_VAULTS=0 = rev 3
  const failedBig = (n) => [`Program ${PUMPSWAP_ID} invoke [1]`, "Program log: " + "x".repeat(n), `Program ${PUMPSWAP_ID} failed: custom program error: 0x1774`];
  const run = (cfg, { modeB = false } = {}) => {
    const { f, pool, trade } = poolCensus({ poolLogsMB: 0.01, ...cfg }); // 10 485.76 bytes
    const pw = f.census.pools;
    if (modeB) pw.mode = "b";
    const calls = [];
    pw.hooks.watchVaults = () => calls.push("vaults");
    C.handlePoolLogs(f.census, failedBig(12_000), { signature: "pre", nowMs: (T0 + 104) * 1000, pool, failed: true });
    const pre = pw.byPool.get(pool).phase;
    trade({ side: "buy", sol: 1, user: key(1921), ts: T0 + 105 });
    return { f, pw, pool, calls, pre };
  };
  const a = run({});
  assert.equal(a.pre, 1, "12 KB of logs BEFORE the first trade: no cut (nothing to price yet)");
  assert.deepEqual([a.pw.byPool.get(a.pool).phase, a.pw.byPool.get(a.pool).logsCutReason, a.calls], [2, "bytes", ["vaults"]], "the first trade's notification passes 10 KB: cut by bytes");
  assert.equal(a.pw.counts.poolLogsCutBytes, 1);
  // crossing exactly: below the limit stays, the notification that passes it cuts
  const { f, pool, trade } = poolCensus({ poolLogsMB: 0.01 });
  const pw = f.census.pools;
  trade({ side: "buy", sol: 1, user: key(1922), ts: T0 + 105 });
  const w = pw.byPool.get(pool);
  const left = Math.ceil(pw.cfg.logsBytes - w.logBytes);
  const lineFor = (n) => n - failedBig(0).reduce((s, l) => s + l.length, 0);
  C.handlePoolLogs(f.census, failedBig(lineFor(left - 1)), { signature: "b1", nowMs: (T0 + 106) * 1000, pool, failed: true });
  assert.ok(w.phase === 1 && pw.cfg.logsBytes - w.logBytes > 0 && pw.cfg.logsBytes - w.logBytes <= 1, "just below the limit: logs");
  C.handlePoolLogs(f.census, failedBig(10), { signature: "b2", nowMs: (T0 + 107) * 1000, pool, failed: true });
  assert.deepEqual([w.phase, w.logsCutReason], [2, "bytes"], "past the limit: vaults");
  const b = run({}, { modeB: true });
  assert.deepEqual([b.pw.byPool.get(b.pool).phase, b.calls], [1, []], "mode b: no per-pool cut");
  const off = run({ poolVaults: false });
  assert.deepEqual([off.pw.byPool.get(off.pool).phase, off.calls], [1, []], "CENSUS_POOL_VAULTS=0: logs for the whole window");
  const [row] = C.finishPoolsAtStop(off.f.census);
  assert.deepEqual([row.phase2, row.logsUntilSec, row.logsCutReason, row.vaults], [null, null, null, null]);
  // env
  const e = C.parseCensusEnv({});
  assert.deepEqual([e.poolLogsSec, e.poolLogsMB, e.poolVaults, e.poolVaultCheck], [900, 40, true, false]);
  for (const [k, v] of [["CENSUS_POOL_LOGS_SEC", "0"], ["CENSUS_POOL_LOGS_SEC", "1.5"], ["CENSUS_POOL_LOGS_MB", "0"], ["CENSUS_POOL_VAULTS", "yes"], ["CENSUS_POOL_VAULT_CHECK", "2"]]) assert.throws(() => C.parseCensusEnv({ [k]: v }), new RegExp(k));
  ok("phase switch by bytes: the notification passing CENSUS_POOL_LOGS_MB cuts (just below does not); not before the first trade; not in mode b; CENSUS_POOL_VAULTS=0 keeps rev 3; env 900 s / 40 MB");
}
{
  // (e) vault check: vaults from the first trade beside the logs; each vault slot vs the event of that
  // slot that left the same base vault, in either arrival order
  const { f, pool, sim } = poolCensus({ poolVaultCheck: true });
  const pw = f.census.pools;
  const calls = [];
  pw.hooks.watchVaults = () => calls.push("vaults");
  pw.hooks.unwatch = () => calls.push("unwatch");
  const ev = (o, slot, ts) => C.handlePoolLogs(f.census, poolLogs([W.pumpSwapPayload(sim.trade({ pool, ts, ...o }))]), { signature: `chk-${slot}-${ts}`, nowMs: ts * 1000, pool, slot });
  ev({ side: "buy", sol: 1, user: key(1931) }, 7000, T0 + 105);
  assert.deepEqual(calls, ["vaults"], "check mode: vaults at the first trade, logs kept");
  // slot 7000: the vaults hold exactly the event's state after the trade -> error 0
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.base), 7000), { pool, kind: "base" });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.quote), 7000), { pool, kind: "quote" });
  // slot 7001: the vaults arrive FIRST (two streams); the quote vault is 2 000 lamports above the event's
  // computed state (a coin-creator fee kept in the vault, KODING_REPORT_21) -> a tiny error
  const sim2 = W.poolSim(sim.st);
  const next = sim2.trade({ side: "buy", sol: 0.4, pool, user: key(1932), ts: T0 + 106 });
  void next;
  const st2 = { ...sim2.st };
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(st2.base), 7001), { pool, kind: "base" });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(st2.quote + 2_000n), 7001), { pool, kind: "quote" });
  ev({ side: "buy", sol: 0.4, user: key(1932) }, 7001, T0 + 106);
  // slot 7002: an event whose state the vaults never show (another tx of the slot came last) -> unmatched
  ev({ side: "sell", tokens: 1_000_000_000_000n, user: key(1933) }, 7002, T0 + 107);
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.base + 5n), 7002), { pool, kind: "base" });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.quote), 7002), { pool, kind: "quote" });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.base), 7300), { pool, kind: "base" });
  C.handlePoolAccount(f.census, acct(W.tokenAccountData(sim.st.quote), 7300), { pool, kind: "quote" });
  const w = pw.byPool.get(pool);
  assert.equal(w.vault.pairs, 2);
  assert.equal(w.vault.errs[0], 0, "same state, same price");
  const want = S.quotePerBase(st2.quote + 2_000n + st2.virtual, st2.base) / S.quotePerBase(st2.quote + st2.virtual, st2.base) - 1;
  assert.ok(Math.abs(w.vault.errs[1] - want) < 1e-15 && want > 0 && want < 1e-7, `fee left in the vault: error ${w.vault.errs[1]}`);
  assert.equal(w.vault.unmatched, 1, "a vault slot whose state no event of the slot left: unmatched");
  assert.equal(w.vault.prices, 0, "phase 1: the vault prices do not feed the path");
  const [row] = C.finishPoolsAtStop(f.census);
  assert.deepEqual([row.vaults.checkPairs, row.vaults.checkUnmatched], [2, 1]);
  const mem = C.memRow(f.census, (T0 + 107) * 1000);
  assert.deepEqual([mem.vaultCheckPairs, mem.vaultCheckUnmatched, mem.vaultCheckVirtualDiff], [2, 1, 0]);
  assert.equal(mem.vaultCheckErrMax, Number(want.toPrecision(3)));
  ok(`vault check: vault slot vs the same-state trade event, either arrival order; unmatched counted (max error ${mem.vaultCheckErrMax})`);
}
{
  // (f) lib/ws.mjs: account subscriptions end with accountUnsubscribe (also before the confirmation)
  const WebSocketServer = (await import("ws")).default.Server;
  const { SolanaWs } = await import("../lib/ws.mjs?real-socket");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const seen = [];
  let hold = null;
  wss.on("connection", (sock) => {
    let next = 500;
    sock.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push([m.method, m.params[0], m.params[1]?.encoding ?? null]);
      if (m.method === "accountSubscribe") {
        next += 1;
        const id = next;
        const answer = () => sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: id }));
        if (m.params[0] === "HOLD") hold = answer; // confirmed later
        else if (m.params[0] === "REJECT") sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "too many" } }));
        else {
          answer();
          setTimeout(() => sock.send(JSON.stringify({ jsonrpc: "2.0", method: "accountNotification", params: { subscription: id, result: acct(W.tokenAccountData(7n), 9) } })), 20);
        }
      } else if (m.method.endsWith("Unsubscribe")) sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: true }));
    });
  });
  await new Promise((r) => wss.on("listening", r));
  const ws = new SolanaWs(`ws://127.0.0.1:${wss.address().port}`);
  await ws.connect();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const got = [];
  const errs = [];
  const a = ws.subscribeAccount("ACC1", (r) => got.push(r), "confirmed", { encoding: "base64" });
  ws.subscribeAccount("REJECT", () => {}, "confirmed", { encoding: "base64", onError: (e) => errs.push(e.message) });
  const h = ws.subscribeAccount("HOLD", () => {}, "confirmed", { encoding: "base64" });
  for (let i = 0; i < 100 && (got.length === 0 || !hold); i++) await wait(20);
  assert.equal(S.tokenAccountAmount(Buffer.from(got[0].value.data[0], "base64")), 7n, "the handler gets the notification's result");
  assert.deepEqual(errs, ["too many"], "a rejected account subscription goes to its onError");
  assert.equal(ws.unsubscribe(a), true);
  assert.equal(ws.unsubscribe(h), true, "unsubscribed before the server confirmed");
  hold();
  for (let i = 0; i < 100 && seen.filter((x) => x[0] === "accountUnsubscribe").length < 2; i++) await wait(20);
  assert.deepEqual(seen.filter((x) => x[0] === "accountUnsubscribe").map((x) => x[1]).sort(), [501, 503], "accountUnsubscribe for both (never logsUnsubscribe)");
  assert.ok(!seen.some((x) => x[0] === "logsUnsubscribe"));
  assert.ok(seen.filter((x) => x[0] === "accountSubscribe").every((x) => x[2] === "base64"));
  assert.ok(![...ws.subs.values()].some((s) => s.params[0] === "ACC1" || s.params[0] === "HOLD"), "ended subscriptions are not resubscribed after a reconnect");
  await ws.close();
  await new Promise((r) => wss.close(r));
  ok("lib/ws.mjs: subscribeAccount base64 + onError; unsubscribe -> accountUnsubscribe, also for one not yet confirmed");
}
{
  // (g) census_mint mayhem: true / false / null (#21d point 2) on REAL creates and trades
  const FXM = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "pump-create-mayhem.json"), "utf8"));
  const { parseCreate } = await import("../lib/events.mjs");
  const may = FXM.events.find((e) => e.mayhem === true);
  const nor = FXM.events.find((e) => e.mayhem === false);
  const feed = (f, b64, ts) => C.handleLogs(f.census, [DATA(Buffer.from(b64, "base64")), "Program x success"], { nowMs: ts * 1000 + 300 });
  const lastRow = (f, mint) => C.finishAll(f.census).find((r) => r.mint === mint);
  const tsOf = (b64) => Number(Buffer.from(b64, "base64").readBigInt64LE(89));
  for (const e of FXM.events) assert.equal(C.createMayhem(parseCreate(Buffer.from(e.create, "base64"))), e.mayhem, `${e.mint}: create tail byte = the trade's mayhem_mode`);
  // create only (no trade): from the create
  let f = feeder();
  feed(f, may.create, T0);
  assert.equal(lastRow(f, may.mint).mayhem, true, "real mayhem create only -> true");
  f = feeder();
  feed(f, nor.create, T0);
  assert.equal(lastRow(f, nor.mint).mayhem, false, "real non-mayhem create only -> false");
  // trade only (create not seen): from the trade tail
  f = feeder();
  feed(f, may.trade, tsOf(may.trade));
  assert.equal(lastRow(f, may.mint).mayhem, true, "real mayhem trade only -> true");
  f = feeder();
  feed(f, nor.trade, tsOf(nor.trade));
  assert.equal(lastRow(f, nor.mint).mayhem, false, "real non-mayhem trade only -> false");
  // neither tail parsable: null (the mock create has no token-program tail; a trade cut to 200 bytes
  // still parses as a trade, with reserves, but has no tail)
  f = feeder();
  const m0 = key(1941);
  f.create(m0, { creator: key(1942), ts: T0 });
  const short = tradePayload({ mint: m0, user: key(1944), isBuy: true, realSol: 0.3 * REAL_100, solLamports: 1e8, ts: T0 + 1 }).subarray(0, 200);
  C.handleLogs(f.census, [DATA(short), "Program x success"], { nowMs: (T0 + 1) * 1000 + 300 });
  const r0 = lastRow(f, m0);
  assert.equal(r0.trades, 1, "the short trade was processed");
  assert.ok("mayhem" in r0 && r0.mayhem === null, "no parsable tail -> null (present, not absent)");
  f = feeder();
  const m1 = key(1945);
  f.create(m1, { creator: key(1946), ts: T0 });
  f.trade(m1, 30, { ts: T0 + 1 }); // the mock trade-v3 carries a full tail with mayhem_mode 0
  assert.equal(lastRow(f, m1).mayhem, false, "a full trade tail with mayhem_mode 0 -> false");
  assert.equal(C.createMayhem({ tail: Buffer.alloc(40) }), null, "a tail that does not start with a token program -> null");
  // a disagreement: the later true wins, counted once
  f = feeder();
  feed(f, nor.create, T0);
  for (const [i, fill] of [[1, 10], [2, 11]]) C.handleLogs(f.census, [DATA(W.curveTradePayload({ mint: nor.mint, user: key(1943), ts: T0 + i, vTok: W.vTokAtFill(fill), mayhem: true, sol: { vSol: 400_000_000n, realSol: 300_000_000n } })), "Program x success"], { nowMs: (T0 + i) * 1000 });
  const mem = C.memRow(f.census, T0 * 1000);
  assert.deepEqual([lastRow(f, nor.mint).mayhem, mem.mayhemConflict, mem.mayhemFromCreate, mem.mayhemFromTrade], [true, 1, 1, 0]);
  ok("mayhem tri-state: real create (tail byte after token_program) and real trade tails -> true / false; neither -> null; conflict -> true, counted");
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
  assert.ok(g.files.includes("lib/pumpswap-stream.mjs") && g.files.includes("lib/census-pool.mjs"), "rev 2: the pool part is in the checked graph (pure PDA + event decoder, no RPC module)");
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
  assert.ok(rows.every((r) => r.ts && r.censusRev === 3));
  assert.equal(connections, 0, `the fixture RPC saw ${connections} connection(s)`);
  assert.ok(!fs.existsSync(path.join(censusDir, ".census.lock")), "the lock is released at the stop");
  ok("process: real recorder on a fixture stream writes the expected rows; fixture RPC counted 0 requests");
}

// ---- 7b. the process with the pool stream (rev 2): mode a, CENSUS_POOL=0, rejection -> b, b at start --
{
  const run = async (extra) => {
    const dir = tmp("census-pool-run-");
    const wsLog = path.join(dir, "ws.log");
    const env = baseEnv({ CENSUS_DIR: dir, WS_MOCK_CENSUS_LOG: wsLog, CENSUS_MAX_SEC: "6", CENSUS_POOL_WATCH_SEC: "2", RPC_URL: `http://127.0.0.1:${port}/?api-key=FIXTUREKEYPOOL`, ...extra });
    const r = await runCensus(env);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"));
    const rows = files.flatMap((x) => fs.readFileSync(path.join(dir, x), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
    const ws = fs.existsSync(wsLog) ? fs.readFileSync(wsLog, "utf8").trim().split("\n") : [];
    const text = r.out + r.err + rows.map((x) => JSON.stringify(x)).join("\n");
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.code, 0, `exit 0 (stderr: ${r.err.split(/\r?\n/)[0]})`);
    assert.ok(!/TypeError|ReferenceError|RangeError|handler error/.test(r.out + r.err), `no exception: ${r.out}${r.err}`);
    assert.ok(!KEY_TEXT.test(text), "no URL / key text in stdout, stderr or rows");
    return { ...r, rows, ws, pool: rows.filter((x) => x.type === "census_pool"), mem: rows.filter((x) => x.type === "census_mem").at(-1) };
  };
  const SUB = (m) => `logsSubscribe ${m}`;
  const PUMP_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

  const a = await run({});
  assert.match(a.out, /pools: mode a, watch 2s, subscribe at fill 92/);
  assert.deepEqual(a.ws.slice(0, 2), [SUB(PUMP_ID), SUB(W.MIG_POOL)], "the pool is subscribed at the completion");
  assert.match(a.ws[2] || "", /^logsUnsubscribe \d+$/, "and unsubscribed at the end of its watch");
  assert.equal(a.ws.length, 3);
  assert.equal(a.pool.length, 1);
  const p = a.pool[0];
  assert.deepEqual([p.mint, p.pool, p.mode, p.final, p.censusRev], [W.MIG_MINT, W.MIG_POOL, "a", "watch", 3]);
  assert.ok(Math.abs(p.ratioOpen - 1) < 0.01, `mock pool opens on the curve's scale (${p.ratioOpen})`);
  assert.equal(p.flowAll.trades, 2, "buy + launcher sell; the event past the 2 s window ends it");
  assert.equal(p.flowAll.sellSol > 0, true);
  assert.deepEqual([a.mem.poolSubs, a.mem.poolRows, a.mem.unknownPool, a.mem.poolAfterEnd, a.mem.poolMode], [0, 1, 1, 1, "a"]);
  // #21b: subscribed at 93 % (before the completion), the open and the first trade caught, traffic
  assert.deepEqual([a.mem.poolPresubs, a.mem.poolPresubDropped, a.mem.poolPending, a.mem.poolOpens], [1, 0, 0, 1]);
  assert.deepEqual([p.t0, p.firstTradeAtOpen, p.quoteReserveSolAtOpen, p.quoteReserveSolAtFirst, p.poolMayhem], ["create", true, 85.75, 68.3, false]);
  assert.ok(Math.abs(p.openRatio - 1) < 0.01 && p.firstTradeAfterOpenSec >= 0 && p.firstTradeAfterOpenSec <= 1);
  assert.deepEqual([p.notes, p.failedNotes], [5, 1], "open, failed, buy, launcher sell, other-pool tx (the tx past the window ends it, uncounted)");
  assert.ok(p.logKB > 0);
  assert.equal(p.traffic.m0_5.notes + p.traffic.pre.notes, 5);
  assert.equal(a.rows.filter((x) => x.type === "census_mint" && x.mint === W.MIG_MINT).length, 1);

  const off = await run({ CENSUS_POOL: "0" });
  assert.match(off.out, /pools: off \(CENSUS_POOL=0\)/);
  assert.deepEqual(off.ws, [SUB(PUMP_ID)], "CENSUS_POOL=0: no pool subscription at all");
  assert.equal(off.pool.length, 0);
  assert.equal(off.mem.poolMode, "off");
  assert.ok(off.rows.some((x) => x.type === "census_mint" && x.migrated === true && x.censusRev === 3));

  const rej = await run({ WS_MOCK_POOL_REJECT: "1" });
  assert.deepEqual(rej.ws.slice(0, 3), [SUB(PUMP_ID), SUB(W.MIG_POOL), SUB(W.PUMPSWAP)], "rejected pool subscription -> one on the PumpSwap program");
  assert.match(rej.err, /POOL SUBSCRIPTION REJECTED .* -> mode b/);
  const modeRow = rej.rows.find((x) => x.type === "census_pool_mode");
  assert.deepEqual([modeRow.mode, modeRow.watchedPools], ["b", 1]);
  assert.equal(rej.pool.length, 1);
  assert.deepEqual([rej.pool[0].mode, rej.pool[0].final, rej.pool[0].flowAll.trades], ["b", "watch", 2]);
  assert.equal(rej.mem.poolSubs, 1);
  assert.equal(rej.mem.rpcSwitches, 0);
  // #23: the plan-limit error of the pool subscription is counted by code (no failover needed).
  assert.deepEqual(rej.mem.rpcLimitErrors, { "-32602": 1 }, `census_mem rpcLimitErrors (got ${JSON.stringify(rej.mem.rpcLimitErrors)})`);
  assert.equal(rej.mem.rpcThin, 0);
  assert.deepEqual(off.mem.rpcLimitErrors, {}, "no error: an empty map");

  const b = await run({ CENSUS_POOL_MODE: "b" });
  assert.deepEqual(b.ws.slice(0, 2), [SUB(PUMP_ID), SUB(W.PUMPSWAP)], "mode b: one program subscription from the start");
  assert.ok(!b.ws.includes(SUB(W.MIG_POOL)));
  assert.deepEqual([b.pool[0].mode, b.pool[0].final, b.pool[0].flowAll.trades], ["b", "watch", 2]);
  assert.deepEqual([b.pool[0].t0, b.pool[0].notes, b.pool[0].failedNotes], ["create", 3, 0], "mode b: transactions holding the pool's events (open, buy, sell)");
  assert.equal(b.mem.unknownPool, 1, "the other pool's event is filtered out in-process");
  const drop = await run({ WS_MOCK_PRESUB_DROP: "1" });
  const dropPool = S.canonicalPool(new PublicKey(W.DROP_MINT)).toBase58();
  assert.ok(drop.ws.includes(SUB(dropPool)), "a mint at 94 % gets its pool subscribed");
  assert.equal(drop.ws.filter((x) => x.startsWith("logsUnsubscribe")).length, 2, "MIG pool at its window end, the dropped pool at the stop");
  assert.deepEqual([drop.mem.poolPresubs, drop.mem.poolPresubDropped, drop.pool.length], [2, 1, 1], "dropped: no census_pool row");
  // #21e: phase 2 in the real process — 0.001 MB of logs pass at the first trade's notification: the
  // pool's logs are dropped, its base vault / quote vault / pool account subscribed (base64), two slots
  // priced from them, all three dropped at the stop
  const v = await run({ CENSUS_POOL_WATCH_SEC: "30", CENSUS_POOL_LOGS_MB: "0.001" });
  assert.match(v.out, /logs until 900s \/ 0\.001 MB then vaults/);
  const ACC = (a) => `accountSubscribe ${a}`;
  assert.deepEqual(v.ws.slice(0, 2), [SUB(PUMP_ID), SUB(W.MIG_POOL)]);
  assert.match(v.ws[2] || "", /^logsUnsubscribe \d+$/, "phase 1 ends: the pool's logs are dropped");
  assert.deepEqual(v.ws.slice(3, 6), [ACC(W.MIG_VAULTS.baseVault), ACC(W.MIG_VAULTS.quoteVault), ACC(W.MIG_POOL)], "then the two vaults and the pool account");
  assert.equal(v.ws.filter((x) => /^accountUnsubscribe \d+$/.test(x)).length, 3, "all three dropped at the stop");
  assert.equal(v.ws.length, 9);
  const vp = v.pool[0];
  assert.deepEqual([vp.phase2, vp.logsCutReason, vp.logsUntilSec, vp.final, vp.flowAll.trades], ["vaults", "bytes", 0, "shutdown", 1]);
  assert.deepEqual([vp.vaults.prices, vp.vaults.notes, vp.vaults.virtSource], [2, { base: 2, quote: 2, pool: 1 }, "account"]);
  const top = W.VAULT_STATES[1];
  assert.equal(vp.maxRatioAll, Math.round((S.quotePerBase(top.quote + W.MIG_POOL_START.virtual, top.base) / vp.curveEndPrice) * 1e4) / 1e4, "the vault-phase price is the max");
  assert.deepEqual([v.mem.poolLogsCutBytes, v.mem.vaultPrices, v.mem.vaultNotes, v.mem.vaultSubs, v.mem.poolPhase2], [1, 2, 5, 0, 0]);
  assert.equal(connections, 0, `the fixture RPC saw ${connections} connection(s)`);
  ok("process (rev 2): mode a subscribe at complete / unsubscribe at the end; CENSUS_POOL=0 no pool subscription; rejection -> mode b; mode b at start; #21b open + first trade caught, traffic, presub drop; #21e logs -> vaults (accountSubscribe x3, priced, accountUnsubscribe x3); no key text");
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
