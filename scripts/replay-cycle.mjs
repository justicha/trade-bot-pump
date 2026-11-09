#!/usr/bin/env node
// Offline full cycle: replay the raw capture through the sniper's entry/exit path AND through the
// lab's strategy variants, then check the accounting invariants of both.
//
//   node scripts/replay-cycle.mjs                 # data/raw
//   node scripts/replay-cycle.mjs --raw data/raw --journal data/journal
//
// What is checked (an integration test, not a strategy test):
//   * the replay raises no exception and every opened position is closed
//   * no position is closed twice (duplicate exit)
//   * ledger.spent == journal buy total, ledger.received == journal proceeds
//   * lab: every variant's closed trades == its journal lines
//   * existing journals: duplicate trade lines and the trace of the old "costs is not defined"
//     exit bug (positions that were sold but never journaled)
//
// Prices come from the rebuilt curve (lib/rebuild.mjs, variant F of scripts/coverage.mjs), which
// is exact between trades; the strategy parameters are the bots' own defaults and are NOT tuned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { HolderTracker } from "../lib/holders.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { CurveConsistency } from "../lib/consistency.mjs";
import { roundTripCosts } from "../lib/fees.mjs";
import { SessionLedger } from "../lib/session.mjs";
import { TradeJournal, readJournal } from "../lib/journal.mjs";
import { StrategyLab, buildVariants } from "../lib/strategy.mjs";
import { isMayhemCaller, isMayhemPath } from "../lib/mayhem.mjs";
import { ROOT } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const JOURNAL_DIR = argOf("--journal", path.join(ROOT, "data", "journal"));

// The sniper's own defaults (mirrored here, not changed).
const BUY_SOL = 0.02;
const TP = 2;
const SL = 0.5;
const TIMEOUT_SEC = 120;
const MIN_HOLDERS = 4;
const MIN_SLOTS = 1;
const MIN_DELAY_MS = 0;
const MAX_POSITIONS = 3;
const COOLDOWN_SEC = 10;

const problems = [];
const note = (ok, msg) => {
  if (!ok) problems.push(msg);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
};

// ---- replay ----------------------------------------------------------------
const priceByMint = new Map();
const perMint = new Map();
let events = 0;
let replayError = null;
try {
  for await (const rec of replayRaw(RAW_TARGET)) {
    const buf = payloadOf(rec);
    if (!buf) continue;
    const d = describe(buf);
    if (d.type === "create-v2") {
      const c = parseCreate(buf);
      if (!c || !c.launchParamsOk) continue;
      const m = perMint.get(c.mint) || { mint: c.mint, events: [], mayhem: false };
      m.createdAt = rec.ts;
      m.fromCreate = true;
      m.creator = c.creator;
      perMint.set(c.mint, m);
      continue;
    }
    if (d.type !== "trade-v3") continue;
    const ev = parseTrade(buf);
    if (!ev) continue;
    events += 1;
    const m = perMint.get(ev.mint) || { mint: ev.mint, events: [], mayhem: false };
    if (isMayhemCaller(rec.outer) || isMayhemPath(rec.path)) m.mayhem = true;
    m.events.push({
      ts: rec.ts,
      slot: rec.slot,
      len: ev.len,
      isBuy: ev.isBuyByte,
      solAmount: ev.solAmount,
      tokenAmount: ev.tokenAmount,
      user: ev.user,
      hasReserves: ev.hasReserves,
      vSol: ev.reserves?.vSol ?? null,
      vTok: ev.reserves?.vTok ?? null,
    });
    perMint.set(ev.mint, m);
  }
} catch (err) {
  replayError = err;
}
console.log(`=== REPLAY CYCLE (${RAW_TARGET}) ===`);
console.log(`  ${events} trade events, ${perMint.size} mints`);

// ---- sniper simulation -----------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-cycle-"));
const journal = new TradeJournal({ bot: "replay-sniper", dir: tmpDir });
const session = new SessionLedger({ label: "SNIPER (replay)", mode: "REPLAY" });
const tracker = new HolderTracker({ minHolders: MIN_HOLDERS, minSlots: MIN_SLOTS, minDelayMs: MIN_DELAY_MS, waitMs: 60_000 });
const consistency = new CurveConsistency();

const opens = new Map(); // mint -> { entryPrice, entryTs, peak }
const exits = new Map(); // mint -> count
let lastEntryTs = -Infinity;
let entries = 0;
let duplicateExits = 0;
let closedProceeds = 0;

function closePosition(mint, price, ts, reason) {
  const pos = opens.get(mint);
  if (!pos) {
    duplicateExits += 1;
    return;
  }
  const ratio = price / pos.entryPrice;
  const costs = roundTripCosts({ buySol: BUY_SOL, ratio });
  exits.set(mint, (exits.get(mint) || 0) + 1);
  opens.delete(mint);
  const proceeds = BUY_SOL * ratio;
  closedProceeds += proceeds;
  session.sell(proceeds, costs.grossPnl, costs);
  journal.trade({
    mint,
    buySol: BUY_SOL,
    ratio,
    pnlPct: (ratio - 1) * 100,
    pnlSol: costs.netPnl,
    holdSec: Math.round((ts - pos.entryTs) / 1000),
    exitReason: reason,
    costsSol: costs.costSol,
  });
}

// ---- run the sniper path over every mint -----------------------------------
for (const m of perMint.values()) {
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  const rb = new CurveRebuild({ reanchorOnLargeErrorPpm: 1000 });
  if (m.fromCreate) {
    rb.seedFromCreate(m.mint, { ts: m.createdAt });
  } else {
    const f = list.find((e) => e.hasReserves);
    if (!f) continue;
    rb.seed(m.mint, { vSol: f.vSol, vTok: f.vTok, ts: f.ts, source: "snapshot" });
  }

  for (const ev of list) {
    rb.apply(m.mint, { isBuy: ev.isBuy, solAmount: ev.solAmount, tokenAmount: ev.tokenAmount, ts: ev.ts });
    if (ev.hasReserves) rb.compare(m.mint, { vSol: ev.vSol, vTok: ev.vTok });
    const price = rb.priceOf(m.mint);
    if (!price || !Number.isFinite(price) || price <= 0) continue;
    priceByMint.set(m.mint, price);

    // exits first: the sniper polls its positions before it considers new entries
    const pos = opens.get(m.mint);
    if (pos) {
      const ratio = price / pos.entryPrice;
      if (ratio > pos.peak) pos.peak = ratio;
      const heldSec = (ev.ts - pos.entryTs) / 1000;
      if (ratio >= TP) closePosition(m.mint, price, ev.ts, `take-profit ${ratio.toFixed(1)}x`);
      else if (ratio <= SL) closePosition(m.mint, price, ev.ts, `stop-loss ${ratio.toFixed(2)}x`);
      else if (heldSec >= TIMEOUT_SEC) closePosition(m.mint, price, ev.ts, `timeout ${heldSec.toFixed(0)}s`);
    }

    if (opens.has(m.mint)) continue;
    tracker.track(m.mint, { at: ev.ts, slot: ev.slot });
    const snap = tracker.apply(m.mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: ev.ts, slot: ev.slot });
    if (!snap) continue;
    if (opens.size >= MAX_POSITIONS) continue;
    if (ev.ts - lastEntryTs < COOLDOWN_SEC * 1000) continue;
    if (!snap.ready || !tracker.organic(snap)) continue;
    if (ev.hasReserves) consistency.checkSnapshot(m.mint, { vSol: ev.vSol, vTok: ev.vTok }); // cross-check only
    opens.set(m.mint, { entryPrice: price, entryTs: ev.ts, peak: 1 });
    session.buy(BUY_SOL);
    entries += 1;
    lastEntryTs = ev.ts;
    tracker.drop(m.mint);
  }
  const left = opens.get(m.mint);
  if (left) closePosition(m.mint, priceByMint.get(m.mint) || left.entryPrice, list[list.length - 1].ts, "end of replay");
}

console.log("\n(1) sniper path");
note(!replayError, replayError ? `replay threw: ${replayError.message}` : "replay completed without an exception");
note(opens.size === 0, `all positions closed (${opens.size} left open)`);
const closed = [...exits.values()].reduce((a, b) => a + b, 0);
note(duplicateExits === 0, `no duplicate exits (${duplicateExits} attempts to close an already-closed position)`);
note(closed === entries, `closed ${closed} == opened ${entries}`);

// ---- accounting: ledger vs journal -----------------------------------------
const journalLines = readJournal(tmpDir).filter((r) => r.type === "trade");
const journalBuys = journalLines.reduce((s, t) => s + Number(t.buySol), 0);
const journalPnl = journalLines.reduce((s, t) => s + Number(t.pnlSol), 0);
const journalCosts = journalLines.reduce((s, t) => s + Number(t.costsSol || 0), 0);
console.log("\n(2) accounting (ledger vs journal)");
note(Math.abs(session.spentSol - journalBuys) < 1e-9, `spent ${session.spentSol.toFixed(9)} == journal buys ${journalBuys.toFixed(9)}`);
note(Math.abs(session.receivedSol - closedProceeds) < 1e-9, `received ${session.receivedSol.toFixed(9)} == sum of exits ${closedProceeds.toFixed(9)}`);
note(journalLines.length === closed, `journal lines ${journalLines.length} == closed positions ${closed}`);
note(
  Math.abs(session.netSol - (session.receivedSol - session.spentSol)) < 1e-9,
  `net ${session.netSol.toFixed(9)} == received - spent (pnl net of costs ${journalPnl.toFixed(6)} SOL, costs ${journalCosts.toFixed(6)} SOL)`,
);
note(entries > 0, `the replay actually traded (${entries} entries, otherwise the invariants above are vacuous)`);

// ---- lab variants over the same replay -------------------------------------
// The same events drive the research variants (A..F60). Each variant's closed trades are written
// to a journal, then counted back: a variant that reports a trade without a journal line (or the
// other way round) means the cycle is leaking somewhere.
const labTmp = fs.mkdtempSync(path.join(os.tmpdir(), "replay-lab-"));
const labVariants = buildVariants();
const labJournalByVariant = new Map();
for (const v of labVariants) labJournalByVariant.set(v.name, new TradeJournal({ bot: `replay-lab-${v.name}`, dir: labTmp }));
const lab = new StrategyLab({ variants: labVariants, buySol: BUY_SOL, latencyMs: 0 });
let labExits = 0;
lab.onEvent = (ev) => {
  if (ev.type !== "exit") return;
  labExits += 1;
  const j = labJournalByVariant.get(ev.variant);
  if (!j) {
    problems.push(`lab emitted an exit for an unknown variant ${ev.variant}`);
    return;
  }
  const { type, ...fields } = ev;
  j.trade(fields);
};
const labTracker = new HolderTracker({ minHolders: MIN_HOLDERS, minSlots: MIN_SLOTS, minDelayMs: MIN_DELAY_MS, waitMs: 60_000 });

for (const m of perMint.values()) {
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  if (m.fromCreate) {
    labTracker.track(m.mint, { at: m.createdAt, slot: null, creator: m.creator });
    lab.onCreate({ mint: m.mint, creator: m.creator, ts: m.createdAt, price: 30 / 1.073e9, ctx: { holders: 0, slots: 0, buyers: 0, createTs: m.createdAt } });
  }
  for (const ev of list) {
    const price = priceByMint.get(m.mint);
    if (!price) continue;
    labTracker.track(m.mint, { at: ev.ts, slot: ev.slot });
    const snap = labTracker.apply(m.mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: ev.ts, slot: ev.slot });
    if (!snap) continue;
    lab.onTrade({
      mint: m.mint,
      creator: m.creator || null,
      ts: ev.ts,
      price,
      isBuy: ev.isBuy,
      user: ev.user,
      organic: labTracker.organic(snap),
      freshPrice: true,
      ctx: { ...snap, createTs: m.fromCreate ? m.createdAt : null, entryGroup: [] },
    });
    lab.onTick({ ts: ev.ts, priceOf: (mint) => priceByMint.get(mint) });
  }
  labTracker.drop(m.mint);
}
const labResults = lab.results();
console.log("\n(3) lab variants over the same replay");
const labJournalLines = readJournal(labTmp).filter((r) => r.type === "trade");
let labMismatch = 0;
for (const r of labResults) {
  const lines = labJournalLines.filter((l) => l.bot === `replay-lab-${r.variant}`);
  if (r.trades.length !== lines.length) {
    labMismatch += 1;
    console.log(`  FAIL ${r.variant}: ${r.trades.length} closed trades but ${lines.length} journal lines`);
  }
}
note(labMismatch === 0, `${labResults.length} variants: closed trades == journal lines for every variant (${labExits} exits total)`);
note(
  labResults.every((r) => r.trades.every((t) => Number.isFinite(t.pnlSol) && Number.isFinite(t.grossRatio))),
  "every lab trade has a finite pnl and gross ratio",
);
note(labResults.every((r) => r.trades.length > 0), `every variant traded at least once (${labResults.map((r) => `${r.variant}:${r.trades.length}`).join(" ")})`);
fs.rmSync(labTmp, { recursive: true, force: true });

// ---- duplicate / orphan audit of the real journals -------------------------
console.log("\n(4) existing journals: duplicates and the old exit-bug trace");
const real = readJournal(JOURNAL_DIR).filter((r) => r.type === "trade");
const byMint = new Map();
for (const t of real) byMint.set(t.mint, (byMint.get(t.mint) || 0) + 1);
const dups = [...byMint.entries()].filter(([, n]) => n > 1);
note(dups.length === 0, `${real.length} trade lines, duplicate mints: ${dups.length}${dups.length ? ` (${dups.slice(0, 3).map(([m, n]) => `${m.slice(0, 6)}x${n}`).join(", ")})` : ""}`);
const nullPnl = real.filter((t) => !Number.isFinite(Number(t.pnlSol)));
note(nullPnl.length === 0, `lines with a non-numeric pnl: ${nullPnl.length} (a line written during the bug would have one)`);
// The "costs is not defined" bug threw before journal.trade(), so its signature is the opposite:
// a position that was sold (log line) with no journal line at all. Nothing in the journal can
// prove that, so what is checked is the negative: no half-written line and no zero-cost line.
const zeroCost = real.filter((t) => Number(t.costsSol || 0) === 0);
console.log(`  note: ${zeroCost.length} lines carry costsSol=0 (written before costs were recorded: ${zeroCost.slice(0, 3).map((t) => String(t.mint).slice(0, 6)).join(", ") || "none"})`);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nproblems: ${problems.length}`);
if (problems.length) {
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("PASS: offline cycle holds (no exception, all positions closed, no duplicate exits, ledger == journal)");

