import "./lib/test-env.mjs";
// P4 (audit bug 5): the sniper's LIVE PnL comes from actual execution — received minus the actual
// entry — with no estimated tx fee / assumed slippage subtracted on top of the real fill, and
// every network fee counted exactly once in the session ledger.
//
// Fails without the fix: lib/live-pnl.mjs does not exist; the sniper still computes
// `receivedSol - BUY_SOL - costs.txSol - costs.slipSol` (spent 0.095 / received 0.1 with a nominal
// 0.1 SOL buy was booked as a LOSS of about -0.0019 SOL instead of +0.005).
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
const { liveEntry, liveSellAccounting } = await import("../lib/live-pnl.mjs");
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

const acc = liveSellAccounting({
  entrySolSol: pos.entrySolSol,
  buySol: BUY_SOL,
  receivedSol: sell.solReceivedSol,
  receivedIsWalletNet: true,
  soldRaw: sell.tokensSold,
  totalRaw: sell.tokensSold,
  buyFeeSol: pos.buyFeeSol,
  sellFeeSol: sell.feeSol,
});
asrt(near(acc.pnlSol, 0.005), `spent 0.095, received 0.1 -> pnlSol +0.005 (no estimated costs subtracted), got ${acc.pnlSol}`);
asrt(acc.costs.slipSol === 0, "live costs: slipSol = 0 (the real slippage is inside the fill)");
asrt(acc.costs.feeSol === 0, "live costs: pump fees are inside entry/received, not charged again");
asrt(near(acc.costs.txSol, 2 * FEE) && near(acc.costs.costSol, 2 * FEE), `live costs = actual buy fee + actual sell fee, got ${acc.costs.txSol}`);
asrt(acc.costs.feesActual === true, "both fees came from the chain");
asrt(near(acc.costs.buyFeeSol, FEE) && near(acc.costs.sellFeeSol, FEE), "per-leg fees are journaled");

// The old formula, for the record: it called this winning trade a loss.
{
  const est = roundTripCosts({ buySol: BUY_SOL, ratio: 1, pumpFeeBps: 0 });
  const oldPnl = sell.solReceivedSol - BUY_SOL - est.txSol - est.slipSol;
  asrt(oldPnl < 0 && acc.pnlSol > 0, `old formula booked a loss (${oldPnl.toFixed(6)}) on a +0.005 trade`);
}

// --- every fee exactly once: the ledger reconciles with the wallet -----------------------------
{
  const s = new SessionLedger({ label: "T", mode: "LIVE", startSol: 2 });
  s.buy(pos.entrySolSol).ataRent(pos.ataRentSol);
  s.sell(acc.ledger.receivedSol, acc.ledger.pnlSol, acc.costs);
  const walletDelta = buy.solDeltaSol + sell.solDeltaSol; // what really happened to the wallet
  const sum = s.report({ reason: "test", endSol: 2 + walletDelta });
  asrt(near(sum.netSol, 0.005 + FEE), `ledger NET is gross of network fees (0.005 + sell fee), got ${sum.netSol}`);
  asrt(near(sum.costsSol, 2 * FEE), `ledger costs = both real fees, got ${sum.costsSol}`);
  asrt(near(sum.netAfterCostsSol, 0.005 - FEE), `NET after costs = pnl - buy fee (sell fee not counted twice), got ${sum.netAfterCostsSol}`);
  asrt(near(sum.netAfterCostsInclRentSol, walletDelta), `NET after costs incl. rent == real wallet delta (${walletDelta}), got ${sum.netAfterCostsInclRentSol}`);
  asrt(near(sum.netAfterCostsSol - RENT, walletDelta), "the only gap to the wallet is the ATA rent");
}

// --- partial sell: the entry and the buy fee are split by the sold share -----------------------
{
  const half = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 10n, buyFeeSol: FEE, sellFeeSol: FEE });
  asrt(near(half.shareEntry, 0.0475) && near(half.remainderEntry, 0.0475), `half sold -> half of the entry, got ${half.shareEntry}/${half.remainderEntry}`);
  asrt(near(half.pnlSol, 0.0025), `partial pnl against the sold share only, got ${half.pnlSol}`);
  asrt(near(half.costs.buyFeeSol, FEE / 2) && near(half.remainderBuyFeeSol, FEE / 2), "the buy fee is split too, the rest stays with the position");
  const rest = liveSellAccounting({ entrySolSol: half.remainderEntry, buySol: BUY_SOL, receivedSol: 0.05, soldRaw: 5n, totalRaw: 5n, buyFeeSol: half.remainderBuyFeeSol, sellFeeSol: FEE });
  asrt(near(half.pnlSol + rest.pnlSol, 0.005), "two halves add up to the full-position pnl (entry never counted twice)");
  asrt(near(half.costs.buyFeeSol + rest.costs.buyFeeSol, FEE), "the buy fee is charged once across the parts");
}

// --- quote fallback (meta missing): flagged, fees estimated, no gross-up of an estimate --------
{
  const q = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: 0.1, receivedIsWalletNet: false, soldRaw: 1n, totalRaw: 1n, buyFeeSol: null, sellFeeSol: null });
  asrt(q.costs.feesActual === false, "unknown fees are flagged (feesActual:false)");
  asrt(near(q.costs.txSol, 2 * txCostSol()), "unknown fees fall back to the configured tx cost");
  asrt(near(q.ledger.receivedSol, 0.1) && near(q.ledger.pnlSol, q.pnlSol), "a quote is not grossed up: the fee is not inside it");
  asrt(q.remainderBuyFeeSol === null, "an unknown buy fee stays unknown");
}

// --- a reconciled sale that returned nothing is a LOSS, not break-even -------------------------
{
  const dust = await readExecution("SELL_DUST", owner, mint, opts);
  asrt(dust.found && dust.tokensSold > 0n && dust.solReceivedSol === 0, "dust sale: tokens left, nothing arrived");
  const d = liveSellAccounting({ entrySolSol: 0.095, buySol: BUY_SOL, receivedSol: dust.solReceivedSol, soldRaw: dust.tokensSold, totalRaw: dust.tokensSold, buyFeeSol: FEE, sellFeeSol: dust.feeSol });
  asrt(near(d.pnlSol, -0.095), `nothing received -> pnl = -entry (old code substituted BUY_SOL = break-even), got ${d.pnlSol}`);
}

// --- no entry recorded (legacy position) -> nominal size --------------------------------------
asrt(near(liveSellAccounting({ buySol: BUY_SOL, receivedSol: 0.12, soldRaw: 1n, totalRaw: 1n }).pnlSol, 0.02), "missing entrySolSol falls back to buySol");

// --- wiring: the sniper uses the helper and the old arithmetic is gone -------------------------
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "sniper", "sniper.mjs"), "utf8");
  asrt(!/receivedSol - BUY_SOL/.test(src), "sniper: no `receivedSol - BUY_SOL` left in the live sell");
  asrt(!/costs\.txSol - costs\.slipSol/.test(src), "sniper: estimated tx/slip are not subtracted from actual proceeds");
  asrt(!/ex\.solReceivedSol > 0 \? ex\.solReceivedSol : BUY_SOL/.test(src), "sniper: a reconciled sale never falls back to BUY_SOL");
  asrt((src.match(/liveSellAccounting\(/g) || []).length === 2, "sniper: both live sell paths (normal + reconciled) use liveSellAccounting");
  asrt(/session\.sell\(acc\.ledger\.receivedSol, acc\.ledger\.pnlSol, costs\)/.test(src), "sniper: the ledger gets the gross figures + actual costs");
  asrt(/entrySolSol: BUY_SOL/.test(src) && /Object\.assign\(posRec, liveEntry\(ex, BUY_SOL\)\)/.test(src), "sniper: the position stores the actual entry (nominal until the buy lands)");
  // roundTripCosts is still the DRY model: exactly the two dry call sites remain.
  asrt((src.match(/roundTripCosts\(\{ buySol: BUY_SOL, ratio \}\)/g) || []).length === 2, "sniper: dry-run cost model untouched (2 call sites)");
}
// The scheme stamp moved (live accounting changed) but keeps the "v2" family prefix the readers use.
asrt(COSTS_SCHEME.startsWith("v2.1"), `COSTS_SCHEME bumped to v2.1, got "${COSTS_SCHEME}"`);
// buyIx comment tells the truth about `amount`; the bytes are pinned by scripts/buyix-layout.test.mjs.
{
  const pf = fs.readFileSync(path.join(here, "..", "lib", "pumpfun.mjs"), "utf8");
  asrt(/`amount` is the TOKEN amount to buy/.test(pf) && /NOT verified on-chain/.test(pf), "pumpfun.mjs: buyIx comment follows the official IDL and says it is unverified");
  asrt(/data\.writeBigUInt64LE\(minTokens, 8\);/.test(pf), "pumpfun.mjs: the instruction bytes are untouched");
}

console.log(JSON.stringify({ entrySolSol: pos.entrySolSol, receivedSol: acc.receivedSol, pnlSol: acc.pnlSol, costsSol: acc.costs.costSol, costsScheme: COSTS_SCHEME.slice(0, 4) }));
console.log("PASS: live PnL = received - actual entry, real fees counted once, ledger reconciles with the wallet");
