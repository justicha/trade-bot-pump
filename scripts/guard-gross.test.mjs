import "./lib/test-env.mjs";
// Task 4 (decision 2026-11-12): "a profitable trade is not a minus — the network fee is small".
//   MAX_CONSEC_LOSSES (TradeGuard) classifies a LIVE sale by its PnL BEFORE network fees
//   (applyLiveSell.guardPnlSol = acc.ledger.pnlSol). The day's net (daily loss limit) and the
//   journal pnlSol keep the real figure, net of both fees. STUCK is still a loss for both.
//
// Fails without the fix: TradeGuard.recordResult ignores the option (a +0.0002-before-fees sale
// with pnlSol -0.000255 counts as a loss); applyLiveSell has no guardPnlSol; the bots do not pass it.
//
// The bots' own recordResult functions are evaluated from their source with a real TradeGuard and
// a local day counter, so the test exercises the exact code the bots run (without starting them).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const { TradeGuard } = await import("../lib/guards.mjs");
const { applyLiveSell } = await import("../lib/live-pnl.mjs");
const { recordStuck } = await import("../lib/stuck.mjs");
const { netSolForDay } = await import("../lib/daily-loss.mjs");
const { mskDateKey } = await import("../lib/time.mjs");

const FEE = 0.000455; // 5000 base + 300k CU * 1.5 µlamports
const BUY_SOL = 0.1;
const newGuard = () => new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses: 3 });

// A sale that made +0.0002 before network fees and -0.000255 after them (one 0.000455 fee).
// buyFeeSol 0 keeps the numbers of the task; the realistic both-fees case follows below.
function saleOf({ entry = 0.095, grossProceeds, buyFeeSol, sellFeeSol = FEE }) {
  const pos = { entrySolSol: entry, buyFeeSol, entrySource: "chain-meta", ataRentSol: 0 };
  const walletDelta = grossProceeds - sellFeeSol; // what the chain reports for the sell
  const ex = { found: true, tokensSold: 1n, feeSol: sellFeeSol, solDeltaSol: walletDelta, rentReturnedSol: 0, solReceivedSol: Math.max(0, walletDelta) };
  return applyLiveSell(pos, { buySol: BUY_SOL, ex, soldRaw: 1n, totalRaw: 1n });
}

// --- the sale itself: gross >= 0, net < 0 -----------------------------------------------------
const small = saleOf({ grossProceeds: 0.0952, buyFeeSol: 0 });
asrt(near(small.guardPnlSol, 0.0002), `guardPnlSol = PnL before network fees = +0.0002, got ${small.guardPnlSol}`);
asrt(near(small.acc.pnlSol, -0.000255), `pnlSol (journal / day) stays net of fees = -0.000255, got ${small.acc.pnlSol}`);
asrt(small.guardPnlSol === small.acc.ledger.pnlSol, "guardPnlSol is exactly the ledger's gross pnl (one definition)");
asrt(near(small.fields.guardPnlSol, 0.0002), "the journal row shows what the guard saw (guardPnlSol)");

// --- TradeGuard: classification by guardPnlSol when given --------------------------------------
{
  const g = newGuard();
  g.recordResult(-0.01); // an earlier real loss
  asrt(g.consecLosses === 1, "setup: one loss");
  g.recordResult(small.acc.pnlSol, { guardPnlSol: small.guardPnlSol });
  asrt(g.consecLosses === 0, `profitable before fees -> NOT a loss (streak not increased, reset as any non-loss), got ${g.consecLosses}`);
  g.recordResult(-0.01, { guardPnlSol: -0.004 });
  asrt(g.consecLosses === 1, "a sale that lost before fees is a loss");
  g.recordResult(-0.01);
  asrt(g.consecLosses === 2, "without the option the old rule applies (pnlSol < 0 -> loss)");
  g.recordResult(-0.002, { guardPnlSol: 0 });
  asrt(g.consecLosses === 0, "exactly 0 before fees is not a loss (>= 0)");
  g.recordResult(-0.01, { guardPnlSol: null });
  g.recordResult(-0.01, { guardPnlSol: NaN });
  asrt(g.consecLosses === 2, "null / NaN guardPnlSol fall back to pnlSol");
}

// Three such fee-only "losses" in a row never halt the session; three real ones do.
{
  const g = newGuard();
  for (let i = 0; i < 3; i++) g.recordResult(small.acc.pnlSol, { guardPnlSol: small.guardPnlSol });
  asrt(!g.halted && g.consecLosses === 0, "3 trades profitable before fees do not trip MAX_CONSEC_LOSSES=3");
  for (let i = 0; i < 3; i++) g.recordResult(-0.01, { guardPnlSol: -0.005 });
  asrt(g.halted === true, "3 trades losing before fees do trip it");
}

// Realistic case: both fees (0.00091) bigger than a +0.0002 gross profit.
{
  const both = saleOf({ grossProceeds: 0.0952, buyFeeSol: FEE });
  asrt(near(both.guardPnlSol, 0.0002) && near(both.acc.pnlSol, 0.0002 - 2 * FEE), `both fees: gross +0.0002, net ${both.acc.pnlSol}`);
  const g = newGuard();
  g.recordResult(both.acc.pnlSol, { guardPnlSol: both.guardPnlSol });
  asrt(g.consecLosses === 0, "both-fees case: still not a loss for the guard");
  const loss = saleOf({ grossProceeds: 0.094, buyFeeSol: FEE });
  asrt(loss.guardPnlSol < 0, "a sale below the entry is negative before fees");
  g.recordResult(loss.acc.pnlSol, { guardPnlSol: loss.guardPnlSol });
  asrt(g.consecLosses === 1, "…and counts as a loss");
}

// --- STUCK stays a loss for the guard and for the day ------------------------------------------
{
  const g = newGuard();
  let day = 0;
  const rec = (p, opts) => { g.recordResult(p, opts); day += p; };
  recordStuck({ recordResult: rec, mint: "S", pos: { entrySolSol: 0.02 }, buySol: BUY_SOL, reason: "r" });
  asrt(g.consecLosses === 1 && near(day, -0.02), "STUCK increases the streak and the day's loss");
}

// --- the bots' real recordResult functions, evaluated from source ------------------------------
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
function botRecordResult(rel) {
  const src = read(rel);
  const start = src.indexOf("function recordResult(");
  asrt(start > 0, `${rel}: recordResult found`);
  const end = src.indexOf("\n}", start) + 2;
  const fnSrc = src.slice(start, end);
  // The function closes over guard, requestStop and (graduation) dayNetSol: provide them.
  const make = new Function("guard", "requestStop", `let dayNetSol = 0;\n${fnSrc}\nreturn { recordResult, day: () => dayNetSol };`);
  const guard = newGuard();
  const stops = [];
  const bot = make(guard, (r) => stops.push(r));
  return { ...bot, guard, stops, fnSrc };
}

{
  const b = botRecordResult("bots/graduation-sniper/graduation.mjs");
  b.recordResult(small.acc.pnlSol, { guardPnlSol: small.guardPnlSol });
  asrt(b.guard.consecLosses === 0, "graduation: the +0.0002-before-fees sale does NOT increase consecLosses");
  asrt(near(b.day(), -0.000255), `graduation: dayNetSol moves by the NET pnl (-0.000255), got ${b.day()}`);
  b.recordResult(-0.01, { guardPnlSol: -0.005 });
  asrt(b.guard.consecLosses === 1 && near(b.day(), -0.010255), "graduation: a sale losing before fees counts, day sums net pnl");
  b.recordResult(-0.02); // STUCK / dry: no option
  asrt(b.guard.consecLosses === 2 && near(b.day(), -0.030255), "graduation: STUCK (no option) is a loss for both");
  b.recordResult(-0.01);
  asrt(b.guard.halted && b.stops.length === 1, "graduation: the halt still requests the stop");
}
for (const rel of ["bots/sniper/sniper.mjs", "bots/copy-trader/watcher.mjs"]) {
  const b = botRecordResult(rel);
  b.recordResult(small.acc.pnlSol, { guardPnlSol: small.guardPnlSol });
  asrt(b.guard.consecLosses === 0, `${rel}: the +0.0002-before-fees sale does NOT increase consecLosses`);
  b.recordResult(-0.01, { guardPnlSol: -0.005 });
  b.recordResult(-0.02);
  asrt(b.guard.consecLosses === 2, `${rel}: real losses and STUCK still count`);
}

// --- wiring: every LIVE sale passes guardPnlSol; dry / STUCK calls stay as they were -----------
for (const [rel, n] of [["bots/sniper/sniper.mjs", 2], ["bots/graduation-sniper/graduation.mjs", 2], ["bots/copy-trader/watcher.mjs", 2]]) {
  const src = read(rel);
  const live = (src.match(/recordResult\(\w+, \{ guardPnlSol: sale\.guardPnlSol \}\)/g) || []).length;
  asrt(live === n, `${rel}: ${n} live sale paths pass guardPnlSol (found ${live})`);
  asrt((src.match(/applyLiveSell\(pos, /g) || []).length === n, `${rel}: …one per applyLiveSell`);
}
// The daily-loss counter in graduation is still fed the net pnl (never the guard's figure).
asrt(/dayNetSol = Math\.round\(\(dayNetSol \+ \(Number\(pnlSol\) \|\| 0\)\) \* 1e9\) \/ 1e9;/.test(read("bots/graduation-sniper/graduation.mjs")), "graduation: dayNetSol += pnlSol (net)");
// Journal: the day seeded after a restart sums pnlSol (net), not guardPnlSol.
{
  const ts = new Date().toISOString();
  const row = { type: "trade", ts, pnlSol: small.acc.pnlSol, ...small.fields };
  asrt(near(netSolForDay([row], mskDateKey()), -0.000255), "journal: netSolForDay uses pnlSol (net), not guardPnlSol");
}

console.log(JSON.stringify({ guardPnlSol: small.guardPnlSol, pnlSol: small.acc.pnlSol, counted: false }));
console.log("PASS: MAX_CONSEC_LOSSES classifies a live sale by PnL before network fees; day and journal keep the net figure");
