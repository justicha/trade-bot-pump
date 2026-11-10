// Unit: sell-all (lib/sell-all.mjs) with every chain/network call faked.
//
// Covers: plan-only by default (no send), pool tokens skipped without LIVE_CONFIRM_AMM, tokens
// with no venue skipped, a failed simulation never sent while the NEXT token is still processed,
// and the --live CLI gate that refuses to run without LIVE_CONFIRM=yes.
// No RPC, no sendTransaction: the fakes below are the only "network".
import "./lib/test-env.mjs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSellAll } from "../lib/sell-all.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const pk = (b) => new PublicKey(Buffer.alloc(32, b));

const MINT_CURVE = pk(0x01);
const MINT_FAIL = pk(0x02);
const MINT_POOL = pk(0x03);
const MINT_NONE = pk(0x04);
const MINT_ZERO = pk(0x05); // holds nothing -> must not appear at all
const CREATOR = pk(0x09);
const BALANCE = 1_000_000_000_000n;
const wallet = Keypair.generate();

const tokenAccount = (mint, amount) => {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  wallet.publicKey.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  return { account: { data: [d.toString("base64"), "base64"] } };
};

const connection = {
  async getTokenAccountsByOwner() {
    return {
      value: [
        tokenAccount(MINT_FAIL, BALANCE),
        tokenAccount(MINT_CURVE, BALANCE),
        tokenAccount(MINT_POOL, BALANCE),
        tokenAccount(MINT_NONE, BALANCE),
        tokenAccount(MINT_ZERO, 0n),
      ],
    };
  },
};

const curveState = {
  address: pk(0x11),
  virtualTokenReserves: 1_000_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 720_100_000_000_000n,
  realSolReserves: 5_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
  creator: CREATOR.toBase58(),
  isMayhemMode: false,
};

function harness({ simulateFails = true } = {}) {
  const journal = { entries: [], write(r) { this.entries.push(r); } };
  const sent = [];
  const ammCalls = [];
  const deps = {
    getBondingCurveState: async (mintPk) =>
      mintPk.equals(MINT_CURVE) || mintPk.equals(MINT_FAIL) ? curveState : null, // pool/none: curve gone
    ammSellQuote: async (_conn, mintPk) =>
      mintPk.equals(MINT_POOL) ? { pool: pk(0x21), p: {}, g: {}, feeBps: 30, solOut: 50_000_000n } : null,
    simulateTx: async (tx) => {
      const touchesFail =
        simulateFails &&
        (tx.ixs ?? []).some((ix) => (ix.keys ?? []).some((k) => k.pubkey.equals(MINT_FAIL)));
      return touchesFail
        ? { ok: false, err: { InstructionError: [2, { Custom: 6005 }] }, logs: ["Program log: Instruction: Sell", "Program log: AnchorError: AccountNotEnoughKeys"], units: 4321 }
        : { ok: true, err: null, logs: ["Program log: Instruction: Sell"], units: 1234 };
    },
    buildVersionedTx: async (_wallet, ixs) => ({ ixs }),
    sendTxWithRetry: async (tx) => {
      const mint = tx.ixs
        .flatMap((ix) => ix.keys ?? [])
        .map((k) => k.pubkey)
        .find((k) => k.equals(MINT_CURVE) || k.equals(MINT_FAIL));
      sent.push(mint ? mint.toBase58() : "unknown");
      return "SIG" + sent.length;
    },
    readExecution: async () => ({ found: true, solReceivedSol: 0.03, rentReturnedSol: 0 }),
    ammSellOnce: async (opts) => {
      ammCalls.push(opts.mint);
      return { status: "sent", sig: "SIGPOOL", quote: 50_000_000n, amountRaw: BALANCE, sim: { ok: true, logs: [] } };
    },
  };
  const run = (over = {}) => {
    const out = [];
    return runSellAll({
      connection,
      wallet,
      journal,
      log: (s = "") => out.push(s),
      live: false,
      confirmAmm: undefined,
      slip: 1000,
      session: { sessionId: "t", paramsHash: "p", gitSha: "g" },
      deps,
      ...over,
    }).then((res) => ({ res, out: out.join("\n") }));
  };
  return { journal, sent, ammCalls, run };
}

const types = (j) => j.entries.map((e) => e.type);
const count = (j, t) => types(j).filter((x) => x === t).length;

// --- 1) default run: plan only, nothing sent even though balances exist ---
{
  const h = harness();
  const { res, out } = await h.run();
  asrt(h.sent.length === 0, `default run must send nothing, got ${h.sent.length} send(s)`);
  asrt(h.ammCalls.length === 0, "default run must not enter the PumpSwap path");
  asrt(res.sold === 0, `default run sells 0, got ${res.sold}`);
  asrt(res.skipped === 2, `the pool token and the no-venue token are skipped, got ${res.skipped}`);
  asrt(/PLAN ONLY, nothing was sent/.test(out), "the summary says it was a plan");
  asrt(count(h.journal, "sell_all_plan") === 4, `4 plan rows (zero balance excluded), got ${count(h.journal, "sell_all_plan")}`);
  asrt(!out.includes(MINT_ZERO.toBase58()), "a zero balance never appears in the plan");
  asrt(/blocked: PumpSwap sell unverified/.test(out), "pool token is marked blocked without LIVE_CONFIRM_AMM");
  asrt(/blocked: no sellable venue/.test(out), "no-venue token is skipped with the documented reason");
  const reasons = h.journal.entries.filter((e) => e.type === "sell_all_skipped").map((e) => e.reason);
  asrt(reasons.includes("PumpSwap sell unverified") && reasons.includes("no sellable venue"), "skip reasons journaled");
}

// --- 2) live without LIVE_CONFIRM_AMM: curve sells, pool skipped, no send for a failed sim ---
{
  const h = harness();
  const { res, out } = await h.run({ live: true, confirmAmm: undefined });
  asrt(h.sent.length === 1, `exactly one sell was sent (ACCOUNT order FAIL, CURVE), got ${h.sent.length}`);
  asrt(h.sent[0] === MINT_CURVE.toBase58(), `the sent token is the curve one, got ${h.sent[0]}`);
  asrt(!h.sent.includes(MINT_FAIL.toBase58()), "the failed simulation was NOT sent");
  asrt(h.ammCalls.length === 0, "the pool token was not priced/sold without LIVE_CONFIRM_AMM");
  asrt(res.sold === 1 && res.failed === 1 && res.skipped === 2, `counts sold/failed/skipped = 1/1/2, got ${res.sold}/${res.failed}/${res.skipped}`);
  asrt(/simulation failed: .*not sending this token/.test(out), "the failed simulation is reported as not sent");
  asrt(/AnchorError: AccountNotEnoughKeys/.test(out), "the failed simulation prints the full program logs");
  asrt(/continuing with the next token/.test(out) === false, "no bogus 'continuing' line for the curve failure");
  asrt(out.indexOf("not sending this token") < out.indexOf("sold: 0.030000 SOL"), "the token after the failure was still processed");
  const failed = h.journal.entries.find((e) => e.type === "sell_all_failed");
  asrt(failed && failed.sent === false && failed.logs.length === 2, "sell_all_failed journaled with the logs and sent:false");
  asrt(count(h.journal, "sell_all_sent") === 1, "one sell_all_sent row");
}

// --- 3) live WITH LIVE_CONFIRM_AMM: the pool token goes through lib/amm-sell.mjs ---
{
  const h = harness();
  const { res, out } = await h.run({ live: true, confirmAmm: "yes" });
  asrt(h.ammCalls.length === 1 && h.ammCalls[0] === MINT_POOL.toBase58(), `pool sold via ammSellOnce, got ${JSON.stringify(h.ammCalls)}`);
  asrt(h.sent.length === 1, "the curve token is still sent once (ammSellOnce is faked, so it adds no send)");
  asrt(res.sold === 2, `both sellable tokens count as sold, got ${res.sold}`);
  asrt(!/blocked: PumpSwap sell unverified/.test(out), "with the AMM gate the pool token is no longer blocked");
  asrt(/sold: 0.030000 SOL/.test(out), "the pool sell reports the received SOL");
  const poolPlan = h.journal.entries.find((e) => e.type === "sell_all_plan" && e.venue === "pool");
  asrt(poolPlan && poolPlan.status === "ready", "the pool plan row says ready when the AMM gate is on");
}

// --- 4) the CLI refuses --live without LIVE_CONFIRM=yes, before any RPC client exists ---
{
  const env = { ...process.env, RPC_URL: "http://127.0.0.1:1", LIVE_CONFIRM: "" };
  delete env.RPC_MOCK;
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, "sell-all.mjs"), "--live"], { cwd: path.join(here, ".."), env });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 15000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err });
    });
  });
  asrt(res.c === 1, `--live without LIVE_CONFIRM exits 1, got ${res.c}`);
  asrt(/LIVE_CONFIRM/.test(res.out + res.err), `the error names LIVE_CONFIRM, got: ${(res.out + res.err).trim().slice(0, 120)}`);
  asrt(!/mint\s+balance/.test(res.out), "it exits before reading any holdings");
  asrt(!/holdings:/.test(res.out), "no holdings were read");
}

console.log(JSON.stringify({ planOnly: true, simFailSkipsToken: true, poolGate: true, cliGate: true }));
console.log("PASS: sell-all — plan only by default, pool needs LIVE_CONFIRM_AMM, failed sim never sent, --live gated");
