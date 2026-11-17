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
import fs from "node:fs";
import path from "node:path";
import { gradFillPct } from "./curve.mjs";
import { parseCreate, parseTrade, tradeCreator } from "./events.mjs";
import { parsePumpSwapCreatePool, parsePumpSwapTrade } from "./pumpswap-stream.mjs";
import {
  DEFAULT_POOL_WATCH_SEC,
  DEFAULT_PRESUB_FILL,
  dropPresub,
  notePoolTraffic,
  onPoolCreate,
  presubPool,
  createPoolWatch,
  finishAllPools,
  firstSighting,
  markPools,
  onPoolTrade,
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

export const CENSUS_REV = 2;
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
export function createCensus({ milestones = DEFAULT_MILESTONES, idleSec = DEFAULT_IDLE_SEC, fullMinFill = DEFAULT_FULL_MIN_FILL, startedAtMs = Date.now(), pool = true, poolWatchSec = DEFAULT_POOL_WATCH_SEC, poolMode = "a", poolPresubFill = DEFAULT_PRESUB_FILL } = {}) {
  return {
    cfg: { milestones: [...milestones], idleSec, fullMinFill },
    // PumpSwap pool watches after a completion (rev 2); null = CENSUS_POOL=0 (rev-1 behaviour).
    pools: pool ? createPoolWatch({ rev: CENSUS_REV, watchSec: poolWatchSec, idleSec, mode: poolMode, presubFill: poolPresubFill }) : null,
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
    counts: { rows: 0, full: 0, compact: 0, migrated: 0, idle: 0, shutdown: 0, resumed: 0, creates: 0, trades: 0, unpriced: 0, afterComplete: 0, bogusTs: 0, stalls: 0, gaps: 0, gapSecTotal: 0, parseErrors: 0 },
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
    unpricedTrades: 0, // trades whose payload carries no reserve snapshot (fill unknown at that event)
    unpricedLens: null, // distinct payload lengths of those events (at most UNPRICED_LENS_MAX)
    unpricedSample: null, // first unpriced event: bytes 8..24 (after the discriminator), hex
    unpricedTail: null, // first unpriced event: bytes 89..129 (timestamp + the four reserve fields), hex
    lastSec: null,
    maxLagSec: null,
    completeSec: null,
    curveEndPrice: null, // the curve price at the completing event (the pool path is measured against it)
    milestones: null, // { "25": snapshot, ... } — created on the first crossing
    stall: false,
    gap: false,
    resumed: false,
  };
}

// The on-chain second to use for an event: its own when plausible, else the local clock.
function eventSec(census, sec, nowMs) {
  const local = Math.floor(nowMs / 1000);
  const s = Number(sec);
  if (Number.isFinite(s) && s > local - PLAUSIBLE_PAST_SEC && s < local + PLAUSIBLE_FUTURE_SEC) {
    if (s > census.streamSec) census.streamSec = s;
    return { sec: s, lag: (nowMs / 1000) - s };
  }
  census.counts.bogusTs += 1;
  if (local > census.streamSec) census.streamSec = local;
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

// A parsed trade-v3 event (lib/events.mjs parseTrade). `creatorOf`: lazy reader of the payload's
// creator field (feature store fallback when the create was not seen). Returns finished rows.
// `raw`: the payload buffer (only read for an event without reserves: unpricedSample / unpricedTail).
export function onTrade(census, t, { slot = null, nowMs = Date.now(), creatorOf = null, raw = null } = {}) {
  if (!t || !t.mint) return [];
  census.counts.trades += 1;
  const rec = recFor(census, t.mint, nowMs);
  if (!rec) {
    census.counts.afterComplete += 1;
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

  // Fill: only from a payload that carries the reserve snapshot (401-byte payloads carry zeros).
  const res = t.reserves;
  const priced = !!(res && res.usable && res.realSol !== null && res.realSol !== undefined);
  const fill = priced ? r2(gradFillPct(res.realSol)) : null;
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
    return [];
  }
  const price = sig((Number(res.vSol) / Number(res.vTok)) * 1e-3);
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
      if (fill < s.minFillAfter) {
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
    rec.milestones[key] = snapshot(census, rec, { sec, fill, price, lag, curve: res, nowMs });
  }
  // #21b: subscribe the mint's (future) PumpSwap pool once its fill reaches the pre-subscription fill
  if (census.pools && !rec.presubbed && fill >= census.pools.cfg.presubFill && census.pools.cfg.presubFill < 100) {
    rec.presubbed = true;
    presubPool(census.pools, { mint: rec.mint, stall: census.stallActive, gap: inGapWindow(census, nowMs) });
  }
  if (fill >= 100) {
    rec.completeSec = sec;
    rec.curveEndPrice = price;
    return [finish(census, rec, "complete")];
  }
  return [];
}

function snapshot(census, rec, { sec, fill, price, lag, curve, nowMs }) {
  const f = census.feats.mints.get(rec.mint);
  let feat = null;
  let holders = null;
  let launcherSellSol = null;
  let launcherBuySol = null;
  if (f) {
    const full = buildFeatures(census.feats, rec.mint, {
      nowSec: sec,
      curve: { virtualSolReserves: curve.vSol, virtualTokenReserves: curve.vTok, realSolReserves: curve.realSol },
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
// final: "complete" | "idle" | "shutdown".
function finish(census, rec, final) {
  const row = rowOf(census, rec, final);
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
      watchPool(census.pools, {
        mint: rec.mint,
        completeSec: rec.completeSec,
        curveEndPrice: rec.curveEndPrice,
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
  return row;
}

export function rowOf(census, rec, final) {
  // maxFill is unknown (null) for a mint that traded but never with a reserve snapshot: some mints'
  // events all carry zero reserves (~9 % of trade events, measured 2026-11-15) — not a dead curve.
  // A mint with no trade at all is at its launch fill, 0.
  const pricedTrades = rec.trades - rec.unpricedTrades;
  const maxFill = rec.trades > 0 && pricedTrades === 0 ? null : rec.maxFill;
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
      ratioMinAfter: s.price > 0 ? r4(minPriceAfter / s.price) : null,
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
    if (rec.lastSec !== null && rec.lastSec <= cut) rows.push(finish(census, rec, "idle"));
  }
  return rows;
}

// The stop: a partial row for every live mint.
export function finishAll(census) {
  return [...census.live.values()].map((rec) => finish(census, rec, "shutdown"));
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
export function handlePoolLogs(census, logs, { signature = null, nowMs = Date.now(), pool = null, failed = false } = {}) {
  const pw = census.pools;
  if (!pw) return [];
  pw.counts.poolNotes += 1;
  let bytes = 0;
  for (const line of logs) if (typeof line === "string") bytes += line.length;
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
    const { sec } = eventSec(census, (ev ?? cr).timestampSec, nowMs);
    if (cr) onPoolCreate(pw, cr, sec);
    else rows.push(...onPoolTrade(pw, ev, sec));
  }
  return countTraffic();
}

// A process stall (gap between timer ticks). Every live mint is marked; mints that start while the
// stream is still draining the backlog (until `clearStall`) are marked too.
export function noteStall(census, gapMs, nowMs) {
  census.counts.stalls += 1;
  census.stallActive = true;
  for (const rec of census.live.values()) rec.stall = true;
  if (census.pools) markPools(census.pools, "stall");
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
  if (census.gap !== null || census.lastEventMs === null) return false;
  if (nowMs - census.lastEventMs < gapSec * 1000) return false;
  census.gap = { startedAtMs: census.lastEventMs, liveMints: census.live.size };
  for (const rec of census.live.values()) rec.gap = true;
  if (census.pools) markPools(census.pools, "gap");
  return true;
}

function gapRow(census, endMs, extra = {}) {
  const g = census.gap;
  const gapSec = r1((endMs - g.startedAtMs) / 1000);
  census.gap = null;
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
      continue;
    }
    const c = parseCreate(data);
    if (c) {
      const g = noteEvent(census, nowMs);
      if (g) rows.push(g);
      onCreate(census, c, { slot, nowMs });
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
