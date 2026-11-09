// Integration test: a normalized multi-hop PumpSwap fixture goes through the IMPORTED
// fetchTxDetails (cache path, no network). Verifies events of different user/mint are not
// mixed and that an unresolved event is counted in stats.pswapUnresolved.
import fs from "node:fs";
import { fetchTxDetails } from "../lib/analyzer-core.mjs";

const norm = JSON.parse(fs.readFileSync("tests/fixtures/pswap_multihop.norm.json", "utf8"));
const A = norm.keys[0], B = norm.keys[0];
const ownerByUser = Object.fromEntries(norm.postTok.map((t) => [t.owner, t.owner]));
const X = norm.postTok[0].mint, Z = norm.postTok[1].mint;
const userA = norm.postTok[0].owner, userB = norm.postTok[2].owner;

const stats = { fetched: 0, cached: 0, missing: 0, errors: 0, retries: 0, pumpSwapTrades: 0, pswapUnresolved: 0 };
const deps = {
  getTx: () => { throw new Error("network must not be used (cache path)"); },
  readCache: () => norm,
  writeCache: () => {},
  stats,
  log: () => {},
};

const d = await fetchTxDetails("FIXTURE_SIG", null, deps);
const trades = d.events.filter((e) => e.type === "trade");
const asrt = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } };

asrt(trades.length === 4, "4 pswap trade events, got " + trades.length);
// grouping key user:mint — different user/mint must not be merged into one event
const groups = {};
for (const t of trades) { const k = t.user + ":" + (t.mint || "null"); groups[k] = (groups[k] || 0) + 1; }
asrt(groups[userA + ":" + X] === 1, "userA:X present (not mixed with Z)");
asrt(groups[userA + ":" + Z] === 1, "userA:Z separate from X");
asrt(groups[userB + ":" + X] === 1, "userB:X separate from userA:X");
asrt(groups[userA + ":null"] === 1, "userA unresolved (ambiguous mints) -> null");
// explicit non-mixing checks
const e1 = trades.find((t) => t.user === userA && t.mint === X), e2 = trades.find((t) => t.user === userA && t.mint === Z);
asrt(e1 && e2 && e1 !== e2, "same user split across two mints into distinct events");
// unresolved counted
const unres = trades.filter((t) => t.unresolved === true);
asrt(unres.length === 1 && unres[0].mint === null, "exactly one unresolved event with mint=null");
asrt(stats.pswapUnresolved === 1, "stats.pswapUnresolved === 1, got " + stats.pswapUnresolved);

console.log(JSON.stringify({ trades: trades.length, groups: Object.keys(groups), pswapUnresolved: stats.pswapUnresolved }));
console.log("PASS: multihop events grouped by user+mint (not mixed); unresolved counted");
