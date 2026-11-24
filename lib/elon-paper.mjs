// elon-watch (KODING #25): paper pricing of a memecoin bought right after an @elonmusk post.
// RESEARCH / PAPER ONLY: no order, no key, no RPC. Pure except the injected clock / rng.
//
// Price model (both the offline backtest and the live paper book):
//   entry  the curve state (virtual reserves) of the first trade at or after decision + execution
//          delay; tokens = the constant-product output for buySol WITHOUT the pump 1% fee (the fee is
//          charged by the cost model, as lib/gshadow.mjs ammEntryTokens does)
//   exit   the constant-product SOL output for those tokens at the exit state (sell impact)
//   ratio  exit SOL / buySol (curve impact of BOTH legs inside); net = lib/pessimistic.mjs
//          pessimisticRoundTrip (pump 100 + 100 bps, slippage 50 + size bps, two tx fees) — the
//          shadow lab's v5 cost model, curve exits.
// A curve that completed before the exit is priced at the standard curve end (STANDARD_CURVE_END,
// exitVenue "curve-end"); the AMM price right after a migration is close to it, but it is NOT a pool
// quote. Never mix rows of different costsScheme.
import { pessimisticRoundTrip, executionDelay, SHADOW_COSTS_SCHEME } from "./pessimistic.mjs";

export const ELON_COSTS_SCHEME = `elon-v1: constant-product curve impact on both legs + pessimisticRoundTrip of ${SHADOW_COSTS_SCHEME.split(":")[0]} (pump 100+100 bps, slip 50+size bps, 2 tx fees); curve completed before the exit -> standard curve end price`;

// Virtual constant product of a standard pump.fun curve: 30 SOL x 1.073e9 tokens (lamports x raw).
export const CURVE_K = 30e9 * 1.073e15;
export const STANDARD_CURVE_END = 4.1088e-7; // SOL per whole token at completion (lib/mint-census.mjs)

// SOL per whole token of reserves { vSol (lamports), vTok (raw) }.
export const priceOf = (r) => (Number(r.vSol) / Number(r.vTok)) * 1e-3;

// A standard curve's reserves at a price (p = vSol^2 * 1e-3 / K).
export function reservesFromPrice(p) {
  if (!(p > 0)) return null;
  const vSol = Math.sqrt((CURVE_K * p) / 1e-3);
  return { vSol, vTok: CURVE_K / vSol };
}

// A standard SOL curve's price at a fill % (real SOL = fill * 85 SOL, virtual = real + 30 SOL).
export function priceFromFill(fill) {
  if (!Number.isFinite(fill) || fill < 0) return null;
  const vSol = ((fill / 100) * 85 + 30) * 1e9;
  return (vSol * vSol * 1e-3) / CURVE_K;
}

export function buyTokens(r, buySol) {
  const b = Number(buySol) * 1e9;
  const vSol = Number(r.vSol);
  const vTok = Number(r.vTok);
  if (!(b > 0 && vSol > 0 && vTok > 0)) return 0;
  return (vTok * b) / (vSol + b);
}

export function sellSol(r, tokens) {
  const vSol = Number(r.vSol);
  const vTok = Number(r.vTok);
  if (!(tokens > 0 && vSol > 0 && vTok > 0)) return 0;
  return (vSol * tokens) / (vTok + tokens) / 1e9;
}

const round = (x, p) => Math.round(x * p) / p;

// Paper result of a round trip: entry reserves -> exit reserves.
export function paperResult(entryRes, exitRes, buySol, { delayMs = 0 } = {}) {
  const tokens = buyTokens(entryRes, buySol);
  const ratio = sellSol(exitRes, tokens) / buySol;
  const rt = pessimisticRoundTrip({ buySol, ratio, delayMs });
  return { ratio: round(ratio, 1e6), netSol: round(rt.netPnl, 1e9), netPct: round((rt.netPnl / buySol) * 100, 100), slipBps: rt.slipBps };
}

// ---- offline: one entry on a census_path row ----------------------------------------------------------
// `row`: census_path (lib/census-path.mjs). `entryFromSec`: absolute second; the entry is the close
// (pc) of the first bucket at or after it. `horizons`: seconds after the entry. `maxSec`: the window of
// the max multiple. Returns null fields where the path does not cover a moment (after endT, or no
// priced bucket). Exits read the last priced bucket at or before the exit second; a completion before
// it gives the curve end price ("curve-end").
export function evalPathEntry(row, { entryFromSec, buySol, horizons = [60, 300, 900, 1800], maxSec = 1800 }) {
  const out = { entrySec: null, entryPrice: null, exits: {}, maxMult: null, maxRatio: null, maxNetPct: null, maxAtSec: null, holes: false, why: null };
  if (!row?.t?.length) return { ...out, why: "no-path" };
  if (row.mayhem === true) return { ...out, why: "mayhem" };
  if (row.quoteMint) return { ...out, why: "quote" };
  const t0 = row.t0;
  const endAbs = t0 + (row.endT ?? row.t[row.t.length - 1]);
  const completeAbs = row.completeSec !== null && row.completeSec !== undefined ? t0 + row.completeSec : null;
  let i = 0;
  while (i < row.t.length && (t0 + row.t[i] < entryFromSec || row.pc[i] === null)) i += 1;
  if (i >= row.t.length) return { ...out, why: entryFromSec > endAbs ? "after-path" : "no-trade-after" };
  const entryAbs = t0 + row.t[i];
  const entryPrice = row.pc[i];
  const entryRes = reservesFromPrice(entryPrice);
  out.entrySec = entryAbs;
  out.entryPrice = entryPrice;
  for (const h of horizons) {
    const exitAbs = entryAbs + h;
    let res = null;
    let venue = "curve";
    if (completeAbs !== null && completeAbs <= exitAbs) {
      res = reservesFromPrice(STANDARD_CURVE_END);
      venue = "curve-end";
    } else if (exitAbs <= endAbs) {
      let p = null;
      for (let j = i; j < row.t.length && t0 + row.t[j] <= exitAbs; j++) if (row.pc[j] !== null) p = row.pc[j];
      res = reservesFromPrice(p);
    }
    out.exits[h] = res ? { ...paperResult(entryRes, res, buySol), venue } : null;
  }
  // max multiple within maxSec: the bucket close prices and the highest fill of each bucket
  let pMax = entryPrice;
  let atMax = entryAbs;
  for (let j = i; j < row.t.length && t0 + row.t[j] <= entryAbs + maxSec; j++) {
    const ph = row.h[j] !== null ? priceFromFill(row.h[j]) : null;
    const p = Math.max(row.pc[j] ?? 0, ph ?? 0);
    if (p > pMax) {
      pMax = p;
      atMax = t0 + row.t[j];
    }
  }
  if (completeAbs !== null && completeAbs <= entryAbs + maxSec && STANDARD_CURVE_END > pMax) {
    pMax = STANDARD_CURVE_END;
    atMax = completeAbs;
  }
  const best = paperResult(entryRes, reservesFromPrice(pMax), buySol);
  out.maxMult = round(pMax / entryPrice, 1e4);
  out.maxRatio = best.ratio;
  out.maxNetPct = best.netPct;
  out.maxAtSec = atMax - entryAbs;
  out.holes = (row.holes || []).some(([a, b]) => t0 + b >= entryAbs && t0 + a <= entryAbs + maxSec);
  return out;
}

// ---- live: the paper book ------------------------------------------------------------------------------
// All entry / exit prices are taken on ON-CHAIN time (the trade event's own timestamp, whole seconds),
// never on the local receive time: a public stream can deliver events 7-100 s late (#21b), and a
// price "seen" late is still the price of its on-chain second.
//   decision   local wall clock ms when the variant rule fired (what the bot knew then)
//   entryAt    decision + execution delay (lib/pessimistic.mjs executionDelay, 200-800 ms)
//   entry      the first trade of the mint with on-chain second >= ceil(entryAt) that carries reserves
//              (a trade inside the second of entryAt might be before it: excluded, pessimistic)
//   exit h     the state after the last trade with on-chain second <= entrySec + h; priced once the
//              stream clock (newest on-chain second seen on the pump stream) has passed that second; a
//              curve completed at or before it -> the standard curve end ("curve-end")
//   unfilled   no priced trade within maxWaitSec of entryAt (by the stream clock)
// Rows carry streamLagSec at the decision (local now - stream clock) and entryLagSec (receive time of
// the entry trade - its on-chain second). Skips (row with `skip`, no position): mayhem curve, a curve
// quoted in another mint.
export function createPaperBook({ buySol, horizonsSec = [300, 900], maxWaitSec = 60, rng = Math.random, delayMs = null, histMax = 20_000 } = {}) {
  const book = { buySol, horizonsSec, maxWaitSec, histMax, positions: [], mints: new Map(), rows: [], n: 0, streamSec: 0 };
  book.delay = () => (delayMs !== null ? delayMs : executionDelay({ rng }));
  return book;
}

const r1 = (x) => Math.round(x * 10) / 10;
const sec = (ms) => Math.round(ms / 100) / 10;

function baseRow(p) {
  return {
    type: "elon_paper",
    costsScheme: ELON_COSTS_SCHEME,
    eventId: p.eventId,
    variant: p.variant,
    mint: p.mint,
    ...(p.basket ? { basket: p.basket } : {}),
    buySol: p.buySol,
    decisionSec: sec(p.decisionMs),
    detectLagMs: p.detectLagMs ?? null,
    streamLagSec: p.streamLagSec ?? null,
    ...(p.score ? { score: p.score } : {}),
  };
}

function mintOf(book, mint) {
  let m = book.mints.get(mint);
  if (!m) {
    m = { hist: [], completeSec: null };
    book.mints.set(mint, m);
  }
  return m;
}

// The stream clock moved (any pump event of any mint): exits and waits are judged against it.
export function paperClock(book, streamSec) {
  if (Number.isFinite(streamSec) && streamSec > book.streamSec) book.streamSec = streamSec;
}

// One trade of a followed mint. `sec`: its on-chain second; `res` null = no reserve snapshot;
// `recvMs`: local receive time (the entry's own lag only); `completed`: this trade completed the curve.
export function paperTrade(book, mint, { sec: s, res = null, completed = false, recvMs = null }) {
  if (!Number.isFinite(s)) return;
  paperClock(book, s);
  const m = mintOf(book, mint);
  const priced = !!res && Number(res.vSol) > 0 && Number(res.vTok) > 0;
  if (priced) {
    const r = { vSol: Number(res.vSol), vTok: Number(res.vTok) };
    let i = m.hist.length; // on-chain order: an out-of-order event goes to its place (after same-second ones)
    while (i > 0 && m.hist[i - 1].sec > s) i -= 1;
    m.hist.splice(i, 0, { sec: s, res: r });
    if (m.hist.length > book.histMax) m.hist.shift();
  }
  if (completed && (m.completeSec === null || s < m.completeSec)) m.completeSec = s;
  if (!priced) return;
  for (const p of book.positions) {
    if (p.state !== "pending" || p.mint !== mint || s < p.entryFromSec) continue;
    p.state = "open";
    p.entrySec = s;
    p.entryRes = { vSol: Number(res.vSol), vTok: Number(res.vTok) };
    p.entryLagSec = recvMs !== null ? r1(recvMs / 1000 - s) : null;
  }
}

// Open a position (or write a skip row). info: { mayhem, quoteMint }. Returns the position or null.
export function paperOpen(book, { eventId, variant, mint, decisionMs, detectLagMs = null, streamLagSec = null, info = {}, buySol = book.buySol, basket = null, score = null }) {
  const p = { id: ++book.n, eventId, variant, mint, decisionMs, detectLagMs, streamLagSec, buySol, basket, score, state: "pending", exits: {} };
  if (info.mayhem === true || info.quoteMint) {
    book.rows.push({ ...baseRow(p), skip: info.mayhem === true ? "mayhem" : "quote", netPct: null, final: "skipped" });
    return null;
  }
  p.delayMs = book.delay();
  p.entryAtMs = decisionMs + p.delayMs;
  p.entryFromSec = Math.ceil(p.entryAtMs / 1000);
  // a trade at or after entryFromSec may already be known (the stream clock can be ahead of a decision)
  const h = book.mints.get(mint)?.hist.find((x) => x.sec >= p.entryFromSec);
  if (h) {
    p.state = "open";
    p.entrySec = h.sec;
    p.entryRes = h.res;
    p.entryLagSec = null;
  }
  book.positions.push(p);
  return p;
}

function exitOf(book, p, exitSec) {
  const m = book.mints.get(p.mint);
  if (m && m.completeSec !== null && m.completeSec <= exitSec)
    return { ...paperResult(p.entryRes, reservesFromPrice(STANDARD_CURVE_END), p.buySol, { delayMs: p.delayMs }), venue: "curve-end", exitSec: m.completeSec };
  let last = null;
  for (const x of m?.hist || []) {
    if (x.sec > exitSec) break;
    last = x;
  }
  if (!last) return null;
  return { ...paperResult(p.entryRes, last.res, p.buySol, { delayMs: p.delayMs }), venue: "curve", exitSec: last.sec };
}

function rowOf(book, p, final) {
  const ex = {};
  for (const h of book.horizonsSec) ex[h] = p.exits[h] ?? null;
  return {
    ...baseRow(p),
    entrySec: p.entrySec ?? null,
    entryLagSec: p.entryLagSec ?? null,
    entryPrice: p.entryRes ? Number(priceOf(p.entryRes).toPrecision(6)) : null,
    delayMs: p.delayMs,
    priceSource: "onchain-trade",
    exits: ex,
    netPct: ex[book.horizonsSec[0]]?.netPct ?? null,
    final,
  };
}

const unfilledRow = (p, final) => ({ ...baseRow(p), delayMs: p.delayMs, entrySec: null, priceSource: "onchain-trade", exits: {}, netPct: null, final });

// Prices the exits that are due on the stream clock; returns the finished rows (and skip rows).
export function paperTick(book) {
  const out = [...book.rows.splice(0)];
  const clock = book.streamSec;
  for (const p of book.positions) {
    if (p.state === "pending" && clock > p.entryFromSec + book.maxWaitSec) {
      p.state = "done";
      out.push(unfilledRow(p, "unfilled"));
      continue;
    }
    if (p.state !== "open") continue;
    for (const h of book.horizonsSec) if (!(h in p.exits) && clock > p.entrySec + h) p.exits[h] = exitOf(book, p, p.entrySec + h);
    if (book.horizonsSec.every((h) => h in p.exits)) {
      p.state = "done";
      out.push(rowOf(book, p, "done"));
    }
  }
  book.positions = book.positions.filter((p) => p.state !== "done");
  return out;
}

// The stop: every live position gets a row; horizons not reached stay null.
export function paperFinishAll(book, final = "shutdown") {
  const out = [...book.rows.splice(0)];
  for (const p of book.positions) out.push(p.state === "pending" ? unfilledRow(p, final) : rowOf(book, p, final));
  book.positions = [];
  return out;
}

// A mint turned out not tradable after the decision (a trade tail showed another quote mint, or mayhem):
// its positions become skip rows (no result), whatever their state.
export function paperSkipMint(book, mint, skip) {
  const out = [];
  for (const p of book.positions) if (p.mint === mint) out.push({ ...baseRow(p), skip, delayMs: p.delayMs, netPct: null, final: "skipped" });
  book.positions = book.positions.filter((p) => p.mint !== mint);
  return out;
}

// Drop the trade history of a mint no open position needs.
export function paperForget(book, mint) {
  if (!book.positions.some((p) => p.mint === mint)) book.mints.delete(mint);
}

// ---- summaries (backtest, report) -------------------------------------------------------------------------
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1) + 0.5)));
  return sorted[i];
}

// values -> { n, mean, median, posShare, best, worst, ci } (ci = bootstrap of the mean, only at n >= 30).
export function distSummary(values, { bootstrap = null, minCi = 30 } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  const n = v.length;
  if (!n) return { n: 0, mean: null, median: null, posShare: null, best: null, worst: null, ci: null };
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / n;
  return {
    n,
    mean: round(mean, 100),
    median: round(quantile(s, 0.5), 100),
    posShare: round(v.filter((x) => x > 0).length / n, 1000),
    best: s[n - 1],
    worst: s[0],
    ci: n >= minCi && bootstrap ? bootstrap(v) : null,
  };
}

// lead30 / lead60 / basket3 score: unique buyers since the post, tie -> SOL inflow (buys - sells).
export function leadOrder(cands) {
  return [...cands].sort((a, b) => b.buyers - a.buyers || b.inflowSol - a.inflowSol || (a.mint < b.mint ? -1 : 1));
}
