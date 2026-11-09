// Research statistics: bootstrap confidence intervals, time-based splits, variant ranking.
//
// The rule the whole lab is built around: a variant only "wins" if, on data that was NOT used
// for tuning, the lower bound of the bootstrap CI of the mean return is still above zero and
// there are at least `minTrades` trades. Anything else means "no stable edge" — that is the
// default outcome, not an exception.
import { statsOf } from "./strategy.mjs";

// Deterministic PRNG so a replay can be reproduced exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile bootstrap of the mean.
export function bootstrapCI(values, { resamples = 2000, alpha = 0.05, seed = 42 } = {}) {
  const n = values.length;
  if (!n) return { n: 0, mean: 0, lo: 0, hi: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;

  const rand = mulberry32(seed);
  const means = new Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[Math.floor(rand() * n)];
    means[r] = s / n;
  }
  means.sort((a, b) => a - b);
  const pick = (q) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))];
  return {
    n,
    mean: Math.round(mean * 1000) / 1000,
    lo: Math.round(pick(alpha / 2) * 1000) / 1000,
    hi: Math.round(pick(1 - alpha / 2) * 1000) / 1000,
  };
}

// Split trades by time: first `fraction` (tuning) and the rest (hold-out test).
export function splitByTime(trades, fraction = 0.7) {
  const sorted = trades.slice().sort((a, b) => (a.exitTs || 0) - (b.exitTs || 0));
  const cut = Math.floor(sorted.length * fraction);
  return { tuning: sorted.slice(0, cut), test: sorted.slice(cut) };
}

const pcts = (trades) => trades.map((t) => t.pnlPct);

// Per-variant evaluation on the hold-out part + the tuning part for reference.
export function evaluateVariant(name, trades, { testFraction = 0.7, minTrades = 300, resamples = 2000, seed = 42 } = {}) {
  const { tuning, test } = splitByTime(trades, testFraction);
  const ci = bootstrapCI(pcts(test), { resamples, seed });
  const st = statsOf(test);
  const tuneCi = bootstrapCI(pcts(tuning), { resamples, seed });

  const pass = test.length >= minTrades && ci.lo > 0;
  return {
    variant: name,
    nTuning: tuning.length,
    nTest: test.length,
    tuning: { meanPct: Math.round(tuneCi.mean * 100) / 100, lo: Math.round(tuneCi.lo * 100) / 100 },
    test: {
      ...st,
      meanPct: Math.round(ci.mean * 100) / 100,
      ciLo: Math.round(ci.lo * 100) / 100,
      ciHi: Math.round(ci.hi * 100) / 100,
    },
    reason: pass
      ? null
      : test.length < minTrades
        ? `only ${test.length}/${minTrades} test trades`
        : `CI lower bound ${ci.lo.toFixed(2)}% <= 0`,
    pass,
  };
}

// Pick the stop-loss variant with the best mean on the TUNING data only.
export function chooseByTuning(results) {
  return results
    .filter((r) => r.nTuning > 0)
    .slice()
    .sort((a, b) => b.tuning.meanPct - a.tuning.meanPct)[0];
}

// ---- sensitivity ------------------------------------------------------------
// Recompute a trade's net return for a different slippage assumption, using the gross ratio the
// journal already stored. Fees (1% in + 1% out) and the tx cost stay as they were measured.
export function netPctAtSlippage(trade, slippageBps, { feeBps = 100, txSol = 0.00025 } = {}) {
  const buySol = Number(trade.buySol) || 0.02;
  const gross = Number(trade.grossRatio) || Number(trade.ratio) || 1;
  const grossOut = buySol * gross;
  const fees = (buySol * feeBps) / 1e4 + (grossOut * feeBps) / 1e4;
  const slip = ((buySol + grossOut) * slippageBps) / 1e4;
  const net = grossOut - buySol - fees - slip - txSol;
  return Math.round((net / buySol) * 10000) / 100;
}

export function slippageSensitivity(trades, bpsList = [50, 100, 200]) {
  return bpsList.map((bps) => {
    const values = trades.map((t) => netPctAtSlippage(t, bps));
    const sorted = values.slice().sort((a, b) => a - b);
    const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    return {
      slippageBps: bps,
      n: values.length,
      meanPct: Math.round(mean * 100) / 100,
      medianPct: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100 : 0,
      wins: values.filter((v) => v > 0).length,
    };
  });
}

// Group "A@600" style variant names into a latency table (lab can run a latency grid).
export function latencySensitivity(tradesByVariant) {
  const rows = [];
  for (const [name, trades] of tradesByVariant.entries()) {
    const m = name.match(/^(.+)@(\d+)$/);
    if (!m) continue;
    const values = trades.map((t) => Number(t.pnlPct) || 0);
    const sorted = values.slice().sort((a, b) => a - b);
    rows.push({
      base: m[1],
      latencyMs: Number(m[2]),
      n: values.length,
      meanPct: values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : 0,
      medianPct: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100 : 0,
    });
  }
  return rows.sort((a, b) => (a.base === b.base ? a.latencyMs - b.latencyMs : a.base.localeCompare(b.base)));
}

// ---- anti-peeking: freeze and only judge what happens afterwards --------------
// A frozen record locks the chosen variant + parameters at a timestamp. Only trades CLOSED
// after that timestamp count, the CI is 99%, and the bar is the usual 300 trades.
export function evaluateFrozen(trades, frozen, { minTrades = 300, resamples = 4000, alpha = 0.01 } = {}) {
  const frozenAt = Number(frozen?.frozenAt ?? frozen?.at ?? 0);
  const fresh = trades.filter((t) => Number(t.exitTs || 0) > frozenAt);
  const ci = bootstrapCI(fresh.map((t) => Number(t.pnlPct) || 0), { resamples, alpha });
  const st = statsOf(fresh);
  const pass = fresh.length >= minTrades && ci.lo > 0;
  return {
    variant: frozen?.variant || null,
    frozenAt,
    n: fresh.length,
    minTrades,
    alpha,
    stats: { ...st, meanPct: ci.mean, ciLo: ci.lo, ciHi: ci.hi },
    pass,
    reason: pass
      ? null
      : fresh.length < minTrades
        ? `only ${fresh.length}/${minTrades} trades closed after the freeze`
        : `${(1 - alpha) * 100}% CI lower bound ${ci.lo.toFixed(2)}% <= 0`,
  };
}

