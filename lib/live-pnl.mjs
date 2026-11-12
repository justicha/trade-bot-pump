// Live accounting from ACTUAL execution (transaction meta), in one place for every bot
// (sniper, graduation-sniper, copy-trader).
//
// Why: each bot used to do its own arithmetic on a live sale:
//   - sniper: `receivedSol - BUY_SOL - txSol(est) - slipSol(est)` — nominal size instead of what
//     left the wallet, an estimated tx fee on top of a wallet delta that already contains the real
//     one, and an assumed slippage on top of a fill that already contains the real one;
//   - graduation / copy-trader: `received - entry` with ESTIMATED costs in the session ledger, so
//     "NET after costs" subtracted the sell fee twice and added a slippage that never happened;
//   - a reconciled sale (confirm error, tx landed) had its own copies with their own bugs.
//
// Definitions (journal scheme v2.2, lib/fees.mjs):
//   entrySolSol   SOL the buy itself took: wallet delta WITHOUT the network fee and WITHOUT the
//                 token-ATA rent (lib/exec.mjs readExecution.solSpentSol)
//   solReceived   wallet delta of the sell as the chain reports it: already NET of the sell's
//                 network fee (or the quote, when the meta is not available)
//   pnlSol        NET of BOTH network fees:
//                   (proceeds before the sell fee) - (sold share of the entry)
//                   - (sold share of the buy fee) - (sell fee)
//                 Contains pump fees and real slippage (they are inside entry / proceeds).
//                 Does NOT contain the ATA rent (journaled apart as ataRentSol).
//   costs         the network fees themselves: txSol = buyFeeSol + sellFeeSol; slipSol = 0 and
//                 feeSol (pump) = 0 because those are already inside entry / proceeds.
//   ledger        what goes to SessionLedger.sell(): proceeds and pnl BEFORE network fees, with
//                 `costs` next to them, so "NET after costs" = gross - costs counts each fee once.
//                 Invariant: pnlSol = ledger.pnlSol - costs.costSol.
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

// What a sell returned, from readExecution() or — when the meta is missing — from the quote.
//   receivedIsWalletNet true: `receivedSol` is the wallet delta (the sell fee is already out of it)
// The chain is trusted whenever it shows SOL arriving OR tokens leaving: a sale whose proceeds did
// not even cover the fee is a fact (a loss), not a reason to fall back to an optimistic quote.
// The delta is taken unclamped (minus a returned WSOL-ATA rent), so such a sale stays exact.
export function sellProceeds(ex, quoteSol) {
  const found = ex?.found === true;
  const sellFeeSol = found && Number.isFinite(ex.feeSol) ? ex.feeSol : null;
  const fromChain = found && (ex.solReceivedSol > 0 || ex.tokensSold > 0n);
  if (!fromChain) {
    const q = Number(quoteSol);
    return { receivedSol: Number.isFinite(q) && q > 0 ? q : 0, receivedIsWalletNet: false, sellFeeSol };
  }
  const net = Number.isFinite(ex.solDeltaSol) ? ex.solDeltaSol - (ex.rentReturnedSol || 0) : ex.solReceivedSol;
  return { receivedSol: net, receivedIsWalletNet: true, sellFeeSol };
}

// Token balance BEFORE a sale that was reconciled after a confirm error (the tx landed, so the
// wallet can no longer be asked). `balanceRaw` is the balance the sell path read before building
// the tx; without it the position's own count is used. Never smaller than what was sold.
//
// The bug this replaces: `pos.tokens + soldRaw` — pos.tokens is not reduced before the sale is
// recorded, so a full sale looked like half of a double-sized position: PnL overstated by half the
// entry, and a phantom position left behind.
export function balanceBeforeSell({ balanceRaw = null, posTokens = null, soldRaw }) {
  const sold = BigInt(soldRaw);
  const total = balanceRaw != null ? BigInt(balanceRaw) : posTokens != null ? BigInt(posTokens) : sold;
  return total < sold ? sold : total;
}

// Accounting of one live sell.
//   entrySolSol        remaining entry of the position (falls back to buySol)
//   receivedSol        SOL the sell returned (wallet delta, or the quote)
//   receivedIsWalletNet true when receivedSol is the wallet delta (already net of the sell fee);
//                      false for a quote (the fee is not in it)
//   soldRaw / totalRaw tokens sold by this tx / tokens held before it (partial sells)
//   buyFeeSol          remaining buy network fee of the position (null = unknown -> estimated)
//   sellFeeSol         network fee of this sell (null = unknown -> estimated)
//   buyFeeActual       false when buyFeeSol is itself an estimate carried over from an earlier part
export function liveSellAccounting({
  entrySolSol,
  buySol,
  receivedSol,
  receivedIsWalletNet = true,
  soldRaw,
  totalRaw,
  buyFeeSol = null,
  sellFeeSol = null,
  buyFeeActual = true,
}) {
  const entry = Number.isFinite(entrySolSol) ? entrySolSol : Number(buySol);
  const split = splitEntryForSell(entry, soldRaw, totalRaw);
  const share = entry > 0 ? split.shareEntry / entry : 1;

  const buyFeeKnown = Number.isFinite(buyFeeSol);
  const sellFeeKnown = Number.isFinite(sellFeeSol);
  const buyFeeAll = buyFeeKnown ? buyFeeSol : txCostSol();
  const buyFee = roundSol(buyFeeAll * share); // a partial sell carries its share of the buy fee
  const sellFee = roundSol(sellFeeKnown ? sellFeeSol : txCostSol());
  const feesActual = buyFeeKnown && buyFeeActual !== false && sellFeeKnown;

  const given = Number.isFinite(receivedSol) ? receivedSol : 0;
  // Proceeds BEFORE the sell network fee: a wallet delta gets the fee added back, a quote has none.
  const gross = roundSol(Math.max(0, receivedIsWalletNet ? given + sellFee : given));
  const grossPnl = roundSol(gross - split.shareEntry);
  const txSol = roundSol(buyFee + sellFee);

  return {
    shareEntry: split.shareEntry,
    remainderEntry: split.remainderEntry,
    // The rest of the buy fee stays with the still-open remainder (an estimate stays an estimate).
    remainderBuyFeeSol: roundSol(Math.max(0, buyFeeAll - buyFee)),
    buyFeeActual: buyFeeKnown && buyFeeActual !== false,
    receivedSol: roundSol(Math.max(0, given)),
    pnlSol: roundSol(grossPnl - txSol), // net of BOTH network fees
    costs: { feeSol: 0, slipSol: 0, txSol, costSol: txSol, buyFeeSol: buyFee, sellFeeSol: sellFee, feesActual },
    ledger: { receivedSol: gross, pnlSol: grossPnl },
  };
}

// Journal fields of a LIVE sale: the actual entry / proceeds and the real network fees, so a reader
// can rebuild any PnL definition without guessing.
//   closes — the sale closes the position. The ATA rent is a property of the position, so it is
//            written on the closing sale only (0 on a partial one): summing it never counts twice.
export function liveSellFields(pos, acc, { closes = true } = {}) {
  return {
    entrySolSol: acc.shareEntry, // SOL the buy took for the sold share (no network fee, no ATA rent)
    entrySource: pos?.entrySource ?? null, // "chain-meta" | "quote-fallback"
    solReceived: acc.receivedSol, // wallet delta of the sell (net of sellFeeSol), or the quote
    buyFeeSol: acc.costs.buyFeeSol, // inside pnlSol
    sellFeeSol: acc.costs.sellFeeSol, // inside pnlSol
    feesActual: acc.costs.feesActual, // false = a fee was estimated (meta missing)
    ataRentSol: closes ? (pos?.ataRentSol ?? 0) : 0, // NOT inside pnlSol
    ataRentKnown: pos?.ataRentKnown === true,
    // What MAX_CONSEC_LOSSES classified this sale by: PnL BEFORE network fees (see guardPnlSol).
    guardPnlSol: acc.ledger.pnlSol,
  };
}

// One live sale applied to a position — the single entry point for the bots.
//   pos      { entrySolSol, buyFeeSol, buyFeeActual?, entrySource, ataRentSol, ... }
//   ex       readExecution() result of the sell (or { found:false })
//   quoteSol the pre-trade quote in SOL, used only when the meta is missing
//   soldRaw / totalRaw  tokens this tx sold / tokens held before it
// Returns the accounting, the journal fields and what is left:
//   closed true  -> the bot deletes the position
//   closed false -> the bot does Object.assign(pos, remainder)
//   guardPnlSol  -> the result MAX_CONSEC_LOSSES classifies the sale by: proceeds before the sell
//                   network fee minus the sold share of the entry (pump fees and slippage inside),
//                   i.e. acc.ledger.pnlSol. A sale that only lost the network fees is NOT a losing
//                   trade for the guard (decision 2026-11-12); acc.pnlSol (net of both fees) stays
//                   the figure for the journal and the daily loss limit. The bots pass it as
//                   recordResult(acc.pnlSol, { guardPnlSol }).
export function applyLiveSell(pos, { buySol, ex, quoteSol = 0, soldRaw, totalRaw }) {
  const p = sellProceeds(ex, quoteSol);
  const sold = BigInt(soldRaw);
  const total = BigInt(totalRaw);
  const acc = liveSellAccounting({
    entrySolSol: pos?.entrySolSol,
    buySol,
    receivedSol: p.receivedSol,
    receivedIsWalletNet: p.receivedIsWalletNet,
    soldRaw: sold,
    totalRaw: total,
    buyFeeSol: pos?.buyFeeSol ?? null,
    sellFeeSol: p.sellFeeSol,
    buyFeeActual: pos?.buyFeeActual !== false,
  });
  const closed = sold >= total;
  return {
    acc,
    closed,
    guardPnlSol: acc.ledger.pnlSol,
    fromChain: p.receivedIsWalletNet,
    fields: liveSellFields(pos, acc, { closes: closed }),
    remainder: closed
      ? null
      : { tokens: total - sold, entrySolSol: acc.remainderEntry, buyFeeSol: acc.remainderBuyFeeSol, buyFeeActual: acc.buyFeeActual },
  };
}
