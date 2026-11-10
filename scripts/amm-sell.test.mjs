// Unit: one PumpSwap sell attempt (lib/amm-sell.mjs) with a fully faked network.
//
// Proves the behaviour AUDIT_SELL.md asks for:
//   - the LIVE_CONFIRM_AMM gate and a missing pool return "gate"/"no_pool" WITHOUT sending, so the
//     caller can keep the position instead of dropping it at attempts=0;
//   - a failed simulation journals the error AND the full program logs, and is never sent;
//   - a passing simulation journals the expected SOL BEFORE the send;
//   - DRY_SELL=yes builds + simulates + journals and never calls sendTransaction.
// No RPC, no sendTransaction: every network function is injected.
import "./lib/test-env.mjs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { ammSellOnce, chooseSellVenue, isDrySell } from "../lib/amm-sell.mjs";
import { WSOL } from "../lib/constants.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const pk = (b) => new PublicKey(Buffer.alloc(32, b));

const wallet = Keypair.generate();
const mintPk = pk(0x22);
const p = {
  baseMint: mintPk,
  quoteMint: WSOL,
  baseVault: pk(0x44),
  quoteVault: pk(0x55),
  coinCreator: pk(0x66),
  isMayhem: false,
  isCashback: false,
};
const g = {
  lpFeeBps: 20,
  protocolFeeBps: 5,
  coinCreatorFeeBps: 5,
  protocolFeeRecipients: [pk(0x77)],
  reservedFeeRecipient: PublicKey.default,
  reservedFeeRecipients: [],
  buybackFeeRecipients: [],
};
const QUOTE = { pool: pk(0x33), p, g, feeBps: 30, solOut: 100_000_000n }; // 0.1 SOL net
const TOTAL = 5_000_000_000n;
const SIM_OK = { ok: true, err: null, logs: ["Program log: Instruction: Sell"], units: 61_234 };
const SIM_FAIL = {
  ok: false,
  err: { InstructionError: [2, { Custom: 6005 }] },
  logs: ["Program log: Instruction: Sell", "Program log: AnchorError occurred. Error Code: NotEnoughTokens"],
  units: 12_345,
};

function harness({ quote = QUOTE, sim = SIM_OK } = {}) {
  const journal = { entries: [], write(r) { this.entries.push(r); } };
  const calls = { quote: 0, build: 0, sim: 0, send: 0, simRowsAtSend: null };
  const deps = {
    ammSellQuote: async () => {
      calls.quote += 1;
      return quote;
    },
    buildVersionedTx: async () => {
      calls.build += 1;
      return { fake: "tx" };
    },
    simulateTx: async () => {
      calls.sim += 1;
      return sim;
    },
    sendTxWithRetry: async () => {
      calls.send += 1;
      calls.simRowsAtSend = journal.entries.filter((r) => r.type === "sell_sim").length;
      return "SIGfixture";
    },
  };
  const run = (over = {}) =>
    ammSellOnce({
      connection: { getAccountInfo: async () => null },
      wallet,
      mint: mintPk.toBase58(),
      mintPk,
      total: TOTAL,
      attempt: 1,
      slip: 500,
      live: true,
      confirmAmm: "yes",
      journal,
      log: () => {},
      meta: { sessionId: "t", paramsHash: "p", gitSha: "g", maxAttempts: 3 },
      deps,
      ...over,
    });
  return { journal, calls, run };
}

// --- venue choice ---
asrt(chooseSellVenue({ complete: false }) === "curve", "live curve -> curve venue");
asrt(chooseSellVenue({ complete: true }) === "pumpswap", "completed curve -> PumpSwap");
asrt(chooseSellVenue(null) === "pumpswap", "gone curve -> PumpSwap");

// --- DRY_SELL parsing: only an explicit yes/1/true can ever stop a send ---
for (const yes of ["yes", "YES", "1", "true", " true "]) asrt(isDrySell({ DRY_SELL: yes }), `DRY_SELL=${yes} is on`);
for (const no of [undefined, "", "no", "0", "false", "yess", "off"]) asrt(!isDrySell({ DRY_SELL: no }), `DRY_SELL=${no} is off`);

// --- gate: LIVE without LIVE_CONFIRM_AMM must not even price the sell ---
{
  const h = harness();
  const r = await h.run({ confirmAmm: undefined });
  asrt(r.status === "gate", `gate status, got ${r.status}`);
  asrt(h.calls.quote === 0 && h.calls.build === 0 && h.calls.sim === 0 && h.calls.send === 0, "gate: nothing built, nothing sent");
  asrt(h.journal.entries.length === 0, "gate: no journal rows");
  const r2 = await h.run({ confirmAmm: "no" });
  asrt(r2.status === "gate", "gate also rejects any value other than yes");
}

// --- no pool: quote null -> no_pool, nothing built, nothing sent ---
{
  const h = harness({ quote: null });
  const r = await h.run();
  asrt(r.status === "no_pool", `no_pool status, got ${r.status}`);
  asrt(h.calls.build === 0 && h.calls.sim === 0 && h.calls.send === 0, "no_pool: nothing built or sent");
}

// --- failed simulation: journal the error + FULL logs, never send ---
{
  const h = harness({ sim: SIM_FAIL });
  const r = await h.run();
  asrt(r.status === "sim_fail", `sim_fail status, got ${r.status}`);
  asrt(h.calls.send === 0, "sim_fail: sendTransaction not called");
  const row = h.journal.entries.find((e) => e.type === "sell_attempt");
  asrt(row, "sim_fail: sell_attempt journaled");
  asrt(row.simulationResult === "fail" && row.sent === false, "sim_fail row marked fail/not sent");
  asrt(typeof row.error === "string" && row.error.length > 0, "sim_fail row carries the error text");
  asrt(Array.isArray(row.logs) && row.logs.length === SIM_FAIL.logs.length, "sim_fail row carries EVERY program log line");
  asrt(row.logs[1].includes("AnchorError"), "sim_fail row keeps the Anchor error line");
  asrt(row.unitsConsumed === 12_345, "sim_fail row carries unitsConsumed");
  asrt(row.venue === "pumpswap" && row.mint === mintPk.toBase58() && row.attempt === 1, "sim_fail row identifies mint/venue/attempt");
  asrt(row.tokens === TOTAL.toString(), "sim_fail row carries the token amount");
}

// --- passing simulation: expectation journaled BEFORE the send, then the send ---
{
  const h = harness();
  const r = await h.run();
  asrt(r.status === "sent" && r.sig === "SIGfixture", `sent with sig, got ${r.status}/${r.sig}`);
  asrt(h.calls.send === 1, "sent: exactly one sendTransaction");
  asrt(h.calls.simRowsAtSend === 1, "sent: the sell_sim row existed BEFORE sendTxWithRetry ran");
  const sim = h.journal.entries.find((e) => e.type === "sell_sim");
  asrt(sim, "sent: sell_sim journaled");
  asrt(sim.expectedSol === 0.1 && sim.quoteOut === 0.1, `sell_sim carries the expected 0.1 SOL, got ${sim.expectedSol}`);
  asrt(sim.minOut === ((QUOTE.solOut * 9500n) / 10000n).toString(), "sell_sim min_out = quote * (1 - slip)");
  asrt(sim.unitsConsumed === 61_234, "sell_sim carries unitsConsumed");
  asrt(sim.logs.length === SIM_OK.logs.length, "sell_sim carries the simulation logs");
  asrt(r.amountRaw === TOTAL, "returned amountRaw is the full balance");
}

// --- DRY_SELL=yes: built + simulated + journaled, NEVER sent ---
{
  const h = harness();
  const r = await h.run({ drySell: true });
  asrt(r.status === "dry", `dry status, got ${r.status}`);
  asrt(h.calls.build === 1 && h.calls.sim === 1, "dry: the transaction WAS built and simulated");
  asrt(h.calls.send === 0, "dry: sendTransaction NOT called");
  const types = h.journal.entries.map((e) => e.type);
  asrt(types.join(",") === "sell_sim,sell_dry", `dry: journal order sell_sim,sell_dry, got ${types.join(",")}`);
  const dry = h.journal.entries[1];
  asrt(dry.sent === false && dry.reason === "DRY_SELL=yes", "dry row says why it was not sent");
}

// --- a send error must propagate (the caller reconciles a possibly-landed tx via err.sig) ---
{
  const h = harness();
  const err = new Error("confirm failed");
  err.sig = "SIGlanded";
  let thrown = null;
  try {
    await h.run({
      deps: {
        ammSellQuote: async () => QUOTE,
        buildVersionedTx: async () => ({}),
        simulateTx: async () => SIM_OK,
        sendTxWithRetry: async () => {
          throw err;
        },
      },
    });
  } catch (e) {
    thrown = e;
  }
  asrt(thrown === err, "a send error is thrown, not swallowed");
  asrt(thrown.sig === "SIGlanded", "the thrown error keeps .sig for reconciliation");
}

console.log("PASS: amm-sell — gate/no_pool keep the position, sim logs journaled, sell_sim before send, DRY_SELL never sends");
