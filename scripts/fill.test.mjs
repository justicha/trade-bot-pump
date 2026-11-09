// Fill must come from REAL reserves. Verified on-chain (2026-11-09):
//   G5TD3gFxE2mL: vSol 71.717 SOL, rSol 41.717 SOL -> vSol - rSol = 30.000 SOL exactly
//   a complete curve: vSol = rSol = 0 (liquidity moved to the pool)
// A normal curve therefore reaches 85 SOL REAL at ~115 SOL virtual, so vSol/85 overstates.
import assert from "node:assert/strict";
import { GRADUATION_REAL_SOL, gradFillPct } from "../lib/curve.mjs";

assert.equal(GRADUATION_REAL_SOL, 85);
assert.equal(gradFillPct(85_000_000_000n), 100);
assert.equal(gradFillPct(0n), 0);

const rSol = 41_717_000_000n;
const vSol = 71_717_000_000n;
assert.equal(Number(vSol - rSol) / 1e9, 30, "a normal curve keeps vSol = rSol + 30 SOL");

const realFill = gradFillPct(rSol);
const oldVirtualFill = (Number(vSol) / 85e9) * 100;
assert.ok(Math.abs(realFill - 49.08) < 0.02, `real fill ${realFill}`);
assert.ok(Math.abs(oldVirtualFill - 84.37) < 0.02, `virtual fill ${oldVirtualFill}`);
assert.ok(oldVirtualFill - realFill > 35, "the old formula overstates the fill by more than 35 points");

console.log(JSON.stringify({ rSolSol: 41.717, realFill: Number(realFill.toFixed(1)), oldFill: Number(oldVirtualFill.toFixed(1)) }));
console.log("PASS: fill is computed from real reserves; the virtual formula is provably wrong");
