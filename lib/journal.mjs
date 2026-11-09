// Trade journal — the raw material for tuning the strategy.
//
// Every closed trade is appended as one JSON line to data/journal/YYYY-MM-DD.jsonl, and a
// second line ("post_exit") lands later with how far the price actually went AFTER we sold.
// That is what tells you whether an exit was too early: exit ratio vs best ratio after exit.
//
// data/ is gitignored, so the journal never ends up in the repo.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { COSTS_SCHEME } from "./fees.mjs";
import { mskDateKey, mskIso } from "./time.mjs";

const DIR = process.env.JOURNAL_DIR ? path.resolve(process.env.JOURNAL_DIR) : path.join(ROOT, "data", "journal");

function today() {
  // Moscow calendar day: the file must roll over at Moscow midnight, not at UTC midnight.
  return mskDateKey();
}

export class TradeJournal {
  constructor({ bot = "bot", dir = DIR } = {}) {
    this.bot = bot;
    this.dir = dir;
    this.enabled = true;
    this.warned = false;
  }

  file() {
    return path.join(this.dir, `${today()}.jsonl`);
  }

  // Append one record. Never throws: a broken disk must not kill a trading session.
  write(record) {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), tsMsk: mskIso(), bot: this.bot, ...record });
      fs.appendFileSync(this.file(), line + "\n");
    } catch (err) {
      this.enabled = false;
      if (!this.warned) {
        this.warned = true;
        process.stderr.write(`[journal] disabled: ${err.message}\n`);
      }
    }
  }

  trade(fields) {
    // costsScheme marks WHICH cost model produced costsSol/pnlSol. Without it a journal that
    // spans a change in the fee model mixes epochs: the numbers are per-trade comparable, the
    // aggregates are not. Older lines without the field are "v1" by definition.
    this.write({ type: "trade", costsScheme: COSTS_SCHEME, ...fields });
  }

  postExit(fields) {
    this.write({ type: "post_exit", ...fields });
  }
}

// Split trade records by cost scheme. Lines written before the costsScheme stamp (or carrying an
// older scheme) are "v1"; they must not be averaged together with v2, whose costs/pnl mean
// something different. Consumers report the excluded count instead of silently mixing epochs.
export function splitByScheme(records) {
  const v2 = [];
  const v1 = [];
  for (const r of records) {
    if (r.type !== "trade") continue;
    const scheme = typeof r.costsScheme === "string" ? r.costsScheme : "";
    if (scheme.startsWith("v2")) v2.push(r);
    else v1.push(r);
  }
  return { v2, v1, v2Count: v2.length, v1Count: v1.length };
}

// A session record marks the RPC health of a run. Sessions with a 429 share > 5% are "degraded":
// their trades happened under throttling, so strategy evaluation must not include them.
export function excludeDegraded(records) {
  const degraded = new Set();
  for (const r of records) if (r.type === "session" && r.degraded === true && r.sessionId) degraded.add(r.sessionId);
  const kept = [];
  const trades = [];
  const excluded = [];
  for (const r of records) {
    const isTradeLine = r.type === "trade" || r.type === "exit";
    if (isTradeLine && r.sessionId && degraded.has(r.sessionId)) {
      excluded.push(r);
      continue;
    }
    kept.push(r);
    if (isTradeLine) trades.push(r);
  }
  return { degraded, records: kept, trades, excluded, degradedCount: degraded.size, excludedCount: excluded.length };
}

// Read every journal file in a directory (or a single file). Returns parsed records.
export function readJournal(target = DIR) {
  const files = [];
  try {
    const st = fs.statSync(target);
    if (st.isFile()) files.push(target);
    else for (const f of fs.readdirSync(target)) if (f.endsWith(".jsonl")) files.push(path.join(target, f));
  } catch {
    return [];
  }

  const out = [];
  for (const f of files.sort()) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* skip a half-written line */
      }
    }
  }
  return out;
}

// Deduplicate trade records. Two simultaneously-running sniper processes can both buy the same
// mint (a bug the instance lock now prevents) and write two trade lines ~1-2 s apart with DIFFERENT
// sessionIds; a restart can also re-append an already-closed trade. The dedup key is therefore:
//   mint + sessionId            (primary — a mint is traded at most once per process)
//   mint + buyAt bucketed to 3 s (fallback — catches cross-process duplicates and legacy rows
//                                 without a sessionId)
// A record is dropped if either key was already seen. Returns { records, removedByGit } so callers
// can report how many rows were removed per gitSha.
export function dedupeTrades(records) {
  const seenSession = new Map(); // mint|sessionId -> kept record
  const seenMint = new Map(); // mint -> kept record (two processes both buying the same mint)
  const seenTime = new Map(); // mint|buyAt3s -> kept record (legacy rows without a sessionId)
  const removedByGit = new Map();
  const duplicates = []; // each glued pair: mint + both sessionIds + time gap
  const out = [];
  const tsOf = (r) => (typeof (r.buyAt || r.ts) === "string" ? Date.parse(r.buyAt || r.ts) : Number(r.buyAt || r.ts));
  for (const r of records) {
    if (r.type !== "trade") {
      out.push(r);
      continue;
    }
    const sid = r.sessionId || "";
    const keySession = `${r.mint}|${sid}`;
    const t = tsOf(r);
    const bucket = Number.isFinite(t) ? Math.round(t / 3000) : String(r.buyAt || r.ts || "na");
    const keyTime = `${r.mint}|${bucket}`;
    let kept = null;
    if (sid) {
      if (seenSession.has(keySession)) kept = seenSession.get(keySession);
      else if (seenMint.has(r.mint)) kept = seenMint.get(r.mint);
    } else if (seenTime.has(keyTime)) {
      kept = seenTime.get(keyTime);
    }
    if (kept) {
      const g = r.gitSha || "n/a";
      removedByGit.set(g, (removedByGit.get(g) || 0) + 1);
      const kt = tsOf(kept);
      duplicates.push({
        mint: r.mint,
        keptSessionId: kept.sessionId || null,
        dupSessionId: sid || null,
        gapMs: Number.isFinite(kt) && Number.isFinite(t) ? Math.round(t - kt) : null,
      });
      continue;
    }
    if (sid) {
      seenSession.set(keySession, r);
      seenMint.set(r.mint, r);
    } else {
      seenTime.set(keyTime, r);
    }
    out.push(r);
  }
  return { records: out, removedByGit, duplicates };
}

const round = (x, d = 9) => Math.round(x * 10 ** d) / 10 ** d;

// Aggregate journal records into the numbers that matter for tuning.
//   tooEarlyMultiple: an exit counts as "too early" when the price after the exit reached
//   more than this multiple of the exit price.
export function summarize(records, { tooEarlyMultiple = 1.5 } = {}) {
  const posts = new Map();
  for (const r of records) if (r.type === "post_exit" && r.mint) posts.set(r.mint, r);

  const trades = records.filter((r) => r.type === "trade");
  const byReason = new Map();
  const buckets = { captured: [], tooEarly: [], unknown: [] };

  let wins = 0;
  let losses = 0;
  let netSol = 0;
  let holdSecTotal = 0;
  let holdCount = 0;

  for (const t of trades) {
    const pnl = Number(t.pnlSol) || 0;
    netSol += pnl;
    if (pnl > 0) wins += 1;
    else if (pnl < 0) losses += 1;
    if (Number.isFinite(t.holdSec)) {
      holdSecTotal += t.holdSec;
      holdCount += 1;
    }

    const reason = t.exitReason || "unknown";
    const b = byReason.get(reason) || { n: 0, wins: 0, netSol: 0, holdSec: 0 };
    b.n += 1;
    if (pnl > 0) b.wins += 1;
    b.netSol += pnl;
    b.holdSec += Number(t.holdSec) || 0;
    byReason.set(reason, b);

    const post = posts.get(t.mint);
    const exitRatio = Number(t.ratio);
    const best = Number(post?.bestRatioAfterExit);
    if (!Number.isFinite(exitRatio) || !Number.isFinite(best) || exitRatio <= 0) {
      buckets.unknown.push(t);
    } else if (best / exitRatio > tooEarlyMultiple) {
      buckets.tooEarly.push({ ...t, bestRatioAfterExit: best, missedMultiple: round(best / exitRatio, 2) });
    } else {
      buckets.captured.push(t);
    }
  }

  const missed = buckets.tooEarly.map((t) => t.missedMultiple).sort((a, b) => a - b);

  return {
    n: trades.length,
    wins,
    losses,
    winRate: trades.length ? round((wins / trades.length) * 100, 1) : 0,
    netSol: round(netSol, 6),
    avgHoldSec: holdCount ? Math.round(holdSecTotal / holdCount) : 0,
    byReason: [...byReason.entries()]
      .map(([reason, b]) => ({
        reason,
        n: b.n,
        wins: b.wins,
        netSol: round(b.netSol, 6),
        avgHoldSec: b.n ? Math.round(b.holdSec / b.n) : 0,
      }))
      .sort((a, b) => b.n - a.n),
    postExit: {
      measured: buckets.captured.length + buckets.tooEarly.length,
      tooEarly: buckets.tooEarly.length,
      captured: buckets.captured.length,
      unknown: buckets.unknown.length,
      tooEarlyMultiple,
      avgMissedMultiple: missed.length ? round(missed.reduce((a, b) => a + b, 0) / missed.length, 2) : 0,
      worst: buckets.tooEarly.sort((a, b) => b.missedMultiple - a.missedMultiple).slice(0, 5),
    },
  };
}
