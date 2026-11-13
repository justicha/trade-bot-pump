#!/usr/bin/env node
// probe-sell-sim: SIMULATE one PumpSwap sell and print everything the simulation says.
//
// Purpose: close TODO(verify) V1/V2 — is the 21-account `sell` layout accepted by the deployed
// program, are the volume-accumulator accounts required. It answers those questions WITHOUT
// sending a transaction. (V4, the quote maths and the fee split, is closed: lib/pumpswap.mjs
// ammSellQuote reproduces real SellEvents to the lamport — scripts/amm-fee.test.mjs.)
//
// The quote and the transaction are the bots' own (ammSellQuote + lib/amm-sell.mjs ammSellTxIxs,
// AMM_SELL_CU_LIMIT), so what is simulated here is what a live AMM sale would send:
//
//   node scripts/probe-sell-sim.mjs --mint <mint> [--tokens <raw>] [--slip <bps>]
//
// It has NO --live flag, never calls sendTransaction, and never signs anything that leaves the
// process. The wallet is only needed to derive ATAs and to price the sell for the real owner.
//
// Output: err + full logs + unitsConsumed on the console AND in data/probe/sell-sim-<mint>-<ts>.json
// so the result can be sent back without transcription errors.
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AMM_SELL_CU_LIMIT, ROOT, numOr } from "../lib/config.mjs";
import { TOKEN_2022_PROGRAM } from "../lib/constants.mjs";
import { connection } from "../lib/rpc.mjs";
import { getBondingCurveState } from "../lib/pumpfun.mjs";
import { describeTxError } from "../lib/pump-errors.mjs";
import { buildVersionedTx } from "../lib/tx.mjs";
import { loadKeypair } from "../lib/wallet.mjs";
import { canonicalPool, decodePool } from "../lib/pumpswap-sell.mjs";
import { ammSellQuote } from "../lib/pumpswap.mjs";
import { ammSellTxIxs } from "../lib/amm-sell.mjs";

const DEFAULTS = [
  "322es1iMfEghyuqi6Hby3eLkMsbfAKBCacmiZqG8pump",
  "48e5BtneVunFTZDo96TvEPsG3YquCSizMoowUaTZpump",
  "HbZM3fVa7XWGbLPzvdZykDX1mtjPJw9UUE8fVg3Wpump",
];

const args = process.argv.slice(2);
if (args.includes("--live") || args.includes("--send")) {
  console.error("[probe] this script only SIMULATES; it has no --live / --send option.");
  process.exit(2);
}
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const mintStr = argOf("--mint");
if (!mintStr) {
  console.error("[probe] usage: node scripts/probe-sell-sim.mjs --mint <mint> [--tokens <raw>] [--slip <bps>]");
  console.error(`[probe] mints from the STUCK list: ${DEFAULTS.join(", ")}`);
  process.exit(2);
}
const slip = numOr(argOf("--slip") ?? process.env.SELL_SLIPPAGE_BPS, 1000, "SELL_SLIPPAGE_BPS");
const mintPk = new PublicKey(mintStr);
const wallet = loadKeypair();

const say = (s = "") => console.log(s);

say(`[probe] SIMULATION ONLY — no transaction is sent. wallet ${wallet.publicKey.toBase58().slice(0, 8)}…`);
say(`[probe] mint ${mintStr}, slippage ${slip} bps`);

// --- amount: the wallet's real balance unless --tokens is given ---
const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, TOKEN_2022_PROGRAM);
let total = argOf("--tokens") ? BigInt(argOf("--tokens")) : 0n;
if (total === 0n) {
  try {
    const info = await connection.getTokenAccountBalance(ata);
    total = BigInt(info.value.amount);
  } catch (e) {
    say(`[probe] cannot read the base ATA ${ata.toBase58()}: ${e.message}`);
    say("[probe] pass --tokens <raw amount> to simulate a sell you do not hold yet.");
    process.exit(1);
  }
}
if (total === 0n) {
  say(`[probe] base ATA ${ata.toBase58()} is empty — nothing to simulate (use --tokens).`);
  process.exit(1);
}
say(`[probe] sell amount: ${total.toString()} raw tokens`);

// --- curve state (context only: a complete curve is what sends us to PumpSwap) ---
const state = await getBondingCurveState(mintPk, 0).catch(() => null);
say(`[probe] bonding curve: ${!state ? "gone" : state.complete ? "COMPLETE (PumpSwap venue)" : "still trading"}`);

// --- pool lookup: this is V3 (canonicalPool) ---
const pool = canonicalPool(mintPk);
say(`[probe] canonical pool PDA: ${pool.toBase58()}`);
const pi = await connection.getAccountInfo(pool).catch((e) => ({ error: e.message }));
if (!pi || pi.error || !pi.data) {
  say(`[probe] NO pool account at that address (${pi?.error ?? "null"}) -> V3 FAILED or the mint never migrated.`);
  say("[probe] stop here: a sell cannot be built without PoolState.");
  process.exit(1);
}
if (pi.data.length < 287) {
  say(`[probe] pool account is ${pi.data.length} bytes, expected >= 287 -> layout mismatch (V1).`);
  process.exit(1);
}
const p = decodePool(pi.data);
say(`[probe] pool owner=${pi.owner.toBase58()} base=${p.baseMint.toBase58()} quote=${p.quoteMint.toBase58()}`);
say(`[probe] isMayhem=${p.isMayhem} isCashback=${p.isCashback} creator=${p.coinCreator.toBase58()} creatorFeeBps=${p.creatorFeeBps}`);

// --- quote + transaction: the bots' own (lib/pumpswap.mjs ammSellQuote, lib/amm-sell.mjs) ---
// The fee is the pool's REAL one: the fee program's tier of the pool's market cap (FeeConfig), not
// the 30 bps of GlobalConfig. feeSource "fallback" = FeeConfig or the mint supply was unreadable,
// so the most expensive tier (125 bps) is assumed.
const q = await ammSellQuote(connection, mintPk, total).catch(() => null);
if (!q) {
  say("[probe] pool or its vaults unreadable -> cannot price the sell.");
  process.exit(1);
}
if (!q.g.protocolFeeRecipients.length) say("[probe] global config unreadable — no fee recipients, the sell cannot be built.");
const { baseReserve, quoteReserve, grossOut, feeBps, feeSource, fees } = q;
const quote = q.solOut;
const { ixs, minOut, sellIx } = ammSellTxIxs(wallet, mintPk, q, total, slip);
say(`[probe] reserves: base ${baseReserve} quote ${quoteReserve} virtualQuote ${q.p.virtualQuoteReserves}`);
say(
  `[probe] quote: gross ${grossOut} lamports, fee ${feeBps} bps (${feeSource}: lp ${fees.lpFeeBps} + protocol ${fees.protocolFeeBps} + creator ${fees.creatorFeeBps}` +
    `${q.marketCapLamports == null ? "" : `, market cap ${q.marketCapLamports} lamports`}), net ${quote}, min_out ${minOut}`,
);

const tx = await buildVersionedTx(wallet, ixs);
say(`[probe] transaction built: ${ixs.length} instructions, CU limit ${AMM_SELL_CU_LIMIT}, sell ix has ${sellIx.keys.length} accounts`);

// --- the actual simulation: read-only, nothing is sent ---
const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }).catch((e) => ({
  value: { err: { rpc: e.message }, logs: [], unitsConsumed: null },
}));
const err = sim.value.err ?? null;
const logs = sim.value.logs ?? [];
const units = sim.value.unitsConsumed ?? null;

say("");
say(`[probe] SIMULATION RESULT: ${err ? "FAIL" : "OK"}`);
if (err) say(`[probe] err: ${JSON.stringify(err)}`);
say(`[probe] describeTxError: ${err ? describeTxError(err) : "—"}`);
say(`[probe] unitsConsumed: ${units ?? "?"}`);
say(`[probe] ${logs.length} log lines:`);
for (const line of logs) say(`    ${line}`);

const dir = path.join(ROOT, "data", "probe");
const file = path.join(dir, `sell-sim-${mintStr.slice(0, 8)}-${Date.now()}.json`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  file,
  JSON.stringify(
    {
      ts: new Date().toISOString(),
      mode: "simulate-only",
      mint: mintStr,
      owner: wallet.publicKey.toBase58(),
      tokens: total.toString(),
      slipBps: slip,
      pool: pool.toBase58(),
      poolState: {
        baseVault: p.baseVault.toBase58(),
        quoteVault: p.quoteVault.toBase58(),
        coinCreator: p.coinCreator.toBase58(),
        isMayhem: p.isMayhem,
        isCashback: p.isCashback,
        creatorFeeBps: Number(p.creatorFeeBps),
      },
      reserves: { base: baseReserve.toString(), quote: quoteReserve.toString(), virtualQuote: q.p.virtualQuoteReserves.toString() },
      quote: {
        grossOut: grossOut.toString(),
        feeBps,
        feeSource,
        fees: { lpFeeBps: fees.lpFeeBps, protocolFeeBps: fees.protocolFeeBps, creatorFeeBps: fees.creatorFeeBps },
        marketCapLamports: q.marketCapLamports == null ? null : q.marketCapLamports.toString(),
        netLamports: quote.toString(),
        minOutLamports: minOut.toString(),
      },
      cuLimit: AMM_SELL_CU_LIMIT,
      accounts: sellIx.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      err,
      describe: err ? describeTxError(err) : null,
      unitsConsumed: units,
      logs,
    },
    null,
    2,
  ),
);
say("");
say(`[probe] written to ${file}`);
say("[probe] NOTHING WAS SENT. Paste this file (or the log block above) back to close V1/V2.");
