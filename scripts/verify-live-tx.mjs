#!/usr/bin/env node
// Dry verification of the LIVE buy instruction against mainnet — nothing is sent on-chain.
// Simulates [createAssociatedTokenAccountIdempotent, buy] and prints the program's verdict, so a
// broken discriminator/account layout is caught long before a real transaction is attempted.
//
// Usage:
//   node scripts/verify-live-tx.mjs                 # first still-on-curve mint from the list below
//   node scripts/verify-live-tx.mjs <mint base58>   # a specific token
//
// Exit code 0 = simulation reached a business result (err null or a non-layout error);
// exit code 1 = could not verify (no mint on the curve / RPC failure).
import { PublicKey, Transaction } from "@solana/web3.js";
import { connection } from "../lib/rpc.mjs";
import { loadKeypair } from "../lib/wallet.mjs";
import { SLIPPAGE_BPS } from "../lib/config.mjs";
import {
  buyIx,
  calcBuyTokens,
  getBondingCurveState,
  refreshGlobalFeeState,
  userAtaIx,
} from "../lib/pumpfun.mjs";

// Known recent near-graduation mints; any still on the curve works for a layout check.
const FALLBACK_MINTS = [
  "5pafBTgyVrHSB2ya1yedhS82mXwVKxN1gkZwNSC3pump",
  "9uiSYNy1qXgZ1H4zDfCJERW2TjJAJjhb28KmePmzpump",
  "4yQp6f3W9nEMMJTHajkTCWEMR6r4akAPZs9qaEiMpump",
  "3JXbxzC9VyBTrZc2eeuWEU12Ly5T1w7mqtmA3Trypump",
];

// Anchor framework error codes that mean the instruction itself is malformed (not a business rule).
const LAYOUT_ERRORS = {
  100: "InstructionMissing",
  101: "InstructionFallbackNotFound (wrong discriminator)",
  102: "InstructionDidNotDeserialize (args mismatch)",
  3005: "AccountNotEnoughKeys (missing account)",
  3012: "AccountNotInitialized",
};

async function main() {
  const fee = await refreshGlobalFeeState();
  console.log("global.fee_recipient :", fee.feeRecipient.toBase58());
  console.log("reserved_fee_recipient:", fee.reservedFeeRecipient.toBase58());
  console.log("buyback recipients   :", fee.buybackFeeRecipients.map((p) => p.toBase58().slice(0, 8)).join(", "));

  const wallet = loadKeypair();
  const candidates = process.argv[2] ? [process.argv[2]] : FALLBACK_MINTS;

  for (const m of candidates) {
    const mint = new PublicKey(m);
    const state = await getBondingCurveState(mint, 0);
    if (!state) continue;
    if (state.complete) {
      console.log(`mint ${m.slice(0, 12)}: already graduated, skipping`);
      continue;
    }
    const fillPct = (Number(state.virtualSolReserves) / 85e9) * 100;
    console.log(`\nmint ${m.slice(0, 12)}: fill=${fillPct.toFixed(1)}% creator=${state.creator}`);

    const sol = 0.02;
    const minTokens = (calcBuyTokens(state, sol) * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
    const tx = new Transaction().add(
      userAtaIx(wallet.publicKey, mint),
      buyIx(wallet.publicKey, mint, sol, minTokens, {
        creator: new PublicKey(state.creator),
        isMayhem: !!state.isMayhemMode,
      }),
    );
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    const sim = await connection.simulateTransaction(tx, [wallet]);
    const custom = sim.value.err?.InstructionError?.[1]?.Custom;
    console.log("  buy simulation err:", JSON.stringify(sim.value.err));
    if (custom !== undefined && LAYOUT_ERRORS[custom]) {
      console.log("  >>> LAYOUT PROBLEM:", LAYOUT_ERRORS[custom]);
    }
    for (const l of (sim.value.logs || []).filter((x) => x.includes("Error Code") || x.includes("AnchorError"))) {
      console.log("  |", l.replace("Program log: ", "").trim());
    }
    return;
  }
  console.log("no mint from the candidate list is still on the bonding curve; pass a mint explicitly");
  process.exit(1);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
