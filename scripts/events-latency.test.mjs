// Tests for the validated event parser, the execution-latency model and the freeze rule.
process.env.RPC_URL = "https://example.invalid/?api-key=test";
process.env.SLIPPAGE_ASSUMED_BPS = "0";
const bs58 = (await import("bs58")).default;
const { parseTrade, describe, reservesOf, tradeDirection } = await import("../lib/events.mjs");
const { StrategyLab, buildVariants } = await import("../lib/strategy.mjs");
const { evaluateFrozen, slippageSensitivity } = await import("../lib/research.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// build a payload with the measured V3 layout
function payload({ len = 129, vSol = 30_000_000_000n, vTok = 1_073_000_000_000_000n, isBuy = true, mint }) {
  const mintBytes = mint || Buffer.alloc(32, 7);
  const b = Buffer.alloc(Math.max(len, 89));
  Buffer.from("bddb7fd34ee661ee", "hex").copy(b, 0);
  mintBytes.copy(b, 8);
  b.writeBigUInt64LE(20_000_000n, 40);
  b.writeBigUInt64LE(700_000_000_000n, 48);
  b[56] = isBuy ? 1 : 0;
  Buffer.alloc(32, 9).copy(b, 57);
  if (len >= 97) b.writeBigUInt64LE(1_700_000_000_000n, 89);
  if (len >= 113) {
    b.writeBigUInt64LE(vSol, 97);
    b.writeBigUInt64LE(vTok, 105);
  }
  return b;
}

// ---- parser -----------------------------------------------------------------
{
  const mint = Buffer.alloc(32, 3);
  const ev = parseTrade(payload({ mint }));
  asrt(ev !== null, "129-byte payload must parse");
  asrt(ev.mint === bs58.encode(mint), "mint base58 matches bs58: " + ev.mint);
  asrt(ev.isBuyByte === true, "is_buy read from byte 56");
  asrt(ev.hasReserves === true, "reserves usable");
  asrt(Number(ev.reserves.vSol) === 30_000_000_000, "vSol decoded at offset 97");
  asrt(Number(ev.reserves.vTok) === 1_073_000_000_000_000, "vTok decoded at offset 105");
  asrt(Number(ev.solAmount) === 0.02, "sol amount 0.02, got " + ev.solAmount);
  asrt(ev.timestampMs === 1_700_000_000_000, "timestamp at offset 89");

  const dir = tradeDirection(ev, false);
  asrt(dir.isBuy === true && dir.disagreed === true, "payload byte wins over the instruction name");

  const short = parseTrade(payload({ len: 89 }));
  asrt(short !== null && short.reserves === null && short.hasReserves === false, "89-byte payload has no reserves");

  const ns = parseTrade(payload({ len: 401, vSol: 0n, vTok: 0n }));
  asrt(ns !== null && ns.hasReserves === false && ns.reserves.usable === false, "zero-reserve payload is not usable");

  const alien = Buffer.alloc(153, 1);
  asrt(describe(alien).type === "unknown", "alien payload type");
  asrt(parseTrade(alien) === null, "alien payload is not a trade");
  asrt(reservesOf(Buffer.alloc(64, 0)) === null, "too short -> no reserves");
}
// ---- latency ----------------------------------------------------------------
{
  const variants = buildVariants();
  const lab = new StrategyLab({ variants, buySol: 1, slippageBps: 0, txSol: 0, latencyMs: 600 });
  const events = [];
  lab.onEvent = (e) => events.push(e);
  const crowd = { holders: 5, buyers: 5, slots: 3, msSinceCreate: 4000, createTs: 0 };

  lab.onTrade({ mint: "L1", creator: "dev", ts: 1000, price: 1, isBuy: true, user: "w1", organic: true, ctx: crowd });
  asrt(lab.results().find((r) => r.variant === "B").open === 0, "entry must not fill instantly with latency");
  asrt(events.some((e) => e.type === "entry_pending"), "entry_pending emitted");

  lab.onTrade({ mint: "L1", creator: "dev", ts: 1300, price: 1.2, isBuy: true, user: "w2", organic: false });
  asrt(lab.results().find((r) => r.variant === "B").open === 0, "still pending before the 600ms deadline");

  lab.onTrade({ mint: "L1", creator: "dev", ts: 1700, price: 1.25, isBuy: true, user: "w3", organic: false });
  asrt(lab.results().find((r) => r.variant === "B").open === 1, "filled after the latency window");
  const entry = events.find((e) => e.type === "entry" && e.variant === "B");
  asrt(entry.price === 1.25, "fill price is the price at/after the deadline, got " + entry.price);

  // three prints above 2x so the median (not a single tick) allows take-profit
  lab.onTrade({ mint: "L1", creator: "dev", ts: 1900, price: 2.5, isBuy: true, user: "w3", organic: false });
  lab.onTrade({ mint: "L1", creator: "dev", ts: 1950, price: 2.5, isBuy: true, user: "w3", organic: false });
  lab.onTrade({ mint: "L1", creator: "dev", ts: 2000, price: 2.5, isBuy: true, user: "w4", organic: false });
  asrt(lab.results().find((r) => r.variant === "B").trades.length === 0, "exit decision must not fill instantly");
  lab.onTrade({ mint: "L1", creator: "dev", ts: 2700, price: 2.1, isBuy: true, user: "w5", organic: false });
  const b2 = lab.results().find((r) => r.variant === "B");
  asrt(b2.trades.length === 1, "exit filled after latency");
  asrt(Math.abs(b2.trades[0].exitPrice - 2.1) < 1e-12, "exit fill price is the later price, got " + b2.trades[0].exitPrice);
}

// ---- slippage sensitivity is monotone ---------------------------------------
{
  const rows = slippageSensitivity([{ buySol: 0.02, grossRatio: 2 }], [50, 100, 200]);
  asrt(rows[0].meanPct > rows[1].meanPct && rows[1].meanPct > rows[2].meanPct, "more slippage -> worse return");
}

// ---- freeze: only post-freeze trades, 99% CI --------------------------------
{
  const mk = (ts, pct) => ({ exitTs: ts, pnlPct: pct, pnlSol: pct / 1000, reason: "x" });
  const trades = [mk(100, 50), mk(200, 50), ...Array.from({ length: 400 }, (_, i) => mk(1000 + i, 5))];
  const ev = evaluateFrozen(trades, { variant: "B", frozenAt: 500 }, { minTrades: 300, resamples: 500 });
  asrt(ev.n === 400, "only trades closed after the freeze count, got " + ev.n);
  asrt(ev.pass === true, "constant +5% after the freeze must pass: " + ev.reason);
  asrt(ev.alpha === 0.01, "99% CI is used");

  const few = evaluateFrozen(trades, { variant: "B", frozenAt: 1100 }, { minTrades: 300, resamples: 500 });
  asrt(few.pass === false && /only/.test(few.reason), "too few post-freeze trades must fail: " + few.reason);
}

console.log("PASS: parser layout verified on fixtures, latency defers fills, slippage monotone, freeze judges only post-freeze trades");
