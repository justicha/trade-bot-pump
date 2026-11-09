#!/usr/bin/env node
// Read-only diagnostic: dump one transaction's fee payer, instructions and logs.
// Usage: node scripts/dump-tx.mjs <SIGNATURE>
// Only calls getTransaction on your configured RPC. Never signs or sends anything.
import bs58 from "bs58";
import { connection } from "../lib/rpc.mjs";

const sig = process.argv[2];
if (!sig) {
  console.error("Usage: node scripts/dump-tx.mjs <SIGNATURE>");
  process.exit(1);
}

const tx = await connection.getTransaction(sig, {
  maxSupportedTransactionVersion: 1,
  commitment: "confirmed",
});
if (!tx || !tx.transaction) {
  console.error("Transaction not found (or your RPC does not have it).");
  process.exit(1);
}

const msg = tx.transaction.message;
// Supports both legacy Message and versioned MessageV0 (staticAccountKeys/compiledInstructions).
const rawKeys = msg.staticAccountKeys || msg.accountKeys || [];
const keys = rawKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
const signers = rawKeys.filter((k) => k && k.signer).map((k) => k.pubkey);

console.log("feePayer (key0):", keys[0]);
console.log("signers:", signers.length ? signers : "(versioned tx: signers = first signed staticAccountKeys)");

console.log("\n=== instructions ===");
const ixs = msg.compiledInstructions || msg.instructions || [];
for (const ix of ixs) {
  const pid = ix.programId || keys[ix.programIdIndex];
  let buf = Buffer.alloc(0);
  if (ix.data instanceof Uint8Array) buf = Buffer.from(ix.data);
  else if (typeof ix.data === "string") {
    try { buf = Buffer.from(bs58.decode(ix.data)); } catch { buf = Buffer.from(ix.data, "base64"); }
  }
  console.log(`- program: ${pid} | data hex: ${buf.subarray(0, 16).toString("hex")} | len: ${buf.length}`);
  const idx = ix.accountKeyIndexes || ix.accounts;
  if (Array.isArray(idx)) console.log("  accounts:", idx.map((i) => keys[i]).join(","));
}

console.log("\n=== event prefixes in logs (first 8 bytes of each 'Program data:') ===");
for (const line of tx.meta?.logMessages || []) {
  const tag = "Program data: ";
  if (!line.startsWith(tag)) continue;
  try {
    const buf = Buffer.from(line.slice(tag.length), "base64");
    console.log("  ", buf.subarray(0, 8).toString("hex"), "len", buf.length);
  } catch {}
}

console.log("\n=== logs ===");
for (const line of tx.meta?.logMessages || []) console.log(line);
