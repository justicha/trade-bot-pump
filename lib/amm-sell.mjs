// One PumpSwap (AMM) sell attempt: gate -> quote -> build -> simulate -> JOURNAL -> send.
//
// The order is the point (AUDIT_SELL.md §5). The old path journaled only the error text of a failed
// simulation — never the program logs, which is where "Custom 6005 / account not found" lives — and
// wrote nothing at all when the simulation passed. Now the expected SOL out and the full logs are
// recorded BEFORE the transaction is sent, so a sell is explainable from the journal alone.
//
// DRY_SELL=yes builds and simulates the live sell path and journals it, but never calls
// sendTransaction. It is NOT the bot's --dry-run: it exists to prove the live AMM path without
// spending SOL.
//
// Everything that touches the network is injected (`deps`), so `npm test` can drive this whole
// function with a fake connection: no network, no sendTransaction.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { WSOL } from "./constants.mjs";
import { TOKEN_PROGRAM, ammSellIx } from "./pumpswap-sell.mjs";
import { ammSellQuote } from "./pumpswap.mjs";
import { describeTxError } from "./pump-errors.mjs";
import { simulateTx } from "./exec.mjs";
import { sendTxWithRetry } from "./rpc.mjs";
import { buildVersionedTx, computeBudgetIxs } from "./tx.mjs";

// DRY_SELL is an explicit, separate switch: "yes"/"1"/"true" only. It can only ever REMOVE a send,
// never add one, so a typo cannot make the bot trade.
export function isDrySell(env = process.env) {
  return /^(1|yes|true)$/i.test(String(env.DRY_SELL ?? "").trim());
}

// The venue depends on chain state only: a curve that is not complete sells on the curve, a
// completed (or vanished) curve on PumpSwap. Kept as a function so the rule has one home and a test.
export function chooseSellVenue(state) {
  return state && !state.complete ? "curve" : "pumpswap";
}

// Result statuses:
//   gate      — LIVE and LIVE_CONFIRM_AMM !== "yes": nothing built, position must be kept
//   no_pool   — the canonical pool is missing / unreadable: nothing built, position must be kept
//   sim_fail  — the simulation failed: nothing sent, `why` + `sim.logs` are in the journal
//   dry       — DRY_SELL=yes: built + simulated + journaled, NOT sent
//   sent      — sent and confirmed; `sig` is set (send errors are thrown to the caller, which keeps
//               its "maybe it landed" reconciliation path via err.sig)
export async function ammSellOnce({
  connection,
  wallet,
  mint,
  mintPk,
  total,
  attempt,
  slip,
  live,
  confirmAmm,
  drySell = false,
  journal,
  log = () => {},
  meta = {},
  deps = {},
}) {
  const D = { ammSellQuote, buildVersionedTx, simulateTx, sendTxWithRetry, ...deps };
  const base = {
    sessionId: meta.sessionId,
    paramsHash: meta.paramsHash,
    gitSha: meta.gitSha,
    mint,
    venue: "pumpswap",
    attempt,
    maxAttempts: meta.maxAttempts ?? null,
    slippageBps: slip,
    tokens: total.toString(),
  };
  const write = (record) => {
    if (!journal) return;
    journal.write({ ...base, ...record });
  };

  // Gate FIRST (unchanged, deliberately before any quote): without LIVE_CONFIRM_AMM=yes nothing is
  // even priced. The caller keeps the position instead of dropping it at attempts=0.
  if (live && confirmAmm !== "yes") {
    return { status: "gate", reason: "PumpSwap sell UNVERIFIED (set LIVE_CONFIRM_AMM=yes to try)" };
  }

  // TODO(verify) V3/V4: canonicalPool() and the quote maths are transcribed from the IDL; neither
  // has been checked against a real graduated pump mint.
  const q = await D.ammSellQuote(connection, mintPk, total);
  if (!q) return { status: "no_pool", reason: "no venue (curve complete, no canonical pool)" };

  const quote = q.solOut; // net lamports after lp+protocol+creator fees
  const minOut = (quote * BigInt(10000 - slip)) / 10000n;
  const userWsol = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM);
  const ixs = [
    ...computeBudgetIxs(),
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM),
    ammSellIx(wallet.publicKey, mintPk, q.pool, q.p, q.g, total, minOut),
    createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM),
  ];

  const tx = await D.buildVersionedTx(wallet, ixs);
  const sim = await D.simulateTx(tx);
  const quoteOut = Number(quote) / 1e9;
  const quoteRecord = { quoteOut, expectedSol: quoteOut, minOut: minOut.toString(), feeBps: q.feeBps ?? null };

  if (!sim.ok) {
    const why = describeTxError(sim.err);
    // FULL dump: err, every program log line, CU consumed. This is what makes V1/V2 checkable.
    write({
      type: "sell_attempt",
      simulationResult: "fail",
      error: why,
      errorRaw: sim.err ?? null,
      logs: sim.logs ?? [],
      unitsConsumed: sim.units ?? null,
      sent: false,
      ...quoteRecord,
    });
    log(
      `  sell simulation failed (pumpswap): ${why} — not sending (${(sim.logs ?? []).length} log lines journaled)`,
    );
    return { status: "sim_fail", why, sim, quote, amountRaw: total };
  }

  // Simulation passed -> record the EXPECTATION before the send. If the send then lands badly, the
  // journal shows what was expected next to what happened.
  write({
    type: "sell_sim",
    simulationResult: "ok",
    unitsConsumed: sim.units ?? null,
    logs: sim.logs ?? [],
    sent: false,
    ...quoteRecord,
  });
  log(
    `  sell simulation ok (pumpswap): expect ${quoteOut.toFixed(6)} SOL, min ${(Number(minOut) / 1e9).toFixed(6)}, ${sim.units ?? "?"} CU`,
  );

  if (drySell) {
    write({ type: "sell_dry", sent: false, reason: "DRY_SELL=yes" });
    log(`  DRY_SELL=yes: NOT sending (would sell ${total.toString()} tokens on pumpswap); position kept`);
    return { status: "dry", quote, amountRaw: total, sim };
  }

  // Send errors are thrown on purpose: the caller's catch resolves err.sig against the chain and
  // records a sale that landed despite a confirm error (see sellPosition).
  const sig = await D.sendTxWithRetry(tx, { skipPreflight: true });
  return { status: "sent", sig, quote, amountRaw: total, sim };
}
