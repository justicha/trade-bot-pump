// Shutdown test (step 2): the stop path must close ALL open positions as normal "manual stop"
// trades, print the SESSION SUMMARY BEFORE any tick drain, and write type:"session_summary" to the
// journal + a summary-<sessionId>.txt file — exactly once.
//
// Windows note: child.kill("SIGINT") force-terminates a child without running its handler, so the
// signal delivery itself cannot be tested here. SNIPER_MAX_SEC triggers the SAME finish() function
// that the SIGINT/SIGTERM handlers call, so this exercises the real shutdown code path.
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-journal-"));
const env = {
  ...process.env,
  RPC_URL: "http://127.0.0.1:1",
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "ws-mock.mjs"),
  JOURNAL_DIR: dir,
  SNIPER_MAX_SEC: "5", // deterministic stop -> finish() (same path as SIGINT/SIGTERM)
  SNIPER_DRAIN_MAX_SEC: "1", // a short drain so the summary-vs-drain ordering is exercised
  TICKS: "1",
  SNIPER_COOLDOWN_SEC: "0",
  SNIPER_MAX_POSITIONS: "3",
  SNIPER_BUY_SOL: "0.02",
  // Pin every sniper filter: the developer's .env must not change test outcomes.
  SNIPER_MIN_HOLDERS: "4",
  SNIPER_HOLDER_WAIT_SEC: "45",
  SNIPER_MIN_DEV_BUY: "0",
  SNIPER_MIN_SLOTS: "1",
  SNIPER_MIN_DELAY_MS: "0",
  SNIPER_POST_EXIT_SEC: "0",
  SNIPER_TIMEOUT_SEC: "300", // no timeout: positions stay open until the stop
  SNIPER_TAKE_PROFIT: "1000", // no TP
  SNIPER_STOP_LOSS: "0", // no SL
  MAX_TRADE_SOL: "0.02",
  MAX_SESSION_SOL: "0.2",
};

const child = spawn(process.execPath, [path.join(root, "bots", "sniper", "sniper.mjs"), "--dry-run"], { cwd: root, env });
let out = "";
child.stdout.on("data", (b) => (out += String(b)));
child.stderr.on("data", () => {});

const t0 = Date.now();
const code = await new Promise((resolve) => {
  const killer = setTimeout(() => {
    child.kill();
    resolve("timeout");
  }, 12000);
  child.on("exit", (c) => {
    clearTimeout(killer);
    resolve(c);
  });
});
const elapsed = Date.now() - t0;

asrt(code === 0, `clean exit 0 (got ${code}), elapsed ${elapsed}ms`);
asrt(elapsed <= 12000, `finished within 12s (got ${elapsed}ms)`);
asrt(/SESSION SUMMARY/.test(out), "SESSION SUMMARY printed");
asrt((out.match(/SESSION SUMMARY/g) || []).length === 1, "summary printed exactly once (idempotent)");

const sumIdx = out.indexOf("SESSION SUMMARY");
const drainIdx = out.indexOf("[ticks]");
asrt(sumIdx >= 0 && (drainIdx < 0 || sumIdx < drainIdx), "summary printed before any tick drain");

const records = readJournal(dir);
const trades = records.filter((r) => r.type === "trade");
const manual = trades.filter((t) => String(t.exitReason).startsWith("manual stop"));
asrt(manual.length >= 2, `>= 2 open positions closed at stop (got ${manual.length} manual-stop trades)`);
asrt(manual.every((t) => Number.isFinite(Number(t.pnlSol)) && Number.isFinite(Number(t.ratio))), "manual-stop closes are normal journaled trades");

const ss = records.filter((r) => r.type === "session_summary");
asrt(ss.length === 1, `one session_summary record (got ${ss.length})`);
asrt(ss[0].manualStopCloses === manual.length, "session_summary records the manual-stop close count");

const sumFiles = fs.readdirSync(dir).filter((f) => f.startsWith("summary-") && f.endsWith(".txt"));
asrt(sumFiles.length === 1, `summary file written (got ${sumFiles.length})`);
const sumTxt = fs.readFileSync(path.join(dir, sumFiles[0]), "utf8");
asrt(/spentSol/.test(sumTxt) && /closedAtStop/.test(sumTxt), "summary file has spent + closedAtStop");
asrt(/openPositions: 0/.test(sumTxt), "no open positions left at stop");

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ code, elapsedMs: elapsed, manualCloses: manual.length }));
console.log("PASS: stop closes open positions, prints summary before drain, writes session_summary (idempotent)");
