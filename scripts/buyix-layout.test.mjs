// BUG 08 (documentation + regression pin, no transactions): the buy instruction byte layout is
// frozen. This test only checks BYTES — it never builds, sends or simulates a transaction.
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buyIx } from "../lib/pumpfun.mjs";

const user = new PublicKey("11111111111111111111111111111111");
const mint = new PublicKey("So11111111111111111111111111111111111111112");
const creator = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");

const ix = buyIx(user, mint, 0.02, 123_456_789n, { creator, maxSolCost: 21_000_000n });

assert.equal(ix.programId.toBase58(), "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "program id");
assert.equal(ix.data.length, 26, "8 disc + 8 amount + 8 max_sol_cost + 2 option flags");
assert.equal(ix.data.subarray(0, 8).toString("hex"), "66063d1201daebea", "buy discriminator");
assert.equal(ix.data.readBigUInt64LE(8), 123_456_789n, "amount holds the caller's minTokens (BUG 08: documented, layout frozen)");
assert.equal(ix.data.readBigUInt64LE(16), 21_000_000n, "max_sol_cost is the padded cap");
assert.equal(ix.data[24], 1, "track_volume = Some(true)");
assert.equal(ix.data[25], 0, "partial_fill = Some(false)");
assert.ok(ix.keys.length >= 17, `16 IDL accounts + bonding-curve-v2 (got ${ix.keys.length})`);

// M1: the default max_sol_cost uses solToLamports (round), not Math.floor — for values that don't
// represent exactly in a double (0.07 * 1e9 = 69999999.99999999) floor() would be 1 lamport short.
const def = buyIx(user, mint, 0.07, 123_456_789n, { creator });
assert.equal(def.data.readBigUInt64LE(16), 70_000_000n, "default max_sol_cost = solToLamports(0.07) = 70_000_000 lamports");

console.log(JSON.stringify({ dataLen: ix.data.length, keys: ix.keys.length, discriminator: "66063d1201daebea" }));
console.log("PASS: buy instruction byte layout pinned (no transaction built or sent)");
