import { cleanEnv, makeTempKeys } from "./lib/test-env.mjs";
// Stall guard of the trading bots (KODING №10, C).
//
// A paused Windows console blocks console.log and with it the whole event loop (KODING №9: the
// shadow lab stood still for 22–39 minutes, three times). A live bot in that state watches nothing;
// when it comes back it used to (a) carry on as if no time had passed and (b) act on the socket's
// backlog — events that are minutes old — as if they were the present, including BUYING on them.
//
//   1. lib/stall-guard.mjs: the detector, the stale-event rule, journal before console, off at 0.
//   2. graduation-sniper end to end (dry run, fixture RPC + a fixture stream that really blocks the
//      bot's event loop with Atomics.wait): `stall` row, immediate on-chain re-check of the open
//      position, no buy on the old event, a fresh event is still bought; STALL_GUARD_SEC=0 = the
//      behaviour before this task.
//   3. sniper / copy-trader wiring (their handlers cannot be run without a live socket here).
// No network, nothing is sent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const SG = await import("../lib/stall-guard.mjs");
const G = await import("../lib/gshadow.mjs");
const { parseLogEvents } = await import("../lib/events.mjs");
const { readJournal } = await import("../lib/journal.mjs");

// =============================================================================================
// 1. lib/stall-guard.mjs
// =============================================================================================
asrt(SG.STALL_GUARD_SEC === 30, `STALL_GUARD_SEC defaults to 30, got ${SG.STALL_GUARD_SEC}`);
asrt(G.stallGapMs === SG.stallGapMs && G.eventLagMs === SG.eventLagMs, "the shadow lab uses the same two rules (re-exported from lib/gshadow.mjs)");
asrt(SG.stallGapMs(40_001, 10_000, 30_000) === 30_001 && SG.stallGapMs(40_000, 10_000, 30_000) === 0 && SG.stallGapMs(99_000, 10_000, 0) === 0 && SG.stallGapMs(99_000, 0, 30_000) === 0, "stallGapMs: a gap above the threshold; exactly the threshold / off / no previous tick -> 0");
asrt(SG.eventTimestampSec({ timestampMs: 1_794_517_995 }) === 1_794_517_995, "a trade's `timestampMs` field carries SECONDS and is read as such");
asrt(SG.eventTimestampSec({ timestampSec: 1_794_517_995 }) === 1_794_517_995 && SG.eventTimestampSec({ timestampMs: 1_794_517_995_000 }) === 1_794_517_995, "timestampSec wins; a real millisecond value is converted");
asrt(SG.eventTimestampSec({}) === null && SG.eventTimestampSec({ timestampMs: null }) === null && SG.eventTimestampSec({ timestampMs: 0 }) === null && SG.eventTimestampSec(null) === null, "no timestamp -> null (unknown)");
asrt(/do not select text in this window/.test(SG.CONSOLE_HINT) && /Windows Terminal/.test(SG.CONSOLE_HINT) && /VS Code terminal/.test(SG.CONSOLE_HINT), "the console hint names the cause and the two safe terminals");

function mkGuard({ thresholdMs = 30_000, positions = new Map() } = {}) {
  const w = { calls: [], rows: [], logs: [], stalls: [], t: 1_800_000_000_000, positions };
  w.guard = SG.createStallGuard({
    thresholdMs,
    journal: { write: (r) => (w.calls.push("journal:" + r.type), w.rows.push(r)) },
    log: (m) => (w.calls.push("log"), w.logs.push(m)),
    positions,
    fields: () => ({ sessionId: "S1" }),
    onStall: (info) => (w.calls.push("onStall"), w.stalls.push(info)),
    now: () => w.t,
  });
  return w;
}
const tsSec = (ms) => Math.floor(ms / 1000);

// --- the detector: journal first, the hook second, the console last ---
{
  const posA = { tokens: 1n };
  const posB = { tokens: 2n, stallMs: 5000 };
  const w = mkGuard({ positions: new Map([["MintA", posA], ["MintB", posB]]) });
  asrt(w.guard.enabled === true && w.guard.tick() === 0, "the first tick has nothing to compare with");
  w.t += 1000;
  asrt(w.guard.tick() === 0 && w.rows.length === 0 && w.logs.length === 0, "an ordinary 1 s tick is silent");
  w.t += 30_000;
  asrt(w.guard.tick() === 0, "a gap of exactly the threshold is not a stall");
  w.t += 1_350_000; // the third freeze of KODING №9: 22.5 min
  const gap = w.guard.tick();
  asrt(gap === 1_350_000, `the tick after the pause reports the gap, got ${gap}`);
  asrt(JSON.stringify(w.calls) === '["journal:stall","onStall","log"]', `journal BEFORE the hook BEFORE the console, got ${JSON.stringify(w.calls)}`);
  const row = w.rows[0];
  asrt(row.type === "stall" && row.stallSec === 1350 && row.open === 2 && JSON.stringify(row.mints) === '["MintA","MintB"]' && row.at === new Date(w.t).toISOString() && row.sessionId === "S1" && row.thresholdSec === 30, `stall row { stallSec, open, at, … }: ${JSON.stringify(row)}`);
  asrt(w.stalls.length === 1 && w.stalls[0].gapMs === 1_350_000 && w.stalls[0].now === w.t, "the bot's hook gets the gap (it re-checks the positions against the chain)");
  asrt(posA.stallMs === 1_350_000 && posB.stallMs === 1_355_000, "every open position is marked with the time it was not watched");
  asrt(/^ALERT: the process stood still for 1350s/.test(w.logs[0]) && /2 open position\(s\) were not watched/.test(w.logs[0]) && /do not select text in this window/.test(w.logs[0]), `ALERT line: ${w.logs[0]}`);
  w.t += 1000;
  asrt(w.guard.tick() === 0 && w.rows.length === 1, "one stall = one row");
  // A hook that throws must not hide the stall or stop the guard.
  const bad = SG.createStallGuard({ thresholdMs: 1000, journal: { write: () => {} }, onStall: () => { throw new Error("boom"); }, now: () => w.t });
  bad.tick(1000);
  asrt(bad.tick(5000) === 4000, "a failing hook does not break the tick");
}

// --- stale stream notifications ---
{
  const w = mkGuard();
  w.guard.tick();
  const fresh = [{ type: "trade", timestampMs: tsSec(w.t) - 2 }];
  const old = [{ type: "trade", timestampMs: tsSec(w.t) - 31 }, { type: "trade", timestampMs: tsSec(w.t) - 1 }];
  asrt(w.guard.isStale(fresh) === false, "a 2 s old event is the present");
  asrt(w.guard.isStale([{ type: "trade", timestampMs: tsSec(w.t) - 30 }]) === false, "exactly the threshold is not stale");
  asrt(w.guard.isStale(old) === true, "a notification with a 31 s old event is backlog (the oldest event decides)");
  asrt(w.guard.isStale([{ type: "create", timestampSec: tsSec(w.t) - 600 }]) === true, "a create event is judged by its own timestampSec");
  asrt(w.guard.isStale([{ type: "trade" }]) === false && w.guard.isStale([]) === false, "an unknown timestamp is not stale (the guard never blinds the bot)…");
  asrt(w.guard.isStale([{ type: "trade", timestampMs: tsSec(w.t) + 5 }]) === false, "a clock that runs behind (negative lag) is not stale");
  asrt(w.rows.length === 0, "no row while the backlog is still arriving");
  w.t += 1000;
  w.guard.tick();
  const row = w.rows[0];
  asrt(w.rows.length === 1 && row.type === "stale_events" && row.events === 2 && row.maxLagSec === 600 && row.sessionId === "S1" && row.thresholdSec === 30, `one summary row: ${JSON.stringify(row)}`);
  asrt(/^STALE EVENTS: 2 stream notification\(s\) up to 600s old/.test(w.logs[0]), `summary log line: ${w.logs[0]}`);
  w.t += 1000;
  w.guard.tick();
  asrt(w.rows.length === 1, "the counter is reset after the row");

  // …except right after a detected stall: an event that cannot be dated is not acted on for 5 s.
  w.t += 60_000;
  asrt(w.guard.isStale([{ type: "trade" }]) === true, "the handler itself notices the stall (before the 1 s timer) and treats an undatable event as backlog");
  asrt(w.rows.some((r) => r.type === "stall" && r.stallSec === 60), "…and the stall is journaled from the handler");
  asrt(w.guard.isStale(fresh.map((e) => ({ ...e, timestampMs: tsSec(w.t) }))) === false, "a datable fresh event is still acted on right after the stall");
  w.t += SG.STALL_DRAIN_MS;
  asrt(w.guard.isStale([{ type: "trade" }]) === false, "after the drain window an undatable event is acted on again");
  w.guard.stop();
  asrt(w.rows.filter((r) => r.type === "stale_events").length === 2, "stop() flushes what is still counted");
}

// --- STALL_GUARD_SEC=0: everything is off ---
{
  const w = mkGuard({ thresholdMs: 0, positions: new Map([["M", {}]]) });
  w.guard.start();
  w.guard.tick();
  w.t += 3_600_000;
  asrt(w.guard.enabled === false && w.guard.tick() === 0 && w.guard.isStale([{ timestampMs: 1 }]) === false, "threshold 0: no stall, nothing is stale");
  w.guard.stop();
  asrt(w.rows.length === 0 && w.logs.length === 0 && w.stalls.length === 0 && w.positions.get("M").stallMs === undefined, "threshold 0: no rows, no log, no hook, positions untouched");
  asrt(/stall guard OFF \(STALL_GUARD_SEC=0\)/.test(w.guard.banner()) && /do not select text in this window/.test(w.guard.banner()), "the banner says it is off and still carries the console hint");
  asrt(/stall guard 30s/.test(mkGuard().guard.banner()) && /Windows Terminal or the VS Code terminal/.test(mkGuard().guard.banner()), "the banner of an active guard");
}

// --- a create event carries its on-chain time (lib/events.mjs) ---
{
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  };
  const payload = Buffer.concat([
    Buffer.from("1b72a94ddeeb6376", "hex"), str("Name"), str("SYM"), str("https://x"),
    Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4),
    u64(1_794_517_995), u64(1_073_000_000_000_000n), u64(30_000_000_000n), u64(793_100_000_000_000n), u64(1_000_000_000_000_000n), Buffer.alloc(8),
  ]);
  const ev = parseLogEvents([`Program data: ${payload.toString("base64")}`]).find((e) => e.type === "create");
  asrt(ev && ev.timestampSec === 1_794_517_995 && SG.eventTimestampSec(ev) === 1_794_517_995, `the create event exposes timestampSec, got ${ev?.timestampSec}`);
}

// =============================================================================================
// 2. graduation-sniper, end to end: the bot's event loop is really blocked
// =============================================================================================
const mock = await import("./mocks/stall-ws-mock.mjs");
async function runGrad(name, extra) {
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), `stall-${name}-`));
  const env = cleanEnv({
    RPC_URL: "http://127.0.0.1:1",
    RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
    WS_MOCK: path.join(here, "mocks", "stall-ws-mock.mjs"),
    WS_STALL_BLOCK_MS: "3500",
    KEYS_DIR: makeTempKeys(),
    JOURNAL_DIR: jdir,
    GRAD_BUY_SOL: "0.02",
    GRAD_MIN_FILL_PCT: "92",
    GRAD_MAX_FILL_PCT: "97",
    GRAD_COOLDOWN_SEC: "0",
    MIN_HOLDERS: "0",
    GRAD_MAX_POSITIONS: "5",
    GRAD_MAX_SEC: "9",
    ...extra,
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "--dry-run"], { cwd: root, env });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (out += String(b)));
  await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 45_000);
    child.on("exit", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  const records = readJournal(jdir);
  fs.rmSync(jdir, { recursive: true, force: true });
  asrt(!/TypeError|ReferenceError/.test(out), `[${name}] no exception: ${(out.match(/(TypeError|ReferenceError).*/) || [""])[0]}`);
  const watch = (mint) => out.includes(`WATCHLIST: ${mint.slice(0, 12)}`);
  return { out, records, watch, tracked: (out.match(/\[DRY RUN\] position tracked/g) || []).length };
}
const [on, off] = await Promise.all([runGrad("on", { STALL_GUARD_SEC: "2" }), runGrad("off", { STALL_GUARD_SEC: "0" })]);

// --- guard ON (threshold 2 s, the process stands still for 3.5 s) ---
{
  const { out, records, watch, tracked } = on;
  asrt(/Console: stall guard 2s \(stall \/ stale stream events\) — do not select text in this window \(a paused console freezes the bot\); run it in Windows Terminal or the VS Code terminal/.test(out), "[on] the start banner carries the guard and the console hint");
  asrt(watch(mock.MINT_A), "[on] the fresh event A is acted on before the stall");
  const stall = records.filter((r) => r.type === "stall");
  asrt(stall.length === 1, `[on] exactly one stall row, got ${stall.length}`);
  asrt(stall[0].stallSec >= 3 && stall[0].stallSec <= 8 && stall[0].open === 1 && JSON.stringify(stall[0].mints) === JSON.stringify([mock.MINT_A]) && typeof stall[0].at === "string" && stall[0].thresholdSec === 2 && typeof stall[0].sessionId === "string", `[on] stall row { stallSec, open, at }: ${JSON.stringify(stall[0])}`);
  const alertAt = out.indexOf("ALERT: the process stood still for");
  asrt(alertAt > 0 && /1 open position\(s\) were not watched; re-checking them against the chain now/.test(out), "[on] ALERT in the log");
  // The open position is re-checked right away, from the curve account, and leaves by the usual
  // rules (the fixture curve is far above TP by then) — a real dry exit, after the ALERT.
  const soldAt = out.indexOf("[DRY RUN] sold on curve", alertAt);
  asrt(soldAt > alertAt, "[on] the open position is re-priced from the chain and sold by the usual rules after the stall");
  // The old event C (600 s old, in band) is the backlog: no watchlist line, no candidate, no buy.
  asrt(!watch(mock.MINT_C) && !records.some((r) => r.mint === mock.MINT_C), `[on] the 600 s old event did not reach the entry logic (${records.filter((r) => r.mint === mock.MINT_C).map((r) => r.type)})`);
  const stale = records.filter((r) => r.type === "stale_events");
  asrt(stale.length === 1 && stale[0].events === 1 && stale[0].maxLagSec >= mock.OLD_EVENT_LAG_SEC && stale[0].maxLagSec <= mock.OLD_EVENT_LAG_SEC + 10, `[on] one stale_events row for it: ${JSON.stringify(stale)}`);
  asrt(/STALE EVENTS: 1 stream notification\(s\)/.test(out), "[on] the summary line is logged");
  // The guard does not blind the bot: the fresh event D after the stall is bought.
  asrt(watch(mock.MINT_D) && tracked === 2, `[on] exactly two dry buys: A before the stall and the fresh D after it (got ${tracked})`);
}

// --- guard OFF (STALL_GUARD_SEC=0): the behaviour before this task ---
{
  const { out, records, watch, tracked } = off;
  asrt(/Console: stall guard OFF \(STALL_GUARD_SEC=0\) — do not select text in this window/.test(out), "[off] the banner says the guard is off (the hint stays)");
  asrt(records.filter((r) => r.type === "stall" || r.type === "stale_events").length === 0 && !/ALERT: the process stood still/.test(out), "[off] no stall row, no stale_events row, no ALERT");
  asrt(watch(mock.MINT_C) && tracked === 3, `[off] the 600 s old event IS bought, as before (dry buys: ${tracked})`);
}

// =============================================================================================
// 3. wiring of the three bots
// =============================================================================================
{
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const count = (s, re) => (s.match(re) || []).length;
  const grad = read("bots/graduation-sniper/graduation.mjs");
  const sniper = read("bots/sniper/sniper.mjs");
  const copy = read("bots/copy-trader/watcher.mjs");
  for (const [name, src] of [["graduation", grad], ["sniper", sniper], ["copy-trader", copy]]) {
    asrt(/import \{ createStallGuard \} from "\.\.\/\.\.\/lib\/stall-guard\.mjs";/.test(src), `${name}: imports the guard`);
    asrt(count(src, /const stallGuard = createStallGuard\(\{/g) === 1 && count(src, /stallGuard\.start\(\);/g) === 1 && count(src, /stallGuard\.stop\(\);/g) === 1, `${name}: one guard, started once, stopped in finish()`);
    asrt(/log\(`Console: \$\{stallGuard\.banner\(\)\}`\);/.test(src), `${name}: the start banner prints the console hint`);
    const ctor = src.slice(src.indexOf("const stallGuard = createStallGuard({"), src.indexOf("});", src.indexOf("const stallGuard = createStallGuard({")));
    asrt(/journal,/.test(ctor) && /positions,/.test(ctor) && /onStall:/.test(ctor), `${name}: the guard journals, marks the bot's positions and has a re-check hook`);
    asrt(count(src, /stallGuard\.isStale\(/g) === 1, `${name}: the stream handler asks the guard once`);
  }
  // graduation: backlog never reaches the entry code; the hook re-checks on-chain (checkExit reads the account).
  asrt(/if \(stallGuard\.isStale\(events\)\) return;\n  for \(const ev of events\) \{/.test(grad) && /onStall: \(\) => \{\n    void monitorPositions\(\);/.test(grad), "graduation: stale notification -> return before the loop; stall -> monitorPositions()");
  asrt(/const state = await getBondingCurveState\(mintPk, 0\);/.test(grad.slice(grad.indexOf("async function checkExit("))), "graduation: checkExit prices from the curve account (no cache)");
  // sniper: the stream prices are dropped (they are as old as the pause) before the re-check, and the
  // backlog is dropped before it can update a stream price or reach a create.
  asrt(/onStall: \(\) => \{\n    curveStream\.clear\(\);\n    accountPriceCache\.clear\(\);\n    void checkPositions\(\);/.test(sniper), "sniper: stall -> stream and account price caches cleared, positions re-checked");
  const handler = sniper.slice(sniper.indexOf("ws.subscribeLogs(PUMP_PROGRAM.toBase58()"));
  const gate = handler.indexOf("if (stallGuard.isStale(events, now)) return;");
  asrt(gate > 0 && gate < handler.indexOf("curveStream.set(") && gate < handler.indexOf("for (const create of creates)") && gate < handler.indexOf("mintStats.set("), "sniper: the stale gate sits before the stream price, the counters and the create handling");
  asrt(/async function confirmExitPrice\(mint\)/.test(sniper) && /await confirmExitPrice\(mint\)/.test(sniper), "sniper: exits still go through the on-chain confirmation");
  // copy-trader: an old target BUY is not copied; a target SELL still goes to copySell (which reads the chain).
  asrt(/const backlog = stallGuard\.isStale\(events\);/.test(copy) && /if \(ev\.isBuy\) \{\n        if \(backlog\) continue;[^\n]*\n        await copyBuy\(ev\.mint, target\);\n      \} else \{\n        await copySell\(ev\.mint, target\);/.test(copy), "copy-trader: backlog skips copyBuy only");
  asrt(/onStall: \(\) => \{\n    void checkExits\(\);/.test(copy), "copy-trader: stall -> the exit timer runs at once");
}

console.log(JSON.stringify({ stallSec: on.records.find((r) => r.type === "stall").stallSec, buysOn: on.tracked, buysOff: off.tracked }));
console.log("PASS: stall guard — stall journaled before the console, positions re-checked on-chain at once, no buy on stale stream events, fresh events still bought, STALL_GUARD_SEC=0 = old behaviour");
