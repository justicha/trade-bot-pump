import "./lib/test-env.mjs";
// elon-watch keywords (KODING #25): lib/elon-keywords.mjs extractKeywords on the human's two examples and
// the extraction rules; lib/elon-vision.mjs with a stub client (no network, the SDK is never loaded).
import assert from "node:assert/strict";

const K = await import("../lib/elon-keywords.mjs");
const V = await import("../lib/elon-vision.mjs");
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};
const norms = (p) => K.extractKeywords(p).map((k) => k.norm);
const get = (p, n) => K.extractKeywords(p).find((k) => k.norm === n);

// 1. the human's examples
{
  const saturn = K.extractKeywords({ id: "1", kind: "post", text: "Saturn" });
  assert.equal(saturn[0].norm, "saturn");
  assert.equal(saturn[0].reason, "short");
  assert.equal(saturn[0].weight, 1);
  assert.deepEqual(saturn[0].variants, ["saturn", "saturns"]);
  assert.ok(saturn[0].reasons.includes("shortWord"));
  // a reply whose only text is an emoji, with a Pepe image captioned "capium" (alt_text)
  const reply = { id: "2", kind: "reply", text: "@someone 🐸", media: [{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg", alt: "capium" }], refs: [{ type: "replied_to", id: "9", text: "gm" }] };
  const capium = get(reply, "capium");
  assert.equal(capium.reason, "alt:short");
  assert.equal(capium.source, "alt");
  assert.ok(norms(reply).includes("pepe"), "frog emoji -> pepe");
  // the same reply without alt_text, with a mocked vision result instead
  const vis = get({ ...reply, media: [{ type: "photo", url: "u" }], vision: [{ texts: ["CAPIUM"], characters: ["Pepe"] }] }, "capium");
  assert.equal(vis.reason, "vision");
  assert.ok(norms({ ...reply, media: [], vision: [{ texts: [], characters: ["pepe the frog"] }] }).includes("pepethefrog"));
  ok("examples: post \"Saturn\" -> saturn (short, weight 1); reply with alt_text / mocked vision \"capium\" -> capium; frog emoji -> pepe");
}

// 2. stop words, filler, mentions, URLs, min length
{
  assert.deepEqual(norms({ id: "3", kind: "post", text: "Exactly!!" }), []);
  assert.deepEqual(norms({ id: "4", kind: "reply", text: "@foo Yes" }), []);
  assert.deepEqual(norms({ id: "5", kind: "post", text: "lol true https://t.co/AbCdEf" }), []);
  assert.deepEqual(norms({ id: "6", kind: "post", text: "Wow. Interesting!" }), []);
  assert.ok(!norms({ id: "7", kind: "post", text: "Concerning @SomeUser" }).includes("someuser"));
  assert.deepEqual(norms({ id: "8", kind: "post", text: "OK" }), [], "below MIN_LEN");
  assert.deepEqual(norms({ id: "9", kind: "post", text: "XI" }), [], "a 2-letter non-stop word is below MIN_LEN");
  ok("stop words / Elon filler dropped (yes, true, wow, exactly, !!, lol, interesting, concerning); @mentions and URLs removed; min length 3");
}

// 3. cashtag, hashtag, quoted, caps, capitalized not at sentence start, bigram, plural, NFKC, leading "the"
{
  const p = { id: "10", kind: "post", text: "Buy $DOGE and #DarkMAGA. We call it \"The Gothic Rockets\" with Starship TESLA power!" };
  assert.equal(get(p, "doge").reason, "cashtag");
  assert.equal(get(p, "darkmaga").reason, "hashtag");
  assert.equal(get(p, "gothicrockets").reason, "quoted", "leading 'the' dropped");
  assert.ok(get(p, "gothicrockets").variants.includes("gothicrocket"), "plural -> singular variant");
  assert.equal(get(p, "tesla").reason, "caps");
  assert.equal(get(p, "starship").reason, "capitalized");
  assert.ok(!norms(p).includes("buy") && !norms(p).includes("we"), "sentence-start words are not 'capitalized'");
  assert.equal(get(p, "starshiptesla").reason, "bigram");
  assert.equal(get({ id: "11", kind: "post", text: "dark maga is back" }, "darkmaga").reason, "bigram", "adjacent bigram joined");
  assert.equal(get({ id: "12", kind: "post", text: "Ｓａｔｕｒｎ" }, "saturn").reason, "short", "NFKC full-width");
  assert.equal(get({ id: "13", kind: "post", text: "Pokémon" }, "pokemon").norm, "pokemon", "diacritics stripped");
  assert.deepEqual(K.variantsOf("puppies"), ["puppies", "puppy"]);
  assert.deepEqual(K.variantsOf("cats"), ["cats", "cat"]);
  assert.deepEqual(K.variantsOf("boss"), ["boss", "bosses"]);
  ok("cashtag / hashtag / quoted / ALL-CAPS / Capitalized (not at a sentence start) / bigram; NFKC, diacritics, leading 'the', plural <-> singular variants");
}

// 4. sources: parent (reply / quote) text with a lower weight, repost uses the reposted text, dedupe by norm
{
  const q = { id: "20", kind: "quote", text: "Wow", refs: [{ type: "quoted", id: "21", text: "Introducing the Kekius Maximus" }] };
  const k = get(q, "kekius");
  assert.equal(k.reason, "parent:capitalized");
  assert.equal(k.source, "parent");
  assert.equal(k.weight, Math.round(0.5 * 0.6 * 100) / 100);
  const rt = { id: "22", kind: "repost", text: "RT @x: Mars cats…", refs: [{ type: "retweeted", id: "23", text: "Mars cats are coming to the Moon base" }] };
  assert.ok(norms(rt).includes("moonbase") && norms(rt).includes("moon"));
  const d = K.extractKeywords({ id: "24", kind: "post", text: "$SATURN Saturn" });
  assert.equal(d.filter((x) => x.norm === "saturn").length, 1, "one entry per norm");
  assert.equal(d[0].reason, "cashtag", "the strongest reason wins");
  assert.ok(d[0].reasons.length >= 2);
  ok("parent text (reply / quote) at weight x 0.6 with a parent: prefix; repost -> the reposted text; one entry per norm, strongest reason kept");
}

// 5. vision with a stub client: request shape, JSON parsing, timeout / errors never throw
{
  let req = null;
  const stub = { messages: { create: async (body, opts) => ((req = { body, opts }), { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ texts: [" capium "], characters: ["pepe"] }) }] }) } };
  const vc = await V.createVisionClient({ client: stub, timeoutMs: 4000 });
  let t = 1000;
  const r = await V.readImage(vc, "https://pbs.twimg.com/media/x.jpg", { now: () => (t += 250) });
  assert.deepEqual(r.texts, ["capium"]);
  assert.deepEqual(r.characters, ["pepe"]);
  assert.equal(r.latencyMs, 250);
  assert.equal(r.error, null);
  assert.equal(req.body.model, "claude-haiku-5-5");
  assert.equal(req.body.output_config.format.type, "json_schema");
  assert.equal(req.body.messages[0].content[0].source.url, "https://pbs.twimg.com/media/x.jpg");
  assert.equal(req.opts.timeout, 4000);
  assert.equal(req.opts.maxRetries, 0);
  const bad = await V.readImage({ client: { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }) } }, timeoutMs: 1 }, "u");
  assert.equal(bad.error, "bad-json");
  const thrown = await V.readImage({ client: { messages: { create: async () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })) } }, timeoutMs: 1 }, "u");
  assert.equal(thrown.error, "TimeoutError");
  assert.deepEqual(thrown.texts, []);
  const refused = await V.readImage({ client: { messages: { create: async () => ({ stop_reason: "refusal", content: [] }) } }, timeoutMs: 1 }, "u");
  assert.equal(refused.error, "refusal");
  await assert.rejects(V.createVisionClient({ apiKey: "" }), /ANTHROPIC_API_KEY/);
  ok("vision (stub client): claude-haiku-5-5, json_schema output, image by URL, 4 s timeout, no retries; bad JSON / timeout / refusal -> empty result with an error, never a throw");
}

console.log(`elon-keywords: ${passed} checks passed`);
