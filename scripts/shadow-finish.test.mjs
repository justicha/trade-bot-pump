// S1: a stop must journal what it closes.
//
// The handler used to call process.exit(0) with positions still in `open`, so every trade that was
// live at Ctrl+C silently vanished from the report (a real run ended with 8 opens and 0 closes for
// one mint). All three stop paths (SIGINT / SIGTERM / SHADOW_MAX_SEC) share finishShadow(), and
// Windows cannot deliver SIGINT to a child (kill() terminates it), so this test drives the SAME
// function through SHADOW_MAX_SEC against the real handler and a fixture socket.
import "./lib/test-env.mjs";
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

async function runShadow(overrides = {}) {
  const dir = tmp("shadow-finish-journal-");
  const env = {
    ...process.env,
    ROOT: tmp("shadow-finish-root-"), // a fresh ROOT: the developer's .env must not leak in
    RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
    RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
    WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
    JOURNAL_DIR: dir,
    WS_MOCK_SCENARIO: "single",
    MIN_FILL: "92",
    SHADOW_BUY_SOL: "0.02",
    SHADOW_SL: "0", // no stop-loss: every position must survive until the stop
    SHADOW_HOLD_SEC: "3600", // no timeout exit either
    SHADOW_MAX_SEC: "4", // deterministic stop -> finishShadow()
    CU_PRICE: "1500000",
    CU_LIMIT: "300000",
    SLIPPAGE_ASSUMED_BPS: "50",
    ...overrides,
  };
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
  return { dir, code, out, err, records: readJournal(dir) };
}

const r = await runShadow();
asrt(r.code === 0, `the shadow lab exited 0 (got ${r.code}); stderr: ${r.err.split(/\r?\n/)[0] || ""}`);
const fatal = /TypeError|ReferenceError|Cannot access .* before initialization|UnhandledPromiseRejection/;
asrt(!fatal.test(r.err + r.out), "no exception in the run, got: " + (r.err.split(/\r?\n/)[0] || ""));
asrt((r.out.match(/SHADOW STOP/g) || []).length === 1, `the stop summary is printed exactly once (got ${(r.out.match(/SHADOW STOP/g) || []).length})`);

const opens = r.records.filter((x) => x.type === "gshadow_open");
const trades = r.records.filter((x) => x.type === "gshadow_trade");
asrt(opens.length === 8, `8 variants opened a position (got ${opens.length})`);
asrt(trades.length === 8, `every open position is journaled as a trade at the stop (got ${trades.length})`);
asrt(
  trades.every((t) => t.reason === "manual stop"),
  `stop trades use reason "manual stop", got ${JSON.stringify([...new Set(trades.map((t) => t.reason))])}`,
);
asrt(new Set(trades.map((t) => t.variant)).size === 8, "all eight variants are represented among the stop trades");
asrt(
  trades.every((t) => opens.some((o) => o.variant === t.variant && o.mint === t.mint)),
  "each stop trade matches a position that was open",
);
const keys = trades.map((t) => `${t.variant}:${t.mint}`);
asrt(new Set(keys).size === keys.length, "no duplicated (variant,mint) trade: a stop must close a position once");
asrt(
  trades.every((t) => Number.isFinite(Number(t.netPct)) && Number(t.ratio) > 0 && Number(t.holdSec) >= 0),
  "stop trades carry a numeric netPct, a positive ratio and a hold time",
);
asrt(trades.every((t) => t.unconfirmed === undefined), "a position with a known price is not marked unconfirmed");
asrt(/Listening for candidates/.test(r.out), "the lab subscribed to the stream");

fs.rmSync(r.dir, { recursive: true, force: true });
console.log(JSON.stringify({ exit: r.code, opens: opens.length, trades: trades.length, reasons: [...new Set(trades.map((t) => t.reason))] }));
console.log("PASS: the shadow stop journals every open position exactly once (no trade lost at Ctrl+C)");
