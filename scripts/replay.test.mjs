// Tests for the replay statistics: bootstrap CI, 70/30 split, and the strict verdict rule.
// Also runs the real CLI on synthetic journals to prove the end-to-end pipeline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv } from "./lib/test-env.mjs";
import { execFileSync } from "node:child_process";

process.env.RPC_URL = "https://example.invalid/?api-key=test";
const { bootstrapCI, splitByTime, evaluateVariant, chooseByTuning } = await import("../lib/research.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---- bootstrap --------------------------------------------------------------
{
  const ci = bootstrapCI([-10, 0, 10], { resamples: 500, seed: 7 });
  asrt(ci.n === 3 && Math.abs(ci.mean) < 1e-9, "mean of [-10,0,10] is 0");
  asrt(ci.lo < 0 && ci.hi > 0, "CI must straddle zero: " + JSON.stringify(ci));

  const same = bootstrapCI([-10, 0, 10], { resamples: 500, seed: 7 });
  asrt(JSON.stringify(ci) === JSON.stringify(same), "bootstrap must be reproducible with a seed");

  const tight = bootstrapCI(new Array(400).fill(5), { resamples: 500 });
  asrt(tight.lo === 5 && tight.hi === 5, "constant sample -> degenerate CI at 5: " + JSON.stringify(tight));
  asrt(bootstrapCI([]).n === 0, "empty sample is handled");
}

// ---- split ------------------------------------------------------------------
{
  const trades = Array.from({ length: 10 }, (_, i) => ({ exitTs: i, pnlPct: i }));
  const { tuning, test } = splitByTime(trades, 0.7);
  asrt(tuning.length === 7 && test.length === 3, `70/30 split -> 7/3, got ${tuning.length}/${test.length}`);
  asrt(tuning[0].exitTs === 0 && test[test.length - 1].exitTs === 9, "split keeps time order");
}

// ---- verdict rule -----------------------------------------------------------
{
  // 1000 trades, all +5% -> 300 test trades with a CI well above zero: PASS
  const good = Array.from({ length: 1000 }, (_, i) => ({ exitTs: i, pnlPct: 5, pnlSol: 0.001, reason: "take-profit" }));
  const g = evaluateVariant("G", good, { minTrades: 300, resamples: 500 });
  asrt(g.nTest === 300, "30% of 1000 = 300 test trades, got " + g.nTest);
  asrt(g.pass === true, "constant +5% must pass: " + g.reason);

  // same size, zero mean -> CI straddles zero: FAIL with the CI reason
  const flat = Array.from({ length: 1000 }, (_, i) => ({ exitTs: i, pnlPct: i % 2 ? -10 : 10, pnlSol: 0, reason: "x" }));
  const f = evaluateVariant("F", flat, { minTrades: 300, resamples: 500 });
  asrt(f.pass === false && /CI lower bound/.test(f.reason), "zero-mean must fail on the CI: " + f.reason);

  // too little data -> FAIL with the count reason, no matter how good the mean is
  const few = Array.from({ length: 100 }, (_, i) => ({ exitTs: i, pnlPct: 50, pnlSol: 0.01, reason: "take-profit" }));
  const s = evaluateVariant("S", few, { minTrades: 300, resamples: 200 });
  asrt(s.pass === false && /only 30\/300 test trades/.test(s.reason), "must refuse to claim an edge on 30 trades: " + s.reason);

  // tuning picks the best SL, not the best test result
  const byTune = chooseByTuning([
    { variant: "F40", nTuning: 10, tuning: { meanPct: 3 }, test: { meanPct: -5 } },
    { variant: "F60", nTuning: 10, tuning: { meanPct: 1 }, test: { meanPct: 9 } },
  ]);
  asrt(byTune.variant === "F40", "chooseByTuning must use the tuning column only, got " + byTune.variant);
}

// ---- CLI on synthetic journals ---------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-test-"));
  const write = (name, trades) =>
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), trades.map((t) => JSON.stringify(t)).join("\n") + "\n");

  write("A", Array.from({ length: 1200 }, (_, i) => ({ type: "exit", variant: "A", exitTs: i, pnlPct: -20, pnlSol: -0.004, reason: "stop-loss 0.4x" })));
  write("B", Array.from({ length: 1200 }, (_, i) => ({ type: "exit", variant: "B", exitTs: i, pnlPct: 30, pnlSol: 0.006, reason: "take-profit 2x" })));

  const out = execFileSync(process.execPath, ["bots/research/replay.mjs", dir], {
    cwd: process.cwd(),
    env: cleanEnv({ RPC_URL: process.env.RPC_URL }),
    encoding: "utf8",
  });

  asrt(/VARIANT REPLAY/.test(out), "CLI must print the table header");
  asrt(/VERDICT/.test(out), "CLI must print a verdict");
  asrt(/passed the criterion/.test(out) && /B/.test(out), "B (always +30%) must pass the criterion");
  asrt(/no \(/.test(out), "A must be marked as failing");

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("PASS: bootstrap CI, 70/30 split, strict verdict (edge only with >=300 hold-out trades and CI>0), CLI runs");
