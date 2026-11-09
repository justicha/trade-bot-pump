import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { CU_LIMIT, CU_PRICE } from "./config.mjs";
import { connection } from "./rpc.mjs";

export function computeBudgetIxs(cuPrice = CU_PRICE, cuLimit = CU_LIMIT) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
  ];
}

export async function buildVersionedTx(payer, instructions, addressLookupTables = []) {
  // Some public RPCs (e.g. publicnode) report a bogus lastValidBlockHeight (millions of
  // blocks behind), which makes confirmTransaction throw "block height exceeded" instantly.
  // Recompute a sane expiry from the current block height: a blockhash stays valid for
  // 150 slots, so `currentHeight + 150` is the correct upper bound. Fetch both in parallel
  // so the extra call does not add a full extra round-trip of latency.
  const [{ blockhash }, currentHeight] = await Promise.all([
    connection.getLatestBlockhash("confirmed"),
    connection.getBlockHeight("confirmed"),
  ]);
  const lastValidBlockHeight = currentHeight + 150;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTables);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  // Attach the expiry window that belongs to THIS blockhash so sendTxWithRetry can confirm
  // against the correct window. (A blockhash fetched after sending belongs to a different,
  // later window — confirming with it made expired txs wait for the wrong expiry.)
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}
