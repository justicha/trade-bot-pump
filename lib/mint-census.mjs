// Mint census (KODING #19): one row per pump.fun mint, for EVERY launch the stream shows.
//
// Research only. Nothing here reads a key, signs, sends or calls an RPC: the input is the pump
// program's log stream (create-v2 and trade-v3 events, decoded by lib/events.mjs), the output is
// rows for scripts/mint-census.mjs to append to data/census/census-YYYY-MM-DD.jsonl.
//
// Why: the graduation strategy is closed; a new one needs base rates and early predictors over all
// launches (~20–40k a day), not only the ~600 a day the shadow lab sees at fill >= 92 %.
//
// Per mint:
//   - who launched it (the create event: `user` = launcher, `creator`, name, symbol, on-chain time;
//     launches of that launcher in 24 h from lib/gshadow-features.mjs's launcher index) and the dev
//     buy (launcher's / creator's buys in the create slot or the first DEV_BUY_SEC seconds);
//   - fill milestones (default 25 50 75 85 92 97 100 % of the 85 SOL real reserve): at the FIRST
//     event that reaches each one a snapshot of the curve and of the rev-7 `feat` fields
//     (buildFeatures — the same names, so the shadow analysis code reads them as is);
//   - after each milestone: the deepest fill before the mint ends (minFillAfter), the curve price
//     there against the milestone price (ratioMinAfter — the stop-loss question) and the seconds to
//     100 % (secTo100, null if never).
// A mint FINISHES (and its row is written) when its curve completes (fill >= 100: migrated), after
// `idleSec` of stream time without an event ("idle"), or at the process stop ("shutdown", partial).
// A mint that trades again after its idle row continues with `resumed: true` (the analysis takes
// the last row per mint).
//
// Milestones are recorded only for crossings the census SAW: a mint whose create was not seen
// starts at its first observed fill (firstSeenFill), and milestones at or below it stay absent.
//
// Time: on-chain seconds of the events drive everything (windows, idleness: the "stream clock" is
// the newest plausible event time). A process stall therefore cannot make live mints look idle;
// the local clock is used only for the event lag (maxLagSec) and for the writer's file date.
//
// Missing data is null, never guessed: a mint whose create was not seen has createSeen: false and
// launcher / isCreator / launches24h / devBuySol / createSec null.
//
// Rev 2 (KODING #21): after a curve completion the census watches the mint's PumpSwap pool for
// CENSUS_POOL_WATCH_SEC and writes one `census_pool` row (lib/census-pool.mjs). census_mint rows are
// unchanged except censusRev. CENSUS_POOL=0 switches the pool part off. #21b: the pool is subscribed
// when the mint's fill first reaches CENSUS_POOL_PRESUB_FILL (92), a "pending" watch until the curve
// completes, dropped (no row) if the mint ends without completing.
//
// Rev 3 (KODING #21c) — census_mint semantics change, do not pool with rev 2 without a note:
//   - the fill comes from the TOKEN side of the curve (vTok; the SOL-equivalent fill on the standard
//     constant-product curve, tokenFill) when the SOL side does not describe the curve's progress:
//       * "unpriced" events (vSol = realSol = 0) are curves quoted in another mint (USDC, other pump
//         tokens, ...: the pump TradeEvent's quote_mint, IDL 2026-11); their token side is standard;
//       * mayhem curves (TradeEvent mayhem_mode): their virtual SOL is cut on the fly, they complete
//         with ~0.4 SOL raised, so realSol / 85 stays near 0 until the completion.
//     Checked on 66 872 live events (KODING_REPORT_21c). A normal SOL curve keeps the SOL fill (the
//     two agree to < 0.0001 pp there). `fillSource` per milestone; census_mint `tokenFillEvents`.
//   - the completion is fill >= 100 on that fill (= real tokens 0), so mayhem and other-quote curves
//     complete too; the pool watch runs for SOL-quoted curves only (the canonical pool is the WSOL one).
//   - a pending pool watch that sees its own CreatePoolEvent or a pool trade while the mint's
//     completion was not seen activates anyway (completeSeen: false); see handlePoolLogs.
//
// Rev 3.1 (KODING #21e), CENSUS_REV stays 3 (fields only added):
//   - census_mint `mayhem` is always present: true / false / null (null = neither the create tail nor a
//     trade tail was parsed). Rev-3 rows written before #21e carry `mayhem: true` or no field (= false
//     or unknown).
//   - census_pool: pool traffic budget, phase 1 logs -> phase 2 vaults (lib/census-pool.mjs header):
//     logsUntilSec / logsCutReason / phase2 / vaults; flow1m / flow5m / launcher, creator sells /
//     largestSell are null when phase 1 ended before their window; flowAll covers phase 1 only.
//
// KODING #24, CENSUS_REV stays 3 (a row type added): `census_path` rows (lib/census-path.mjs), one per
// mint whose fill reaches CENSUS_PATH_MIN_FILL (25): the per-second fill / price / flow path, written
// right after the mint's census_mint row (same finish, same `final`). CENSUS_PATH=0 = off (every
// other row byte-for-byte as before; census_mem then carries no path* fields).
import fs from "node:fs";
import path from "node:path";
import { gradFillPct } from "./curve.mjs";
import { PublicKey } from "@solana/web3.js";
import { parseCreate, parseTrade, tradeCreator } from "./events.mjs";
import { parsePumpSwapCreatePool, parsePumpSwapTrade } from "./pumpswap-stream.mjs";
import {
  DEFAULT_PATH_MAX_BUCKETS,
  DEFAULT_PATH_MAX_SEC,
  DEFAULT_PATH_MIN_FILL,
  closeHole,
  createPathStore,
  openGapHole,
  pathRow,
  pathStats,
  pathTrade,
  stallHole,
  trimHoles,
} from "./census-path.mjs";
import {
  DEFAULT_POOL_LOGS_MB,
  DEFAULT_POOL_LOGS_SEC,
  DEFAULT_POOL_WATCH_SEC,
  DEFAULT_PRESUB_FILL,
  dropPresub,
  lateComplete,
  noCompleteWatch,
  notePoolTraffic,
  notePoolTruncated,
  onPoolCreate,
  presubPool,
  createPoolWatch,
  finishAllPools,
  firstSighting,
  markPools,
  onPoolTrade,
  onVaultNote,
  poolStats,
  sweepPools,
  watchPool,
} from "./census-pool.mjs";
import {
  buildFeatures,
  createFeatureStore,
  createLauncherIndex,
  evictIdle,
  launcherInfo,
  launcherStats,
  noteCreate,
  noteLaunch,
  noteTrade,
  storeStats,
  trimIndexes,
  trimLaunchers,
} from "./gshadow-features.mjs";

// UTC hour of an on-chain second: the same rule as lib/gshadow.mjs hourUtc (not imported from there:
// that module pulls the fee config and with it lib/config.mjs into this pure module).
function hourUtc(sec) {
  const t = Number(sec);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.floor((t % 86400) / 3600);
}

export const CENSUS_REV = 3;
export const DEFAULT_MILESTONES = [25, 50, 75, 85, 92, 97, 100];
export const DEFAULT_IDLE_SEC = 1800;
export const DEFAULT_FULL_MIN_FILL = 25;
export const DEV_BUY_SEC = 10; // dev buy = launcher's / creator's buys in the create slot or this many seconds
export const RESUME_WINDOW_SEC = 24 * 3600; // an idle mint is remembered this long (resumed rows)
export const STALL_SEC = 30; // a gap between two 1 s timer ticks longer than this is a process stall
export const DEFAULT_GAP_SEC = 10; // no create / trade event for this long = a stream gap (normal rate ~45 events/s)
export const GAP_AFTER_MS = 60_000; // mints first seen / milestones taken this soon after a gap are flagged
const UNPRICED_LENS_MAX = 4; // distinct payload lengths kept per mint
// An event time this far from the local clock is not trusted for the stream clock (one bogus
// timestamp of ~0 was seen in rev 6; a far-future one would finish every live mint at once).
const PLAUSIBLE_PAST_SEC = 6 * 3600;
const PLAUSIBLE_FUTURE_SEC = 120;
// The milestone `feat` drops the per-mint constants (they are on the row once).
const FEAT_ROW_LEVEL = ["creator", "creatorSource", "name", "symbol", "firstSeenFill", "watchSec"];

// ---- the token side of the curve (rev 3) --------------------------------------------------------------
// trade-v3 payload: virtual_token_reserves @105, real_token_reserves @121 (lib/events.mjs layout). They
// are present in the "unpriced" events too. A standard curve starts at 1.073e15 virtual / 793.1e12
// real tokens, so virtual - real = 279.9e12 for its whole life (all but 102 of the 66 872 live events
// of the 2026-11-17 sample, mayhem and other-quote curves included; those 102: 5 mints at 211.8e12).
export const STD_TOKEN_OFFSET = 279_900_000_000_000n;
const LAUNCH_VTOK = 1.073e15;
// The SOL-equivalent fill from the token side: on the standard curve vSol = 30 SOL x 1.073e15 / vTok,
// so realSol / 85 SOL = (30 / 85) x (1.073e15 / vTok - 1). 100.006 at real tokens 0 (the completion),
// exactly as the SOL fill (85.005 SOL). NOT the share of tokens sold (1 - realTok / 793.1e12): that is
// another curve coordinate (50 % sold = 20.7 % fill).
export function tokenFill(vTok) {
  const v = Number(vTok);
  return v > 0 ? (30 / 85) * (LAUNCH_VTOK / v - 1) * 100 : null;
}
export function tokenSide(data) {
  if (!data || data.length < 129) return null;
  const vTok = data.readBigUInt64LE(105);
  const rTok = data.readBigUInt64LE(121);
  if (vTok === 0n) return null;
  return { vTok, rTok, std: vTok - rTok === STD_TOKEN_OFFSET };
}
// The curve's last price at its completion on a standard SOL curve (vSol 115.005 SOL / vTok 279.9e12):
// every complete row of the rev-2 runs carried it.
export const STANDARD_CURVE_END = 4.1088e-7;
// The quote mint of a SOL curve in the TradeEvent (the default pubkey) and the WSOL mint.
const SOL_QUOTES = new Set(["11111111111111111111111111111111", "So11111111111111111111111111111111111111112"]);
const IX_NAME_MAX = 64;
// pump TradeEvent tail (pump-public-docs idl/pump.json, read 2026-11-17): after real_token_reserves
// @121: fee_recipient @129, fee_basis_points @161, fee @169, creator @177, creator_fee_basis_points
// @209, creator_fee @217, track_volume @225, total_unclaimed_tokens @226, total_claimed_tokens @234,
// current_sol_volume @242, last_update_timestamp @250, ix_name string @258 (u32 length + bytes),
// then mayhem_mode bool, cashback_fee_basis_points, cashback, buyback_fee_basis_points, buyback_fee
// (4 x u64), shareholders vec (u32 count + 34 bytes each), quote_mint pubkey, quote_amount,
// virtual_quote_reserves, real_quote_reserves, ... Null when the payload is too short for it.
export function tradeTail(data) {
  try {
    if (!data || data.length < 262) return null;
    const n = data.readUInt32LE(258);
    if (n > IX_NAME_MAX) return null;
    let o = 262 + n;
    if (data.length < o + 1 + 32 + 4) return null;
    const mayhem = data[o] === 1;
    o += 1 + 32;
    const holders = data.readUInt32LE(o);
    o += 4 + holders * 34;
    if (holders > 64 || data.length < o + 32) return { mayhem, quoteMint: null, solQuote: null };
    const quoteMint = new PublicKey(data.subarray(o, o + 32)).toBase58(); // (events.mjs toBase58Safe gives 33 chars for the all-zero key)
    return { mayhem, quoteMint, solQuote: SOL_QUOTES.has(quoteMint) };
  } catch {
    return null;
  }
}

// #21e: the create-v2 tail (lib/events.mjs parseCreate `tail`, after token_total_supply): token_program
// pubkey, then is_mayhem_mode bool. Checked on 37 real creates (2026-11-18, 31 with a trade): that byte
// equals the TradeEvent's mayhem_mode in 31 of 31 (17 true, 14 false); fixture
// scripts/fixtures/pump-create-mayhem.json. Null when the tail does not start with a token program.
const TOKEN_PROGRAMS = ["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"].map((k) => new PublicKey(k).toBuffer());
export function createMayhem(c) {
  const t = c?.tail;
  if (!t || t.length < 33) return null;
  const head = Buffer.from(t.subarray(0, 32));
  if (!TOKEN_PROGRAMS.some((p) => p.equals(head))) return null;
  return t[32] === 1 ? true : t[32] === 0 ? false : null;
}

// #21e: census_mint `mayhem` is true / false / null (null = no create tail and no trade tail parsed).
// The first source sets it; a later `true` wins (as before: true once seen); a disagreement is counted.
function noteMayhem(census, rec, value, source) {
  if (value === null || value === undefined) return;
  if (rec.mayhem === null) {
    rec.mayhem = value;
    census.counts[source === "create" ? "mayhemFromCreate" : "mayhemFromTrade"] += 1;
    return;
  }
  if (rec.mayhem !== value) {
    if (!rec.mayhemConflict) census.counts.mayhemConflict += 1;
    rec.mayhemConflict = true;
    if (value) rec.mayhem = true;
  }
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sig = (x) => (x > 0 ? Number(x.toPrecision(6)) : x); // prices are ~1e-8 SOL/token: 6 significant digits

// ---- configuration --------------------------------------------------------------------------------
// A bad value is a loud error naming the variable, never a silent default.
function numEnv(env, name, def, { min, max, integer = false } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || (integer && !Number.isInteger(v))) throw new Error(`${name} must be ${integer ? "an integer" : "a number"} (got "${raw}")`);
  if (min !== undefined && v < min) throw new Error(`${name} must be >= ${min} (got ${v})`);
  if (max !== undefined && v > max) throw new Error(`${name} must be <= ${max} (got ${v})`);
  return v;
}

export function parseMilestones(raw) {
  if (raw === undefined || raw === "") return [...DEFAULT_MILESTONES];
  const parts = String(raw).split(",").map((s) => s.trim());
  const out = [];
  for (const p of parts) {
    const v = Number(p);
    if (p === "" || !Number.isFinite(v) || v <= 0 || v > 100) throw new Error(`CENSUS_MILESTONES must be a comma list of fills in (0, 100] (got "${raw}")`);
    if (out.length && v <= out[out.length - 1]) throw new Error(`CENSUS_MILESTONES must be strictly increasing (got "${raw}")`);
    out.push(v);
  }
  return out;
}

export function parseCensusEnv(env = process.env) {
  return {
    milestones: parseMilestones(env.CENSUS_MILESTONES),
    idleSec: numEnv(env, "CENSUS_IDLE_SEC", DEFAULT_IDLE_SEC, { min: 1, integer: true }),
    fullMinFill: numEnv(env, "CENSUS_FULL_MIN_FILL", DEFAULT_FULL_MIN_FILL, { min: 0, max: 100 }),
    maxSec: numEnv(env, "CENSUS_MAX_SEC", 0, { min: 0 }),
    memRowSec: numEnv(env, "CENSUS_MEM_ROW_SEC", 600, { min: 0 }),
    gapSec: numEnv(env, "CENSUS_GAP_SEC", DEFAULT_GAP_SEC, { min: 1 }),
    pool: boolEnv(env, "CENSUS_POOL", true),
    poolWatchSec: numEnv(env, "CENSUS_POOL_WATCH_SEC", DEFAULT_POOL_WATCH_SEC, { min: 1, max: 86400, integer: true }),
    poolMode: choiceEnv(env, "CENSUS_POOL_MODE", "a", ["a", "b"]),
    poolPresubFill: numEnv(env, "CENSUS_POOL_PRESUB_FILL", DEFAULT_PRESUB_FILL, { min: 50, max: 100 }),
    // #21e: pool traffic budget (phase 1 logs -> phase 2 vaults)
    poolLogsSec: numEnv(env, "CENSUS_POOL_LOGS_SEC", DEFAULT_POOL_LOGS_SEC, { min: 1, max: 86400, integer: true }),
    poolLogsMB: numEnv(env, "CENSUS_POOL_LOGS_MB", DEFAULT_POOL_LOGS_MB, { min: 0.001, max: 100000 }),
    poolVaults: boolEnv(env, "CENSUS_POOL_VAULTS", true),
    poolVaultCheck: boolEnv(env, "CENSUS_POOL_VAULT_CHECK", false),
    // #24: the curve price path
    pathOn: boolEnv(env, "CENSUS_PATH", true),
    pathMinFill: numEnv(env, "CENSUS_PATH_MIN_FILL", DEFAULT_PATH_MIN_FILL, { min: 1, max: 100 }),
    pathMaxSec: numEnv(env, "CENSUS_PATH_MAX_SEC", DEFAULT_PATH_MAX_SEC, { min: 1, max: 86400, integer: true }),
    pathMaxBuckets: numEnv(env, "CENSUS_PATH_MAX_BUCKETS", DEFAULT_PATH_MAX_BUCKETS, { min: 1, max: 100000, integer: true }),
  };
}

function boolEnv(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (raw === "1") return true;
  if (raw === "0") return false;
  throw new Error(`${name} must be 0 or 1 (got "${raw}")`);
}

function choiceEnv(env, name, def, allowed) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (!allowed.includes(raw)) throw new Error(`${name} must be one of ${allowed.join(" / ")} (got "${raw}")`);
  return raw;
}

// ---- state ----------------------------------------------------------------------------------------
export function createCensus({ milestones = DEFAULT_MILESTONES, idleSec = DEFAULT_IDLE_SEC, fullMinFill = DEFAULT_FULL_MIN_FILL, startedAtMs = Date.now(), pool = true, poolWatchSec = DEFAULT_POOL_WATCH_SEC, poolMode = "a", poolPresubFill = DEFAULT_PRESUB_FILL, poolLogsSec = DEFAULT_POOL_LOGS_SEC, poolLogsMB = DEFAULT_POOL_LOGS_MB, poolVaults = true, poolVaultCheck = false, pathOn = false, pathMinFill = DEFAULT_PATH_MIN_FILL, pathMaxSec = DEFAULT_PATH_MAX_SEC, pathMaxBuckets = DEFAULT_PATH_MAX_BUCKETS } = {}) {
  return {
    cfg: { milestones: [...milestones], idleSec, fullMinFill },
    // PumpSwap pool watches after a completion (rev 2); null = CENSUS_POOL=0 (rev-1 behaviour).
    pools: pool ? createPoolWatch({ rev: CENSUS_REV, watchSec: poolWatchSec, idleSec, mode: poolMode, presubFill: poolPresubFill, logsSec: poolLogsSec, logsMB: poolLogsMB, vaults: poolVaults, vaultCheck: poolVaultCheck }) : null,
    // #24: per-second curve paths; null = off. The library default is off (the unit tests of the other
    // rows predate it); scripts/mint-census.mjs passes parseCensusEnv, where CENSUS_PATH defaults to 1.
    paths: pathOn ? createPathStore({ minFill: pathMinFill, maxSec: pathMaxSec, maxBuckets: pathMaxBuckets }) : null,
    pumpSec: 0, // #24: newest plausible on-chain second of a PUMP stream event (the path holes' clock)
    lastTickPumpSec: null, // pumpSec at the last checkGap call (the 1 s timer): a stall hole starts there
    openHole: null, // #24: a closed gap whose path hole waits for the closing event's second
    startedAtMs,
    live: new Map(), // mint -> rec (see newRec)
    idled: new Map(), // mint -> rec of a mint whose idle row was written (kept RESUME_WINDOW_SEC)
    migrated: new Map(), // mint -> sec: mints whose complete row was written (later events are ignored)
    feats: createFeatureStore(),
    launches: createLauncherIndex(),
    streamSec: 0, // newest plausible on-chain event time
    stallActive: false,
    // Stream gaps (#19b): local receive time of the last create / trade event, the open gap (its
    // start = that time) and the end of the flag window after the last closed gap.
    lastEventMs: null,
    gap: null, // { startedAtMs, liveMints } while the stream is silent
    gapUntilMs: 0,
    unpricedByLen: {}, // payload length -> count of trade events without a reserve snapshot
    counts: { rows: 0, full: 0, compact: 0, migrated: 0, idle: 0, shutdown: 0, resumed: 0, creates: 0, trades: 0, unpriced: 0, tokenFill: 0, badFill: 0, mayhemFromCreate: 0, mayhemFromTrade: 0, mayhemConflict: 0, afterComplete: 0, bogusTs: 0, stalls: 0, gaps: 0, gapSecTotal: 0, parseErrors: 0, logTruncated: 0 },
  };
}

function newRec(mint) {
  return {
    mint,
    createSeen: false,
    createSec: null,
    createSlot: null,
    name: null,
    symbol: null,
    creator: null,
    launcher: null,
    isCreator: null,
    launches24h: null,
    devBuySol: null,
    firstSec: null,
    firstSeenFill: null,
    baseFill: null, // milestones <= this were not seen crossing (0 when the create was seen first)
    fill: null,
    maxFill: 0,
    maxFillSec: null,
    trades: 0,
    fillEvents: 0, // trades that gave a fill (SOL side or token side)
    tokenFillEvents: 0, // rev 3: trades whose fill came from the token side
    mayhem: null, // #21e: true / false / null — the create tail's is_mayhem_mode, else the first TradeEvent tail
    quoteMint: null, // rev 3: the curve's quote mint when it is not SOL
    lastPrice: null, // the last SOL price seen (a curve end when the completion was not seen)
    lastPriceFill: null,
    unpricedTrades: 0, // trades whose payload carries no SOL reserve snapshot (no SOL price at that event)
    unpricedLens: null, // distinct payload lengths of those events (at most UNPRICED_LENS_MAX)
    unpricedSample: null, // first unpriced event: bytes 8..24 (after the discriminator), hex
    unpricedTail: null, // first unpriced event: bytes 89..129 (timestamp + the four reserve fields), hex
    lastSec: null,
    maxLagSec: null,
    completeSec: null,
    completeSeen: null, // rev 3: false = completed by its pool's own event (the completion was not seen)
    activatedSec: null,
    curveEndPrice: null, // the curve price at the completing event (the pool path is measured against it)
    milestones: null, // { "25": snapshot, ... } — created on the first crossing
    stall: false,
    gap: false,
    resumed: false,
  };
}

// The on-chain second to use for an event: its own when plausible, else the local clock.
// `pump` = an event of the pump stream (not of a pool subscription): it also moves census.pumpSec, the
// clock of the path holes (#24: a pool stream that keeps running through a pump-stream gap must not
// move the hole's start).
function eventSec(census, sec, nowMs, { pump = true } = {}) {
  const local = Math.floor(nowMs / 1000);
  const s = Number(sec);
  if (Number.isFinite(s) && s > local - PLAUSIBLE_PAST_SEC && s < local + PLAUSIBLE_FUTURE_SEC) {
    if (s > census.streamSec) census.streamSec = s;
    if (pump && s > census.pumpSec) census.pumpSec = s;
    return { sec: s, lag: (nowMs / 1000) - s };
  }
  census.counts.bogusTs += 1;
  if (local > census.streamSec) census.streamSec = local;
  if (pump && local > census.pumpSec) census.pumpSec = local;
  return { sec: local, lag: null };
}

function noteLag(rec, lag) {
  if (lag === null) return;
  if (rec.maxLagSec === null || lag > rec.maxLagSec) rec.maxLagSec = r1(lag);
}

// A rec for `mint`: live, or resumed from its idle row. Null for a mint that already migrated.
function recFor(census, mint, nowMs) {
  let rec = census.live.get(mint);
  if (rec) return rec;
  if (census.migrated.has(mint)) return null;
  rec = census.idled.get(mint);
  if (rec) {
    census.idled.delete(mint);
    rec.resumed = true;
    census.counts.resumed += 1;
  } else rec = newRec(mint);
  if (census.stallActive) rec.stall = true;
  if (inGapWindow(census, nowMs)) rec.gap = true;
  census.live.set(mint, rec);
  return rec;
}

// ---- events ---------------------------------------------------------------------------------------
// A create-v2 event (lib/events.mjs parseCreate). `slot`: the notification's context slot.
export function onCreate(census, c, { slot = null, nowMs = Date.now() } = {}) {
  if (!c || !c.mint) return [];
  census.counts.creates += 1;
  const rec = recFor(census, c.mint, nowMs);
  if (!rec) return [];
  if (rec.createSeen) return []; // a re-delivered create counts once
  const { sec, lag } = eventSec(census, c.timestampSec, nowMs);
  noteLag(rec, lag);
  noteLaunch(census.launches, c);
  noteCreate(census.feats, c, nowMs);
  rec.createSeen = true;
  rec.createSec = sec;
  rec.createSlot = Number.isFinite(slot) && slot > 0 ? slot : null;
  rec.name = typeof c.name === "string" ? c.name.slice(0, 32) : null;
  rec.symbol = typeof c.symbol === "string" ? c.symbol.slice(0, 32) : null;
  rec.creator = c.creator || null;
  const info = launcherInfo(census.launches, c.mint, rec.createSec);
  rec.launcher = info.known ? info.launcher : c.user || null;
  rec.isCreator = rec.launcher && rec.creator ? rec.launcher === rec.creator : null;
  rec.launches24h = info.known ? info.launches24h : null;
  rec.devBuySol = 0;
  noteMayhem(census, rec, createMayhem(c), "create");
  // Trades delivered before their create keep the baseline of the first seen trade (conservative:
  // a crossing is recorded only if it was seen).
  if (rec.firstSec === null) {
    rec.firstSec = sec;
    rec.firstSeenFill = 0;
    rec.baseFill = 0;
  }
  if (rec.lastSec === null || sec > rec.lastSec) rec.lastSec = sec;
  return [];
}

// rev 3: the fill of one trade event. The SOL side (realSol / 85 SOL) for a normal SOL curve; the
// token side (tokenFill) for a mayhem curve and for an event without the SOL snapshot (a curve quoted
// in another mint). On a standard token side the fill reaches 100 only at real tokens 0 (the program's
// completion): a rounded 99.996 is NOT a completion (live 2026-11-17: a mayhem mint read 100.00 with
// tokens left and never got a pool), so it is capped at 99.99 while tokens remain.
export const MAX_PLAUSIBLE_FILL = 200;
export function fillOf(t, raw) {
  const res = t.reserves;
  const priced = !!(res && res.usable && res.realSol !== null && res.realSol !== undefined);
  const tail = raw ? tradeTail(raw) : null;
  const tok = raw ? tokenSide(raw) : null;
  let fill = null;
  let fillSource = null;
  if (tok?.std && (!priced || tail?.mayhem)) {
    fill = r2(tokenFill(tok.vTok));
    fillSource = "token";
  } else if (priced) {
    fill = r2(gradFillPct(res.realSol));
    fillSource = "price";
  }
  if (fill !== null && tok?.std && tok.rTok > 0n && fill >= 100) fill = 99.99;
  return { priced, tail, tok, fill, fillSource };
}

// A parsed trade-v3 event (lib/events.mjs parseTrade). `creatorOf`: lazy reader of the payload's
// creator field (feature store fallback when the create was not seen). Returns finished rows.
// `raw`: the payload buffer (only read for an event without reserves: unpricedSample / unpricedTail).
export function onTrade(census, t, { slot = null, nowMs = Date.now(), creatorOf = null, raw = null } = {}) {
  if (!t || !t.mint) return [];
  census.counts.trades += 1;
  const rec = recFor(census, t.mint, nowMs);
  if (!rec) {
    census.counts.afterComplete += 1;
    lateCompletion(census, t, raw, nowMs);
    return [];
  }
  const { sec, lag } = eventSec(census, t.timestampMs, nowMs); // lib/events.mjs: "timestampMs" is seconds
  noteLag(rec, lag);
  rec.trades += 1;
  if (rec.lastSec === null || sec > rec.lastSec) rec.lastSec = sec;
  if (rec.firstSec === null) rec.firstSec = sec;
  const sol = Number(t.solAmount) > 0 ? Number(t.solAmount) : 0;

  // Dev buy: the launcher's or creator's buys in the create slot or the first DEV_BUY_SEC seconds.
  if (rec.createSeen && t.isBuy && (t.user === rec.launcher || t.user === rec.creator)) {
    const inSlot = rec.createSlot !== null && slot === rec.createSlot;
    if (inSlot || sec - rec.createSec <= DEV_BUY_SEC) rec.devBuySol = r4(rec.devBuySol + sol);
  }

  // Fill (rev 3): the SOL side (realSol / 85 SOL) for a normal SOL curve; the token side (tokenFill)
  // for a mayhem curve and for an event without the SOL snapshot (a curve quoted in another mint).
  // The price stays SOL-only: null when the event has no SOL snapshot.
  const res = t.reserves;
  const priced = !!(res && res.usable && res.realSol !== null && res.realSol !== undefined);
  const { tail, fill: f0, fillSource: src0 } = fillOf(t, raw);
  if (tail) noteMayhem(census, rec, tail.mayhem, "trade");
  if (tail && tail.quoteMint && !tail.solQuote) rec.quoteMint = tail.quoteMint;
  let fill = f0;
  let fillSource = src0;
  if (fill !== null && fill > MAX_PLAUSIBLE_FILL) {
    // not a real curve state (live 2026-11-17: two non-pump "mints", one event each, fill 1.8e9 %);
    // rev 2 recorded them as migrations. The event counts as a trade without a fill.
    census.counts.badFill += 1;
    fill = null;
    fillSource = null;
  }
  // #24: a wallet new on this mint (the feature store's wallet map: this part of the mint)
  const newWallet = census.paths && t.user ? !census.feats.mints.get(t.mint)?.wallets.has(t.user) : false;
  noteTrade(census.feats, { mint: t.mint, user: t.user, isBuy: !!t.isBuy, solLamports: Math.round(sol * 1e9), timestampSec: sec }, { nowMs, fill: fill ?? NaN, creatorOf });
  if (!priced) {
    census.counts.unpriced += 1;
    rec.unpricedTrades += 1;
    census.unpricedByLen[t.len] = (census.unpricedByLen[t.len] || 0) + 1;
    rec.unpricedLens ??= [];
    if (!rec.unpricedLens.includes(t.len) && rec.unpricedLens.length < UNPRICED_LENS_MAX) rec.unpricedLens.push(t.len);
    if (rec.unpricedSample === null && raw) {
      // Raw bytes only, no decoding guess: PROMPT tells a new layout from a broken one offline.
      rec.unpricedSample = raw.subarray(8, 24).toString("hex");
      rec.unpricedTail = raw.length >= 129 ? raw.subarray(89, 129).toString("hex") : null;
    }
  }
  if (census.paths) {
    const pathPrice = priced && fill !== null ? sig((Number(res.vSol) / Number(res.vTok)) * 1e-3) : null; // = `price` below
    pathTrade(census.paths, rec, { sec, fill, price: pathPrice, isBuy: !!t.isBuy, sol, newWallet });
  }
  if (fill === null) return [];
  rec.fillEvents += 1;
  if (fillSource === "token") {
    rec.tokenFillEvents += 1;
    census.counts.tokenFill += 1;
  }
  const price = priced ? sig((Number(res.vSol) / Number(res.vTok)) * 1e-3) : null;
  if (price !== null) {
    rec.lastPrice = price;
    rec.lastPriceFill = fill;
  }
  if (rec.firstSeenFill === null) {
    rec.firstSeenFill = fill;
    rec.baseFill = fill; // create not seen: crossings up to here were not watched
  }
  rec.fill = fill;
  if (fill > rec.maxFill) {
    rec.maxFill = fill;
    rec.maxFillSec = sec;
  }
  // Post-milestone tracking: the deepest fill and the price there.
  if (rec.milestones) {
    for (const s of Object.values(rec.milestones)) {
      if (fill < s.minFillAfter && (price !== null || s.price === null)) {
        s.minFillAfter = fill;
        s.minPriceAfter = price;
        s.minSecAfter = sec;
      }
    }
  }
  // Milestones crossed by this event (a jump 20 -> 60 records 25 and 50 here), each once.
  for (const m of census.cfg.milestones) {
    if (fill < m) break;
    if (m <= rec.baseFill) continue;
    const key = String(m);
    if (rec.milestones && key in rec.milestones) continue;
    rec.milestones ??= {};
    rec.milestones[key] = snapshot(census, rec, { sec, fill, fillSource, price, lag, curve: priced ? res : null, nowMs });
  }
  // #21b: subscribe the mint's (future) PumpSwap pool once its fill reaches the pre-subscription fill
  // (SOL-quoted curves only: the canonical pool of another quote is not the WSOL one)
  if (census.pools && !rec.presubbed && !rec.quoteMint && fill >= census.pools.cfg.presubFill && census.pools.cfg.presubFill < 100) {
    rec.presubbed = true;
    presubPool(census.pools, { mint: rec.mint, stall: census.stallActive, gap: inGapWindow(census, nowMs) });
  }
  if (fill >= 100) {
    rec.completeSec = sec;
    rec.completeSeen = true;
    rec.curveEndPrice = price; // null on an event without the SOL snapshot (other quote: no pool watch)
    return finish(census, rec, "complete");
  }
  return [];
}

// rev 3: the completing trade of a mint whose pool watch was already activated by the pool's own event
// (the pump and pool subscriptions are separate streams; their notifications of one slot can come in
// either order): the watch gets the real completion second and curve end. The mint row is already
// written (completeSeen: false).
function lateCompletion(census, t, raw, nowMs) {
  if (!census.pools || !census.migrated.has(t.mint)) return;
  const w = noCompleteWatch(census.pools, t.mint);
  if (!w) return;
  const res = t.reserves;
  const { priced, fill } = fillOf(t, raw);
  if (!(fill >= 100 && fill <= MAX_PLAUSIBLE_FILL)) return;
  const { sec } = eventSec(census, t.timestampMs, nowMs);
  lateComplete(census.pools, w, { completeSec: sec, curveEndPrice: priced ? sig((Number(res.vSol) / Number(res.vTok)) * 1e-3) : null });
}

// rev 3: the curve end a pool watch is measured against. Seen completion with a SOL price -> that
// price ("price"). Otherwise (the completion was not seen): a normal SOL curve ends at the constant
// STANDARD_CURVE_END ("standard"); a mayhem curve has no constant end (its virtual SOL is cut on the
// fly) -> its last seen SOL price ("lastPrice", with that event's fill in curveEndFill). Null for a
// curve quoted in another mint (no pool watch).
export function curveEndOf(rec) {
  if (rec.quoteMint) return null;
  if (rec.completeSeen && rec.curveEndPrice > 0) return { price: rec.curveEndPrice, source: "price", fill: null };
  if (!rec.mayhem) return { price: STANDARD_CURVE_END, source: "standard", fill: null };
  if (rec.lastPrice > 0) return { price: rec.lastPrice, source: "lastPrice", fill: rec.lastPriceFill };
  return null;
}

function snapshot(census, rec, { sec, fill, fillSource, price, lag, curve, nowMs }) {
  const f = census.feats.mints.get(rec.mint);
  let feat = null;
  let holders = null;
  let launcherSellSol = null;
  let launcherBuySol = null;
  if (f) {
    const full = buildFeatures(census.feats, rec.mint, {
      nowSec: sec,
      curve: curve ? { virtualSolReserves: curve.vSol, virtualTokenReserves: curve.vTok, realSolReserves: curve.realSol } : null,
    });
    feat = {};
    for (const [k, v] of Object.entries(full)) if (!FEAT_ROW_LEVEL.includes(k)) feat[k] = v;
    holders = 0;
    for (const w of f.wallets.values()) if (w.b > 0) holders += 1;
    if (rec.launcher) {
      const lw = f.wallets.get(rec.launcher);
      launcherSellSol = r4(lw ? lw.s : 0);
      launcherBuySol = r4(lw ? lw.b : 0);
    }
  }
  return {
    sec,
    secFromCreate: rec.createSec !== null ? sec - rec.createSec : null,
    fill,
    fillSource, // rev 3: "price" (realSol / 85) | "token" (tokenFill)
    price,
    lagSec: lag === null ? null : r1(lag),
    holders, // distinct wallets with a buy (the shadow lab's `holders`)
    launcherBuySol,
    launcherSellSol,
    launcherSold: launcherSellSol === null ? null : launcherSellSol > 0,
    feat,
    // post-milestone tracking (finalized in the row)
    minFillAfter: fill,
    minPriceAfter: price,
    minSecAfter: sec,
    stall: census.stallActive || undefined,
    gap: inGapWindow(census, nowMs) || undefined,
  };
}

// ---- finishing ------------------------------------------------------------------------------------
// final: "complete" | "idle" | "shutdown". Returns [census_mint row] or, with paths on and the
// threshold reached, [census_mint row, census_path row].
function finish(census, rec, final) {
  const row = rowOf(census, rec, final);
  const pRow = census.paths
    ? pathRow(census.paths, rec, final, { endSec: final === "complete" ? rec.lastSec ?? census.streamSec : census.streamSec, streamSec: census.pumpSec, censusRev: CENSUS_REV })
    : null;
  // Live-mint state is dropped with its row. An idle mint keeps only its small rec (for a resumed
  // row); its wallet map is gone, so a resumed row's flow features start again from zero.
  const f = census.feats.mints.get(rec.mint);
  rec.uniqueTradersPrev = (rec.uniqueTradersPrev || 0) + (f ? f.wallets.size : 0);
  census.live.delete(rec.mint);
  census.feats.mints.delete(rec.mint);
  census.counts.rows += 1;
  census.counts[row.full ? "full" : "compact"] += 1;
  if (final === "complete") {
    census.counts.migrated += 1;
    census.migrated.set(rec.mint, rec.lastSec ?? census.streamSec);
    if (census.pools) {
      const end = curveEndOf(rec);
      if (!end) {
        // another quote mint (or a mayhem curve never priced): no pool watch; a pending one is dropped
        census.pools.counts.poolSkipped += 1;
        if (rec.presubbed) dropPresub(census.pools, rec.mint);
      } else
        watchPool(census.pools, {
          mint: rec.mint,
          completeSec: rec.completeSec,
          curveEndPrice: end.price,
          curveEndSource: end.source,
          curveEndFill: end.fill,
          completeSeen: rec.completeSeen !== false,
          activatedSec: rec.activatedSec,
          launcher: rec.launcher,
          creator: rec.creator ?? f?.creator ?? null,
          stall: census.stallActive,
          gap: census.gap !== null || Date.now() <= census.gapUntilMs,
        });
    }
  } else {
    // #21b: the mint ended without completing -> its pending pool watch is dropped (no row)
    if (census.pools && rec.presubbed) {
      dropPresub(census.pools, rec.mint);
      rec.presubbed = false;
    }
    if (final === "idle") {
      census.counts.idle += 1;
      census.idled.set(rec.mint, rec);
    } else census.counts.shutdown += 1;
  }
  delete row.full;
  return pRow ? [row, pRow] : [row];
}

export function rowOf(census, rec, final) {
  // maxFill is unknown (null) for a mint that traded but never with a usable fill (neither the SOL
  // snapshot nor a standard token side; rev 3: the token side fills the "unpriced" other-quote
  // curves). A mint with no trade at all is at its launch fill, 0.
  const maxFill = rec.trades > 0 && rec.fillEvents === 0 ? null : rec.maxFill;
  const full = maxFill !== null && maxFill >= census.cfg.fullMinFill;
  const hourSec = rec.createSec ?? rec.firstSec;
  const f = census.feats.mints.get(rec.mint);
  const base = {
    type: "census_mint",
    censusRev: CENSUS_REV,
    mint: rec.mint,
    createSec: rec.createSec,
    createSeen: rec.createSeen,
    launcher: rec.launcher,
    isCreator: rec.isCreator,
    launches24h: rec.launches24h,
    devBuySol: rec.devBuySol,
    hourUtc: hourUtc(hourSec),
    maxFill,
    trades: rec.trades,
    // distinct wallets that traded; a resumed row adds the wallets of its earlier part (a wallet that
    // traded in both parts is counted twice)
    uniqueTraders: (rec.uniqueTradersPrev || 0) + (f ? f.wallets.size : 0),
    lastSec: rec.lastSec,
    final,
    maxLagSec: rec.maxLagSec,
  };
  const flags = {
    ...(final === "shutdown" ? { partial: true } : {}),
    ...(rec.stall ? { stall: true } : {}),
    ...(rec.resumed ? { resumed: true } : {}),
    ...(rec.gap ? { gap: true } : {}),
    ...(rec.tokenFillEvents > 0 ? { tokenFillEvents: rec.tokenFillEvents } : {}),
    mayhem: rec.mayhem, // #21e: true / false / null (rev-3 rows before #21e: true or absent)
    ...(rec.quoteMint ? { quoteMint: rec.quoteMint } : {}),
    ...(rec.completeSeen === false ? { completeSeen: false } : {}),
    ...(rec.unpricedTrades > 0
      ? { unpricedTrades: rec.unpricedTrades, unpricedLens: [...rec.unpricedLens].sort((a, b) => a - b), unpricedSample: rec.unpricedSample, unpricedTail: rec.unpricedTail }
      : {}),
  };
  if (!full) return { ...base, ...flags, full: false };
  const ms = {};
  for (const [k, s] of Object.entries(rec.milestones || {})) {
    const { minPriceAfter, stall, gap, ...rest } = s;
    ms[k] = {
      ...rest,
      ratioMinAfter: s.price > 0 && minPriceAfter > 0 ? r4(minPriceAfter / s.price) : null,
      secTo100: rec.completeSec !== null ? rec.completeSec - s.sec : null,
      ...(stall ? { stall: true } : {}),
      ...(gap ? { gap: true } : {}),
    };
  }
  return {
    ...base,
    name: rec.name,
    symbol: rec.symbol,
    creator: rec.creator ?? f?.creator ?? null,
    creatorSource: rec.createSeen ? "create" : f?.creatorSource ?? null,
    firstSec: rec.firstSec,
    firstSeenFill: rec.firstSeenFill,
    maxFillSec: rec.maxFillSec,
    migrated: final === "complete" ? true : final === "idle" ? false : null,
    completeSec: rec.completeSec,
    milestones: ms,
    ...flags,
    full: true,
  };
}

// Mints with no event for `idleSec` of STREAM time. Returns their rows.
export function sweepIdle(census) {
  const rows = [];
  const cut = census.streamSec - census.cfg.idleSec;
  for (const rec of [...census.live.values()]) {
    if (rec.lastSec !== null && rec.lastSec <= cut) rows.push(...finish(census, rec, "idle"));
  }
  return rows;
}

// The stop: a partial row for every live mint.
export function finishAll(census) {
  return [...census.live.values()].flatMap((rec) => finish(census, rec, "shutdown"));
}

// ---- PumpSwap pools (rev 2) ---------------------------------------------------------------------------
// Watches whose window ended or that went idle (the script calls this every second). Returns rows.
export function sweepPoolWatch(census) {
  return census.pools ? sweepPools(census.pools, census.streamSec) : [];
}

// The stop: a partial census_pool row for every pool still watched.
export function finishPoolsAtStop(census) {
  return census.pools ? finishAllPools(census.pools, census.streamSec) : [];
}

// One logsNotification of a pool subscription (mode a: `pool` = the subscription's pool) or of the
// whole PumpSwap program (mode b: `pool` null): `value.logs` and the signature; `failed` = the
// transaction failed (counted as traffic only). Buy/SellEvents and the CreatePoolEvent (#21b) of
// watched pools feed their watch; events of any other pool are ignored (counted: unknownPool).
// Traffic (#21b): mode a counts every notification of the pool's subscription, mode b every
// successful transaction holding an event of the pool. Returns finished rows.
// `slot`: the notification's context slot (#21e vault check).
export function handlePoolLogs(census, logs, { signature = null, nowMs = Date.now(), pool = null, failed = false, slot = null } = {}) {
  const pw = census.pools;
  if (!pw) return [];
  pw.counts.poolNotes += 1;
  let bytes = 0;
  let truncated = false;
  for (const line of logs) {
    if (typeof line !== "string") continue;
    bytes += line.length;
    if (line === "Log truncated") truncated = true;
  }
  pw.counts.poolLogBytes += bytes;
  if (failed) {
    pw.counts.poolFailedTx += 1;
    if (pool) notePoolTraffic(pw, pool, { failed, bytes, streamSec: census.streamSec });
    return [];
  }
  // Traffic is counted after the events (the notification holding the first trade belongs to t >= 0);
  // a notification that ends a watch (an event past its window) is not counted any more.
  const rows = [];
  const touched = new Set();
  const countTraffic = () => {
    for (const p of pool ? [pool] : touched) notePoolTraffic(pw, p, { bytes, streamSec: census.streamSec });
    return rows;
  };
  if (!firstSighting(pw, signature)) return countTraffic();
  if (truncated) notePoolTruncated(pw, pool, census.streamSec);
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
    let data;
    try {
      data = Buffer.from(line.slice(14), "base64");
    } catch {
      census.counts.parseErrors += 1;
      continue;
    }
    const ev = parsePumpSwapTrade(data);
    const cr = ev ? null : parsePumpSwapCreatePool(data);
    const evPool = ev?.pool ?? cr?.pool;
    if (!evPool) continue;
    if (!pw.byPool.has(evPool)) {
      pw.counts.unknownPool += 1;
      continue;
    }
    touched.add(evPool);
    const { sec } = eventSec(census, (ev ?? cr).timestampSec, nowMs, { pump: false });
    const w = pw.byPool.get(evPool);
    if (w.pending) rows.push(...activateNoComplete(census, w, { sec, createSec: cr ? sec : null }));
    if (cr) onPoolCreate(pw, cr, sec);
    else rows.push(...onPoolTrade(pw, ev, sec, slot));
  }
  return countTraffic();
}

// #21e: one accountNotification (base64) of a watched pool's base vault / quote vault / pool account
// (`kind` "base" | "quote" | "pool"). Size = the notification's JSON. Returns finished rows.
export function handlePoolAccount(census, result, { pool, kind }) {
  const pw = census.pools;
  if (!pw) return [];
  const raw = result?.value?.data;
  let data = null;
  try {
    if (Array.isArray(raw) && typeof raw[0] === "string") data = Buffer.from(raw[0], "base64");
  } catch {
    data = null;
  }
  let bytes = 0;
  try {
    bytes = JSON.stringify(result).length;
  } catch {
    bytes = 0;
  }
  const slot = Number.isFinite(result?.context?.slot) ? result.context.slot : null;
  return onVaultNote(pw, pool, kind, { data, slot, bytes, streamSec: census.streamSec });
}

// rev 3 (#21c): a pending (pre-subscribed) pool shows its own CreatePoolEvent or a trade while its
// mint's curve completion was not seen (a stream gap, a missed notification): the curve DID complete
// (a pool exists), so the mint is finished as migrated with `completeSeen: false` and the watch is
// activated (no more silent drop). completeSec = the CreatePoolEvent's second if this is it, else
// null; the curve end per curveEndOf. Returns the mint row.
function activateNoComplete(census, w, { sec, createSec }) {
  const rec = census.live.get(w.mint);
  if (!rec) return [];
  rec.completeSeen = false;
  rec.completeSec = createSec;
  rec.activatedSec = sec;
  return finish(census, rec, "complete");
}

// A process stall (gap between timer ticks). Every live mint is marked; mints that start while the
// stream is still draining the backlog (until `clearStall`) are marked too.
export function noteStall(census, gapMs, nowMs) {
  census.counts.stalls += 1;
  census.stallActive = true;
  for (const rec of census.live.values()) rec.stall = true;
  if (census.pools) markPools(census.pools, "stall");
  if (census.paths) stallHole(census.paths, census.lastTickPumpSec ?? census.pumpSec, gapMs / 1000);
  return { type: "census_stall", censusRev: CENSUS_REV, stallSec: Math.round(gapMs / 1000), liveMints: census.live.size, at: new Date(nowMs - gapMs).toISOString() };
}
export function clearStall(census) {
  census.stallActive = false;
}

// ---- stream gaps (#19b) -----------------------------------------------------------------------------
// lib/ws.mjs reconnects on its own; while the socket is down the census misses events (a milestone
// would be recorded at the next event, a mint created meanwhile would be createSeen: false). The
// script's 1 s timer calls checkGap: no create / trade event for `gapSec` opens a gap and flags every
// live mint; the next event closes it (handleLogs) and returns its census_gap row. Mints first seen,
// and milestone snapshots taken, within GAP_AFTER_MS after the close are flagged too. A process stall
// also looks like silence (the timer and the socket resume together), so it usually yields a gap row too.
export function inGapWindow(census, nowMs) {
  return census.gap !== null || (Number.isFinite(nowMs) && nowMs <= census.gapUntilMs);
}

export function checkGap(census, nowMs, gapSec = DEFAULT_GAP_SEC) {
  census.lastTickPumpSec = census.pumpSec; // #24: where a stall hole found at the next tick starts
  if (census.gap !== null || census.lastEventMs === null) return false;
  if (nowMs - census.lastEventMs < gapSec * 1000) return false;
  census.gap = { startedAtMs: census.lastEventMs, liveMints: census.live.size, hole: census.paths ? openGapHole(census.paths, census.pumpSec) : null };
  for (const rec of census.live.values()) rec.gap = true;
  if (census.pools) markPools(census.pools, "gap");
  return true;
}

function gapRow(census, endMs, extra = {}) {
  const g = census.gap;
  const gapSec = r1((endMs - g.startedAtMs) / 1000);
  census.gap = null;
  // #24: the path hole stays open until the closing event's second is known (handleLogs); at the stop
  // it ends at its start + the silence
  if (g.hole) {
    if (extra.openAtStop) closeHole(g.hole, g.hole.from + Math.ceil(gapSec));
    else census.openHole = g.hole;
  }
  census.gapUntilMs = endMs + GAP_AFTER_MS;
  census.counts.gaps += 1;
  census.counts.gapSecTotal = r1(census.counts.gapSecTotal + gapSec);
  return { type: "census_gap", censusRev: CENSUS_REV, startedAt: new Date(g.startedAtMs).toISOString(), endedAt: new Date(endMs).toISOString(), gapSec, liveMints: g.liveMints, ...extra };
}

// A create / trade event arrived at `nowMs`: closes an open gap (returns its row) and restarts the clock.
export function noteEvent(census, nowMs) {
  const row = census.gap !== null ? gapRow(census, nowMs) : null;
  census.lastEventMs = nowMs;
  return row;
}

// #24: the first event after a gap set the stream clock: the gap's path hole ends there.
function closeOpenHole(census) {
  closeHole(census.openHole, census.pumpSec);
  census.openHole = null;
}

// The stop with the stream still silent: the gap row is written with `openAtStop: true`.
export function closeGapAtStop(census, nowMs) {
  return census.gap !== null ? gapRow(census, nowMs, { openAtStop: true }) : null;
}

// Bounded memory: the 24 h launcher index and the feature store's creator / name indexes are trimmed
// by on-chain age; idle mints are forgotten after RESUME_WINDOW_SEC; per-mint feature state of a
// mint that is not live (it should not exist: finish() drops it) is evicted after 2 x idleSec.
export function housekeeping(census, nowMs) {
  const sec = census.streamSec || Math.floor(nowMs / 1000);
  trimLaunchers(census.launches, sec);
  trimIndexes(census.feats, sec);
  const cut = sec - RESUME_WINDOW_SEC;
  for (const [mint, rec] of census.idled) if ((rec.lastSec ?? 0) <= cut) census.idled.delete(mint);
  for (const [mint, s] of census.migrated) if (s <= cut) census.migrated.delete(mint);
  evictIdle(census.feats, nowMs, new Set(census.live.keys()), census.cfg.idleSec * 2000);
  if (census.paths) trimHoles(census.paths, sec);
}

export function memRow(census, nowMs, extra = {}) {
  const m = process.memoryUsage();
  return {
    type: "census_mem",
    censusRev: CENSUS_REV,
    upSec: Math.round((nowMs - census.startedAtMs) / 1000),
    liveMints: census.live.size,
    idledMints: census.idled.size,
    migratedMints: census.migrated.size,
    ...storeStats(census.feats),
    ...launcherStats(census.launches),
    ...census.counts,
    unpricedByLen: { ...census.unpricedByLen },
    ...(census.pools ? poolStats(census.pools) : { poolMode: "off" }),
    ...(census.paths ? pathStats(census.paths) : {}),
    ...extra,
    rssMB: Math.round(m.rss / 1048576),
    heapMB: Math.round(m.heapUsed / 1048576),
  };
}

// ---- stream ---------------------------------------------------------------------------------------
// One logsNotification's `value.logs` (the caller already dropped failed transactions). Every
// create / trade event of the transaction is processed, in log order. Returns finished rows.
export function handleLogs(census, logs, { slot = null, nowMs = Date.now() } = {}) {
  const rows = [];
  // rev 3: the validator cut the transaction's logs: events after the cut never reach the stream
  if (logs.includes("Log truncated")) census.counts.logTruncated += 1;
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
    let data;
    try {
      data = Buffer.from(line.slice(14), "base64");
    } catch {
      census.counts.parseErrors += 1;
      continue;
    }
    if (data.length < 8) continue;
    const t = parseTrade(data);
    if (t) {
      const g = noteEvent(census, nowMs);
      if (g) rows.push(g);
      rows.push(...onTrade(census, t, { slot, nowMs, creatorOf: () => tradeCreator(data), raw: data }));
      if (census.openHole) closeOpenHole(census);
      continue;
    }
    const c = parseCreate(data);
    if (c) {
      const g = noteEvent(census, nowMs);
      if (g) rows.push(g);
      onCreate(census, c, { slot, nowMs });
      if (census.openHole) closeOpenHole(census);
    }
  }
  return rows;
}

// ---- output ---------------------------------------------------------------------------------------
// data/census/census-YYYY-MM-DD.jsonl, by the UTC date of the WRITE (rolls over at 00:00 UTC).
export function censusFileName(ms) {
  return `census-${new Date(ms).toISOString().slice(0, 10)}.jsonl`;
}

// Append-only writer. Never throws (a full disk must not kill the recorder): the first error is
// reported through `onError` and writing stops.
export function createWriter(dir, { now = () => Date.now(), onError = () => {} } = {}) {
  let enabled = true;
  let written = 0;
  let bytes = 0;
  return {
    file: (ms = now()) => path.join(dir, censusFileName(ms)),
    write(row) {
      if (!enabled) return false;
      try {
        const ms = now();
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ts: new Date(ms).toISOString(), ...row }) + "\n";
        fs.appendFileSync(path.join(dir, censusFileName(ms)), line);
        written += 1;
        bytes += Buffer.byteLength(line);
        return true;
      } catch (e) {
        enabled = false;
        onError(e);
        return false;
      }
    },
    get written() {
      return written;
    },
    get bytes() {
      return bytes;
    },
  };
}

// ---- instance lock --------------------------------------------------------------------------------
// One census per data directory (it may run beside a shadow lab: different lock, different files).
// The lock holds our PID; a lock whose PID is dead (or garbage) is taken over.
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}
export function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { ok: true };
  } catch (e) {
    if (e.code !== "EEXIST") return { ok: true, warning: `could not create the lock: ${e.message}` };
  }
  const pid = Number(fs.readFileSync(lockPath, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) return { ok: false, pid };
  fs.writeFileSync(lockPath, String(process.pid));
  return { ok: true };
}
export function releaseLock(lockPath) {
  try {
    if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}
