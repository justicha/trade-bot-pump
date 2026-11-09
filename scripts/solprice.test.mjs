// Unit test for dollar formatting / conversion (pure functions, no network).
import { fmtUsd, solPerTokenToUsd } from "../lib/solprice.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const cases = [
  [188.2413, "$188.24"],
  [1, "$1.00"],
  [0.004, "$0.004"],
  [0.003997123, "$0.003997123"],
  [0.00528, "$0.00528"],
  [0.000000528, "$0.000000528"],
  [0, "$0"],
  [NaN, "$n/a"],
];
for (const [input, want] of cases) {
  const got = fmtUsd(input);
  asrt(got === want, `fmtUsd(${input}) = ${got}, want ${want}`);
}

// token price in SOL -> dollars
asrt(solPerTokenToUsd(0.0000280, 190) === 0.00532, "0.000028 SOL/tok at $190 = $0.00532");
asrt(solPerTokenToUsd(NaN, 190) === null, "invalid price -> null");
asrt(solPerTokenToUsd(1, null) === null, "unknown SOL/USD -> null");

console.log(JSON.stringify({ cases: cases.length, sample: fmtUsd(solPerTokenToUsd(0.0000280, 190)) }));
console.log("PASS: dollar formatting keeps micro-cap digits and converts SOL/token -> USD");
