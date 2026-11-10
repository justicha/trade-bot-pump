// B4: an EXPIRED tx never landed (no fee paid) and must not be counted as a landed-but-failed tx.
// web3.js 1.99 identifies expiry by the Error `.name`, not by an `.expired` field.
import "./lib/test-env.mjs";
import { isExpiredTxError } from "../lib/rpc.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

class TxExpiredBH extends Error {
  constructor() {
    super("Signature x has expired: block height exceeded.");
    this.name = "TransactionExpiredBlockheightExceededError";
  }
}

asrt(isExpiredTxError(new TxExpiredBH()), true, "blockheight-exceeded class");
asrt(isExpiredTxError(Object.assign(new Error("t"), { name: "TransactionExpiredTimeoutError" })), true, "timeout class");
asrt(isExpiredTxError({ expired: true }), true, "legacy .expired flag still honored");
asrt(isExpiredTxError(new Error("landed but failed: Custom 6024")) === false, "a real on-chain failure is not expired");
asrt(isExpiredTxError(new Error("some other error")) === false, "ordinary error");
asrt(isExpiredTxError(null) === false, "null returns false");

console.log(JSON.stringify({ classes: 2, legacy: 1, negatives: 3 }));
console.log("PASS: expired-tx classification matches web3.js 1.99 error classes");
