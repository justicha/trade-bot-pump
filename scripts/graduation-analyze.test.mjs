// Shadow-report math: the numbers behind the go/no-go rule must be reproducible and honest.
// bootstrap CI only for n >= 30; no CI on tiny samples; PF/maxDD edge cases defined.
import assert from "node:assert/strict";
import { bootstrapCI, maxDrawdown, mean, median, profitFactor, summarize } from "../lib/gradstats.mjs";

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

console.log(JSON.stringify({ pf: profitFactor([10, -5, -5]), maxDD: maxDrawdown([10, -5, -10, 20]), ciSeed7: a }));
console.log("PASS: shadow stats (PF, maxDD, bootstrap CI, summarize) behave");
