// B9: the research lab keeps a mint's price history while any variant still holds an open paper
// position on it. This test pins the strategy-level invariant the lab relies on: a position whose
// price temporarily disappears (pruned source) must stay OPEN — not be dropped — and must be able
// to exit normally once a price returns.
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { StrategyLab } from "../lib/strategy.mjs";

const cfg = {
  name: "X",
  entry: "create",
  minHolders: 4,
  minSlots: 2,
  minDelayMs: 2500,
  takeProfit: 3.0,
  stopLoss: 0.2,
  timeoutSec: 999999,
  timeStopSec: null,
  timeStopMinGain: 0.3,
  partialAt: null,
  partialPct: null,
  trailPct: null,
  exitOnCreatorSell: false,
  exitOnGroupSell: false,
};
const lab = new StrategyLab({ variants: [cfg], buySol: 0.02, latencyMs: 0, priceWindow: 1 });

const ts = 1_000_000;
lab.onCreate({ mint: "M1", creator: "C1", ts, price: 0.01, ctx: { entryGroup: [], holders: 1, slots: 1, buyers: 1, createTs: ts } });
assert.deepEqual(lab.openMints(), new Set(["M1"]), "position open right after create-entry");

// Long after the lab's KEEP_SEC (320s): the price source is gone.
lab.onTick({ ts: ts + 400_000, priceOf: () => null });
assert.deepEqual(lab.openMints(), new Set(["M1"]), "no price -> position stays open (lab must keep the mint, not prune it)");

// A price returns and clears take-profit: the position must still be able to exit.
lab.onTrade({ mint: "M1", creator: "C1", ts: ts + 500_000, price: 0.035, isBuy: true, user: "U1", ctx: {}, organic: false, freshPrice: true });
assert.equal(lab.openMints().size, 0, "position exits once a price returns");
const res = lab.results()[0];
assert.equal(res.open, 0, "variant records the position as closed");
assert.equal(res.trades.length, 1, "one closed trade recorded");
assert.equal(res.trades[0].variant, "X", "trade belongs to the variant");

console.log(JSON.stringify({ stayedOpen: true, exitedOnReturn: true }));
console.log("PASS: lab positions survive a missing price and exit when it returns");
