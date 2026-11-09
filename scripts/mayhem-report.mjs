#!/usr/bin/env node
// Mayhem report (step 1): is the program id that owns the k-invariant violations the same id
// everywhere, and what share of tokens/trades is Mayhem?
//
//   node scripts/mayhem-report.mjs                  # data/raw
//   node scripts/mayhem-report.mjs --rpc-sample 8   # + validate the token class on the curve account
//
// Three independent sources are cross-checked:
//   trade level : the trade event's outer (calling) program == MAYHEM_PROGRAM
//   create level: create-v2 payload (name/symbol/uri/mint/... + a variable tail)
//   account     : BondingCurve byte 81 = is_mayhem_mode (authoritative)
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { MAYHEM_PROGRAM_ID, MayhemIndex, isMayhemCaller, isMayhemPath, MAYHEM_ACCOUNT_FLAG_OFFSET } from "../lib/mayhem.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const RPC_SAMPLE = Number(argOf("--rpc-sample", "0"));

const index = new MayhemIndex();
const outerCounts = new Map();
const mintsWithCreate = new Set();
const createFlagGuess = new Map(); // mint -> boolean guessed from the create tail (validated below)
let tradeEvents = 0;
let mayhemTradeEvents = 0;
let createEvents = 0;
let createLaunchOk = 0;
let pathOnly = 0;

for await (const rec of replayRaw(RAW_TARGET)) {
  outerCounts.set(rec.outer || "direct", (outerCounts.get(rec.outer || "direct") || 0) + 1);
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);

  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (!c) continue;
    createEvents += 1;
    if (c.launchParamsOk) createLaunchOk += 1;
    mintsWithCreate.add(c.mint);
    // The tail is variable-length; the only stable trailing pattern observed is a one-byte flag
    // followed by padding. It is NOT trusted — it is compared with the account flag below and
    // only reported, never used as the verdict.
    if (c.tail.length >= 2) createFlagGuess.set(c.mint, c.tail[c.tail.length - 2] === 1);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  tradeEvents += 1;
  const direct = isMayhemCaller(rec.outer);
  const viaPath = !direct && isMayhemPath(rec.path);
  if (viaPath) pathOnly += 1;
  if (direct || viaPath) mayhemTradeEvents += 1;
  index.noteTrade(ev.mint, { outer: rec.outer, path: rec.path, user: ev.user, isBuy: ev.isBuyByte, tokenAmount: ev.tokenAmount });
}

const stats = index.stats();
const exact = outerCounts.get(MAYHEM_PROGRAM_ID) || 0;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

console.log(`=== MAYHEM REPORT (${RAW_TARGET}) ===`);
console.log(`\n(1) program id verification`);
console.log(`  expected : ${MAYHEM_PROGRAM_ID}`);
console.log(`  seen in  : ${exact} raw events whose outer program is this exact string`);
const nearMisses = [...outerCounts.keys()].filter((k) => k !== "direct" && k !== MAYHEM_PROGRAM_ID && /^MAyh/i.test(k));
console.log(`  same-prefix but different ids: ${nearMisses.length ? nearMisses.join(", ") : "none"}`);

console.log(`\n(2) share of Mayhem`);
console.log(`  trades : ${mayhemTradeEvents}/${tradeEvents} (${pct(mayhemTradeEvents, tradeEvents)}) reached through Mayhem` + (pathOnly ? ` (${pathOnly} only deeper in the call path)` : ""));
console.log(`  tokens : ${stats.mayhemTokens}/${stats.mints} (${pct(stats.mayhemTokens, stats.mints)}) have at least one Mayhem trade`);
console.log(`  creates: ${createEvents} create-v2 parsed, ${createLaunchOk} with the documented launch reserves, ${mintsWithCreate.size} of ${stats.mints} mints seen at creation`);


// ---- account cross-check ----------------------------------------------------
let rpc = null;
if (RPC_SAMPLE > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  rpc = [];
  const recs = [...index.mints.values()];
  // Prefer mints whose create payload we actually saw, so the create-tail guess can be tested.
  const byCreate = (a, b) => Number(createFlagGuess.has(b.mint)) - Number(createFlagGuess.has(a.mint));
  const half = Math.ceil(RPC_SAMPLE / 2);
  const may = recs.filter((r) => r.mayhem).sort(byCreate).slice(0, half);
  const plain = recs.filter((r) => !r.mayhem).sort(byCreate).slice(0, RPC_SAMPLE - half);
  console.log(`\n(3) curve account cross-check (byte ${MAYHEM_ACCOUNT_FLAG_OFFSET} = is_mayhem_mode)`);
  for (const r of [...may, ...plain]) {
    try {
      const info = await connection.getAccountInfo(getBondingCurve(new PublicKey(r.mint)));
      if (!info) {
        console.log(`  ${r.mint.slice(0, 8)} (${r.mayhem ? "mayhem" : "plain"}): no account (migrated?)`);
        continue;
      }
      const flag = info.data.length > MAYHEM_ACCOUNT_FLAG_OFFSET ? info.data[MAYHEM_ACCOUNT_FLAG_OFFSET] === 1 : null;
      const guess = createFlagGuess.has(r.mint) ? createFlagGuess.get(r.mint) : null;
      rpc.push({ mint: r.mint, tradeEvidence: r.mayhem, accountFlag: flag, agree: flag === r.mayhem, createTailGuess: guess });
      console.log(
        `  ${r.mint.slice(0, 8)}: trade-evidence=${r.mayhem ? "mayhem" : "plain"}  account flag=${flag}  ${flag === r.mayhem ? "AGREE" : "DISAGREE"}` +
          (guess === null ? "  (no create event seen)" : `  create-tail guess=${guess}${guess === flag ? " (matches)" : " (does not match)"}`),
      );
    } catch (err) {
      console.log(`  ${r.mint.slice(0, 8)}: rpc error ${err.message}`);
    }
  }
  const agree = rpc.filter((x) => x.agree).length;
  const guessChecked = rpc.filter((x) => x.createTailGuess !== null);
  const guessAgree = guessChecked.filter((x) => x.createTailGuess === x.accountFlag).length;
  console.log(`  token class: trade evidence vs account flag agree ${agree}/${rpc.length}`);
  console.log(
    `  create-tail guess vs account flag: ${guessAgree}/${guessChecked.length} -> ` +
      `${guessChecked.length && guessAgree === guessChecked.length ? "usable as a hint" : "NOT reliable, the account flag stays the source of truth"}`,
  );
}

const out = path.join(ROOT, "data", "research", "mayhem.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      mayhemProgram: MAYHEM_PROGRAM_ID,
      outerEventsWithMayhemId: exact,
      samePrefixOtherIds: nearMisses,
      trades: { total: tradeEvents, mayhem: mayhemTradeEvents, viaPathOnly: pathOnly },
      tokens: { total: stats.mints, mayhem: stats.mayhemTokens },
      creates: { events: createEvents, launchParamsOk: createLaunchOk, mints: mintsWithCreate.size },
      rpc,
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${out}`);
