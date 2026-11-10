// C5 unit: readExecution resolves actual fills from transaction meta (token/SOL deltas) and reports
// found:false when the meta has not landed yet (the caller then falls back to the quote).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

process.env.ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "exec-test-root-"));
process.env.RPC_URL = "http://127.0.0.1:1";
process.env.RPC_MOCK = path.join(here, "mocks", "exec-mock.mjs");

const { readExecution } = await import("../lib/exec.mjs");
const mock = await import("./mocks/exec-mock.mjs");
const owner = new PublicKey(mock.OWNER);
const mint = new PublicKey(mock.MINT);

// meta lag -> found:false (caller falls back to the quote, priceSource "quote-fallback")
const missing = await readExecution("MISSING", owner, mint, { retries: 1, delayMs: 0 });
asrt(missing.found === false, "getTransaction null -> found:false");

// a landed sell -> tokensSold from the token-balance delta, SOL received from the balance delta
const sell = await readExecution("SELL", owner, mint, { retries: 1, delayMs: 0 });
asrt(sell.found === true, "sell tx found");
asrt(sell.tokensSold === 1_000_000n, `tokensSold = 1_000_000, got ${sell.tokensSold}`);
asrt(sell.solReceivedSol > 0, `solReceivedSol reflects the positive SOL delta, got ${sell.solReceivedSol}`);

// A closed WSOL ATA returns its rent: that 0.00203928 SOL is not proceeds (step 4 / TODO(verify) V5).
const rented = await readExecution("SELL_RENT", owner, mint, { retries: 1, delayMs: 0 });
asrt(rented.found === true, "rent tx found");
asrt(rented.solDeltaSol > 0.102, `rent tx SOL delta is ~0.10204, got ${rented.solDeltaSol}`);
asrt(Math.abs(rented.rentReturnedSol - 0.00203928) < 1e-12, `rentReturnedSol = 0.00203928, got ${rented.rentReturnedSol}`);
asrt(
  Math.abs(rented.solReceivedSol - 0.1) < 1e-9,
  `solReceivedSol excludes the ATA rent (expected 0.1), got ${rented.solReceivedSol}`,
);

console.log("PASS: readExecution resolves fills from tx meta and reports found:false on meta lag");
