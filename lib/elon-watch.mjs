// elon-watch (KODING #25) core: posts -> keyword events -> matching pump.fun creates -> followed mints,
// per-second paths and PAPER variants. RESEARCH / PAPER ONLY: no order, no key, no RPC, no I/O here —
// bots/elon-watch/elon.mjs feeds it (pump logs stream, X source, metadata fetches) and writes the rows
// it returns. Every function returns journal rows (lib/elon-journal.mjs types).
//
// Keyword event = (post id, keyword norm). On a new event:
//   - the 24 h create index is searched for creates in [post - 6 h, now] ("before" = created before the
//     post; "after" = between the post and its detection); the last ELON_BEFORE_FOLLOW before-matches
//     and every after-match are followed (cap ELON_MAX_FOLLOW per event);
//   - every NEW create is matched against the events of the last ELON_FOLLOW_SEC (on-chain time).
// A followed mint ("watch") records its per-second path in the census_path format (lib/census-path.mjs,
// minFill 0, written as elon_path when the follow window ends, the curve completes, or at the stop),
// buyers / SOL flow since each post, creator / launcher sells, and the metadata "linked" flag.
// Paper variants per event (lib/elon-paper.mjs, on-chain prices, mayhem / other-quote skipped):
//   first    first matching create AFTER the post, decided when we see it (or at detection)
//   linked   first match whose metadata links THIS post, decided when the metadata arrives
//   lead30   at post + 30 s, the eligible match with the most unique buyers since the post (tie: SOL inflow)
//   lead60   the same at post + 60 s
//   basket3  at post + 30 s, the bet split over the top 3 by the lead30 score (one row per leg, `basket`)
import { extractKeywords } from "./elon-keywords.mjs";
import * as M from "./elon-match.mjs";
import * as P from "./elon-paper.mjs";
import * as CP from "./census-path.mjs";
import { fillOf, createMayhem, MAX_PLAUSIBLE_FILL } from "./mint-census.mjs";

export const ELON_REV = 1;
export const VARIANTS = ["first", "linked", "lead30", "lead60", "basket3"];

export const DEFAULTS = Object.freeze({
  followSec: 1800,
  indexSec: 24 * 3600,
  indexMax: 300_000,
  beforeSec: M.BEFORE_SEC,
  beforeFollow: 10,
  maxFollowPerEvent: 30,
  maxWatches: 600,
  gapSec: 10,
  pathMaxBuckets: 4000,
  meta: true,
  horizonsSec: [300, 900],
});

const r1 = (x) => Math.round(x * 10) / 10;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const LAG_N = 4096;

export function createWatch(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  return {
    cfg,
    idx: M.createTokenIndex({ maxEntries: cfg.indexMax }),
    events: new Map(),
    recentNorms: new Map(), // norm -> postSec of its last non-repeat event
    posts: new Set(),
    watches: new Map(),
    book: P.createPaperBook({ buySol: cfg.buySol, horizonsSec: cfg.horizonsSec, ...(cfg.rng ? { rng: cfg.rng } : {}), ...(cfg.delayMs !== undefined ? { delayMs: cfg.delayMs } : {}) }),
    ps: CP.createPathStore({ minFill: 0, maxSec: cfg.followSec + 60, maxBuckets: cfg.pathMaxBuckets }),
    metaQueue: [],
    visionQueue: [],
    pumpSec: 0,
    startSec: null,
    lastEventMs: null,
    gap: null,
    lags: new Float32Array(LAG_N),
    lagN: 0,
    lastEvictMs: 0,
    counts: { posts: 0, kwEvents: 0, repeats: 0, matches: 0, followed: 0, notFollowed: 0, watchesDone: 0, paperRows: 0, creates: 0, trades: 0, bogusTs: 0, gaps: 0, gapSecTotal: 0, metaOk: 0, metaFail: 0, linked: 0 },
    detectLags: [],
  };
}

// ---- clocks ----------------------------------------------------------------------------------------------------
function onChainSec(W, s, nowMs) {
  const local = Math.floor(nowMs / 1000);
  const v = Number(s);
  if (Number.isFinite(v) && Math.abs(v - local) < 600) return v;
  W.counts.bogusTs += 1;
  return local;
}

export const streamLagSec = (W, nowMs) => (W.pumpSec > 0 ? r1(nowMs / 1000 - W.pumpSec) : null);

// A pump stream event arrived: moves the clocks, closes an open gap (elon_gap row).
function noteEvent(W, sec, nowMs) {
  const rows = [];
  if (W.startSec === null) W.startSec = sec;
  if (W.gap) {
    const g = W.gap;
    W.gap = null;
    CP.closeHole(g.hole, Math.max(sec, W.pumpSec));
    const lenSec = r1((nowMs - g.fromMs) / 1000);
    W.counts.gaps += 1;
    W.counts.gapSecTotal = r1(W.counts.gapSecTotal + lenSec);
    rows.push({ type: "elon_gap", source: "pump", startedAt: new Date(g.fromMs).toISOString(), endedAt: new Date(nowMs).toISOString(), sec: lenSec, watches: W.watches.size });
  }
  if (sec > W.pumpSec) W.pumpSec = sec;
  P.paperClock(W.book, W.pumpSec);
  W.lastEventMs = nowMs;
  return rows;
}

export function lagStats(W) {
  const n = Math.min(W.lagN, LAG_N);
  if (!n) return { n: 0, p50: null, p90: null };
  const a = Array.from(W.lags.subarray(0, n)).sort((x, y) => x - y);
  return { n, p50: r1(P.quantile(a, 0.5)), p90: r1(P.quantile(a, 0.9)) };
}

// ---- posts / keyword events --------------------------------------------------------------------------------------
export function onPost(W, post, { nowMs = Date.now() } = {}) {
  if (!post?.id || W.posts.has(post.id) || !Number.isFinite(post.postMs)) return [];
  W.posts.add(post.id);
  W.counts.posts += 1;
  const seenAtMs = post.seenAtMs ?? nowMs;
  const detectLagMs = post.detectLagMs ?? seenAtMs - post.postMs;
  if (post.provider === "api" || post.provider === "stream") W.detectLags.push(detectLagMs);
  const kws = extractKeywords(post);
  const rows = [
    {
      type: "elon_post",
      postId: post.id,
      postSec: Math.floor(post.postMs / 1000),
      postMs: post.postMs,
      createdAt: post.createdAt ?? null,
      kind: post.kind,
      text: String(post.text ?? "").slice(0, 1000),
      refs: (post.refs || []).map((r) => ({ type: r.type, id: r.id, text: r.text ? String(r.text).slice(0, 500) : null })),
      media: (post.media || []).map((m) => ({ type: m.type, url: m.url, alt: m.alt })),
      seenAtMs,
      detectLagMs,
      provider: post.provider ?? null,
      streamLagSec: streamLagSec(W, nowMs),
      keywords: kws.length,
    },
  ];
  for (const m of post.media || []) if (m?.url && (m.type === "photo" || m.type === "animated_gif")) W.visionQueue.push({ postId: post.id, url: m.url });
  rows.push(...addKeywords(W, post, kws, { nowMs, detectLagMs }));
  return rows;
}

// Keywords read later from the post's images (lib/elon-vision.mjs). `results`: [{ texts, characters, latencyMs, error, url }].
export function onVision(W, post, results, { nowMs = Date.now() } = {}) {
  const kws = extractKeywords({ id: post.id, kind: "post", text: "", vision: results }).filter((k) => k.reason === "vision");
  const detectLagMs = nowMs - post.postMs;
  const rows = addKeywords(W, post, kws, { nowMs, detectLagMs, vision: results.map((r) => ({ url: r.url, latencyMs: r.latencyMs, error: r.error, texts: r.texts.length, characters: r.characters.length })) });
  if (!kws.length) rows.push({ type: "elon_kw", postId: post.id, vision: results.map((r) => ({ url: r.url, latencyMs: r.latencyMs, error: r.error })), eventId: null });
  return rows;
}

function addKeywords(W, post, kws, { nowMs, detectLagMs, vision = null }) {
  const rows = [];
  const postSec = Math.floor(post.postMs / 1000);
  for (const k of kws) {
    const eventId = `${post.id}:${k.norm}`;
    if (W.events.has(eventId)) continue;
    const prev = W.recentNorms.get(k.norm);
    const repeat = prev !== undefined && postSec - prev < M.REPEAT_WINDOW_SEC;
    if (!repeat) W.recentNorms.set(k.norm, postSec);
    W.counts.kwEvents += 1;
    if (repeat) W.counts.repeats += 1;
    const E = { eventId, postId: post.id, postSec, postMs: post.postMs, seenMs: nowMs, detectLagMs, kw: k, repeat, matches: [], matched: new Set(), capped: 0, done: {} };
    W.events.set(eventId, E);
    const found = M.indexFind(W.idx, k, { fromSec: postSec - Math.max(W.cfg.beforeSec, M.GENERIC_WINDOW_SEC), toSec: Infinity });
    const before = found.filter((m) => m.entry.createSec < postSec && m.entry.createSec >= postSec - W.cfg.beforeSec);
    const after = found.filter((m) => m.entry.createSec >= postSec);
    const generic = M.isGeneric(found.map((m) => m.entry), postSec);
    rows.push({
      type: "elon_kw",
      eventId,
      postId: post.id,
      postSec,
      kw: k.kw,
      norm: k.norm,
      variants: k.variants,
      reason: k.reason,
      weight: k.weight,
      repeat,
      generic,
      detectLagMs,
      streamLagSec: streamLagSec(W, nowMs),
      matchesBefore: before.length,
      matchesAfterAtDetect: after.length,
      indexCoverSec: W.startSec !== null ? Math.max(0, postSec - W.startSec) : 0, // < 24 h: "generic" undercounts
      ...(vision ? { vision } : {}),
    });
    for (const m of before.slice(-W.cfg.beforeFollow)) rows.push(...addMatch(W, E, m.entry, m.kind, nowMs, true));
    for (const m of after) rows.push(...addMatch(W, E, m.entry, m.kind, nowMs, true));
  }
  return rows;
}

const eligible = (w) => w.mayhem !== true && !w.quoteMint;

function newWatchState(W, entry) {
  const startSec = Math.max(W.pumpSec, entry.createSec);
  return {
    mint: entry.mint,
    name: entry.name,
    symbol: entry.symbol,
    uri: entry.uri ?? null,
    creator: entry.creator ?? null,
    launcher: entry.launcher ?? null,
    createSec: entry.createSec,
    mayhem: entry.mayhem ?? null,
    quoteMint: null,
    events: new Set(),
    startSec,
    untilSec: startSec + W.cfg.followSec,
    rec: { mint: entry.mint, createSeen: true, createSec: entry.createSec, firstSec: null, mayhem: entry.mayhem ?? null, quoteMint: null, completeSec: null, resumed: false, path: null },
    wallets: new Set(),
    buyers: new Map(), // wallet -> last buy second
    flows: [], // [sec, +buy / -sell SOL]
    creatorSells: [],
    launcherSells: [],
    trades: 0,
    maxFill: 0,
    meta: { state: entry.uri && W.cfg.meta ? "pending" : "none", linked: [], elonStatus: null, twitter: null, website: null },
  };
}

function addMatch(W, E, entry, kind, nowMs, fromIndex) {
  if (E.matched.has(entry.mint)) return [];
  E.matched.add(entry.mint);
  W.counts.matches += 1;
  const side = entry.createSec >= E.postSec ? "after" : "before";
  let w = W.watches.get(entry.mint);
  let followed = !!w;
  if (!w && E.matches.length < W.cfg.maxFollowPerEvent && W.watches.size < W.cfg.maxWatches) {
    w = newWatchState(W, entry);
    W.watches.set(entry.mint, w);
    if (w.meta.state === "pending") W.metaQueue.push(entry.mint);
    followed = true;
  }
  if (followed) {
    W.counts.followed += 1;
    E.matches.push(entry.mint);
    w.events.add(E.eventId);
  } else {
    W.counts.notFollowed += 1;
    E.capped += 1;
  }
  const lag = streamLagSec(W, nowMs);
  const rows = [
    {
      type: "elon_match",
      eventId: E.eventId,
      postId: E.postId,
      mint: entry.mint,
      name: entry.name,
      symbol: entry.symbol,
      kind,
      side,
      createSec: entry.createSec,
      dtSec: entry.createSec - E.postSec,
      matchedAfterPostSec: r1(nowMs / 1000 - E.postSec),
      detectLagMs: E.detectLagMs,
      streamLagSec: lag,
      createRecvLagSec: entry.recvMs ? r1(entry.recvMs / 1000 - entry.createSec) : null,
      mayhem: entry.mayhem ?? null,
      creator: entry.creator ?? null,
      launcher: entry.launcher ?? null,
      uri: entry.uri ?? null,
      fromIndex,
      followed,
    },
  ];
  // variant "first": the first ELIGIBLE create after the post (ineligible ones leave a skip row)
  if (followed && side === "after" && !E.done.first) {
    const p = P.paperOpen(W.book, { eventId: E.eventId, variant: "first", mint: entry.mint, decisionMs: nowMs, detectLagMs: E.detectLagMs, streamLagSec: lag, info: { mayhem: w.mayhem, quoteMint: w.quoteMint } });
    if (p) E.done.first = true;
  }
  return rows;
}

// ---- pump stream ------------------------------------------------------------------------------------------------------
// c: lib/events.mjs parseCreate result.
export function onCreate(W, c, { nowMs = Date.now() } = {}) {
  if (!c?.mint) return [];
  W.counts.creates += 1;
  const sec = onChainSec(W, c.timestampSec, nowMs);
  const rows = noteEvent(W, sec, nowMs);
  const entry = M.indexAdd(W.idx, { mint: c.mint, name: typeof c.name === "string" ? c.name.slice(0, 64) : "", symbol: typeof c.symbol === "string" ? c.symbol.slice(0, 32) : "", uri: typeof c.uri === "string" ? c.uri.slice(0, 300) : null, creator: c.creator ?? null, launcher: c.user ?? null, createSec: sec, mayhem: createMayhem(c), recvMs: nowMs });
  if (!entry) return rows;
  for (const E of W.events.values()) {
    if (E.matched.has(entry.mint)) continue;
    if (sec > E.postSec + W.cfg.followSec || sec < E.postSec - W.cfg.beforeSec) continue;
    const kind = M.matchKind(E.kw, entry.keys);
    if (kind) rows.push(...addMatch(W, E, entry, kind, nowMs, false));
  }
  return rows;
}

// t: lib/events.mjs parseTrade result; raw: its payload buffer.
export function onTrade(W, t, raw, { nowMs = Date.now() } = {}) {
  if (!t?.mint) return [];
  W.counts.trades += 1;
  const sec = onChainSec(W, t.timestampMs, nowMs); // lib/events.mjs: "timestampMs" holds seconds
  const rows = noteEvent(W, sec, nowMs);
  const lag = nowMs / 1000 - sec;
  if (Number.isFinite(lag)) W.lags[W.lagN++ % LAG_N] = lag;
  const w = W.watches.get(t.mint);
  if (!w) return rows;
  const { fill: f0, tail, priced } = fillOf(t, raw);
  const fill = f0 !== null && f0 <= MAX_PLAUSIBLE_FILL ? f0 : null;
  if (tail?.mayhem === true && w.mayhem !== true) {
    w.mayhem = true;
    w.rec.mayhem = true;
    rows.push(...P.paperSkipMint(W.book, w.mint, "mayhem"));
  }
  if (tail?.quoteMint && !tail.solQuote && !w.quoteMint) {
    w.quoteMint = tail.quoteMint;
    w.rec.quoteMint = tail.quoteMint;
    rows.push(...P.paperSkipMint(W.book, w.mint, "quote"));
  }
  const res = priced ? t.reserves : null;
  const price = res ? (Number(res.vSol) / Number(res.vTok)) * 1e-3 : null;
  const sol = Number(t.solAmount) > 0 ? Number(t.solAmount) : 0;
  const newWallet = !!t.user && !w.wallets.has(t.user);
  if (t.user) w.wallets.add(t.user);
  if (w.rec.firstSec === null) w.rec.firstSec = sec;
  CP.pathTrade(W.ps, w.rec, { sec, fill, price, isBuy: !!t.isBuy, sol, newWallet });
  w.trades += 1;
  if (fill !== null && fill > w.maxFill) w.maxFill = fill;
  if (t.isBuy) w.buyers.set(t.user, sec);
  if (w.flows.length < 20_000) w.flows.push([sec, t.isBuy ? sol : -sol]);
  if (!t.isBuy && t.user && (t.user === w.creator || t.user === w.launcher)) {
    const s = { dtSec: sec - w.createSec, sol: r4(sol) };
    if (t.user === w.creator && w.creatorSells.length < 50) w.creatorSells.push(s);
    if (t.user === w.launcher && t.user !== w.creator && w.launcherSells.length < 50) w.launcherSells.push(s);
  }
  const completed = fill !== null && fill >= 100;
  P.paperTrade(W.book, w.mint, { sec, res: res ? { vSol: res.vSol, vTok: res.vTok } : null, completed, recvMs: nowMs });
  if (completed) {
    w.rec.completeSec = sec;
    rows.push(...finishWatch(W, w, "complete"));
  }
  return rows;
}

// ---- metadata ("linked") ------------------------------------------------------------------------------------------------
// meta: the parsed metadata JSON, or null with `error`.
export function onMeta(W, mint, { meta = null, error = null } = {}, { nowMs = Date.now() } = {}) {
  const w = W.watches.get(mint);
  if (!w) return [];
  if (!meta) {
    w.meta.state = "error";
    w.meta.error = error ?? "error";
    W.counts.metaFail += 1;
    return [];
  }
  W.counts.metaOk += 1;
  w.meta.state = "ok";
  w.meta.twitter = typeof meta.twitter === "string" ? meta.twitter.slice(0, 120) : null;
  w.meta.website = typeof meta.website === "string" ? meta.website.slice(0, 120) : null;
  for (const id of w.events) {
    const E = W.events.get(id);
    if (!E) continue;
    const info = M.linkedInfo(meta, E.postId);
    if (info.elonStatus) w.meta.elonStatus = info.elonStatus;
    if (!info.linked) continue;
    if (!w.meta.linked.includes(E.postId)) w.meta.linked.push(E.postId);
    W.counts.linked += 1;
    if (!E.done.linked) {
      const p = P.paperOpen(W.book, { eventId: E.eventId, variant: "linked", mint, decisionMs: nowMs, detectLagMs: E.detectLagMs, streamLagSec: streamLagSec(W, nowMs), info: { mayhem: w.mayhem, quoteMint: w.quoteMint } });
      if (p) E.done.linked = true;
    }
  }
  return [];
}

// ---- lead variants -------------------------------------------------------------------------------------------------------
export function leadScore(w, sinceSec) {
  let buyers = 0;
  for (const s of w.buyers.values()) if (s >= sinceSec) buyers += 1;
  let inflow = 0;
  for (const [s, v] of w.flows) if (s >= sinceSec) inflow += v;
  return { mint: w.mint, buyers, inflowSol: r4(inflow) };
}

function decideLead(W, E, variant, nowMs) {
  const rows = [];
  const cands = E.matches.map((m) => W.watches.get(m)).filter((w) => w && eligible(w));
  const order = P.leadOrder(cands.map((w) => leadScore(w, E.postSec)));
  const lag = streamLagSec(W, nowMs);
  const none = (v) => ({ type: "elon_paper", costsScheme: P.ELON_COSTS_SCHEME, eventId: E.eventId, variant: v, mint: null, skip: "no-candidate", decisionSec: r1(nowMs / 1000), detectLagMs: E.detectLagMs, streamLagSec: lag, netPct: null, final: "skipped" });
  if (!order.length) {
    rows.push(none(variant));
    if (variant === "lead30") rows.push(none("basket3"));
    return rows;
  }
  const top = order[0];
  P.paperOpen(W.book, { eventId: E.eventId, variant, mint: top.mint, decisionMs: nowMs, detectLagMs: E.detectLagMs, streamLagSec: lag, score: { ...top, cands: order.length }, info: {} });
  if (variant === "lead30") {
    const legs = order.slice(0, 3);
    for (const s of legs) P.paperOpen(W.book, { eventId: E.eventId, variant: "basket3", mint: s.mint, decisionMs: nowMs, detectLagMs: E.detectLagMs, streamLagSec: lag, buySol: W.cfg.buySol / legs.length, basket: `${E.eventId}:b3`, score: { ...s, legs: legs.length }, info: {} });
  }
  return rows;
}

// ---- watches ----------------------------------------------------------------------------------------------------------------
function finishWatch(W, w, final) {
  W.watches.delete(w.mint);
  W.counts.watchesDone += 1;
  const row = CP.pathRow(W.ps, w.rec, final, { endSec: final === "complete" ? w.rec.completeSec : W.pumpSec, streamSec: W.pumpSec, censusRev: null });
  const base = row ? { ...row } : { mint: w.mint, buckets: 0, holes: [], final };
  delete base.censusRev;
  delete base.type;
  return [
    {
      type: "elon_path",
      elonRev: ELON_REV,
      events: [...w.events],
      name: w.name,
      symbol: w.symbol,
      createSec: w.createSec,
      watchStartSec: w.startSec,
      maxFill: w.maxFill,
      trades: w.trades,
      wallets: w.wallets.size,
      creatorSells: w.creatorSells,
      launcherSells: w.launcherSells,
      meta: w.meta,
      linked: w.meta.linked.length > 0,
      ...base,
    },
  ];
}

// ---- the 1 s timer ------------------------------------------------------------------------------------------------------------
export function tick(W, { nowMs = Date.now() } = {}) {
  const rows = [];
  if (!W.gap && W.lastEventMs !== null && nowMs - W.lastEventMs >= W.cfg.gapSec * 1000) {
    W.gap = { fromMs: W.lastEventMs, hole: CP.openGapHole(W.ps, W.pumpSec) };
  }
  for (const E of W.events.values()) {
    for (const [v, s] of [["lead30", 30], ["lead60", 60]]) {
      if (!E.done[v] && nowMs >= E.postMs + s * 1000) {
        E.done[v] = true;
        rows.push(...decideLead(W, E, v, nowMs));
      }
    }
    if (nowMs > E.postMs + (W.cfg.followSec + 120) * 1000) W.events.delete(E.eventId);
  }
  for (const w of [...W.watches.values()]) if (W.pumpSec > w.untilSec) rows.push(...finishWatch(W, w, "follow"));
  const paper = P.paperTick(W.book);
  W.counts.paperRows += paper.length;
  rows.push(...paper);
  if (nowMs - W.lastEvictMs >= 60_000) {
    W.lastEvictMs = nowMs;
    if (W.pumpSec > 0) M.indexEvictBefore(W.idx, W.pumpSec - W.cfg.indexSec);
    for (const [n, s] of W.recentNorms) if (W.pumpSec - s > M.REPEAT_WINDOW_SEC) W.recentNorms.delete(n);
    for (const m of [...W.book.mints.keys()]) if (!W.watches.has(m)) P.paperForget(W.book, m);
    CP.trimHoles(W.ps, W.pumpSec);
    if (W.detectLags.length > 5000) W.detectLags.splice(0, W.detectLags.length - 5000);
  }
  return rows;
}

// The stop: partial paths, paper rows for open positions, an open gap.
export function finishAll(W, { nowMs = Date.now() } = {}) {
  const rows = [];
  for (const w of [...W.watches.values()]) rows.push(...finishWatch(W, w, "shutdown"));
  rows.push(...P.paperFinishAll(W.book, "shutdown"));
  if (W.gap) {
    rows.push({ type: "elon_gap", source: "pump", startedAt: new Date(W.gap.fromMs).toISOString(), endedAt: null, sec: r1((nowMs - W.gap.fromMs) / 1000), open: true, watches: 0 });
    W.gap = null;
  }
  return rows;
}

export function stats(W) {
  const d = [...W.detectLags].sort((a, b) => a - b);
  return {
    ...W.counts,
    events: W.events.size,
    watches: W.watches.size,
    indexSize: M.indexSize(W.idx),
    indexEvicted: W.idx.evicted,
    pathBuffers: W.ps.buffers,
    pathBuckets: W.ps.buckets,
    positions: W.book.positions.length,
    streamLag: lagStats(W),
    detectLagMs: { n: d.length, p50: P.quantile(d, 0.5), p90: P.quantile(d, 0.9), last: W.detectLags[W.detectLags.length - 1] ?? null },
  };
}
