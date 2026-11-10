// Test (task 4): after migration the sell goes through lib/amm-sell.mjs — build, simulate, journal,
// and with DRY_SELL=yes it STOPS before sending. No RPC, no sendTransaction: everything injected.
import "./lib/test-env.mjs";
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ammSellOnce, chooseSellVenue } from "../lib/amm-sell.mjs";
import { WSOL } from "../lib/constants.mjs";

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
  lpFeeBps: 20, protocolFeeBps: 5, coinCreatorFeeBps: 5,
  protocolFeeRecipients: [pk(0x77)], reservedFeeRecipient: PublicKey.default, reservedFeeRecipients: [],
  buybackFeeRecipients: [pk(0x88)],
};
const QUOTE = { pool: pk(0x33), p, g, feeBps: 30, solOut: 100_000_000n };
const TOTAL = 5_000_000_000n;

// --- the venue the bot must pick once the curve is gone/complete ---
asrt(chooseSellVenue({ complete: true }) === "pumpswap", "a completed curve goes to PumpSwap");
asrt(chooseSellVenue(null) === "pumpswap", "a vanished curve goes to PumpSwap");
asrt(chooseSellVenue({ complete: false }) === "curve", "a live curve stays on the curve");

// --- DRY_SELL on a migrated position: built + simulated + journaled, never sent ---
{
  const journal = { entries: [], write(r) { this.entries.push(r); } };
  let sends = 0;
  let sims = 0;
  const res = await ammSellOnce({
    connection: { getAccountInfo: async () => null },
    wallet,
    mint: mintPk.toBase58(),
    mintPk,
    total: TOTAL,
    attempt: 1,
    slip: 500,
    live: true, // the operator is in LIVE mode with the AMM gate on...
    confirmAmm: "yes",
    drySell: true, // ...but DRY_SELL=yes stops the send
    journal,
    log: () => {},
    meta: { sessionId: "t", paramsHash: "p", gitSha: "g", maxAttempts: 3 },
    deps: {
      ammSellQuote: async () => {
        sims += 1;
        return QUOTE;
      },
      buildVersionedTx: async () => ({ fake: "tx" }),
      simulateTx: async () => ({ ok: true, err: null, logs: ["Program log: Instruction: Sell"], units: 60_000 }),
      sendTxWithRetry: async () => {
        sends += 1;
        return "SIGmustNotHappen";
      },
    },
  });

  asrt(res.status === "dry", `status is dry, got ${res.status}`);
  asrt(sends === 0, `sendTransaction was NOT called (got ${sends})`);
  asrt(sims === 1, "the sell was priced and simulated once");
  const types = journal.entries.map((e) => e.type);
  asrt(types.includes("sell_sim"), `the simulation is journaled (got ${types.join(",")})`);
  asrt(types.includes("sell_dry"), `sell_dry is journaled (got ${types.join(",")})`);
  const sim = journal.entries.find((e) => e.type === "sell_sim");
  asrt(sim.expectedSol === 0.1 && sim.unitsConsumed === 60_000, "sell_sim carries the expected SOL and CU");
  const dry = journal.entries.find((e) => e.type === "sell_dry");
  asrt(dry.sent === false && dry.reason === "DRY_SELL=yes", "sell_dry explains why nothing was sent");
  asrt(journal.entries.every((e) => e.sent === false), "no journal row claims a send");
}

// --- the bot wires exactly that: ammSellOnce + DRY_SELL, and no STUCK without attempts ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const sellFn = src.indexOf("async function sellPosition");
  const call = src.indexOf("ammSellOnce(", sellFn);
  asrt(sellFn > 0 && call > sellFn, "sellPosition calls ammSellOnce");
  asrt(/drySell: DRY_SELL/.test(src), "the bot passes DRY_SELL into the AMM sell");
  const gateBranch = src.slice(src.indexOf('if (amm.status === "gate" || amm.status === "no_pool")'), src.indexOf("if (amm.status === \"sim_fail\")"));
  asrt(/deferSell\(/.test(gateBranch), "gate/no-pool defer the position instead of marking it STUCK");
  asrt(!/markStuck\(/.test(gateBranch), "no STUCK is set for gate/no-pool");
  asrt(/if \(amm.status === "dry"\)/.test(src), "the dry path returns without accounting the sale");
}

console.log(JSON.stringify({ venue: "pumpswap", dry: true, sent: false }));
console.log("PASS: post-migration sell — simulated and journaled via DRY_SELL, never sent, position kept");
