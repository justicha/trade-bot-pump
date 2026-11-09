#!/usr/bin/env node
// Compact CSV export for the analysis spreadsheet (step 2).
//
//   node scripts/export-compact.mjs [sessionId]
//
// Columns: mint8, git, holdersAtEntry, tHolders4/6/8/10 (seconds from create), entryPremiumVsFloor,
// mayhemMode, creatorLaunches30m (disk registry, cross-session), exit, holdS, peak, net%, best5m,
// trunc, priceSource, mcapUsd.
//
//   - Deduplicates by mint+sessionId / mint+buyAt 3s (lib/journal.mjs).
//   - mcapUsd = entryUsd x 1e9 (supply ~1e9 tokens); legacy rows (no gitSha) stored entryUsd 1000x
//     too big (raw-vs-whole units), so those are divided by 1000.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJournal, dedupeTrades } from "../lib/journal.mjs";
import { loadCreatorRegistry, creatorLaunches30m } from "../lib/creators.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.JOURNAL_DIR || path.join(ROOT, "data", "journal");
const sid = process.argv[2] || null;

const rows = readJournal(dir);
const { records } = dedupeTrades(rows);
const trades = records.filter((r) => r.type === "trade" && (!sid || r.sessionId === sid));

const post = new Map();
for (const r of records) if (r.type === "post_exit") post.set(r.mint, r);

const creatorReg = loadCreatorRegistry();

// Holder milestones from holders-<date>.jsonl, keyed by mint + sessionId.
const holderMs = new Map();
try {
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith("holders-") || !f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      if (j.phase !== "milestone") continue;
      const k = j.mint + "|" + (j.sessionId || "");
      if (!holderMs.has(k)) holderMs.set(k, {});
      holderMs.get(k)[j.holders] = j.sec;
    }
  }
} catch {
  /* no holder ticks yet */
}

const FLOOR = 30e9 / 1.073e15; // raw launch price (SOL per raw unit)

const HDR = ["mint8", "git", "holdersAtEntry", "tHolders4", "tHolders6", "tHolders8", "tHolders10", "entryPremiumVsFloor", "mayhemMode", "creator30m", "exit", "holdS", "peak", "net%", "best5m", "trunc", "priceSource", "mcapUsd"];
const out = [];
for (const r of trades) {
  const p = post.get(r.mint);
  const entryUsd = Number(r.entryUsd || 0) || 0;
  const correctedUsd = r.gitSha ? entryUsd : entryUsd / 1000; // legacy rows: entryUsd was 1000x
  const mcapUsd = correctedUsd ? Math.round(correctedUsd * 1e9) : "";
  const entrySol = Number(r.entrySol || 0);
  const premium = entrySol > 0 ? entrySol / FLOOR - 1 : "";
  const hm = holderMs.get(r.mint + "|" + (r.sessionId || "")) || {};
  const at = Date.parse(r.buyAt || r.sellAt || r.ts || Date.now());
  const c30 = r.creator ? creatorLaunches30m(creatorReg, r.creator, Number.isFinite(at) ? at : Date.now()) : "";
  const c30v = c30 === null ? (r.creatorLaunches30m ?? "") : c30;
  out.push([
    r.mint.slice(0, 8),
    r.gitSha || "",
    r.holdersAtEntry ?? "",
    hm[4] ?? "",
    hm[6] ?? "",
    hm[8] ?? "",
    hm[10] ?? "",
    premium === "" ? "" : premium.toFixed(2),
    r.mayhemMode ?? r.isMayhem ?? "",
    c30v ?? "",
    (r.exitReason || "").split(" ")[0],
    r.holdSec ?? "",
    r.peakRatio != null ? Number(r.peakRatio).toFixed(2) : "",
    Number(r.buySol) > 0 ? ((100 * Number(r.pnlSol)) / Number(r.buySol)).toFixed(0) : "",
    p?.bestRatioAfterExit != null ? Number(p.bestRatioAfterExit).toFixed(2) : "",
    p?.truncated ? 1 : 0,
    r.priceSource || "",
    mcapUsd,
  ].join(","));
}
console.log([HDR.join(","), ...out].join("\n"));
