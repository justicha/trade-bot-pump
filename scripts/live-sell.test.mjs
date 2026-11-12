import "./lib/test-env.mjs";
// One live-sale calculation for every bot (lib/live-pnl.mjs applyLiveSell), task 3:
//   P1 graduation: a sale reconciled after a confirm error measured the sold share against
//      `pos.tokens + soldRaw` (pos.tokens is not reduced yet) — a FULL sale looked like half of a
//      double-sized position: PnL overstated by half the entry, phantom position kept.
//   P2 graduation + copy-trader live sales (normal and reconciled) use the same calculation as the
//      sniper: actual entry, real network fees as costs, gross figures to the session ledger.
//      copy-trader's reconciled sale booked the FULL entry even for a SELL_PCT<100 partial sale.
//
// The live branches cannot be executed (lib/rpc.mjs refuses RPC_MOCK with --live), so the logic
// lives in lib/live-pnl.mjs, is tested here on mocked execution, and the bots are checked for
// calling it — and for no longer carrying their own arithmetic.
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
const { applyLiveSell, balanceBeforeSell, liveEntry } = await import("../lib/live-pnl.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const mock = await import("./mocks/live-accounting-mock.mjs");
const owner = new PublicKey(mock.OWNER);
const mint = new PublicKey(mock.MINT);
const opts = { retries: 1, delayMs: 0 };
const BUY_SOL = 0.1;
const FEE = mock.FEE / 1e9;
const RENT = mock.RENT / 1e9;
const T = mock.TOKENS;

const buy = await readExecution("BUY_NEW_ATA", owner, mint, opts);
const sellAll = await readExecution("SELL", owner, mint, opts);
const half1 = await readExecution("SELL_HALF_1", owner, mint, opts);
const half2 = await readExecution("SELL_HALF_2", owner, mint, opts);
const entry = liveEntry(buy, BUY_SOL);
// A position exactly as graduation-sniper stores it after a live buy.
const newPos = () => ({ tokens: buy.tokensReceived, ...entry, entryPrice: 1, entryTime: 0, attempts: 0 });

// ---------------------------------------------------------------------------------------------
// P1. Balance before a reconciled sale
// ---------------------------------------------------------------------------------------------
asrt(balanceBeforeSell({ balanceRaw: T, posTokens: T, soldRaw: T }) === T, "the balance read before the sale is the total");
asrt(balanceBeforeSell({ balanceRaw: null, posTokens: T, soldRaw: T / 2n }) === T, "balance never read -> the position's own token count");
asrt(balanceBeforeSell({ soldRaw: 7n }) === 7n, "nothing known -> what was sold (share = 1)");
asrt(balanceBeforeSell({ balanceRaw: 5n, posTokens: 5n, soldRaw: 9n }) === 9n, "never smaller than what was sold (no share > 1)");
asrt(balanceBeforeSell({ balanceRaw: "10", posTokens: null, soldRaw: 4n }) === 10n, "accepts string / bigint");

// A FULL sale that landed despite the confirm error: share = 1, position closed.
{
  const pos = newPos();
  const soldRaw = sellAll.tokensSold;
  const totalRaw = balanceBeforeSell({ balanceRaw: T, posTokens: pos.tokens, soldRaw });
  const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex: sellAll, soldRaw, totalRaw });
  asrt(sale.closed === true && sale.remainder === null, "reconciled full sale closes the position (no phantom remainder)");
  asrt(near(sale.acc.shareEntry, 0.095), `share = 1: the whole remaining entry, got ${sale.acc.shareEntry}`);
  asrt(near(sale.acc.pnlSol, 0.1 - 0.095 - FEE), `pnl = received - whole entry - buy fee, got ${sale.acc.pnlSol}`);

  // The old arithmetic on the same facts, for the record.
  const oldTotal = pos.tokens + soldRaw;
  const old = applyLiveSell(pos, { buySol: BUY_SOL, ex: sellAll, soldRaw, totalRaw: oldTotal });
  asrt(old.closed === false && old.remainder.tokens === T, "(old: pos.tokens + sold left a phantom position of the same size)");
  asrt(near(old.acc.shareEntry, 0.0475), "(old: only half of the entry was charged)");
  asrt(old.acc.pnlSol - sale.acc.pnlSol > 0.047, "(old: profit overstated by about half the entry)");
}

// A PARTIAL sale that landed despite the confirm error: the right share, the right remainder.
{
  const pos = newPos();
  const soldRaw = half1.tokensSold;
  asrt(soldRaw === T / 2n, "mock: half of the tokens were sold");
  const totalRaw = balanceBeforeSell({ balanceRaw: T, posTokens: pos.tokens, soldRaw });
  const sale = applyLiveSell(pos, { buySol: BUY_SOL, ex: half1, soldRaw, totalRaw });
  asrt(sale.closed === false, "partial sale keeps the position");
  asrt(near(sale.acc.shareEntry, 0.0475), `half sold -> half of the entry, got ${sale.acc.shareEntry}`);
  asrt(sale.remainder.tokens === T / 2n && near(sale.remainder.entrySolSol, 0.0475) && near(sale.remainder.buyFeeSol, FEE / 2), "remainder: tokens, entry share and buy-fee share");
  asrt(sale.fields.ataRentSol === 0, "a partial sale does not write the position's ATA rent");
  Object.assign(pos, sale.remainder, { attempts: 0, nextSellAt: 0 }); // what the bots do
  const last = applyLiveSell(pos, { buySol: BUY_SOL, ex: half2, soldRaw: half2.tokensSold, totalRaw: pos.tokens });
  asrt(last.closed === true, "the second half closes the position");
  asrt(near(last.fields.ataRentSol, RENT), "the closing sale writes the ATA rent once");
  asrt(near(sale.acc.pnlSol + last.acc.pnlSol, 0.1 - 0.095 - FEE), "both parts together: entry once, buy fee once");
}

// ---------------------------------------------------------------------------------------------
// P2. The same result for the three bots on the same mocks
// ---------------------------------------------------------------------------------------------
{
  // Position shapes as each bot builds them from liveEntry() after a live buy.
  const sniperPos = { tokens: buy.tokensReceived, entryPrice: 1, entrySolSol: BUY_SOL, entrySource: "quote-fallback", buyFeeSol: null, ataRentSol: 0, ataRentKnown: false, entryTime: 0 };
  Object.assign(sniperPos, entry); // sniper: Object.assign(posRec, liveEntry(ex, BUY_SOL))
  const gradPos = newPos(); // graduation: positions.set(mint, { tokens, ...entry, ... })
  const copyPos = { entryPrice: 1, ...entry, entryTime: 0, copiedFrom: "x" }; // copy-trader

  const args = { buySol: BUY_SOL, ex: sellAll, quoteSol: 0.2, soldRaw: T, totalRaw: T };
  const [s, g, c] = [sniperPos, gradPos, copyPos].map((p) => applyLiveSell(p, args));
  for (const [name, r] of [["sniper", s], ["graduation", g], ["copy-trader", c]]) {
    asrt(near(r.acc.pnlSol, 0.004545), `${name}: pnlSol +0.004545 on the common mock, got ${r.acc.pnlSol}`);
    asrt(r.acc.costs.feesActual === true, `${name}: the position carries the real buy fee (feesActual)`);
    asrt(near(r.acc.costs.costSol, 2 * FEE) && r.acc.costs.slipSol === 0, `${name}: costs = both real network fees, no assumed slippage`);
    asrt(r.closed === true && r.fromChain === true, `${name}: closed, from chain meta`);
    asrt(r.fields.entrySource === "chain-meta" && near(r.fields.entrySolSol, 0.095) && near(r.fields.solReceived, 0.1), `${name}: journal fields`);
    asrt(near(r.fields.buyFeeSol, FEE) && near(r.fields.sellFeeSol, FEE) && r.fields.feesActual === true && near(r.fields.ataRentSol, RENT), `${name}: fee and rent fields`);
  }
  asrt(JSON.stringify(s.acc) === JSON.stringify(g.acc) && JSON.stringify(g.acc) === JSON.stringify(c.acc), "identical accounting for the three bots");
  asrt(JSON.stringify(s.fields) === JSON.stringify(g.fields) && JSON.stringify(g.fields) === JSON.stringify(c.fields), "identical journal fields for the three bots");

  // Session ledger, as every bot feeds it: NET after costs == wallet delta without the ATA rent.
  const led = new SessionLedger({ label: "T", mode: "LIVE", startSol: 2 });
  led.buy(entry.entrySolSol).ataRent(entry.ataRentSol);
  led.sell(g.acc.ledger.receivedSol, g.acc.ledger.pnlSol, g.acc.costs);
  const walletDelta = buy.solDeltaSol + sellAll.solDeltaSol;
  const sum = led.report({ reason: "test", endSol: 2 + walletDelta });
  asrt(near(sum.netAfterCostsSol, walletDelta + RENT), `NET after costs == wallet delta minus the rent effect (${walletDelta + RENT}), got ${sum.netAfterCostsSol}`);
  asrt(near(sum.netAfterCostsInclRentSol, walletDelta), "incl. rent == wallet delta exactly");
  asrt(near(sum.netAfterCostsSol, g.acc.pnlSol), "the session's NET after costs equals the journal pnlSol of its only trade");
}

// Two-part sale through the ledger: still exact (2 sell fees, 1 buy fee, entry once).
{
  const pos = newPos();
  const led = new SessionLedger({ label: "T2", mode: "LIVE", startSol: 2 });
  led.buy(pos.entrySolSol).ataRent(pos.ataRentSol);
  const a = applyLiveSell(pos, { buySol: BUY_SOL, ex: half1, soldRaw: half1.tokensSold, totalRaw: T });
  led.sell(a.acc.ledger.receivedSol, a.acc.ledger.pnlSol, a.acc.costs);
  Object.assign(pos, a.remainder);
  const b = applyLiveSell(pos, { buySol: BUY_SOL, ex: half2, soldRaw: half2.tokensSold, totalRaw: pos.tokens });
  led.sell(b.acc.ledger.receivedSol, b.acc.ledger.pnlSol, b.acc.costs);
  const walletDelta = buy.solDeltaSol + half1.solDeltaSol + half2.solDeltaSol;
  const sum = led.report({ reason: "test", endSol: 2 + walletDelta });
  asrt(near(sum.costsSol, 3 * FEE), `two-part sale: 1 buy fee + 2 sell fees, got ${sum.costsSol}`);
  asrt(near(sum.netAfterCostsInclRentSol, walletDelta), `two-part sale reconciles with the wallet (${walletDelta}), got ${sum.netAfterCostsInclRentSol}`);
  asrt(near(a.acc.pnlSol + b.acc.pnlSol, sum.netAfterCostsSol), "sum of journal pnlSol == session NET after costs");
}

// copy-trader reconciled partial sale (SELL_PCT<100): the sold share only, remainder keeps its entry.
{
  const copyPos = { entryPrice: 1, ...entry, entryTime: 0, copiedFrom: "x" }; // no `tokens` field in this bot
  const soldRaw = half1.tokensSold;
  const totalRaw = balanceBeforeSell({ balanceRaw: T, posTokens: copyPos.tokens, soldRaw });
  const sale = applyLiveSell(copyPos, { buySol: BUY_SOL, ex: half1, soldRaw, totalRaw });
  asrt(sale.closed === false && near(sale.acc.shareEntry, 0.0475), "copy-trader reconciled partial: half of the entry, position kept");
  asrt(near(sale.acc.pnlSol, 0.05 - 0.0475 - FEE / 2), `not the full entry (old: 0.05 - 0.095 = -0.045), got ${sale.acc.pnlSol}`);
  Object.assign(copyPos, sale.remainder);
  asrt(near(copyPos.entrySolSol, 0.0475) && near(copyPos.buyFeeSol, FEE / 2), "the remainder's entry and buy fee are reduced");
}

// ---------------------------------------------------------------------------------------------
// Wiring: the bots call the shared calculation and carry no arithmetic of their own
// ---------------------------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const count = (src, re) => (src.match(re) || []).length;
{
  const src = read("bots/graduation-sniper/graduation.mjs");
  const sell = src.slice(src.indexOf("async function sellPosition"), src.indexOf("async function monitorPositions"));
  const live = sell; // whole function; its DRY branch is checked separately below
  asrt(!/\(pos\.tokens \?\? 0n\) \+ soldRaw/.test(src), "graduation: `pos.tokens + soldRaw` is gone (P1)");
  asrt(/let total = null;/.test(sell) && /\n\s+total = BigInt\(info\.value\.amount\);/.test(sell), "graduation: the pre-sale balance is visible in the catch");
  asrt(/balanceBeforeSell\(\{ balanceRaw: total, posTokens: pos\.tokens, soldRaw \}\)/.test(sell), "graduation: reconciled sale measures against the balance read before the sale");
  asrt(count(live, /applyLiveSell\(pos, /g) === 2, "graduation: normal + reconciled sale use applyLiveSell");
  asrt(count(live, /session\.sell\(sale\.acc\.ledger\.receivedSol, sale\.acc\.ledger\.pnlSol, sale\.acc\.costs\)/g) === 2, "graduation: ledger gets gross figures + real fees (both paths)");
  asrt(count(live, /\.\.\.sale\.fields/g) === 2, "graduation: both sell rows carry the shared live fields");
  // Task 5 / P4: the dry branch moved to netRatioExitCosts (no double pump fee); the live paths
  // still carry no estimated costs at all.
  asrt(count(src, /roundTripCosts\(/g) === 0 && count(sell, /netRatioExitCosts\(\{ entrySol, ratio: mult \}\)/g) === 1, "graduation: no roundTripCosts; the DRY branch uses netRatioExitCosts once");
  asrt(!/pumpFeeBps: 0/.test(src) && !/splitEntryForSell/.test(src), "graduation: no estimated live costs, no hand-rolled entry split");
  asrt(count(src, /\.\.\.entry, \/\/ entrySolSol, entrySource, buyFeeSol/g) === 2, "graduation: both buy paths store every entry fact (incl. buyFeeSol)");
  asrt(count(sell, /Object\.assign\(pos, sale\.remainder, \{ attempts: 0, nextSellAt: 0 \}\)/g) === 2, "graduation: a partial sale keeps tokens, entry share and buy-fee share");
}
{
  const src = read("bots/copy-trader/watcher.mjs");
  const sell = src.slice(src.indexOf("async function copySell"), src.indexOf("async function finish"));
  asrt(count(sell, /applyLiveSell\(pos, /g) === 2, "copy-trader: normal + reconciled sale use applyLiveSell");
  asrt(count(sell, /session\.sell\(sale\.acc\.ledger\.receivedSol, sale\.acc\.ledger\.pnlSol, sale\.acc\.costs\)/g) === 2, "copy-trader: ledger gets gross figures + real fees (both paths)");
  asrt(/let total = null;/.test(sell) && /balanceBeforeSell\(\{ balanceRaw: total, posTokens: pos\.tokens, soldRaw \}\)/.test(sell), "copy-trader: reconciled sale measures against the pre-sale balance");
  asrt(count(sell, /if \(sale\.closed\) positions\.delete\(mint\);\s+else Object\.assign\(pos, sale\.remainder\);/g) === 2, "copy-trader: both paths keep the remainder of a partial sale");
  asrt(!/ex\.solReceivedSol > 0 \? ex\.solReceivedSol : BUY_SOL/.test(src), "copy-trader: a reconciled sale never falls back to BUY_SOL");
  asrt(!/session\.sell\(receivedSol, pnlSol, null\)/.test(src), "copy-trader: reconciled sale no longer skips the costs");
  asrt(count(src, /roundTripCosts\(/g) === 1 && !/pumpFeeBps: 0/.test(src) && !/splitEntryForSell/.test(src), "copy-trader: roundTripCosts only in the DRY branch");
  asrt(count(src, /positions\.set\(mint, \{ entryPrice: \w+, \.\.\.entry, /g) === 2, "copy-trader: both buy paths store every entry fact (incl. buyFeeSol)");
}
{
  const src = read("bots/sniper/sniper.mjs");
  asrt(!/function liveFields/.test(src) && count(src, /live: sale\.fields/g) === 2, "sniper: journal fields come from the shared helper");
}

console.log(JSON.stringify({ reconciledFull: "share=1, closed", reconciledPartial: "share=0.5, kept", parity: 3 }));
console.log("PASS: one live-sale calculation for sniper / graduation / copy-trader; reconciled sales use the pre-sale balance");
