// B5: the graduation paramsHash must include every filter that changes behaviour — different
// filter configs must produce different hashes, otherwise journal runs with different settings
// compare as identical.
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { paramsHash } from "../lib/runmeta.mjs";

const base = { BUY_SOL: 0.02, MIN_FILL_PCT: 92, MAX_FILL_PCT: 97, MIN_HOLDERS: 7, MAX_TOP10_SHARE: 0, TAKE_PROFIT: 1.5 };
assert.equal(paramsHash(base), paramsHash(base), "deterministic");
assert.notEqual(paramsHash(base), paramsHash({ ...base, MAX_FILL_PCT: 95 }), "MAX_FILL_PCT changes the hash");
assert.notEqual(paramsHash(base), paramsHash({ ...base, MIN_HOLDERS: 5 }), "MIN_HOLDERS changes the hash");
assert.notEqual(paramsHash(base), paramsHash({ ...base, MAX_TOP10_SHARE: 30 }), "MAX_TOP10_SHARE changes the hash");
assert.equal(
  paramsHash(base),
  paramsHash({ MAX_TOP10_SHARE: 0, MIN_HOLDERS: 7, MAX_FILL_PCT: 97, BUY_SOL: 0.02, MIN_FILL_PCT: 92, TAKE_PROFIT: 1.5 }),
  "key order does not matter",
);

console.log(JSON.stringify({ distinct: true }));
console.log("PASS: paramsHash distinguishes every graduation filter");
