// Test (tasks 6 and 7): what the bot does at Ctrl+C.
//
// Windows note (same as scripts/shutdown.test.mjs): child.kill("SIGINT") force-terminates a child
// without running its handler, so the signal itself cannot be delivered in a test. GRAD_MAX_SEC
// stops the bot through the very same requestStop() -> finish() path the SIGINT handler calls.
//
// Covered: the exit decision table, "only the session's own positions are ever sold", and two real
// dry runs with an open position that must not send anything.
import { makeTempKeys } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exitDecision, positionsToSell } from "../lib/exit-plan.mjs";
import { readJournal } from "../lib/journal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const MINT_A = "FMosXPu8L1cm9kgaYJs5y2MWTtqqWTs7AyVtBaFvpump";
const MINT_B = "HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump";

// --- who may be sold: only this session's own buys ---
{
  const positions = new Map([
    [MINT_A, { tokens: 1n }],
    [MINT_B, { tokens: 2n }], // in the wallet, bought by hand: NOT in boughtMints
  ]);
  const mine = positionsToSell({ positions, boughtMints: new Set([MINT_A]) });
  asrt(mine.length === 1 && mine[0].mint === MINT_A, "a token the bot did not buy is never in the exit list");
  asrt(positionsToSell({ positions, boughtMints: new Set() }).length === 0, "no buys -> nothing to sell");
  asrt(positionsToSell({ positions: new Map(), boughtMints: new Set([MINT_A]) }).length === 0, "no positions -> nothing to sell");
}

// --- the exit decision table (SIGINT behaviour on a live run) ---
{
  asrt(exitDecision({ live: false, sellOnExit: false, venue: "curve" }).mode === "simulate", "dry run: simulate, never send");
  asrt(exitDecision({ live: true, sellOnExit: false, venue: "curve" }).sell === false, "LIVE without SELL_ON_EXIT: do not sell");
  asrt(
    exitDecision({ live: true, sellOnExit: false, venue: "curve" }).reason === "SELL_ON_EXIT not set",
    "the reason is journaled for the operator",
  );
  asrt(exitDecision({ live: true, sellOnExit: true, venue: "curve", confirmAmm: undefined }).mode === "send", "curve exit sells with SELL_ON_EXIT");
  const poolNoAmm = exitDecision({ live: true, sellOnExit: true, venue: "pumpswap", confirmAmm: undefined });
  asrt(poolNoAmm.sell === false && poolNoAmm.reason === "PumpSwap sell unverified", "a PumpSwap exit without LIVE_CONFIRM_AMM is skipped");
  asrt(exitDecision({ live: true, sellOnExit: true, venue: "pumpswap", confirmAmm: "yes" }).sell === true, "with the AMM gate it sells");
}

// --- two dry runs with an open position: the stop path sends nothing ---
function runBot(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grad-exit-journal-"));
  const env = {
    ...process.env,
    RPC_URL: "http://127.0.0.1:1",
    RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
    WS_MOCK: path.join(here, "mocks", "grad-ws-mock.mjs"),
    KEYS_DIR: makeTempKeys(),
    JOURNAL_DIR: dir,
    GRAD_BUY_SOL: "0.02",
    GRAD_MIN_FILL_PCT: "92",
    GRAD_MAX_FILL_PCT: "97",
    MIN_HOLDERS: "0",
    GRAD_MAX_POSITIONS: "3",
    GRAD_COOLDOWN_SEC: "0",
    // No TP/SL/timeout: the position must still be OPEN when the stop arrives.
    GRAD_TAKE_PROFIT: "1000",
    GRAD_STOP_LOSS: "0.000001",
    GRAD_TIMEOUT_SEC: "300",
    GRAD_MAX_SEC: "6", // stop through the same path as SIGINT
    LIVE_CONFIRM: "",
    LIVE_CONFIRM_AMM: "",
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "graduation.mjs")], { cwd: root, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 30000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err, dir });
    });
  });
}

const assertCleanStop = ({ c, out, err, dir }, label) => {
  asrt(c === 0, `${label}: clean exit 0 (got ${c})`);
  asrt(/did not settle|position tracked/.test(out), `${label}: the bot opened a position before the stop`);
  asrt(/open position\(s\) from this session/.test(out), `${label}: the stop reported the session's own positions`);
  asrt(!/sendRawTransaction must not be called/.test(out + err), `${label}: sendTransaction was NOT called`);
  asrt(!/tx sent|tx confirmed/.test(out), `${label}: no transaction was broadcast`);
  const trades = readJournal(dir).filter((r) => r.type === "trade" && r.sig);
  asrt(trades.length === 0, `${label}: no journaled trade carries a signature (got ${trades.length})`);
  fs.rmSync(dir, { recursive: true, force: true });
};

{
  const r = await runBot({ DRY_SELL: "yes" });
  assertCleanStop(r, "DRY_SELL=yes + stop");
}

{
  // SELL_ON_EXIT=yes but no --live: the config gate keeps the bot in DRY RUN, so nothing is sent.
  const r = await runBot({ SELL_ON_EXIT: "yes" });
  assertCleanStop(r, "SELL_ON_EXIT without LIVE_CONFIRM");
}

console.log(JSON.stringify({ exitTable: true, sessionOnly: true, dryStopsClean: 2 }));
console.log("PASS: Ctrl+C exit — buys stop at once, only the session's positions are handled, nothing is sent");
