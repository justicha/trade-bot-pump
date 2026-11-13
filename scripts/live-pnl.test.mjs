import "./lib/test-env.mjs";
// Live PnL from actual execution (lib/live-pnl.mjs), journal scheme v2.2:
//   pnlSol = proceeds - actual entry - BOTH real network fees (buy + sell);
//   no estimated tx fee / assumed slippage on top of the real fill;
//   the session ledger counts every network fee exactly once and reconciles with the wallet.
//
// Fails without the fixes:
//   - before v2.1 (sniper): `receivedSol - BUY_SOL - costs.txSol - costs.slipSol` booked the mock
//     trade (spent 0.095, received 0.1, nominal 0.1) as a LOSS of about -0.0019 SOL;
//   - v2.1 -> v2.2: pnlSol was received - entry = +0.005, i.e. WITHOUT the buy network fee; now
//     +0.004545 (both fees inside).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

process.env.RPC_MOCK = path.join(here, "mocks", "live-accounting-mock.mjs");

const { readExecution } = await import("../lib/exec.mjs");
const { liveEntry, liveSellAccounting, sellProceeds } = await import("../lib/live-pnl.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const { COSTS_SCHEME, roundTripCosts, txCostSol } = await import("../lib/fees.mjs");
const mock = await import("./mocks/live-accounting-mock.mjs");
const owner = new PublicKey(mock.OWNER);
const mint = new PublicKey(mock.MINT);
const opts = { retries: 1, delayMs: 0 };
const BUY_SOL = 0.1; // nominal size: the buy takes minTokens and really spends 0.095
const FEE = mock.FEE / 1e9;
const RENT = mock.RENT / 1e9;

// --- the whole round trip from mocked execution ------------------------------------------------
const buy = await readExecution("BUY_NEW_ATA", owner, mint, opts);
const sell = await readExecution("SELL", owner, mint, opts);
const pos = liveEntry(buy, BUY_SOL);
asrt(near(pos.entrySolSol, 0.095), `actual entry 0.095, got ${pos.entrySolSol}`);

const p = sellProceeds(sell, 0.2);
asrt(p.receivedIsWalletNet === true && near(p.receivedSol, 0.1) && near(p.sellFeeSol, FEE), "sell proceeds come from the chain (wallet delta), not from the quote");
const acc = liveSellAccounting({
  entrySolSol: pos.entrySolSol,
  buySol: BUY_SOL,
  receivedSol: p.receivedSol,
  receivedIsWalletNet: p.receivedIsWalletNet,
  soldRaw: sell.tokensSold,
  totalRaw: sell.tokensSold,
  buyFeeSol: pos.buyFeeSol,
  sellFeeSol: p.sellFeeSol,
});
// v2.2: both network fees are inside pnlSol. 0.1 (wallet delta, sell fee already out) - 0.095 - buy fee.
asrt(near(acc.pnlSol, 0.004545), `spent 0.095, received 0.1 -> pnlSol +0.004545 (net of both network fees), got ${acc.pnlSol}`);
asrt(near(acc.pnlSol, 0.1 - 0.095 - FEE), "pnlSol = wallet-net proceeds - entry - buy fee");
asrt(near(acc.receivedSol, 0.1), `journal solReceived stays the wallet delta, got ${acc.receivedSol}`);
asrt(acc.costs.slipSol === 0, "live costs: slipSol = 0 (the real slippage is inside the fill)");
asrt(acc.costs.feeSol === 0, "live costs: pump fees are inside entry/received, not charged again");
asrt(near(acc.costs.txSol, 2 * FEE) && near(acc.costs.costSol, 2 * FEE), `live costs = actual buy fee + actual sell fee, got ${acc.costs.txSol}`);
asrt(acc.costs.feesActual === true, "both fees came from the chain");
asrt(near(acc.costs.buyFeeSol, FEE) && near(acc.costs.sellFeeSol, FEE), "per-leg fees are journaled");
// The invariant that keeps the ledger honest: pnl (net) = ledger pnl (gross) - costs.
asrt(near(acc.pnlSol, acc.ledger.pnlSol - acc.costs.costSol), "pnlSol = ledger.pnlSol - costs.costSol");
asrt(near(acc.ledger.receivedSol, 0.1 + FEE) && near(acc.ledger.pnlSol, 0.005 + FEE), "ledger figures are BEFORE network fees");

// The pre-v2.1 formula, for the record: it called this winning trade a loss.
{
  const est = roundTripCosts({ buySol: BUY_SOL, ratio: 1, pumpFeeBps: 0 });
  const oldPnl = sell.solReceivedSol - BUY_SOL - est.txSol - est.slipSol;
  asrt(oldPnl < 0 && acc.pnlSol > 0, `old formula booked a loss (${oldPnl.toFixed(6)}) on a winning trade`);
}

// --- every fee exactly once: the ledger reconciles with the wallet -----------------------------
{
  const s = new SessionLedger({ label: "T", mode: "LIVE", startSol: 2 });
  s.buy(pos.entrySolSol).ataRent(pos.ataRentSol);
  s.sell(acc.ledger.receivedSol, acc.ledger.pnlSol, acc.costs);
  const walletDelta = buy.solDeltaSol + sell.solDeltaSol; // what really happened to the wallet
  const sum = s.report({ reason: "test", endSol: 2 + walletDelta });
  asrt(near(sum.netSol, 0.005 + FEE), `ledger NET is gross of network fees, got ${sum.netSol}`);
  asrt(near(sum.costsSol, 2 * FEE), `ledger costs = both real fees, got ${sum.costsSol}`);
  asrt(near(sum.netAfterCostsSol, acc.pnlSol), `NET after costs == the trade's pnlSol (${acc.pnlSol}), got ${sum.netAfterCostsSol}`);
  asrt(near(sum.netAfterCostsSol, walletDelta + RENT), "NET after costs == wallet delta without the ATA rent");
  asrt(near(sum.netAfterCostsInclRentSol, walletDelta), `NET after costs incl. rent == real wallet delta (${walletDelta}), got ${sum.netAfterCostsInclRentSol}`);
}

// --- partial sell: the entry and the buy fee are split by the sold share -----------------------
{
  const half = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 10n, buyFeeSol: FEE, sellFeeSol: FEE });
  asrt(near(half.shareEntry, 0.0475) && near(half.remainderEntry, 0.0475), `half sold -> half of the entry, got ${half.shareEntry}/${half.remainderEntry}`);
  asrt(near(half.costs.buyFeeSol, FEE / 2) && near(half.remainderBuyFeeSol, FEE / 2), "the buy fee is split too, the rest stays with the position");
  asrt(near(half.pnlSol, 0.05 - 0.0475 - FEE / 2), `partial pnl: sold share of the entry and of the buy fee, got ${half.pnlSol}`);
  const rest = liveSellAccounting({ entrySolSol: half.remainderEntry, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 5n, buyFeeSol: half.remainderBuyFeeSol, sellFeeSol: FEE });
  asrt(near(half.pnlSol + rest.pnlSol, 0.1 - 0.095 - FEE), "two halves add up: entry once, buy fee once (each part's sell fee is in its own wallet delta)");
  asrt(near(half.costs.buyFeeSol + rest.costs.buyFeeSol, FEE), "the buy fee is charged once across the parts");
  asrt(near(rest.remainderBuyFeeSol, 0) && near(rest.remainderEntry, 0), "nothing is left after the closing part");
}

// --- unknown buy fee: estimated ONCE across the parts, and flagged --------------------------------
{
  const est = txCostSol();
  const a = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 10n, buyFeeSol: null, sellFeeSol: FEE });
  asrt(a.costs.feesActual === false && a.buyFeeActual === false, "an unknown buy fee is estimated and flagged");
  asrt(near(a.costs.buyFeeSol, est / 2) && near(a.remainderBuyFeeSol, est / 2), "the estimate is split like a real fee");
  asrt(near(a.pnlSol, 0.05 - 0.0475 - est / 2), "the estimated buy fee is inside pnlSol");
  const b = liveSellAccounting({ entrySolSol: a.remainderEntry, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 5n, buyFeeSol: a.remainderBuyFeeSol, buyFeeActual: a.buyFeeActual, sellFeeSol: FEE });
  asrt(b.costs.feesActual === false, "the carried-over estimate stays flagged on the next part");
  asrt(near(a.costs.buyFeeSol + b.costs.buyFeeSol, est), "an estimated buy fee is charged once in total, not once per part");
}

// --- quote fallback (meta missing): flagged, fees estimated, still net of both fees ------------
{
  const pq = sellProceeds({ found: false }, 0.1);
  asrt(pq.receivedIsWalletNet === false && pq.receivedSol === 0.1 && pq.sellFeeSol === null, "no meta -> the quote, marked as not wallet-net");
  const q = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: pq.receivedSol, receivedIsWalletNet: false, soldRaw: 1n, totalRaw: 1n, buyFeeSol: null, sellFeeSol: pq.sellFeeSol });
  asrt(q.costs.feesActual === false, "unknown fees are flagged (feesActual:false)");
  asrt(near(q.costs.txSol, 2 * txCostSol()), "unknown fees fall back to the configured tx cost");
  asrt(near(q.ledger.receivedSol, 0.1), "a quote is not grossed up: the sell fee is not inside it");
  asrt(near(q.pnlSol, 0.1 - 0.095 - 2 * txCostSol()), `quote fallback pnl is net of both (estimated) fees too, got ${q.pnlSol}`);
  asrt(near(q.pnlSol, q.ledger.pnlSol - q.costs.costSol), "invariant holds for a quote");
}

// --- a sale that returned nothing is a LOSS of the entry and both fees, never break-even -------
{
  const dust = await readExecution("SELL_DUST", owner, mint, opts);
  asrt(dust.found && dust.tokensSold > 0n && dust.solReceivedSol === 0, "dust sale: tokens left, nothing arrived");
  const pd = sellProceeds(dust, 0.1);
  asrt(pd.receivedIsWalletNet === true, "tokens left the wallet -> the chain is trusted, not the (optimistic) quote");
  asrt(near(pd.receivedSol, -FEE), `the unclamped wallet delta is kept (-fee), got ${pd.receivedSol}`);
  const d = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: pd.receivedSol, soldRaw: dust.tokensSold, totalRaw: dust.tokensSold, buyFeeSol: FEE, sellFeeSol: pd.sellFeeSol });
  asrt(near(d.pnlSol, -0.095 - 2 * FEE), `nothing received -> pnl = -(entry + both fees), got ${d.pnlSol}`);
  asrt(near(d.pnlSol, buy.solDeltaSol + dust.solDeltaSol + RENT), "equals the real wallet delta without the rent");
  asrt(d.receivedSol === 0 && d.ledger.receivedSol === 0, "received is never negative in the journal / ledger");
}

// --- a returned WSOL-ATA rent (AMM sell) is not proceeds ---------------------------------------
{
  const amm = { found: true, tokensSold: 1n, feeSol: FEE, solDeltaSol: 0.1 + 0.00203928, rentReturnedSol: 0.00203928, solReceivedSol: 0.1 };
  asrt(near(sellProceeds(amm, 0).receivedSol, 0.1), "WSOL rent returned by the sell is excluded from the proceeds");
}

// --- no entry recorded (legacy position) -> nominal size --------------------------------------
asrt(near(liveSellAccounting({ buySol: BUY_SOL, receivedSol: 0.12, soldRaw: 1n, totalRaw: 1n, buyFeeSol: FEE, sellFeeSol: FEE }).pnlSol, 0.02 - FEE), "missing entrySolSol falls back to buySol");

// --- wiring: the sniper uses the shared calculation and the old arithmetic is gone -------------
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "sniper", "sniper.mjs"), "utf8");
  asrt(!/receivedSol - BUY_SOL/.test(src), "sniper: no `receivedSol - BUY_SOL` left in the live sell");
  asrt(!/costs\.txSol - costs\.slipSol/.test(src), "sniper: estimated tx/slip are not subtracted from actual proceeds");
  asrt(!/ex\.solReceivedSol > 0 \? ex\.solReceivedSol : BUY_SOL/.test(src), "sniper: a reconciled sale never falls back to BUY_SOL");
  asrt((src.match(/applyLiveSell\(pos, /g) || []).length === 2, "sniper: both live sell paths (normal + reconciled) use applyLiveSell");
  asrt((src.match(/session\.sell\(acc\.ledger\.receivedSol, acc\.ledger\.pnlSol, costs\)/g) || []).length === 2, "sniper: the ledger gets the gross figures + actual costs");
  asrt(/entrySolSol: BUY_SOL/.test(src) && /Object\.assign\(posRec, liveEntry\(ex, BUY_SOL\)\)/.test(src), "sniper: the position stores the actual entry (nominal until the buy lands)");
  // roundTripCosts is still the DRY model: exactly the two dry call sites remain.
  asrt((src.match(/roundTripCosts\(/g) || []).length === 2 && (src.match(/roundTripCosts\(\{ buySol: BUY_SOL, ratio \}\)/g) || []).length === 2, "sniper: dry-run cost model untouched (2 call sites, none in live)");
}
// The scheme stamp moved (live accounting changed) but keeps the "v2" family prefix the readers use.
// v2.3 (task 5) changed only the graduation DRY exit; the live arithmetic tested here is v2.2's.
asrt(COSTS_SCHEME.startsWith("v2.4") && /pnlSol net of both network fees/.test(COSTS_SCHEME), `COSTS_SCHEME is v2.4 and still describes the live model, got "${COSTS_SCHEME}"`);
// buyIx comment tells the truth about `amount`; the bytes are pinned by scripts/buyix-layout.test.mjs.
{
  const pf = fs.readFileSync(path.join(here, "..", "lib", "pumpfun.mjs"), "utf8");
  asrt(/`amount` is the TOKEN amount to buy/.test(pf) && /NOT verified on-chain/.test(pf), "pumpfun.mjs: buyIx comment follows the official IDL and says it is unverified");
  asrt(/data\.writeBigUInt64LE\(minTokens, 8\);/.test(pf), "pumpfun.mjs: the instruction bytes are untouched");
}

console.log(JSON.stringify({ entrySolSol: pos.entrySolSol, receivedSol: acc.receivedSol, pnlSol: acc.pnlSol, costsSol: acc.costs.costSol, costsScheme: COSTS_SCHEME.slice(0, 4) }));
console.log("PASS: live PnL = proceeds - actual entry - both real network fees; ledger reconciles with the wallet");
