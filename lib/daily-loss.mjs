// Daily loss limit (task 5).
//
// A bad day must stop the bleeding, not turn into a revenge-trading loop. Realised PnL for the
// current Moscow day is summed from the journal; once the net reaches -DAILY_LOSS_LIMIT_SOL the bot
// stops BUYING (open positions keep being managed and sold normally).
import { mskDateKey } from "./time.mjs";
import { BUY_SKIP_REASON } from "./buy-skip-reasons.mjs";

export const DEFAULT_DAILY_LOSS_LIMIT_SOL = 0.05;

const round = (x) => Math.round(x * 1e9) / 1e9;

// The journal row's own Moscow date: `tsMsk` is written by lib/journal.mjs, `ts` is the fallback.
function dayOf(record) {
  if (typeof record.tsMsk === "string" && record.tsMsk.length >= 10) return record.tsMsk.slice(0, 10);
  if (typeof record.ts === "string") {
    const d = new Date(record.ts);
    if (!Number.isNaN(d.getTime())) return mskDateKey(d);
  }
  return null;
}

// A row that moves the day's result: a closed trade, or a STUCK position whose remaining entry was
// booked as an assumed loss (lib/stuck.mjs, `lossAssumed: true`). Older `stuck` rows carry neither
// `lossAssumed` nor `pnlSol` and stay out, exactly as before.
function countsForDay(r) {
  if (r.type === "trade") return true;
  return r.type === "stuck" && r.lossAssumed === true;
}

// Net realised SOL of the given day (default: today, Moscow) from journal records.
export function netSolForDay(records, dayKey = mskDateKey()) {
  let net = 0;
  for (const r of records ?? []) {
    if (!r || !countsForDay(r)) continue;
    if (dayOf(r) !== dayKey) continue;
    const pnl = Number(r.pnlSol);
    if (Number.isFinite(pnl)) net += pnl;
  }
  return round(net);
}

/**
 * @returns {{blocked: boolean, reason: string|null, netSol: number, limitSol: number}}
 */
export function dailyLossBlocked({ netSol, limitSol = DEFAULT_DAILY_LOSS_LIMIT_SOL }) {
  const limit = Number(limitSol);
  const net = Number(netSol) || 0;
  if (!(limit > 0)) return { blocked: false, reason: null, netSol: net, limitSol: limit };
  if (net <= -limit) return { blocked: true, reason: BUY_SKIP_REASON.dailyLossLimit, netSol: net, limitSol: limit };
  return { blocked: false, reason: null, netSol: net, limitSol: limit };
}
