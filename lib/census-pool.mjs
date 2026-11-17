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
import { PublicKey } from "@solana/web3.js";
import { canonicalPool, poolTradePrices, quotePerBase } from "./pumpswap-stream.mjs";

export const DEFAULT_POOL_WATCH_SEC = 3600;
export const DEFAULT_PRESUB_FILL = 92;
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

export function createPoolWatch({ rev, watchSec = DEFAULT_POOL_WATCH_SEC, idleSec, mode = "a", presubFill = DEFAULT_PRESUB_FILL }) {
  return {
    cfg: { rev, watchSec, idleSec, presubFill },
    mode, // "a" one subscription per pool | "b" one on the whole PumpSwap program
    byPool: new Map(), // pool -> watch state (pending or active)
    seen: new Set(), // signatures already processed (a tx can reach us through two subscriptions)
    seenOrder: [],
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
    },
    // Set by the subscriber (attachPoolStream); no-ops in the pure tests.
    hooks: { watch: () => {}, unwatch: () => {} },
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
    curveEndPrice: null,
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
    stall: false,
    gap: false,
  };
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
export function watchPool(pw, { mint, completeSec, curveEndPrice, launcher = null, creator = null, stall = false, gap = false }) {
  if (!(curveEndPrice > 0)) return null;
  const pool = poolOf(mint);
  if (!pool) return null;
  let w = pw.byPool.get(pool);
  if (w && !w.pending) return pool;
  const fresh = !w;
  if (fresh) w = newWatch(mint, pool);
  w.pending = false;
  w.completeSec = completeSec;
  w.curveEndPrice = curveEndPrice;
  w.launcher = launcher;
  w.creator = creator;
  w.stall = w.stall || stall;
  w.gap = w.gap || gap;
  pw.counts.poolWatched += 1;
  if (fresh) subscribe(pw, w);
  return pool;
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
export function onPoolTrade(pw, ev, sec) {
  const w = pw.byPool.get(ev.pool);
  if (!w) {
    pw.counts.unknownPool += 1;
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
}

const flowOut = (f) => ({ ...f, buySol: r4(f.buySol), sellSol: r4(f.sellSol) });
const trafficOut = (t) => ({ notes: t.notes, failedNotes: t.failedNotes, logKB: r1(t.logBytes / 1024) });

// final: "watch" (the window ended) | "idle" (no pool event for idleSec) | "shutdown" (partial).
// `horizon`: the last on-chain second the watch covered (decides which windows were reached).
export function finishPool(pw, w, final, horizon) {
  unsubscribe(pw, w);
  pw.counts.poolRows += 1;
  const { watchSec, rev } = pw.cfg;
  const started = w.firstSec !== null;
  const reached = (t) => started && t <= watchSec && horizon >= w.firstSec + t;
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
  const effFirst = w.firstQuote === null ? null : w.firstQuote + (w.firstVirtual !== null && w.firstVirtual > 0n ? w.firstVirtual : 0n);
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
    curveEndPrice: w.curveEndPrice,
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
    poolDelaySec: started ? w.firstSec - w.completeSec : null,
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
    flow1m: reached(W1) ? flowOut(w.f1) : null,
    flow5m: reached(W5) ? flowOut(w.f5) : null,
    flowAll: flowOut(w.fAll),
    launcherSellSol5m: w.launcher && reached(W5) ? r4(launcherSell) : null,
    creatorSellSol5m: w.creator && reached(W5) ? r4(creatorSell) : null,
    largestSellSol3m: reached(W3) ? (w.largestSell ? r4(w.largestSell.sol) : 0) : null,
    largestSellWallet3m: reached(W3) && w.largestSell ? w.largestSell.wallet : null,
    largestSellSec3m: reached(W3) && w.largestSell ? w.largestSell.sec : null,
    quoteReserveSolEnd: w.lastQuote,
    lastPoolSec: w.lastSec,
    observedSec: started ? Math.max(0, Math.min(horizon, w.firstSec + watchSec) - w.firstSec) : null,
    events: w.events,
    notes: total.notes,
    failedNotes: total.failedNotes,
    logKB: r1(total.logBytes / 1024),
    traffic,
    ...(w.unpriced > 0 ? { unpricedEvents: w.unpriced } : {}),
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
  const { watchSec, idleSec } = pw.cfg;
  for (const w of [...pw.byPool.values()]) {
    if (w.pending) continue;
    if (w.firstSec !== null && streamSec >= w.firstSec + watchSec + POOL_END_SLACK_SEC) rows.push(finishPool(pw, w, "watch", w.firstSec + watchSec));
    else if (streamSec - Math.max(w.lastSec ?? w.completeSec, w.completeSec) >= idleSec) rows.push(finishPool(pw, w, "idle", streamSec));
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
  const { poolLogBytes, ...rest } = pw.counts;
  let pending = 0;
  for (const w of pw.byPool.values()) if (w.pending) pending += 1;
  return { poolMode: pw.mode, poolLive: pw.byPool.size - pending, poolPending: pending, ...rest, poolLogMB: Math.round((poolLogBytes / 1048576) * 1000) / 1000 };
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
const clean = (s) => String(s ?? "").replace(/[a-z]+:\/\/\S+/gi, "<url>").replace(/\s+/g, " ").slice(0, 80);

export function attachPoolStream({ ws, pw, programId, onLogs, log = () => {}, onRow = () => {} }) {
  const subs = new Map(); // pool -> ws subscription id
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
  if (pw.mode === "b") programSub = ws.subscribeLogs(programId, programHandler);
  return {
    get poolSubs() {
      return subs.size + (programSub !== null ? 1 : 0);
    },
    toProgram,
  };
}
