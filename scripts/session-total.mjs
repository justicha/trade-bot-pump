#!/usr/bin/env node
// Session totals (step 3): aggregate one session's closed trades from the journal.
//
//   node scripts/session-total.mjs                 # last session (by sellAt)
//   node scripts/session-total.mjs <sessionId>     # a specific session
//
// Computes n, W/L, spentSol, netSol (sum of pnlSol — already net of costs), netPct, best/worst,
// and the breakdown by exitReason and by gitSha. For sessions with no session_summary record the
// total is recovered from the trades themselves.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dedupeTrades } from "../lib/journal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.JOURNAL_DIR ? path.resolve(process.env.JOURNAL_DIR) : path.join(ROOT, "data", "journal");
const target = process.argv[2] || null;

const files = [];
try {
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.endsWith(".jsonl") && !f.startsWith("ticks-")) files.push(path.join(dir, f));
  }
} catch {
  console.error(`cannot read journal dir ${dir}`);
  process.exit(1);
}

const allTrades = [];
const sessions = new Map(); // sessionId -> { firstAt, lastAt }
const summaries = new Map(); // sessionId -> session_summary record

for (const f of files) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let j;
    try { j = JSON.parse(t); } catch { continue; }
    if (j.type === "session_summary" && j.sessionId) summaries.set(j.sessionId, j);
    if (j.type !== "trade") continue;
    allTrades.push(j);
  }
}
const { records: trades } = dedupeTrades(allTrades);
for (const j of trades) {
  const sid = j.sessionId || "n/a";
  const at = String(j.sellAt || j.ts || "");
  const s = sessions.get(sid) || { firstAt: at, lastAt: at };
  if (at > s.lastAt) s.lastAt = at;
  if (at < s.firstAt) s.firstAt = at;
  sessions.set(sid, s);
}

let sessionId = target;
if (!sessionId) {
  sessionId = [...sessions.entries()].sort((a, b) => String(b[1].lastAt).localeCompare(String(a[1].lastAt)))[0]?.[0] || null;
}

if (!sessionId || !sessions.has(sessionId)) {
  console.error(`session not found: ${sessionId || "(empty journal)"}`);
  if (sessions.size) {
    console.error("available sessions:");
    for (const [sid, s] of [...sessions.entries()].sort((a, b) => String(b[1].lastAt).localeCompare(String(a[1].lastAt)))) {
      console.error(`  ${sid}  (${s.firstAt} .. ${s.lastAt})`);
    }
  }
  process.exit(1);
}

const list = trades.filter((t) => (t.sessionId || "n/a") === sessionId);
const n = list.length;
const wins = list.filter((t) => Number(t.pnlSol) > 0);
const losses = list.filter((t) => Number(t.pnlSol) < 0);
const spent = list.reduce((a, t) => a + Number(t.buySol || 0), 0);
const net = list.reduce((a, t) => a + Number(t.pnlSol || 0), 0);
const pnls = list.map((t) => Number(t.pnlSol));
const best = pnls.length ? Math.max(...pnls) : null;
const worst = pnls.length ? Math.min(...pnls) : null;
const netPct = spent > 0 ? (net / spent) * 100 : null;

const byReason = new Map();
const byGit = new Map();
for (const t of list) {
  const r = String(t.exitReason || "unknown");
  const b = byReason.get(r) || { n: 0, wins: 0, netSol: 0 };
  b.n += 1; if (Number(t.pnlSol) > 0) b.wins += 1; b.netSol += Number(t.pnlSol || 0);
  byReason.set(r, b);
  const g = String(t.gitSha || "n/a");
  const bg = byGit.get(g) || { n: 0, wins: 0, netSol: 0 };
  bg.n += 1; if (Number(t.pnlSol) > 0) bg.wins += 1; bg.netSol += Number(t.pnlSol || 0);
  byGit.set(g, bg);
}

const summary = summaries.get(sessionId) || null;
const sgn = (x) => (x === null || x === undefined ? "" : x >= 0 ? "+" : "");

const lines = [];
lines.push(`# session-total ${sessionId}`);
lines.push(`recovered-from-trades: ${summary ? "no (session_summary present)" : "yes (no session_summary record)"}`);
lines.push(`n: ${n}`);
lines.push(`wins: ${wins.length} / losses: ${losses.length}  (win ${n ? ((wins.length / n) * 100).toFixed(1) : 0}%)`);
lines.push(`spentSol: ${spent.toFixed(6)}`);
lines.push(`netSol: ${sgn(net)}${net.toFixed(6)}`);
lines.push(`netPct: ${netPct === null ? "n/a" : sgn(netPct) + netPct.toFixed(2) + "%"}`);
lines.push(`best: ${best === null ? "n/a" : sgn(best) + best.toFixed(6)}   worst: ${worst === null ? "n/a" : sgn(worst) + worst.toFixed(6)}`);
if (summary) {
  lines.push(`summary.netSol: ${summary.netSol ?? "n/a"}`);
  lines.push(`summary.netAfterCostsSol: ${summary.netAfterCostsSol ?? "n/a"}`);
  lines.push(`summary.closedAtStop: ${summary.manualStopCloses ?? "n/a"}`);
  lines.push(`summary.reason: ${summary.reason ?? "n/a"}`);
}
lines.push("");
lines.push("## by exitReason");
for (const [r, b] of [...byReason.entries()].sort((x, y) => y[1].n - x[1].n)) {
  lines.push(`- ${r}: n=${b.n} win=${b.n ? ((b.wins / b.n) * 100).toFixed(0) : 0}% netSol=${sgn(b.netSol)}${b.netSol.toFixed(6)}`);
}
lines.push("");
lines.push("## by gitSha");
for (const [g, b] of [...byGit.entries()].sort((x, y) => y[1].n - x[1].n)) {
  lines.push(`- ${g}: n=${b.n} win=${b.n ? ((b.wins / b.n) * 100).toFixed(0) : 0}% netSol=${sgn(b.netSol)}${b.netSol.toFixed(6)}`);
}

console.log(lines.join("\n"));
