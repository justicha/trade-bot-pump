import { cleanEnv, makeTempKeys } from "./lib/test-env.mjs";
// rescue-sell and probe-sell-sim price and budget a PumpSwap sale exactly like the bots (KODING №11).
//
// Before: both scripts carried their own copy of the quote — constant product minus the lp +
// protocol + creator bps of GlobalConfig (30 bps). The pool takes the tier of its market cap from
// the fee program (125 / 120 bps right after a migration), so min_quote_amount_out was ~0.95% too
// high: with SELL_SLIPPAGE_BPS below ~100 a manual AMM sale asked for more than the pool pays.
// Both also sent the AMM transaction with CU_LIMIT instead of AMM_SELL_CU_LIMIT.
//
// Now: the quote is lib/pumpswap.mjs ammSellQuote and the transaction is lib/amm-sell.mjs
// ammSellTxIxs — the same two functions the bots use.
//
// No network and nothing is sent: RPC_MOCK serves a migrated mint (pool, vaults, GlobalConfig with
// 30 bps and fee recipients; no FeeConfig / supply -> the fallback tier, 125 bps). A real --live
// rescue cannot be spawned (lib/rpc.mjs refuses RPC_MOCK with --live), so the live branch of
// rescue-sell is pinned at source level and the function it calls is tested directly.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const MINT = new PublicKey(Buffer.alloc(32, 0x22)).toBase58();
const RAW = 4_000_000_000_000n; // 4M tokens
const SLIP = 50; // bps — the case the old quote broke: tolerance below the ~95 bps it was off by
const FIXTURE = {
  RPC_MOCK: path.join(here, "mocks", "rescue-amm-rpc-mock.mjs"),
  RPC_AMM_MINTS: MINT,
  RPC_AMM_POOL: "1",
  RESCUE_HOLD_RAW: RAW.toString(),
  // The human's live numbers, so the two limits differ in the direction that matters (120k < 160k).
  CU_PRICE: "1500000",
  CU_LIMIT: "120000",
};
Object.assign(process.env, FIXTURE);

const { AMM_SELL_CU_LIMIT, CU_LIMIT } = await import("../lib/config.mjs");
const { connection } = await import("../lib/rpc.mjs");
const { ammSellQuote, AMM_SELL_DISCRIMINATOR } = await import("../lib/pumpswap.mjs");
const { ammMinOut, ammSellOnce, ammSellTxIxs } = await import("../lib/amm-sell.mjs");
const { buildVersionedTx, computeBudgetIxs } = await import("../lib/tx.mjs");
const mock = await import("./mocks/rescue-amm-rpc-mock.mjs");

asrt(CU_LIMIT === 120_000 && AMM_SELL_CU_LIMIT === 160_000, "fixture limits: CU_LIMIT 120k, AMM_SELL_CU_LIMIT 160k");

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

// --- the numbers, by hand (independent of lib/pumpswap.mjs) ---
const GROSS = (mock.QUOTE_RESERVE * RAW) / (mock.BASE_RESERVE + RAW);
const up = (bps) => (GROSS * BigInt(bps) + 9999n) / 10000n;
const NET = GROSS - up(2) - up(93) - up(30); // the fallback tier: 2 + 93 + 30 = 125 bps, each rounded up
const MIN_OUT = (NET * BigInt(10000 - SLIP)) / 10000n;
const OLD_NET = (GROSS * 9970n) / 10000n; // what the scripts' own copy subtracted: GlobalConfig, 30 bps
const OLD_MIN_OUT = (OLD_NET * BigInt(10000 - SLIP)) / 10000n;
// The bug in one line: at 50 bps of tolerance the old min_out was above what the pool really pays.
asrt(OLD_MIN_OUT > NET && MIN_OUT < NET, `fixture shows the bug: old min_out ${OLD_MIN_OUT} > real net ${NET} > new min_out ${MIN_OUT}`);

// --- 1. the bots' quote on this pool: the fee tier, not GlobalConfig's 30 bps ---
const kp = Keypair.generate();
const mintPk = new PublicKey(MINT);
const q = await ammSellQuote(connection, mintPk, RAW);
asrt(q && q.feeBps === 125 && q.feeSource === "fallback", `quote fee = fallback tier 125 bps, got ${q?.feeBps} (${q?.feeSource})`);
asrt(q.g.lpFeeBps + q.g.protocolFeeBps + q.g.coinCreatorFeeBps === 30, "the fixture's GlobalConfig says 30 bps — and the quote does not use it");
asrt(q.grossOut === GROSS && q.solOut === NET, `net quote ${q.solOut} = gross ${GROSS} - 125 bps = ${NET}`);
asrt(q.baseReserve === mock.BASE_RESERVE && q.quoteReserve === mock.QUOTE_RESERVE, "the quote reports the vault balances it was computed on");

// --- 2. the AMM sell transaction (what rescue-sell and probe-sell-sim build) ---
asrt(ammMinOut(NET, SLIP) === MIN_OUT && ammMinOut(1_000_000n, 1000) === 900_000n, "ammMinOut = quote x (1 - slippage), integer lamports");
const built = ammSellTxIxs(kp, mintPk, q, RAW, SLIP);
asrt(built.minOut === MIN_OUT, `min_out = ammSellQuote x (1 - slip) = ${MIN_OUT}, got ${built.minOut}`);
asrt(built.ixs.length === 5 && built.ixs[3] === built.sellIx, "compute budget x2, WSOL ATA, sell, WSOL close");
{
  const d = Buffer.from(built.sellIx.data);
  asrt(d.subarray(0, 8).equals(AMM_SELL_DISCRIMINATOR) && d.length === 24, "sell instruction data: discriminator + two u64");
  asrt(d.readBigUInt64LE(8) === RAW, "base_amount_in = the whole balance");
  asrt(d.readBigUInt64LE(16) === MIN_OUT, `min_quote_amount_out in the instruction bytes = ${MIN_OUT}, got ${d.readBigUInt64LE(16)}`);
  asrt(d.readBigUInt64LE(16) !== OLD_MIN_OUT, "not the 30 bps figure");
}
const ammTx = await buildVersionedTx(kp, built.ixs);
asrt(budgetOf(ammTx).limit === 160_000 && budgetOf(ammTx).price === 1_500_000, `the AMM sell tx requests AMM_SELL_CU_LIMIT (160000), got ${JSON.stringify(budgetOf(ammTx))}`);
// The curve sell of rescue-sell keeps `computeBudgetIxs()` — CU_LIMIT.
const curveTx = await buildVersionedTx(kp, computeBudgetIxs());
asrt(budgetOf(curveTx).limit === 120_000, `computeBudgetIxs() (the curve sell) requests CU_LIMIT (120000), got ${budgetOf(curveTx).limit}`);

// --- 3. the bots send that very transaction (ammSellOnce builds it with ammSellTxIxs) ---
{
  let botIxs = null;
  const r = await ammSellOnce({
    connection,
    wallet: kp,
    mint: MINT,
    mintPk,
    total: RAW,
    attempt: 1,
    slip: SLIP,
    live: false,
    confirmAmm: undefined,
    drySell: true, // built + simulated, never sent
    journal: { write() {} },
    deps: {
      buildVersionedTx: async (w, ixs) => ((botIxs = ixs), buildVersionedTx(w, ixs)),
      simulateTx: async () => ({ ok: true, err: null, logs: [], units: 80_000 }),
      sendTxWithRetry: async () => {
        throw new Error("sendTxWithRetry must not be called in this test");
      },
    },
  });
  const flat = (ixs) =>
    JSON.stringify(ixs.map((ix) => [ix.programId.toBase58(), Buffer.from(ix.data).toString("hex"), ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])]));
  asrt(r.status === "dry" && r.quote === NET, `ammSellOnce (DRY_SELL) priced the same sale, got ${r.status}`);
  asrt(botIxs && flat(botIxs) === flat(built.ixs), "the bot's AMM sell tx is instruction-for-instruction the one rescue-sell / probe-sell-sim build");
}

// --- spawn helper: a script against the fixture RPC, in its own clean environment ---
const run = (script, argv, extra = {}) =>
  new Promise((resolve) => {
    const env = cleanEnv({ RPC_URL: "http://127.0.0.1:1", KEYS_DIR: makeTempKeys(), ...FIXTURE, ...extra });
    const child = spawn(process.execPath, [path.join(root, "scripts", script), ...argv], { cwd: root, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 20000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err });
    });
  });
const sol6 = (lamports) => (Number(lamports) / 1e9).toFixed(6);
asrt(sol6(NET) !== sol6(OLD_NET), "the two quotes differ at the precision the plan prints");

// --- 4. rescue-sell, plan only (default mode): the real fee, its source, the min_out ---
{
  const { c, out, err } = await run("rescue-sell.mjs", ["--mint", MINT], { SELL_SLIPPAGE_BPS: String(SLIP) });
  asrt(c === 0, `rescue-sell plan exits 0 (got ${c}): ${err}`);
  asrt(/DRY RUN/.test(out) && /holdings: 1, selected: 1/.test(out), `plan mode, one holding: ${out}`);
  asrt(out.includes("venue=pool") && out.includes("curve complete"), "a completed curve is priced on the pool");
  asrt(out.includes(`out=${sol6(NET)} SOL`), `plan shows the ammSellQuote net (${sol6(NET)} SOL), got: ${out}`);
  asrt(!out.includes(`out=${sol6(OLD_NET)} SOL`), "not the 30 bps figure");
  asrt(out.includes("fee=1.25% (125 bps, fallback)"), `plan names the real feeBps and feeSource, got: ${out}`);
  asrt(out.includes(`net ${NET} lamports, min_out ${MIN_OUT} lamports`), `plan shows min_out = quote x (1 - slip) = ${MIN_OUT}, got: ${out}`);
  asrt(!/sold /.test(out) && !/sell failed/.test(out) && !/simulation/.test(out), "plan only: nothing built, simulated or sent");
}

// --- 5. probe-sell-sim: the same quote, and the tx it simulates asks for AMM_SELL_CU_LIMIT ---
{
  const { c, out, err } = await run("probe-sell-sim.mjs", ["--mint", MINT, "--tokens", RAW.toString(), "--slip", String(SLIP)]);
  asrt(c === 0, `probe-sell-sim exits 0 (got ${c}): ${out}${err}`);
  asrt(/SIMULATION ONLY/.test(out) && /NOTHING WAS SENT/.test(out), "simulation only");
  asrt(out.includes(`fee 125 bps (fallback: lp 2 + protocol 93 + creator 30`) && out.includes(`net ${NET}, min_out ${MIN_OUT}`), `probe prints the real fee and min_out, got: ${out}`);
  const dir = path.join(process.env.ROOT, "data", "probe");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("sell-sim-"));
  asrt(files.length === 1, `one result file, got ${files.length}`);
  const res = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
  asrt(res.mode === "simulate-only" && res.err === null, "the fixture simulation passed");
  asrt(res.quote.feeBps === 125 && res.quote.feeSource === "fallback", `file: feeBps 125 / fallback, got ${res.quote.feeBps} / ${res.quote.feeSource}`);
  asrt(res.quote.fees.lpFeeBps === 2 && res.quote.fees.protocolFeeBps === 93 && res.quote.fees.creatorFeeBps === 30, "file: the fee split of the tier");
  asrt(res.quote.grossOut === GROSS.toString() && res.quote.netLamports === NET.toString(), `file: net ${res.quote.netLamports} = ${NET}`);
  asrt(res.quote.minOutLamports === MIN_OUT.toString(), `file: min_out ${res.quote.minOutLamports} = ${MIN_OUT}`);
  asrt(res.reserves.base === mock.BASE_RESERVE.toString() && res.reserves.quote === mock.QUOTE_RESERVE.toString(), "file: the reserves the quote used");
  asrt(res.logs.some((l) => l.includes("cu_limit=160000 cu_price=1500000")), `the SIMULATED tx requested AMM_SELL_CU_LIMIT (160000), fixture saw: ${res.logs.join(" | ")}`);
  asrt(res.cuLimit === 160_000, "file: the CU limit next to unitsConsumed");
  asrt(res.accounts.length === built.sellIx.keys.length, "the sell instruction has the accounts of ammSellIx");
}

// --- 6. source level: no private copy of the formula, the right limit in the right branch ---
const strip = (src) => src.replace(/\r\n/g, "\n");
{
  const src = strip(fs.readFileSync(path.join(root, "scripts", "rescue-sell.mjs"), "utf8"));
  asrt(/const quote = await ammSellQuote\(connection, mint, raw\)/.test(src), "rescue-sell prices the pool with ammSellQuote");
  asrt(!/10000 - feeBps|decodeGlobalConfig|lpFeeBps|coinCreatorFeeBps/.test(src), "rescue-sell has no copy of the GlobalConfig fee formula");
  // The live branches. Curve: computeBudgetIxs() (CU_LIMIT) + sellIx, unchanged.
  const iCurve = src.indexOf('if (q.venue === "curve") {');
  const iPool = src.indexOf("} else {", iCurve);
  const iEnd = src.indexOf("} catch (e) {", iPool);
  asrt(iCurve > 0 && iPool > iCurve && iEnd > iPool, "both live branches found");
  const curve = src.slice(iCurve, iPool);
  const pool = src.slice(iPool, iEnd);
  asrt(/\.\.\.computeBudgetIxs\(\),\n\s+sellIx\(/.test(curve) && !/AMM_SELL_CU_LIMIT|ammSellTxIxs/.test(curve), "curve sell: computeBudgetIxs() = CU_LIMIT, as before");
  asrt(/sendTxWithRetry\(tx, \{ skipPreflight: true \}\)/.test(curve), "curve sell: sender unchanged");
  asrt(/const \{ ixs \} = ammSellTxIxs\(wallet, new PublicKey\(h\.mint\), q\.quote, amountRaw, SLIP\);/.test(pool), "AMM sell: built by ammSellTxIxs from the ammSellQuote result");
  asrt(!/computeBudgetIxs\(|ammSellIx\(/.test(pool), "AMM sell: no hand-built budget / sell instruction left (so no CU_LIMIT)");
  asrt(/sendTxWithRetry\(tx, \{ skipPreflight: true, cuLimit: AMM_SELL_CU_LIMIT \}\)/.test(pool), "AMM sell: the sender is told the limit this tx requested");
  asrt((src.match(/computeBudgetIxs\(/g) || []).length === 1, "exactly one computeBudgetIxs() call in rescue-sell — the curve one");
  // The gates are where they were.
  asrt(/if \(LIVE && mintArg\.length === 0\) \{/.test(src) && /if \(!LIVE\) continue;/.test(src), "gates: --live needs --mint; plan mode never reaches the sell");
  asrt(/if \(q\.venue === "pool" && process\.env\.LIVE_CONFIRM_AMM !== "yes"\) \{/.test(src), "gate: the AMM sell needs LIVE_CONFIRM_AMM=yes");
  asrt(/const SLIP = numOr\(process\.env\.SELL_SLIPPAGE_BPS, 1000, "SELL_SLIPPAGE_BPS"\)/.test(src), "SELL_SLIPPAGE_BPS and its default are unchanged");
}
{
  const src = strip(fs.readFileSync(path.join(root, "scripts", "probe-sell-sim.mjs"), "utf8"));
  asrt(/const q = await ammSellQuote\(connection, mintPk, total\)/.test(src), "probe-sell-sim prices the pool with ammSellQuote");
  asrt(/const \{ ixs, minOut, sellIx \} = ammSellTxIxs\(wallet, mintPk, q, total, slip\);/.test(src), "probe-sell-sim builds the tx with ammSellTxIxs");
  asrt(!/10000 - feeBps|decodeGlobalConfig|lpFeeBps \+|coinCreatorFeeBps|computeBudgetIxs|ammSellIx\(/.test(src), "probe-sell-sim has no copy of the formula and no CU_LIMIT budget");
  asrt(!/TODO\(verify\) V4/.test(src), "the closed TODO(verify) V4 (fee split) is gone");
  asrt(!/sendTransaction|sendRawTransaction|sendTxWithRetry/.test(src.replace(/\/\/.*$/gm, "")), "probe-sell-sim still cannot send");
}

console.log(JSON.stringify({ gross: GROSS.toString(), net: NET.toString(), minOut: MIN_OUT.toString(), oldNet: OLD_NET.toString(), oldMinOut: OLD_MIN_OUT.toString(), feeBps: q.feeBps, feeSource: q.feeSource, ammCuLimit: AMM_SELL_CU_LIMIT, cuLimit: CU_LIMIT }));
console.log("PASS: rescue-amm-quote — rescue-sell and probe-sell-sim price the pool with ammSellQuote (real fee tier, not 30 bps), min_out = quote x (1 - slip), the AMM tx requests AMM_SELL_CU_LIMIT, the curve tx keeps CU_LIMIT, gates untouched");
