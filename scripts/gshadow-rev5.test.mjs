import "./lib/test-env.mjs";
// Graduation shadow lab, revision 5 (KODING #9). No network: fixture socket + fixture RPC.
//
//   P0  The lab's process once stood still for 22–39 minutes right after a curve completed (a paused
//       console blocks console.log and with it the event loop). When it came back, the first pool
//       quote was booked as "sl -97%" at holdSec 2008 against a 300 s timeout. Reproduced here by
//       blocking the bot's own event loop (scenario "stall"):
//         - guards OFF (SHADOW_LATE_SEC=0, the old behaviour) -> the artifact: a priced "sl" at
//           three times the timeout;
//         - guards ON -> a gshadow_stall row, and the overdue positions are journaled WITHOUT a
//           result (timeout / amm-unpriced / late).
//       Also: a migration check that keeps failing no longer holds a position open for ever, and a
//       stream event older than SHADOW_LATE_SEC (the backlog after a stall) opens nothing.
//   P2  Variants K / L / M / N; A–J are byte-for-byte what they were; N leaves a migrated position
//       at the first pool quote; a migrated position WITH a quote still times out at the quote.
//
// Every assertion marked [off] runs the same scenario with the guard switched off and asserts the
// old, wrong outcome — that is the "fails without the fix" proof, kept in the test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const same = (a, b) => {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
};
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const uniq = (list, f) => JSON.stringify([...new Set(list.map(f))]);

process.env.CU_PRICE = "1500000";
process.env.CU_LIMIT = "300000";
process.env.SLIPPAGE_ASSUMED_BPS = "50";

const G = await import("../lib/gshadow.mjs");
const { SHADOW_COSTS_SCHEME } = await import("../lib/pessimistic.mjs");
const { readGradStrategy } = await import("../lib/grad-config.mjs");
const { readJournal } = await import("../lib/journal.mjs");
const { FIRST_MINT, MOM_MINT, SLOW_MINT, LATE_MINT } = await import("./mocks/ws-mock-shadow.mjs");

const BUY = 0.02;
const S = 1000;

// =============================================================================================
// Pure logic
// =============================================================================================

// ---- closeDecision: the P0 rule ---------------------------------------------------------------
{
  const base = { tp: 1.5, sl: 0.7, holdMs: 300 * S, lateMs: 30 * S };
  // The journaled case: 300 s timeout, first quote at 2008 s, the pool pays 5% of the buy.
  const p0 = G.closeDecision({ ...base, venue: "amm", ratio: 0.0534, heldMs: 2008 * S });
  asrt(same(p0, { reason: "timeout", venue: "amm-unpriced", late: true }), `P0: a quote that arrives 1708 s after the deadline is NOT an exit price, got ${JSON.stringify(p0)}`);
  asrt(G.exitReason({ ratio: 0.0534, tp: 1.5, sl: 0.7, heldMs: 2008 * S, holdMs: 300 * S }) === "sl", "…while the old rule (exitReason alone) books it as a stop-loss");
  const p0curve = G.closeDecision({ ...base, venue: "curve", ratio: 1.16, heldMs: 1518 * S });
  asrt(same(p0curve, { reason: "timeout", venue: "curve-unpriced", late: true }), `P0 (5KWX…): a curve price seen 1218 s after the deadline is not an exit price either, got ${JSON.stringify(p0curve)}`);
  asrt(same(G.closeDecision({ ...base, venue: "amm", ratio: 2.4, heldMs: 2008 * S }), { reason: "timeout", venue: "amm-unpriced", late: true }), "late beats a take-profit too: the rule is not a loss filter");

  // Migrated, no quote: nothing before the deadline, unpriced timeout at it (task #5 behaviour).
  asrt(G.closeDecision({ ...base, venue: "amm", ratio: null, heldMs: 299 * S }) === null, "no quote before the deadline: keep waiting (the pool may still appear)");
  asrt(same(G.closeDecision({ ...base, venue: "amm", ratio: null, heldMs: 300 * S }), { reason: "timeout", venue: "amm-unpriced" }), "no quote at the deadline: timeout, amm-unpriced (on time: not late)");
  // Migrated, with a quote: timeout at the quote.
  asrt(same(G.closeDecision({ ...base, venue: "amm", ratio: 1.1, heldMs: 300 * S }), { reason: "timeout", venue: "amm" }), "a quote at the deadline: timeout priced on the AMM");
  asrt(same(G.closeDecision({ ...base, venue: "amm", ratio: 1.1, heldMs: 330 * S }), { reason: "timeout", venue: "amm" }), "exactly lateMs after the deadline is still on time (strictly greater is late)");
  asrt(G.closeDecision({ ...base, venue: "amm", ratio: 1.1, heldMs: 330 * S + 1 }).late === true, "one millisecond more is late");
  // Ordinary exits are untouched.
  asrt(same(G.closeDecision({ ...base, venue: "amm", ratio: 0.6, heldMs: 20 * S }), { reason: "sl", venue: "amm" }), "an ordinary stop-loss on the AMM");
  asrt(same(G.closeDecision({ ...base, venue: "curve", ratio: 1.5, heldMs: 20 * S }), { reason: "tp", venue: "curve" }), "an ordinary take-profit on the curve");
  asrt(G.closeDecision({ ...base, venue: "curve", ratio: 1.0, heldMs: 20 * S }) === null, "otherwise hold");
  // The rule can be switched off (0 or the default Infinity): the old behaviour.
  for (const lateMs of [0, Infinity, undefined]) {
    const d = G.closeDecision({ ...base, lateMs, venue: "amm", ratio: 0.0534, heldMs: 2008 * S });
    asrt(same(d, { reason: "sl", venue: "amm" }), `lateMs ${lateMs}: the rule is off, got ${JSON.stringify(d)}`);
  }
  asrt(G.isLate({ heldMs: 331 * S, holdMs: 300 * S, lateMs: 30 * S }) && !G.isLate({ heldMs: 330 * S, holdMs: 300 * S, lateMs: 30 * S }) && !G.isLate({ heldMs: 9e9, holdMs: 1, lateMs: 0 }), "isLate: strictly more than lateMs after the deadline; 0 = off");

  // N: a migrated position leaves at the first quote — but never on the curve, and never late.
  const n = { ...base, exitOnMigration: true };
  asrt(same(G.closeDecision({ ...n, venue: "amm", ratio: 0.95, heldMs: 40 * S }), { reason: "migration-exit", venue: "amm" }), "N: first pool quote -> migration-exit");
  asrt(G.closeDecision({ ...n, venue: "amm", ratio: null, heldMs: 40 * S }) === null, "N without a quote waits like everyone else");
  asrt(same(G.closeDecision({ ...n, venue: "amm", ratio: null, heldMs: 300 * S }), { reason: "timeout", venue: "amm-unpriced" }), "N without a quote at the deadline: unpriced timeout");
  asrt(G.closeDecision({ ...n, venue: "curve", ratio: 1.0, heldMs: 40 * S }) === null && same(G.closeDecision({ ...n, venue: "curve", ratio: 0.7, heldMs: 40 * S }), { reason: "sl", venue: "curve" }), "N before migration: TP / SL / timeout exactly like J");
  asrt(G.closeDecision({ ...n, venue: "amm", ratio: 0.95, heldMs: 2008 * S }).late === true, "N late: unpriced, not a migration-exit");
}

// ---- stall and stale-event detectors ----------------------------------------------------------
{
  asrt(G.stallGapMs(2_050_000, 1_000_000, 30_000) === 1_050_000, "a 1050 s gap between two 1 s ticks is a stall");
  asrt(G.stallGapMs(1_001_200, 1_000_000, 30_000) === 0 && G.stallGapMs(1_030_000, 1_000_000, 30_000) === 0, "an ordinary tick (and exactly the threshold) is not");
  asrt(G.stallGapMs(2_050_000, 1_000_000, 0) === 0 && G.stallGapMs(2_050_000, 0, 30_000) === 0, "threshold 0 = off; no previous tick = nothing to compare");
  // Event timestamps are unix SECONDS (checked against block times on chain).
  asrt(G.eventLagMs(1_794_517_995, 1_794_517_996_500) === 1500, "lag = local clock - event time (seconds -> ms)");
  asrt(G.eventLagMs(1_794_517_995, 1_794_519_345_000) === 1_350_000, "a 22.5 min old event (the backlog after the third freeze)");
  asrt(G.eventLagMs(0, 1e12) === 0 && G.eventLagMs(NaN, 1e12) === 0 && G.eventLagMs(-5, 1e12) === 0, "an unreadable timestamp is never 'stale' (the guard must not blind the lab)");
  asrt(G.eventLagMs(1_794_518_000, 1_794_517_995_000) === -5000, "a clock that runs behind gives a negative lag: not stale");
}

// ---- variants: A–J frozen, K / L / M / N --------------------------------------------------------
const live = readGradStrategy({ GRAD_MIN_FILL_PCT: "80", GRAD_MAX_FILL_PCT: "90", GRAD_MIN_HOLDERS: "5", GRAD_TAKE_PROFIT: "1.5", GRAD_STOP_LOSS: "0.7", GRAD_TIMEOUT_SEC: "300" });
const V = G.buildVariants({ minFill: 92, sl: 0.65, holdSec: 240, live, momentum: { pp: 5, sec: 60 } });
{
  const lab = { minFill: 92, sl: 0.65, holdSec: 240 };
  const frozen = {
    A: { label: "baseline", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    B: { label: "MIN_HOLDERS 7", minHolders: 7, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    C: { label: "MIN_HOLDERS 15", minHolders: 15, maxFill: 100, exitCheck: false, tp: 1.5, ...lab },
    D: { label: "MAX_FILL 95", minHolders: 0, maxFill: 95, exitCheck: false, tp: 1.5, ...lab },
    E: { label: "MAX_FILL 97", minHolders: 0, maxFill: 97, exitCheck: false, tp: 1.5, ...lab },
    F: { label: "exit check >=0.9", minHolders: 0, maxFill: 100, exitCheck: true, tp: 1.5, ...lab },
    G: { label: "B+E+F", minHolders: 7, maxFill: 97, exitCheck: true, tp: 1.5, ...lab },
    H: { label: "TP 1.3", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.3, ...lab },
    I: { label: "enter after migration", postMigration: true, tp: 1.5, ...lab },
    J: { label: "live config", minHolders: 5, maxFill: 90, exitCheck: false, tp: 1.5, minFill: 80, sl: 0.7, holdSec: 300, journalParams: true },
  };
  for (const [id, want] of Object.entries(frozen)) asrt(same(V[id], want), `variant ${id} is exactly what it was before revision 5, got ${JSON.stringify(V[id])}`);
  asrt(Object.keys(V).join("") === "ABCDEFGHIJKLMN", `the table: A–J then K, L, M, N (got ${Object.keys(V).join("")})`);
  asrt(same(G.variantParams(V.J), { minFill: 80, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300 }), "J rows carry the same six parameters as before (no new keys)");

  asrt(same(V.K, { label: "late entry 88-95, holders>=20", minHolders: 20, minFill: 88, maxFill: 95, exitCheck: false, tp: 1.5, sl: 0.7, holdSec: 300, journalParams: true }), `K: fill 88–95, holders >= 20, TP 1.5, SL 0.7, hold 300 (got ${JSON.stringify(V.K)})`);
  asrt(same(V.L, { label: "momentum", minHolders: 5, minFill: 75, maxFill: 90, exitCheck: false, tp: 1.5, sl: 0.7, holdSec: 300, journalParams: true, momentum: { pp: 5, sec: 60 } }), `L: fill 75–90, holders >= 5, +5 pp / 60 s (got ${JSON.stringify(V.L)})`);
  asrt(same(V.M, { ...V.J, label: "live config, SL 0.5", sl: 0.5 }), "M = J with SL 0.5 and nothing else");
  asrt(same(V.N, { ...V.J, label: "live config, exit on migration", exitOnMigration: true }), "N = J plus exitOnMigration and nothing else");
  // K and L do not follow the lab-wide knobs or the live config; M and N follow the live config.
  const V2 = G.buildVariants({ minFill: 60, sl: 0.1, holdSec: 5, live: readGradStrategy({ GRAD_MIN_FILL_PCT: "70", GRAD_MAX_FILL_PCT: "85", GRAD_MIN_HOLDERS: "9", GRAD_TAKE_PROFIT: "2", GRAD_STOP_LOSS: "0.6", GRAD_TIMEOUT_SEC: "120" }), momentum: { pp: 8, sec: 30 } });
  asrt(same({ ...V2.K }, { ...V.K }) && same({ ...V2.L, momentum: null }, { ...V.L, momentum: null }) && same(V2.L.momentum, { pp: 8, sec: 30 }), "K / L: fixed numbers; only L's momentum follows SHADOW_MOMENTUM_PP / _SEC");
  asrt(V2.M.minFill === 70 && V2.M.tp === 2 && V2.M.holdSec === 120 && V2.M.sl === 0.5 && V2.N.sl === 0.6 && V2.N.minHolders === 9, "M / N follow the live config (M keeps SL 0.5)");
  const noLive = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live: null });
  asrt(!noLive.J && !noLive.M && !noLive.N && noLive.K && noLive.L, "without a live config there is no J, M or N (K and L do not need it)");

  asrt(same(G.variantParams(V.K), { minFill: 88, maxFill: 95, minHolders: 20, tp: 1.5, sl: 0.7, holdSec: 300 }), "K params");
  asrt(same(G.variantParams(V.L), { minFill: 75, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300, momentumPp: 5, momentumSec: 60 }), "L params carry the momentum rule");
  asrt(same(G.variantParams(V.M), { minFill: 80, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.5, holdSec: 300 }), "M params");
  asrt(same(G.variantParams(V.N), { minFill: 80, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300, exitOnMigration: true }), "N params carry exitOnMigration");

  // Threshold = the lowest minFill of the ACTIVE variants, as before.
  asrt(G.candidateThreshold(V) === 75 && G.candidateThreshold(V, G.activeVariantIds(V, "ABCDEFGHJ")) === 80 && G.candidateThreshold(V, G.activeVariantIds(V, "ak")) === 88, "candidate threshold follows the active set (75 with L, 80 for A–J, 88 for A+K)");
  asrt(G.activeVariantIds(V, "I").length === 0 && G.activeVariantIds(V, " j, n ").join("") === "JN", "SHADOW_VARIANTS: letters only, case-insensitive; I never trades");

  // Entry filters.
  const acc = (c) => G.activeVariantIds(V).filter((id) => G.variantAccepts(V[id], c)).join("");
  asrt(acc({ fill: 90, holders: 25, gainPp: 12 }) === "JKLMN", `fill 90 / 25 holders / +12 pp: J, K, L, M, N (got "${acc({ fill: 90, holders: 25, gainPp: 12 })}")`);
  asrt(acc({ fill: 90, holders: 19, gainPp: 12 }) === "JLMN", "K needs 20 holders");
  asrt(acc({ fill: 87.9, holders: 25, gainPp: 0 }) === "JMN" && acc({ fill: 88, holders: 25, gainPp: 0 }) === "JKMN", "K band starts at 88; L needs momentum");
  asrt(acc({ fill: 95, holders: 25, gainPp: 50 }) === "ABCDEFGHK" && acc({ fill: 95.1, holders: 25, gainPp: 50 }) === "ABCEFGH", "K band ends at 95 (inclusive)");
  asrt(acc({ fill: 76, holders: 5, gainPp: 5 }) === "L" && acc({ fill: 76, holders: 5, gainPp: 4.99 }) === "" && acc({ fill: 76, holders: 5, gainPp: null }) === "" && acc({ fill: 76, holders: 5 }) === "", "L: +5 pp inclusive; unknown history (null) never enters");
  asrt(acc({ fill: 76, holders: 4, gainPp: 30 }) === "" && acc({ fill: 90.1, holders: 9, gainPp: 30 }) === "" && acc({ fill: 74.9, holders: 9, gainPp: 30 }) === "", "L: holders >= 5, band 75–90");
  for (const c of [{ fill: 80, holders: 5 }, { fill: 79.9, holders: 9 }, { fill: 90, holders: 4 }, { fill: 90.1, holders: 9 }, { fill: 85, holders: 50 }]) {
    asrt(G.variantAccepts(V.M, c) === G.variantAccepts(V.J, c) && G.variantAccepts(V.N, c) === G.variantAccepts(V.J, c), `M and N enter exactly where J does (${JSON.stringify(c)})`);
  }
}

// ---- momentum history ---------------------------------------------------------------------------
{
  const W = 60 * S;
  asrt(G.fillGainPp([], 1000, 76, W) === null, "no history: unknown, not zero");
  const h = [];
  G.pushFillSample(h, 0, 40, W);
  asrt(G.fillGainPp(h, 500, 76, W) === 36, "a mint first seen half a second ago is measured from its first sample (a 0 -> 76% burst is momentum)");
  for (let t = 100; t < 1000; t += 100) G.pushFillSample(h, t, 40 + t / 100, W);
  asrt(h.length === 1, "at most one sample per second");
  G.pushFillSample(h, 30 * S, 70, W);
  G.pushFillSample(h, 59 * S, 74, W);
  asrt(G.fillGainPp(h, 60 * S, 76, W) === 36, "exactly 60 s later the sample at t=0 is the fill 'a window ago' (40 -> 76)");
  asrt(G.fillGainPp(h, 89 * S, 76, W) === 36 && G.fillGainPp(h, 90 * S, 76, W) === 6, "the reference is the LATEST sample at or before now - window (70 at t=30 s -> +6)");
  asrt(G.fillGainPp(h, 200 * S, 76, W) === 2, "a mint that sat at 74% and ticks to 76% has +2 pp, whatever it did an hour ago");
  asrt(G.fillGainPp(h, 90 * S, 60, W) === -10, "a falling fill is a negative gain");
  // Pruning keeps exactly one sample at or before the start of the window.
  const p = [];
  for (let t = 0; t <= 300 * S; t += S) G.pushFillSample(p, t, t / S / 4, W);
  asrt(p.length === 61 && p[0].t === 240 * S && p[60].t === 300 * S, `a hot mint costs ~60 samples (got ${p.length}, first at ${p[0].t / S} s)`);
  asrt(G.fillGainPp(p, 300 * S, 75, W) === 75 - 60, "…and the gain is still measured against the fill 60 s ago");
}

// ---- journal rows ---------------------------------------------------------------------------------
{
  const pos = { variant: "J", mint: "MintJ", entryPrice: 1e-7, at: 1_000, tokens: 66_000_000_000n };
  const late = G.tradeRow({ pos, v: V.J, reason: "timeout", venue: "curve-unpriced", buySol: BUY, now: 1_519_000, extra: { late: true, lateSec: 1218, stallSec: 1350 } });
  asrt(late.exitVenue === "curve-unpriced" && late.migrated === false && late.unconfirmed === true, "curve-unpriced row: flagged, NOT migrated");
  asrt(late.netSol === null && late.netPct === null && late.ratio === null && late.exitPrice === null, "curve-unpriced row has no result");
  asrt(late.late === true && late.lateSec === 1218 && late.stallSec === 1350 && late.holdSec === 1518 && late.reason === "timeout", "…and says why: late, by how much, after how long a stall");
  const un = G.tradeRow({ pos, v: V.J, reason: "timeout", venue: "amm-unpriced", buySol: BUY, now: 301_000 });
  asrt(un.exitVenue === "amm-unpriced" && un.migrated === true && un.late === undefined, "amm-unpriced row as before (an on-time unpriced timeout is not 'late')");
  const row = G.tradeRow({ pos: { ...pos, variant: "N" }, v: V.N, reason: "migration-exit", venue: "amm", amm: { solOut: 19_000_000n, feeBps: 30, ageMs: 3 }, buySol: BUY, now: 41_000 });
  asrt(row.reason === "migration-exit" && row.exitVenue === "amm" && row.ratio === 0.95 && Number.isFinite(row.netPct) && row.params.exitOnMigration === true, "N row: a priced AMM exit with its parameters");
  const o = G.openRow({ variantId: "L", v: V.L, mint: "M", fill: 78, holders: 7, spot: 1e-7, buySol: BUY, tokens: 1n, gainPp: 68.004 });
  asrt(o.gainPp === 68 && o.params.momentumPp === 5 && o.label === "momentum", "L open row: the gain it entered on + its parameters");
  const oj = G.openRow({ variantId: "J", v: V.J, mint: "M", fill: 80, holders: 6, spot: 1e-7, buySol: BUY, tokens: 1n, gainPp: 68 });
  asrt(oj.gainPp === undefined, "only a momentum variant journals gainPp");
  for (const r of [late, un, row, o, oj]) asrt(r.shadowRev === 5 && G.SHADOW_REV === 5 && r.costsScheme === SHADOW_COSTS_SCHEME && r.costsScheme.startsWith("v5-amm-fee"), "rows carry shadowRev 5 (rules) next to the cost scheme (v5-amm-fee since KODING №10: the AMM fee changed, the rules did not)");
}

// ---- the report counts late / stalled rows and keeps them out of the averages -----------------
{
  const dir = tmp("gshadow5-report-");
  const file = path.join(dir, "j.jsonl");
  const row = (variant, mint, netPct, more = {}) => JSON.stringify({ ts: "2026-11-13T10:00:00.000Z", type: "gshadow_trade", costsScheme: SHADOW_COSTS_SCHEME, shadowRev: 5, variant, mint, netPct, reason: "timeout", ...more });
  fs.writeFileSync(file, [
    row("J", "M1", 10, { exitVenue: "curve", migrated: false }),
    row("J", "M2", -30, { exitVenue: "amm", migrated: true, stallSec: 40 }),
    row("J", "M3", null, { exitVenue: "amm-unpriced", migrated: true, unconfirmed: true, late: true, lateSec: 1708, stallSec: 2007 }),
    row("J", "M4", null, { exitVenue: "curve-unpriced", migrated: false, unconfirmed: true, late: true, lateSec: 1218, stallSec: 1350 }),
  ].join("\n") + "\n");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "analyze-graduation.mjs"), file], { cwd: root, encoding: "utf8", env: cleanEnv({}) });
  asrt(r.status === 0, `the report runs (stderr: ${String(r.stderr).split("\n")[0]})`);
  asrt(/exit venues: curve=1 amm=1 amm-unpriced=1 curve-unpriced=1/.test(r.stdout), `the venue mix shows curve-unpriced: ${(r.stdout.match(/exit venues:.*/) || [""])[0]}`);
  asrt(/STALL: 2 trade\(s\) closed late without a result; 3 trade\(s\) lived through a process stall \(up to 2007 s unwatched; 1 of them are priced/.test(r.stdout), `late / stalled rows are counted: ${(r.stdout.match(/STALL:.*/) || [""])[0]}`);
  asrt(/UNPRICED: 2 of 4/.test(r.stdout), "both unpriced kinds are excluded");
  const jRow = (r.stdout.match(/^J\s+.*$/m) || [""])[0];
  asrt(/^J\s+2\s/.test(jRow) && /-10\.00%/.test(jRow), `J statistics: the 2 priced trades, mean (10 - 30) / 2 = -10.00% (got "${jRow}")`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// =============================================================================================
// End to end: the real handler in bots/graduation-sniper/shadow.mjs
// =============================================================================================
const COSTS = { CU_PRICE: "1500000", CU_LIMIT: "300000", SLIPPAGE_ASSUMED_BPS: "50" };
async function runShadow(name, overrides) {
  const dir = tmp(`gshadow5-${name}-journal-`);
  const env = cleanEnv({
    ROOT: tmp(`gshadow5-${name}-root-`), // a fresh ROOT: the developer's .env must not leak in
    RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
    WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
    JOURNAL_DIR: dir,
    SHADOW_BUY_SOL: String(BUY),
    ...COSTS,
    ...overrides,
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "shadow.mjs")], { cwd: root, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  const code = await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 60_000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });
  const records = readJournal(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const fatal = /TypeError|ReferenceError|Cannot access .* before initialization|UnhandledPromiseRejection/;
  asrt(code === 0, `[${name}] the shadow lab exited 0 (got ${code}); stderr: ${err.split(/\r?\n/)[0] || ""}`);
  asrt(!fatal.test(err + out), `[${name}] no exception in the run, got: ${(err.match(fatal) || [""])[0]} ${err.split(/\r?\n/)[0] || ""}`);
  const of = (type) => records.filter((x) => x.type === type);
  return { out, opens: of("gshadow_open"), trades: of("gshadow_trade"), candidates: of("gshadow_candidate"), stalls: of("gshadow_stall"), stale: of("gshadow_stale_events") };
}

const RPC_AMM = path.join(here, "mocks", "rpc-mock-amm.mjs");
const RPC_CURVE = path.join(here, "mocks", "rpc-mock.mjs");
const AJ = "ABCDEFGHJ";
// A 2 s timeout, a pool that pays ~0.80 of the buy, a stop-loss at 0.9: once the pool is quoted the
// position is a stop-loss — the shape of the journaled artifact (SL 0.7, pool paying 0.05).
const STALL = {
  RPC_MOCK: RPC_AMM, RPC_AMM_MINTS: FIRST_MINT, RPC_AMM_POOL: "1", MIN_FILL: "92", SHADOW_VARIANTS: AJ,
  WS_MOCK_SCENARIO: "stall", WS_MOCK_STALL_MS: "6000",
  SHADOW_SL: "0.9", GRAD_STOP_LOSS: "0.9", SHADOW_HOLD_SEC: "2", GRAD_TIMEOUT_SEC: "2", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "14",
};
const CURVE_ERR = {
  RPC_MOCK: RPC_AMM, RPC_AMM_MINTS: FIRST_MINT, RPC_AMM_POOL: "1", RPC_AMM_CURVE: "error", MIN_FILL: "92", SHADOW_VARIANTS: "AJ",
  WS_MOCK_SCENARIO: "migrate", SHADOW_SL: "0", SHADOW_HOLD_SEC: "2", GRAD_TIMEOUT_SEC: "2", SHADOW_MAX_SEC: "10",
};
const STALE = { RPC_MOCK: RPC_CURVE, MIN_FILL: "92", SHADOW_VARIANTS: AJ, WS_MOCK_SCENARIO: "stale", WS_MOCK_STALE_LAG_SEC: "600", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "4" };
const LIVE_BAND = { GRAD_MIN_FILL_PCT: "75", GRAD_MAX_FILL_PCT: "90", GRAD_MIN_HOLDERS: "5", GRAD_TAKE_PROFIT: "1.5", GRAD_STOP_LOSS: "0.7", GRAD_TIMEOUT_SEC: "300" };

const [stallOn, stallOff, errOn, errOff, staleOn, staleOff, momentum, migExit] = await Promise.all([
  runShadow("stall-on", { ...STALL, SHADOW_LATE_SEC: "2" }),
  runShadow("stall-off", { ...STALL, SHADOW_LATE_SEC: "0" }),
  runShadow("curve-err-on", { ...CURVE_ERR, SHADOW_LATE_SEC: "2" }),
  runShadow("curve-err-off", { ...CURVE_ERR, SHADOW_LATE_SEC: "0" }),
  runShadow("stale-on", { ...STALE }), // default SHADOW_LATE_SEC (30 s)
  runShadow("stale-off", { ...STALE, SHADOW_LATE_SEC: "0" }),
  // All variants (SHADOW_VARIANTS unset), live band 75–90, a 2 s momentum window.
  runShadow("momentum", { RPC_MOCK: RPC_CURVE, ...LIVE_BAND, WS_MOCK_SCENARIO: "momentum", SHADOW_MOMENTUM_SEC: "2", SHADOW_MOMENTUM_PP: "5", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "9" }),
  // J and N on a mint that migrates with a pool: default live config (fill 92–97, SL 0.7, pool ~0.80).
  runShadow("migration-exit", { RPC_MOCK: RPC_AMM, RPC_AMM_MINTS: FIRST_MINT, RPC_AMM_POOL: "1", MIN_FILL: "92", SHADOW_VARIANTS: "JN", WS_MOCK_SCENARIO: "migrate", SHADOW_SL: "0", SHADOW_HOLD_SEC: "4", GRAD_TIMEOUT_SEC: "4", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "12" }),
]);

// ---- P0: the process stalls right after the curve completes ----------------------------------------
{
  // [off] the old behaviour: the artifact.
  const { opens, trades, stalls } = stallOff;
  asrt(opens.length === 9 && trades.length === 9, `[stall off] 9 positions opened and closed (got ${opens.length}/${trades.length})`);
  asrt(trades.every((t) => t.exitVenue === "amm" && t.reason === "sl" && t.netPct < -20), `[stall off] the artifact: a priced stop-loss, got ${uniq(trades, (t) => `${t.exitVenue}/${t.reason}`)}`);
  asrt(trades.every((t) => t.holdSec >= 6), `[stall off] …booked at >= 3x the 2 s timeout, got holdSec ${uniq(trades, (t) => t.holdSec)}`);
  asrt(stalls.length === 0 && trades.every((t) => t.late === undefined && t.stallSec === undefined), "[stall off] and nothing in the journal says the lab was not watching");
}
{
  const { opens, trades, stalls, out } = stallOn;
  asrt(opens.length === 9 && trades.length === 9, `[stall on] 9 positions opened and journaled (got ${opens.length}/${trades.length})`);
  const big = stalls.filter((s) => s.stallSec >= 5);
  asrt(big.length === 1 && big[0].open === 9, `[stall on] the stall is journaled once with the positions it covered, got ${JSON.stringify(stalls)}`);
  asrt(trades.every((t) => t.exitVenue === "amm-unpriced" && t.reason === "timeout"), `[stall on] overdue positions: timeout / amm-unpriced, got ${uniq(trades, (t) => `${t.exitVenue}/${t.reason}`)}`);
  asrt(trades.every((t) => t.netSol === null && t.netPct === null && t.ratio === null && t.unconfirmed === true), "[stall on] NO result is booked (the old lab: sl at the pool's later price)");
  asrt(trades.every((t) => t.late === true && t.lateSec >= 3 && t.stallSec >= 5 && t.holdSec >= 6), `[stall on] each row says it is late and stalled, got ${JSON.stringify(trades[0])}`);
  asrt(new Set(trades.map((t) => `${t.variant}:${t.mint}`)).size === 9, "[stall on] each position is closed once");
  asrt(/STALL: the process did not run for \d+s/.test(out), "[stall on] the stall is printed");
  asrt(opens.every((o) => o.shadowRev === 5) && trades.every((t) => t.shadowRev === 5), "[stall on] rows carry shadowRev 5");
}

// ---- P0: a migration check that keeps failing --------------------------------------------------------
{
  const { opens, trades } = errOff;
  asrt(opens.length === 2 && trades.length === 2, `[curve-err off] A and J opened and journaled (got ${opens.length}/${trades.length})`);
  asrt(trades.every((t) => t.reason === "manual stop" && t.holdSec >= 7), `[curve-err off] the old behaviour: a 2 s timeout never fires, the position lives until the stop (got ${uniq(trades, (t) => `${t.reason}@${t.holdSec}`)})`);
}
{
  const { opens, trades } = errOn;
  asrt(opens.length === 2 && trades.length === 2, `[curve-err on] A and J opened and journaled (got ${opens.length}/${trades.length})`);
  asrt(trades.every((t) => t.reason === "timeout" && t.exitVenue === "amm-unpriced" && t.late === true && t.netSol === null), `[curve-err on] closed by the rule, without a result, got ${uniq(trades, (t) => `${t.reason}/${t.exitVenue}/${t.late}`)}`);
  asrt(trades.every((t) => t.holdSec >= 4 && t.holdSec <= 6), `[curve-err on] at timeout + SHADOW_LATE_SEC (2 + 2 s), not at the stop (got ${uniq(trades, (t) => t.holdSec)})`);
}

// ---- P0: the backlog after a stall --------------------------------------------------------------------
{
  asrt(staleOff.opens.length === 9, `[stale off] the old behaviour: a 10-minute-old event opens 9 positions at its price (got ${staleOff.opens.length})`);
  const { opens, candidates, stale, out } = staleOn;
  asrt(opens.length === 0 && !candidates.some((c) => c.fill >= 92), `[stale on] a stale event opens nothing and is not a candidate (got ${opens.length} opens)`);
  const dropped = stale.reduce((a, r) => a + r.events, 0);
  asrt(dropped === 1 && stale[0].maxLagSec >= 598 && stale[0].maxLagSec <= 610, `[stale on] the drop is journaled with its lag, got ${JSON.stringify(stale)}`);
  asrt(/dropped 1 stream event\(s\) older than 30s/.test(out), "[stale on] and printed (default SHADOW_LATE_SEC = 30)");
  asrt(/clock guards 30s/.test(out) && /clock guards OFF/.test(staleOff.out), "the startup line shows the guard setting");
}

// ---- P2: K and L end to end ------------------------------------------------------------------------------
{
  const { opens, trades, candidates, out } = momentum;
  const of = (mint) => opens.filter((o) => o.mint === mint).map((o) => o.variant).sort().join("");
  asrt(of(MOM_MINT) === "JLMN", `[momentum] 10 -> 78% within a second, 7 holders: J, L, M, N (got "${of(MOM_MINT)}")`);
  asrt(of(SLOW_MINT) === "JMN", `[momentum] 73 -> 76% (+3 pp over the window): J, M, N and NOT L (got "${of(SLOW_MINT)}")`);
  asrt(of(LATE_MINT) === "JKLMN", `[momentum] 90% with 25 holders: K joins (got "${of(LATE_MINT)}")`);
  const l = opens.find((o) => o.mint === MOM_MINT && o.variant === "L");
  asrt(l.gainPp === 68 && l.fill === 78 && same(l.params, { minFill: 75, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300, momentumPp: 5, momentumSec: 2 }), `[momentum] L open row: gain 68 pp, env-driven window (got ${JSON.stringify({ g: l.gainPp, p: l.params })})`);
  const k = opens.find((o) => o.variant === "K");
  asrt(k.fill === 90 && k.holders === 25 && same(k.params, { minFill: 88, maxFill: 95, minHolders: 20, tp: 1.5, sl: 0.7, holdSec: 300 }), "[momentum] K open row carries its fixed parameters");
  const m = opens.find((o) => o.variant === "M");
  const n = opens.find((o) => o.variant === "N");
  asrt(m.params.sl === 0.5 && m.params.minFill === 75 && n.params.exitOnMigration === true && n.params.sl === 0.7, "[momentum] M / N rows: the live band, SL 0.5 / exit on migration");
  asrt(candidates.length > 0 && !candidates.some((c) => c.fill < 75), "[momentum] candidate threshold 75 (the lowest minFill of the active variants)");
  asrt(/variants ABCDEFGHJKLMN \| candidate threshold 75%/.test(out) && /L momentum \+5pp \/ 2s/.test(out), "[momentum] the startup lines show the variants and the momentum rule");
  asrt(trades.length === opens.length && trades.every((t) => t.reason === "manual stop" && t.exitVenue === "curve" && t.late === undefined && t.stallSec === undefined), "[momentum] ordinary curve exits at the stop, no late / stall flags in a healthy run");
}

// ---- P2: N leaves at the first pool quote; J (with a quote) times out at the quote ------------------------
{
  const { opens, trades } = migExit;
  asrt(opens.map((o) => o.variant).sort().join("") === "JN" && trades.length === 2, `[migration-exit] J and N opened and closed (got ${opens.length}/${trades.length})`);
  const j = trades.find((t) => t.variant === "J");
  const n = trades.find((t) => t.variant === "N");
  asrt(n.reason === "migration-exit" && n.exitVenue === "amm" && n.migrated === true && n.unconfirmed === undefined, `[migration-exit] N: migration-exit on the AMM (got ${n.reason}/${n.exitVenue})`);
  asrt(n.ratio > 0.75 && n.ratio < 0.85 && Number.isFinite(n.netPct) && n.holdSec < 4, `[migration-exit] N: priced at the first quote (~0.80), before the 4 s timeout (ratio ${n.ratio}, holdSec ${n.holdSec})`);
  asrt(j.reason === "timeout" && j.exitVenue === "amm" && j.ratio === n.ratio && j.holdSec >= 4 && j.holdSec <= 5 && j.late === undefined, `[migration-exit] J on the same mint: timeout at the pool quote, on time (got ${j.reason}/${j.exitVenue}@${j.holdSec})`);
  asrt(n.params.exitOnMigration === true && j.params.exitOnMigration === undefined, "[migration-exit] only N's rows carry exitOnMigration");
}

console.log(JSON.stringify({ stallOff: stallOff.trades[0].reason, stallOn: stallOn.trades[0].exitVenue, stallSec: stallOn.stalls.map((s) => s.stallSec), L: momentum.opens.filter((o) => o.variant === "L").length, N: migExit.trades.find((t) => t.variant === "N").reason }));
console.log("PASS: shadow rev 5 — a stalled process books no result (stall / late / stale guards); variants K, L, M, N; A–J unchanged");
