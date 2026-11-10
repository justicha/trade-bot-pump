// Unit test for the limit -> stop -> session-report flow:
//   - TradeGuard marks TERMINAL states (loss limit, session budget) so the bot must exit,
//     instead of staying alive and repeating "skip: trading halted" forever;
//   - an oversized single trade is only refused per-trade (bot keeps running);
//   - SessionLedger totals: spent / received / net, W/L, unresolved, one-shot report.
// lib/config.mjs aborts the process when RPC_URL is missing, so set the env before importing.
process.env.RPC_URL = process.env.RPC_URL || "https://example.invalid/?api-key=test";
process.env.MAX_TRADE_SOL = "0.05";
process.env.MAX_SESSION_SOL = "0.2";
process.env.MAX_CONSEC_LOSSES = "3";

const { TradeGuard } = await import("../lib/guards.mjs");
const { SessionLedger, roundSol } = await import("../lib/session.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---- loss limit must be terminal -------------------------------------------
let g = new TradeGuard();
g.reserve(0.02);
g.recordResult(-0.001);
asrt(g.checkOpen(0.02).ok, "still trading after 1 loss");
g.recordResult(-0.001);
asrt(g.checkOpen(0.02).ok, "still trading after 2 losses");
g.recordResult(-0.001);
asrt(g.halted, "halted after MAX_CONSEC_LOSSES=3");
const halted = g.checkOpen(0.02);
asrt(!halted.ok && halted.terminal === true && halted.code === "HALTED", "halted gate must be terminal: " + JSON.stringify(halted));

// a win resets the counter
g = new TradeGuard();
g.recordResult(-0.001);
g.recordResult(-0.001);
g.recordResult(0.002);
asrt(!g.halted && g.state.consecLosses === 0, "winning trade resets consecutive losses");

// ---- session budget must be terminal --------------------------------------
g = new TradeGuard();
for (let i = 0; i < 4; i++) {
  asrt(g.checkOpen(0.05).ok, "session: trade " + (i + 1) + " of 0.05 allowed");
  g.reserve(0.05);
}
const overCap = g.checkOpen(0.05); // 0.25 > MAX_SESSION_SOL 0.2
asrt(!overCap.ok && overCap.terminal === true && overCap.code === "SESSION_CAP", "session cap must be terminal: " + JSON.stringify(overCap));
asrt(g.halted, "session cap halts the session");

// ---- MAX_SESSION_SOL=0 means "no session cap" (long runs) ------------------
g = new TradeGuard({ maxSessionSol: 0 });
for (let i = 0; i < 50; i++) {
  asrt(g.checkOpen(0.05).ok, "no session cap: trade " + (i + 1) + " must be allowed");
  g.reserve(0.05);
}
asrt(!g.halted, "no session cap must never halt the session");

// ---- MAX_TRADE_SOL=0 is fail-safe (blocks everything) ---------------------
g = new TradeGuard({ maxTradeSol: 0, maxSessionSol: 0 });
const blocked = g.checkOpen(0.01);
asrt(!blocked.ok && blocked.code === "TRADE_CAP" && blocked.terminal === false, "MAX_TRADE_SOL=0 must block (fail-safe): " + JSON.stringify(blocked));

// ---- a single oversized trade is NOT terminal -----------------------------
g = new TradeGuard();
const big = g.checkOpen(1);
asrt(!big.ok && big.terminal === false && big.code === "TRADE_CAP", "oversized trade must stay non-terminal: " + JSON.stringify(big));
asrt(!g.halted, "oversized single trade must not halt the session");

// ---- ledger --------------------------------------------------------------
const s = new SessionLedger({ label: "TEST", mode: "LIVE", startSol: 1.0 });
s.buy(0.05);
s.buy(0.05);
s.sell(0.06, 0.01); // +0.01
s.sell(0.03, -0.02); // -0.02
asrt(s.spentSol === 0.1, "spent 0.1, got " + s.spentSol);
asrt(s.receivedSol === 0.09, "received 0.09, got " + s.receivedSol);
asrt(s.netSol === -0.01, "net -0.01, got " + s.netSol);
asrt(s.wins === 1 && s.losses === 1, "1W/1L, got " + s.wins + "W/" + s.losses + "L");
asrt(s.buys === 2 && s.sells === 2, "2 buys / 2 sells");
s.drop("mint: no tokens in wallet");

const summary = s.report({ reason: "MAX_CONSEC_LOSSES hit", openPositions: 1, endSol: 0.99 });
asrt(summary.netSol === -0.01, "summary carries net");
asrt(summary.reason === "MAX_CONSEC_LOSSES hit", "summary carries the stop reason");
asrt(summary.unresolved === 1, "unresolved count in summary, got " + summary.unresolved);
asrt(roundSol(summary.endSol - summary.startSol) === -0.01, "wallet delta in summary");

// the report is printed exactly once
asrt(s.report({ reason: "second call" }) === summary, "report must be one-shot");

// ---- open positions at stop are not booked as a loss ----------------------
const s2 = new SessionLedger({ label: "TEST2", mode: "DRY RUN" });
s2.buy(0.02);
s2.buy(0.02);
s2.sell(0.021, 0.001);
const sum2 = s2.report({ reason: "stopped", openPositions: 1, openSpentSol: 0.02 });
asrt(sum2.netSol === 0.001, "open position must be excluded from NET, got " + sum2.netSol);
asrt(sum2.openSpentSol === 0.02, "open spend must be reported, got " + sum2.openSpentSol);
asrt(sum2.worstCaseSol === -0.019, "worst case (open = 0) must be received - spent, got " + sum2.worstCaseSol);

// ---- costs must reach the ledger and the summary ---------------------------
{
  const sc = new SessionLedger({ label: "COSTS", mode: "LIVE", startSol: 1.0 });
  sc.buy(0.05);
  // full costs object as the bots pass it (has costSol), like roundTripCosts
  sc.sell(0.055, 0.005, { grossPnl: 0.005, feeSol: 0.001, slipSol: 0.0005, txSol: 0.0002, costSol: 0.0017, netPnl: 0.0033 });
  const sm = sc.report({ reason: "test", openPositions: 0, endSol: 1.0033 });
  asrt(sm.costsSol === 0.0017, `costs accumulate from costSol, got ${sm.costsSol}`);
  asrt(sm.netAfterCostsSol === roundSol(sm.netSol - 0.0017), `NET after costs = net - costs, got ${sm.netAfterCostsSol}`);
  asrt(sm.costsSol > 0 && sm.netAfterCostsSol < sm.netSol, "costs are non-zero and reduce NET after costs");

  // a partial costs object WITHOUT costSol (the old LIVE bug) must not silently zero the costs:
  const sc2 = new SessionLedger({ label: "PARTIAL", mode: "LIVE" });
  sc2.buy(0.05);
  sc2.sell(0.055, 0.005, { feeSol: 0, slipSol: 0.0005, txSol: 0.0002 }); // no costSol field
  asrt(sc2.costsSol === 0, "a costs object without costSol cannot be summed (regression guard)");
}

// ---- H9: partial-sell proceeds must not be mistaken for profit -----------------
{
  const sp = new SessionLedger({ label: "PARTIAL", mode: "LIVE" });
  sp.buy(0.1); // full entry
  sp.sell(0.05, 0.0); // a partial sell returns 0.05 of the 0.1 entry (closed share = 0.05)
  // openSpentSol must be the REMAINING entry (0.05), not the full 0.1.
  const sm = sp.report({ reason: "stopped", openPositions: 1, openSpentSol: 0.05 });
  asrt(sm.netSol === 0, `partial-sell proceeds are not profit: net must be 0, got ${sm.netSol}`);
  asrt(sm.openSpentSol === 0.05, `openSpentSol must be the remaining entry, got ${sm.openSpentSol}`);
}

// ---- hard safety gates must fail fast before any network -------------------
{
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mockPath = fileURLToPath(new URL("./mocks/rpc-mock.mjs", import.meta.url));
  // Set --live on process.argv BEFORE importing config/rpc: both compute their gate at import time.
  const code = `process.argv = ['node','bot','--live']; process.env.RPC_MOCK = ${JSON.stringify(mockPath)}; await import('./lib/rpc.mjs'); console.log('SHOULD NOT REACH');`;
  const run = (extraEnv) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env: { ...process.env, ...extraEnv } });

  // 1) --live alone is not enough: LIVE_CONFIRM=yes is required.
  const noConfirm = run({ LIVE_CONFIRM: "" });
  asrt(noConfirm.status !== 0, `--live without LIVE_CONFIRM must exit non-zero, got ${noConfirm.status}`);
  asrt(/LIVE_CONFIRM=yes/.test(String(noConfirm.stderr)), `must ask for LIVE_CONFIRM, got: ${noConfirm.stderr}`);
  asrt(!String(noConfirm.stdout).includes("SHOULD NOT REACH"), "the bot must not proceed past the live gate");

  // 2) With LIVE_CONFIRM=yes the mock-fixture guard must fire next.
  const withConfirm = run({ LIVE_CONFIRM: "yes" });
  asrt(withConfirm.status !== 0, `--live + RPC_MOCK must exit non-zero, got status ${withConfirm.status}`);
  asrt(/RPC_MOCK is a test fixture/.test(String(withConfirm.stderr)), `must print a clear error, got: ${withConfirm.stderr}`);
  asrt(!String(withConfirm.stdout).includes("SHOULD NOT REACH"), "the bot must not proceed past the guard");
}

console.log(JSON.stringify({ netSol: summary.netSol, spent: summary.spentSol, received: summary.receivedSol }));
console.log("PASS: limits are terminal (bot exits + prints totals); oversized trade is not; ledger net is exact");
