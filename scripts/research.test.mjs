// Tests for the research building blocks: holder-gate bugfix, curve anomaly guard, cost model.
// No network, no wallet.
process.env.RPC_URL = process.env.RPC_URL || "https://example.invalid/?api-key=test";
process.env.SLIPPAGE_ASSUMED_BPS = "0";

const { HolderTracker } = await import("../lib/holders.mjs");
const { checkCurve } = await import("../lib/curve.mjs");
const { roundTripCosts, txCostSol } = await import("../lib/fees.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---------------------------------------------------------------- holder gate
// Regression: a ready mint that could not be entered used to be logged as "6 holders < 4".
{
  const h = new HolderTracker({ minHolders: 4, waitMs: 45_000, minSlots: 2, minDelayMs: 2500 });
  h.track("M", { at: 0, slot: 100, creator: "dev" });
  let snap = null;
  for (const [i, user] of ["a", "b", "c", "d", "e", "f"].entries()) {
    snap = h.apply("M", user, 1000, { ts: 3000 + i * 10, slot: 101 + i });
  }
  asrt(snap.holders === 6, "6 holders counted, got " + snap.holders);
  asrt(snap.holdersAtReady === 4, "holdersAtReady pinned at the threshold, got " + snap.holdersAtReady);
  h.markBlocked("M", "no free position slot");
  const [dropped] = h.prune(1_000_000);
  asrt(dropped.ready === true, "drop must report ready=true, not 'holders < 4'");
  asrt(dropped.holdersAtReady === 4 && dropped.holders === 6, "drop snapshot must carry both counts");
  asrt(dropped.blocked === "no free position slot", "drop must carry the blocking reason");
}

// organic(): a single-slot instant bundle is not a crowd
{
  const h = new HolderTracker({ minHolders: 4, minSlots: 2, minDelayMs: 2500, waitMs: 60_000 });
  h.track("B", { at: 0, slot: 7 });
  let snap = null;
  for (const u of ["w1", "w2", "w3", "w4"]) snap = h.apply("B", u, 500, { ts: 500, slot: 7 });
  asrt(snap.holders === 4, "4 distinct holders");
  asrt(h.organic(snap) === false, "one slot + 500ms must NOT count as organic");

  const h2 = new HolderTracker({ minHolders: 4, minSlots: 2, minDelayMs: 2500, waitMs: 60_000 });
  h2.track("C", { at: 0, slot: 7 });
  let s2 = h2.apply("C", "w1", 500, { ts: 3000, slot: 8 });
  s2 = h2.apply("C", "w2", 500, { ts: 3200, slot: 9 });
  s2 = h2.apply("C", "w3", 500, { ts: 3400, slot: 9 });
  s2 = h2.apply("C", "w4", 500, { ts: 3600, slot: 10 });
  asrt(h2.organic(s2) === true, "4 buyers over 3 slots after 3s must be organic");

  s2 = h2.apply("C", "w4", -500, { ts: 4000, slot: 10 });
  asrt(s2.holders === 3, "a seller drops out of the holder count, got " + s2.holders);
}

// ------------------------------------------------------------------- curve math
{
  const normal = { virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, complete: false };
  const ok = checkCurve(normal, { buySol: 0.02 });
  asrt(ok.ok === true, "normal curve must pass: " + ok.reason);
  const whole = ok.tokensForBuy / 1e6;
  asrt(whole > 600_000 && whole < 800_000, "0.02 SOL buys ~700k whole tokens, got " + Math.round(whole));

  // the anomaly from the dry-run log: ~0.085 SOL of virtual reserves -> 400M+ tokens for 0.02 SOL
  const bad = { virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 85_000_000n, complete: false };
  const rejected = checkCurve(bad, { buySol: 0.02 });
  asrt(rejected.ok === false, "0.085 SOL virtual reserves must be rejected");
  asrt(/below the .* floor/.test(rejected.reason), "reason must mention the floor, got: " + rejected.reason);

  asrt(checkCurve({ virtualTokenReserves: 5n, virtualSolReserves: 5n, complete: false }).ok === false, "tiny reserves rejected");
  asrt(
    checkCurve({ virtualTokenReserves: normal.virtualTokenReserves, virtualSolReserves: normal.virtualSolReserves, complete: true }).ok === false,
    "completed curve rejected",
  );
  asrt(checkCurve(null).ok === false, "missing state rejected");
}

// ------------------------------------------------------------------ cost model
{
  // 1 SOL in, exit at 2x, no slippage, no tx fee: 1% in + 1% out = 0.03 SOL lost
  const c = roundTripCosts({ buySol: 1, ratio: 2, slippageBps: 0, txSol: 0 });
  asrt(Math.abs(c.grossPnl - 1) < 1e-9, "gross +1 SOL, got " + c.grossPnl);
  asrt(Math.abs(c.feeSol - 0.03) < 1e-9, "fees 0.03 SOL, got " + c.feeSol);
  asrt(Math.abs(c.netPnl - 0.97) < 1e-9, "net +0.97 SOL, got " + c.netPnl);
  asrt(Math.abs(c.netRatio - 1.97) < 1e-9, "net ratio 1.97, got " + c.netRatio);

  const flat = roundTripCosts({ buySol: 1, ratio: 1.0, slippageBps: 50, txSol: txCostSol() });
  asrt(flat.netPnl < 0, "a flat price must be a net loss");
  asrt(flat.costSol > flat.feeSol, "costs must include slippage + tx fees");
}

// REGRESSION (29 minutes, 0 buys): organic() counts DISTINCT BUY SLOTS, so a caller that does
// not pass slot info into apply() can never satisfy even minSlots=1 — the gate silently blocks
// every entry. This test pins both halves of that behaviour.
{
  const h = new HolderTracker({ minHolders: 4, minSlots: 1, minDelayMs: 0, waitMs: 60_000 });
  h.track("NOSLOT", { at: 0 });
  let snap = null;
  for (const u of ["a", "b", "c", "d"]) snap = h.apply("NOSLOT", u, 100); // no { ts, slot }
  asrt(snap.holders === 4, "4 holders counted without slot info");
  asrt(snap.slots === 0, "slots stay 0 when the caller omits them, got " + snap.slots);
  asrt(h.organic(snap) === false, "without slot info organic() must be false — callers MUST pass the slot");

  const h2 = new HolderTracker({ minHolders: 4, minSlots: 1, minDelayMs: 0, waitMs: 60_000 });
  h2.track("WITHSLOT", { at: 0, slot: 100 });
  let ok = null;
  for (const [i, u] of ["a", "b", "c", "d"].entries()) ok = h2.apply("WITHSLOT", u, 100, { ts: 1000 + i, slot: 100 });
  asrt(h2.organic(ok) === true, "the same crowd IS organic once the slot is passed");
}

// ---- status line units (synthetic: 12 trades in 10 minutes, target 1000) -----------
{
  const { statusOf, formatStatus } = await import("../lib/status.mjs");
  const closed = new Map([["A", 12]]);
  const startedAt = 0;
  const now = 10 * 60 * 1000; // exactly 10 minutes

  const row = statusOf({ closed, startedAt, now, target: 1000 }).rows[0];
  asrt(Math.abs(row.perMin - 1.2) < 1e-9, "12 trades / 10 min = 1.2 per minute, got " + row.perMin);
  asrt(Math.abs(row.perHour - 72) < 1e-9, "1.2 per minute = 72 per hour, got " + row.perHour);
  asrt(Math.abs(row.etaHours - 988 / 72) < 1e-9, "ETA = 13.72h, got " + row.etaHours);

  const line = formatStatus({ closed, startedAt, now, target: 1000 });
  asrt(/1\.2\/min/.test(line), "per-minute unit in the line: " + line);
  asrt(/72\.0\/h/.test(line), "per-hour unit in the line: " + line);
  asrt(/eta 13\.7h/.test(line), "ETA in hours: " + line);
  asrt(/STATUS 10\.0min/.test(line), "elapsed in minutes: " + line);
}

console.log(JSON.stringify({ tokensForBuy: Math.round(checkCurve({ virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, complete: false }, { buySol: 0.02 }).tokensForBuy) }));
console.log("PASS: holder drop bug fixed (ready+blocked reported), bundles rejected, curve anomalies refused, costs applied");
