// Shadow-report math: the numbers behind the go/no-go rule must be reproducible and honest.
// bootstrap CI only for n >= 30; no CI on tiny samples; PF/maxDD edge cases defined.
import assert from "node:assert/strict";
import { cleanEnv } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapCI, maxDrawdown, mean, median, profitFactor, summarize } from "../lib/gradstats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

assert.equal(mean([1, 2, 3]), 2);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);
assert.equal(median([]), null);

assert.equal(profitFactor([10, -5, -5]), 1);
assert.equal(profitFactor([10, 20]), Infinity, "no losses -> Infinity");
assert.equal(profitFactor([-1, -2]), 0, "no wins -> 0 (null only when there are no trades)");

// cumulative: 10, 5, -5, 15 -> peak 10, worst dip 15
assert.equal(maxDrawdown([10, -5, -10, 20]), 15);
assert.equal(maxDrawdown([1, 2, 3]), 0);

assert.equal(bootstrapCI([1, 2, 3]), null, "n<30 must not produce a CI");
const series = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1 : -1));
const a = bootstrapCI(series, { seed: 7 });
const b = bootstrapCI(series, { seed: 7 });
assert.deepEqual(a, b, "the CI must be reproducible for a fixed seed");
assert.ok(a.lo <= a.hi, "CI bounds are ordered");
assert.ok(a.lo < 0 && a.hi > 0, "a symmetric series straddles zero");

const flat = bootstrapCI(Array.from({ length: 40 }, () => 5), { seed: 1 });
assert.equal(flat.lo, 5);
assert.equal(flat.hi, 5);

assert.deepEqual(summarize([]), { n: 0, note: "no data" });
const s = summarize([10, -10, 0, 20], { reasons: ["tp", "sl", "timeout", "tp"] });
assert.equal(s.n, 4);
assert.equal(s.winPct, 50);
assert.equal(s.tpPct, 50);
assert.equal(s.slPct, 25);
assert.equal(s.timeoutPct, 25);
assert.equal(s.ci95, null, "n=4 -> no CI");

// ---- S4/S5: the report must split epochs by costsScheme and report the sample size ----
// Two accounting schemes in one file: the analyzer has to print ONE TABLE PER SCHEME (never a
// combined one), say so explicitly, and warn that a handful of mints is not a sample.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grad-analyze-"));
  const journal = path.join(dir, "synthetic.jsonl");
  const trade = (scheme, variant, mint, netPct) =>
    JSON.stringify({ ts: "2026-11-10T10:00:00.000Z", type: "gshadow_trade", variant, mint, netPct, reason: "timeout", ...(scheme ? { costsScheme: scheme } : {}) });
  const lines = [
    JSON.stringify({ ts: "2026-11-10T09:59:00.000Z", type: "gshadow_candidate", mint: "M1", fill: 93 }),
    trade("v2: pump 100+100 bps, slip=assumed", "A", "M1", 5),
    trade("v2: pump 100+100 bps, slip=assumed", "A", "M2", -5),
    trade("v2: pump 100+100 bps, slip=assumed", "B", "M1", 2),
    trade("v2: pump 100+100 bps, slip=assumed", "B", "M2", -2),
    trade("v3-single-slip: entry=curve spot", "A", "M3", 1),
    trade("v3-single-slip: entry=curve spot", "A", "M3", 1),
    trade("v3-single-slip: entry=curve spot", "A", "M3", 1),
  ];
  fs.writeFileSync(journal, lines.join("\n") + "\n");

  const child = spawn(process.execPath, [path.join(here, "analyze-graduation.mjs"), journal], {
    cwd: root,
    env: cleanEnv({ ROOT: dir, RPC_URL: "http://127.0.0.1:1" }),
  });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  assert.equal(code, 0, "the analyzer exits 0");

  assert.ok(/смешаны версии учёта \(2\)/.test(out), `the report states that two schemes are mixed:\n${out}`);
  assert.ok(/общая таблица НЕ выводится/.test(out), "the report refuses to print a combined table");
  assert.ok(/=== costsScheme: v2[^-]*— 4 trade\(s\) ===/.test(out), "one table for the v2 epoch (4 trades)");
  assert.ok(/=== costsScheme: v3-single-slip[^-]*— 3 trade\(s\) ===/.test(out), "one table for the v3 epoch (3 trades)");
  assert.equal((out.match(/variant  n     win%/g) || []).length, 2, "exactly one table per scheme, no combined table");
  // S5: sample size — unique mints, candidates, trades per variant, and the correlation warning
  assert.ok(/samples: unique mints 2 \| candidates 1 \| per variant: A=2 B=2/.test(out), `the v2 group reports its sample: ${(out.match(/samples:.*/) || [""])[0]}`);
  assert.ok(/samples: unique mints 1 \| candidates 1 \| per variant: A=3/.test(out), "the v3 group reports its sample");
  assert.ok(/WARNING: уникальных mints \d+ < 30 — наблюдения сильно коррелированы/.test(out), "a tiny sample is flagged");
  assert.ok(/withheld — \d+ distinct mints < 30/.test(out), "the verdict is withheld for a correlated sample");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ pf: profitFactor([10, -5, -5]), maxDD: maxDrawdown([10, -5, -10, 20]), ciSeed7: a }));
console.log("PASS: shadow stats (PF, maxDD, bootstrap CI, summarize) behave");

