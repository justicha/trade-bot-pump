#!/usr/bin/env node
// Read-only: wait for the next pump.fun token-creation transaction and dump its raw
// logs + event prefixes. Detection: the tx initializes a token mint (InitializeMint).
// Usage: node scripts/capture-create.mjs
// It only subscribes to logs via your RPC. Never signs or sends anything.
import { PUMP_PROGRAM } from "../lib/constants.mjs";
import { SolanaWs } from "../lib/ws.mjs";

const ws = new SolanaWs();
await ws.connect();
console.log("Waiting for a token creation (contains InitializeMint)... Ctrl+C to stop.\n");

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  const logs = value.logs;
  const hasMintInit = logs.some((l) => /Instruction: InitializeMint/.test(l));
  if (!hasMintInit) return;

  console.log("=== CREATE CANDIDATE ===");
  console.log("signature:", value.signature);
  console.log("--- event prefixes (Program data) ---");
  for (const l of logs) {
    if (l.startsWith("Program data: ")) {
      const buf = Buffer.from(l.slice("Program data: ".length), "base64");
      console.log("  prefix:", buf.subarray(0, 8).toString("hex"), "len", buf.length);
    }
  }
  console.log("--- raw logs ---");
  for (const l of logs) console.log(l);

  ws.close();
  process.exit(0);
});
