// Statistics for the graduation shadow report. Pure functions so they can be tested offline.
// Rules baked in: bootstrap CI only for n >= 30; no profitability conclusion below n = 200.

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// Profit factor: gross wins / |gross losses|. Infinity when there are no losses, null when no wins.
export function profitFactor(xs) {
  let win = 0;
  let loss = 0;
  for (const x of xs) {
    if (x > 0) win += x;
    else if (x < 0) loss += -x;
  }
  if (loss === 0) return win > 0 ? Infinity : null;
  return win / loss;
}
// Max drawdown of the cumulative net curve, in the same units as the inputs (percent).
export function maxDrawdown(xs) {
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of xs) {
    cum += x;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return dd;
}
// Deterministic RNG so a report is reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Percentile bootstrap CI of the mean. n < 30 -> null (no CI on tiny samples).
export function bootstrapCI(xs, { resamples = 2000, alpha = 0.05, seed = 42 } = {}) {
  if (xs.length < 30) return null;
  const rnd = mulberry32(seed);
  const means = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * means.length)];
  const hi = means[Math.floor((1 - alpha / 2) * means.length)];
  return { lo, hi };
}
// One variant's summary. `nets` are net percentages (net SOL / buy SOL * 100).
export function summarize(nets, { reasons = [] } = {}) {
  const n = nets.length;
  if (!n) return { n: 0, note: "no data" };
  const share = (r) => Math.round((reasons.filter((x) => x === r).length / n) * 1000) / 10;
  return {
    n,
    winPct: Math.round((nets.filter((x) => x > 0).length / n) * 1000) / 10,
    meanPct: Math.round(mean(nets) * 100) / 100,
    medianPct: Math.round(median(nets) * 100) / 100,
    profitFactor: profitFactor(nets),
    maxDdPct: Math.round(maxDrawdown(nets) * 100) / 100,
    tpPct: share("tp"),
    slPct: share("sl"),
    timeoutPct: share("timeout"),
    stuckPct: share("stuck"),
    ci95: bootstrapCI(nets),
  };
}
