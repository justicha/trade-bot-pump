#!/usr/bin/env node
// C6-VERIFY (READ-ONLY): confirm the on-chain semantics of pump.fun buy(amount, max_sol_cost) via
// simulateTransaction. NOTHING is sent on-chain. Run with your own RPC_URL and wallet:
//
//   node scripts/verify-buy-semantics.mjs [<mint base58>]
//
// Cases (per the official IDL, `amount` = TOKEN amount, `max_sol_cost` = SOL lamports cap):
//   A: amount = minTokens, maxSolCost = BUY_SOL      -> expect err null (pass)
//   B: amount = minTokens, maxSolCost = 1 lamport    -> expect Custom 6002 "TooMuchSolRequired"
//   C: amount = 1 raw token, maxSolCost = 1 SOL      -> expect err null (a tiny buy)
//
// If case (B) returns 6002, the program priced `amount` AS TOKENS and compared it against
// max_sol_cost — which is the premise the bots' instruction layout relies on (and which
// BUGS_VERIFICATION #08 must be re-verified against before any change to the buy instruction).
//
// This script only READS and SIMULATES; it never signs a broadcast or sends a transaction.
import { PublicKey, Transaction } from "@solana/web3.js";
import { connection } from "../lib/rpc.mjs";
import { loadKeypair } from "../lib/wallet.mjs";
import { SLIPPAGE_BPS } from "../lib/config.mjs";
import { buyIx, calcBuyTokens, getBondingCurveState, refreshGlobalFeeState, userAtaIx } from "../lib/pumpfun.mjs";

// Known recent near-graduation mints; any still on the curve works for the semantic check.
const FALLBACK_MINTS = [
  "5pafBTgyVrHSB2ya1yedhS82mXwVKxN1gkZwNSC3pump",
  "9uiSYNy1qXgZ1H4zDfCJERW2TjJAJjhb28KmePmzpump",
  "4yQp6f3W9nEMMJTHajkTCWEMR6r4akAPZs9qaEiMpump",
  "3JXbxzC9VyBTrZc2eeuWEU12Ly5T1w7mqtmA3Trypump",
];

const BUY_SOL = 0.02;

async function simulate(user, mint, state, amount, maxSolCost) {
  const tx = new Transaction().add(
    userAtaIx(user.publicKey, mint),
    buyIx(user.publicKey, mint, BUY_SOL, amount, {
      creator: new PublicKey(state.creator),
      isMayhem: !!state.isMayhemMode,
      maxSolCost,
    }),
  );
  tx.feePayer = user.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return connection.simulateTransaction(tx, [user]);
}

async function main() {
  await refreshGlobalFeeState().catch((e) => console.warn("[fee-state]", e.message));
  const user = loadKeypair();
  const candidates = process.argv[2] ? [process.argv[2]] : FALLBACK_MINTS;

  for (const m of candidates) {
    const mint = new PublicKey(m);
    const state = await getBondingCurveState(mint, 0);
    if (!state) continue;
    if (state.complete) {
      console.log(`mint ${m.slice(0, 12)}: already graduated, skipping`);
      continue;
    }
    const minTokens = (calcBuyTokens(state, BUY_SOL) * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    console.log(`\nmint ${m.slice(0, 12)} creator=${state.creator} minTokens=${minTokens}`);

    const cases = [
      ["A", minTokens, BigInt(Math.round(BUY_SOL * 1e9))],
      ["B", minTokens, 1n],
      ["C", 1n, BigInt(Math.round(1 * 1e9))],
    ];
    for (const [label, amount, cap] of cases) {
      try {
        const sim = await simulate(user, mint, state, amount, cap);
        const err = sim.value?.err;
        const custom = err?.InstructionError?.[1]?.Custom;
        console.log(`  case ${label}: amount=${amount} maxSolCost=${cap} -> err=${JSON.stringify(err)}${custom !== undefined ? ` (Custom ${custom})` : ""}`);
        for (const l of (sim.value?.logs || []).filter((x) => /Error Code|AnchorError|TooMuchSolRequired|TooLittleSolReceived/.test(x))) {
          console.log("    |", l.replace("Program log: ", "").trim());
        }
      } catch (e) {
        console.log(`  case ${label}: simulate threw ${e.message}`);
      }
    }
    return;
  }
  console.log("no candidate mint is still on the bonding curve; pass a mint explicitly");
  process.exit(1);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
