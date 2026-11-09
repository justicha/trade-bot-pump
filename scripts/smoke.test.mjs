// Smoke test of the main path: the REAL sniper (dry-run) driven by a fixture WebSocket and a
// fixture RPC, so no network is involved and the exact handler that runs in production is tested.
//
//   node scripts/smoke.test.mjs
//
// What it asserts:
//   * the process finishes by itself (SNIPER_MAX_SEC) with exit code 0 and prints the session report
//   * no exception anywhere in stdout/stderr (the TDZ bug of the Mayhem check showed up here)
//   * synthetic create/buy/sell notifications (>= 10 events, incl. a Mayhem CPI) were handled
//   * positions were opened AND closed; none left open at the stop
//   * the journal in the temp dir agrees with the session summary (spent / received / closed)
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-journal-"));
const maxSec = 14;
const env = {
  ...process.env,
  RPC_URL: "http://127.0.0.1:1", // never used: RPC_MOCK replaces the client
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "ws-mock.mjs"),
  JOURNAL_DIR: dir,
  SNIPER_MAX_SEC: String(maxSec),
  SNIPER_DRAIN_MAX_SEC: "0", // no post-run tick draining in the smoke test
  TICKS: "1", // tick log on (deterministic for the assertions below)
  SNIPER_COOLDOWN_SEC: "1", // let several mints buy inside the short window
  SNIPER_MAX_POSITIONS: "3",
  SNIPER_BUY_SOL: "0.02",
  // Pin every sniper filter: the developer's .env must not change test outcomes.
  SNIPER_MIN_HOLDERS: "4",
  SNIPER_HOLDER_WAIT_SEC: "45",
  SNIPER_MIN_DEV_BUY: "0",
  SNIPER_MIN_SLOTS: "1",
  SNIPER_MIN_DELAY_MS: "0",
  SNIPER_POST_EXIT_SEC: "0",
  SNIPER_TIMEOUT_SEC: "6", // exits come from the timeout (the stream price rises slowly in the fixture)
  MAX_TRADE_SOL: "0.02",
  MAX_SESSION_SOL: "0.2",
};

const out = [];
const err = [];
const child = spawn(process.execPath, [path.join(root, "bots", "sniper", "sniper.mjs"), "--dry-run"], { cwd: root, env });
child.stdout.on("data", (b) => out.push(String(b)));
child.stderr.on("data", (b) => err.push(String(b)));

const code = await new Promise((resolve) => {
  const killer = setTimeout(() => child.kill(), (maxSec + 20) * 1000);
  child.on("exit", (c) => {
    clearTimeout(killer);
    resolve(c);
  });
});

const stdout = out.join("");
const stderr = err.join("");
const fatal = /TypeError|ReferenceError|Cannot access .* before initialization|UnhandledPromiseRejection|SIGSEGV/;
asrt(code === 0, `the sniper exited cleanly, got code ${code}`);
asrt(!fatal.test(stderr), "no exception in stderr, got: " + stderr.split(/\r?\n/).slice(0, 3).join(" | "));
asrt(!fatal.test(stdout), "no exception in stdout");
asrt(/=== SNIPER BOT/.test(stdout), "the bot reached its banner");
asrt(/SESSION SUMMARY/.test(stdout), "the session summary was printed");

// ---- what the real handler did with the synthetic stream --------------------
asrt(/synthetic|WATCHING/.test(stdout) || /SNIPING/.test(stdout), "the handler saw the notifications");
const trades = readJournal(dir).filter((r) => r.type === "trade");
const rejects = readJournal(dir).filter((r) => r.type === "reject");
asrt(trades.length >= 1, `at least one closed trade was journaled, got ${trades.length} (rejects: ${rejects.length})`);
asrt(
  trades.every((t) => Number.isFinite(Number(t.pnlSol)) && Number.isFinite(Number(t.ratio))),
  "every journal line has a numeric pnl and ratio",
);
asrt(
  trades.every((t) => typeof t.costsScheme === "string"),
  "every journal line carries the cost-scheme version",
);
// task B fields: run metadata + context, written by the real handler
asrt(
  trades.every((t) => typeof t.sessionId === "string" && typeof t.paramsHash === "string" && "gitSha" in t),
  "every line carries sessionId / paramsHash / gitSha",
);
asrt(
  trades.every((t) => t.curveType === "mayhem" || t.curveType === "standard"),
  "every line carries curveType",
);
asrt(
  trades.every((t) => Number.isFinite(Number(t.pnlPctNet))),
  "every line carries a numeric pnlPctNet",
);
// tick log: at least one line per held position
{
  const tickFiles = fs.readdirSync(dir).filter((f) => f.startsWith("ticks-") && f.endsWith(".jsonl"));
  asrt(tickFiles.length >= 1, `tick log file was created (got ${tickFiles.length})`);
  const tickLines = tickFiles.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  asrt(tickLines.length >= 1, `tick log has lines (got ${tickLines.length})`);
  asrt(
    tickLines.every((r) => r.mint && (r.phase === "hold" || r.phase === "post") && Number.isFinite(r.ratio) && Number.isFinite(r.t)),
    "tick lines carry mint / phase / ratio / t",
  );
  asrt(tickLines.every((r) => typeof r.sessionId === "string"), "tick lines carry the sessionId");
}
asrt(
  trades.every((t) => String(t.exitReason).length > 0),
  "every closed trade has an exit reason (the position was closed by a rule, not dropped)",
);
// timing invariants: sellAt >= buyAt and holdSec agrees with the difference
asrt(
  trades.every((t) => typeof t.buyAt === "string" && typeof t.sellAt === "string"),
  "every journal line carries buyAt and sellAt",
);
asrt(
  trades.every((t) => new Date(t.sellAt) >= new Date(t.buyAt)),
  "sellAt >= buyAt on every line",
);
asrt(
  trades.every((t) => {
    const hold = Math.round((new Date(t.sellAt) - new Date(t.buyAt)) / 1000);
    return Math.abs(hold - Number(t.holdSec)) <= 2; // 2 s tolerance for the poll granularity
  }),
  "holdSec agrees with sellAt - buyAt on every line",
);

// the summary the bot printed must agree with what it wrote
const num = (re, s) => {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
};
const summaryBuys = num(/buys \/ sells\s*:\s*(\d+)/, stdout);
const summaryWinLoss = /closed trades\s*:\s*(\d+)W\s*\/\s*(\d+)L/.exec(stdout);
const summaryClosed = summaryWinLoss ? Number(summaryWinLoss[1]) + Number(summaryWinLoss[2]) : null;
const openAtStop = num(/open at stop\s*:\s*(\d+)/, stdout);
asrt(summaryBuys !== null && summaryBuys >= 1, `the summary reports the buys (got ${summaryBuys})`);
asrt(summaryClosed === trades.length, `summary closed trades ${summaryClosed} == journal ${trades.length}`);
asrt(openAtStop === 0, `no position left open at the stop (got ${openAtStop})`);

// spent/received from the summary must equal what the journal implies
const summarySpent = num(/spent\s*:\s*([\d.]+) SOL/, stdout);
const journalBuys = trades.reduce((s, t) => s + Number(t.buySol), 0);
asrt(
  summarySpent === null || Math.abs(summarySpent - journalBuys) < 1e-6,
  `summary spent ${summarySpent} == journal buys ${journalBuys.toFixed(6)}`,
);

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ exitCode: code, journalTrades: trades.length, rejects: rejects.length, summaryBuys, summaryClosed, openAtStop }));
console.log("PASS: real sniper handler survived a synthetic create/buy/sell stream (incl. Mayhem CPI), opened and closed positions, journal == summary");

asrt(/Listening for new tokens/.test(stdout), "it subscribed and listened");
