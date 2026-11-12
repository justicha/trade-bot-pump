import "./lib/test-env.mjs";
// P0 (task 5): the pre-buy exit check simulated a SELL of tokens the wallet does not hold yet, so
// the program always answered 6023 NotEnoughTokensToSell and graduation never bought — dry or live.
// scripts/prebuy-sim.test.mjs could not catch it: its fake simulateTx ignores the token balance.
//
// Here the fake simulateTx KEEPS A TOKEN BALANCE from the transaction's own instructions (a pump
// buy adds, a pump sell needs the tokens), which is what the chain does:
//   - sell alone (the old transaction)  -> 6023
//   - buy + sell in one transaction     -> ok
// and the policy: LIVE blocks on a failed simulation, DRY RUN never does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const { simulateCurveSell, preBuyCheck, stateAfterBuy, DRY_SIM_BALANCE_MARGIN_SOL } = await import("../lib/prebuy-sim.mjs");
const { buyIx, calcBuyTokens, calcSellSol, solToLamports } = await import("../lib/pumpfun.mjs");
const { PUMP_PROGRAM, ATA_PROGRAM } = await import("../lib/constants.mjs");
const { CU_LIMIT } = await import("../lib/config.mjs");
const { readJournal } = await import("../lib/journal.mjs");

const BUY_DISC = "66063d1201daebea";
const SELL_DISC = "33e685a4017f83ad";
const pk = (b) => new PublicKey(Buffer.alloc(32, b));
const wallet = Keypair.generate();
const mintPk = pk(0x22);
const state = {
  address: pk(0x11),
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 100_000_000_000n,
  realTokenReserves: 793_000_000_000_000n,
  realSolReserves: 70_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: pk(0x09).toBase58(),
  isMayhemMode: false,
};
const BUY_SOL = 0.02;
const SLIP = 500;
// Exactly what graduation.mjs computes for the real buy.
const expectedTokens = calcBuyTokens(state, BUY_SOL);
const minTokens = (expectedTokens * BigInt(10000 - SLIP)) / 10000n;
const maxSolCost = solToLamports(BUY_SOL * (1 + SLIP / 10000));

// --- a simulateTx that keeps the wallet's token balance, like the chain ------------------------
function ledgerSim({ startTokens = 0n } = {}) {
  return async (tx) => {
    let balance = startTokens;
    const logs = [];
    for (let i = 0; i < tx.ixs.length; i++) {
      const ix = tx.ixs[i];
      if (!ix.programId.equals(PUMP_PROGRAM)) continue;
      const disc = ix.data.subarray(0, 8).toString("hex");
      const amount = ix.data.readBigUInt64LE(8);
      if (disc === BUY_DISC) {
        logs.push("Program log: Instruction: Buy");
        balance += amount;
      } else if (disc === SELL_DISC) {
        logs.push("Program log: Instruction: Sell");
        if (balance < amount) {
          logs.push("Program log: AnchorError: NotEnoughTokensToSell", `Program log: Left: ${balance}`, `Program log: Right: ${amount}`);
          return { ok: false, err: { InstructionError: [i, { Custom: 6023 }] }, logs, units: 30_000 };
        }
        balance -= amount;
      }
    }
    return { ok: true, err: null, logs, units: 150_000 };
  };
}
function harness(simOpts) {
  const built = [];
  return {
    built,
    deps: {
      buildVersionedTx: async (_w, ixs) => {
        built.push(ixs);
        return { ixs };
      },
      simulateTx: ledgerSim(simOpts),
    },
  };
}
const pumpIxs = (ixs) => ixs.filter((ix) => ix.programId.equals(PUMP_PROGRAM));
const disc = (ix) => ix.data.subarray(0, 8).toString("hex");

// --- the OLD transaction (sell alone) fails exactly like the real dry run did ------------------
{
  const h = harness();
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, deps: h.deps });
  asrt(res.ok === false, "sell alone: the wallet holds no tokens before the buy -> the simulation fails");
  asrt(/6023/.test(res.reason), `the reason is 6023 NotEnoughTokensToSell, got: ${res.reason}`);
  asrt(res.logs.some((l) => /Left: 0/.test(l)) && res.logs.some((l) => l === `Program log: Right: ${minTokens}`), "program logs: Left: 0 / Right: <tokens> (as in the real run)");
  asrt(pumpIxs(h.built[0]).length === 1 && disc(pumpIxs(h.built[0])[0]) === SELL_DISC, "that transaction has only the sell");
}

// --- the NEW transaction: buy + sell, in that order, same tokens ------------------------------
{
  const h = harness();
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, buy: { solAmount: BUY_SOL, maxSolCost }, deps: h.deps });
  asrt(res.ok === true, `buy+sell passes on the same balance-keeping simulator (got ${res.reason ?? "ok"})`);
  asrt(res.withBuy === true, "the result says the buy leg was included");
  const ixs = h.built[0];
  const pump = pumpIxs(ixs);
  asrt(pump.length === 2 && disc(pump[0]) === BUY_DISC && disc(pump[1]) === SELL_DISC, "pump instructions: buy first, then sell");
  const ata = ixs.find((ix) => ix.programId.equals(ATA_PROGRAM));
  asrt(ata && ixs.indexOf(ata) < ixs.indexOf(pump[0]), "the user ATA is created before the buy");
  asrt(pump[0].data.readBigUInt64LE(8) === minTokens && pump[1].data.readBigUInt64LE(8) === minTokens, "the sell offers exactly the tokens the buy takes (minTokens)");
  asrt(pump[0].data.readBigUInt64LE(16) === maxSolCost, "the simulated buy has the real buy's max_sol_cost");
  // The buy instruction is the bot's own buyIx, byte for byte (accounts may pick a random fee
  // recipient, the data cannot differ).
  const ref = buyIx(wallet.publicKey, mintPk, BUY_SOL, minTokens, { creator: new PublicKey(state.creator), isMayhem: false, maxSolCost });
  asrt(pump[0].data.equals(ref.data) && pump[0].keys.length === ref.keys.length, "the buy leg is the unmodified buyIx (same bytes, same account count)");
  // The sell is quoted on the post-buy reserves, minus the slippage bound.
  const after = stateAfterBuy(state, minTokens);
  asrt(res.quote === calcSellSol(after, minTokens), "the sell leg is quoted on the reserves AFTER the buy");
  asrt(pump[1].data.readBigUInt64LE(16) === (res.quote * 9500n) / 10000n, "min_out = that quote minus the 5% bound");
  asrt(res.quote > calcSellSol(state, minTokens), "(the pre-buy reserves would quote less: the buy moved the price up)");
  // A round trip returns about what went in, minus the two 1% fees.
  const ratio = Number(res.quote) / Number(solToLamports(BUY_SOL));
  asrt(ratio > 0.92 && ratio < 0.99, `buy->sell round trip returns ~93-98% of the buy (got ${(ratio * 100).toFixed(2)}%)`);
  // Compute budget: doubled for the two-leg simulation only.
  const cu = (list) => list[0].data.readUInt32LE(1);
  asrt(cu(ixs) === 2 * CU_LIMIT, `buy+sell simulation asks for 2x CU_LIMIT (got ${cu(ixs)})`);
  const h1 = harness({ startTokens: minTokens });
  await simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, deps: h1.deps });
  asrt(cu(h1.built[0]) === CU_LIMIT, "a plain sell simulation keeps the normal CU limit");
}

// A wallet that already holds the tokens can still be checked with the sell alone.
{
  const h = harness({ startTokens: minTokens });
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, deps: h.deps });
  asrt(res.ok === true && res.withBuy === false, "sell alone is valid when the tokens are already in the wallet");
}

// --- the policy: LIVE blocks, DRY RUN never does ---------------------------------------------
const simFail = async () => simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, deps: harness().deps }); // sell alone -> 6023
const simOk = async () => simulateCurveSell({ wallet, mintPk, state, tokens: minTokens, buy: { solAmount: BUY_SOL, maxSolCost }, deps: harness().deps });
const rich = async () => 5;
{
  const live = await preBuyCheck({ live: true, maxSolCost, simulate: simFail });
  asrt(live.block === true && /^fail:.*6023/.test(live.preBuySim), `LIVE: a failed simulation blocks the buy (${live.preBuySim})`);
  asrt(live.sim.logs.length > 0, "LIVE: the program logs are kept for the journal");
  const liveOk = await preBuyCheck({ live: true, maxSolCost, simulate: simOk });
  asrt(liveOk.block === false && liveOk.preBuySim === "ok", "LIVE: a passing simulation lets the buy through");
  const liveThrow = await preBuyCheck({ live: true, maxSolCost, simulate: async () => { throw new Error("rpc down"); } });
  asrt(liveThrow.block === true && liveThrow.preBuySim === "fail:rpc down", "LIVE: a simulation that cannot run cannot prove the exit -> no buy");
  // LIVE never consults the balance: a poor wallet simply fails the simulation.
  let asked = 0;
  await preBuyCheck({ live: true, maxSolCost, getBalanceSol: async () => { asked += 1; return 0; }, simulate: simOk });
  asrt(asked === 0, "LIVE: no balance pre-check");
}
{
  const dry = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: rich, simulate: simFail });
  asrt(dry.block === false, "DRY RUN: a failed simulation does NOT block the entry");
  asrt(/^fail:.*6023/.test(dry.preBuySim), `DRY RUN: the failure is journaled as fail:<reason> (${dry.preBuySim})`);
  const dryOk = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: rich, simulate: simOk });
  asrt(dryOk.block === false && dryOk.preBuySim === "ok", "DRY RUN: ok is journaled as ok");

  let ran = 0;
  const need = Number(maxSolCost) / 1e9 + DRY_SIM_BALANCE_MARGIN_SOL;
  const poor = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: async () => need - 0.000001, simulate: async () => { ran += 1; return simOk(); } });
  asrt(poor.block === false && poor.preBuySim === "skipped:low-balance" && ran === 0, "DRY RUN: balance < maxSolCost + 0.01 -> not simulated, skipped:low-balance");
  asrt(DRY_SIM_BALANCE_MARGIN_SOL === 0.01, "the margin is 0.01 SOL");
  const edge = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: async () => need, simulate: simOk });
  asrt(edge.preBuySim === "ok", "DRY RUN: exactly maxSolCost + 0.01 is enough to simulate");
  const noBal = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: async () => { throw new Error("rpc"); }, simulate: simOk });
  asrt(noBal.block === false && noBal.preBuySim === "skipped:balance-unavailable", "DRY RUN: an unreadable balance skips the simulation");
  const dryThrow = await preBuyCheck({ live: false, maxSolCost, getBalanceSol: rich, simulate: async () => { throw new Error("rpc down"); } });
  asrt(dryThrow.block === false && dryThrow.preBuySim === "skipped:error: rpc down", "DRY RUN: a simulation that cannot run is skipped, never blocking");
}

// --- wiring: graduation builds the simulation from the real buy's numbers ----------------------
{
  const src = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.slice(src.indexOf("async function buyToken"), src.indexOf("async function checkExit"));
  asrt(/simulateCurveSell\(\{ wallet, mintPk, state, tokens: minTokens, buy: \{ solAmount: BUY_SOL, maxSolCost \} \}\)/.test(fn), "graduation simulates BUY+SELL of minTokens with the buy's maxSolCost");
  asrt(/preBuyCheck\(\{\s*live: LIVE,/.test(fn) && /if \(pre\.block\) \{/.test(fn), "the block decision comes from preBuyCheck (LIVE only)");
  asrt((fn.match(/const maxSolCost = /g) || []).length === 1 && (fn.match(/const minTokens = /g) || []).length === 1, "one definition of minTokens / maxSolCost for the simulation AND the real buy");
  asrt(fn.indexOf("preBuyCheck(") < fn.indexOf("if (DRY_RUN) {"), "the simulation runs before the dry/live split");
  asrt(/type: "prebuy_sim"/.test(fn) && /preBuySim: pre\.preBuySim/.test(fn), "the result is journaled as preBuySim");
  asrt(!/tokens: wouldBuyTokens \}\)/.test(src), "the sell-alone pre-buy simulation is gone");
}

// --- end to end: a DRY RUN whose every simulation fails with 6023 still enters ---------------
{
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), "prebuy-e2e-journal-"));
  const env = cleanEnv({
    RPC_URL: "http://127.0.0.1:1",
    RPC_MOCK: path.join(here, "mocks", "rpc-mock-simfail.mjs"),
    WS_MOCK: path.join(here, "mocks", "grad-ws-mock.mjs"),
    KEYS_DIR: makeTempKeys(),
    JOURNAL_DIR: jdir,
    GRAD_BUY_SOL: "0.02",
    GRAD_MIN_FILL_PCT: "92",
    GRAD_MAX_FILL_PCT: "97",
    MIN_HOLDERS: "0",
    GRAD_MAX_POSITIONS: "3",
    GRAD_MAX_SEC: "3",
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "--dry-run"], { cwd: root, env });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (out += String(b)));
  await new Promise((resolve) => {
    const killer = setTimeout(() => child.kill(), 30_000);
    child.on("exit", () => {
      clearTimeout(killer);
      resolve();
    });
  });
  asrt(/\[DRY RUN\] position tracked/.test(out), "dry run: the candidate is ENTERED although the simulation failed");
  asrt(/pre-buy simulation fail:.*6023.*entry not blocked/.test(out), "dry run: the failure is logged as informational");
  asrt(!/skip: curve sell simulation failed/.test(out), "dry run: the candidate is not rejected by the simulation");
  const rows = readJournal(jdir).filter((r) => r.type === "prebuy_sim");
  asrt(rows.length === 1 && rows[0].mode === "DRY" && rows[0].blocked === false && /^fail:.*6023/.test(rows[0].preBuySim), `journal: one prebuy_sim row, fail, not blocked (${JSON.stringify(rows.map((r) => r.preBuySim))})`);
  asrt(Array.isArray(rows[0].logs) && rows[0].logs.some((l) => /Left: 0/.test(l)), "journal: the program logs of the failed simulation are kept");
  fs.rmSync(jdir, { recursive: true, force: true });
}

console.log(JSON.stringify({ sellAlone: "6023", buyThenSell: "ok", dryBlocks: false, liveBlocks: true }));
console.log("PASS: pre-buy check simulates buy+sell in one transaction; LIVE blocks on failure, DRY RUN never does");
