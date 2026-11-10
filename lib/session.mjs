// Session ledger + one end-of-session report.
//
// Every looping bot records its SOL flows here:
//   - buy(amount)              — SOL put into a buy
//   - sell(received, pnl)      — SOL that came back from a sell + the trade result
//   - drop(note)               — a position closed without any exit recorded
//
// When the bot stops (loss limit hit, session budget exhausted, Ctrl+C) it prints a single
// summary: how much was spent, how much came back, and the net result. Numbers are gross —
// network + priority fees are not deducted (in LIVE the real wallet delta is printed next to
// them, so the fee impact is visible).
import { log as logger } from "./logger.mjs";

export const roundSol = (x) => Math.round(x * 1e9) / 1e9;

// Proportional entry for a partial sell (H4/H9): selling `soldRaw` of `totalRaw` raw tokens closes
// that share of the position, so its PnL must be measured against that share of the entry SOL —
// not the full entry (which double-counted the entry on every partial fill). Returns the entry
// share sold and the entry that remains for the still-open remainder.
export function splitEntryForSell(entrySol, soldRaw, totalRaw) {
  const sold = Number(soldRaw);
  const total = Number(totalRaw);
  if (!Number.isFinite(sold) || !Number.isFinite(total) || total <= 0 || sold >= total) {
    return { shareEntry: roundSol(entrySol), remainderEntry: 0 };
  }
  const share = sold / total;
  const shareEntry = roundSol(entrySol * share);
  return { shareEntry, remainderEntry: roundSol(entrySol - shareEntry) };
}

function fmtSol(x, signed = true) {
  if (!Number.isFinite(x)) return "n/a";
  const sign = x > 0 && signed ? "+" : x < 0 ? "-" : "";
  return `${sign}${Math.abs(x).toFixed(6)} SOL`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m ${sec}s`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export class SessionLedger {
  constructor({ label = "BOT", mode = "DRY RUN", startSol = null } = {}) {
    this.label = label;
    this.mode = mode;
    this.startedAt = Date.now();
    this.startSol = Number.isFinite(startSol) ? startSol : null;
    this.spentSol = 0; // gross SOL sent into buys
    this.receivedSol = 0; // gross SOL received from sells
    this.costsSol = 0; // pump fees + slippage + network/priority fees
    this.pnlTrades = 0; // sum of per-trade PnL estimates
    this.buys = 0;
    this.sells = 0;
    this.wins = 0;
    this.losses = 0;
    this.bestSol = 0;
    this.worstSol = 0;
    this.unresolved = []; // closed without a recorded exit (tokens gone / curve gone)
    this.reported = false;
  }

  buy(amountSol) {
    if (Number.isFinite(amountSol) && amountSol > 0) {
      this.spentSol = roundSol(this.spentSol + amountSol);
      this.buys += 1;
    }
    return this;
  }

  // costs: { feeSol, slipSol, txSol } from lib/fees.mjs (gross pnl stays as passed in)
  sell(receivedSol, pnlSol, costs = null) {
    if (costs) {
      const c = typeof costs === "number" ? costs : Number(costs.costSol || 0);
      if (Number.isFinite(c) && c > 0) this.costsSol = roundSol(this.costsSol + c);
    }
    if (Number.isFinite(receivedSol) && receivedSol >= 0) {
      this.receivedSol = roundSol(this.receivedSol + receivedSol);
    }
    this.sells += 1;
    if (Number.isFinite(pnlSol)) {
      this.pnlTrades = roundSol(this.pnlTrades + pnlSol);
      if (pnlSol > 0) this.wins += 1;
      else if (pnlSol < 0) this.losses += 1;
      if (pnlSol > this.bestSol) this.bestSol = pnlSol;
      if (pnlSol < this.worstSol) this.worstSol = pnlSol;
    }
    return this;
  }

  drop(note) {
    if (note) this.unresolved.push(String(note));
    return this;
  }

  get netSol() {
    return roundSol(this.receivedSol - this.spentSol);
  }

  get netAfterCostsSol() {
    return roundSol(this.netSol - this.costsSol);
  }

  get state() {
    return {
      label: this.label,
      mode: this.mode,
      spentSol: this.spentSol,
      receivedSol: this.receivedSol,
      netSol: this.netSol,
      pnlTrades: this.pnlTrades,
      buys: this.buys,
      sells: this.sells,
      wins: this.wins,
      losses: this.losses,
      unresolved: this.unresolved.length,
      startSol: this.startSol,
    };
  }

  // Print the summary exactly once; later calls return the same object.
  // openSpentSol: SOL locked in positions that are still open at stop (not part of NET).
  report({ reason = "stopped", openPositions = 0, endSol = null, openSpentSol = 0, rpc = null, stuck = [] } = {}) {
    if (this.reported) return this.summary;
    this.reported = true;

    const live = this.mode === "LIVE";
    // H9 invariant: `openSpentSol` must be the REMAINING entry of still-open shares (bots reduce
    // pos.entrySolSol on every partial sell), while `receivedSol` accumulates proceeds of CLOSED
    // shares only. Then net = received - (spent - openSpent) stays consistent even with partial
    // sells, and an open position's partial proceeds are not mistaken for profit.
    const openSpent = Math.max(0, Math.min(this.spentSol, roundSol(openSpentSol || 0)));
    const closedSpent = roundSol(this.spentSol - openSpent);
    const net = roundSol(this.receivedSol - closedSpent); // closed trades only
    const pct = closedSpent > 0 ? (net / closedSpent) * 100 : null;
    const bar = "=".repeat(64);

    const rows = [
      ["mode", live ? "LIVE" : "DRY RUN (simulated, nothing was sent on-chain)"],
      ["stopped", reason],
      ["duration", fmtDur(Date.now() - this.startedAt)],
      ["buys / sells", `${this.buys} / ${this.sells}`],
      ["spent", fmtSol(this.spentSol, false)],
      ...(openSpent > 0
        ? [["in open positions", `${fmtSol(openSpent, false)} (${openPositions} pos, excluded from NET)`]]
        : []),
      ["received", fmtSol(this.receivedSol, false)],
      [
        "NET result",
        `${fmtSol(net)}${pct === null ? "" : `  (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% of spent)`}`,
      ],
      ["costs", `${fmtSol(this.costsSol, false)}  (pump 1%+1%, slippage, priority fee)`],
      ["NET after costs", `${fmtSol(roundSol(net - this.costsSol))}`],
      [
        "closed trades",
        `${this.wins}W / ${this.losses}L` +
          (this.bestSol || this.worstSol
            ? `   best ${fmtSol(this.bestSol)}  worst ${fmtSol(this.worstSol)}`
            : ""),
      ],
      ["open at stop", `${openPositions} position(s)`],
    ];
    if (openSpent > 0) {
      // Open positions are not closed yet: also show the result assuming they end at zero,
      // otherwise 'NET result' next to 'spent' looks like a contradiction.
      rows.push([
        "worst case",
        `${fmtSol(roundSol(this.receivedSol - this.spentSol))}  (if the ${openPositions} open position(s) end at 0)`,
      ]);
    }
    if (this.unresolved.length) {
      rows.push(["no exit recorded", `${this.unresolved.length}: ${this.unresolved.slice(0, 5).join(" | ")}`]);
    }
    if (live && Number.isFinite(this.startSol) && Number.isFinite(endSol)) {
      rows.push([
        "wallet",
        `${this.startSol.toFixed(6)} -> ${endSol.toFixed(6)} SOL  (delta ${fmtSol(roundSol(endSol - this.startSol))})`,
      ]);
    } else if (!live) {
      rows.push(["wallet", "unchanged (dry run)"]);
    }
    if (rpc && Number.isFinite(rpc.txFails) && rpc.txFails > 0) {
      rows.push([
        "failed tx fees",
        `${rpc.txFails} landed-and-failed tx, est. ${Number(rpc.txFailFeeSol || 0).toFixed(6)} SOL (not in NET)`,
      ]);
    }
    if (stuck.length) {
      rows.push(["STUCK positions", `${stuck.length}: ${stuck.slice(0, 5).join(" | ")}`]);
    }

    rows.push(["note", "spent/received are gross — network + priority fees not deducted"]);
    const width = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
    logger.info(bar);
    logger.info(`SESSION SUMMARY — ${this.label}`);
    logger.info(bar);
    for (const [k, v] of rows) logger.info(`  ${k.padEnd(width)} : ${v}`);
    logger.info(bar);

    this.summary = {
      ...this.state,
      netSol: net, // closed trades only
      costsSol: this.costsSol,
      netAfterCostsSol: roundSol(net - this.costsSol),
      worstCaseSol: openSpent > 0 ? roundSol(this.receivedSol - this.spentSol) : null,
      closedSpentSol: closedSpent,
      reason,
      openPositions,
      openSpentSol: openSpent,
      endSol: Number.isFinite(endSol) ? endSol : null,
      durationMs: Date.now() - this.startedAt,
    };
    return this.summary;
  }
}
