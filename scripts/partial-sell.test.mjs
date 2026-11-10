// H4: splitEntryForSell returns the entry share sold and the entry that remains, so a partial sell
// does not double-count the full entry.
process.env.RPC_URL = process.env.RPC_URL || "https://example.invalid/?api-key=test";
import "./lib/test-env.mjs";
import { splitEntryForSell, roundSol } from "../lib/session.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const half = splitEntryForSell(0.1, 5_000_000n, 10_000_000n);
asrt(half.shareEntry === 0.05, `half entry = 0.05, got ${half.shareEntry}`);
asrt(half.remainderEntry === 0.05, `half remainder = 0.05, got ${half.remainderEntry}`);

const full = splitEntryForSell(0.1, 10_000_000n, 10_000_000n);
asrt(full.shareEntry === roundSol(0.1) && full.remainderEntry === 0, "full sell closes the whole entry");

const over = splitEntryForSell(0.1, 12_000_000n, 10_000_000n);
asrt(over.shareEntry === roundSol(0.1) && over.remainderEntry === 0, "sold >= total closes the whole entry");

const junk = splitEntryForSell(0.1, 0n, 0n);
asrt(junk.shareEntry === roundSol(0.1) && junk.remainderEntry === 0, "degenerate totals fall back to full entry");

console.log("PASS: splitEntryForSell returns the sold share and the remaining entry");
