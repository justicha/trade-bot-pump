// Unit test for the holder gate: a token is only bought after N DISTINCT wallets hold a
// positive balance (bought - sold), so "dev + 2 of his own wallets" never triggers a buy.
import { HolderTracker } from "../lib/holders.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// gate off -> never tracks, never ready
const off = new HolderTracker({ minHolders: 0 });
asrt(off.enabled === false, "minHolders=0 must disable the gate");
asrt(off.track("MINT_OFF") === false, "disabled tracker must not track");
asrt(off.apply("MINT_OFF", "userA", 100) === null, "disabled tracker must return null");

// gate on: 3 distinct holders required
const h = new HolderTracker({ minHolders: 3, waitMs: 2000 });
asrt(h.enabled === true, "gate enabled with minHolders=3");
asrt(h.track("MINT_A") === true, "track() adds a mint");
asrt(h.track("MINT_A") === false, "track() is idempotent");
asrt(h.watching("MINT_A") === true, "mint is watched");

let r = h.apply("MINT_A", "dev", 1000);
asrt(r.holders === 1 && r.ready === false, "dev buy = 1 holder, not ready: " + JSON.stringify(r));

// the SAME wallet buying twice is still one holder
r = h.apply("MINT_A", "dev", 500);
asrt(r.holders === 1, "same wallet twice must count as 1 holder, got " + r.holders);

r = h.apply("MINT_A", "userB", 100);
asrt(r.holders === 2 && r.ready === false, "2 holders, not ready: " + JSON.stringify(r));

r = h.apply("MINT_A", "userC", 50);
asrt(r.holders === 3 && r.ready === true, "3 holders -> ready: " + JSON.stringify(r));

// a full exit drops the holder count again
r = h.apply("MINT_A", "userB", -100);
asrt(r.holders === 2 && r.ready === false, "wallet that sold everything is not a holder: " + JSON.stringify(r));
// and buying back restores it
r = h.apply("MINT_A", "userB", 25);
asrt(r.holders === 3 && r.ready === true, "buying back restores the holder: " + JSON.stringify(r));

// untracked mint is ignored
asrt(h.apply("MINT_UNKNOWN", "userA", 10) === null, "untracked mint must be ignored");

// drop stops tracking
asrt(h.drop("MINT_A") === true && h.watching("MINT_A") === false, "drop() stops tracking");

// prune: a mint that never reached the threshold is forgotten after waitMs
h.track("MINT_SLOW", { at: 1_000 });
h.apply("MINT_SLOW", "only1", 10, { ts: 1_100, slot: 5 });
const notYet = h.prune(1_500);
asrt(notYet.length === 0, "nothing expires before waitMs");
const dropped = h.prune(3_500);
asrt(dropped.length === 1 && dropped[0].mint === "MINT_SLOW" && dropped[0].holders === 1, "expired mint reported: " + JSON.stringify(dropped));
asrt(dropped[0].ready === false && dropped[0].holdersAtReady === null, "a mint that never got a crowd is reported as not ready");
asrt(h.watching("MINT_SLOW") === false, "expired mint is no longer watched");

console.log(JSON.stringify({ dropped, size: h.size }));
console.log("PASS: holder gate counts distinct positive wallets, ignores same-wallet repeats, expires slow mints");
