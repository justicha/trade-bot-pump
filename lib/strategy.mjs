// Strategy lab: variants A..F run in PARALLEL on the same token stream, in dry-run only.
//
// Everything here is paper trading on prices observed in the live trade stream — no wallet, no
// transactions. Each variant keeps its own positions and produces its own trade records, so the
// replay compares variants on identical tokens instead of on different days.
//
// Entry rules
//   create  — buy the create event (variant A, the old behaviour)
//   organic — buy only when >= minHolders distinct wallets hold the token, spread over
//             >= minSlots slots, at least minDelayMs after the create (skips instant bundles)
//
// Exit rules are combined per variant: stop-loss, take-profit, timeout, time-stop, partial
// take-profit + trailing stop, and "creator / entry-group sells".
import { txCostSol } from "./fees.mjs";

const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_ASSUMED_BPS ?? 50);
const PUMP_FEE_BPS = 100;

const bpsOf = (x, b) => (x * b) / 10_000;

// Default variant matrix. Every knob can be overridden from .env (bots/research/lab.mjs).
export function buildVariants(overrides = {}, global = {}) {
  const base = {
    entry: "organic",
    minHolders: 4,
    minSlots: 2,
    minDelayMs: 2500,
    takeProfit: 2.0,
    stopLoss: 0.5,
    timeoutSec: 120,
    timeStopSec: null,
    timeStopMinGain: 0.3,
    partialAt: null,
    partialPct: null,
    trailPct: null,
    exitOnCreatorSell: false,
    exitOnGroupSell: false,
  };

  const defs = [
    { name: "A", ...base, entry: "create" },
    { name: "B", ...base },
    { name: "C", ...base, timeStopSec: 35 },
    { name: "D", ...base, timeStopSec: 35, partialAt: 2.0, partialPct: 0.5, trailPct: 0.25 },
    {
      name: "E",
      ...base,
      timeStopSec: 35,
      partialAt: 2.0,
      partialPct: 0.5,
      trailPct: 0.25,
      exitOnCreatorSell: true,
      exitOnGroupSell: true,
    },
    // F: stop-loss sweep on top of E
    { name: "F40", ...base, stopLoss: 0.4, timeStopSec: 35, partialAt: 2.0, partialPct: 0.5, trailPct: 0.25, exitOnCreatorSell: true, exitOnGroupSell: true },
    { name: "F50", ...base, stopLoss: 0.5, timeStopSec: 35, partialAt: 2.0, partialPct: 0.5, trailPct: 0.25, exitOnCreatorSell: true, exitOnGroupSell: true },
    { name: "F60", ...base, stopLoss: 0.6, timeStopSec: 35, partialAt: 2.0, partialPct: 0.5, trailPct: 0.25, exitOnCreatorSell: true, exitOnGroupSell: true },
  ];

  return defs.map((d) => ({ ...d, ...global, ...(overrides[d.name] || {}) }));
}

// One paper position. All money is tracked in SOL; token amounts only matter for the crowd
// bookkeeping done by the collector.
function openPosition(cfg, { mint, creator, ts, price, buySol, ctx }) {
  return {
    mint,
    creator,
    entryTs: ts,
    entryPrice: price,
    buySol,
    remainingShare: 1,
    realizedSol: 0, // net SOL received from partial exits
    partialDone: false,
    peak: 1,
    entryGroup: new Set(ctx?.entryGroup || []),
    holdersAtEntry: ctx?.holders ?? null,
    slotsAtEntry: ctx?.slots ?? null,
    buyersAtEntry: ctx?.buyers ?? null,
    msToEntry: ts - (ctx?.createTs ?? ts),
  };
}
export class StrategyLab {
  constructor({
    variants,
    buySol = 0.02,
    feeBps = PUMP_FEE_BPS,
    slippageBps = DEFAULT_SLIPPAGE_BPS,
    txSol = txCostSol(),
    latencyMs = 0, // execution delay: entry/exit fill at the first price at least this late
    priceWindow = 3, // exit decisions use the median of the last N fresh prices
  } = {}) {
    this.buySol = buySol;
    this.feeBps = feeBps;
    this.slippageBps = slippageBps;
    this.txSol = txSol;
    this.latencyMs = Math.max(0, Number(latencyMs) || 0);
    // Exit decisions use the MEDIAN of the last `priceWindow` fresh prices, not a single tick:
    // one print can spike, three in a row much less so.
    this.priceWindow = Math.max(1, Number(priceWindow) || 3);
    this.history = new Map(); // mint -> last fresh prices
    this.spikeGuard = true; // TP needs a full window (no take-profit on one print)
    this.variants = variants.map((cfg) => ({ cfg, open: null, closed: [], pendingEntry: null, pendingExit: null }));
    this.onEvent = null; // (event) => void, set by the collector
  }

  _emit(event) {
    if (this.onEvent) this.onEvent(event);
  }

  // Cost of opening: 1% pump fee + adverse slippage + one transaction.
  _entryCosts() {
    const fee = bpsOf(this.buySol, this.feeBps);
    const slip = bpsOf(this.buySol, this.slippageBps);
    return { fee, slip, tx: this.txSol, total: fee + slip + this.txSol };
  }

  // Median of the last fresh prices; falls back to the raw price when there is no history.
  _decisionPrice(mint, fallback) {
    const hist = this.history.get(mint);
    if (!hist || !hist.length) return { price: fallback, samples: 0 };
    const sorted = hist.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { price: median, samples: sorted.length };
  }

  _remember(mint, price) {
    if (!Number.isFinite(price) || price <= 0) return;
    const hist = this.history.get(mint) || [];
    hist.push(price);
    while (hist.length > this.priceWindow) hist.shift();
    this.history.set(mint, hist);
  }

  _enter(v, { mint, creator, ts, price, ctx }) {
    const pos = openPosition(v.cfg, { mint, creator, ts, price, buySol: this.buySol, ctx });
    v.open = pos;
    v.pendingExit = null;
    this._emit({
      type: "entry",
      variant: v.cfg.name,
      mint,
      ts,
      price,
      latencyMs: this.latencyMs,
      holders: pos.holdersAtEntry,
      slots: pos.slotsAtEntry,
      buyers: pos.buyersAtEntry,
      msToEntry: pos.msToEntry,
    });
  }

  // Entry/exit decisions are not filled at the price that triggered them: with latencyMs > 0 the
  // fill happens at the first price observed at least latencyMs later (that is what a real
  // transaction would get, not the tick we reacted to).
  _scheduleEntry(v, ev) {
    if (this.latencyMs <= 0) return this._enter(v, ev);
    v.pendingEntry = { ...ev, fillAfter: ev.ts + this.latencyMs };
    this._emit({ type: "entry_pending", variant: v.cfg.name, mint: ev.mint, ts: ev.ts, latencyMs: this.latencyMs });
  }

  _scheduleExit(v, { ts, price, reason, share = null }) {
    if (this.latencyMs <= 0) return this._close(v, { ts, price, reason, share });
    if (v.pendingExit) return null;
    v.pendingExit = { reason, share, fillAfter: ts + this.latencyMs };
    this._emit({ type: "exit_pending", variant: v.cfg.name, mint: v.open?.mint, ts, reason, latencyMs: this.latencyMs });
    return null;
  }

  // Sell `share` of the position at `price`; returns the gross/net SOL of that leg.
  _sellShare(pos, share, price) {
    const grossSol = pos.buySol * share * (price / pos.entryPrice);
    const fee = bpsOf(grossSol, this.feeBps);
    const slip = bpsOf(grossSol, this.slippageBps);
    const tx = this.txSol;
    const net = grossSol - fee - slip - tx;
    return { grossSol, net, costs: fee + slip + tx };
  }

  _close(v, { ts, price, reason, share = null }) {
    const pos = v.open;
    if (!pos) return null;
    // share is a fraction of the ORIGINAL position; a full close sells what is left
    const sellShare = Math.min(share === null ? pos.remainingShare : share, pos.remainingShare);
    const { net, costs } = this._sellShare(pos, sellShare, price);
    pos.realizedSol += net;
    pos.remainingShare = Math.max(0, pos.remainingShare - sellShare);

    if (pos.remainingShare > 0.0001) {
      pos.partialExitCosts = (pos.partialExitCosts || 0) + costs;
      this._emit({ type: "partial", variant: v.cfg.name, mint: pos.mint, ts, price, share, reason });
      return null;
    }

    const entry = this._entryCosts();
    const netPnl = pos.realizedSol - pos.buySol - entry.total;
    const trade = {
      variant: v.cfg.name,
      mint: pos.mint,
      creator: pos.creator,
      entryTs: pos.entryTs,
      exitTs: ts,
      holdSec: Math.round((ts - pos.entryTs) / 1000),
      entryPrice: pos.entryPrice,
      exitPrice: price,
      grossRatio: Math.round((price / pos.entryPrice) * 1e6) / 1e6,
      peakRatio: Math.round(pos.peak * 1e6) / 1e6,
      pnlSol: Math.round(netPnl * 1e9) / 1e9,
      pnlPct: Math.round((netPnl / pos.buySol) * 10000) / 100,
      netRatio: Math.round(((pos.buySol + netPnl) / pos.buySol) * 1e6) / 1e6,
      reason,
      partial: pos.partialDone,
      buySol: pos.buySol,
      latencyMs: this.latencyMs,
      costsSol: Math.round((entry.total + (pos.partialExitCosts || 0) + costs) * 1e9) / 1e9,
      holdersAtEntry: pos.holdersAtEntry,
      slotsAtEntry: pos.slotsAtEntry,
      buyersAtEntry: pos.buyersAtEntry,
      msToEntry: pos.msToEntry,
    };
    v.closed.push(trade);
    v.open = null;
    this._emit({ type: "exit", ...trade });
    return trade;
  }
  // Evaluate exits for the open position of one variant at a new price/time.
  _evaluate(v, { ts, price, isBuy = null, user = null, creator = null }) {
    const pos = v.open;
    if (!pos) return;
    const cfg = v.cfg;
    const decision = this._decisionPrice(pos.mint, price);
    const decisionRatio = decision.price / pos.entryPrice;
    const ratio = decisionRatio; // exits are judged on the median, never on one print
    const enoughSamples = !this.spikeGuard || decision.samples >= this.priceWindow;
    if (ratio > pos.peak) pos.peak = ratio;
    const elapsed = (ts - pos.entryTs) / 1000;

    // E: exit when the creator or a wallet of the entry crowd sells
    if (cfg.exitOnCreatorSell && isBuy === false && user && creator && user === creator) {
      this._scheduleExit(v, { ts, price, reason: "creator-sell" });
      return;
    }
    if (cfg.exitOnGroupSell && isBuy === false && user && pos.entryGroup.has(user)) {
      this._scheduleExit(v, { ts, price, reason: "holder-sell" });
      return;
    }

    // stop-loss first: it must win over a time-stop on the same tick
    if (ratio <= cfg.stopLoss) {
      this._scheduleExit(v, { ts, price, reason: `stop-loss ${ratio.toFixed(2)}x` });
      return;
    }

    // partial take-profit, then the remainder trails
    if (cfg.partialAt && cfg.partialPct && !pos.partialDone && ratio >= cfg.partialAt && enoughSamples) {
      pos.partialDone = true;
      this._scheduleExit(v, { ts, price, reason: `partial ${cfg.partialPct * 100}% @ ${ratio.toFixed(2)}x`, share: cfg.partialPct });
      if (!v.open) return;
    }

    if (v.open && pos.partialDone && cfg.trailPct && pos.peak > 1) {
      if (ratio <= pos.peak * (1 - cfg.trailPct)) {
        this._scheduleExit(v, {
          ts,
          price,
          reason: `trailing ${((1 - ratio / pos.peak) * 100).toFixed(0)}% off peak ${pos.peak.toFixed(2)}x`,
        });
        return;
      }
    }

    if (v.open && ratio >= cfg.takeProfit && !cfg.partialAt && enoughSamples) {
      this._scheduleExit(v, { ts, price, reason: `take-profit ${ratio.toFixed(2)}x` });
      return;
    }

    // C: time-stop — no progress after N seconds, get out
    if (cfg.timeStopSec && elapsed >= cfg.timeStopSec && ratio < 1 + cfg.timeStopMinGain) {
      this._scheduleExit(v, { ts, price, reason: `time-stop ${cfg.timeStopSec}s (${((ratio - 1) * 100).toFixed(0)}%)` });
      return;
    }

    if (elapsed >= cfg.timeoutSec) {
      this._scheduleExit(v, { ts, price, reason: `timeout ${cfg.timeoutSec}s` });
    }
  }

  // Fill anything that was scheduled earlier (latency model).
  _resolvePending(v, { mint, ts, price }) {
    if (v.pendingEntry && v.pendingEntry.mint === mint && ts >= v.pendingEntry.fillAfter) {
      const ev = v.pendingEntry;
      v.pendingEntry = null;
      this._enter(v, { ...ev, ts, price });
    }
    if (v.open && v.pendingExit && v.open.mint === mint && ts >= v.pendingExit.fillAfter) {
      const { reason, share } = v.pendingExit;
      v.pendingExit = null;
      this._close(v, { ts, price, reason: `${reason} (fill +${this.latencyMs}ms)`, share });
    }
  }

  // A new token appeared in the stream.
  onCreate({ mint, creator, ts, price, ctx }) {
    for (const v of this.variants) {
      if (v.open) continue;
      if (v.cfg.entry !== "create") continue;
      this._scheduleEntry(v, { mint, creator, ts, price, ctx });
    }
  }

  // A trade happened on a known token; `price` is the curve price AFTER that trade.
  onTrade({ mint, creator, ts, price, isBuy, user, ctx, organic, freshPrice = true }) {
    if (freshPrice) this._remember(mint, price);
    for (const v of this.variants) {
      this._resolvePending(v, { mint, ts, price });
      if (v.pendingEntry || v.pendingExit) continue;
      if (v.open) {
        if (v.open.mint === mint) this._evaluate(v, { ts, price, isBuy, user, creator });
        continue;
      }
      if (v.cfg.entry !== "organic") continue;
      if (organic !== true) continue;
      this._scheduleEntry(v, { mint, creator, ts, price, ctx });
    }
  }

  // Time-based exits, called on a timer even when no trade arrives.
  onTick({ ts, priceOf }) {
    for (const v of this.variants) {
      const pendingMint = v.pendingEntry ? v.pendingEntry.mint : v.open?.mint;
      if ((v.pendingEntry || v.pendingExit) && pendingMint) {
        const pp = priceOf(pendingMint);
        if (Number.isFinite(pp) && pp > 0) this._resolvePending(v, { mint: pendingMint, ts, price: pp });
      }
      if (v.pendingEntry || v.pendingExit) continue;
      const pos = v.open;
      if (!pos) continue;
      const price = priceOf(pos.mint);
      if (!Number.isFinite(price) || price <= 0) continue;
      this._evaluate(v, { ts, price });
    }
  }

  decisions() {
    return this.variants.map((v) => ({ variant: v.cfg.name, open: v.open ? v.open.mint : null, closed: v.closed.length }));
  }

  results() {
    return this.variants.map((v) => ({ variant: v.cfg.name, trades: v.closed.slice(), open: v.open ? 1 : 0 }));
  }
}

// Basic statistics used by the replay and the tests.
export function statsOf(trades) {
  const n = trades.length;
  if (!n) {
    return { n: 0, meanPct: 0, medianPct: 0, wins: 0, losses: 0, tpShare: 0, bigLossShare: 0, maxDrawdownSol: 0, netSol: 0 };
  }
  const pcts = trades.map((t) => t.pnlPct).sort((a, b) => a - b);
  const meanPct = pcts.reduce((a, b) => a + b, 0) / n;
  const medianPct = n % 2 ? pcts[(n - 1) / 2] : (pcts[n / 2 - 1] + pcts[n / 2]) / 2;

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.pnlSol;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  return {
    n,
    meanPct: Math.round(meanPct * 100) / 100,
    medianPct: Math.round(medianPct * 100) / 100,
    wins: trades.filter((t) => t.pnlPct > 0).length,
    losses: trades.filter((t) => t.pnlPct < 0).length,
    tpShare: Math.round((trades.filter((t) => /take-profit|partial/.test(t.reason || "")).length / n) * 1000) / 10,
    bigLossShare: Math.round((trades.filter((t) => t.pnlPct <= -50).length / n) * 1000) / 10,
    maxDrawdownSol: Math.round(maxDd * 1e6) / 1e6,
    netSol: Math.round(cum * 1e6) / 1e6,
  };
}

