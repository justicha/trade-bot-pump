import "./lib/test-env.mjs";
// elon-watch matching (KODING #25): lib/elon-match.mjs — match kinds, the token index windows (before /
// after the post), the generic flag, repeat events, "linked" from a metadata fixture, metadata URL
// safety. Pure, no network.
import assert from "node:assert/strict";

const M = await import("../lib/elon-match.mjs");
const { extractKeywords } = await import("../lib/elon-keywords.mjs");
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};
const kw = (norm) => ({ norm, variants: [norm, norm.endsWith("s") ? norm.slice(0, -1) : norm + "s"] });
const keys = (name, symbol) => M.tokenKeys({ name, symbol });

// 1. match kinds
{
  assert.equal(M.matchKind(kw("saturn"), keys("Saturn Coin", "SATURN")), "symbol");
  assert.equal(M.matchKind(kw("saturn"), keys("Saturn", "SAT")), "name");
  assert.equal(M.matchKind(kw("saturn"), keys("Saturn Coin", "STC")), "token", "whole word of the name");
  assert.equal(M.matchKind(kw("saturn"), keys("SaturnCoin", "SC")), "token", "camelCase split");
  assert.equal(M.matchKind(kw("saturn"), keys("Saturnalia", "SAL")), null, "a substring is not a whole word");
  assert.equal(M.matchKind(kw("saturn"), keys("Saturns", "XX")), "name", "plural variant");
  assert.equal(M.matchKind(kw("capium"), keys("Capiun", "CPN")), "fuzzy", "Levenshtein 1 at length >= 5");
  assert.equal(M.matchKind(kw("capium"), keys("Copiun", "CPN")), null, "distance 2");
  assert.equal(M.matchKind(kw("pepe"), keys("Pepa", "PPA")), null, "no fuzzy below length 5");
  assert.equal(M.matchKind(kw("darkmaga"), keys("Dark MAGA", "DMAGA")), "name", "multi-word name norm");
  assert.equal(M.levenshtein("kitten", "sitting"), 3);
  assert.equal(M.levenshtein("abc", "abcdef", 1), 2, "early exit returns max + 1");
  ok("match kinds: exact symbol / exact name / whole word (incl. camelCase) / Levenshtein <= 1 at length >= 5; substring and distance 2 do not match");
}

// 2. index windows around the post, generic flag, eviction
{
  const post = 1_800_000_000;
  const idx = M.createTokenIndex();
  const add = (mint, name, symbol, createSec) => M.indexAdd(idx, { mint, name, symbol, createSec });
  add("old", "Saturn", "SAT", post - 7 * 3600); // outside the 6 h before-window (still in the 24 h generic window)
  add("b1", "Saturn", "SAT1", post - 3600);
  add("b2", "SATURN", "S2", post - 60);
  add("a1", "Saturn Inu", "SINU", post + 5);
  add("a2", "saturn", "SATURN", post + 1799);
  add("late", "Saturn", "S9", post + 1801); // after the 30 min after-window
  add("other", "Jupiter", "JUP", post + 10);
  assert.equal(add("a1", "dup", "dup", post), null, "a mint is indexed once");
  const ev = { postSec: post, ...kw("saturn") };
  const m = M.matchEvent(idx, ev);
  assert.deepEqual(m.before.map((x) => x.entry.mint), ["b1", "b2"]);
  assert.deepEqual(m.after.map((x) => x.entry.mint), ["a1", "a2"]);
  assert.deepEqual(m.after.map((x) => x.kind), ["token", "symbol"]);
  assert.equal(m.generic, false, "3 matches in the 24 h before: not generic");
  for (let i = 0; i < 2; i++) add(`g${i}`, "Saturn", `G${i}`, post - 10_000 - i);
  assert.equal(M.matchEvent(idx, ev).generic, false, "exactly 5 in the 24 h before: not generic (more than 5 is)");
  add("g2", "Saturn", "G2", post - 10_002);
  assert.equal(M.matchEvent(idx, ev).generic, true, "6 matches in the 24 h before -> generic");
  assert.equal(M.isGeneric([{ createSec: post - 10 }], post, { min: 1 }), true);
  assert.equal(M.isGeneric([{ createSec: post + 10 }], post, { min: 1 }), false, "after the post does not count");
  // live eviction (time ordered)
  const live = M.createTokenIndex({ maxEntries: 3 });
  for (let i = 0; i < 5; i++) M.indexAdd(live, { mint: `m${i}`, name: "Saturn", symbol: "S", createSec: 100 + i });
  assert.equal(M.indexSize(live), 3, "maxEntries");
  M.indexEvictBefore(live, 104);
  assert.deepEqual([...live.byMint.keys()], ["m4"]);
  assert.equal(M.indexFind(live, kw("saturn")).length, 1, "evicted entries are not found");
  ok("index: before = [post - 6 h, post), after = [post, post + 30 min]; generic = more than 5 matches in the 24 h before; a mint once; maxEntries / evictBefore");
}

// 3. keyword events: repeat within 24 h counted once
{
  const posts = [
    { id: "1", postMs: 1_000_000_000, kind: "post", text: "Saturn" },
    { id: "2", postMs: 1_000_000_000 + 3600_000, kind: "post", text: "Saturn" },
    { id: "3", postMs: 1_000_000_000 + 25 * 3600_000, kind: "post", text: "Saturn" },
  ];
  const evs = M.keywordEvents(posts, extractKeywords);
  assert.deepEqual(evs.map((e) => [e.postId, e.norm, e.repeat]), [["1", "saturn", false], ["2", "saturn", true], ["3", "saturn", false]]);
  assert.equal(evs[0].eventId, "1:saturn");
  ok("keyword events: the same norm within 24 h is repeat: true; after 24 h a new event");
}

// 4. linked: the metadata points at THIS post
{
  const postId = "1861234567890123456";
  const fixture = { name: "CAPIUM", symbol: "CAPIUM", description: "the meme", twitter: `https://x.com/elonmusk/status/${postId}`, website: "https://capium.example" };
  assert.deepEqual(M.linkedInfo(fixture, postId), { linked: true, linkedField: "twitter", elonStatus: postId });
  const other = { twitter: "https://twitter.com/elonmusk/status/1861111111111111111", description: "x" };
  assert.deepEqual(M.linkedInfo(other, postId), { linked: false, linkedField: null, elonStatus: "1861111111111111111" });
  assert.equal(M.linkedInfo({ description: `based on ${postId}` }, postId).linked, true, "the bare id in the description");
  assert.equal(M.linkedInfo({ extensions: { website: `https://x.com/elonmusk/status/${postId}?s=20` } }, postId).linkedField, "website");
  assert.equal(M.linkedInfo(null, postId).linked, false);
  assert.equal(M.linkedInfo({ twitter: "https://x.com/someone" }, postId).linked, false);
  ok("linked: twitter / website / description (or extensions) containing the post id or its elonmusk/status URL; another elonmusk status is recorded, not linked");
}

// 5. metadata URL safety (the uri is chosen by the token's launcher)
{
  assert.equal(M.metadataUrl("ipfs://QmAbCdEfGhIjKlMnOpQrStUv123"), "https://ipfs.io/ipfs/QmAbCdEfGhIjKlMnOpQrStUv123");
  assert.equal(M.metadataUrl("ipfs://QmShort"), null, "not a CID");
  assert.equal(M.metadataUrl("https://ipfs.io/ipfs/bafkreiabc"), "https://ipfs.io/ipfs/bafkreiabc");
  for (const bad of ["http://example.com/a.json", "https://127.0.0.1/a", "https://10.0.0.5/x", "https://localhost/x", "https://[::1]/x", "https://user:pw@host.example/x", "file:///etc/passwd", "javascript:alert(1)", "ipfs://../../etc", "", null, "x".repeat(500)]) assert.equal(M.metadataUrl(bad), null, String(bad).slice(0, 30));
  const urls = M.metadataUrls("https://ipfs.io/ipfs/bafkreiabcdefghijklmnopqrstu");
  assert.equal(urls[0], "https://ipfs.io/ipfs/bafkreiabcdefghijklmnopqrstu");
  assert.ok(urls.includes("https://dweb.link/ipfs/bafkreiabcdefghijklmnopqrstu") && urls.length === 3, "other gateways for the same CID");
  assert.deepEqual(M.metadataUrls("https://meta.example/x.json"), ["https://meta.example/x.json"]);
  ok("metadata URL: https / ipfs only; no plain http, IPs, localhost, credentials, other schemes; IPFS CIDs get the other public gateways");
}

console.log(`elon-match: ${passed} checks passed`);
