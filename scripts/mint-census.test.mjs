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
  assert.equal(row.censusRev, 2);
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

  // CENSUS_POOL=0: rev-1 behaviour (still censusRev 2)
  const off = feeder({ pool: false });
  const m = key(1140);
  off.create(m, { creator: key(1141), ts: T0 });
  const [mig] = off.trade(m, 100, { ts: T0 + 10 });
  assert.equal(mig.censusRev, 2);
  assert.equal(off.census.pools, null);
  assert.deepEqual(C.handlePoolLogs(off.census, poolLogs([W.pumpSwapPayload(W.poolSim(MP).trade({ side: "buy", sol: 1, pool: S.canonicalPool(new PublicKey(m)).toBase58(), user: A, ts: T0 + 11 }))]), { nowMs: (T0 + 11) * 1000 }), []);
  assert.deepEqual(C.finishPoolsAtStop(off.census), []);
  assert.equal(C.memRow(off.census, T0 * 1000).poolMode, "off");
  // census_mint rows: the same keys as rev 1 (only censusRev changed)
  assert.deepEqual(Object.keys(mig), ["type", "censusRev", "mint", "createSec", "createSeen", "launcher", "isCreator", "launches24h", "devBuySol", "hourUtc", "maxFill", "trades", "uniqueTraders", "lastSec", "final", "maxLagSec", "name", "symbol", "creator", "creatorSource", "firstSec", "firstSeenFill", "maxFillSec", "migrated", "completeSec", "milestones"]);

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
  assert.ok(rows.every((r) => r.ts && r.censusRev === 2));
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
  assert.deepEqual([p.mint, p.pool, p.mode, p.final, p.censusRev], [W.MIG_MINT, W.MIG_POOL, "a", "watch", 2]);
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
  assert.ok(off.rows.some((x) => x.type === "census_mint" && x.migrated === true && x.censusRev === 2));

  const rej = await run({ WS_MOCK_POOL_REJECT: "1" });
  assert.deepEqual(rej.ws.slice(0, 3), [SUB(PUMP_ID), SUB(W.MIG_POOL), SUB(W.PUMPSWAP)], "rejected pool subscription -> one on the PumpSwap program");
  assert.match(rej.err, /POOL SUBSCRIPTION REJECTED .* -> mode b/);
  const modeRow = rej.rows.find((x) => x.type === "census_pool_mode");
  assert.deepEqual([modeRow.mode, modeRow.watchedPools], ["b", 1]);
  assert.equal(rej.pool.length, 1);
  assert.deepEqual([rej.pool[0].mode, rej.pool[0].final, rej.pool[0].flowAll.trades], ["b", "watch", 2]);
  assert.equal(rej.mem.poolSubs, 1);
  assert.equal(rej.mem.rpcSwitches, 0);

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
  assert.equal(connections, 0, `the fixture RPC saw ${connections} connection(s)`);
  ok("process (rev 2): mode a subscribe at complete / unsubscribe at the end; CENSUS_POOL=0 no pool subscription; rejection -> mode b; mode b at start; #21b open + first trade caught, traffic, presub drop; no key text");
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
