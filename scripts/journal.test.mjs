// Unit test for the trade journal: writing, reading back, and the summary that drives
// strategy tuning (win rate, PnL by exit reason, "exit too early" detection).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RPC_URL = process.env.RPC_URL || "https://example.invalid/?api-key=test";
const { TradeJournal, readJournal, summarize } = await import("../lib/journal.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-test-"));
const j = new TradeJournal({ bot: "test", dir });

// two trades: one lost on stop-loss and kept running after the exit, one won
j.trade({ mint: "MINT_A", pnlSol: -0.012, ratio: 0.4, peakRatio: 1.2, holdSec: 10, exitReason: "stop-loss 0.40x", holdersAtEntry: 4, devBuySol: 2 });
j.trade({ mint: "MINT_B", pnlSol: 0.02, ratio: 2.1, peakRatio: 2.3, holdSec: 30, exitReason: "take-profit 2.1x", holdersAtEntry: 6, devBuySol: 1 });
j.postExit({ mint: "MINT_A", exitRatio: 0.4, bestRatioAfterExit: 2.4, windowSec: 300 }); // 6x the exit price
j.postExit({ mint: "MINT_B", exitRatio: 2.1, bestRatioAfterExit: 2.4, windowSec: 300 }); // 1.14x -> fine

const records = readJournal(dir);
asrt(records.length === 4, "4 records read back, got " + records.length);
asrt(records.every((r) => r.bot === "test" && typeof r.ts === "string"), "every record has bot + ts");

const s = summarize(records, { tooEarlyMultiple: 1.5 });
asrt(s.n === 2, "2 trades, got " + s.n);
asrt(s.wins === 1 && s.losses === 1, "1W/1L, got " + s.wins + "W/" + s.losses + "L");
asrt(s.winRate === 50, "win rate 50%, got " + s.winRate);
asrt(s.netSol === 0.008, "net +0.008, got " + s.netSol);
asrt(s.avgHoldSec === 20, "avg hold 20s, got " + s.avgHoldSec);
asrt(s.byReason.length === 2, "2 exit reasons, got " + s.byReason.length);

asrt(s.postExit.measured === 2 && s.postExit.tooEarly === 1, "1 of 2 exits flagged too early, got " + JSON.stringify(s.postExit));
asrt(s.postExit.worst[0].mint === "MINT_A", "the stop-loss exit is the too-early one");
asrt(s.postExit.worst[0].missedMultiple === 6, "missed 6x, got " + s.postExit.worst[0].missedMultiple);

// a broken/knee-less line must not crash the reader
fs.writeFileSync(path.join(dir, "broken.jsonl"), '{"type":"trade"\n');
asrt(readJournal(dir).length === 4, "half-written line skipped, still 4 records");

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ netSol: s.netSol, tooEarly: s.postExit.tooEarly, missed: s.postExit.worst[0].missedMultiple }));
console.log("PASS: journal writes/reads, summary flags early exits (missed 6x) and ignores broken lines");
