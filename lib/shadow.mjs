// Shadow variants V0-V7 (step 4): paper strategies on the SAME token feed, one virtual wallet per
// variant. Entry-filter variants (V0-V3, V6, V7) reuse the main bot's exits. V4 (partial 50% @1.5x
// then trailing) and V5 (timeout 180 s) REPLAY the exit on the 1/s hold tick trajectory; they use
// only FRESH ticks (stale=false) or account-confirmed ticks — positions without them are "no data".
import { bootstrapCI } from "./research.mjs";
import { roundTripCosts } from "./fees.mjs";

export const LAUNCH_RAW = 30e9 / 1.073e15;

export const SHADOW_VARIANTS = [
  { id: "V0", label: "baseline" },
  { id: "V1", label: "standard <=1.2x floor" },
  { id: "V2", label: "skip holders>=9" },
  { id: "V3", label: "no mayhemMode" },
  { id: "V4", label: "standard: 50% @1.5x + trailing 30%" },
  { id: "V5", label: "standard: timeout 180s" },
  { id: "V6", label: "skip creator>=4/30m" },
  { id: "V7", label: "V1+V2+V3" },
];

function ctxOf(t) {
  return {
    entryPrice: Number(t.entrySol),
    mayhemMode: t.mayhemMode === undefined ? null : t.mayhemMode,
    holdersAtEntry: t.holdersAtEntry === undefined || t.holdersAtEntry === null ? null : Number(t.holdersAtEntry),
    creatorLaunches30m: t.creatorLaunches30m === undefined || t.creatorLaunches30m === null ? null : Number(t.creatorLaunches30m),
  };
}

const isStandard = (c) => c.mayhemMode !== true;

function entryPredicates(floorPrice) {
  const f = floorPrice > 0 ? floorPrice : LAUNCH_RAW;
  const V1 = (c) => isStandard(c) && Number.isFinite(c.entryPrice) && c.entryPrice <= 1.2 * f;
  const V2 = (c) => (c.holdersAtEntry ?? 0) < 9;
  const V3 = (c) => isStandard(c);
  return {
    V1,
    V2,
    V3,
    V6: (c) => (c.creatorLaunches30m ?? 0) < 4,
    V7: (c) => V1(c) && V2(c) && V3(c),
  };
}

// ---- exit replays on the hold tick trajectory (V4 / V5) ----------------------

// V5: same TP/SL as baseline, but the timeout is 180 s for standard tokens. The replay walks the
// FRESH hold samples; if the trajectory ends before an exit is reached, it is "no data" (we do NOT
// use hindsight peak/best5m).
function replayTimeout(samples, { takeProfit, stopLoss, timeoutSec }) {
  const fresh = samples.filter((s) => s.stale !== true && Number.isFinite(s.ratio));
  if (!fresh.length) return { noData: true };
  for (const s of fresh) {
    if (s.ratio >= takeProfit) return { exitClass: "take-profit", ratio: s.ratio };
    if (s.ratio <= stopLoss) return { exitClass: "stop-loss", ratio: s.ratio };
  }
  const last = fresh[fresh.length - 1];
  if (last.t >= timeoutSec) return { exitClass: "timeout", ratio: last.ratio };
  return { noData: true }; // trajectory ended before 180 s without TP/SL
}

// V4: sell 50% at 1.5x, trail the rest at 30% below the running peak. The combined ratio is the
// volume-weighted average of the two legs (0.5*partial + 0.5*trail). Costs use 3 legs (buy + two
// sells). Missing / stale-only trajectory -> "no data".
function replayPartialTrail(samples, { partialAt = 1.5, trailPct = 0.3, stopLoss, timeoutSec }) {
  const fresh = samples.filter((s) => s.stale !== true && Number.isFinite(s.ratio));
  if (!fresh.length) return { noData: true };
  let peak = 1;
  let partialDone = false;
  let partialRatio = null;
  for (const s of fresh) {
    const r = s.ratio;
    if (r > peak) peak = r;
    if (!partialDone) {
      if (r >= partialAt) {
        partialDone = true;
        partialRatio = r;
        peak = r;
        continue;
      }
      if (r <= stopLoss) return { exitClass: "stop-loss", ratio: r };
      if (s.t >= timeoutSec) return { exitClass: "timeout", ratio: r };
    } else {
      const trail = peak * (1 - trailPct);
      if (r <= trail + 1e-9) return { exitClass: "take-profit", ratio: 0.5 * partialRatio + 0.5 * r };
      if (s.t >= timeoutSec + 180) return { exitClass: "timeout", ratio: 0.5 * partialRatio + 0.5 * r };
    }
  }
  return { noData: true };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[Math.floor(s.length / 2) - 1] + s[Math.floor(s.length / 2)]) / 2;
};

function exitClassOf(t) {
  const r = String(t.exitReason || "");
  if (r.startsWith("take-profit")) return "take-profit";
  if (r.startsWith("stop-loss")) return "stop-loss";
  if (r.startsWith("timeout")) return "timeout";
  return "other";
}

function statsFor(variant, outcomes, { total, skippedOutcomes, noData, minNForCI }) {
  const n = outcomes.length;
  const wins = outcomes.filter((o) => Number(o.pnlSol) > 0);
  const netPcts = outcomes
    .map((o) => (Number(o.buySol) > 0 ? (Number(o.pnlSol) / Number(o.buySol)) * 100 : null))
    .filter((x) => Number.isFinite(x));
  const meanNetPct = netPcts.length ? netPcts.reduce((a, b) => a + b, 0) / netPcts.length : null;
  const grossWin = wins.reduce((a, o) => a + Number(o.pnlSol), 0);
  const grossLoss = outcomes.filter((o) => Number(o.pnlSol) < 0).reduce((a, o) => a + Math.abs(Number(o.pnlSol)), 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const enough = netPcts.length >= minNForCI;
  const ci = enough ? bootstrapCI(netPcts, { resamples: 2000, seed: 42 }) : null;
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const o of outcomes) {
    eq += Number(o.pnlSol) || 0;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const share = (cls) => (n ? outcomes.filter((o) => o.exitClass === cls).length / n : null);
  const skipped = total - n - noData;
  const skippedMean = skippedOutcomes.length
    ? skippedOutcomes.reduce((a, o) => a + (Number(o.buySol) > 0 ? (Number(o.pnlSol) / Number(o.buySol)) * 100 : 0), 0) / skippedOutcomes.length
    : null;
  return {
    id: variant.id,
    label: variant.label,
    n,
    noData,
    noDataShare: n + noData > 0 ? noData / (n + noData) : null,
    winRate: n ? wins.length / n : null,
    meanNetPct: meanNetPct === null ? null : Math.round(meanNetPct * 100) / 100,
    medianNetPct: median(netPcts) === null ? null : Math.round(median(netPcts) * 100) / 100,
    pf: Number.isFinite(pf) ? Math.round(pf * 100) / 100 : pf,
    ciLo: ci ? ci.lo : null,
    ciHi: ci ? ci.hi : null,
    enough,
    maxDDSol: Math.round(maxDD * 1e6) / 1e6,
    tpShare: share("take-profit"),
    slShare: share("stop-loss"),
    timeoutShare: share("timeout"),
    skipped,
    skipShare: total ? skipped / total : null,
    skippedMeanNetPct: skippedMean === null ? null : Math.round(skippedMean * 100) / 100,
    netPcts, // per-trade net% values, for a Bonferroni-adjusted CI in the final report
    verdict: null,
  };
}

// Evaluate every variant over the main bot's closed trades + (for V4/V5) the hold tick trajectories.
//   trades: [{ pnlSol, buySol, ratio, exitReason, entrySol, mayhemMode, holdersAtEntry,
//              creatorLaunches30m, sellAt|ts, mint }]
//   opts.ticks: Map<mint, [{ t, ratio, stale }]>  (hold-phase samples, t = seconds since entry)
export function evaluateShadow(trades, opts = {}) {
  const {
    floorPrice = LAUNCH_RAW,
    minNForCI = 30,
    minNForVerdict = 200,
    ticks = new Map(),
    takeProfit = 2.0,
    stopLoss = 0.5,
    timeoutSec = 120,
    costFn = roundTripCosts,
  } = opts;

  const sorted = trades
    .slice()
    .sort((a, b) => String(a.sellAt || a.ts || "").localeCompare(String(b.sellAt || b.ts || "")));
  const total = sorted.length;
  const pred = entryPredicates(floorPrice);
  const baseOutcome = (t) => ({ pnlSol: Number(t.pnlSol), buySol: Number(t.buySol), ratio: Number(t.ratio), exitClass: exitClassOf(t) });
  const allOutcomes = sorted.map(baseOutcome);

  const results = [];
  for (const v of SHADOW_VARIANTS) {
    if (v.id === "V0") {
      results.push(statsFor(v, allOutcomes, { total, skippedOutcomes: [], noData: 0, minNForCI }));
    } else if (v.id === "V4" || v.id === "V5") {
      const entered = [];
      let noData = 0;
      for (const t of sorted) {
        if (!isStandard(ctxOf(t))) continue;
        const samples = ticks.get(t.mint) || [];
        const res = v.id === "V5"
          ? replayTimeout(samples, { takeProfit, stopLoss, timeoutSec: 180 })
          : replayPartialTrail(samples, { stopLoss, timeoutSec });
        if (res.noData) {
          noData += 1;
          continue;
        }
        const buySol = Number(t.buySol);
        const costs = costFn({ buySol, ratio: res.ratio, legs: v.id === "V4" ? 3 : 2 });
        entered.push({ pnlSol: costs.netPnl, buySol, ratio: res.ratio, exitClass: res.exitClass });
      }
      const skippedOutcomes = sorted.filter((t) => !isStandard(ctxOf(t))).map(baseOutcome);
      results.push(statsFor(v, entered, { total, skippedOutcomes, noData, minNForCI }));
    } else {
      const selected = sorted.filter((t) => pred[v.id](ctxOf(t)));
      const skippedOutcomes = sorted.filter((t) => !pred[v.id](ctxOf(t))).map(baseOutcome);
      results.push(statsFor(v, selected.map(baseOutcome), { total, skippedOutcomes, noData: 0, minNForCI }));
    }
  }

  // Verdicts vs baseline, only when the sample is large enough (n >= 200).
  const base = results.find((r) => r.id === "V0");
  for (const r of results) {
    if (r.n < minNForVerdict || !base || r.id === "V0") {
      r.verdict = null;
      continue;
    }
    const d = (r.meanNetPct ?? 0) - (base.meanNetPct ?? 0);
    r.verdict = `${d >= 0 ? "+" : ""}${d.toFixed(1)} pp vs baseline`;
  }

  return { variants: results, checkedVariants: SHADOW_VARIANTS.length };
}

// Compact per-variant text table.
export function shadowLines({ variants, checkedVariants }) {
  const h = ["id", "n", "noData", "win%", "meanNet%", "medianNet%", "PF", "CI95", "maxDD SOL", "TP%", "SL%", "to%", "skip%", "skipNet%"];
  const rows = variants.map((r) => [
    r.id,
    String(r.n),
    r.noData ? String(r.noData) : "",
    r.winRate === null ? "n/a" : (r.winRate * 100).toFixed(0),
    r.meanNetPct === null ? "n/a" : r.meanNetPct.toFixed(1),
    r.medianNetPct === null ? "n/a" : r.medianNetPct.toFixed(1),
    r.pf === Infinity ? "inf" : r.pf.toFixed(2),
    r.ciLo === null ? "n/a" : `[${r.ciLo.toFixed(1)}..${r.ciHi.toFixed(1)}]`,
    r.maxDDSol.toFixed(4),
    r.tpShare === null ? "n/a" : (r.tpShare * 100).toFixed(0),
    r.slShare === null ? "n/a" : (r.slShare * 100).toFixed(0),
    r.timeoutShare === null ? "n/a" : (r.timeoutShare * 100).toFixed(0),
    r.skipShare === null ? "n/a" : (r.skipShare * 100).toFixed(1),
    r.skippedMeanNetPct === null ? "n/a" : r.skippedMeanNetPct.toFixed(1),
  ]);
  return { h, rows, checkedVariants };
}

