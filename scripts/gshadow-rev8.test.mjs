import "./lib/test-env.mjs";
// Graduation shadow lab, revision 8 (KODING #18): "US hours" variants O / P / Q / R, the launcher
// (create-event signer) from the stream, no holder minimum. No network: fixture socket + fixture RPC.
//
// Capture (run ONCE, against the unchanged revision-7 shadow.mjs, before revision 8 was written):
//   node scripts/gshadow-rev8.test.mjs --capture   -> tests/fixtures/gshadow-rev7-golden.json
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const GOLDEN = path.join(root, "tests", "fixtures", "gshadow-rev7-golden.json");
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

const { readJournal } = await import("../lib/journal.mjs");
const M = await import("./mocks/ws-mock-shadow.mjs");

// =============================================================================================
// The replay harness (shared by the golden capture and the comparison)
// =============================================================================================
const RPC_CURVE = path.join(here, "mocks", "rpc-mock.mjs");
const RPC_AMM = path.join(here, "mocks", "rpc-mock-amm.mjs");
const COMMON = { CU_PRICE: "1500000", CU_LIMIT: "300000", SLIPPAGE_ASSUMED_BPS: "50", SHADOW_BUY_SOL: "0.02", MIN_FILL: "92" };
const LIVE_BAND = { GRAD_MIN_FILL_PCT: "75", GRAD_MAX_FILL_PCT: "90", GRAD_MIN_HOLDERS: "5", GRAD_TAKE_PROFIT: "1.5", GRAD_STOP_LOSS: "0.7", GRAD_TIMEOUT_SEC: "300" };
const SCENARIOS = {
  single: { RPC_MOCK: RPC_CURVE, WS_MOCK_SCENARIO: "single", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5" },
  features: { RPC_MOCK: RPC_CURVE, WS_MOCK_SCENARIO: "features", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "6" },
  "live-band": { RPC_MOCK: RPC_CURVE, ...LIVE_BAND, WS_MOCK_SCENARIO: "live-band", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5" },
  migrate: { RPC_MOCK: RPC_AMM, RPC_AMM_MINTS: M.FIRST_MINT, RPC_AMM_POOL: "1", SHADOW_VARIANTS: "JN", WS_MOCK_SCENARIO: "migrate", SHADOW_SL: "0", SHADOW_HOLD_SEC: "4", GRAD_TIMEOUT_SEC: "4", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "10" },
  // Revision 8's scenario: launchers (serial, launcher-mode, unseen, 25 h old launches), 1-holder entries.
  launcher: { RPC_MOCK: RPC_CURVE, WS_MOCK_SCENARIO: "launcher", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5" },
};

async function runShadow(name, overrides, { expectExit = 0 } = {}) {
  const dir = tmp(`gshadow8-${name}-journal-`);
  const env = cleanEnv({
    ROOT: tmp(`gshadow8-${name}-root-`), // a fresh ROOT: the developer's .env must not leak in
    RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
    WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
    JOURNAL_DIR: dir,
    ...COMMON,
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
  const records = fs.existsSync(dir) ? readJournal(dir) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  const fatal = /TypeError|ReferenceError|RangeError|Cannot access .* before initialization|UnhandledPromiseRejection/;
  asrt(code === expectExit, `[${name}] the shadow lab exited ${expectExit} (got ${code}); stderr: ${err.split(/\r?\n/)[0] || ""}`);
  asrt(!fatal.test(err + out), `[${name}] no exception in the run: ${(err.match(fatal) || [""])[0]} ${err.split(/\r?\n/)[0] || ""}`);
  const of = (type) => records.filter((x) => x.type === type);
  return { out, err, records, opens: of("gshadow_open"), trades: of("gshadow_trade"), candidates: of("gshadow_candidate") };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const byKey = (a, b) => `${a.mint}:${a.variant}`.localeCompare(`${b.mint}:${b.variant}`);
function decisions(run) {
  return {
    opens: run.opens.map((o) => pick(o, ["variant", "mint", "label", "fill", "holders", "entryPrice", "spot", "slipBps", "buySol", "tokens", "gainPp", "params", "costsScheme"])).sort(byKey),
    trades: run.trades
      .map((t) => pick(t, ["variant", "mint", "reason", "exitVenue", "migrated", "unconfirmed", "late", "entryPrice", "exitPrice", "ratio", "netSol", "netPct", "slipBps", "ammSolOut", "ammFeeBps", "ammFeeSource", "tokens", "params", "costsScheme"]))
      .sort(byKey),
    candidates: run.candidates.map((c) => pick(c, ["mint", "fill", "holders", "price"])),
  };
}

async function replayAll(extra = {}) {
  const names = Object.keys(SCENARIOS);
  const runs = await Promise.all(names.map((n) => runShadow(n, { ...SCENARIOS[n], ...extra })));
  return Object.fromEntries(names.map((n, i) => [n, runs[i]]));
}

if (process.argv.includes("--capture")) {
  const runs = await replayAll();
  const golden = Object.fromEntries(Object.entries(runs).map(([n, r]) => [n, decisions(r)]));
  fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + "\n");
  console.log(`captured ${GOLDEN}: ${Object.entries(golden).map(([n, g]) => `${n} ${g.opens.length}/${g.trades.length}`).join(", ")}`);
  process.exit(0);
}

const G = await import("../lib/gshadow.mjs");
const F = await import("../lib/gshadow-features.mjs");
const { readGradStrategy } = await import("../lib/grad-config.mjs");
const KEEP = "AFJKLMN"; // the variants whose decisions must be exactly revision 7's
const only = (d, ids) => ({ opens: d.opens.filter((o) => ids.includes(o.variant)), trades: d.trades.filter((t) => ids.includes(t.variant)), candidates: d.candidates });
const utc = (h, m, s) => Date.UTC(2026, 10, 15, h, m, s) / 1000;

// =============================================================================================
// 1. The hour window (pure)
// =============================================================================================
{
  const w = G.parseHoursUtc(undefined);
  asrt(w.start === 19 && w.end === 23 && w.text === "19-23" && same(G.parseHoursUtc(""), w) && same(G.parseHoursUtc("19-23"), w), "default window 19-23 (unset / empty)");
  const at = (h, m, s, win = w) => G.inHoursUtc(utc(h, m, s), win);
  asrt(!at(18, 59, 59) && at(19, 0, 0) && at(22, 59, 59) && !at(23, 0, 0), "19-23: 18:59:59 out, 19:00:00 in, 22:59:59 in, 23:00:00 out");
  const wrap = G.parseHoursUtc("22-02");
  asrt(wrap.start === 22 && wrap.end === 2 && wrap.text === "22-02", "22-02 parses");
  asrt(!at(21, 59, 59, wrap) && at(22, 0, 0, wrap) && at(23, 59, 59, wrap) && at(0, 0, 0, wrap) && at(1, 59, 59, wrap) && !at(2, 0, 0, wrap) && !at(12, 0, 0, wrap), "22-02 wraps over midnight: 22:00:00..01:59:59");
  asrt(G.inHoursUtc(utc(23, 30, 0), G.parseHoursUtc("0-24")) && G.inHoursUtc(utc(0, 0, 0), G.parseHoursUtc("0-24")), "0-24 = all day");
  asrt(G.hourUtc(utc(19, 0, 0)) === 19 && G.hourUtc(null) === null && G.hourUtc(0) === null && !G.inHoursUtc(null, w), "hourUtc; an unknown time is never inside");
  for (const bad of ["abc", "19", "19-19", "24-02", "19-25", "-1-3", "19-23x", "19:00-23:00", "7 - 9"]) {
    let threw = false;
    try {
      G.parseHoursUtc(bad);
    } catch (e) {
      threw = /SHADOW_HOURS_UTC/.test(e.message);
    }
    asrt(threw, `SHADOW_HOURS_UTC="${bad}" throws a named error`);
  }
  asrt(G.parseSerialLaunches(undefined) === 3 && G.parseSerialLaunches("") === 3 && G.parseSerialLaunches("5") === 5, "SHADOW_SERIAL_LAUNCHES default 3");
  for (const bad of ["1", "0", "2.5", "x", "-3"]) {
    let threw = false;
    try {
      G.parseSerialLaunches(bad);
    } catch (e) {
      threw = /SHADOW_SERIAL_LAUNCHES/.test(e.message);
    }
    asrt(threw, `SHADOW_SERIAL_LAUNCHES="${bad}" throws`);
  }
}

// =============================================================================================
// 2. The launcher index (pure)
// =============================================================================================
const T0 = utc(20, 0, 0);
{
  const ix = F.createLauncherIndex();
  F.noteLaunch(ix, { mint: "SOLO", user: "U1", creator: "U1", timestampSec: T0 - 100 });
  F.noteLaunch(ix, { mint: "SOLO", user: "U1", creator: "U1", timestampSec: T0 - 100 }); // re-delivered: once
  for (const [m, age] of [["S1", 7200], ["S2", 3600], ["S3", 60]]) F.noteLaunch(ix, { mint: m, user: "U2", creator: "U2", timestampSec: T0 - age });
  F.noteLaunch(ix, { mint: "MODE", user: "U3", creator: "FEE", timestampSec: T0 - 60 });
  for (const [m, age] of [["O1", 93_600], ["O2", 90_000], ["O3", 30]]) F.noteLaunch(ix, { mint: m, user: "U4", creator: "U4", timestampSec: T0 - age });
  asrt(F.noteLaunch(ix, { mint: "NOUSER", creator: "X", timestampSec: T0 }) === null && F.noteLaunch(ix, { mint: "NOTIME", user: "X", creator: "X", timestampSec: 0 }) === null, "a create without a signer or a time is not indexed");
  const info = (m) => F.launcherInfo(ix, m, T0);
  asrt(same(info("SOLO"), { known: true, launcher: "U1", creator: "U1", isCreator: true, launches24h: 1 }), `user = creator, 1 launch (got ${JSON.stringify(info("SOLO"))})`);
  asrt(info("S3").launches24h === 3 && info("S3").isCreator, "3 launches by one user in 24 h");
  asrt(info("S2").launches24h === 3, "the count is the launcher's in the window up to the event, not up to this create");
  asrt(info("MODE").isCreator === false, "user != creator");
  asrt(same(info("UNSEEN"), { known: false }), "create not seen -> unknown");
  asrt(info("O3").launches24h === 1, "launches 25 h and 26 h ago are not counted");
  asrt(F.launcherInfo(ix, "O3", T0 + 86_400).known === false, "a create older than 24 h is unknown (not guessed)");
  asrt(F.launcherInfo(ix, "S1", T0 - 7200).launches24h === 1, "a launch AFTER the event is not counted (only on-chain time <= now)");
  asrt(same(F.deployerFeatures(info("MODE")), { deployer: "U3", deployerIsCreator: false, deployerLaunches24h: 1 }) && same(F.deployerFeatures({ known: false }), { deployer: null, deployerIsCreator: null, deployerLaunches24h: null }) && same(F.deployerFeatures(null), F.deployerFeatures({ known: false })), "deployer feat fields: null when unknown, never guessed");
  // The gates of P / Q.
  const V = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live: readGradStrategy({}) });
  const gate = (id, m, holders = 1, sec = T0) => G.variantGate(V[id], { fill: 93, holders, eventSec: sec, launcher: () => F.launcherInfo(ix, m, sec) });
  asrt(gate("P", "SOLO") === null && gate("Q", "SOLO") === null, "user = creator with 1 launch -> P / Q open");
  asrt(gate("P", "S3") === "serialLauncher" && gate("Q", "S3") === "serialLauncher", "3 launches in 24 h -> skip (serialLauncher)");
  asrt(gate("P", "MODE") === "launcherMode" && gate("Q", "MODE") === "launcherMode", "user != creator -> skip (launcherMode)");
  asrt(gate("P", "UNSEEN") === "launcherUnknown" && gate("Q", "UNSEEN") === "launcherUnknown", "create not seen -> skip (launcherUnknown)");
  asrt(gate("Q", "O3") === null, "launches 25 h ago are not counted -> Q opens");
  asrt(gate("P", "SOLO", 1, utc(12, 0, 0)) === "outsideHours" && gate("P", "UNSEEN", 1, utc(12, 0, 0)) === "outsideHours", "P checks the hour before the launcher");
  asrt(gate("R", "UNSEEN") === null && gate("O", "UNSEEN") === null && gate("O", "UNSEEN", 1, utc(23, 0, 0)) === "outsideHours", "O / R do not read the launcher; O reads the hour");
  const V4 = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live: readGradStrategy({}), serialLaunches: 4 });
  asrt(G.variantGate(V4.Q, { fill: 93, holders: 1, eventSec: T0, launcher: info("S3") }) === null, "SHADOW_SERIAL_LAUNCHES=4: 3 launches are not serial");
  // Trim to 24 h by on-chain time.
  F.trimLaunchers(ix, T0);
  asrt(!ix.mints.has("O1") && !ix.mints.has("O2") && ix.mints.has("O3") && ix.launchers.get("U4").length === 1 && same(F.launcherStats(ix), { launchMints: 6, launchers: 4 }), `trimmed to 24 h (got ${JSON.stringify(F.launcherStats(ix))})`);
  F.trimLaunchers(ix, T0 + 86_400);
  asrt(same(F.launcherStats(ix), { launchMints: 0, launchers: 0 }), "after 24 h everything is gone, empty keys deleted");
}

// =============================================================================================
// 3. The variant table (pure)
// =============================================================================================
{
  const V = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live: readGradStrategy({}) });
  asrt(G.activeVariantIds(V).join("") === "AFJKLMNOPQR", `default active set A F J K L M N O P Q R (got ${G.activeVariantIds(V).join("")})`);
  asrt(G.activeVariantIds(V, "BCDEGH").join("") === "BCDEGH" && G.knownVariantIds(V).join("") === "ABCDEFGHJKLMNOPQR", "B C D E G H still selectable by SHADOW_VARIANTS");
  const strip = (v, keys) => Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
  for (const id of "OPQR") {
    asrt(same(strip(V[id], ["label", "minHolders", "hoursUtc", "noSerialLauncher", "serialLaunches"]), strip(V.N, ["label", "minHolders"])) && V[id].minHolders === 0, `${id} = N with minHolders 0 (and its own gates)`);
  }
  asrt(!!V.O.hoursUtc && !V.O.noSerialLauncher && !!V.P.hoursUtc && V.P.noSerialLauncher && !V.Q.hoursUtc && V.Q.noSerialLauncher && !V.R.hoursUtc && !V.R.noSerialLauncher, "gates: O hours, P hours + launcher, Q launcher, R none");
  const base = { minFill: 92, maxFill: 97, minHolders: 0, tp: 1.5, sl: 0.7, holdSec: 300, exitOnMigration: true };
  asrt(same(G.variantParams(V.R), base) && same(G.variantParams(V.O), { ...base, hoursUtc: "19-23" }) && same(G.variantParams(V.P), { ...base, hoursUtc: "19-23", noSerialLauncher: true, serialLaunches: 3 }) && same(G.variantParams(V.Q), { ...base, noSerialLauncher: true, serialLaunches: 3 }), "O–R params (fill 92–97, SL 0.7, 300 s, exit on migration, no holders)");
  asrt(same(G.variantParams(V.N), { minFill: 92, maxFill: 97, minHolders: 7, tp: 1.5, sl: 0.7, holdSec: 300, exitOnMigration: true }), "N params unchanged");
  asrt(G.variantAccepts(V.R, { fill: 93, holders: 1 }) && !G.variantAccepts(V.N, { fill: 93, holders: 1 }) && G.variantAccepts(V.R, { fill: 93, holders: 0 }), "a mint with 1 holder opens R, not N");
  asrt(!G.variantAccepts(V.R, { fill: 97.1, holders: 50 }) && !G.variantAccepts(V.R, { fill: 91.9, holders: 50 }), "R keeps N's band");
  asrt(G.candidateThreshold(V) === 75, "candidate threshold unchanged (L's 75)");
  asrt(G.SHADOW_REV === 8, "SHADOW_REV 8");
}

// =============================================================================================
// 4. The real lab
// =============================================================================================
const h = new Date().getUTCHours();
const HOURS_IN = `${h}-${(h + 2) % 24}`; // contains now (and the next hour, if the run crosses it)
const HOURS_OUT = `${(h + 3) % 24}-${(h + 5) % 24}`;
const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
const [runs, lIn, lOut, lOff, migr, badHours, badSerial] = await Promise.all([
  replayAll(),
  runShadow("launcher-in", { ...SCENARIOS.launcher, SHADOW_HOURS_UTC: HOURS_IN }),
  runShadow("launcher-out", { ...SCENARIOS.launcher, SHADOW_HOURS_UTC: HOURS_OUT }),
  runShadow("launcher-feat-off", { ...SCENARIOS.launcher, SHADOW_HOURS_UTC: HOURS_IN, SHADOW_FEATURES: "0" }),
  runShadow("migrate-nr", { ...SCENARIOS.migrate, SHADOW_VARIANTS: "NR" }),
  runShadow("bad-hours", { ...SCENARIOS.single, SHADOW_HOURS_UTC: "25-3" }, { expectExit: 1 }),
  runShadow("bad-serial", { ...SCENARIOS.single, SHADOW_SERIAL_LAUNCHES: "1" }, { expectExit: 1 }),
]);
// 4a. Golden: A F J K L M N exactly as revision 7 (captured from the revision-7 shadow.mjs).
for (const n of Object.keys(SCENARIOS)) {
  const got = only(decisions(runs[n]), KEEP);
  const want = only(golden[n], KEEP);
  for (const part of ["opens", "trades", "candidates"]) {
    asrt(same(got[part], want[part]), `[${n}] ${part} of ${KEEP} are exactly revision 7's (golden ${want[part].length}, got ${got[part].length}):\n got  ${JSON.stringify(got[part]).slice(0, 600)}\n want ${JSON.stringify(want[part]).slice(0, 600)}`);
  }
  asrt(want.opens.length > 0, `[${n}] the golden run opened something`);
  const vs = new Set(runs[n].opens.map((o) => o.variant));
  asrt(![..."BCDEGHI"].some((id) => vs.has(id)), `[${n}] B C D E G H I do not trade by default (got ${[...vs].join("")})`);
  asrt(runs[n].opens.every((o) => o.shadowRev === 8) && runs[n].trades.every((t) => t.shadowRev === 8), `[${n}] shadowRev 8`);
}
asrt(/variants AFJKLMNOPQR \|/.test(runs.single.out) && /US hours \(O\/P\): 19-23 UTC/.test(runs.single.out), "startup lines: the default set and the window");
// 4b. The launcher scenario: who opens what.
const opened = (run, mint) => run.opens.filter((o) => o.mint === mint).map((o) => o.variant).sort().join("");
const has = (run, mint, ids) => [...ids].every((id) => opened(run, mint).includes(id));
const lacks = (run, mint, ids) => [...ids].every((id) => !opened(run, mint).includes(id));
const ALL = [M.SOLO_MINT, M.SERIAL2_MINT, M.MODE_MINT, M.UNSEEN_MINT, M.OLDL_MINT];
for (const [name, run] of [["in", lIn], ["feat-off", lOff]]) {
  for (const m of ALL) asrt(has(run, m, "OR"), `[launcher ${name}] O and R open ${m.slice(0, 8)} (no holder minimum; got ${opened(run, m)})`);
  for (const m of [M.SOLO_MINT, M.OLDL_MINT]) asrt(has(run, m, "PQ"), `[launcher ${name}] P and Q open a one-off launcher's mint (got ${opened(run, m)})`);
  for (const m of [M.SERIAL2_MINT, M.MODE_MINT, M.UNSEEN_MINT]) asrt(lacks(run, m, "PQ"), `[launcher ${name}] P and Q skip a serial / launcher-mode / unseen launcher (got ${opened(run, m)})`);
  asrt(lacks(run, M.SERIAL2_MINT, "N") && run.opens.find((o) => o.mint === M.SERIAL2_MINT && o.variant === "R").holders === 1, `[launcher ${name}] a 1-holder mint opens R, not N`);
  const mem = run.records.filter((x) => x.type === "gshadow_mem").at(-1);
  asrt(mem && mem.launcherUnknown === 2 && mem.launcherMode === 2 && mem.serialLauncher === 2 && mem.outsideHours === 0 && mem.launchErrors === 0 && mem.launchMints === 8, `[launcher ${name}] gate skips per (variant, mint) in gshadow_mem (got ${JSON.stringify(mem && pick(mem, ["launcherUnknown", "launcherMode", "serialLauncher", "outsideHours", "launchErrors", "launchMints"]))})`);
}
asrt(lOff.opens.every((o) => o.feat === null), "[launcher feat-off] SHADOW_FEATURES=0: feat null, the launcher gate still works (above)");
{
  for (const m of ALL) asrt(lacks(lOut, m, "OP") && has(lOut, m, "R"), `[launcher out] outside the window O and P open nothing, R does (got ${opened(lOut, m)})`);
  asrt(has(lOut, M.SOLO_MINT, "Q") && lacks(lOut, M.UNSEEN_MINT, "Q"), "[launcher out] Q has no hour rule");
  const mem = lOut.records.filter((x) => x.type === "gshadow_mem").at(-1);
  asrt(mem.outsideHours === 10 && mem.launcherUnknown === 1 && mem.launcherMode === 1 && mem.serialLauncher === 1, `[launcher out] 10 hour skips (O, P x 5 mints); Q's launcher skips once each (got ${JSON.stringify(pick(mem, ["outsideHours", "launcherUnknown", "launcherMode", "serialLauncher"]))})`);
  const sameDecisions = same(only(decisions(lIn), "AFJKLMNQR"), only(decisions(lOut), "AFJKLMNQR"));
  asrt(sameDecisions, "[launcher] the window moves O and P only");
}
// 4c. feat: deployer fields and the hour.
{
  const p = lIn.opens.find((o) => o.mint === M.SOLO_MINT && o.variant === "P");
  const f = p.feat;
  asrt(f.deployer === M.L_SOLO && f.deployerIsCreator === true && f.deployerLaunches24h === 1 && f.inUsHours === true && (f.hourUtc === h || f.hourUtc === (h + 1) % 24) && f.creator === M.L_SOLO && "priceRel" in f, `[launcher] P's feat: deployer, deployerIsCreator, deployerLaunches24h, inUsHours, hourUtc + the rev-7 fields (got ${JSON.stringify(f)})`);
  asrt(same(p.params, { minFill: 92, maxFill: 97, minHolders: 0, tp: 1.5, sl: 0.7, holdSec: 300, exitOnMigration: true, hoursUtc: G.parseHoursUtc(HOURS_IN).text, noSerialLauncher: true, serialLaunches: 3 }), `[launcher] P's params (got ${JSON.stringify(p.params)})`);
  const md = lIn.opens.find((o) => o.mint === M.MODE_MINT && o.variant === "R").feat;
  asrt(md.deployer === M.L_MODE && md.creator === M.L_MODE_CREATOR && md.deployerIsCreator === false && md.deployerLaunches24h === 1, `[launcher] launcher-mode feat: the deployer is the signer, not the creator (got ${JSON.stringify(md)})`);
  const se = lIn.opens.find((o) => o.mint === M.SERIAL2_MINT && o.variant === "R").feat;
  const un = lIn.opens.find((o) => o.mint === M.UNSEEN_MINT && o.variant === "R").feat;
  const ol = lIn.opens.find((o) => o.mint === M.OLDL_MINT && o.variant === "R").feat;
  asrt(se.deployerLaunches24h === 3 && un.deployer === null && un.deployerIsCreator === null && un.deployerLaunches24h === null && ol.deployerLaunches24h === 1, "[launcher] serial = 3, unseen = null, 25 h old launches not counted");
  const o = lOut.opens.find((x) => x.mint === M.SOLO_MINT && x.variant === "R").feat;
  asrt(o.inUsHours === false && Number.isInteger(o.hourUtc), "[launcher out] inUsHours false outside the window");
  // Every variant opened on one event journals the same feat.
  const groups = new Map();
  for (const x of lIn.opens) groups.set(`${x.mint}@${x.fill}`, [...(groups.get(`${x.mint}@${x.fill}`) || []), x.feat]);
  for (const [k, list] of groups) asrt(list.every((x) => same(x, list[0])), `[launcher] one feat per event (${k})`);
}
// 4d. R leaves a migrated position like N (exit on migration).
{
  const n = migr.trades.find((t) => t.variant === "N");
  const r = migr.trades.find((t) => t.variant === "R");
  asrt(n && r && r.reason === "migration-exit" && r.reason === n.reason && r.exitVenue === "amm" && r.ammSolOut === n.ammSolOut && r.ratio === n.ratio, `[migrate] R exits on migration exactly like N (got N ${n && n.reason} / R ${r && r.reason})`);
}
// 4e. A bad window or threshold stops the lab at the start, loudly.
asrt(/SHADOW_HOURS_UTC="25-3"/.test(badHours.err) && badHours.opens.length === 0, `invalid SHADOW_HOURS_UTC: exit 1 with the variable named (stderr: ${badHours.err.trim().slice(0, 200)})`);
asrt(/SHADOW_SERIAL_LAUNCHES="1"/.test(badSerial.err), "invalid SHADOW_SERIAL_LAUNCHES: exit 1 with the variable named");

const ex = lIn.opens.find((o) => o.mint === M.SOLO_MINT && o.variant === "P");
console.log(JSON.stringify({ exampleOpenP: ex }));
console.log("PASS: shadow rev 8 — O/P/Q/R (no holders, US hours, launcher filter from the stream), default set A F J K L M N O P Q R; A F J K L M N decisions identical to revision 7");
