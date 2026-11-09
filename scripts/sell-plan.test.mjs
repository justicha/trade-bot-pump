// Step-1 regression suite: a 100% sell must never be sent when the curve cannot pay it.
// Real numbers from the stuck position (FMosXPu8L1cm): balance 235,612.53 tokens,
// realSolReserves 0.000786 SOL, while the naive full-balance quote is 0.0509 SOL.
process.env.RPC_URL = process.env.RPC_URL || "https://example.invalid/?api-key=test";
import assert from "node:assert/strict";
import { calcSellQuote, calcSellSol, solToLamports } from "../lib/pumpfun.mjs";
import { maxSellableRaw, planSellParts, stepSellState } from "../lib/sell-plan.mjs";

const STATE = {
  virtualSolReserves: 217_073_336_095n,
  virtualTokenReserves: 994_294_805_279_529n,
  realSolReserves: 786_439n,
  realTokenReserves: 714_394_805_279_529n,
  complete: false,
};
const BALANCE = 235_612_530_000n; // raw units (6 decimals)
const cap = (STATE.realSolReserves * 95n) / 100n;

// (1) the bug: the full-balance quote exceeds the real reserves -> the program overflows (6024)
const full = calcSellQuote(STATE, BALANCE);
assert.ok(full.net > STATE.realSolReserves, `full quote ${full.net} must exceed rSol ${STATE.realSolReserves}`);
assert.ok(full.gross > STATE.realSolReserves, "the GROSS is the number the program pays out of reserves");

// (2) BigInt only: no float can round the balance
assert.equal(solToLamports(0.07), 70_000_000n);
assert.equal(typeof BALANCE, "bigint");

// (3) the planner keeps every part payable
const plan = planSellParts(STATE, BALANCE, { capRatio: 0.95, minPartRaw: 1_000_000n });
assert.ok(plan.parts.length > 1, `expected several parts, got ${plan.parts.length}`);
for (const p of plan.parts) {
  assert.ok(p.amountRaw > 0n, "every part has a positive amount");
  assert.ok(p.quoteOut <= cap, `part quote ${p.quoteOut} must fit the cap ${cap}`);
}
const sum = plan.parts.reduce((a, p) => a + p.amountRaw, 0n);
assert.equal(sum + plan.restRaw, BALANCE, "parts + rest must equal the balance exactly");

// (4) stepping the state shrinks what the curve can pay (rSol goes down, vTok goes up)
const stepped = stepSellState(STATE, plan.parts[0].amountRaw);
assert.ok(stepped.realSolReserves < STATE.realSolReserves, "a sell lowers the real reserves");
assert.ok(stepped.virtualTokenReserves > STATE.virtualTokenReserves, "a sell returns tokens to the curve");
assert.ok(maxSellableRaw(stepped) < maxSellableRaw(STATE), "the next part is smaller than the first");

// (5) a drained curve refuses instead of sending a doomed tx
const zero = { ...STATE, realSolReserves: 0n };
const none = planSellParts(zero, BALANCE, { capRatio: 0.95 });
assert.equal(none.parts.length, 0);
assert.match(none.reason, /cannot pay/);

console.log(
  JSON.stringify({
    fullNetSol: Number(full.net) / 1e9,
    rSol: Number(STATE.realSolReserves) / 1e9,
    parts: plan.parts.length,
    firstPartTokens: Number(plan.parts[0].amountRaw) / 1e6,
    restTokens: Number(plan.restRaw) / 1e6,
  }),
);
console.log("PASS: full-balance sells are split so every part fits realSolReserves (6024 guard)");
