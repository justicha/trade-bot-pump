#!/usr/bin/env node
// Step 3 (low priority): what actually moves the curve's SOL reserve on a Mayhem-routed trade?
//
//   node scripts/mayhem-sol.mjs                 # 3 signatures from data/raw
//   node scripts/mayhem-sol.mjs --count 5
//
// For each of a few Mayhem signatures whose trade payload is a 390/391 one (the class whose SOL
// reserve side breaks x*y=k), fetch the transaction with parsed instructions and look at where the
// lamports went: the instruction sequence, the lamport delta of every account, and which of those
// accounts is the bonding curve itself. Anything that is not explained by the swap amounts is what
// the reconstruction model cannot see.
import { replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade } from "../lib/events.mjs";
import { isMayhemCaller, MAYHEM_PROGRAM_ID } from "../lib/mayhem.mjs";
import { connection } from "../lib/rpc.mjs";
import { getBondingCurve } from "../lib/pumpfun.mjs";
import { PublicKey } from "@solana/web3.js";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const COUNT = Number(argOf("--count", "3"));

// Pick the first few distinct Mayhem signatures with a 390/391 payload.
const seen = new Map();
for await (const rec of replayRaw(RAW_TARGET)) {
  if (seen.size >= COUNT) break;
  if (!rec.sig || seen.has(rec.sig)) continue;
  if (!isMayhemCaller(rec.outer)) continue;
  const buf = payloadOf(rec);
  if (!buf) continue;
  if (describe(buf).type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev || !ev.hasReserves) continue;
  if (ev.len !== 390 && ev.len !== 391) continue;
  seen.set(rec.sig, { sig: rec.sig, mint: ev.mint, len: ev.len, solAmount: ev.solAmount, tokenAmount: ev.tokenAmount, vSol: ev.reserves.vSol, vTok: ev.reserves.vTok, slot: rec.slot });
}

console.log(`=== MAYHEM SOL FLOW (${seen.size} signature(s), program ${MAYHEM_PROGRAM_ID}) ===`);
if (!seen.size) {
  console.log("no matching signature in the raw capture");
  process.exit(0);
}

for (const item of seen.values()) {
  console.log(`\n--- ${item.sig} (mint ${item.mint.slice(0, 8)}, payload len ${item.len}, slot ${item.slot})`);
  console.log(`    payload says: ${item.solAmount.toFixed(6)} SOL, ${item.tokenAmount.toFixed(2)} tokens, vSol=${item.vSol}, vTok=${item.vTok}`);
  let tx;
  try {
    tx = await connection.getParsedTransaction(item.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  } catch (err) {
    console.log(`    rpc error: ${err.message}`);
    continue;
  }
  if (!tx) {
    console.log("    transaction not available (old / pruned)");
    continue;
  }
  const msg = tx.transaction.message;
  const accountKeys = msg.accountKeys.map((k) => (typeof k === "string" ? k : String(k.pubkey?.toBase58?.() ?? k.pubkey)));
  const curve = getBondingCurve(new PublicKey(item.mint)).toBase58();

  // 1. instruction sequence (names come from the log lines, parsed types from the RPC)
  const ixNames = [];
  for (const line of tx.meta?.logMessages || []) {
    const m = /^Program log: Instruction: (\w+)/.exec(line);
    if (m) ixNames.push(m[1]);
  }
  console.log(`    instructions: ${ixNames.length ? ixNames.join(" -> ") : "none logged"}`);
  const top = (msg.instructions || []).map((ix) => {
    const p = ix.programId?.toBase58?.() || ix.programId;
    const kind = ix.parsed?.type || ix.program || "";
    return `${p.slice(0, 6)}${kind ? `(${kind})` : ""}`;
  });
  console.log(`    top-level programs: ${top.join(", ")}`);
  const inner = (tx.meta?.innerInstructions || []).flatMap((g) => g.instructions);
  const innerKinds = new Map();
  for (const ix of inner) {
    const p = ix.programId?.toBase58?.() || ix.programId;
    const kind = ix.parsed?.type || ix.program || "raw";
    const key = `${p.slice(0, 6)}:${kind}`;
    innerKinds.set(key, (innerKinds.get(key) || 0) + 1);
  }
  console.log(`    inner instructions: ${inner.length} (${[...innerKinds.entries()].map(([k, v]) => `${k}x${v}`).join(", ") || "none"})`);

  // 2. lamport deltas
  const pre = tx.meta?.preBalances || [];
  const post = tx.meta?.postBalances || [];
  const deltas = accountKeys
    .map((key, i) => ({ key, delta: ((post[i] || 0) - (pre[i] || 0)) / 1e9, isCurve: key === curve }))
    .filter((x) => Math.abs(x.delta) > 1e-6)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  console.log("    lamport moves (SOL):");
  for (const d of deltas.slice(0, 8)) {
    console.log(`      ${d.key.slice(0, 8)}${d.isCurve ? " [BONDING CURVE]" : ""} ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(6)}`);
  }
  const curveDelta = deltas.find((d) => d.isCurve)?.delta ?? null;
  console.log(`    curve SOL change: ${curveDelta === null ? "curve not in this tx" : `${curveDelta >= 0 ? "+" : ""}${curveDelta.toFixed(6)} SOL`}`);
  console.log(
    `    payload sol_amount: ${item.solAmount.toFixed(6)} SOL -> ` +
      (curveDelta === null ? "n/a" : `curve moved ${(curveDelta / (item.solAmount || 1)).toFixed(2)}x the trade size`),
  );
}

console.log("\nHow to read this: the swap itself explains a curve change of about +-sol_amount.");
console.log("Anything beyond that is a second instruction touching the curve (fee collection, transfer,");
console.log("or a router moving SOL) and is exactly what the amount-based reconstruction cannot model.");
