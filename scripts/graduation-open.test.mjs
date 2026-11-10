// H3: the entry gate must refuse a second entry of the same mint while the first buy is still in
// flight (the watchdog used to release the slot and allow a duplicate buy).
import { canEnterMint } from "../lib/entry-gate.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const mk = () => ({ positions: new Set(), opening: new Set(), attempted: new Set() });

{
  const s = mk();
  asrt(canEnterMint({ ...s, mint: "M", maxPositions: 3 }).ok, "a fresh mint is enterable");
}

{
  const s = mk();
  s.opening.add("M"); // buy in flight
  asrt(canEnterMint({ ...s, mint: "M", maxPositions: 3 }).reason === "in-flight", "an in-flight mint is refused");
}

{
  const s = mk();
  s.attempted.add("M"); // already attempted (e.g. the watchdog freed the slot mid-buy)
  asrt(canEnterMint({ ...s, mint: "M", maxPositions: 3 }).reason === "attempted", "an already-attempted mint is refused (H3)");
}

{
  const s = mk();
  s.positions.add("X");
  asrt(canEnterMint({ ...s, mint: "Y", maxPositions: 1 }).reason === "full", "no free slot refuses a new mint");
}

console.log("PASS: canEnterMint refuses in-flight and attempted mints (duplicate-buy guard)");
