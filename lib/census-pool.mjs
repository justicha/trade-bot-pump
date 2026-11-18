// Mint census rev 2 (KODING #21, #21b): the PumpSwap pool price path after a migration.
//
// Research only, zero RPC: the input is the pool's own events from the log stream
// (lib/pumpswap-stream.mjs decodes them), the output is ONE `census_pool` row per mint whose curve
// completion the census saw. Mints first seen already in the pool are out of scope.
//
// Per watched pool (canonicalPool(mint), a pure PDA):
//   - #21b pre-subscription: the pool is subscribed (mode a) as soon as the mint's fill first reaches
//     CENSUS_POOL_PRESUB_FILL (92), long before the pool exists, so the migration transaction (its
//     CreatePoolEvent = the pool's opening reserves) and the very first pool trades are caught. Until
//     the curve completes the watch is "pending": pool events are kept, no row. A mint that finishes
//     without completing (idle / shutdown) drops its pending watch (no row, poolPresubDropped).
//   - prices from the event itself: before the trade = (quote vault + virtual quote reserves) / base
//     vault, after the trade = the same after the trade's amounts (lib/pumpswap-stream.mjs
//     poolTradePrices) — SOL per token, the unit of the census curve prices;
//   - t = 0 is the FIRST pool TRADE; ratio at 10 s, 30 s, 1 m, 3 m, 5 m, 15 m, 30 m, 60 m = the last
//     price at or before t / the curve's last price (null if the watch did not reach t);
//   - min / max ratio and their second in [0, 1 m], [0, 5 m], [0, watch];
//   - flows in the first 1 m / 5 m / whole watch; launcher's / creator's pool sells in 5 m; the
//     largest sell in 3 m; the quote reserve (real SOL in the vault) at the first event and at the end;
//   - the pool open (CreatePoolEvent) when it was seen: open second, open price, open / curve ratio;
//   - traffic: notifications, failed ones and log KB of this pool's subscription, also per window.
// Aggregates keep raw prices (the curve's last price is unknown while a watch is pending); ratios
// are made when the row is written.
// The watch ends CENSUS_POOL_WATCH_SEC (on-chain seconds) after the first pool trade, earlier after
// CENSUS_IDLE_SEC without a pool event (stream time), or at the stop (partial).
// Memory per pool: running aggregates plus the set of trader wallets (O(traders in the watch)).
// Rev 3 (#21c): a pending watch can be activated by its own pool event without the curve completion
// (completeSeen: false; lib/mint-census.mjs handlePoolLogs); curveEndSource says where the curve end
// came from; poolOdd flags an opening jump / logs cut at the open; the virtual quote reserves are signed.
//
// Rev 3.1 (#21e) — traffic budget (one hot pool sent 900 MB of logs in its hour, KODING_REPORT_21c):
//   phase 1 "logs" (as before) until min(first pool trade + CENSUS_POOL_LOGS_SEC, the moment the
//   pool's log bytes pass CENSUS_POOL_LOGS_MB); then phase 2 "vaults" until the end of the window: the
//   logs subscription is dropped and the price follows three accountSubscribe (base64): the base vault,
//   the quote vault and the pool account (its signed virtual quote reserves). A slot's price =
//   (quote vault + virtual) / base vault once both vaults of that slot have arrived (both move on every
//   trade); the virtual is the pool account's last value, else the last trade event's. Failed
//   transactions change no account, so they cost nothing in phase 2. Phase 2 keeps min / max /
//   checkpoint ratios; flows, traders, launcher / creator sells and the largest sell come from phase 1
//   only: a fixed window (1 m / 3 m / 5 m) that phase 1 did not cover is null, flowAll covers phase 1
//   (row: logsUntilSec, logsCutReason, phase2). Mode b (one program subscription) has no per-pool cut.
//   CENSUS_POOL_VAULT_CHECK=1 subscribes the vaults already at the first pool trade and compares the
//   vault price of each slot with the trade event that left the pool in the same state (the same base
//   vault): the phase-2 price error, per row and in census_mem.
import { PublicKey } from "@solana/web3.js";
import { canonicalPool, poolAccountVirtual, poolTradePrices, poolVaults, quotePerBase, tokenAccountAmount } from "./pumpswap-stream.mjs";

export const DEFAULT_POOL_WATCH_SEC = 3600;
export const DEFAULT_PRESUB_FILL = 92;
export const DEFAULT_POOL_LOGS_SEC = 900;
export const DEFAULT_POOL_LOGS_MB = 40;
const CHECK_SLOTS = 150; // vault-check: slots of state kept per pool for the matching (~1 min)
const CHECK_ERRS_MAX = 200_000; // vault-check: relative errors kept for the census_mem percentiles
export const POOL_CHECKPOINTS = [
  [10, "ratio10s"],
  [30, "ratio30s"],
  [60, "ratio1m"],
  [180, "ratio3m"],
  [300, "ratio5m"],
  [900, "ratio15m"],
  [1800, "ratio30m"],
  [3600, "ratio60m"],
];
const W1 = 60;
const W3 = 180;
const W5 = 300;
// Traffic windows (seconds from the first pool trade): before it, [0, 5 m), [5 m, 15 m), [15 m, 60 m).
const TRAFFIC_WINDOWS = [
  ["pre", -Infinity, 0],
  ["m0_5", 0, 300],
  ["m5_15", 300, 900],
  ["m15_60", 900, Infinity],
];
// The stream clock (pump events) runs ahead of an in-flight pool notification by ~1 s: the watch
// ends this many seconds after its last second so the last pool events still count.
export const POOL_END_SLACK_SEC = 5;
const SIG_KEEP = 20_000; // signatures remembered for the cross-subscription dedupe

const r1 = (x) => Math.round(x * 10) / 10;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sig6 = (x) => (x > 0 ? Number(x.toPrecision(6)) : x);
const sol = (lamports) => r4(Number(lamports) / 1e9);

export function createPoolWatch({ rev, watchSec = DEFAULT_POOL_WATCH_SEC, idleSec, mode = "a", presubFill = DEFAULT_PRESUB_FILL, logsSec = DEFAULT_POOL_LOGS_SEC, logsMB = DEFAULT_POOL_LOGS_MB, vaults = true, vaultCheck = false }) {
  return {
    cfg: { rev, watchSec, idleSec, presubFill, logsSec, logsMB, logsBytes: logsMB * 1048576, vaults, vaultCheck: vaults && vaultCheck },
    mode, // "a" one subscription per pool | "b" one on the whole PumpSwap program
    byPool: new Map(), // pool -> watch state (pending or active)
    seen: new Set(), // signatures already processed (a tx can reach us through two subscriptions)
    seenOrder: [],
    checkErrs: [], // #21e vault check: relative price errors (bounded)
    counts: {
      poolWatched: 0,
      poolRows: 0,
      poolEvents: 0,
      unknownPool: 0,
      poolUnpriced: 0,
      poolAfterEnd: 0,
      poolDup: 0,
      poolFailedTx: 0,
      poolNotes: 0,
      poolLogBytes: 0,
      poolPresubs: 0,
      poolPresubDropped: 0,
      poolPresubDroppedTraded: 0, // dropped although pool trades had arrived (the completion was missed)
      poolOpens: 0,
      poolActivatedNoComplete: 0, // #21c: a pending watch activated by its own pool event (completion not seen)
      poolLateComplete: 0, // #21c: ... whose curve completion arrived after that activation
      poolLogTruncated: 0, // #21c: pool notifications whose logs end with "Log truncated" (events lost)
      poolSkipped: 0, // #21c: completions with no pool watch (a curve quoted in another mint; no curve end)
      poolLogsCutTime: 0, // #21e: phase 1 ended by CENSUS_POOL_LOGS_SEC
      poolLogsCutBytes: 0, // #21e: phase 1 ended by CENSUS_POOL_LOGS_MB
      poolAfterCut: 0, // #21e: pool events of a pool already in phase 2 (in flight / mode b), ignored
      vaultNotes: 0, // #21e: account notifications of the vaults / pool accounts
      vaultBytes: 0,
      vaultPrices: 0, // slots priced from the vaults
      vaultBadData: 0,
      vaultUnknown: 0, // notifications of a pool no longer watched
      vaultSubRejected: 0,
      vaultCheckPairs: 0, // vault-check: vault slots compared with a trade event
      vaultCheckUnmatched: 0, // vault-check: vault slots with trade events of the slot but none of the same base
      vaultCheckVirtualDiff: 0, // vault-check: the virtual used differs from the matched event's
    },
    // Set by the subscriber (attachPoolStream); no-ops in the pure tests.
    hooks: { watch: () => {}, unwatch: () => {}, watchVaults: () => {}, unwatchVaults: () => {} },
  };
}

const newFlow = () => ({ trades: 0, buys: 0, sells: 0, buySol: 0, sellSol: 0, uniqueTraders: 0 });
const newMm = () => ({ min: null, minSec: null, max: null, maxSec: null });
const newTraffic = () => Object.fromEntries(TRAFFIC_WINDOWS.map(([k]) => [k, { notes: 0, failedNotes: 0, logBytes: 0 }]));

function newWatch(mint, pool) {
  return {
    mint,
    pool,
    pending: true,
    completeSec: null,
    completeSeen: null, // #21c: false = activated by its own pool event, the curve completion was not seen
    activatedSec: null, // the second the watch became active (the completion, else the activating event)
    curveEndPrice: null,
    curveEndSource: null, // #21c: "price" | "standard" | "lastPrice"
    curveEndFill: null, // #21c: the fill at the "lastPrice" curve end
    launcher: null,
    creator: null,
    openSec: null, // CreatePoolEvent
    openBase: null,
    openQuote: null,
    openMayhem: null,
    firstSec: null,
    firstPrice: null,
    firstVirtual: null,
    firstBase: null,
    firstQuote: null,
    quoteAtFirst: null,
    lastSec: null,
    lastPrice: null,
    lastQuote: null,
    cps: {}, // checkpoint key -> price (settled)
    mm1: newMm(),
    mm5: newMm(),
    mmAll: newMm(),
    f1: newFlow(),
    f5: newFlow(),
    fAll: newFlow(),
    users: new Set(),
    launcherSell: 0,
    creatorSell: 0,
    largestSell: null, // { sol, wallet, sec } in the first 3 m
    events: 0,
    unpriced: 0,
    traffic: newTraffic(),
    truncatedNotes: 0,
    stall: false,
    gap: false,
    // #21e
    phase: 1, // 1 logs | 2 vaults
    logBytes: 0, // log bytes of this pool's subscription so far (every window)
    logsUntilSec: null, // seconds from the first pool trade when phase 1 ended (null: never cut)
    logsCutReason: null, // "time" | "bytes"
    lastVirtual: null, // the last trade event's signed virtual quote reserves
    vault: null, // vault state once the vaults are subscribed (newVault)
  };
}

function newVault(w) {
  const { baseVault, quoteVault } = poolVaults(w.mint, w.pool);
  return {
    baseVault,
    quoteVault,
    base: null, // { amt, slot }
    quote: null,
    virt: w.lastVirtual, // the last known virtual: the pool account's once it notifies
    virtSource: w.lastVirtual === null ? null : "event",
    virtChanges: 0, // pool-account notifications with a new virtual value
    pricedSlot: null,
    notes: { base: 0, quote: 0, pool: 0 },
    bytes: 0,
    p2Notes: 0, // notifications in phase 2 (in check mode the vaults run in phase 1 too)
    p2Bytes: 0,
    prices: 0, // slots priced in phase 2
    // vault check: slot -> trade events' state after the trade / slot -> the vault price of the slot
    evBySlot: new Map(),
    vpBySlot: new Map(),
    errs: [],
    pairs: 0,
    unmatched: 0,
  };
}

// #21e: phase 1 -> 2 is possible for an active watch whose first pool trade was seen, in mode a.
function canCut(pw, w) {
  return pw.cfg.vaults && pw.mode === "a" && !w.pending && w.firstSec !== null && w.phase === 1;
}

function startVaults(pw, w) {
  if (w.vault) return;
  try {
    w.vault = newVault(w);
  } catch {
    return; // not a valid key (never for a watched pool)
  }
  try {
    pw.hooks.watchVaults(w);
  } catch {
    /* the subscriber logs its own errors */
  }
}

// #21e: end phase 1 — drop the pool's logs subscription, follow its vaults.
export function cutLogs(pw, w, reason, streamSec) {
  if (!canCut(pw, w)) return false;
  w.phase = 2;
  w.logsCutReason = reason;
  w.logsUntilSec = Math.max(0, streamSec - w.firstSec);
  pw.counts[reason === "time" ? "poolLogsCutTime" : "poolLogsCutBytes"] += 1;
  try {
    pw.hooks.unwatch(w.pool);
  } catch {
    /* the subscriber logs its own errors */
  }
  startVaults(pw, w);
  return true;
}

function poolOf(mint) {
  try {
    return canonicalPool(new PublicKey(mint)).toBase58();
  } catch {
    return null;
  }
}

function subscribe(pw, w) {
  pw.byPool.set(w.pool, w);
  try {
    pw.hooks.watch(w.pool);
  } catch {
    /* the subscriber logs its own errors */
  }
}

function unsubscribe(pw, w) {
  pw.byPool.delete(w.pool);
  try {
    pw.hooks.unwatch(w.pool);
  } catch {
    /* the subscriber logs its own errors */
  }
  try {
    if (w.vault) pw.hooks.unwatchVaults(w.pool);
  } catch {
    /* the subscriber logs its own errors */
  }
}

// #21b: the mint's fill reached presubFill — subscribe its (future) pool now. Returns the pool, or
// null (already watched, not a valid mint, or pre-subscription off: presubFill >= 100).
export function presubPool(pw, { mint, stall = false, gap = false }) {
  if (pw.cfg.presubFill >= 100) return null;
  const pool = poolOf(mint);
  if (!pool || pw.byPool.has(pool)) return null;
  const w = newWatch(mint, pool);
  w.stall = stall;
  w.gap = gap;
  pw.counts.poolPresubs += 1;
  subscribe(pw, w);
  return pool;
}

// #21b: the mint finished without completing (its idle / shutdown row): drop its pending watch.
export function dropPresub(pw, mint) {
  const pool = poolOf(mint);
  const w = pool && pw.byPool.get(pool);
  if (!w || !w.pending) return false;
  pw.counts.poolPresubDropped += 1;
  if (w.events > 0) pw.counts.poolPresubDroppedTraded += 1;
  unsubscribe(pw, w);
  return true;
}

// The curve completed: the pending watch (or a new one) becomes active. Returns the pool address, or
// null (no price to compare with, or not a valid mint).
// #21c: `completeSeen: false` = the census did not see the completion; the watch is activated by its
// own pool event at `activatedSec` (completeSec = the CreatePoolEvent time if seen, else null).
export function watchPool(pw, { mint, completeSec, curveEndPrice, curveEndSource = "price", curveEndFill = null, completeSeen = true, activatedSec = null, launcher = null, creator = null, stall = false, gap = false }) {
  if (!(curveEndPrice > 0)) return null;
  const pool = poolOf(mint);
  if (!pool) return null;
  let w = pw.byPool.get(pool);
  if (w && !w.pending) return pool;
  const fresh = !w;
  if (fresh) w = newWatch(mint, pool);
  w.pending = false;
  w.completeSec = completeSec;
  w.completeSeen = completeSeen;
  w.activatedSec = activatedSec ?? completeSec;
  w.curveEndPrice = curveEndPrice;
  w.curveEndSource = curveEndSource;
  w.curveEndFill = curveEndFill;
  if (!completeSeen) pw.counts.poolActivatedNoComplete += 1;
  w.launcher = launcher;
  w.creator = creator;
  w.stall = w.stall || stall;
  w.gap = w.gap || gap;
  pw.counts.poolWatched += 1;
  if (fresh) subscribe(pw, w);
  return pool;
}

// #21c: the pool watch of `mint` when it is active and was activated without its curve completion
// (null otherwise) — for a completion that arrives late (the pump and pool subscriptions are separate
// streams: their notifications of one slot can come in either order).
export function noCompleteWatch(pw, mint) {
  const pool = poolOf(mint);
  const w = pool && pw.byPool.get(pool);
  return w && !w.pending && w.completeSeen === false ? w : null;
}

// #21c: that late completion: the curve end and the completion second become the real ones.
export function lateComplete(pw, w, { completeSec, curveEndPrice }) {
  w.completeSeen = true;
  w.lateComplete = true;
  w.completeSec = completeSec;
  if (curveEndPrice > 0) {
    w.curveEndPrice = curveEndPrice;
    w.curveEndSource = "price";
    w.curveEndFill = null;
  }
  pw.counts.poolLateComplete += 1;
}

// #21c: one pool notification whose logs were cut by the validator ("Log truncated"): the events after
// the cut (e.g. buys bundled into the migration transaction itself) never reach the stream.
// Only a cut at the open (before the first pool trade, or within OPEN_TRUNC_SEC of it) makes the row
// odd: in a busy pool cut logs are routine later on (live 2026-11-17: 21 of 47 pools had some).
export const OPEN_TRUNC_SEC = 10;
export function notePoolTruncated(pw, pool, streamSec = null) {
  pw.counts.poolLogTruncated += 1;
  const w = pool && pw.byPool.get(pool);
  if (!w) return;
  w.truncatedNotes += 1;
  if (w.firstSec === null || (streamSec !== null && streamSec - w.firstSec <= OPEN_TRUNC_SEC)) w.truncatedAtOpen = true;
}

function noteMm(mm, price, rel) {
  if (mm.min === null || price < mm.min) {
    mm.min = price;
    mm.minSec = rel;
  }
  if (mm.max === null || price > mm.max) {
    mm.max = price;
    mm.maxSec = rel;
  }
}

function notePrice(w, price, rel) {
  w.lastPrice = price;
  if (rel <= W1) noteMm(w.mm1, price, rel);
  if (rel <= W5) noteMm(w.mm5, price, rel);
  noteMm(w.mmAll, price, rel);
}

// Checkpoints whose second is strictly before `sec` take the last price now (an event exactly at
// first + t still belongs to t).
function settle(w, sec, watchSec) {
  for (const [t, key] of POOL_CHECKPOINTS) {
    if (t > watchSec || key in w.cps) continue;
    if (w.firstSec + t < sec) w.cps[key] = w.lastPrice;
  }
}

// #21b: a CreatePoolEvent (lib/pumpswap-stream.mjs parsePumpSwapCreatePool) of a watched pool.
export function onPoolCreate(pw, ev, sec) {
  const w = pw.byPool.get(ev.pool);
  if (!w) {
    pw.counts.unknownPool += 1;
    return;
  }
  if (w.openSec !== null) return;
  pw.counts.poolOpens += 1;
  w.openSec = sec;
  w.openBase = ev.poolBase;
  w.openQuote = ev.poolQuote;
  w.openMayhem = ev.isMayhem;
}

// One decoded pool trade (lib/pumpswap-stream.mjs parsePumpSwapTrade) of a watched pool at on-chain
// second `sec`. Returns finished rows (an event past the watch window ends an active watch first).
// `slot`: the notification's context slot (#21e vault check only).
export function onPoolTrade(pw, ev, sec, slot = null) {
  const w = pw.byPool.get(ev.pool);
  if (!w) {
    pw.counts.unknownPool += 1;
    return [];
  }
  if (w.phase === 2) {
    // #21e: the vaults drive the price now (a notification in flight at the cut, or mode b)
    pw.counts.poolAfterCut += 1;
    return [];
  }
  const { watchSec } = pw.cfg;
  let s = sec;
  if (w.lastSec !== null && s < w.lastSec) s = w.lastSec; // notifications may arrive slightly out of order
  if (!w.pending && w.firstSec !== null && s > w.firstSec + watchSec) {
    pw.counts.poolAfterEnd += 1;
    return [finishPool(pw, w, "watch", w.firstSec + watchSec)];
  }
  pw.counts.poolEvents += 1;
  w.events += 1;
  const p = poolTradePrices(ev);
  if (w.firstSec === null) {
    w.firstSec = s;
    w.quoteAtFirst = sol(ev.poolQuote);
    w.firstBase = ev.poolBase;
    w.firstQuote = ev.poolQuote;
    w.firstVirtual = ev.virtualQuote;
    if (p) {
      w.firstPrice = p.before;
      notePrice(w, p.before, 0);
    }
  }
  const rel = s - w.firstSec;
  // The reserves BEFORE this trade are the exact pool state since the previous event: the previous
  // event's computed "after" misses the coin-creator + buyback fees that some pools keep in the quote
  // vault (~20 % of consecutive pairs on the live stream, KODING_REPORT_21; base side always exact).
  if (p) w.lastPrice = p.before;
  settle(w, s, watchSec);
  if (p) {
    notePrice(w, p.after, rel);
    w.lastQuote = sol(p.quoteAfter);
  } else {
    w.unpriced += 1;
    pw.counts.poolUnpriced += 1;
  }
  w.lastSec = s;
  // #21e: the last known virtual (phase 2 starts from it); the vault check from the first trade on
  if (ev.virtualQuote !== null) {
    w.lastVirtual = ev.virtualQuote;
    if (w.vault && w.vault.virtSource !== "account") {
      w.vault.virt = ev.virtualQuote;
      w.vault.virtSource = "event";
    }
  }
  if (pw.cfg.vaultCheck && canCut(pw, w)) startVaults(pw, w);
  if (w.vault && p && slot !== null) checkEvent(pw, w, slot, { base: p.baseAfter, price: p.after, virt: ev.virtualQuote });

  // flows
  const amt = Number(ev.userQuote) / 1e9;
  const isBuy = ev.side === "buy";
  const newUser = !w.users.has(ev.user);
  if (newUser) w.users.add(ev.user);
  for (const [f, lim] of [[w.f1, W1], [w.f5, W5], [w.fAll, Infinity]]) {
    if (rel > lim) continue;
    f.trades += 1;
    if (isBuy) {
      f.buys += 1;
      f.buySol += amt;
    } else {
      f.sells += 1;
      f.sellSol += amt;
    }
    if (newUser) f.uniqueTraders += 1;
  }
  if (!isBuy && rel <= W5) {
    // launcher / creator are set at the completion; a pending watch compares them at the row
    (w.earlySells ??= []).push({ user: ev.user, sol: amt });
  }
  if (!isBuy && rel <= W3 && (w.largestSell === null || amt > w.largestSell.sol)) w.largestSell = { sol: amt, wallet: ev.user, sec: rel };
  return [];
}

// #21b traffic: one notification of this pool's subscription (mode a), or one transaction holding
// an event of this pool (mode b). `streamSec`: the stream clock at receipt (failed transactions carry
// no event time).
// #21e: the pool's log bytes passing CENSUS_POOL_LOGS_MB end its phase 1 here.
export function notePoolTraffic(pw, pool, { failed = false, bytes = 0, streamSec }) {
  const w = pw.byPool.get(pool);
  if (!w) return;
  const rel = w.firstSec === null ? -1 : streamSec - w.firstSec;
  for (const [k, lo, hi] of TRAFFIC_WINDOWS) {
    if (rel >= lo && rel < hi) {
      const t = w.traffic[k];
      t.notes += 1;
      if (failed) t.failedNotes += 1;
      t.logBytes += bytes;
      break;
    }
  }
  w.logBytes += bytes;
  if (w.logBytes >= pw.cfg.logsBytes) cutLogs(pw, w, "bytes", streamSec);
}

// ---- #21e: the vaults --------------------------------------------------------------------------------
const pct = (xs, p) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
};
const errOut = (x) => (x === null ? null : Number(x.toPrecision(3)));
const maxOf = (xs) => xs.reduce((m, x) => (m === null || x > m ? x : m), null);

function trimSlots(map, slot) {
  if (map.size <= CHECK_SLOTS) return;
  for (const k of map.keys()) if (k < slot - CHECK_SLOTS) map.delete(k);
}

// The vault price of `slot` against the trade event of that slot that left the base vault at the same
// amount (the base side of an event is exact, KODING_REPORT_21): their relative price difference.
function matchSlot(pw, w, slot) {
  const v = w.vault;
  const vp = v.vpBySlot.get(slot);
  const evs = v.evBySlot.get(slot);
  if (!vp || vp.done || !evs) return;
  const ev = evs.find((e) => e.base === vp.base);
  if (!ev) return; // a later event of the slot may still come; counted unmatched when it never does
  vp.done = true;
  const err = Math.abs(vp.price / ev.price - 1);
  v.pairs += 1;
  v.errs.push(err);
  pw.counts.vaultCheckPairs += 1;
  if (pw.checkErrs.length < CHECK_ERRS_MAX) pw.checkErrs.push(err);
  if (ev.virt !== null && ev.virt !== vp.virt) pw.counts.vaultCheckVirtualDiff += 1;
}

function checkEvent(pw, w, slot, e) {
  if (!pw.cfg.vaultCheck) return;
  const v = w.vault;
  const list = v.evBySlot.get(slot) ?? [];
  list.push(e);
  v.evBySlot.set(slot, list);
  trimSlots(v.evBySlot, slot);
  matchSlot(pw, w, slot);
}

function checkVault(pw, w, slot, vp) {
  if (!pw.cfg.vaultCheck || w.phase === 2) return; // no trade events in phase 2
  const v = w.vault;
  const old = v.vpBySlot.get(slot);
  if (old?.done) return;
  v.vpBySlot.set(slot, vp);
  for (const [k, x] of v.vpBySlot) {
    if (k >= slot - CHECK_SLOTS) break;
    if (!x.done && v.evBySlot.has(k)) {
      v.unmatched += 1;
      pw.counts.vaultCheckUnmatched += 1;
    }
    v.vpBySlot.delete(k);
  }
  matchSlot(pw, w, slot);
}

// One account notification of a watched pool: `kind` "base" | "quote" (vault token accounts) | "pool"
// (the pool account), `data` its decoded bytes, `slot` its context slot, `bytes` its size, `streamSec`
// the stream clock. In phase 2 a priced slot feeds the path like a trade's price; an event past the
// window ends the watch (returns its row).
export function onVaultNote(pw, pool, kind, { data, slot = null, bytes = 0, streamSec }) {
  const w = pw.byPool.get(pool);
  if (!w || !w.vault) {
    pw.counts.vaultUnknown += 1;
    return [];
  }
  const v = w.vault;
  pw.counts.vaultNotes += 1;
  pw.counts.vaultBytes += bytes;
  v.notes[kind] = (v.notes[kind] ?? 0) + 1;
  v.bytes += bytes;
  if (w.phase === 2) {
    v.p2Notes += 1;
    v.p2Bytes += bytes;
  }
  if (kind === "pool") {
    const x = poolAccountVirtual(data);
    if (x === null) {
      pw.counts.vaultBadData += 1;
      return [];
    }
    if (v.virtSource === "account" && x !== v.virt) v.virtChanges += 1;
    v.virt = x;
    v.virtSource = "account";
  } else if (kind === "base" || kind === "quote") {
    const a = tokenAccountAmount(data);
    if (a === null) {
      pw.counts.vaultBadData += 1;
      return [];
    }
    v[kind] = { amt: a, slot };
  } else return [];
  // A slot is priced once both vaults of that slot arrived; again when the pool account of the same
  // slot comes after them (its virtual may have changed in that slot).
  if (!v.base || !v.quote || v.base.slot !== v.quote.slot || v.base.slot === null || v.virt === null) return [];
  const ps = v.base.slot;
  if (v.pricedSlot === ps && kind !== "pool") return [];
  const price = quotePerBase(v.quote.amt + v.virt, v.base.amt);
  if (price === null) return [];
  v.pricedSlot = ps;
  checkVault(pw, w, ps, { base: v.base.amt, price, virt: v.virt });
  if (w.phase !== 2) return [];
  const { watchSec } = pw.cfg;
  let s = streamSec;
  if (w.lastSec !== null && s < w.lastSec) s = w.lastSec;
  if (s > w.firstSec + watchSec) {
    pw.counts.poolAfterEnd += 1;
    return [finishPool(pw, w, "watch", w.firstSec + watchSec)];
  }
  v.prices += 1;
  pw.counts.vaultPrices += 1;
  settle(w, s, watchSec);
  notePrice(w, price, s - w.firstSec);
  w.lastSec = s;
  w.lastQuote = sol(v.quote.amt);
  return [];
}

// #21c: pools whose first seen price is far above the curve end. Checked on chain (KODING_REPORT_21c):
// the data is real — buys in the pool's opening slot, some of them inside the migration transaction
// itself, whose logs the validator truncates ("Log truncated"), so the stream never shows them.
export const ODD_OPEN_RATIO = 1.5;
function oddOf(w, ce) {
  const reasons = [];
  if (w.firstPrice !== null && ce > 0 && w.firstPrice / ce >= ODD_OPEN_RATIO) reasons.push("openJump");
  if (w.truncatedAtOpen) reasons.push("openLogTruncated");
  return reasons.length ? { poolOdd: true, poolOddReasons: reasons } : {};
}

const flowOut = (f) => ({ ...f, buySol: r4(f.buySol), sellSol: r4(f.sellSol) });
// #21e: the vault subscriptions of a row (null when the vaults were never subscribed). KB = the
// notifications' JSON size; p2 = phase 2 only (the vault check runs them in phase 1 too).
function vaultsOut(v) {
  if (!v) return null;
  return {
    notes: { ...v.notes },
    KB: r1(v.bytes / 1024),
    p2Notes: v.p2Notes,
    p2KB: r1(v.p2Bytes / 1024),
    prices: v.prices,
    virtSource: v.virtSource,
    virtChanges: v.virtChanges,
    ...(v.pairs || v.unmatched ? { checkPairs: v.pairs, checkUnmatched: v.unmatched, checkErrP50: errOut(pct(v.errs, 0.5)), checkErrMax: errOut(maxOf(v.errs)) } : {}),
  };
}
const trafficOut = (t) => ({ notes: t.notes, failedNotes: t.failedNotes, logKB: r1(t.logBytes / 1024) });

// final: "watch" (the window ended) | "idle" (no pool event for idleSec) | "shutdown" (partial).
// `horizon`: the last on-chain second the watch covered (decides which windows were reached).
export function finishPool(pw, w, final, horizon) {
  unsubscribe(pw, w);
  pw.counts.poolRows += 1;
  const { watchSec, rev } = pw.cfg;
  const started = w.firstSec !== null;
  const reached = (t) => started && t <= watchSec && horizon >= w.firstSec + t;
  // #21e: the logs (flows, sells) cover phase 1 only: a fixed window phase 1 did not cover is null
  const logged = (t) => reached(t) && (w.logsUntilSec === null || w.logsUntilSec >= t);
  if (started) settle(w, horizon + 1, watchSec); // every checkpoint at or before the horizon
  const ce = w.curveEndPrice;
  const ratio = (price) => (price === null || price === undefined ? null : r4(price / ce));
  const ratios = {};
  for (const [t, key] of POOL_CHECKPOINTS) ratios[key] = reached(t) ? ratio(w.cps[key]) : null;
  const mm = (m, ok) => (ok ? { min: ratio(m.min), minSec: m.minSec, max: ratio(m.max), maxSec: m.maxSec } : { min: null, minSec: null, max: null, maxSec: null });
  const m1 = mm(w.mm1, reached(W1));
  const m5 = mm(w.mm5, reached(W5));
  const mAll = mm(w.mmAll, started);
  // launcher / creator pool sells in the first 5 m (the wallets are known since the completion)
  let launcherSell = 0;
  let creatorSell = 0;
  for (const x of w.earlySells || []) {
    if (w.launcher && x.user === w.launcher) launcherSell += x.sol;
    if (w.creator && x.user === w.creator) creatorSell += x.sol;
  }
  // the open (#21b): pool_quote_amount / pool_base_amount of the CreatePoolEvent. On a pump migration
  // the quote amount is the WHOLE effective quote: right after the create a part of the vault becomes
  // the pool's virtual quote reserves (real 2026-11-17: open 84.990360291 SOL = vault 67.405854747 +
  // virtual 17.584505544 at the first trade, same transaction), so no virtual part is added here.
  const opened = w.openSec !== null;
  const openPrice = opened ? quotePerBase(w.openQuote, w.openBase) : null;
  const effFirst = w.firstQuote === null ? null : w.firstQuote + (w.firstVirtual ?? 0n); // signed virtual (#21c)
  const traffic = {};
  const total = { notes: 0, failedNotes: 0, logBytes: 0 };
  for (const [k] of TRAFFIC_WINDOWS) {
    traffic[k] = trafficOut(w.traffic[k]);
    total.notes += w.traffic[k].notes;
    total.failedNotes += w.traffic[k].failedNotes;
    total.logBytes += w.traffic[k].logBytes;
  }
  return {
    type: "census_pool",
    censusRev: rev,
    mint: w.mint,
    pool: w.pool,
    mode: pw.mode,
    final,
    completeSec: w.completeSec,
    completeSeen: w.completeSeen,
    ...(w.lateComplete ? { lateComplete: true } : {}),
    curveEndPrice: w.curveEndPrice,
    curveEndSource: w.curveEndSource,
    ...(w.curveEndFill !== null ? { curveEndFill: w.curveEndFill } : {}),
    t0: opened ? "create" : "trade",
    poolOpenSec: opened ? w.openSec : null,
    poolOpenPrice: openPrice === null ? null : sig6(openPrice),
    openRatio: openPrice === null ? null : r4(openPrice / ce),
    quoteReserveSolAtOpen: opened ? sol(w.openQuote) : null, // effective quote at the open (vault + virtual)
    poolMayhem: opened ? w.openMayhem : null,
    firstTradeAfterOpenSec: opened && started ? w.firstSec - w.openSec : null,
    // the first trade seen is the pool's first trade: its "before" reserves (base; vault + virtual)
    // are the open reserves
    firstTradeAtOpen: opened && started ? w.firstBase === w.openBase && effFirst === w.openQuote : null,
    firstPoolSec: w.firstSec,
    poolDelaySec: started && w.completeSec !== null ? w.firstSec - w.completeSec : null,
    firstPoolPrice: w.firstPrice === null ? null : sig6(w.firstPrice),
    ratioOpen: w.firstPrice === null ? null : r4(sig6(w.firstPrice) / ce),
    quoteReserveSolAtFirst: w.quoteAtFirst,
    ...ratios,
    minRatio1m: m1.min,
    minSec1m: m1.minSec,
    maxRatio1m: m1.max,
    maxSec1m: m1.maxSec,
    minRatio5m: m5.min,
    minSec5m: m5.minSec,
    maxRatio5m: m5.max,
    maxSec5m: m5.maxSec,
    minRatioAll: mAll.min,
    minSecAll: mAll.minSec,
    maxRatioAll: mAll.max,
    maxSecAll: mAll.maxSec,
    flow1m: logged(W1) ? flowOut(w.f1) : null,
    flow5m: logged(W5) ? flowOut(w.f5) : null,
    flowAll: flowOut(w.fAll), // #21e: phase 1 only (logsUntilSec)
    launcherSellSol5m: w.launcher && logged(W5) ? r4(launcherSell) : null,
    creatorSellSol5m: w.creator && logged(W5) ? r4(creatorSell) : null,
    largestSellSol3m: logged(W3) ? (w.largestSell ? r4(w.largestSell.sol) : 0) : null,
    largestSellWallet3m: logged(W3) && w.largestSell ? w.largestSell.wallet : null,
    largestSellSec3m: logged(W3) && w.largestSell ? w.largestSell.sec : null,
    quoteReserveSolEnd: w.lastQuote,
    lastPoolSec: w.lastSec,
    observedSec: started ? Math.max(0, Math.min(horizon, w.firstSec + watchSec) - w.firstSec) : null,
    events: w.events,
    notes: total.notes,
    failedNotes: total.failedNotes,
    logKB: r1(total.logBytes / 1024), // phase 1 (logs)
    traffic,
    // #21e: phase 2
    logsUntilSec: w.logsUntilSec,
    logsCutReason: w.logsCutReason,
    phase2: w.phase === 2 ? "vaults" : null,
    vaults: vaultsOut(w.vault),
    ...(w.unpriced > 0 ? { unpricedEvents: w.unpriced } : {}),
    ...(w.truncatedNotes > 0 ? { logTruncatedNotes: w.truncatedNotes } : {}),
    ...oddOf(w, ce),
    ...(final === "shutdown" ? { partial: true } : {}),
    ...(w.stall ? { stall: true } : {}),
    ...(w.gap ? { gap: true } : {}),
  };
}

// Active watches whose window is over (stream clock past first + watch + slack) or idle (no pool
// event for idleSec of stream time since the last one, or since the completion if none came).
// Pending watches end with their mint (dropPresub), never here.
export function sweepPools(pw, streamSec) {
  const rows = [];
  const { watchSec, idleSec, logsSec } = pw.cfg;
  for (const w of [...pw.byPool.values()]) {
    if (w.pending) continue;
    if (w.phase === 1 && w.firstSec !== null && streamSec >= w.firstSec + logsSec) cutLogs(pw, w, "time", streamSec); // #21e
    if (w.firstSec !== null && streamSec >= w.firstSec + watchSec + POOL_END_SLACK_SEC) rows.push(finishPool(pw, w, "watch", w.firstSec + watchSec));
    else if (streamSec - Math.max(w.lastSec ?? w.activatedSec, w.activatedSec) >= idleSec) rows.push(finishPool(pw, w, "idle", streamSec));
  }
  return rows;
}

// The stop: a partial row for every active watch; pending ones are dropped (their mints' shutdown
// rows already dropped them, this is the safety net).
export function finishAllPools(pw, streamSec) {
  const rows = [];
  for (const w of [...pw.byPool.values()]) {
    if (w.pending) dropPresub(pw, w.mint);
    else rows.push(finishPool(pw, w, "shutdown", streamSec));
  }
  return rows;
}

export function markPools(pw, flag) {
  for (const w of pw.byPool.values()) w[flag] = true;
}

// A transaction reaches us once per subscription that mentions it: process each signature once.
export function firstSighting(pw, signature) {
  if (!signature) return true;
  if (pw.seen.has(signature)) {
    pw.counts.poolDup += 1;
    return false;
  }
  pw.seen.add(signature);
  pw.seenOrder.push(signature);
  if (pw.seenOrder.length > SIG_KEEP) for (const k of pw.seenOrder.splice(0, SIG_KEEP / 2)) pw.seen.delete(k);
  return true;
}

export function poolStats(pw) {
  const { poolLogBytes, vaultBytes, ...rest } = pw.counts;
  let pending = 0;
  let phase2 = 0;
  for (const w of pw.byPool.values()) {
    if (w.pending) pending += 1;
    if (w.phase === 2) phase2 += 1;
  }
  const mb = (b) => Math.round((b / 1048576) * 1000) / 1000;
  return {
    poolMode: pw.mode,
    poolLive: pw.byPool.size - pending,
    poolPending: pending,
    poolPhase2: phase2,
    ...rest,
    poolLogMB: mb(poolLogBytes),
    vaultMB: mb(vaultBytes),
    ...(pw.cfg.vaultCheck ? { vaultCheckErrP50: errOut(pct(pw.checkErrs, 0.5)), vaultCheckErrP90: errOut(pct(pw.checkErrs, 0.9)), vaultCheckErrMax: errOut(maxOf(pw.checkErrs)) } : {}),
  };
}

// ---- subscriptions ---------------------------------------------------------------------------------
// Mode "a": one logsSubscribe per watched pool (mentions: [pool]), made at the pre-subscription fill
// (or at the curve completion) and ended when the watch ends or is dropped (lib/ws.mjs unsubscribe: an
// ended pool is not resubscribed after a reconnect or a failover switch). If the server rejects a pool
// subscription (e.g. a limit on subscriptions per connection), the census falls back LOUDLY to mode
// "b": every pool subscription is dropped and ONE subscription on the whole PumpSwap program replaces
// them (the pools still watched keep their state; in-process filtering by pool). Mode "b" can also be
// chosen at the start. `onLogs(result, pool)` receives every notification of these subscriptions
// (`pool` = the subscription's pool in mode a, null in mode b).
// #21e phase 2: three accountSubscribe (base64, confirmed) per pool — base vault, quote vault, pool
// account — ended with the watch; `onAccount(result, pool, kind)` receives their notifications. A
// rejected vault subscription is counted and logged once (no mode change: the pool keeps its row,
// without phase-2 prices).
const clean = (s) => String(s ?? "").replace(/[a-z]+:\/\/\S+/gi, "<url>").replace(/\s+/g, " ").slice(0, 80);

export function attachPoolStream({ ws, pw, programId, onLogs, onAccount = () => {}, log = () => {}, onRow = () => {} }) {
  const subs = new Map(); // pool -> ws subscription id
  const vaultSubs = new Map(); // pool -> [ws subscription ids] (#21e)
  let vaultRejectLogged = false;
  let programSub = null;
  const programHandler = (result) => onLogs(result, null);
  const toProgram = (reason) => {
    if (pw.mode === "b" && programSub !== null) return;
    pw.mode = "b";
    for (const id of subs.values()) ws.unsubscribe(id);
    subs.clear();
    programSub = ws.subscribeLogs(programId, programHandler);
    log(`POOL SUBSCRIPTION REJECTED (${reason}) -> mode b: ONE subscription on the whole PumpSwap program (heavy traffic), ${pw.byPool.size} watched pool(s) kept`);
    onRow({ type: "census_pool_mode", censusRev: pw.cfg.rev, mode: "b", reason, watchedPools: pw.byPool.size });
  };
  pw.hooks.watch = (pool) => {
    if (pw.mode !== "a" || subs.has(pool)) return;
    const id = ws.subscribeLogs(pool, (result) => onLogs(result, pool), "confirmed", { onError: (e) => toProgram(clean(`subscribe error ${e?.code ?? ""} ${e?.message ?? ""}`.trim())) });
    subs.set(pool, id);
  };
  pw.hooks.unwatch = (pool) => {
    const id = subs.get(pool);
    if (id === undefined) return;
    subs.delete(pool);
    ws.unsubscribe(id);
  };
  pw.hooks.watchVaults = (w) => {
    if (vaultSubs.has(w.pool) || !w.vault) return;
    const onError = (e) => {
      pw.counts.vaultSubRejected += 1;
      if (!vaultRejectLogged) {
        vaultRejectLogged = true;
        log(`VAULT SUBSCRIPTION REJECTED (${clean(`${e?.code ?? ""} ${e?.message ?? ""}`.trim())}): phase-2 prices missing for such pools (counted: vaultSubRejected)`);
      }
    };
    const ids = [
      ["base", w.vault.baseVault],
      ["quote", w.vault.quoteVault],
      ["pool", w.pool],
    ].map(([kind, address]) => ws.subscribeAccount(address, (result) => onAccount(result, w.pool, kind), "confirmed", { encoding: "base64", onError }));
    vaultSubs.set(w.pool, ids);
  };
  pw.hooks.unwatchVaults = (pool) => {
    const ids = vaultSubs.get(pool);
    if (!ids) return;
    vaultSubs.delete(pool);
    for (const id of ids) ws.unsubscribe(id);
  };
  if (pw.mode === "b") programSub = ws.subscribeLogs(programId, programHandler);
  return {
    get poolSubs() {
      return subs.size + (programSub !== null ? 1 : 0);
    },
    get vaultSubs() {
      let n = 0;
      for (const ids of vaultSubs.values()) n += ids.length;
      return n;
    },
    toProgram,
  };
}
