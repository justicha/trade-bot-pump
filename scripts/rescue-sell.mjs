#!/usr/bin/env node
// rescue-sell: salvage tokens the bot could not sell on the bonding curve.
//
// A position can outlive the curve: once the curve is complete (migrated to PumpSwap) or its
// real SOL reserves are drained (a curve sell then overflows with Custom 6024), the bot has no
// route. This tool finds the right venue and prices the exit.
//
// DRY-RUN by default: reads the chain and prints what an exit would yield.
// LIVE requires BOTH an explicit --mint and LIVE_CONFIRM=yes (lib/config.mjs enforces the gate).
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
import { DRY_RUN } from "../lib/config.mjs";
import {
  ATA_PROGRAM,
  PUMP_PROGRAM,
  PUMPSWAP_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  WSOL,
} from "../lib/constants.mjs";
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

const AMM_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const AMM_GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_PROGRAM)[0];
const AMM_EVENT_AUTH = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP_PROGRAM)[0];
const AMM_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMPSWAP_PROGRAM.toBuffer()],
  AMM_FEE_PROGRAM,
)[0];
// SPL Token (classic) program for WSOL; pump mints themselves are Token-2022.
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const mintArg = (() => {
  const i = args.indexOf("--mint");
  return i >= 0 && args[i + 1] ? args[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : [];
})();
const SLIP = Number(process.env.SELL_SLIPPAGE_BPS || 1000); // 10% — a rescue wants out

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
function canonicalPool(mint) {
  const authority = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM)[0];
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([0, 0]), authority.toBuffer(), mint.toBuffer(), WSOL.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
}

function readI128(d, o) {
  const lo = d.readBigUInt64LE(o);
  const hi = d.readBigInt64LE(o + 8);
  return lo + (hi << 64n);
}

// PumpSwap PoolState (borsh after the 8-byte discriminator), from the official pump-amm IDL.
function decodePool(d) {
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  return {
    baseMint: pk(43),
    quoteMint: pk(75),
    baseVault: pk(139),
    quoteVault: pk(171),
    coinCreator: pk(211),
    isMayhem: d[243] === 1,
    isCashback: d[244] === 1,
    virtualQuoteReserves: readI128(d, 245),
    creatorFeeBps: d.readBigUInt64LE(261),
  };
}

// GlobalConfig: admin(32) lp_fee_bps(u64) protocol_fee_bps(u64) disable(u8) recipients[8](256) ...
function decodeGlobalConfig(d) {
  return {
    lpFeeBps: Number(d.readBigUInt64LE(40)),
    protocolFeeBps: Number(d.readBigUInt64LE(48)),
    protocolFeeRecipient: new PublicKey(d.subarray(57, 89)),
    coinCreatorFeeBps: Number(d.readBigUInt64LE(313)),
  };
}

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
  const gc = await connection.getAccountInfo(AMM_GLOBAL_CONFIG);
  const g = gc
    ? decodeGlobalConfig(gc.data)
    : { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipient: null };
  const feeBps = g.lpFeeBps + g.protocolFeeBps + (p.creatorFeeBps > 0n ? Number(p.creatorFeeBps) : g.coinCreatorFeeBps);
  const net = (out * BigInt(10000 - feeBps)) / 10000n;
  return {
    venue: "pool",
    expectedSol: Number(net) / 1e9,
    note: `${curveNote}; pool ${pool.toBase58().slice(0, 8)} fee≈${(feeBps / 100).toFixed(2)}%`,
    sellable: true,
    pool,
    p,
    g,
  };
}

// PumpSwap (AMM) sell — 21 accounts per the official IDL. UNVERIFIED until one live rescue works.
function ammSellIx(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut) {
  if (!g.protocolFeeRecipient) throw new Error("AMM global config has no protocol fee recipient");
  const creatorAuth = PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), p.coinCreator.toBuffer()],
    PUMPSWAP_PROGRAM,
  )[0];
  const creatorVaultAta = getAssociatedTokenAddressSync(p.quoteMint, creatorAuth, true, TOKEN_PROGRAM);
  const keys = [
    { pubkey: pool, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: AMM_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: p.quoteMint, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(baseMint, user, false, TOKEN_2022_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(p.quoteMint, user, false, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: p.baseVault, isSigner: false, isWritable: true },
    { pubkey: p.quoteVault, isSigner: false, isWritable: true },
    { pubkey: g.protocolFeeRecipient, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(p.quoteMint, g.protocolFeeRecipient, false, TOKEN_PROGRAM), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: AMM_EVENT_AUTH, isSigner: false, isWritable: false },
    { pubkey: PUMPSWAP_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
    { pubkey: creatorAuth, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_CONFIG, isSigner: false, isWritable: false },
    { pubkey: AMM_FEE_PROGRAM, isSigner: false, isWritable: false },
  ];
  const data = Buffer.alloc(24);
  Buffer.from("33e685a4017f83ad", "hex").copy(data, 0); // sha256("global:sell")[0..8]
  data.writeBigUInt64LE(baseAmountIn, 8);
  data.writeBigUInt64LE(minQuoteOut, 16);
  return { programId: PUMPSWAP_PROGRAM, keys, data };
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
    const ixs = [...computeBudgetIxs()];
    let amountRaw = h.raw;
    let quoteOut = BigInt(Math.floor(q.expectedSol * 1e9));
    if (q.venue === "curve") {
      const part = q.plan.parts[0];
      amountRaw = part.amountRaw;
      quoteOut = part.quoteOut;
      ixs.push(
        sellIx(wallet.publicKey, new PublicKey(h.mint), amountRaw, (quoteOut * BigInt(10000 - SLIP)) / 10000n, {
          creator: q.state.creator ? new PublicKey(q.state.creator) : undefined,
          isMayhem: !!q.state.isMayhemMode,
        }),
      );
    } else {
      const userWsol = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userWsol, wallet.publicKey, WSOL, TOKEN_PROGRAM));
      ixs.push(ammSellIx(wallet.publicKey, new PublicKey(h.mint), q.pool, q.p, q.g, amountRaw, (quoteOut * BigInt(10000 - SLIP)) / 10000n));
      ixs.push(createCloseAccountInstruction(userWsol, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM));
      console.log("  NOTE: AMM sell layout is UNVERIFIED — the first live rescue is its test.");
    }
    const tx = await buildVersionedTx(wallet, ixs);
    const sim = await simulateTx(tx);
    if (!sim.ok) {
      console.log(`  simulation failed: ${describeTxError(sim.err)} — not sending`);
      continue;
    }
    await sendTxWithRetry(tx, { skipPreflight: true });
    console.log(`  sold ${(Number(amountRaw) / 1e6).toFixed(0)} tokens.`);
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



