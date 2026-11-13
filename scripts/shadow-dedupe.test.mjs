// S2: a mint must never be opened twice in one session.
//
// mintState is bounded, so a mint that is closed and evicted can reappear in the stream. The per-mint
// `entered` set dies with the state, so without a session-wide (variant, mint) record the lab opened
// the same pair again and the report counted the trade twice (one mint was opened 5 times in a 3h
// run, and 4E481… reached 11 trades instead of 8).
//
// Scenario "reappear": the mint crosses MIN_FILL, filler mints push mintState past a tiny cap, the
// spent mint is pruned, then the same mint trades again — with the fix it stays closed.
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

const dir = tmp("shadow-dedupe-journal-");
const env = cleanEnv({
  ROOT: tmp("shadow-dedupe-root-"), // a fresh ROOT: the developer's .env must not leak in
  RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
  JOURNAL_DIR: dir,
  WS_MOCK_SCENARIO: "reappear",
  SHADOW_VARIANTS: "ABCDEFGHIJ", // the set these assertions were written for; K–N: scripts/gshadow-rev5.test.mjs
  MIN_FILL: "92",
  SHADOW_BUY_SOL: "0.02",
  SHADOW_MAX_MINTS: "2", // the cap is hit on purpose: 1 traded mint + 3 filler mints
  SHADOW_SL: "0", // no stop-loss: the exit is a plain timeout
  SHADOW_HOLD_SEC: "1", // close fast: a live position is (correctly) never evictable
  GRAD_TIMEOUT_SEC: "1", // the same for variant J, which holds for the LIVE timeout (300s by default)
  SHADOW_MAX_SEC: "10",
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
const fatal = /TypeError|ReferenceError|Cannot access .* before initialization|UnhandledPromiseRejection/;
asrt(!fatal.test(err + out), "no exception in the run, got: " + (err.split(/\r?\n/)[0] || ""));

const records = readJournal(dir);
const opens = records.filter((x) => x.type === "gshadow_open");
const trades = records.filter((x) => x.type === "gshadow_trade");

// The cap was reached and a spent mint was pruned — otherwise the "no second open" result below
// would be trivial (the state was simply never evicted).
asrt(/mintState cap 2: pruned [1-9]/.test(out), `the cap pruned a spent mint: "${(out.match(/mintState cap.*/) || [""])[0]}"`);

// 9 since task 5: A–H plus J ("live config").
asrt(opens.length === 9, `one open per variant, no duplicates after the mint reappeared (got ${opens.length})`);
const openKeys = opens.map((o) => `${o.variant}:${o.mint}`);
asrt(new Set(openKeys).size === openKeys.length, "no duplicated (variant,mint) gshadow_open");
asrt(new Set(opens.map((o) => o.variant)).size === 9, "all nine variants opened once");
asrt(trades.length === 9, `each of those positions is closed once (got ${trades.length})`);
asrt(
  trades.every((t) => t.reason === "timeout"),
  `the positions closed by timeout before the cap ran, got ${JSON.stringify([...new Set(trades.map((t) => t.reason))])}`,
);

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ exit: code, opens: opens.length, trades: trades.length, capLine: (out.match(/mintState cap.*/) || [null])[0] }));
console.log("PASS: an evicted mint cannot be opened a second time (session-wide variant+mint dedupe)");
