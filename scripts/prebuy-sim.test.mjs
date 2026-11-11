// Unit: the pre-buy curve sell simulation (task 3) with a faked transaction/simulation layer.
//
// The bot builds a real curve sell for the tokens it is about to buy and only simulates it; a
// failing simulation must mean "no buy". No RPC here: buildVersionedTx/simulateTx are injected.
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { simulateCurveSell } from "../lib/prebuy-sim.mjs";
import { calcSellSol } from "../lib/pumpfun.mjs";
import { ATA_PROGRAM } from "../lib/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const pk = (b) => new PublicKey(Buffer.alloc(32, b));
const wallet = Keypair.generate();
const mintPk = pk(0x22);
const TOKENS = 1_000_000_000_000n;
const state = {
  address: pk(0x11),
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 90_000_000_000n,
  realTokenReserves: 793_000_000_000_000n,
  realSolReserves: 60_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: pk(0x09).toBase58(),
  isMayhemMode: false,
};

const SIM_OK = { ok: true, err: null, logs: ["Program log: Instruction: Sell"], units: 55_000 };
const SIM_FAIL = {
  ok: false,
  err: { InstructionError: [1, { Custom: 6024 }] },
  logs: ["Program log: Instruction: Sell", "Program log: Error: overflow"],
  units: 44_000,
};

function harness({ sim = SIM_OK } = {}) {
  const built = [];
  const deps = {
    buildVersionedTx: async (_w, ixs) => {
      built.push(ixs);
      return { ixs };
    },
    simulateTx: async () => sim,
  };
  return { built, deps };
}

// --- a healthy curve: the sell simulates, the whole position is offered ---
{
  const h = harness();
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: TOKENS, deps: h.deps });
  asrt(res.ok === true, `simulation passes (got ${res.reason ?? "ok"})`);
  asrt(res.quote === calcSellSol(state, TOKENS), "the quote is the same curve math the bot uses for TP/SL");
  asrt(res.quote > 0n, "the quote is positive");
  asrt(h.built.length === 1, "exactly one transaction was built");
  const sellIx = h.built[0].at(-1);
  asrt(sellIx.data.readBigUInt64LE(8) === TOKENS, "the sell offers the FULL position");
  asrt(sellIx.data.readBigUInt64LE(16) === (res.quote * 9500n) / 10000n, "min_out is the quote minus the 5% slip");
  asrt(sellIx.data.subarray(0, 8).toString("hex") === "33e685a4017f83ad", "it is the curve sell instruction");
}

// --- the sim creates the user ATA first, exactly like the real buy does ---
{
  const h = harness();
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: TOKENS, deps: h.deps });
  asrt(res.ok === true, "simulation passes with the ATA create");
  const ixs = h.built[0];
  const sellIx = ixs.at(-1);
  const ataIx = ixs.find((ix) => ix.programId.equals(ATA_PROGRAM) && ix.data.length === 1 && ix.data[0] === 1);
  asrt(!!ataIx, "the transaction creates the associated token account (idempotent)");
  asrt(ixs.indexOf(ataIx) < ixs.indexOf(sellIx), "the ATA create runs before the curve sell");
}

// --- a failing simulation must refuse the buy ---
{
  const h = harness({ sim: SIM_FAIL });
  const res = await simulateCurveSell({ wallet, mintPk, state, tokens: TOKENS, deps: h.deps });
  asrt(res.ok === false, "a failed sell simulation refuses the buy");
  asrt(typeof res.reason === "string" && res.reason.length > 0, "the reason is human readable");
  asrt(/6024|overflow/i.test(res.reason + " " + res.logs.join(" ")), `the program error is kept: ${res.reason}`);
  asrt(res.logs.length === 2, "the full program logs are returned for the journal");
  asrt(res.units === 44_000, "unitsConsumed is returned");
}

// --- missing inputs are refused instead of building a bogus sell ---
{
  const h = harness();
  const noCreator = await simulateCurveSell({ wallet, mintPk, state: { ...state, creator: null }, tokens: TOKENS, deps: h.deps });
  asrt(noCreator.ok === false && /creator unknown/.test(noCreator.reason), "a curve without a creator cannot be verified");
  const zero = await simulateCurveSell({ wallet, mintPk, state, tokens: 0n, deps: h.deps });
  asrt(zero.ok === false && /no tokens/.test(zero.reason), "a zero position is refused");
  asrt(h.built.length === 0, "nothing is built for invalid input");
}

// --- the bot runs this check before it sends a buy ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.indexOf("async function buyToken");
  const sim = src.indexOf("simulateCurveSell(", fn);
  const send = src.indexOf("sendTxWithRetry(", fn);
  asrt(sim > fn, "buyToken calls simulateCurveSell");
  asrt(send === -1 || sim < send, "the sell simulation runs before the buy is sent");
  asrt(/curve sell simulation failed/.test(src), "a failure is logged with the reason");
}

console.log(JSON.stringify({ quoteSol: Number(calcSellSol(state, TOKENS)) / 1e9, refusal: true }));
console.log("PASS: pre-buy sell simulation — a curve that cannot sell the position blocks the buy");
