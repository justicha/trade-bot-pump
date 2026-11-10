// sell-all: exit every token the wallet holds — one simulation before every send, sequentially.
//
// The venue is decided exactly like the bots do it (chooseSellVenue): a bonding curve that is not
// complete sells on the curve, a migrated/gone curve goes to PumpSwap, anything else has no
// sellable venue. Nothing here is new sell logic: the parts, the instruction and the PumpSwap
// attempt all come from lib/sell-plan.mjs, lib/pumpfun.mjs and lib/amm-sell.mjs.
//
// Gates (unchanged, they are the caller's responsibility to pass correctly):
//   * live=false -> plan only, nothing is signed or sent;
//   * a PumpSwap (pool) sell is skipped unless confirmAmm === "yes" — that layout is still
//     unverified on-chain (AUDIT_SELL.md V7);
//   * every sell is simulated first; a failed simulation is never sent and the run continues;
//   * sends are sequential and a failed token is never retried automatically.
//
// Every decision is journaled: sell_all_plan, sell_all_sent, sell_all_skipped, sell_all_failed.
// All network/chain functions are injectable so `npm test` can drive this with fakes.
import { PublicKey } from "@solana/web3.js";
import { WSOL } from "./constants.mjs";
import { getBondingCurveState, sellIx } from "./pumpfun.mjs";
import { planSellParts } from "./sell-plan.mjs";
import { buildVersionedTx, computeBudgetIxs } from "./tx.mjs";
import { readExecution, simulateTx } from "./exec.mjs";
import { sendTxWithRetry } from "./rpc.mjs";
import { describeTxError } from "./pump-errors.mjs";
import { ammSellOnce, chooseSellVenue } from "./amm-sell.mjs";
import { ammSellQuote } from "./pumpswap.mjs";
import { TOKEN_PROGRAM } from "./pumpswap-sell.mjs";
import { TOKEN_2022_PROGRAM } from "./constants.mjs";

const sol = (lamports) => (Number(lamports) / 1e9).toFixed(6);

// web3.js returns token-account data either as a Buffer (encoding "base64" is applied for you) or
// as the [base64, "base64"] tuple, depending on the client version and the RPC. Both are accepted.
function tokenAccountBytes(acc) {
  const raw = acc?.account?.data;
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (Array.isArray(raw) && typeof raw[0] === "string") return Buffer.from(raw[0], "base64");
  if (typeof raw === "string") return Buffer.from(raw, "base64");
  throw new Error(`unexpected token account data shape: ${Object.prototype.toString.call(raw)}`);
}

// Token accounts of the wallet, both token programs. Zero balances are not positions.
export async function holdings(connection, owner) {
  const out = new Map();
  for (const programId of [TOKEN_2022_PROGRAM, TOKEN_PROGRAM]) {
    const res = await connection.getTokenAccountsByOwner(owner, { programId }, { encoding: "base64" });
    for (const acc of res.value) {
      const d = tokenAccountBytes(acc);
      const mint = new PublicKey(d.subarray(0, 32)).toBase58();
      const amount = d.readBigUInt64LE(64);
      if (amount > 0n && !out.has(mint)) out.set(mint, { mint, raw: amount });
    }
  }
  return [...out.values()];
}

// Venue + price for one token. Side-effect free; null price means "not priced".
async function describeVenue(deps, connection, mintPk, raw) {
  const state = await deps.getBondingCurveState(mintPk, 0, 3).catch(() => null);
  if (chooseSellVenue(state) === "curve") {
    const plan = deps.planSellParts(state, raw, { capRatio: 0.95, minPartRaw: 1_000_000n });
    if (plan.parts.length === 0) return { venue: "none", reason: `curve cannot pay (${plan.reason})` };
    if (!state.creator) return { venue: "none", reason: "creator unknown (cannot build the sell)" };
    const expectedLamports = plan.parts.reduce((acc, part) => acc + part.quoteOut, 0n);
    return { venue: "curve", state, plan, expectedLamports };
  }
  const quote = await deps.ammSellQuote(connection, mintPk, raw).catch(() => null);
  if (!quote) return { venue: "none", reason: "no canonical pool" };
  return { venue: "pool", quote, expectedLamports: quote.solOut };
}

/**
 * One pass over the wallet: plan every token, then (live only) sell the sellable ones.
 * Returns { sold, skipped, failed, results }.
 */
export async function runSellAll({
  connection,
  wallet,
  journal,
  log = () => {},
  live,
  confirmAmm,
  slip = 1000,
  session = {},
  deps = {},
}) {
  const D = {
    getBondingCurveState,
    planSellParts,
    ammSellQuote,
    ammSellOnce,
    sellIx,
    computeBudgetIxs,
    buildVersionedTx,
    simulateTx,
    sendTxWithRetry,
    readExecution,
    describeTxError,
    ...deps,
  };
  const base = { sessionId: session.sessionId, paramsHash: session.paramsHash, gitSha: session.gitSha };
  const meta = { ...base, maxAttempts: 1 };
  const write = (record) => {
    if (!journal) return;
    journal.write({ ...base, ...record });
  };

  const all = await holdings(connection, wallet.publicKey);
  const targets = [];
  for (const h of all) {
    if (h.mint === WSOL.toBase58()) {
      log("[sell-all] skipping WSOL: quote mint, not a position");
      continue;
    }
    targets.push(h);
  }
  log(`[sell-all] holdings: ${targets.length}${targets.length ? "" : " (nothing to sell)"}`);
  log("");
  log("mint".padEnd(46) + "balance".padStart(18) + "  " + "venue".padEnd(6) + "expected SOL".padStart(15) + "  status");
  log("-".repeat(110));

  let sold = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  for (const h of targets) {
    const mintPk = new PublicKey(h.mint);
    const d = await describeVenue(D, connection, mintPk, h.raw);
    // A pool sell needs its own confirmation: nothing is sent on an unverified AMM layout.
    const blocked =
      d.venue === "none" ? "no sellable venue" : d.venue === "pool" && confirmAmm !== "yes" ? "PumpSwap sell unverified" : null;
    const expected = d.expectedLamports == null ? "n/a" : sol(d.expectedLamports);

    log(
      h.mint.padEnd(46) +
        (Number(h.raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }).padStart(18) +
        "  " +
        d.venue.padEnd(6) +
        expected.padStart(15) +
        "  " +
        (blocked ? `blocked: ${blocked}` : "ready"),
    );

    write({
      type: "sell_all_plan",
      mint: h.mint,
      balanceRaw: h.raw.toString(),
      venue: d.venue,
      expectedSol: d.expectedLamports == null ? null : Number(d.expectedLamports) / 1e9,
      status: blocked ? "blocked" : "ready",
      reason: blocked ?? d.reason ?? null,
      live,
    });

    if (!live || blocked) {
      if (blocked) {
        skipped += 1;
        write({ type: "sell_all_skipped", mint: h.mint, venue: d.venue, reason: blocked });
      }
      continue;
    }

    try {
      if (d.venue === "curve") {
        // Multi-part curve exit: EVERY part is simulated, only an ok part is sent. One failed part
        // stops this token; the rest of the wallet is still processed.
        const parts = d.plan.parts;
        let received = 0n;
        let ok = true;
        for (let i = 0; i < parts.length && ok; i++) {
          const part = parts[i];
          const minSol = (part.quoteOut * BigInt(10000 - slip)) / 10000n;
          const ixs = [
            ...D.computeBudgetIxs(),
            D.sellIx(wallet.publicKey, mintPk, part.amountRaw, minSol, {
              creator: new PublicKey(d.state.creator),
              isMayhem: !!d.state.isMayhemMode,
            }),
          ];
          const tx = await D.buildVersionedTx(wallet, ixs);
          const sim = await D.simulateTx(tx);
          if (!sim.ok) {
            ok = false;
            const why = D.describeTxError(sim.err);
            log(`  part ${i + 1}/${parts.length} simulation failed: ${why} — not sending this token`);
            for (const line of sim.logs ?? []) log(`    ${line}`);
            write({
              type: "sell_all_failed", mint: h.mint, venue: "curve", part: i + 1, parts: parts.length,
              error: why, logs: sim.logs ?? [], unitsConsumed: sim.units ?? null, sent: false,
            });
            break;
          }
          const sig = await D.sendTxWithRetry(tx, { skipPreflight: true });
          const ex = await D.readExecution(sig, wallet.publicKey, mintPk).catch(() => ({ found: false }));
          const lamports = ex.found && ex.solReceivedSol > 0 ? BigInt(Math.round(ex.solReceivedSol * 1e9)) : part.quoteOut;
          received += lamports;
          write({
            type: "sell_all_sent", mint: h.mint, venue: "curve", sig, part: i + 1, parts: parts.length,
            amountRaw: part.amountRaw.toString(),
            expectedSol: Number(part.quoteOut) / 1e9,
            solReceived: Number(lamports) / 1e9,
          });
          log(`  part ${i + 1}/${parts.length} sold: ${sol(lamports)} SOL (sig ${String(sig).slice(0, 8)}…)`);
        }
        if (ok) {
          sold += 1;
          results.push({ mint: h.mint, venue: "curve", solReceived: Number(received) / 1e9 });
        } else {
          failed += 1;
        }
      } else {
        // PumpSwap: lib/amm-sell.mjs runs quote -> build -> simulate -> journal -> send.
        const r = await D.ammSellOnce({
          connection, wallet, mint: h.mint, mintPk, total: h.raw, attempt: 1, slip,
          live, confirmAmm, drySell: false, journal, log, meta,
        });
        if (r.status === "sent") {
          const ex = await D.readExecution(r.sig, wallet.publicKey, mintPk).catch(() => ({ found: false }));
          const lamports = ex.found && ex.solReceivedSol > 0 ? BigInt(Math.round(ex.solReceivedSol * 1e9)) : r.quote;
          sold += 1;
          results.push({ mint: h.mint, venue: "pool", solReceived: Number(lamports) / 1e9 });
          write({
            type: "sell_all_sent", mint: h.mint, venue: "pool", sig: r.sig,
            amountRaw: r.amountRaw.toString(),
            expectedSol: Number(r.quote) / 1e9,
            solReceived: Number(lamports) / 1e9,
          });
          log(`  sold: ${sol(lamports)} SOL (sig ${String(r.sig).slice(0, 8)}…)`);
        } else {
          failed += 1;
          const why = r.status === "sim_fail" ? r.why : (r.reason ?? r.status);
          for (const line of r.sim?.logs ?? []) log(`    ${line}`);
          write({
            type: "sell_all_failed", mint: h.mint, venue: "pool",
            error: why, logs: r.sim?.logs ?? [], unitsConsumed: r.sim?.units ?? null, sent: false,
          });
          log(`  not sent: ${why} — continuing with the next token`);
        }
      }
    } catch (e) {
      failed += 1;
      const why = D.describeTxError(e);
      write({ type: "sell_all_failed", mint: h.mint, venue: d.venue, error: why, sig: e.sig ?? null });
      log(`  failed: ${why} — continuing with the next token`);
    }
  }

  log("");
  log("-".repeat(110));
  for (const r of results) log(`  sold ${r.mint.slice(0, 12)}… on ${r.venue}: ${r.solReceived.toFixed(6)} SOL`);
  log(`[sell-all] sold: ${sold}, skipped: ${skipped}, failed: ${failed}${live ? "" : " — PLAN ONLY, nothing was sent"}`);
  return { sold, skipped, failed, results };
}
