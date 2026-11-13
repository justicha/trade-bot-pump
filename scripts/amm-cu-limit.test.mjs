import { cleanEnv } from "./lib/test-env.mjs";
// AMM_SELL_CU_LIMIT (KODING №10, B): the PumpSwap sell transaction requests its own compute-unit
// limit (default 160k) — a real pool sell needs 73–86k CU, plus ~25k for the WSOL ATA and ~3k for
// its close, which a 120k CU_LIMIT barely covers. Every other transaction keeps CU_LIMIT.
//
// Also pinned here: the ESTIMATES that stand in for a fee nobody measured (a tx that landed and
// failed, a paper AMM exit, a live sale whose meta is missing) use the AMM limit for the AMM sell;
// a fee read from the chain is used as it is and never topped up with an estimate.
// No network: RPC_MOCK serves the blockhash, accepts the "send" and fails the confirmation.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

// The human's live numbers, so the two limits differ in the direction that matters (120k < 160k).
process.env.CU_PRICE = "1500000";
process.env.CU_LIMIT = "120000";
process.env.RPC_MOCK = path.join(here, "mocks", "confirm-fail-mock.mjs");

const { AMM_SELL_CU_LIMIT, CU_LIMIT, CU_PRICE } = await import("../lib/config.mjs");
const { estTxFeeLamports, rpcStats, sendTxWithRetry } = await import("../lib/rpc.mjs");
const { buildVersionedTx, computeBudgetIxs } = await import("../lib/tx.mjs");
const { ammSellOnce } = await import("../lib/amm-sell.mjs");
const { ammSellTxCostSol, netRatioExitCosts, roundTripCosts, txCostSol } = await import("../lib/fees.mjs");
const { pessimisticRoundTrip } = await import("../lib/pessimistic.mjs");
const { applyLiveSell } = await import("../lib/live-pnl.mjs");
const { WSOL } = await import("../lib/constants.mjs");
const mock = await import("./mocks/confirm-fail-mock.mjs");

// --- the env var: default 160k, CU_LIMIT untouched ---
asrt(AMM_SELL_CU_LIMIT === 160_000, `AMM_SELL_CU_LIMIT defaults to 160000, got ${AMM_SELL_CU_LIMIT}`);
asrt(CU_LIMIT === 120_000 && CU_PRICE === 1_500_000, "CU_LIMIT / CU_PRICE are what the env says");

// What a transaction asks the ComputeBudget program for.
function budgetOf(tx) {
  const keys = tx.message.staticAccountKeys;
  const out = {};
  for (const ix of tx.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 2) out.limit = d.readUInt32LE(1);
    if (d[0] === 3) out.price = Number(d.readBigUInt64LE(1));
  }
  return out;
}

// --- every other transaction still requests CU_LIMIT ---
const kp = Keypair.generate();
const plain = await buildVersionedTx(kp, [...computeBudgetIxs(), SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })]);
asrt(budgetOf(plain).limit === 120_000 && budgetOf(plain).price === 1_500_000, `computeBudgetIxs() default is CU_LIMIT (120000), got ${JSON.stringify(budgetOf(plain))}`);

// --- the AMM sell: built, simulated and sent with AMM_SELL_CU_LIMIT ---
const pk = (b) => new PublicKey(Buffer.alloc(32, b));
const mintPk = pk(0x22);
const p = { baseMint: mintPk, quoteMint: WSOL, baseVault: pk(0x44), quoteVault: pk(0x55), coinCreator: pk(0x66), isMayhem: false, isCashback: false };
const g = { lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5, protocolFeeRecipients: [pk(0x77)], reservedFeeRecipient: PublicKey.default, reservedFeeRecipients: [], buybackFeeRecipients: [pk(0x88)] };
const QUOTE = { pool: pk(0x33), p, g, feeBps: 125, feeSource: "onchain", solOut: 100_000_000n };
let builtTx = null;
let simulatedTx = null;
let sendOpts = null;
const failsBefore = rpcStats.txFails;
const feeBefore = rpcStats.txFailFeeLamports;
let thrown = null;
try {
  await ammSellOnce({
    connection: {},
    wallet: kp,
    mint: mintPk.toBase58(),
    mintPk,
    total: 5_000_000_000n,
    attempt: 1,
    slip: 500,
    live: true,
    confirmAmm: "yes",
    journal: { write() {} },
    deps: {
      ammSellQuote: async () => QUOTE,
      buildVersionedTx: async (w, ixs) => (builtTx = await buildVersionedTx(w, ixs)),
      simulateTx: async (tx) => ((simulatedTx = tx), { ok: true, err: null, logs: [], units: 86_000 }),
      // The REAL sender against the fixture RPC: the "send" is accepted, the confirmation fails
      // with a network error — i.e. the tx may have landed and failed, and its fee is estimated.
      sendTxWithRetry: (tx, opts) => ((sendOpts = opts), sendTxWithRetry(tx, opts)),
    },
  });
} catch (e) {
  thrown = e;
}
asrt(thrown && thrown.sig === mock.SIG, "the fixture's confirmation failure reaches the caller with the signature");
asrt(builtTx && budgetOf(builtTx).limit === 160_000, `the AMM sell tx requests AMM_SELL_CU_LIMIT (160000), got ${budgetOf(builtTx ?? plain).limit}`);
asrt(budgetOf(builtTx).price === 1_500_000, "CU_PRICE is unchanged on the AMM sell tx");
asrt(simulatedTx === builtTx, "the pre-send simulation runs the very same transaction (same CU limit)");
asrt(sendOpts && sendOpts.cuLimit === 160_000 && sendOpts.skipPreflight === true, `the sender is told the limit this tx requested, got ${JSON.stringify(sendOpts)}`);

// --- estimate of a landed-but-failed tx: by the limit the tx requested ---
asrt(estTxFeeLamports() === 5000 + 1.5 * 120_000 && estTxFeeLamports() === 185_000, `estTxFeeLamports() = CU_LIMIT tx (185000), got ${estTxFeeLamports()}`);
asrt(estTxFeeLamports(AMM_SELL_CU_LIMIT) === 245_000, `estTxFeeLamports(AMM_SELL_CU_LIMIT) = 245000, got ${estTxFeeLamports(AMM_SELL_CU_LIMIT)}`);
asrt(rpcStats.txFails === failsBefore + 1, "the failed AMM sell is counted once");
asrt(rpcStats.txFailFeeLamports - feeBefore === 245_000, `its estimated fee uses AMM_SELL_CU_LIMIT (245000), got ${rpcStats.txFailFeeLamports - feeBefore}`);
{
  const before = rpcStats.txFailFeeLamports;
  await sendTxWithRetry(plain, { skipPreflight: true }).catch(() => {});
  asrt(rpcStats.txFailFeeLamports - before === 185_000, `any other failed tx is still estimated with CU_LIMIT (185000), got ${rpcStats.txFailFeeLamports - before}`);
}

// --- paper costs of an AMM exit: buy leg at CU_LIMIT, sell leg at AMM_SELL_CU_LIMIT ---
asrt(near(txCostSol(), 0.000185) && near(ammSellTxCostSol(), 0.000245), `txCostSol ${txCostSol()} / ammSellTxCostSol ${ammSellTxCostSol()}`);
{
  const curve = netRatioExitCosts({ entrySol: 0.02, ratio: 1.2 });
  const amm = netRatioExitCosts({ entrySol: 0.02, ratio: 1.2, venue: "pumpswap" });
  asrt(near(curve.costs.txSol, 2 * 0.000185), `dry curve exit: two CU_LIMIT legs (${curve.costs.txSol})`);
  asrt(near(amm.costs.txSol, 0.000185 + 0.000245), `dry PumpSwap exit: CU_LIMIT buy + AMM_SELL_CU_LIMIT sell (${amm.costs.txSol})`);
  asrt(near(amm.pnlSol, curve.pnlSol) && near(amm.costs.netPnl, curve.costs.netPnl - 0.00006), "only the network cost differs, by exactly the 40k CU");
  const a = roundTripCosts({ buySol: 0.02, ratio: 1.3 });
  asrt(near(a.txSol, 2 * 0.000185), "roundTripCosts default: every leg at CU_LIMIT (unchanged)");
  const shadowCurve = pessimisticRoundTrip({ buySol: 0.02, ratio: 1.2, delayMs: 1 });
  const shadowAmm = pessimisticRoundTrip({ buySol: 0.02, ratio: 1.2, delayMs: 1, exitVenue: "amm" });
  asrt(near(shadowCurve.txSol, 2 * 0.000185) && near(shadowAmm.txSol, 0.000185 + 0.000245), `shadow: AMM exit pays the AMM sell tx (${shadowAmm.txSol})`);
}

// --- live PnL: the ACTUAL fee wins; the estimate is used only when the meta is missing ---
{
  const pos = { entrySolSol: 0.02, buyFeeSol: 0.000185, entrySource: "chain-meta", ataRentSol: 0 };
  const args = { buySol: 0.02, quoteSol: 0.03, soldRaw: 10n, totalRaw: 10n };
  const actual = applyLiveSell(pos, { ...args, ex: { found: true, feeSol: 0.000111, solReceivedSol: 0.03, solDeltaSol: 0.03, tokensSold: 10n }, sellFeeEstSol: ammSellTxCostSol() });
  asrt(actual.acc.costs.sellFeeSol === 0.000111 && actual.acc.costs.feesActual === true, `a fee read from the chain is booked as it is (${actual.acc.costs.sellFeeSol}) — the estimate is not added`);
  asrt(near(actual.acc.pnlSol, 0.03 + 0.000111 - 0.02 - 0.000185 - 0.000111, 1e-9), "pnlSol formula unchanged: proceeds before the sell fee - entry - both real fees");
  const missing = applyLiveSell(pos, { ...args, ex: { found: false }, sellFeeEstSol: ammSellTxCostSol() });
  asrt(near(missing.acc.costs.sellFeeSol, 0.000245) && missing.acc.costs.feesActual === false, `meta missing on an AMM sale: estimated with AMM_SELL_CU_LIMIT (${missing.acc.costs.sellFeeSol})`);
  const curve = applyLiveSell(pos, { ...args, ex: { found: false } });
  asrt(near(curve.acc.costs.sellFeeSol, 0.000185), `meta missing on any other sale: estimated with CU_LIMIT as before (${curve.acc.costs.sellFeeSol})`);
}

// --- the bot passes the venue / the estimate (source-level: the call sites) ---
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  asrt(/netRatioExitCosts\(\{ entrySol, ratio: mult, venue \}\)/.test(src), "graduation dry exit passes its venue to the cost model");
  asrt(/sellFeeEstSol: venue === "pumpswap" \? ammSellTxCostSol\(\) : null/.test(src), "graduation live sale passes the AMM fee estimate for a PumpSwap sale");
}

// --- the 0.002 SOL priority-fee cap applies to AMM_SELL_CU_LIMIT too ---
{
  const probe = `import("${path.join(root, "lib", "config.mjs").replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "file:///$1")}").then((c) => console.log("OK " + c.AMM_SELL_CU_LIMIT + " " + c.CU_LIMIT))`;
  const run = (extra) => spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", env: cleanEnv({ CU_PRICE: "1500000", CU_LIMIT: "120000", RPC_MOCK: "", ...extra }) });
  const ok = run({});
  asrt(ok.status === 0 && /OK 160000 120000/.test(ok.stdout), `defaults pass the cap (245000 lamports): ${ok.stdout}${ok.stderr}`);
  const custom = run({ AMM_SELL_CU_LIMIT: "200000" });
  asrt(custom.status === 0 && /OK 200000 120000/.test(custom.stdout), `AMM_SELL_CU_LIMIT is read from the env and does not move CU_LIMIT: ${custom.stdout}${custom.stderr}`);
  // 1.5M x 1.4M / 1e6 = 2.1M lamports > 2M, while CU_LIMIT (120k -> 180k lamports) is fine.
  const over = run({ AMM_SELL_CU_LIMIT: "1400000" });
  asrt(over.status === 1 && /AMM_SELL_CU_LIMIT/.test(over.stderr) && /0\.002 SOL/.test(over.stderr), `over the cap: startup aborts and names AMM_SELL_CU_LIMIT, got ${over.status}: ${over.stderr}`);
  const bad = run({ AMM_SELL_CU_LIMIT: "abc" });
  asrt(bad.status === 1 && /AMM_SELL_CU_LIMIT must be a number/.test(bad.stderr), "a non-numeric value aborts startup");
}

console.log(JSON.stringify({ cuLimit: CU_LIMIT, ammSellCuLimit: AMM_SELL_CU_LIMIT, estFailFee: estTxFeeLamports(), estAmmFailFee: estTxFeeLamports(AMM_SELL_CU_LIMIT) }));
console.log("PASS: amm-cu-limit — the AMM sell requests AMM_SELL_CU_LIMIT (160k), other txs keep CU_LIMIT, the fee cap covers it, estimates follow the tx's own limit, actual fees are never estimated");
