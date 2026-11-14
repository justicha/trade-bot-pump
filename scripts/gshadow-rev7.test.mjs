import "./lib/test-env.mjs";
// Graduation shadow lab, revision 7 (KODING #16): pre-entry "who is behind the token" features.
// No network: fixture socket + fixture RPC.
//
//   1. lib/gshadow-features.mjs: every `feat` field on hand-built event sequences.
//   2. lib/events.mjs: the create event (name / symbol / creator / time) and the creator field of
//      the trade event (pump.fun IDL TradeEvent, bytes 177..209).
//   3. Decisions unchanged: four scenarios replayed through the REAL bots/graduation-sniper/
//      shadow.mjs give exactly the opens / closes / netPct of revision 6. The expected values in
//      tests/fixtures/gshadow-rev6-golden.json were captured from the revision-6 shadow.mjs (commit
//      c2f57e4) with `node scripts/gshadow-rev7.test.mjs --capture`, before revision 7 was written.
//   4. Every gshadow_open carries `feat` and shadowRev 7; migrated trade rows carry
//      curveCompleteSec / migNoticedLagSec.
//   5. Memory: a mint idle for 31 min without a position is evicted, one with a position is kept;
//      the creator / name maps are trimmed by age.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const GOLDEN = path.join(root, "tests", "fixtures", "gshadow-rev6-golden.json");
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
  // A–N, the 93% entry and a later 96% price; everything closes at the stop.
  single: { RPC_MOCK: RPC_CURVE, WS_MOCK_SCENARIO: "single", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5" },
  // Creates, a creator, a wash wallet, a whale, a trade-only creator (revision 7's scenario; the
  // revision-6 lab ignores the creates and the trade tail, so it trades it like any other).
  features: { RPC_MOCK: RPC_CURVE, WS_MOCK_SCENARIO: "features", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "6" },
  // Per-variant bands and a two-event transaction, with the live band 75–90.
  "live-band": { RPC_MOCK: RPC_CURVE, ...LIVE_BAND, WS_MOCK_SCENARIO: "live-band", SHADOW_SL: "0", SHADOW_HOLD_SEC: "3600", SHADOW_MAX_SEC: "5" },
  // J and N on a mint that migrates to a pool: N leaves at the first quote, J times out at it.
  migrate: { RPC_MOCK: RPC_AMM, RPC_AMM_MINTS: M.FIRST_MINT, RPC_AMM_POOL: "1", SHADOW_VARIANTS: "JN", WS_MOCK_SCENARIO: "migrate", SHADOW_SL: "0", SHADOW_HOLD_SEC: "4", GRAD_TIMEOUT_SEC: "4", SHADOW_AMM_POLL_MS: "500", SHADOW_MAX_SEC: "10" },
};

async function runShadow(name, overrides) {
  const dir = tmp(`gshadow7-${name}-journal-`);
  const env = cleanEnv({
    ROOT: tmp(`gshadow7-${name}-root-`), // a fresh ROOT: the developer's .env must not leak in
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
  const records = readJournal(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const fatal = /TypeError|ReferenceError|RangeError|Cannot access .* before initialization|UnhandledPromiseRejection/;
  asrt(code === 0, `[${name}] the shadow lab exited 0 (got ${code}); stderr: ${err.split(/\r?\n/)[0] || ""}`);
  asrt(!fatal.test(err + out), `[${name}] no exception in the run: ${(err.match(fatal) || [""])[0]} ${err.split(/\r?\n/)[0] || ""}`);
  const of = (type) => records.filter((x) => x.type === type);
  return { out, records, opens: of("gshadow_open"), trades: of("gshadow_trade"), candidates: of("gshadow_candidate") };
}

// The decision-bearing part of a run: what was opened, at what, and how it closed. Timing fields
// (ts, holdSec, lagSec, delayMs, ammQuoteAgeMs) and revision-7 additions are left out on purpose.
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

async function replayAll() {
  const names = Object.keys(SCENARIOS);
  const runs = await Promise.all(names.map((n) => runShadow(n, SCENARIOS[n])));
  return Object.fromEntries(names.map((n, i) => [n, runs[i]]));
}

if (process.argv.includes("--capture")) {
  const runs = await replayAll();
  const golden = Object.fromEntries(Object.entries(runs).map(([n, r]) => [n, decisions(r)]));
  fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1) + "\n");
  console.log(`captured ${GOLDEN}: ${Object.entries(golden).map(([n, g]) => `${n} ${g.opens.length}/${g.trades.length}`).join(", ")}`);
  process.exit(0);
}

const F = await import("../lib/gshadow-features.mjs");
const E = await import("../lib/events.mjs");

// =============================================================================================
// 1. lib/gshadow-features.mjs
// =============================================================================================
const T0 = 1_794_000_000;
// A point of the standard curve (30 SOL x 1.073e15 raw tokens) at real SOL `rSol` (lamports);
// `mult` scales the price (fewer virtual tokens).
const STD = (rSol, mult = 1) => {
  const vSol = 30e9 + rSol;
  return { virtualSolReserves: BigInt(vSol), virtualTokenReserves: BigInt(Math.round((30e9 * 1.073e15) / vSol / mult)), realSolReserves: BigInt(rSol) };
};
const trade = (st, mint, sec, user, isBuy, sol, fill = 50, creatorOf = null) =>
  F.noteTrade(st, { mint, user, isBuy, solLamports: BigInt(Math.round(sol * 1e9)), timestampSec: sec }, { nowMs: sec * 1000, fill, creatorOf });
{
  const st = F.createFeatureStore();
  F.noteCreate(st, { mint: "MINT_E", creator: "CRE", name: "E", symbol: "E", timestampSec: T0 - 90_000 }, 0); // 25 h ago: outside 24 h
  F.noteCreate(st, { mint: "MINT_D", creator: "CRE", name: "D", symbol: "D", timestampSec: T0 - 3600 }, 0); // a serial launch 1 h ago
  F.noteCreate(st, { mint: "MINT_C", creator: "X", name: "Other", symbol: "sai", timestampSec: T0 - 2000 }, 0); // same symbol, 38 min before now: outside 30 min
  F.noteCreate(st, { mint: "MINT_A", creator: "CRE", name: "Solana AI", symbol: "SAI", timestampSec: T0 }, 0);
  F.noteCreate(st, { mint: "MINT_A", creator: "CRE", name: "Solana AI", symbol: "SAI", timestampSec: T0 }, 0); // re-delivered: counted once
  F.noteCreate(st, { mint: "MINT_B", creator: "X", name: "solana-ai!", symbol: "ZZZ", timestampSec: T0 + 240 }, 0); // copycat 4 min later
  // MINT_A: the creator buys 1.5 SOL, one wallet makes 73 of 100 trades (0.1 SOL, buy/sell), the
  // creator sells 0.5, 25 wallets buy 0.2 each in the last minute.
  trade(st, "MINT_A", T0 + 10, "CRE", true, 1.5, 3);
  for (let i = 0; i < 73; i++) trade(st, "MINT_A", T0 + 100 + i, "WASH", i % 2 === 0, 0.1);
  trade(st, "MINT_A", T0 + 250, "CRE", false, 0.5);
  for (let i = 0; i < 25; i++) trade(st, "MINT_A", T0 + 260 + i, `W${i}`, true, 0.2, 80);
  const f = F.buildFeatures(st, "MINT_A", { nowSec: T0 + 300, curve: STD(9e9), watchSec: 3600.4 });
  const want = {
    ageSec: 300,
    creator: "CRE",
    creatorSource: "create",
    creatorBuySol: 1.5,
    creatorSellSol: 0.5,
    creatorTrades: 2,
    creatorLaunches24h: 2, // MINT_A + MINT_D (MINT_E is 25 h old)
    name: "Solana AI",
    symbol: "SAI",
    sameNameRecent: 1, // MINT_B ("solana-ai!" = "Solana AI"); MINT_C's symbol is outside the 30 min
    trades: 100,
    uniqueTraders: 27,
    topWalletTradeShare: 0.73,
    topWalletVolShare: 0.51, // 7.3 of 14.3 SOL
    top5NetSol: 1.8, // creator +1.0, four of the 0.2 buyers (WASH nets +0.1)
    top5NetShare: 0.2, // 1.8 of 9 SOL real reserves
    buySol60: 5,
    sellSol60: 0.5,
    buys60: 25,
    sells60: 1,
    maxSell60Sol: 0.5,
    priceRel: 1,
    firstSeenFill: 0, // its create was seen: the whole life
    watchSec: 3600,
  };
  asrt(same(f, want), `features of a hand-built sequence:\n got  ${JSON.stringify(f)}\n want ${JSON.stringify(want)}`);
  asrt(F.priceRel(STD(78e9)) === 1 && F.priceRel(STD(78e9, 7)) === 7, `priceRel: 1 on the standard curve, 7 at a 7x price (got ${F.priceRel(STD(78e9))} / ${F.priceRel(STD(78e9, 7))})`);
  asrt(F.priceRel({ virtualSolReserves: 0n, virtualTokenReserves: 1n, realSolReserves: 0n }) === null, "priceRel of an unpriced curve is null");
  // A 3 SOL whale sell inside the window is the largest sell.
  trade(st, "MINT_A", T0 + 299, "WHALE", false, 3);
  const g = F.buildFeatures(st, "MINT_A", { nowSec: T0 + 300, curve: STD(6e9) });
  asrt(g.maxSell60Sol === 3 && g.sells60 === 2 && g.sellSol60 === 3.5 && g.trades === 101 && g.watchSec === null, `a whale sell in the last 60 s (got ${JSON.stringify(pick(g, ["maxSell60Sol", "sells60", "sellSol60", "trades"]))})`);
  // 30 min later the copycat has left the name window; the creator's launch count has not.
  const later = F.buildFeatures(st, "MINT_A", { nowSec: T0 + 240 + 1800, curve: STD(6e9) });
  asrt(later.sameNameRecent === 0 && later.creatorLaunches24h === 2 && later.buys60 === 0 && later.sells60 === 0 && later.maxSell60Sol === 0, "windows follow the event time (name 30 min, flow 60 s)");
  asrt(F.normalizeName("SOLANA  ai!") === "solanaai" && F.normalizeName("🚀🚀") === "" && F.normalizeName(null) === "", "name normalization: case, spaces and punctuation; emoji-only = not indexed");
}
{
  // No create seen: the trade event's creator is the fallback; everything about the launch is null.
  const st = F.createFeatureStore();
  trade(st, "MINT_N", T0, "U1", true, 0.4, 41.234, () => "TCRE");
  trade(st, "MINT_N", T0 + 1, "U2", true, 0.1, 42, () => "IGNORED"); // the first creator stays
  const f = F.buildFeatures(st, "MINT_N", { nowSec: T0 + 1, curve: STD(30e9) });
  asrt(f.creator === "TCRE" && f.creatorSource === "trade" && f.creatorBuySol === 0 && f.creatorSellSol === 0 && f.creatorTrades === 0 && f.creatorLaunches24h === 1, `trade-creator fallback (got ${JSON.stringify(f)})`);
  asrt(f.ageSec === null && f.name === null && f.symbol === null && f.sameNameRecent === null && f.firstSeenFill === 41.23, "no create seen -> ageSec / name / sameNameRecent null; firstSeenFill = the fill at first sight");
  // No creator at all: null, never 0.
  const st2 = F.createFeatureStore();
  trade(st2, "MINT_Z", T0, "U1", true, 0.4, 50, () => null);
  const z = F.buildFeatures(st2, "MINT_Z", { nowSec: T0, curve: null });
  for (const k of ["creator", "creatorSource", "creatorBuySol", "creatorSellSol", "creatorTrades", "creatorLaunches24h", "ageSec", "sameNameRecent", "priceRel", "top5NetShare"]) {
    asrt(z[k] === null, `unknown ${k} is null, never 0 (got ${z[k]})`);
  }
  asrt(z.trades === 1 && z.topWalletTradeShare === 1 && z.top5NetSol === 0.4, "the known totals are numbers");
  asrt(F.buildFeatures(st2, "NEVER_SEEN", { nowSec: T0 }) === null, "a mint never seen has no features");
}

// =============================================================================================
// 5. Memory: eviction and index trimming (pure)
// =============================================================================================
{
  const st = F.createFeatureStore();
  const MIN = 60_000;
  F.noteCreate(st, { mint: "IDLE", creator: "C1", name: "Idle", symbol: "I", timestampSec: T0 }, 0);
  trade(st, "IDLE", T0, "U", true, 1);
  st.mints.get("IDLE").lastEventAt = 0;
  trade(st, "LIVE", T0, "U", true, 1);
  st.mints.get("LIVE").lastEventAt = 0;
  trade(st, "EDGE", T0, "U", true, 1);
  st.mints.get("EDGE").lastEventAt = 1 * MIN; // exactly 30 min idle at 31 min: kept (strictly more is idle)
  const n = F.evictIdle(st, 31 * MIN, new Set(["LIVE"]));
  asrt(n === 1 && !st.mints.has("IDLE") && st.mints.has("LIVE") && st.mints.has("EDGE"), `idle 31 min, no position -> dropped; with an open position -> kept (dropped ${n}, left ${[...st.mints.keys()]})`);
  asrt(F.storeStats(st).mints === 2 && F.storeStats(st).wallets === 2, "storeStats counts what is left");
  // Indexes: the 24 h / 30 min windows, by on-chain time.
  F.noteCreate(st, { mint: "NEW", creator: "C1", name: "Idle", symbol: "N", timestampSec: T0 + 3600 }, 0);
  F.trimIndexes(st, T0 + 1800 + 1);
  asrt(st.names.get("idle").length === 1 && st.names.get("idle")[0].mint === "NEW" && !st.symbols.has("i") && st.creators.get("C1").length === 2, "after 30 min a name entry is trimmed, the creator's is not");
  F.trimIndexes(st, T0 + 3600 + 24 * 3600);
  asrt(!st.creators.has("C1") && st.names.size === 0 && st.symbols.size === 0, "after 24 h the creator entry goes too, empty keys are deleted");
  // The lab wires it: once a minute, with the mints of the open positions kept.
  const sh = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "shadow.mjs"), "utf8");
  asrt(/evictIdle\(feats, now, new Set\(\[\.\.\.open\.values\(\)\]\.map\(\(p\) => p\.mint\)\)\)/.test(sh) && /trimIndexes\(feats,/.test(sh), "shadow.mjs evicts with the open positions' mints kept, and trims the indexes");
}

// =============================================================================================
// 2. lib/events.mjs: create decode, trade creator
// =============================================================================================
{
  const cp = M.createPayload({ mint: M.FEAT_MINT, creator: M.CREATOR, name: "Соль AI 🚀", symbol: "SAI", ts: T0 });
  const c = E.parseCreate(cp);
  asrt(c && c.mint === M.FEAT_MINT && c.creator === M.CREATOR && c.name === "Соль AI 🚀" && c.symbol === "SAI" && c.timestampSec === T0 && c.launchParamsOk === true, `create decode incl. a UTF-8 name / symbol / creator / time (got ${JSON.stringify(c && pick(c, ["mint", "creator", "name", "symbol", "timestampSec", "launchParamsOk"]))})`);
  const tp = M.tradePayload({ mint: M.FEAT_MINT, user: M.WASH, realSol: 1e9, creator: M.CREATOR });
  asrt(E.tradeCreator(tp) === M.CREATOR, "the trade event's creator (bytes 177..209) is decoded");
  asrt(E.tradeCreator(M.tradePayload({ mint: M.FEAT_MINT, user: M.WASH, realSol: 1e9 })) === null, "an all-zero creator field is no creator");
  const bad = Buffer.from(tp);
  bad.writeBigUInt64LE(123_456n, 209);
  asrt(E.tradeCreator(bad) === null, "an implausible creator_fee_basis_points (another layout) -> null");
  asrt(E.tradeCreator(tp.subarray(0, 224)) === null && E.tradeCreator(cp) === null && E.tradeCreator(null) === null, "short payload / a create / nothing -> null");
  const t = E.parseTrade(tp);
  asrt(t.mint === M.FEAT_MINT && t.user === M.WASH && t.solAmount === 0.02, "the rest of the trade decode is untouched");
}

// =============================================================================================
// 3 + 4. The real lab: decisions unchanged, every open carries feat
// =============================================================================================
const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
const [runs, featOff] = await Promise.all([replayAll(), runShadow("features-off", { ...SCENARIOS.features, SHADOW_FEATURES: "0" })]);
for (const n of Object.keys(SCENARIOS)) {
  const got = decisions(runs[n]);
  for (const part of ["opens", "trades", "candidates"]) {
    asrt(same(got[part], golden[n][part]), `[${n}] ${part} are exactly revision 6's (golden ${golden[n][part].length}, got ${got[part].length}):\n got  ${JSON.stringify(got[part]).slice(0, 600)}\n want ${JSON.stringify(golden[n][part]).slice(0, 600)}`);
  }
  asrt(golden[n].opens.length > 0, `[${n}] the golden run opened something`);
  const r = runs[n];
  asrt(r.opens.every((o) => o.shadowRev === 7) && r.trades.every((t) => t.shadowRev === 7), `[${n}] rows carry shadowRev 7`);
  asrt(r.opens.every((o) => o.feat && typeof o.feat === "object" && "creator" in o.feat && "priceRel" in o.feat), `[${n}] every gshadow_open carries feat`);
  // One moment (mint + fill of the event) -> one feat object for every variant that opened on it.
  const groups = new Map();
  for (const o of r.opens) {
    const k = `${o.mint}@${o.fill}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o.feat);
  }
  for (const [k, list] of groups) asrt(list.every((x) => same(x, list[0])), `[${n}] all variants opened at ${k} journal the same feat`);
  const mem = r.records.filter((x) => x.type === "gshadow_mem");
  asrt(mem.length >= 1 && mem.at(-1).features === true && mem.at(-1).mints >= 1 && mem.at(-1).rssMB > 0, `[${n}] a gshadow_mem row at the stop (got ${JSON.stringify(mem.at(-1))})`);
}
{
  const fo = decisions(featOff);
  asrt(same(fo.opens, golden.features.opens) && same(fo.trades, golden.features.trades), "[features off] SHADOW_FEATURES=0: the same decisions");
  asrt(featOff.opens.every((o) => o.feat === null && o.shadowRev === 7), "[features off] feat: null");
}
{
  // The features scenario, checked field by field.
  const { opens } = runs.features;
  const a = opens.find((o) => o.mint === M.FEAT_MINT && o.variant === "A");
  const f = a.feat;
  asrt(a.fill === 93 && f.creator === M.CREATOR && f.creatorSource === "create" && f.name === "Solana AI" && f.symbol === "SAI", `[features] FEAT_MINT: the create's creator / name (got ${JSON.stringify(f)})`);
  asrt(f.creatorBuySol === 1 && f.creatorSellSol === 0.4 && f.creatorTrades === 2, "[features] the creator bought 1 SOL and sold 0.4 SOL in 2 trades");
  asrt(f.creatorLaunches24h === 2 && f.sameNameRecent === 1, `[features] 2 launches in 24 h, 1 copycat name in 30 min (got ${f.creatorLaunches24h} / ${f.sameNameRecent})`);
  asrt(f.ageSec >= 98 && f.ageSec <= 110 && f.firstSeenFill === 0, `[features] age ~100 s by on-chain time, seen from its create (got ${f.ageSec} / ${f.firstSeenFill})`);
  asrt(f.trades === 29 && f.uniqueTraders === 19 && f.topWalletTradeShare === 0.345 && f.topWalletVolShare === 0.621, `[features] 29 trades by 19 wallets, the wash wallet 10 trades / 20 of 32.2 SOL (got ${JSON.stringify(pick(f, ["trades", "uniqueTraders", "topWalletTradeShare", "topWalletVolShare"]))})`);
  asrt(f.buySol60 === 18.8 && f.sellSol60 === 13.4 && f.buys60 === 22 && f.sells60 === 7 && f.maxSell60Sol === 3, `[features] 60 s flow incl. the 3 SOL whale sell (got ${JSON.stringify(pick(f, ["buySol60", "sellSol60", "buys60", "sells60", "maxSell60Sol"]))})`);
  asrt(f.top5NetSol === 2.6 && f.top5NetShare === 0.033, `[features] top-5 net buyers 2.6 SOL of 79.05 (got ${f.top5NetSol} / ${f.top5NetShare})`);
  asrt(f.priceRel === Math.round((30 / 109.05) * 1000) / 1000, `[features] the fixture's curve is not the standard one: priceRel ${f.priceRel}`);
  const n = opens.find((o) => o.mint === M.NOCREATE_MINT && o.variant === "A").feat;
  asrt(n.creator === M.TRADE_CREATOR && n.creatorSource === "trade" && n.ageSec === null && n.name === null && n.sameNameRecent === null && n.firstSeenFill === 10 && n.creatorLaunches24h === 1 && n.creatorTrades === 0, `[features] NOCREATE_MINT: creator from the trade event, launch fields null (got ${JSON.stringify(n)})`);
  const s = runs.single.opens.find((o) => o.variant === "A").feat;
  asrt(s.creator === null && s.creatorBuySol === null && s.ageSec === null && s.firstSeenFill === 5 && s.trades === 17 && s.uniqueTraders === 17, `[single] no create, no creator field: nulls, not zeros (got ${JSON.stringify(s)})`);
}
{
  // Migration timing on migrated rows.
  const { trades } = runs.migrate;
  asrt(trades.length === 2 && trades.every((t) => t.migrated === true), "[migrate] J and N closed on the pool");
  for (const t of trades) {
    asrt(Number.isInteger(t.curveCompleteSec) && Math.abs(t.curveCompleteSec - Date.now() / 1000) < 120, `[migrate] ${t.variant}: curveCompleteSec is the 100% event's on-chain time (got ${t.curveCompleteSec})`);
    asrt(typeof t.migNoticedLagSec === "number" && t.migNoticedLagSec >= -1 && t.migNoticedLagSec <= 5, `[migrate] ${t.variant}: migNoticedLagSec small and numeric (got ${t.migNoticedLagSec})`);
  }
  asrt(runs.single.trades.every((t) => t.curveCompleteSec === undefined && t.migNoticedLagSec === undefined), "[single] curve exits carry no migration timing");
}

const ex = runs.features.opens.find((o) => o.mint === M.FEAT_MINT && o.variant === "J");
console.log(JSON.stringify({ exampleOpen: ex }));
console.log("PASS: shadow rev 7 — gshadow_open carries feat (creator, launches, copycats, wallet concentration, 60 s flow, priceRel); migrated rows carry curveCompleteSec / migNoticedLagSec; decisions identical to revision 6; memory bounded");
