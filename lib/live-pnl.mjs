// Live accounting from ACTUAL execution (transaction meta), in one place.
//
// Why: the sniper's live PnL was `receivedSol - BUY_SOL - txSol(est) - slipSol(est)`:
//   - BUY_SOL instead of what actually left the wallet (the buy takes `minTokens`, so it normally
//     spends LESS than BUY_SOL);
//   - an ESTIMATED sell tx fee subtracted from a `receivedSol` that readExecution already reports
//     net of the real one (counted twice);
//   - an ASSUMED slippage on both legs on top of a fill that already contains the real one.
// A flat trade was booked as a loss, which also feeds MAX_CONSEC_LOSSES.
//
// Definitions used here (and by the journal):
//   entrySolSol   SOL the buy itself took: wallet delta WITHOUT the network fee and WITHOUT the
//                 token-ATA rent (lib/exec.mjs readExecution.solSpentSol)
//   receivedSol   wallet delta of the sell as readExecution reports it. It IS net of the sell's
//                 network fee (the wallet paid it in the same tx).
//   pnlSol        receivedSol - (sold share of entrySolSol). Contains: pump fees, real slippage,
//                 the SELL network fee. Does NOT contain: the BUY network fee, the ATA rent.
//   costs         actual network fees of both legs (txSol = buyFeeSol + sellFeeSol), slipSol = 0,
//                 feeSol (pump) = 0 because the pump fees are already inside entry/received.
//   ledger        what goes to SessionLedger.sell(): received and pnl GROSS of the sell network
//                 fee, so that "NET after costs" = gross - costs counts every fee exactly once.
import { roundSol, splitEntryForSell } from "./session.mjs";
import { txCostSol } from "./fees.mjs";

// Entry facts of a landed buy, from readExecution(). Fallback (meta not available): the nominal
// buy size, flagged "quote-fallback" so the journal never passes an estimate off as a fact.
export function liveEntry(ex, buySol) {
  const found = ex?.found === true;
  const actual = found && ex.solSpentSol > 0;
  return {
    entrySolSol: actual ? ex.solSpentSol : buySol,
    entrySource: actual ? "chain-meta" : "quote-fallback",
    buyFeeSol: found && Number.isFinite(ex.feeSol) ? ex.feeSol : null, // null = unknown
    ataRentSol: found && Number.isFinite(ex.ataRentPaidSol) ? ex.ataRentPaidSol : 0,
    ataRentKnown: found && ex.ataRentKnown === true,
  };
}

// Accounting of one live sell.
//   entrySolSol        remaining entry of the position (falls back to buySol)
//   receivedSol        SOL the sell returned (readExecution.solReceivedSol, or the quote)
//   receivedIsWalletNet true when receivedSol came from the chain (already net of the sell fee);
//                      false for a quote fallback (the fee is not in it)
//   soldRaw / totalRaw tokens sold by this tx / tokens held before it (partial sells)
//   buyFeeSol          remaining buy network fee of the position (null = unknown -> estimated)
//   sellFeeSol         network fee of this sell (null = unknown -> estimated)
export function liveSellAccounting({
  entrySolSol,
  buySol,
  receivedSol,
  receivedIsWalletNet = true,
  soldRaw,
  totalRaw,
  buyFeeSol = null,
  sellFeeSol = null,
}) {
  const entry = Number.isFinite(entrySolSol) ? entrySolSol : Number(buySol);
  const split = splitEntryForSell(entry, soldRaw, totalRaw);
  const share = entry > 0 ? split.shareEntry / entry : 1;

  const feesActual = Number.isFinite(buyFeeSol) && Number.isFinite(sellFeeSol);
  const buyFeeAll = Number.isFinite(buyFeeSol) ? buyFeeSol : txCostSol();
  const buyFee = roundSol(buyFeeAll * share); // a partial sell carries its share of the buy fee
  const sellFee = roundSol(Number.isFinite(sellFeeSol) ? sellFeeSol : txCostSol());

  const received = Number.isFinite(receivedSol) && receivedSol > 0 ? receivedSol : 0;
  const pnlSol = roundSol(received - split.shareEntry);
  const txSol = roundSol(buyFee + sellFee);
  // Gross-up for the ledger only when the sell fee is really inside `received`.
  const grossUp = receivedIsWalletNet ? sellFee : 0;

  return {
    shareEntry: split.shareEntry,
    remainderEntry: split.remainderEntry,
    remainderBuyFeeSol: Number.isFinite(buyFeeSol) ? roundSol(buyFeeAll - buyFee) : null,
    receivedSol: roundSol(received),
    pnlSol,
    costs: { feeSol: 0, slipSol: 0, txSol, costSol: txSol, buyFeeSol: buyFee, sellFeeSol: sellFee, feesActual },
    ledger: { receivedSol: roundSol(received + grossUp), pnlSol: roundSol(pnlSol + grossUp) },
  };
}
