// Deterministic tests for the strategy variants A..E (paper trading, no network).
process.env.RPC_URL = "https://example.invalid/?api-key=test";
process.env.SLIPPAGE_ASSUMED_BPS = "0"; // costs are asserted separately in research.test.mjs

const { StrategyLab, buildVariants, statsOf } = await import("../lib/strategy.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const labWith = () => {
  const variants = buildVariants();
  const lab = new StrategyLab({ variants, buySol: 1, slippageBps: 0, txSol: 0 });
  const events = [];
  lab.onEvent = (e) => events.push(e);
  return { lab, events };
};

const CROWD = { holders: 5, buyers: 5, slots: 3, msSinceCreate: 4000, createTs: 0 };
const res = (lab, name) => lab.results().find((r) => r.variant === name);

// A: buys the create event, exits at take-profit
{
  const { lab } = labWith();
  lab.onCreate({ mint: "A1", creator: "dev", ts: 0, price: 1, ctx: {} });
  // take-profit needs the median of 3 fresh prices, so feed three prints
  for (const ts of [5000, 5100, 5200]) {
    lab.onTrade({ mint: "A1", creator: "dev", ts, price: 2.2, isBuy: true, user: "x", organic: false });
  }
  const a = res(lab, "A");
  asrt(a.trades.length === 1, "A closes one trade, got " + a.trades.length);
  asrt(/take-profit/.test(a.trades[0].reason), "A exits on take-profit: " + a.trades[0].reason);
  asrt(a.trades[0].pnlPct > 115 && a.trades[0].pnlPct < 118, "A pnl after 2% fees ~116.8%, got " + a.trades[0].pnlPct);
}

// B: refuses the instant one-slot bundle, enters on a real crowd
{
  const { lab } = labWith();
  lab.onCreate({ mint: "B1", creator: "dev", ts: 0, price: 1, ctx: {} });
  for (const u of ["w1", "w2", "w3", "w4"]) {
    lab.onTrade({
      mint: "B1",
      creator: "dev",
      ts: 400,
      price: 1,
      isBuy: true,
      user: u,
      organic: false,
      ctx: { holders: 4, buyers: 4, slots: 1, msSinceCreate: 400, createTs: 0 },
    });
  }
  const b0 = res(lab, "B");
  asrt(b0.open === 0 && b0.trades.length === 0, "B must not enter an instant bundle");
  lab.onTrade({ mint: "B1", creator: "dev", ts: 4200, price: 1, isBuy: true, user: "w5", organic: true, ctx: CROWD });
  asrt(res(lab, "B").open === 1, "B enters on the organic crowd");
}

// C: time-stop after 35 s without progress
{
  const { lab } = labWith();
  lab.onCreate({ mint: "C1", creator: "dev", ts: 0, price: 1, ctx: {} });
  lab.onTrade({ mint: "C1", creator: "dev", ts: 3000, price: 1, isBuy: true, user: "w1", organic: true, ctx: CROWD });
  lab.onTrade({ mint: "C1", creator: "dev", ts: 40_000, price: 1.1, isBuy: true, user: "w9", organic: false });
  const c = res(lab, "C");
  asrt(c.trades.length === 1 && /time-stop/.test(c.trades[0].reason), "C must time-stop: " + c.trades[0]?.reason);
}

// D: half out at 2x, remainder trails the peak
{
  const { lab, events } = labWith();
  lab.onCreate({ mint: "D1", creator: "dev", ts: 0, price: 1, ctx: {} });
  lab.onTrade({ mint: "D1", creator: "dev", ts: 3000, price: 1, isBuy: true, user: "w1", organic: true, ctx: CROWD });
  for (const ts of [4000, 4050, 4100]) {
    lab.onTrade({ mint: "D1", creator: "dev", ts, price: 2.0, isBuy: true, user: "w2", organic: false });
  }
  asrt(events.filter((e) => e.type === "partial" && e.variant === "D").length === 1, "exactly one partial at 2x for D");
  lab.onTrade({ mint: "D1", creator: "dev", ts: 5000, price: 1.6, isBuy: true, user: "w2", organic: false });
  asrt(res(lab, "D").open === 1, "20% off peak must not trigger a 25% trail");
  // the median needs a couple of prints to register the drop as well
  for (const ts of [6000, 6100, 6200]) {
    lab.onTrade({ mint: "D1", creator: "dev", ts, price: 1.45, isBuy: true, user: "w2", organic: false });
  }
  const d = res(lab, "D");
  asrt(d.trades.length === 1, "trailing closes the remainder");
  asrt(/trailing/.test(d.trades[0].reason), "reason must be trailing: " + d.trades[0].reason);
  asrt(d.trades[0].partial === true, "trade is marked partially realised");
  asrt(d.trades[0].pnlPct > 65 && d.trades[0].pnlPct < 75, "blended pnl ~69.8%, got " + d.trades[0].pnlPct);
}

// E: exits when the creator sells
{
  const { lab } = labWith();
  lab.onCreate({ mint: "E1", creator: "dev", ts: 0, price: 1, ctx: {} });
  lab.onTrade({ mint: "E1", creator: "dev", ts: 3000, price: 1, isBuy: true, user: "w1", organic: true, ctx: CROWD });
  asrt(res(lab, "E").open === 1, "E enters on the crowd");
  lab.onTrade({ mint: "E1", creator: "dev", ts: 3500, price: 0.95, isBuy: false, user: "dev", organic: false });
  const e = res(lab, "E");
  asrt(e.trades.length === 1 && e.trades[0].reason === "creator-sell", "E exits on creator-sell: " + e.trades[0]?.reason);
  asrt(res(lab, "B").open === 1, "B (no creator rule) still holds");
}

// stop-loss beats the time-stop on the same tick
{
  const { lab } = labWith();
  lab.onCreate({ mint: "S1", creator: "dev", ts: 0, price: 1, ctx: {} });
  lab.onTrade({ mint: "S1", creator: "dev", ts: 3000, price: 1, isBuy: true, user: "w1", organic: true, ctx: CROWD });
  // a crash is several prints; the median needs them (and they land before the 35s time-stop)
  for (const ts of [30_000, 30_100, 30_200]) {
    lab.onTrade({ mint: "S1", creator: "dev", ts, price: 0.45, isBuy: true, user: "w2", organic: false });
  }
  const c = res(lab, "C");
  asrt(/stop-loss/.test(c.trades[0].reason), "stop-loss must win: " + c.trades[0].reason);
}

// spike guard: one print cannot trigger take-profit
{
  const { lab } = labWith();
  lab.onCreate({ mint: "SP1", creator: "dev", ts: 0, price: 1, ctx: {} });
  lab.onTrade({ mint: "SP1", creator: "dev", ts: 1000, price: 5.0, isBuy: true, user: "x", organic: false });
  asrt(res(lab, "A").trades.length === 0, "one 5x print must not close the position");
  asrt(res(lab, "A").open === 1, "position stays open after a single spike");
  lab.onTrade({ mint: "SP1", creator: "dev", ts: 1100, price: 1.1, isBuy: true, user: "x", organic: false });
  lab.onTrade({ mint: "SP1", creator: "dev", ts: 1200, price: 1.15, isBuy: true, user: "x", organic: false });
  const a = res(lab, "A");
  asrt(a.trades.length === 0, "median of [5.0,1.1,1.15] is 1.15x -> no take-profit, got " + JSON.stringify(a.trades[0]?.reason));
}

// stats: drawdown / tp share / big losses
{
  const st = statsOf([
    { pnlPct: 100, pnlSol: 0.02, reason: "take-profit 2x" },
    { pnlPct: -60, pnlSol: -0.012, reason: "stop-loss 0.4x" },
    { pnlPct: -55, pnlSol: -0.011, reason: "stop-loss 0.45x" },
  ]);
  asrt(st.n === 3, "3 trades");
  asrt(st.tpShare === 33.3, "tp share 33.3%, got " + st.tpShare);
  asrt(st.bigLossShare === 66.7, "2 of 3 are worse than -50%, got " + st.bigLossShare);
  asrt(st.maxDrawdownSol === 0.023, "drawdown 0.023 SOL, got " + st.maxDrawdownSol);
}

console.log(JSON.stringify({ variants: buildVariants().map((v) => v.name) }));
console.log("PASS: A-E variants behave (bundle rejected, time-stop, partial+trailing, creator-sell, SL priority)");
