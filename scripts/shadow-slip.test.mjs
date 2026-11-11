// S3: the buy-slippage must be charged ONCE.
//
// v2-era shadow lines moved the entry price up by slipBps (54 bps for a 0.02 SOL order) AND let
// roundTripCosts subtract buySlip again, so a position that exited exactly at its entry price was
// booked at ratio 1/1.0054 = 0.994629 instead of 1. The synthetic scenario "flat" holds the price
// constant after the entry, which makes the double charge visible as an exact number:
//
//   buySol 0.02, slipBps 54, pump 100+100 bps, tx 455000 lamports x2
//   single charge (v3): netPnl = -0.0004 - 0.000216 - 0.00091        -> -7.63%
//   double charge (v2): the same plus 0.54% of the position         -> -8.16%, ratio 0.994629
import { cleanEnv } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal } from "../lib/journal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const dir = tmp("shadow-slip-journal-");
const env = cleanEnv({
  ROOT: tmp("shadow-slip-root-"), // a fresh ROOT: the developer's .env must not leak in
  RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
  JOURNAL_DIR: dir,
  WS_MOCK_SCENARIO: "flat", // the price never moves after the entry -> gross ratio must be 1
  MIN_FILL: "92",
  SHADOW_BUY_SOL: "0.02",
  SHADOW_SL: "0",
  SHADOW_HOLD_SEC: "3600",
  SHADOW_MAX_SEC: "4",
  // every cost input pinned, so netPct is an exact expectation and not "whatever the .env says"
  CU_PRICE: "1500000",
  CU_LIMIT: "300000",
  SLIPPAGE_ASSUMED_BPS: "50",
});

const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "shadow.mjs")], { cwd: root, env });
let out = "";
let err = "";
child.stdout.on("data", (b) => (out += String(b)));
child.stderr.on("data", (b) => (err += String(b)));
const code = await new Promise((resolve) => {
  const killer = setTimeout(() => child.kill(), 40_000);
  child.on("exit", (c) => {
    clearTimeout(killer);
    resolve(c);
  });
});
asrt(code === 0, `the shadow lab exited 0 (got ${code}); stderr: ${err.split(/\r?\n/)[0] || ""}`);

const trades = readJournal(dir).filter((x) => x.type === "gshadow_trade");
asrt(trades.length === 8, `8 stop trades (got ${trades.length})`);
const t = trades[0];
console.log(JSON.stringify({ ratio: t.ratio, entryPrice: t.entryPrice, exitPrice: t.exitPrice, netPct: t.netPct, slipBps: t.slipBps, costsScheme: t.costsScheme }));

asrt(t.exitPrice === t.entryPrice, `the exit price equals the entry price (${t.exitPrice} vs ${t.entryPrice})`);
asrt(t.ratio === 1, `a flat round trip has ratio 1, not 1/(1+slip) — got ${t.ratio}`);
asrt(t.netPct === -7.63, `flat round trip nets -7.63% (fees+one slip+tx), got ${t.netPct}`);
asrt(
  typeof t.costsScheme === "string" && t.costsScheme.startsWith("v3-single-slip"),
  `the line carries the new accounting scheme, got ${t.costsScheme}`,
);
asrt(t.slipBps === 54, `the reported slippage is 50 assumed + 4 size = 54 bps, got ${t.slipBps}`);

fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS: buy slippage is charged once (ratio 1 on a flat round trip, netPct -7.63%)");
