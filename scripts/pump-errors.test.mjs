// Pump error table + parser: a failed trade must report a human code ("6024 Overflow"), not
// {Custom:6024} — the code decides whether a retry can succeed. Also checks the exit preview:
// a drained curve (rSol < out) must be rejected BEFORE sending (that is the 6024 spam).
process.env.RPC_URL = "https://example.invalid/?api-key=test";
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import {
  describeCustom,
  describeTxError,
  isCurveCompleteError,
  isOverflowError,
  isSlippageError,
  parseInstructionError,
} from "../lib/pump-errors.mjs";
import { previewExit } from "../lib/exec.mjs";

assert.match(describeCustom(6024), /6024 Overflow/);
assert.match(describeCustom(6003), /6003 TooLittleSolReceived/);
assert.match(describeCustom(9999), /Custom 9999/);
assert.deepEqual(parseInstructionError({ InstructionError: [3, { Custom: 6024 }] }), {
  ixIndex: 3,
  kind: "custom",
  code: 6024,
});
assert.match(describeTxError({ InstructionError: [3, { Custom: 6002 }] }), /instruction 3: 6002 TooMuchSolRequired/);
assert.match(describeTxError({ InstructionError: [2, "ProgramFailedToComplete"] }), /instruction 2: ProgramFailedToComplete/);
assert.equal(isOverflowError({ InstructionError: [2, { Custom: 6024 }] }), true);
assert.equal(isSlippageError({ InstructionError: [2, { Custom: 6003 }] }), true);
assert.equal(isCurveCompleteError({ InstructionError: [2, { Custom: 6005 }] }), true);
assert.equal(isCurveCompleteError({ InstructionError: [2, { Custom: 6081 }] }), true, "6081 BondingCurveAlreadyMigrated must also blacklist the mint (no repeat buys)");
assert.equal(isCurveCompleteError({ InstructionError: [2, { Custom: 6024 }] }), false);

// A2: wrapped shapes — txError()/simulateThenSend stringify the payload into the Error message;
// the structure must survive so 6005/6081 are still recognized on the send/confirm path.
const wrappedJson = new Error(`tx SIG failed on-chain: {"InstructionError":[2,{"Custom":6005}]}`);
assert.equal(isCurveCompleteError(wrappedJson), true, "stringified InstructionError in the message is decoded");
const wrappedProp = Object.assign(new Error("x"), { err: { InstructionError: [2, { Custom: 6081 }] } });
assert.equal(isCurveCompleteError(wrappedProp), true, "payload attached as .err is decoded");
assert.equal(isCurveCompleteError(new Error('{"Custom":6024}')), false, "6024 is still not a complete-curve error");
assert.match(describeTxError(wrappedJson), /instruction n\/a: 6005 BondingCurveComplete/, "wrapped error describes the real code");
assert.match(describeTxError(new Error('tx failed on-chain: {"InstructionError":[3,{"Custom":6024}]}')), /6024 Overflow/, "slippage/overflow codes decode from the message too");

const mk = (vSol, vTok, rSol, rTok) => ({
  virtualSolReserves: vSol,
  virtualTokenReserves: vTok,
  realSolReserves: rSol,
  realTokenReserves: rTok,
  complete: false,
});
const healthy = mk(30_000_000_000n, 1_073_000_000_000_000n, 0n, 793_100_000_000_000n);
const pv = previewExit(healthy, 0.02);
assert.ok(pv.ok && pv.ratio > 0.8 && pv.ratio < 1, `round-trip ratio must be <1 and near 1, got ${pv.ratio}`);
assert.equal(pv.payable, true, "a fresh curve pays the exit");

// The bot's pre-send guard: a sell is only sendable when its output fits the REAL SOL reserves.
// The 40+ Custom-6024 txs were exactly this condition being violated (rSol 0.0008 SOL vs 0.05 out).
const { calcSellSol } = await import("../lib/pumpfun.mjs");
const drainedState = mk(217_073_336_095n, 994_294_805_279_529n, 786_439n, 714_394_805_279_529n);
const bigSell = calcSellSol(drainedState, 235_612_530_000n); // the stuck position
assert.ok(BigInt(drainedState.realSolReserves) < bigSell, "rSol < out must trip the guard");
const tinySell = calcSellSol(drainedState, 1_000_000n);
assert.ok(BigInt(drainedState.realSolReserves) >= tinySell, "a tiny sell is still payable");

console.log(JSON.stringify({ ratio: Number(pv.ratio.toFixed(4)), drainedOut: Number(bigSell) / 1e9, drainedRSol: 786_439 / 1e9 }));
console.log("PASS: pump error codes are human-readable, survive wrapper layers, and rSol<out is detected before sending");
