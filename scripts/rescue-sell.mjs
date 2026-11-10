#!/usr/bin/env node
// rescue-sell: salvage tokens the bot could not sell on the bonding curve.
//
// A position can outlive the curve: once the curve is complete (migrated to PumpSwap) or its
// real SOL reserves are drained (a curve sell then overflows with Custom 6024), the bot has no
// route. This tool finds the right venue and prices the exit.
//
// DRY-RUN by default: reads the chain and prints what an exit would yield.
// LIVE is read from lib/config.mjs: --live AND NOT --dry-run, with LIVE_CONFIRM=yes enforced there.
// --dry-run always wins over --live and never sends a transaction.
//
//   node scripts/rescue-sell.mjs                          # list every holding + expected exit
//   node scripts/rescue-sell.mjs --mint <mint>[,<mint>]   # explain specific mints
//   $env:LIVE_CONFIRM="yes"; node scripts/rescue-sell.mjs --live --mint <mint>
//
// The PumpSwap (AMM) sell layout is built from the official pump-amm IDL and is marked
// UNVERIFIED until one live rescue succeeds. Curve sells reuse the bots' instruction.
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { DRY_RUN, LIVE, numOr } from "../lib/config.mjs";
import { TOKEN_2022_PROGRAM, WSOL } from "../lib/constants.mjs";
import {
  AMM_GLOBAL_CONFIG,
  TOKEN_PROGRAM,
  ammSellIx,
  canonicalPool,
  decodeGlobalConfig,
  decodePool,
} from "../lib/pumpswap-sell.mjs";
import { connection, getSOLBalance, sendTxWithRetry } from "../lib/rpc.mjs";
import {
  calcSellSol,
  getBondingCurveState,
  refreshGlobalFeeState,
  sellIx,
} from "../lib/pumpfun.mjs";

import { planSellParts } from "../lib/sell-plan.mjs";
import { simulateTx } from "../lib/exec.mjs";
import { describeTxError } from "../lib/pump-errors.mjs";
import { buildVersionedTx, computeBudgetIxs } from "../lib/tx.mjs";
import { loadKeypair } from "../lib/wallet.mjs";

const args = process.argv.slice(2);
// Single source of truth: LIVE/DRY_RUN come from lib/config.mjs (--live AND NOT --dry-run,
// LIVE_CONFIRM=yes enforced there). A local `args.includes("--live")` used to let
// `--live --dry-run` send real sells while the banner printed DRY RUN.
const mintArg = (() => {
  const i = args.indexOf("--mint");
  return i >= 0 && args[i + 1] ? args[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
})();
const SLIP = numOr(process.env.SELL_SLIPPAGE_BPS, 1000, "SELL_SLIPPAGE_BPS"); // 10% — a rescue wants out

if (LIVE && mintArg.length === 0) {
  console.error("[rescue] --live requires an explicit --mint <mint> (no blind sweeping).");
  process.exit(1);
}

const wallet = loadKeypair();
await refreshGlobalFeeState().catch((e) => console.warn(`[fee-state] ${e.message}`));

// ---------- holdings ----------
// Prefer the token-account query; some public RPCs block it, so fall back to the wallet's
// recent transaction history (token balance deltas) — read-only, same data.
async function holdings() {
  const out = new Map();
  try {
    for (const pid of [TOKEN_2022_PROGRAM, TOKEN_PROGRAM]) {
      const r = await connection.getTokenAccountsByOwner(wallet.publicKey, { programId: pid }, { encoding: "base64" });
      for (const a of r.value) {
        const d = Buffer.from(a.account.data[0], "base64");
        const mint = new PublicKey(d.subarray(0, 32)).toBase58();
        const amt = d.readBigUInt64LE(64);
        if (amt > 0n) out.set(mint, { mint, raw: amt });
      }
    }
    return [...out.values()];
  } catch (e) {
    console.warn(`[rescue] token-account query blocked (${e.message.slice(0, 50)}); scanning recent txs`);
  }
  const sigs = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 100 });
  const W = wallet.publicKey.toBase58();
  for (const s of sigs) {
    let tx = null;
    try { tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); } catch { continue; }
    if (!tx) continue;
    for (const b of tx.meta?.postTokenBalances || []) {
      if (b.owner !== W) continue;
      const amt = BigInt(b.uiTokenAmount.amount);
      if (amt > 0n && !out.has(b.mint)) out.set(b.mint, { mint: b.mint, raw: amt });
    }
  }
  return [...out.values()];
}

// ---------- venues ----------

async function quoteVenue(mintStr, raw) {
  const mint = new PublicKey(mintStr);
  const state = await getBondingCurveState(mint, 0, 3);
  if (state && !state.complete) {
    // Same planner the bot uses: the curve can only pay out of its REAL reserves, so a full
    // position may need several parts (this is what made 100% sells fail with Custom 6024).
    const plan = planSellParts(state, raw, { capRatio: 0.95, minPartRaw: 1_000_000n });
    const totalOut = plan.parts.reduce((acc, p) => acc + p.quoteOut, 0n);
    const note =
      `fill=${(Number(state.virtualSolReserves) / 85e9 * 100).toFixed(1)}% mayhem=${state.isMayhemMode}` +
      `; rSol ${(Number(state.realSolReserves) / 1e9).toFixed(6)} SOL` +
      (plan.parts.length > 1 ? `; ${plan.parts.length} parts (rest ${(Number(plan.restRaw) / 1e6).toFixed(0)} tokens)` : "") +
      (plan.parts.length === 0 ? `; curve cannot pay (${plan.reason})` : "");
    return {
      venue: "curve",
      expectedSol: Number(totalOut) / 1e9,
      note,
      sellable: plan.parts.length > 0,
      state,
      plan,
    };
  }
  const curveNote = !state ? "curve gone" : state.complete ? "curve complete" : "curve drained (rSol=0)";
  const pool = canonicalPool(mint);
  const pi = await connection.getAccountInfo(pool);
  if (!pi || pi.data.length < 287) {
    return { venue: "none", expectedSol: null, note: `${curveNote}; no canonical pool`, sellable: false };
  }
  const p = decodePool(pi.data);
  const [bv, qv] = await Promise.all([
    connection.getTokenAccountBalance(p.baseVault).catch(() => null),
    connection.getTokenAccountBalance(p.quoteVault).catch(() => null),
  ]);
  if (!bv || !qv) return { venue: "pool", expectedSol: null, note: `${curveNote}; vaults unreadable`, sellable: false, pool, p };
  const baseReserve = BigInt(bv.value.amount);
  const quoteReserve = BigInt(qv.value.amount);
  const gross = quoteReserve + (p.virtualQuoteReserves > 0n ? p.virtualQuoteReserves : 0n);
  const out = (gross * raw) / (baseReserve + raw);
  // .catch like lib/pumpswap.mjs: an unreadable global config must degrade to the fallback fees,
  // not throw and kill the whole rescue cycle.
  const gc = await connection.getAccountInfo(AMM_GLOBAL_CONFIG).catch(() => null);
  const g = gc
    ? decodeGlobalConfig(gc.data)
    : { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipients: [], reservedFeeRecipient: null, reservedFeeRecipients: [], buybackFeeRecipients: [] };
  const feeBps = g.lpFeeBps + g.protocolFeeBps + (p.creatorFeeBps > 0n ? Number(p.creatorFeeBps) : g.coinCreatorFeeBps);
  const net = (out * BigInt(10000 - feeBps)) / 10000n;
  return {
    venue: "pool",
    expectedSol: Number(net) / 1e9,
    // Raw lamports of the quote: the min_out must be BigInt arithmetic on this, never
    // Math.floor(expectedSol * 1e9) (float rounding, AUDIT_SELL.md §4).
    expectedLamports: net,

    note: `${curveNote}; pool ${pool.toBase58().slice(0, 8)} fee≈${(feeBps / 100).toFixed(2)}%`,
    sellable: true,
    pool,
    p,
    g,
  };
}


// ---------- main ----------
console.log(`[rescue] ${DRY_RUN ? "DRY RUN" : "LIVE"} | wallet ${wallet.publicKey.toBase58().slice(0, 8)}… | slippage ${SLIP} bps`);
const startSol = LIVE ? await getSOLBalance(wallet.publicKey).catch(() => null) : null;

const all = await holdings();
const targets = mintArg.length ? all.filter((h) => mintArg.includes(h.mint)) : all;
for (const m of mintArg) if (!all.some((h) => h.mint === m)) console.log(`[rescue] ${m.slice(0, 12)}: no balance in wallet`);
console.log(`[rescue] holdings: ${all.length}, selected: ${targets.length}\n`);

let totalSol = 0;
for (const h of targets) {
  const q = await quoteVenue(h.mint, h.raw);
  const whole = Number(h.raw) / 1e6;
  const px = q.expectedSol ? q.expectedSol / whole : null;
  if (q.expectedSol) totalSol += q.expectedSol;
  console.log(
    `${h.mint}\n  balance=${whole.toLocaleString("en-US", { maximumFractionDigits: 2 })} | venue=${q.venue} | out=${
      q.expectedSol == null ? "n/a" : q.expectedSol.toFixed(6) + " SOL"
    }${px ? ` (${px.toExponential(3)} SOL/tok)` : ""}\n  ${q.note}`,
  );

  if (!LIVE) continue;
  if (!q.sellable) {
    console.log("  SKIP: no sellable venue (STUCK — wait for migration, or sell on PumpSwap manually)");
    continue;
  }
  if (q.venue === "pool" && process.env.LIVE_CONFIRM_AMM !== "yes") {
    console.log("  SKIP: PumpSwap sell is UNVERIFIED — set LIVE_CONFIRM_AMM=yes to try it");
    continue;
  }
  try {
    if (q.venue === "curve") {
      // M5: a curve sell is planned in parts (each part's payout fits 0.95 × realSolReserves);
      // sell EVERY part in order, not just the first. Each part steps the curve, so simulate and
      // send each one separately.
      const parts = q.plan.parts;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const minSol = (part.quoteOut * BigInt(10000 - SLIP)) / 10000n;
        const ixs = [
          ...computeBudgetIxs(),
          sellIx(wallet.publicKey, new PublicKey(h.mint), part.amountRaw, minSol, {
            creator: q.state.creator ? new PublicKey(q.state.creator) : undefined,
            isMayhem: !!q.state.isMayhemMode,
          }),
        ];
        const tx = await buildVersionedTx(wallet, ixs);
        const sim = await simulateTx(tx);
        if (!sim.ok) {
          console.log(`  part ${i + 1}/${parts.length} simulation failed: ${describeTxError(sim.err)} — not sending`);
          continue;
        }
        await sendTxWithRetry(tx, { skipPreflight: true });
        console.log(`  sold part ${i + 1}/${parts.length}: ${(Number(part.amountRaw) / 1e6).toFixed(0)} tokens.`);
      }
    } else {
      const amountRaw = h.raw;
      // BigInt lamports straight from the quote (no float round trip): min_out is then exact
      // integer arithmetic on the net quote (AUDIT_SELL.md §4).
      const quoteOut = q.expectedLamports;
      const userWsol = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM);
      const ixs = [
        ...computeBudgetIxs(),
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM),
        ammSellIx(wallet.publicKey, new PublicKey(h.mint), q.pool, q.p, q.g, amountRaw, (quoteOut * BigInt(10000 - SLIP)) / 10000n),
        createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM),
      ];
      console.log("  NOTE: AMM sell layout is UNVERIFIED — the first live rescue is its test.");
      const tx = await buildVersionedTx(wallet, ixs);
      const sim = await simulateTx(tx);
      if (!sim.ok) {
        console.log(`  simulation failed: ${describeTxError(sim.err)} — not sending`);
        continue;
      }
      await sendTxWithRetry(tx, { skipPreflight: true });
      console.log(`  sold ${(Number(amountRaw) / 1e6).toFixed(0)} tokens.`);
    }
  } catch (e) {
    console.log(`  sell failed: ${describeTxError(e)}`);
  }
}

console.log(`\n[rescue] estimated total: ${totalSol.toFixed(6)} SOL`);
if (LIVE) {
  const endSol = await getSOLBalance(wallet.publicKey).catch(() => null);
  if (Number.isFinite(startSol) && Number.isFinite(endSol)) {
    console.log(`[rescue] wallet ${startSol.toFixed(6)} -> ${endSol.toFixed(6)} SOL (delta ${(endSol - startSol).toFixed(6)})`);
  }
}



