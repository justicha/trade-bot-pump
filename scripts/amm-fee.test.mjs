import "./lib/test-env.mjs";
// The PumpSwap sell quote must subtract the fee the pool REALLY takes (KODING №10, A).
//
// Before: lp + protocol + creator bps of GlobalConfig = 30 bps. The pool charges the tier of its
// market cap from the fee program's FeeConfig (125 bps right after a migration), so every quote —
// shadow exits, the live `expectedSol` and min_quote_amount_out — was ~0.95% too high.
//
// The replay below is offline: 10 real mainnet SellEvents + the real FeeConfig account
// (scripts/fixtures/amm-sell-events.json). The fake connection serves the state the event itself
// reports (reserves before the trade, virtual quote reserves, mint supply), and the quote has to
// reproduce what the seller received. Tolerance: 0 lamports — the program's arithmetic is integer
// (floor on the constant product, each of the three fees rounded up) and is replayed exactly, so
// anything but equality means the model is wrong. (The task allows 5 bps; none is needed.)
import fs from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AMM_FALLBACK_FEES,
  AMM_FEE_CONFIG,
  AMM_FEE_PROGRAM,
  AMM_GLOBAL_CONFIG,
  ammNetOut,
  ammSellFees,
  ammSellIx,
  ammSellQuote,
  canonicalPool,
  decodeFeeConfig,
  decodePool,
  pickFeeTier,
  poolMarketCapLamports,
} from "../lib/pumpswap.mjs";
import { ammSellOnce } from "../lib/amm-sell.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/amm-sell-events.json", import.meta.url), "utf8"));
asrt(!/https?:|api-key/i.test(JSON.stringify(FIX)), "the fixture carries no URL / key");
asrt(FIX.events.length === 10, `10 real SellEvents, got ${FIX.events.length}`);
const FEE_CONFIG_DATA = Buffer.concat([Buffer.from(FIX.feeConfig.dataHex, "hex"), Buffer.alloc(FIX.feeConfig.accountLength)]).subarray(0, FIX.feeConfig.accountLength);
const SOL = 1_000_000_000n;

// --- the fee config account: address, owner, layout ---
asrt(AMM_FEE_CONFIG.toBase58() === FIX.feeConfig.address, "AMM_FEE_CONFIG is the account the fixture was read from");
asrt(AMM_FEE_PROGRAM.toBase58() === FIX.feeConfig.owner, "it is owned by the fee program");
const feeConfig = decodeFeeConfig(FEE_CONFIG_DATA);
asrt(feeConfig && feeConfig.feeTiers.length === 25, `25 tiers decoded, got ${feeConfig?.feeTiers.length}`);
asrt(feeConfig.flatFees.lpFeeBps === 25 && feeConfig.flatFees.protocolFeeBps === 5 && feeConfig.flatFees.creatorFeeBps === 0, "flat fees 25/5/0 (non-pump pools)");
{
  const [t0, t1, t2] = feeConfig.feeTiers;
  asrt(t0.thresholdLamports === 0n && t0.lpFeeBps === 2 && t0.protocolFeeBps === 93 && t0.creatorFeeBps === 30, "tier 0: 2 + 93 + 30 = 125 bps");
  asrt(t1.thresholdLamports === 420n * SOL && t1.lpFeeBps === 20 && t1.protocolFeeBps === 5 && t1.creatorFeeBps === 95, "tier 1 from 420 SOL: 20 + 5 + 95 = 120 bps");
  asrt(t2.thresholdLamports === 1470n * SOL && t2.creatorFeeBps === 90, "tier 2 from 1470 SOL");
  const last = feeConfig.feeTiers[24];
  asrt(last.lpFeeBps === 20 && last.protocolFeeBps === 5 && last.creatorFeeBps === 5, "top tier: 20 + 5 + 5 = 30 bps");
  asrt(pickFeeTier(feeConfig.feeTiers, 420n * SOL - 1n) === t0, "just below 420 SOL -> tier 0");
  asrt(pickFeeTier(feeConfig.feeTiers, 420n * SOL) === t1, "exactly 420 SOL -> tier 1");
  asrt(pickFeeTier(feeConfig.feeTiers, 10n ** 30n) === last, "above every threshold -> the last tier");
}
// The ix the bot sends already names this very account (index 19) and its program (index 20).
{
  const pk = (b) => new PublicKey(Buffer.alloc(32, b));
  const p = { quoteMint: new PublicKey("So11111111111111111111111111111111111111112"), baseVault: pk(4), quoteVault: pk(5), coinCreator: pk(6), isMayhem: false, isCashback: false };
  const g = { protocolFeeRecipients: [pk(7)], reservedFeeRecipient: PublicKey.default, reservedFeeRecipients: [], buybackFeeRecipients: [pk(8)] };
  const ix = ammSellIx(pk(1), pk(2), pk(3), p, g, 1n, 1n);
  asrt(ix.keys[19].pubkey.equals(AMM_FEE_CONFIG) && ix.keys[20].pubkey.equals(AMM_FEE_PROGRAM), "the quote reads the fee_config account the sell instruction passes to the program");
}

// --- anything that is not a FeeConfig decodes to null (never to a fee of 0) ---
asrt(decodeFeeConfig(null) === null && decodeFeeConfig(Buffer.alloc(0)) === null, "empty data -> null");
asrt(decodeFeeConfig(Buffer.alloc(4097)) === null, "zeroed account -> null (wrong discriminator)");
{
  const bad = Buffer.from(FEE_CONFIG_DATA);
  bad.writeUInt32LE(0, 65);
  asrt(decodeFeeConfig(bad) === null, "no tiers -> null");
  const huge = Buffer.from(FEE_CONFIG_DATA);
  huge.writeBigUInt64LE(20_000n, 69 + 16); // tier 0 lp fee = 200%
  asrt(decodeFeeConfig(huge) === null, "implausible bps -> null");
  const unordered = Buffer.from(FEE_CONFIG_DATA);
  unordered.writeBigUInt64LE(0n, 69 + 40); // tier 1 threshold = 0 (not ascending)
  asrt(decodeFeeConfig(unordered) === null, "thresholds not ascending -> null");
  asrt(decodeFeeConfig(FEE_CONFIG_DATA.subarray(0, 300)) === null, "truncated tier list -> null");
}

// --- replay of the 10 real SellEvents ---
function readEvent(hex) {
  const d = Buffer.from(hex, "hex");
  const u = (o) => d.readBigUInt64LE(o);
  asrt(d.subarray(0, 8).toString("hex") === "3e2f370aa503dc2a" && d.length === 449, "fixture row is a SellEvent");
  return {
    baseAmountIn: u(16),
    poolBase: u(48), // pool_base_token_reserves, before the trade
    poolQuote: u(56), // pool_quote_token_reserves (the vault, without the virtual part)
    quoteAmountOut: u(64), // gross
    lpFeeBps: Number(u(72)),
    protocolFeeBps: Number(u(88)),
    userQuoteAmountOut: u(112), // what the seller received
    pool: new PublicKey(d.subarray(120, 152)),
    creatorFeeBps: Number(u(344)),
    virtualQuote: u(392) + (d.readBigInt64LE(400) << 64n),
    supply: u(409),
  };
}

// The chain as it was at the event: pool account (its virtual quote reserves set to the value the
// event reports), the two vault balances, the mint supply, the fee config.
function chainAt(f, ev, { feeConfigInfo, supply = "ok", calls = {} } = {}) {
  const poolData = Buffer.from(f.poolAccountHex, "hex");
  poolData.writeBigUInt64LE(ev.virtualQuote & 0xffffffffffffffffn, 245);
  poolData.writeBigInt64LE(ev.virtualQuote >> 64n, 253);
  const p = decodePool(poolData);
  const hit = (k) => (calls[k] = (calls[k] || 0) + 1);
  const conn = {
    async getAccountInfo(a) {
      if (a.equals(ev.pool)) return { data: poolData, owner: new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA") };
      if (a.equals(AMM_FEE_CONFIG)) {
        hit("feeConfig");
        if (feeConfigInfo === "throw") throw new Error("rpc down");
        return feeConfigInfo === undefined ? { data: FEE_CONFIG_DATA, owner: AMM_FEE_PROGRAM } : feeConfigInfo;
      }
      if (a.equals(AMM_GLOBAL_CONFIG)) return null;
      throw new Error("unexpected getAccountInfo " + a.toBase58());
    },
    async getTokenAccountBalance(a) {
      if (a.equals(p.baseVault)) return { value: { amount: ev.poolBase.toString() } };
      if (a.equals(p.quoteVault)) return { value: { amount: ev.poolQuote.toString() } };
      throw new Error("unexpected getTokenAccountBalance " + a.toBase58());
    },
  };
  if (supply === "ok") conn.getTokenSupply = async () => ({ value: { amount: ev.supply.toString() } });
  if (supply === "throw") conn.getTokenSupply = async () => { throw new Error("rpc down"); };
  return conn; // supply === "missing": the connection has no getTokenSupply at all
}

const table = [];
const seenBps = new Set();
let edgeCases = 0;
for (const f of FIX.events) {
  const ev = readEvent(f.eventHex);
  const mint = new PublicKey(f.mint);
  asrt(canonicalPool(mint).equals(ev.pool) && ev.pool.toBase58() === f.pool, `${f.mint.slice(0, 6)}: the event's pool is the mint's canonical pool`);
  const q = await ammSellQuote(chainAt(f, ev), mint, ev.baseAmountIn);
  const tag = `${f.mint.slice(0, 6)} slot ${f.slot}`;
  const evBps = ev.lpFeeBps + ev.protocolFeeBps + ev.creatorFeeBps;
  asrt(q && q.feeSource === "onchain", `${tag}: feeSource onchain, got ${q?.feeSource}`);
  asrt(q.grossOut === ev.quoteAmountOut, `${tag}: gross ${q.grossOut} = event quote_amount_out ${ev.quoteAmountOut}`);
  asrt(
    q.fees.lpFeeBps === ev.lpFeeBps && q.fees.protocolFeeBps === ev.protocolFeeBps && q.fees.creatorFeeBps === ev.creatorFeeBps && q.feeBps === evBps,
    `${tag}: fee split ${q.fees.lpFeeBps}+${q.fees.protocolFeeBps}+${q.fees.creatorFeeBps} = the event's ${ev.lpFeeBps}+${ev.protocolFeeBps}+${ev.creatorFeeBps}`,
  );
  asrt(q.solOut === ev.userQuoteAmountOut, `${tag}: net ${q.solOut} = what the seller received ${ev.userQuoteAmountOut} (diff ${q.solOut - ev.userQuoteAmountOut} lamports)`);
  // The old model (GlobalConfig 20 + 5 + 5, one floor) on the same gross — what the quote used to say.
  const old = (ev.quoteAmountOut * 9970n) / 10000n;
  const overBps = Number(((old - ev.userQuoteAmountOut) * 1_000_000n) / ev.userQuoteAmountOut) / 100;
  if (evBps > 30) asrt(old > ev.userQuoteAmountOut, `${tag}: the 30 bps model overstates this sale`);
  // Market cap WITHOUT the virtual reserves puts sales near the 420 SOL edge into the wrong tier.
  const capReal = poolMarketCapLamports({ baseReserve: ev.poolBase, quoteReserve: ev.poolQuote, supply: ev.supply });
  const realTier = pickFeeTier(feeConfig.feeTiers, capReal);
  if (realTier.lpFeeBps + realTier.protocolFeeBps + realTier.creatorFeeBps !== evBps) edgeCases += 1;
  // The fallback is never more optimistic than the chain.
  const fb = await ammSellQuote(chainAt(f, ev, { feeConfigInfo: null }), mint, ev.baseAmountIn);
  asrt(fb.feeSource === "fallback" && fb.feeBps === 125 && fb.solOut <= q.solOut, `${tag}: fallback quote (${fb.solOut}) is not above the real one (${q.solOut})`);
  seenBps.add(evBps);
  table.push({ mint: f.mint.slice(0, 6), slot: f.slot, mcapSol: Math.round(Number(q.marketCapLamports) / 1e7) / 100, feeBps: q.feeBps, received: ev.userQuoteAmountOut.toString(), quote: q.solOut.toString(), diff: Number(q.solOut - ev.userQuoteAmountOut), old30bpsOverBps: overBps });
}
asrt(seenBps.has(125) && seenBps.has(120) && seenBps.has(115) && seenBps.has(30), `the fixture covers tiers 125/120/115/30, got ${[...seenBps]}`);
asrt(edgeCases >= 2, `at least 2 events sit on the 420 SOL edge where only vault+virtual reserves pick the right tier (got ${edgeCases})`);

// --- fallbacks: the quote survives an unreadable fee config / supply, and says so ---
{
  const f = FIX.events[0];
  const ev = readEvent(f.eventHex);
  const mint = new PublicKey(f.mint);
  const real = await ammSellQuote(chainAt(f, ev), mint, ev.baseAmountIn);
  const expectFallback = ammNetOut(ev.quoteAmountOut, AMM_FALLBACK_FEES);
  asrt(AMM_FALLBACK_FEES.lpFeeBps + AMM_FALLBACK_FEES.protocolFeeBps + AMM_FALLBACK_FEES.creatorFeeBps === 125, "fallback = 125 bps (not below the observed maximum)");
  for (const [name, info] of [
    ["missing account", null],
    ["rpc error", "throw"],
    ["wrong owner", { data: FEE_CONFIG_DATA, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }],
    ["wrong data", { data: Buffer.alloc(4097), owner: AMM_FEE_PROGRAM }],
  ]) {
    const q = await ammSellQuote(chainAt(f, ev, { feeConfigInfo: info }), mint, ev.baseAmountIn);
    asrt(q && q.feeSource === "fallback" && q.feeBps === 125 && q.solOut === expectFallback, `fee config ${name}: fallback 125 bps, got ${q?.feeSource}/${q?.feeBps}`);
    asrt(q.grossOut === real.grossOut && q.marketCapLamports === null, `fee config ${name}: gross unchanged, no market cap claimed`);
  }
  // Supply unreadable: the tier cannot be chosen -> the most expensive tier of the real config.
  const top = FIX.events[9];
  const evTop = readEvent(top.eventHex);
  for (const supply of ["missing", "throw"]) {
    const q = await ammSellQuote(chainAt(top, evTop, { supply }), new PublicKey(top.mint), evTop.baseAmountIn);
    asrt(q.feeSource === "fallback" && q.feeBps === 125, `supply ${supply}: the most expensive tier (125 bps), got ${q.feeSource}/${q.feeBps}`);
    asrt(q.solOut < evTop.userQuoteAmountOut, `supply ${supply}: the quote is below what this 30 bps sale really paid`);
  }
  const noSupply = ammSellFees({ feeConfig, baseReserve: 1n, quoteReserve: 1n, supply: 0n });
  asrt(noSupply.source === "fallback" && noSupply.lpFeeBps + noSupply.protocolFeeBps + noSupply.creatorFeeBps === 125, "ammSellFees without a supply never guesses a cheap tier");
}

// --- the fee config is read once per connection (5 min), failures are retried ---
{
  const f = FIX.events[0];
  const ev = readEvent(f.eventHex);
  const mint = new PublicKey(f.mint);
  const calls = {};
  const conn = chainAt(f, ev, { calls });
  const t0 = 1_000_000;
  await ammSellQuote(conn, mint, ev.baseAmountIn, null, { now: t0 });
  await ammSellQuote(conn, mint, ev.baseAmountIn, null, { now: t0 + 60_000 });
  asrt(calls.feeConfig === 1, `two quotes within 5 min read the fee config once, got ${calls.feeConfig}`);
  await ammSellQuote(conn, mint, ev.baseAmountIn, null, { now: t0 + 6 * 60_000 });
  asrt(calls.feeConfig === 2, `after 5 min it is read again, got ${calls.feeConfig}`);
  const calls2 = {};
  const down = chainAt(f, ev, { calls: calls2, feeConfigInfo: null });
  await ammSellQuote(down, mint, ev.baseAmountIn, null, { now: t0 });
  await ammSellQuote(down, mint, ev.baseAmountIn, null, { now: t0 + 1 });
  asrt(calls2.feeConfig === 2, `a failed read is not cached, got ${calls2.feeConfig}`);
  const given = await ammSellQuote(chainAt(f, ev, { feeConfigInfo: "throw" }), mint, ev.baseAmountIn, null, { feeConfig });
  asrt(given.feeSource === "onchain" && given.solOut === ev.userQuoteAmountOut, "a decoded fee config can be passed in");
}

// --- live sell: ONLY min_quote_amount_out moves; accounts / order / discriminator stay ---
{
  const f = FIX.events[4];
  const ev = readEvent(f.eventHex);
  const mint = new PublicKey(f.mint);
  const wallet = Keypair.generate();
  const pk = (b) => new PublicKey(Buffer.alloc(32, b));
  const g = { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipients: [pk(0x77)], reservedFeeRecipient: PublicKey.default, reservedFeeRecipients: [], buybackFeeRecipients: [pk(0x88)] };
  const conn = chainAt(f, ev);
  const journal = { entries: [], write(r) { this.entries.push(r); } };
  let built = null;
  const r = await ammSellOnce({
    connection: conn,
    wallet,
    mint: f.mint,
    mintPk: mint,
    total: ev.baseAmountIn,
    attempt: 1,
    slip: 500,
    live: true,
    confirmAmm: "yes",
    drySell: true, // built + simulated + journaled, never sent
    journal,
    deps: {
      ammSellQuote: (c, m, t) => ammSellQuote(c, m, t, g),
      buildVersionedTx: async (_w, ixs) => ((built = ixs), { fake: "tx" }),
      simulateTx: async () => ({ ok: true, err: null, logs: [], units: 80_000 }),
      sendTxWithRetry: async () => {
        throw new Error("must not send");
      },
    },
  });
  asrt(r.status === "dry", `dry sell, got ${r.status}`);
  const sell = built.find((ix) => ix.data.length === 24 && ix.data.subarray(0, 8).toString("hex") === "33e685a4017f83ad");
  asrt(sell, "the transaction carries the PumpSwap sell instruction");
  const minOut = (ev.userQuoteAmountOut * 9500n) / 10000n;
  asrt(sell.data.readBigUInt64LE(16) === minOut, `min_quote_amount_out = real net x (1 - slip) = ${minOut}, got ${sell.data.readBigUInt64LE(16)}`);
  const oldMinOut = (((ev.quoteAmountOut * 9970n) / 10000n) * 9500n) / 10000n;
  asrt(oldMinOut > minOut, "the 30 bps quote asked the pool for more than it pays");
  // The same instruction built with the OLD minOut differs in bytes 16..24 only.
  const q = await ammSellQuote(conn, mint, ev.baseAmountIn, g);
  const before = ammSellIx(wallet.publicKey, mint, q.pool, q.p, q.g, ev.baseAmountIn, oldMinOut);
  asrt(sell.data.subarray(0, 16).equals(before.data.subarray(0, 16)), "discriminator + base_amount_in unchanged");
  asrt(sell.keys.length === before.keys.length && sell.keys.length === 24, `same account count (24), got ${sell.keys.length}`);
  asrt(
    sell.keys.every((k, i) => k.pubkey.equals(before.keys[i].pubkey) && k.isSigner === before.keys[i].isSigner && k.isWritable === before.keys[i].isWritable),
    "same accounts, order and flags",
  );
  asrt(sell.programId.equals(before.programId), "same program");
  const sim = journal.entries.find((e) => e.type === "sell_sim");
  asrt(sim && sim.feeBps === 120 && sim.feeSource === "onchain", `sell_sim journals feeBps 120 / feeSource onchain, got ${sim?.feeBps}/${sim?.feeSource}`);
  asrt(sim.expectedSol === Number(ev.userQuoteAmountOut) / 1e9, "expectedSol in the journal is the real net");
}

console.log(JSON.stringify(table));
console.log("PASS: amm-fee — the quote takes the pool's real fee tier from the fee program; 10 real SellEvents reproduced to the lamport; fallback 125 bps; only min_quote_amount_out changes in the sell ix");
