#!/usr/bin/env node
// Phase 1 / C2: mayhemMode (account byte 81) vs mayhemRouter (journal) on a FIXED sample.
//
//   node scripts/c2-mayhem.mjs                 # 60 mints, 3 retries with backoff
//   node scripts/c2-mayhem.mjs --sample 100 --min-valid 0.9
//
// Rules (from the brief):
//   * fixed sample: mints sorted, first N -> the same set every run
//   * retries with backoff; an EMPTY RPC answer is "no data", not a disagreement
//   * the result is published only when the share of valid answers is >= --min-valid (default 0.9)
import path from "node:path";
import { readJournal } from "../lib/journal.mjs";
import { getBondingCurveState } from "../lib/pumpfun.mjs";
import { withBackoff } from "../lib/retry.mjs";
import { PublicKey } from "@solana/web3.js";
import { ROOT } from "../lib/config.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SAMPLE = Number(argOf("--sample", "60"));
const MIN_VALID = Number(argOf("--min-valid", "0.9"));

const trades = readJournal(path.join(ROOT, "data", "journal")).filter((r) => r.type === "trade");
const routerByMint = new Map();
for (const t of trades) if (t.mayhemRouter !== undefined) routerByMint.set(t.mint, Boolean(t.mayhemRouter));
const mints = [...routerByMint.keys()].sort().slice(0, SAMPLE);

console.log(`=== C2: mayhemMode (account) vs mayhemRouter (journal) ===`);
console.log(`fixed sample: ${mints.length} mints (sorted, first ${SAMPLE}), journal trades with a router flag: ${routerByMint.size}\n`);

const rows = [];
for (const mint of mints) {
  let state = null;
  let error = null;
  try {
    state = await withBackoff(() => getBondingCurveState(new PublicKey(mint), 0), { retries: 3, baseMs: 250 });
  } catch (err) {
    error = err.message;
  }
  rows.push({ mint, router: routerByMint.get(mint), mode: state ? state.isMayhemMode : null, complete: state ? state.complete : null, error });
}

const empty = rows.filter((r) => r.mode === null || r.mode === undefined);
const valid = rows.filter((r) => r.mode === true || r.mode === false);
const agree = valid.filter((r) => r.mode === r.router);
const disagree = valid.filter((r) => r.mode !== r.router);
const validShare = rows.length ? valid.length / rows.length : 0;

console.log(`valid answers: ${valid.length}/${rows.length} = ${(validShare * 100).toFixed(1)}% (empty/no-data: ${empty.length})`);
console.log(`mayhemMode=true: ${valid.filter((r) => r.mode).length}, mayhemMode=false: ${valid.filter((r) => !r.mode).length}`);
if (validShare < MIN_VALID) {
  console.log(`\nRESULT WITHHELD: valid share ${(validShare * 100).toFixed(1)}% < ${(MIN_VALID * 100).toFixed(0)}% -> "no data" (retry later, do not publish a disagreement)`);
} else {
  console.log(`agree ${agree.length}/${valid.length} = ${((agree.length / valid.length) * 100).toFixed(1)}%, disagree ${disagree.length}`);
  console.log("  router=true  & mode=true :", valid.filter((r) => r.router && r.mode).length);
  console.log("  router=true  & mode=false:", valid.filter((r) => r.router && !r.mode).length, "<- journal calls it Mayhem, the token is not in mayhem mode");
  console.log("  router=false & mode=true :", valid.filter((r) => !r.router && r.mode).length);
  console.log("  router=false & mode=false:", valid.filter((r) => !r.router && !r.mode).length);
  for (const r of disagree.slice(0, 10)) console.log(`    ${r.mint.slice(0, 8)}: router=${r.router} mode=${r.mode}`);
  console.log(`\nRESULT: ${disagree.length === 0 ? "no disagreement on the valid sample" : `${disagree.length} disagreement(s) on ${valid.length} valid mints`}`);
}
if (empty.length) console.log(`\nno-data mints (empty RPC answer or error): ${empty.slice(0, 5).map((r) => `${r.mint.slice(0, 8)}${r.error ? `(${r.error})` : ""}`).join(", ")}${empty.length > 5 ? " ..." : ""}`);
