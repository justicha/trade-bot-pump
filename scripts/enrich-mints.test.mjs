// Offline tests for lib/enrich.mjs and scripts/enrich-mints.mjs (TASK 17).
// The fixture scripts/fixtures/enrich-49VVQVn7.json is a real read-only recording of the
// ground-truth mint (public keys, balances, event payloads only). The ground-truth numbers below
// were checked by hand in a browser on 2026-11-14; the replay must reproduce them.
import { cleanEnv } from "./lib/test-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import * as E from "../lib/enrich.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const fx = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "enrich-49VVQVn7.json"), "utf8"));

const MINT = "49VVQVn7BgEUzD8yKhSHBHa6CAQnbgaP5QVTMKrQpump";
const CREATOR = "AyRxCxNVPj4QTCzhXmHDgink4zApfdLEMtr67rg2jz9Y";
const FUNDER = "AfEeiCWg8PKUJpv7KnKKd86q1jUwb9DZZmkZX6J8GXQp";
const near = (a, b, eps, msg) => assert.ok(a != null && Math.abs(a - b) <= eps, `${msg}: got ${a}, want ${b}`);

// Replay rpc over a recording. A `before` that is not in the recorded list (the creator's history
// is recorded from before=createSig) starts at the top of the list.
function replayRpc(rec, { log } = {}) {
  const calls = { sigs: 0, txs: 0, acc: 0, missing: [] };
  return {
    calls,
    async getSignatures(addr, { before, limit }) {
      calls.sigs += 1;
      const list = rec.sigs[addr] ?? [];
      const i = before ? list.findIndex((s) => s.signature === before) : -1;
      const start = i >= 0 ? i + 1 : 0;
      return list.slice(start, start + limit);
    },
    async getTransaction(sig) {
      calls.txs += 1;
      if (!(sig in rec.txs)) calls.missing.push(sig);
      return rec.txs[sig] ?? null;
    },
    async getAccountInfo(addr) {
      calls.acc += 1;
      const a = rec.accounts[addr];
      return a ? { owner: a.owner, data: Buffer.from(a.data, "base64") } : null;
    },
  };
}
const fixtureJson = async (url) => {
  if (!(url in fx.json)) throw new Error("not recorded");
  return fx.json[url];
};

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`ok - ${name}`);
};

// ---- 1. recorded create tx + buy events ------------------------------------------------------
{
  const rpc = replayRpc(fx);
  const oldestFirst = fx.sigs[MINT].slice().reverse();
  const c = await E.findCreate(rpc, MINT, oldestFirst);
  assert.ok(c, "create found");
  assert.equal(c.create.creator, CREATOR);
  assert.equal(c.tx.slot, 469089763);
  assert.equal(c.tx.blockTime, 1794608099);
  // dev buy inside the create tx: gross (incl. 0.95% protocol + 0.30% creator fee) = what the
  // browser shows; net = what reached the curve
  const devEv = E.txEvents(c.tx).filter((e) => e.type === "trade" && e.user === CREATOR);
  assert.equal(devEv.length, 1);
  assert.equal(devEv[0].solGross, 0.873681689);
  assert.equal(devEv[0].solNet, 0.862895494);

  const early = await E.collectEarly(rpc, MINT, oldestFirst, { createSlot: c.tx.slot, createdAtSec: c.tx.blockTime });
  const buys = E.buysOf(MINT, early.txs);
  const s = E.summarizeBuys(buys, { createSig: c.sig, createSlot: c.tx.slot, createdAtSec: c.tx.blockTime, creator: CREATOR });
  assert.equal(s.devBuySol, 0.873681689);
  assert.equal(s.sameSecondBuyers, 23, "browser counted 23 buyers in the create second");
  assert.equal(s.sameSlotBuyers, 5, "by slot it is 5");
  near(s.first20BuyersSol, 33.19, 0.005, "first-20 incl dev");
  near(s.first20ExDevSol, 32.32, 0.005, "first-20 excl dev");
  near(s.first20BuyersSol - s.first20ExDevSol, s.devBuySol, 1e-9, "dev is one of the 20");
  assert.equal(s.first20Count, 20);
  assert.equal(s.first20Wallets, 19);
  // order: the create tx is the first tx, the dev buy the first buy
  assert.equal(buys[0].sig, c.sig);
  for (let i = 1; i < buys.length; i++) assert.ok(buys[i].slot >= buys[i - 1].slot, "buys in slot order");
  ok("recorded create + buys: creator, dev buy, same slot/second, first-20 incl/excl dev");
}

// normalizeTx: web3-style response -> compact; emit_cpi inner events win over (truncated) logs
{
  const ev = fx.txs[Object.keys(fx.txs).find((k) => fx.txs[k]?.events?.length >= 2)].events;
  const evBufs = ev.map((b) => Buffer.from(b, "base64"));
  const keys = [CREATOR, MINT, E.PUMP_PROGRAM_ID, FUNDER];
  const resp = {
    slot: 7,
    blockTime: 100,
    transaction: { signatures: ["S1"], message: { staticAccountKeys: keys, header: { numRequiredSignatures: 1 } } },
    meta: {
      err: null,
      preBalances: [10, 0, 0, 5],
      postBalances: [8, 0, 0, 7],
      loadedAddresses: { writable: ["W1"], readonly: ["R1"] },
      innerInstructions: [
        { index: 0, instructions: evBufs.map((b) => ({ programIdIndex: 2, data: bs58.encode(Buffer.concat([Buffer.from("e445a52e51cb9a1d", "hex"), b])) })) },
        { index: 1, instructions: [{ programIdIndex: 3, data: bs58.encode(Buffer.from("e445a52e51cb9a1d00", "hex")) }] }, // not pump
      ],
      logMessages: [`Program ${E.PUMP_PROGRAM_ID} invoke [1]`, "Log truncated"],
    },
  };
  const t = E.normalizeTx(resp, "S1");
  assert.deepEqual(t.keys, [...keys, "W1", "R1"]);
  assert.deepEqual(t.signers, [CREATOR]);
  assert.equal(t.eventsFrom, "inner");
  assert.deepEqual(t.events, ev);
  assert.equal(t.pumpInvoked, true);
  // no inner events -> the Program data log lines
  const resp2 = structuredClone(resp);
  resp2.meta.innerInstructions = [];
  resp2.meta.logMessages = ["Program log: Instruction: Buy", ...ev.map((b) => `Program data: ${b}`), "Program data: AAAAAAAAAAAA"];
  const t2 = E.normalizeTx(resp2, "S1");
  assert.equal(t2.eventsFrom, "logs");
  assert.deepEqual(t2.events, ev, "unknown payloads dropped");
  assert.equal(E.normalizeTx(null), null);
  ok("normalizeTx: keys incl. lookups, signers, inner events preferred, log fallback");
}

// ---- 2. funding ------------------------------------------------------------------------------
{
  const rpc = replayRpc(fx);
  const oldestFirst = fx.sigs[CREATOR].slice().reverse();
  const f = await E.findFunding(rpc, CREATOR, oldestFirst);
  assert.equal(f.found.funder, FUNDER);
  assert.equal(Math.round(f.found.fundedSol * 1e9), 113048598);
  // pure: the creator's own spend is no funding; largest decrease wins
  const tx = { sig: "x", slot: 1, blockTime: 1, err: false, keys: ["C", "A", "B"], signers: ["A"], pre: [0, 100, 50], post: [30, 75, 45], events: [] };
  assert.deepEqual(E.fundingFromTx(tx, "C"), { funder: "A", fundedSol: 30e-9, sig: "x", blockTime: 1 });
  assert.equal(E.fundingFromTx({ ...tx, pre: [30, 100, 50], post: [10, 100, 50] }, "C"), null, "decrease is no funding");
  assert.equal(E.fundingFromTx({ ...tx, err: true }, "C"), null, "failed tx");
  // over the cap -> lower-bound flags, funding unknown (the oldest tx is not reached)
  const endless = {
    async getSignatures(addr, { limit }) {
      if (addr === MINT) return fx.sigs[MINT].slice(0, limit);
      return Array.from({ length: limit }, (_, i) => ({ signature: `s${Math.random()}`, slot: 1000 + i, blockTime: 1794000000 + i, err: true }));
    },
    getTransaction: replayRpc(fx).getTransaction,
    getAccountInfo: replayRpc(fx).getAccountInfo,
  };
  const pg = await E.paginateSignatures(endless, "X", { maxPages: 3, pageSize: 10 });
  assert.equal(pg.capped, true);
  assert.equal(pg.sigs.length, 30);
  const row = await E.enrichMint({ mint: MINT }, { rpc: endless, fetchJson: fixtureJson, maxPages: 2 });
  assert.equal(row.creator, CREATOR);
  assert.equal(row.creatorAgeIsLowerBound, true);
  assert.equal(row.creatorFundedBy, null);
  assert.equal(row.fundedSol, null);
  assert.equal(row.priorTokensIsLowerBound, true);
  assert.ok(row.errors.includes("creator: history capped, funding unknown"), row.errors.join("|"));
  // capped mint history -> create unknown, error "history too long"
  const capMint = { ...endless, getSignatures: async (_a, { limit }) => Array.from({ length: limit }, (_, i) => ({ signature: `m${i}${Math.random()}`, slot: i, blockTime: i, err: true })) };
  const r2 = await E.enrichMint({ mint: MINT }, { rpc: capMint, fetchJson: fixtureJson, maxPages: 2, mintMaxPages: 2 });
  assert.equal(r2.createSig, null);
  assert.ok(r2.errors.includes("mint: history too long, creator unknown"), r2.errors.join("|"));
  ok("funding: fixture funder + amount; capped history -> lower-bound flags");
}

// ---- 3. prior tokens -------------------------------------------------------------------------
{
  const createTx = fx.txs[fx.sigs[MINT].at(-1).signature];
  const createB64 = createTx.events.find((b) => Buffer.from(b, "base64").subarray(0, 8).toString("hex") === "1b72a94ddeeb6376");
  const mk = (sig, slot, { signer = CREATOR, err = false, withCreate = true } = {}) => ({
    sig, slot, blockTime: slot, err, keys: [signer, MINT], signers: [signer], pre: [0, 0], post: [0, 0], events: withCreate ? [createB64] : [],
  });
  const txs = {
    a: mk("a", 90), // counted
    b: mk("b", 80, { withCreate: false }), // not a create
    c: mk("c", 70, { signer: "Other1111111111111111111111111111111111111" }), // not signed by creator
    d: mk("d", 100), // same slot as the create -> not before createSlot
    e: mk("e", 60), // counted
  };
  const sigs = [
    { signature: "d", slot: 100, err: false },
    { signature: "a", slot: 90, err: false },
    { signature: "f", slot: 85, err: true }, // failed: never fetched
    { signature: "b", slot: 80, err: false },
    { signature: "c", slot: 70, err: false },
    { signature: "e", slot: 60, err: false },
  ];
  const fetched = [];
  const rpc = { getTransaction: async (s) => (fetched.push(s), txs[s] ?? null) };
  const p = await E.countPriorCreates(rpc, CREATOR, sigs, { cap: 300, beforeSlot: 100 });
  assert.equal(p.count, 2);
  assert.equal(p.lowerBound, false);
  assert.ok(!fetched.includes("f") && !fetched.includes("d"));
  const capped = await E.countPriorCreates(rpc, CREATOR, sigs, { cap: 2, beforeSlot: 100 });
  assert.equal(capped.count, 1, "only the 2 newest scanned");
  assert.equal(capped.lowerBound, true);
  // the real creator: 2 prior pump.fun creates
  const real = await E.countPriorCreates(replayRpc(fx), CREATOR, fx.sigs[CREATOR], { beforeSlot: 469089763 });
  assert.equal(real.count, 2);
  assert.equal(real.lowerBound, false);
  assert.ok(!real.mints.includes(MINT));
  ok("prior tokens: before createSlot counted, after/unsigned/failed ignored, cap -> lower bound");
}

// ---- 4. metadata -----------------------------------------------------------------------------
{
  // Token-2022 metadata extension: the recorded mint account and the older t22 fixture
  const acc = fx.accounts[MINT];
  assert.equal(acc.owner, E.TOKEN_2022_PROGRAM_ID);
  const md = E.decodeToken2022Metadata(Buffer.from(acc.data, "base64"));
  assert.deepEqual({ name: md.name, symbol: md.symbol, source: md.source }, { name: "Topblast", symbol: "TOPBLAST", source: "token-2022" });
  assert.match(md.uri, /^https:\/\/ipfs\.io\/ipfs\/bafkrei/);
  const t22 = Buffer.from(fs.readFileSync(path.join(here, "fixtures", "mint-5qfTfUYWpz-t22.hex"), "utf8").trim(), "hex");
  const md2 = E.decodeToken2022Metadata(t22);
  assert.ok(md2 && md2.name && md2.uri, "second Token-2022 mint decodes");
  assert.equal(E.decodeToken2022Metadata(Buffer.alloc(82)), null, "plain SPL mint has no extension");

  // Metaplex: key, update_authority, mint, then zero-padded borsh strings (32/10/200)
  const pad = (s, n) => {
    const b = Buffer.alloc(4 + n);
    b.writeUInt32LE(n, 0);
    Buffer.from(s).copy(b, 4);
    return b;
  };
  const mp = Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1), Buffer.alloc(32, 2), pad("Classic Coin", 32), pad("CLC", 10), pad("ipfs://QmXyz", 200), Buffer.alloc(40)]);
  assert.deepEqual(E.decodeMetaplexMetadata(mp), { name: "Classic Coin", symbol: "CLC", uri: "ipfs://QmXyz", source: "metaplex" });
  assert.equal(E.decodeMetaplexMetadata(Buffer.alloc(10)), null);
  assert.equal(E.metaplexPda(MINT).length >= 32, true);

  // uri normalization + gateway fallback
  assert.equal(E.normalizeUri("ipfs://QmXyz"), "https://ipfs.io/ipfs/QmXyz");
  assert.equal(E.normalizeUri("ipfs://ipfs/QmXyz"), "https://ipfs.io/ipfs/QmXyz");
  assert.equal(E.normalizeUri("data:xyz"), null);
  const tried = [];
  const j = await E.fetchJsonWithFallback("https://ipfs.io/ipfs/QmA", {
    fetchOne: async (u) => {
      tried.push(u);
      if (tried.length < 2) throw new Error("http 429");
      return { twitter: "x" };
    },
  });
  assert.deepEqual(j, { twitter: "x" });
  assert.deepEqual(tried, ["https://ipfs.io/ipfs/QmA", "https://dweb.link/ipfs/QmA"]);

  // socials from both key styles
  assert.deepEqual(E.socialsFromJson({ twitter: "https://x.com/a", telegram: "", website: "https://a.b" }), { hasTwitter: true, hasTelegram: false, hasWebsite: true });
  assert.deepEqual(E.socialsFromJson({ extensions: { twitter: "t", telegram: "https://t.me/a" } }), { hasTwitter: true, hasTelegram: true, hasWebsite: false });
  assert.deepEqual(E.socialsFromJson({ x: "https://x.com/b" }).hasTwitter, true);
  assert.deepEqual(E.socialsFromJson(null), { hasTwitter: null, hasTelegram: null, hasWebsite: null });

  // fetch failure -> nulls + error, not a crash (everything else still filled)
  const row = await E.enrichMint({ mint: MINT }, { rpc: replayRpc(fx), fetchJson: async () => { throw new Error("The operation was aborted due to timeout https://secret.example/?api-key=K"); } });
  assert.equal(row.hasTwitter, null);
  assert.equal(row.hasTelegram, null);
  assert.equal(row.hasWebsite, null);
  assert.equal(row.creator, CREATOR);
  const uriErr = row.errors.find((e) => e.startsWith("uri:"));
  assert.ok(uriErr, row.errors.join("|"));
  assert.ok(!/secret\.example|api-key=K/.test(uriErr), "error text redacted");
  ok("metadata: Token-2022 + Metaplex decode, socials both styles, gateway fallback, fetch failure -> nulls + error");
}

// ---- 5. full offline replay of the ground truth -----------------------------------------------
{
  const rpc = replayRpc(fx);
  const row = await E.enrichMint({ n: 1, mint: MINT, entryUtc: "2026-11-13 22:35:56" }, { rpc, fetchJson: fixtureJson });
  assert.deepEqual(rpc.calls.missing, [], "replay needed nothing outside the recording");
  assert.equal(row.creator, CREATOR);
  assert.equal(row.devBuySol, 0.873681689);
  assert.equal(row.createdAtUtc, "2026-11-13 22:14:59");
  assert.equal(row.program, "pump");
  assert.equal(row.tokenProgram, "token-2022");
  assert.equal(row.sameSecondBuyers, 23);
  assert.equal(row.sameSlotBuyers, 5);
  near(row.first20BuyersSol, 33.19, 0.005, "first20BuyersSol");
  near(row.first20ExDevSol, 32.32, 0.005, "first20ExDevSol");
  assert.equal(row.creatorPriorTokens, 2);
  assert.equal(row.priorTokensIsLowerBound, false);
  near(row.creatorAgeDays, 2.2, 0.05, "creatorAgeDays");
  assert.equal(row.creatorAgeIsLowerBound, false);
  assert.equal(row.creatorFundedBy, FUNDER);
  assert.equal(row.fundedSol, 0.113048598);
  assert.equal(row.funderIsEarlyBuyer, false);
  assert.deepEqual([row.hasTwitter, row.hasWebsite, row.hasTelegram], [true, true, false]);
  assert.equal(row.name, "Topblast");
  assert.equal(row.lookaheadOk, true);
  assert.deepEqual(row.errors, []);
  // entry before the first-20 buys finished -> lookahead flagged with the reason
  const early = await E.enrichMint({ n: 1, mint: MINT, entryUtc: "2026-11-13 22:14:59" }, { rpc: replayRpc(fx), fetchJson: fixtureJson });
  assert.equal(early.lookaheadOk, false);
  assert.deepEqual(early.lookaheadIssues, ["create not before entry", "first-20 buys not all before entry"]);
  // create unknown -> cannot tell (null), not false; incomplete first-20 checks the buys counted
  assert.deepEqual(E.lookahead(1000, { createdAtSec: null, first20LastBlockTime: null }), { lookaheadOk: null, lookaheadIssues: ["create unknown"] });
  assert.deepEqual(E.lookahead(1000, { createdAtSec: 900, first20LastBlockTime: null }), { lookaheadOk: true, lookaheadIssues: [] });
  assert.deepEqual(E.lookahead(1000, { createdAtSec: 900, first20LastBlockTime: 1000 }), { lookaheadOk: false, lookaheadIssues: ["first-20 buys not all before entry"] });
  assert.deepEqual(E.lookahead(null, { createdAtSec: 900 }), { lookaheadOk: null, lookaheadIssues: ["no entry time"] });
  ok("ground truth reproduced offline from the recording; lookahead true/false/null");
}

// ---- 5c. legacy create event (2025: no reserves in the payload) ------------------------------
{
  // Layout of the real 2025-04 event (246 bytes on mint 6W9q5…pump): name, symbol, uri, mint,
  // bonding_curve, user, creator, timestamp. lib/events parseCreate anchors on the reserves and
  // returns null; the enrich fallback decodes it.
  const s = (v) => {
    const b = Buffer.alloc(4 + Buffer.byteLength(v));
    b.writeUInt32LE(Buffer.byteLength(v), 0);
    b.write(v, 4);
    return b;
  };
  const key = (seed) => new PublicKey(Buffer.alloc(32, seed));
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(1745850577n);
  const buf = Buffer.concat([Buffer.from("1b72a94ddeeb6376", "hex"), s("CYBER POLYGON"), s("CYBERCOVID"), s("https://ipfs.io/ipfs/QmLegacy"), key(1).toBuffer(), key(2).toBuffer(), key(3).toBuffer(), key(4).toBuffer(), ts]);
  const { parseCreate } = await import("../lib/events.mjs");
  assert.equal(parseCreate(buf), null, "the bots' parser does not take it");
  const [c] = E.txEvents({ events: [buf.toString("base64")] });
  assert.equal(c.type, "create");
  assert.deepEqual([c.name, c.symbol, c.mint, c.user, c.creator, c.timestampSec, c.legacy], ["CYBER POLYGON", "CYBERCOVID", key(1).toBase58(), key(3).toBase58(), key(4).toBase58(), 1745850577, true]);
  // the current (reserves) layout still goes through parseCreate
  const cur = E.txEvents(fx.txs[fx.sigs[MINT].at(-1).signature]).find((e) => e.type === "create");
  assert.equal(cur.legacy, undefined);
  assert.equal(E.parseCreateLegacy(Buffer.alloc(40)), null);
  ok("legacy create event decoded by the enrich fallback; current layout unchanged");
}

// ---- 5a. deployer (the create's signer) != creator (a fresh fee address) ---------------------
{
  // Same recording, but the create event's creator field points at a key with no history: the
  // signer (event user) keeps the real wallet. Creator facts: 0 txs, age 0, no error. Deployer
  // facts: the ground-truth wallet. The dev buy (by the deployer) still counts as the dev's.
  const FRESH = new PublicKey(Buffer.alloc(32, 7)).toBase58();
  const fx2 = structuredClone(fx);
  const createSig = fx.sigs[MINT].at(-1).signature;
  const t = fx2.txs[createSig];
  t.events = t.events.map((b64) => {
    const b = Buffer.from(b64, "base64");
    const c = E.txEvents({ events: [b64] })[0];
    if (!c || c.type !== "create") return b64;
    let o = 8;
    for (let k = 0; k < 3; k++) o += 4 + b.readUInt32LE(o); // name, symbol, uri
    new PublicKey(FRESH).toBuffer().copy(b, o + 96); // mint, bonding_curve, user, then creator
    return b.toString("base64");
  });
  const c2 = E.txEvents(t).find((e) => e.type === "create");
  assert.deepEqual([c2.user, c2.creator], [CREATOR, FRESH]);
  const row = await E.enrichMint({ n: 1, mint: MINT, entryUtc: "2026-11-13 22:35:56" }, { rpc: replayRpc(fx2), fetchJson: fixtureJson });
  assert.equal(row.creator, FRESH);
  assert.equal(row.deployer, CREATOR);
  assert.equal(row.deployerIsCreator, false);
  assert.equal(row.creatorTxsBeforeCreate, 0);
  assert.equal(row.creatorAgeDays, 0);
  assert.equal(row.creatorFundedBy, null);
  assert.equal(row.creatorPriorTokens, 0);
  assert.equal(row.deployerFundedBy, FUNDER);
  assert.equal(row.deployerFundedSol, 0.113048598);
  assert.equal(row.deployerPriorTokens, 2);
  near(row.deployerAgeDays, 2.2, 0.05, "deployer age");
  assert.equal(row.devBuySol, 0.873681689, "the deployer's buy in the create tx is the dev buy");
  near(row.first20ExDevSol, 32.32, 0.005, "first-20 without the deployer's buy");
  assert.equal(row.sameSecondBuyers, 23);
  assert.deepEqual(row.errors, [], "a wallet with no history before the create is no error");
  // ground truth: deployer == creator -> no deployer facts
  const gt = await E.enrichMint({ mint: MINT }, { rpc: replayRpc(fx), fetchJson: fixtureJson });
  assert.equal(gt.deployerIsCreator, true);
  assert.equal(gt.deployerAgeDays, null);
  assert.equal(gt.creatorTxsBeforeCreate, fx.sigs[CREATOR].length);
  ok("deployer != creator: fresh creator is a fact (0 txs, no error), wallet facts for the deployer, dev buy by the deployer");
}

// ---- 5b. mint history over the page cap: create found via the creator ------------------------
{
  // Universe (newest first). Mint: one real buy tx re-listed as the newest, 2500 failed filler
  // sigs, then the recorded early history. Creator: an anchor tx after the create, the create,
  // then the recorded pre-create history. A `before` that is not in an address's list is placed by
  // its slot (as the RPC does for any confirmed signature); `until` is exclusive.
  const createSig = fx.sigs[MINT].at(-1).signature;
  const createTx = fx.txs[createSig];
  const maxEarlySlot = fx.sigs[MINT][0].slot;
  const buySig = fx.sigs[MINT].find((s) => !s.err && s.signature !== createSig && E.txEvents(fx.txs[s.signature]).some((e) => e.type === "trade" && e.isBuy)).signature;
  const filler = Array.from({ length: 2500 }, (_, i) => ({ signature: `F${i}`, slot: 500_000_000 - i, blockTime: 1794700000 - i, err: true }));
  const universe = {
    [MINT]: [{ signature: "NEWEST", slot: 600_000_000, blockTime: 1794800000, err: false }, ...filler, ...fx.sigs[MINT]],
    [CREATOR]: [{ signature: "ANCHOR", slot: maxEarlySlot + 1, blockTime: 1794608200, err: false }, { signature: createSig, slot: createTx.slot, blockTime: createTx.blockTime, err: false }, ...fx.sigs[CREATOR]],
  };
  const slotOf = new Map(Object.values(universe).flat().map((s) => [s.signature, s.slot]));
  const longRpc = ({ withTrades = true } = {}) => {
    const base = replayRpc(fx);
    const calls = [];
    return {
      calls,
      async getSignatures(addr, { before, until, limit }) {
        calls.push({ addr, before, until });
        const list = universe[addr] ?? [];
        let start = 0;
        if (before) {
          const i = list.findIndex((s) => s.signature === before);
          start = i >= 0 ? i + 1 : list.findIndex((s) => s.slot < slotOf.get(before));
          if (start < 0) start = list.length;
        }
        let end = list.length;
        if (until) {
          const j = list.findIndex((s) => s.signature === until);
          if (j >= 0) end = j;
        }
        return list.slice(start, Math.min(end, start + limit));
      },
      async getTransaction(sig) {
        const t = await base.getTransaction(sig);
        // withTrades=false: the newest tx carries no pump trade (a migrated token on PumpSwap)
        if (sig === "NEWEST") return { ...fx.txs[buySig], sig: "NEWEST", slot: 600_000_000, events: withTrades ? fx.txs[buySig].events : [] };
        return t;
      },
      async getAccountInfo(addr) {
        if (addr === E.bondingCurvePda(MINT)) {
          const d = Buffer.alloc(150);
          new PublicKey(CREATOR).toBuffer().copy(d, 49);
          return { owner: E.PUMP_PROGRAM_ID, data: d };
        }
        return base.getAccountInfo(addr);
      },
    };
  };
  // tradeCreator on the recorded buy payload carries the creator
  assert.equal(E.txEvents(fx.txs[buySig]).find((e) => e.type === "trade").creator, CREATOR);

  for (const withTrades of [true, false]) {
    const rpc = longRpc({ withTrades });
    const row = await E.enrichMint({ n: 2, mint: MINT, entryUtc: "2026-11-13 22:35:56" }, { rpc, fetchJson: fixtureJson, maxPages: 2, mintMaxPages: 2 });
    assert.equal(row.createFoundVia, "creator");
    assert.equal(row.creatorSource, withTrades ? "trade" : "curve");
    assert.equal(row.createSig, createSig);
    assert.equal(row.creator, CREATOR);
    assert.equal(row.createdAtUtc, "2026-11-13 22:14:59");
    assert.equal(row.devBuySol, 0.873681689);
    assert.equal(row.sameSecondBuyers, 23);
    assert.equal(row.sameSlotBuyers, 5);
    near(row.first20BuyersSol, 33.19, 0.005, "first20 via creator path");
    near(row.first20ExDevSol, 32.32, 0.005, "first20ExDev via creator path");
    assert.equal(row.creatorPriorTokens, 2);
    assert.equal(row.creatorFundedBy, FUNDER);
    assert.equal(row.fundedSol, 0.113048598);
    near(row.creatorAgeDays, 2.2, 0.05, "age via creator path");
    assert.equal(row.lookaheadOk, true);
    assert.deepEqual(row.errors, [], row.errors.join("|"));
    // the early window was read with before=anchor, until=create
    assert.ok(rpc.calls.some((c) => c.addr === MINT && c.before === "ANCHOR" && c.until === createSig));
  }
  // no creator tx after the create -> create facts kept, early fields null + error
  const saved = universe[CREATOR];
  universe[CREATOR] = saved.slice(1);
  const r3 = await E.enrichMint({ mint: MINT }, { rpc: longRpc(), fetchJson: fixtureJson, maxPages: 2, mintMaxPages: 2 });
  universe[CREATOR] = saved;
  assert.equal(r3.createSig, createSig);
  assert.equal(r3.first20BuyersSol, null);
  assert.ok(r3.errors.includes("early: history too long and no creator tx after the create"), r3.errors.join("|"));
  assert.equal(r3.creatorPriorTokens, 2, "creator facts still filled");
  // the mint's own history gets the deeper cap (mintMaxPages) before the creator path is tried:
  // 2598 sigs = 3 pages, over maxPages 2 but under mintMaxPages 5 -> found through the mint
  const deep = longRpc();
  const r4 = await E.enrichMint({ mint: MINT, entryUtc: "2026-11-13 22:35:56" }, { rpc: deep, fetchJson: fixtureJson, maxPages: 2, mintMaxPages: 5 });
  assert.equal(r4.createFoundVia, "mint");
  assert.equal(r4.mintSigs, universe[MINT].length);
  assert.equal(r4.createSig, createSig);
  near(r4.first20BuyersSol, 33.19, 0.005, "first20 via deep mint history");
  assert.equal(r4.devBuySol, 0.873681689);
  assert.deepEqual(r4.errors, [], r4.errors.join("|"));
  assert.ok(!deep.calls.some((c) => c.addr === MINT && c.until), "no creator-path window");
  // the creator acted again right after the create (NEAR, same slot): that window holds no buy,
  // so the next anchor (LATER, two txs on) is used
  universe[CREATOR] = [saved[0], { signature: "NEAR", slot: createTx.slot, blockTime: createTx.blockTime, err: false }, ...saved.slice(1)];
  slotOf.set("NEAR", createTx.slot);
  const ext = longRpc();
  const r5 = await E.enrichMint({ mint: MINT }, { rpc: ext, fetchJson: fixtureJson, maxPages: 2, mintMaxPages: 2 });
  universe[CREATOR] = saved;
  const windows = ext.calls.filter((c) => c.addr === MINT && c.until).map((c) => c.before);
  assert.deepEqual([...new Set(windows)], ["NEAR", "ANCHOR"], "NEAR first, then the later anchor");
  near(r5.first20BuyersSol, 33.19, 0.005, "first20 after anchor extension");
  assert.equal(r5.sameSecondBuyers, 23);
  assert.deepEqual(r5.errors, [], r5.errors.join("|"));
  ok("history over the cap: deeper mint cap first; then creator from the newest trade (or the curve account), create via the creator, early window before/until");
}

// ---- 6. input parsing + resume ---------------------------------------------------------------
{
  const txt = [
    "  1  49VVQVn7BgEUzD8yKhSHBHa6CAQnbgaP5QVTMKrQpump  2026-11-13 22:35:56",
    "",
    "# comment",
    "2xwjxcKpj57K1CqyJtiVU2CykkRNwsBViJcRw5mfpump",
    "12  3PcAYGBrYUGYi6aL74RbiW2X4GRVjKSwHCZ2Mvb2pump  2026-11-13T19:43:30Z",
    "garbage line here",
  ].join("\r\n");
  const { rows, bad } = E.parseInputText(txt);
  assert.deepEqual(rows, [
    { n: 1, mint: MINT, entryUtc: "2026-11-13 22:35:56" },
    { n: null, mint: "2xwjxcKpj57K1CqyJtiVU2CykkRNwsBViJcRw5mfpump", entryUtc: null },
    { n: 12, mint: "3PcAYGBrYUGYi6aL74RbiW2X4GRVjKSwHCZ2Mvb2pump", entryUtc: "2026-11-13 19:43:30" },
  ]);
  assert.equal(bad.length, 1);
  assert.equal(E.entryToSec("2026-11-13 22:14:59"), 1794608099);
  assert.equal(E.entryToSec(null), null);
  const done = E.doneMints(`{"mint":"A"}\n{"mint":"B"}\n{"mint":"C`);
  assert.deepEqual([...done], ["A", "B"], "a cut-off last line is redone");
  // the real batch files parse completely
  for (let i = 1; i <= 6; i++) {
    const f = path.join(repo, "agents", `BROWSER_BATCH_${i}.txt`);
    if (!fs.existsSync(f)) continue;
    const r = E.parseInputText(fs.readFileSync(f, "utf8"));
    assert.equal(r.bad.length, 0, `batch ${i} parses`);
    assert.ok(r.rows.every((x) => x.entryUtc && x.n != null));
  }

  // CLI: resume skips the mint already in --out; the new mint is processed through the mock
  // connection and gets a row with an error, not a crash; --live is refused.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-"));
  const inF = path.join(dir, "in.txt");
  const outF = path.join(dir, "out.jsonl");
  const NEW = "2xwjxcKpj57K1CqyJtiVU2CykkRNwsBViJcRw5mfpump";
  fs.writeFileSync(inF, `1  ${MINT}  2026-11-13 22:35:56\n2  ${NEW}  2026-11-14 02:45:40\n`);
  fs.writeFileSync(outF, JSON.stringify({ mint: MINT, kept: true }) + "\n");
  const env = cleanEnv({ RPC_URL: "https://poison.invalid/?api-key=POISON_ENRICH", RPC_MOCK: path.join(here, "mocks", "enrich-rpc-mock.mjs") });
  const run = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF], { cwd: repo, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!run.stdout.includes(`MOCK getSignatures ${MINT}`), "resumed mint untouched");
  assert.ok(run.stdout.includes(`MOCK getSignatures ${NEW}`), "new mint processed");
  assert.ok(!/POISON_ENRICH|poison\.invalid/.test(run.stdout + run.stderr), "RPC url never printed");
  const lines = fs.readFileSync(outF, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { mint: MINT, kept: true });
  assert.equal(lines[1].mint, NEW);
  assert.equal(lines[1].n, 2);
  assert.equal(lines[1].creator, null);
  assert.ok(lines[1].errors.includes("mint: no pump.fun create among the oldest txs"), lines[1].errors.join("|"));
  assert.equal(typeof lines[1].rpcCalls, "number");
  // second run: nothing to do
  const run2 = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF], { cwd: repo, encoding: "utf8", env });
  assert.equal(run2.status, 0);
  assert.ok(!run2.stdout.includes("MOCK "), "fully resumed run makes no RPC call");
  assert.equal(fs.readFileSync(outF, "utf8").trim().split("\n").length, 2);
  // --retry-errors: the errored line of NEW is dropped and re-run, the clean line stays, .bak kept;
  // an errored line of a mint not in --in is left alone
  const OTHER = "DmjAMfGitYb5NwVrWwJLfFe5GWijYddDk4MTFhmYpump";
  fs.appendFileSync(outF, JSON.stringify({ mint: OTHER, errors: ["x"] }) + "\n");
  assert.deepEqual([...E.doneMints(fs.readFileSync(outF, "utf8"), { retryErrors: true })], [MINT]);
  const before3 = fs.readFileSync(outF, "utf8");
  const run3 = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF, "--retry-errors"], { cwd: repo, encoding: "utf8", env });
  assert.equal(run3.status, 0, run3.stderr);
  assert.ok(!run3.stdout.includes(`MOCK getSignatures ${MINT}`), "clean line not re-run");
  assert.ok(run3.stdout.includes(`MOCK getSignatures ${NEW}`), "errored line re-run");
  assert.equal(fs.readFileSync(outF + ".bak", "utf8"), before3);
  const after3 = fs.readFileSync(outF, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(after3.map((o) => o.mint), [MINT, OTHER, NEW], "one line per mint, NEW re-appended");
  assert.deepEqual(after3[1], { mint: OTHER, errors: ["x"] });
  // --retry-match <regex>: only lines with a matching error are re-run
  const jl = [{ mint: "A", errors: ["creator: history capped, funding unknown"] }, { mint: "B", errors: ["mint: history too long, create not found in 3 creator txs"] }, { mint: "C", errors: [] }].map((o) => JSON.stringify(o)).join("\n");
  assert.deepEqual([...E.doneMints(jl, { retryMatch: /^(mint|early):/ })], ["A", "C"]);
  assert.deepEqual([...E.doneMints(jl, { retryErrors: true })], ["C"]);
  const runNo = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF, "--retry-match", "^uri:"], { cwd: repo, encoding: "utf8", env });
  assert.equal(runNo.status, 0, runNo.stderr);
  assert.ok(!runNo.stdout.includes("MOCK "), "no matching error -> nothing re-run");
  const runYes = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF, "--retry-match", "^mint:"], { cwd: repo, encoding: "utf8", env });
  assert.equal(runYes.status, 0, runYes.stderr);
  assert.ok(runYes.stdout.includes(`MOCK getSignatures ${NEW}`) && !runYes.stdout.includes(`MOCK getSignatures ${MINT}`));
  assert.deepEqual(fs.readFileSync(outF, "utf8").trim().split("\n").map((l) => JSON.parse(l).mint), [MINT, OTHER, NEW]);
  const live = spawnSync(process.execPath, [path.join(here, "enrich-mints.mjs"), "--in", inF, "--out", outF, "--live"], { cwd: repo, encoding: "utf8", env });
  assert.notEqual(live.status, 0, "--live refused");
  ok("input parsing (numbered + plain + batch files), resume via CLI, --live refused, url not printed");
}

console.log(`enrich-mints: ${passed} passed`);
