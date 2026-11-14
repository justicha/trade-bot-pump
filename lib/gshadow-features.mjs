// Pre-entry "who is behind the token" features of the graduation shadow lab (revision 7).
//
// Journal only: nothing here feeds an entry or exit decision. bots/graduation-sniper/shadow.mjs
// feeds every create event and every state-updating trade event (not the > SHADOW_LATE_SEC backlog)
// into a store, and at the moment of an open asks buildFeatures() for one `feat` object that all
// variants opening on that event share.
//
// Why (PROMPT, 2026-11-14): the 10 worst live-mirror trades crashed for reasons the lab did not
// log — the creator dumping at migration, a serial creator, copycat names, one wallet making 73%
// of the trades, a non-standard curve (price 7x the standard curve at the same fill), single whale
// sells. These fields are collected first and tested as filters out-of-sample later.
//
// No I/O. Time comes in as arguments: on-chain seconds (event timestamps) for the windows,
// local milliseconds for idleness (eviction).
//
// Missing data is null, never 0: a creator we do not know has `creatorBuySol: null`; a creator we
// know who never traded this mint has `creatorBuySol: 0`.
import { LAUNCH_RESERVES } from "./events.mjs";

export const FEAT_WINDOW_SEC = 60; // buySol60 / sellSol60 / buys60 / sells60 / maxSell60Sol
export const CREATOR_WINDOW_SEC = 24 * 3600; // creatorLaunches24h
export const NAME_WINDOW_SEC = 30 * 60; // sameNameRecent
export const FEAT_IDLE_MS = 30 * 60 * 1000; // a mint with no event for this long (and no position) is evicted

const STD_VSOL = Number(LAUNCH_RESERVES.vSol); // 30 SOL virtual at launch (lamports)
const STD_VTOK = Number(LAUNCH_RESERVES.vTok); // 1.073e15 raw virtual tokens at launch
const NAME_MAX = 32; // name / symbol are journaled truncated to this many characters

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r3 = (x) => Math.round(x * 1e3) / 1e3;
const r2 = (x) => Math.round(x * 100) / 100;
const finiteOr = (x, d = null) => (Number.isFinite(x) ? x : d);

export function createFeatureStore() {
  return {
    mints: new Map(), // mint -> per-mint state (mintFeat)
    creators: new Map(), // creator -> [{ sec, mint }] creates in the last 24 h
    names: new Map(), // normalized name -> [{ sec, mint }] creates in the last 30 min
    symbols: new Map(), // normalized symbol -> [{ sec, mint }]
  };
}

function mintFeat(store, mint, nowMs) {
  let f = store.mints.get(mint);
  if (!f) {
    f = {
      createdAtSec: null,
      creator: null,
      creatorSource: null, // "create" | "trade"
      name: null,
      symbol: null,
      firstSeenFill: null,
      lastEventAt: nowMs,
      wallets: new Map(), // wallet -> { t: trades, b: buy SOL, s: sell SOL }
      trades: 0,
      recent: [], // [{ sec, isBuy, sol }] within FEAT_WINDOW_SEC of maxSec
      maxSec: 0,
    };
    store.mints.set(mint, f);
  }
  return f;
}

// "Solana AI", "SOLANA  ai!" and "solana-ai" are the same name: NFKC, lower case, letters and
// digits only. An empty result (emoji-only names) is not indexed.
export function normalizeName(s) {
  if (typeof s !== "string") return "";
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function indexPush(map, key, entry) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

// A create-v2 event (lib/events.mjs parseCreate): { mint, creator, name, symbol, timestampSec }.
// The same create seen twice (a re-delivered notification) is counted once.
export function noteCreate(store, c, nowMs) {
  if (!c || !c.mint) return null;
  const f = mintFeat(store, c.mint, nowMs);
  if (f.createdAtSec !== null) return f;
  const sec = Number(c.timestampSec) > 0 ? Number(c.timestampSec) : null;
  f.createdAtSec = sec;
  if (c.creator) {
    f.creator = c.creator;
    f.creatorSource = "create";
  }
  f.name = typeof c.name === "string" ? c.name : null;
  f.symbol = typeof c.symbol === "string" ? c.symbol : null;
  if (f.firstSeenFill === null) f.firstSeenFill = 0; // seen from its first second: the whole life
  f.lastEventAt = nowMs;
  if (sec !== null) {
    const entry = { sec, mint: c.mint };
    if (c.creator) indexPush(store.creators, c.creator, entry);
    indexPush(store.names, normalizeName(f.name), entry);
    indexPush(store.symbols, normalizeName(f.symbol), entry);
  }
  return f;
}

// A trade event that updated the lab's state: { mint, user, isBuy, solLamports, timestampSec }.
// `fill`: the mint's fill after this event. `creatorOf`: lazy reader of the trade event's own
// creator field (only called while the mint has no creator yet — base58 is not free).
export function noteTrade(store, ev, { nowMs, fill, creatorOf = null } = {}) {
  if (!ev || !ev.mint) return null;
  const f = mintFeat(store, ev.mint, nowMs);
  if (f.firstSeenFill === null) f.firstSeenFill = finiteOr(r2(Number(fill)));
  if (!f.creator && creatorOf) {
    const c = creatorOf();
    if (c) {
      f.creator = c;
      f.creatorSource = "trade";
    }
  }
  const sol = Math.max(0, finiteOr(Number(ev.solLamports) / 1e9, 0));
  if (ev.user) {
    let w = f.wallets.get(ev.user);
    if (!w) {
      w = { t: 0, b: 0, s: 0 };
      f.wallets.set(ev.user, w);
    }
    w.t += 1;
    if (ev.isBuy) w.b += sol;
    else w.s += sol;
  }
  f.trades += 1;
  const sec = Number(ev.timestampSec);
  if (Number.isFinite(sec) && sec > 0) {
    f.maxSec = Math.max(f.maxSec, sec);
    f.recent.push({ sec, isBuy: !!ev.isBuy, sol });
    const cut = f.maxSec - FEAT_WINDOW_SEC;
    while (f.recent.length && f.recent[0].sec <= cut) f.recent.shift();
  }
  f.lastEventAt = nowMs;
  return f;
}

// Spot price over the standard pump.fun curve's price at the same real SOL reserve (constant
// product 30 SOL x 1.073e15 raw tokens, 1B supply). 1 = a standard token; the 2B-supply wash-trade
// case was ~7. Units cancel: both are lamports per raw token.
export function priceRel({ virtualSolReserves, virtualTokenReserves, realSolReserves }) {
  const vSol = Number(virtualSolReserves);
  const vTok = Number(virtualTokenReserves);
  const rSol = Number(realSolReserves);
  if (!(vSol > 0) || !(vTok > 0) || !(rSol >= 0)) return null;
  const stdVSol = STD_VSOL + rSol;
  const stdVTok = (STD_VSOL * STD_VTOK) / stdVSol;
  return r3(vSol / vTok / (stdVSol / stdVTok));
}

function countWindow(list, fromSec, toSec, exceptMint, into) {
  if (!list) return;
  for (const e of list) if (e.sec > fromSec && e.sec <= toSec && e.mint !== exceptMint) into.add(e.mint);
}

// The `feat` object of one mint at one moment (the event an open is decided on).
//   nowSec   on-chain time of that event
//   curve    { virtualSolReserves, virtualTokenReserves, realSolReserves } after that event (raw)
//   watchSec how long the lab has been running: the 24 h / 30 min windows are lower bounds before
//            it has watched that long
export function buildFeatures(store, mint, { nowSec, curve, watchSec = null }) {
  const f = store.mints.get(mint);
  if (!f) return null;
  const now = Number(nowSec);

  let maxT = 0;
  let maxV = 0;
  let vol = 0;
  const nets = [];
  for (const w of f.wallets.values()) {
    if (w.t > maxT) maxT = w.t;
    const v = w.b + w.s;
    if (v > maxV) maxV = v;
    vol += v;
    nets.push(w.b - w.s);
  }
  // Net holders proxy: the five largest net buyers. A net seller holds nothing, so it adds 0
  // (not a negative amount) when fewer than five wallets are net buyers.
  nets.sort((a, b) => b - a);
  let top5 = 0;
  for (let i = 0; i < Math.min(5, nets.length); i++) top5 += Math.max(0, nets[i]);
  const rSolSol = Number(curve?.realSolReserves) / 1e9;

  let buySol60 = 0;
  let sellSol60 = 0;
  let buys60 = 0;
  let sells60 = 0;
  let maxSell60 = 0;
  for (const e of f.recent) {
    if (!(e.sec > now - FEAT_WINDOW_SEC && e.sec <= now)) continue;
    if (e.isBuy) {
      buys60 += 1;
      buySol60 += e.sol;
    } else {
      sells60 += 1;
      sellSol60 += e.sol;
      if (e.sol > maxSell60) maxSell60 = e.sol;
    }
  }

  const cw = f.creator ? f.wallets.get(f.creator) : null;
  let creatorLaunches24h = null;
  if (f.creator) {
    const seen = new Set();
    countWindow(store.creators.get(f.creator), now - CREATOR_WINDOW_SEC, now, null, seen);
    // This mint is a launch by definition; when its create was not seen it is not in the index.
    seen.add(mint);
    creatorLaunches24h = seen.size;
  }
  let sameNameRecent = null;
  if (f.name !== null || f.symbol !== null) {
    const seen = new Set();
    countWindow(store.names.get(normalizeName(f.name)), now - NAME_WINDOW_SEC, now, mint, seen);
    countWindow(store.symbols.get(normalizeName(f.symbol)), now - NAME_WINDOW_SEC, now, mint, seen);
    sameNameRecent = seen.size;
  }

  return {
    ageSec: f.createdAtSec !== null && Number.isFinite(now) ? now - f.createdAtSec : null,
    creator: f.creator,
    creatorSource: f.creatorSource,
    creatorBuySol: f.creator ? r4(cw ? cw.b : 0) : null,
    creatorSellSol: f.creator ? r4(cw ? cw.s : 0) : null,
    creatorTrades: f.creator ? (cw ? cw.t : 0) : null,
    creatorLaunches24h,
    name: f.name === null ? null : f.name.slice(0, NAME_MAX),
    symbol: f.symbol === null ? null : f.symbol.slice(0, NAME_MAX),
    sameNameRecent,
    trades: f.trades,
    uniqueTraders: f.wallets.size,
    topWalletTradeShare: f.trades > 0 ? r3(maxT / f.trades) : null,
    topWalletVolShare: vol > 0 ? r3(maxV / vol) : null,
    top5NetSol: nets.length ? r4(top5) : null,
    top5NetShare: nets.length && rSolSol > 0 ? r3(top5 / rSolSol) : null,
    buySol60: r4(buySol60),
    sellSol60: r4(sellSol60),
    buys60,
    sells60,
    maxSell60Sol: r4(maxSell60),
    priceRel: curve ? priceRel(curve) : null,
    firstSeenFill: f.firstSeenFill,
    watchSec: watchSec === null ? null : Math.round(watchSec),
  };
}

// ---- memory --------------------------------------------------------------------------------------
// The phone runs the lab for 10+ hours; every pump.fun launch lands in the store.

// Drop the per-mint state (wallet map, 60 s window) of mints with no event for `idleMs` and no
// open position (`keep`: mints that hold one). Returns how many were dropped.
export function evictIdle(store, nowMs, keep = new Set(), idleMs = FEAT_IDLE_MS) {
  let n = 0;
  for (const [mint, f] of store.mints) {
    if (keep.has(mint)) continue;
    if (nowMs - f.lastEventAt > idleMs) {
      store.mints.delete(mint);
      n += 1;
    }
  }
  return n;
}

// Trim the creator / name / symbol indexes to their windows (on-chain seconds).
export function trimIndexes(store, nowSec) {
  const trim = (map, windowSec) => {
    const cut = nowSec - windowSec;
    for (const [k, list] of map) {
      const kept = list.filter((e) => e.sec > cut);
      if (kept.length) {
        if (kept.length !== list.length) map.set(k, kept);
      } else map.delete(k);
    }
  };
  trim(store.creators, CREATOR_WINDOW_SEC);
  trim(store.names, NAME_WINDOW_SEC);
  trim(store.symbols, NAME_WINDOW_SEC);
}

export function storeStats(store) {
  let wallets = 0;
  let recent = 0;
  for (const f of store.mints.values()) {
    wallets += f.wallets.size;
    recent += f.recent.length;
  }
  const entries = (m) => [...m.values()].reduce((a, l) => a + l.length, 0);
  return { mints: store.mints.size, wallets, recent, creators: store.creators.size, creatorLaunches: entries(store.creators), names: store.names.size, symbols: store.symbols.size };
}
