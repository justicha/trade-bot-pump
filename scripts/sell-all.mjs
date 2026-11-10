#!/usr/bin/env node
// sell-all: exit every token the wallet holds — one simulation before every send, sequentially.
//
//   node scripts/sell-all.mjs                 # PLAN ONLY: print what an exit would do, send nothing
//   $env:LIVE_CONFIRM="yes"; node scripts/sell-all.mjs --live
//
// Venue logic, the plan and the sends live in lib/sell-all.mjs (reused by the tests with fakes);
// this file only parses the flags, enforces the gates and wires the real client.
//
// Gates:
//   * --live needs LIVE_CONFIRM=yes, otherwise the script exits before it builds an RPC client;
//   * a PumpSwap (pool) sell additionally needs LIVE_CONFIRM_AMM=yes — that layout is still
//     unverified on-chain (AUDIT_SELL.md V7), so without it the token is skipped, not sent;
//   * every sell is simulated first; a failed simulation is never sent and the run continues;
//   * sends are sequential and a failed token is never retried automatically.
//
// This script has no buy code. It never opens a position and never sends anything without --live.
const args = process.argv.slice(2);
const LIVE = args.includes("--live") && !args.includes("--dry-run");

// Gate BEFORE any import that builds the RPC client: --live alone must never be enough.
if (LIVE && process.env.LIVE_CONFIRM !== "yes") {
  console.error(
    '[sell-all] --live requires LIVE_CONFIRM=yes for this run, e.g. $env:LIVE_CONFIRM="yes"; node scripts/sell-all.mjs --live',
  );
  process.exit(1);
}

const { numOr } = await import("../lib/config.mjs"); // also enforces LIVE_CONFIRM (both agree)
const { connection } = await import("../lib/rpc.mjs");
const { TradeJournal } = await import("../lib/journal.mjs");
const { newSessionId, paramsHash, gitSha } = await import("../lib/runmeta.mjs");
const { loadKeypair } = await import("../lib/wallet.mjs");
const { runSellAll } = await import("../lib/sell-all.mjs");

const CONFIRM_AMM = process.env.LIVE_CONFIRM_AMM === "yes";
const SLIP = numOr(process.env.SELL_SLIPPAGE_BPS, 1000, "SELL_SLIPPAGE_BPS"); // 10%: a sweep wants out
const wallet = loadKeypair();
const journal = new TradeJournal({ bot: "sell-all" });
const session = {
  sessionId: newSessionId("sellall"),
  paramsHash: paramsHash({ mode: LIVE ? "live" : "plan", confirmAmm: CONFIRM_AMM }),
  gitSha: gitSha(),
};

console.log(`[sell-all] ${LIVE ? "LIVE" : "PLAN ONLY"} | wallet ${wallet.publicKey.toBase58().slice(0, 8)}… | slippage ${SLIP} bps`);
if (LIVE) {
  console.log(`[sell-all] PumpSwap sells ${CONFIRM_AMM ? "enabled (LIVE_CONFIRM_AMM=yes)" : "SKIPPED (LIVE_CONFIRM_AMM not set)"}`);
}

await runSellAll({
  connection,
  wallet,
  journal,
  log: console.log,
  live: LIVE,
  confirmAmm: process.env.LIVE_CONFIRM_AMM,
  slip: SLIP,
  session,
});
