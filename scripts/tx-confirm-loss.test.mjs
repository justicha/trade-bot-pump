// C2 regression: when confirmTransaction fails with a network error AFTER the tx was sent, the
// thrown error must carry the signature, and readExecution must be able to resolve the landed fill
// from getTransaction meta (so a bot can record the position instead of dropping it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// Set the mock env BEFORE importing lib/rpc.mjs (it loads RPC_MOCK at import time).
process.env.ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tx-confirm-loss-root-"));
process.env.RPC_URL = "http://127.0.0.1:1";
process.env.RPC_MOCK = path.join(here, "mocks", "confirm-fail-mock.mjs");

const { sendTxWithRetry } = await import("../lib/rpc.mjs");
const { readExecution } = await import("../lib/exec.mjs");
const { buildVersionedTx } = await import("../lib/tx.mjs");
const mock = await import("./mocks/confirm-fail-mock.mjs");

const kp = Keypair.generate();
const tx = await buildVersionedTx(kp, [
  SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
]);

// 1) confirm failure attaches the signature to the thrown error
let threw = false;
try {
  await sendTxWithRetry(tx, { skipPreflight: true });
} catch (e) {
  threw = true;
  asrt(e.sig === mock.SIG, `error carries the signature (got ${e.sig})`);
}
asrt(threw, "sendTxWithRetry rejects when confirmTransaction fails");

// 2) readExecution resolves the landed fill from getTransaction meta
const ex = await readExecution(mock.SIG, new PublicKey(mock.OWNER), new PublicKey(mock.MINT));
asrt(ex.found === true, "readExecution found the tx");
asrt(ex.tokensReceived === 700000n, `tokensReceived read from postTokenBalances (got ${ex.tokensReceived})`);
asrt(ex.solSpentSol > 0, `solSpentSol reflects the SOL delta minus the fee (got ${ex.solSpentSol})`);
asrt(ex.err === null, "tx meta has no error");

console.log("PASS: confirm-failure carries the signature and readExecution resolves the landed fill");
