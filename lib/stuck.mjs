// STUCK accounting: a position the bot stops trying to sell.
//
// Why: a STUCK position used to vanish from the limits. The session report listed it, but
// TradeGuard never saw a loss (MAX_CONSEC_LOSSES could not trip) and the daily loss limit summed
// only `type:"trade"` rows, so a day of unsellable positions looked like a zero day and the bot kept
// buying. The money is not provably lost — the tokens are still in the wallet — but the bot cannot
// get it back on its own, so for the LIMITS it is booked as a full loss of the remaining entry.
//
// The journal row says so explicitly: `pnlSol` = -(remaining entry), `lossAssumed: true`. A later
// manual recovery (scripts/rescue-sell.mjs, scripts/sell-all.mjs) is NOT credited back: those
// tools write no `trade` row, so nothing is counted twice and the day stays on the cautious side.
import { roundSol } from "./session.mjs";

// The assumed loss of a stuck position, in SOL (<= 0): the entry that is still open. Partial sells
// already reduced pos.entrySolSol to the remaining share, so the sold part is never counted again.
export function stuckLossSol(pos, buySol) {
  const entry = Number.isFinite(pos?.entrySolSol) ? pos.entrySolSol : Number(buySol);
  return Number.isFinite(entry) && entry > 0 ? -roundSol(entry) : 0;
}

// Journal the stuck position and report the assumed loss to the limits.
//   journal      — TradeJournal (or anything with write()); optional
//   recordResult — the bot's own result hook (TradeGuard + daily loss); optional
//   fields       — bot-specific journal fields (sessionId, venue, attempts, tokens, …); they can
//                  NOT override pnlSol / lossAssumed
// Returns the booked pnlSol (<= 0).
export function recordStuck({ journal = null, recordResult = null, mint, pos, buySol, reason, fields = {} }) {
  const pnlSol = stuckLossSol(pos, buySol);
  if (journal) {
    journal.write({
      type: "stuck",
      mint,
      reason,
      tokens: (pos?.tokens ?? 0n).toString(),
      ...fields,
      entrySolSol: roundSol(-pnlSol),
      // Rent locked in the token ATA is NOT part of the assumed loss (it is not part of the entry).
      ataRentSol: Number.isFinite(pos?.ataRentSol) ? pos.ataRentSol : 0,
      pnlSol,
      lossAssumed: true,
    });
  }
  // A zero "loss" must not reach the guard: recordResult(0) would RESET the losing streak.
  if (pnlSol < 0 && typeof recordResult === "function") recordResult(pnlSol);
  return pnlSol;
}
