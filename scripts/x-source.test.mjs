import "./lib/test-env.mjs";
// elon-watch X source (KODING #25): lib/x-source.mjs against a local mock X API (127.0.0.1, no network):
// post normalization, the spend ledger (UTC-day dedupe, budget stop), 429 / 5xx backoff, the rate-limit
// poll interval, the api / replay / stream providers (stream -> api fallback), secret masking; then the
// processes: scripts/elon-fetch.mjs (pagination, cache, budget stop, no double read) and
// bots/elon-watch/elon.mjs on the census fixture socket with replayed posts (the Anthropic SDK is never
// loaded with ELON_VISION=0, the token never printed, bad env / --live refused).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const X = await import("../lib/x-source.mjs");
const { maskSecrets, addSecretValue } = await import("../lib/logger.mjs");
const CM = await import("./mocks/ws-mock-census.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
let passed = 0;
const ok = (m) => {
  passed += 1;
  console.log(`ok - ${m}`);
};
const TOKEN = "test-bearer-AAAAAAAAAAAAAAAAAAAA%3Dsecret123";
const USER_ID = "44196397";
const idAt = (ms, seq = 0) => String(((BigInt(ms) - 1288834974657n) << 22n) + BigInt(seq));

// ---- mock X API ---------------------------------------------------------------------------------------------------------
function mockX(handler) {
  const reqs = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      reqs.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, body });
      const out = handler(reqs.at(-1), reqs) || { status: 404, json: { error: "nf" } };
      if (out.stream) return out.stream(res);
      res.writeHead(out.status ?? 200, { "content-type": "application/json", "x-rate-limit-limit": "10000", "x-rate-limit-remaining": "9990", "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900), ...(out.headers || {}) });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, reqs, base: `http://127.0.0.1:${server.address().port}` })));
}
const tweet = (id, text, extra = {}) => ({ id, text, created_at: new Date(X.snowflakeMs(id)).toISOString(), conversation_id: id, ...extra });

// 1. normalization, snowflake time
{
  const ms = Date.parse("2026-11-20T12:00:00.123Z");
  const id = idAt(ms, 5);
  assert.equal(X.snowflakeMs(id), ms);
  const includes = {
    tweets: [{ id: "2", text: "the parent text" }, { id: "3", text: "RT full", note_tweet: { text: "the long reposted text" } }],
    media: [{ media_key: "m1", type: "photo", url: "https://pbs.twimg.com/media/a.jpg", alt_text: "capium" }],
  };
  const reply = X.normalizePost(tweet(id, "@x 🐸", { referenced_tweets: [{ type: "replied_to", id: "2" }], attachments: { media_keys: ["m1"] } }), includes, { seenAtMs: ms + 1500, provider: "api" });
  assert.equal(reply.kind, "reply");
  assert.equal(reply.postMs, ms);
  assert.equal(reply.detectLagMs, 1500);
  assert.deepEqual(reply.refs, [{ type: "replied_to", id: "2", text: "the parent text" }]);
  assert.deepEqual(reply.media, [{ key: "m1", type: "photo", url: "https://pbs.twimg.com/media/a.jpg", alt: "capium", own: true }]);
  const rt = X.normalizePost(tweet(idAt(ms, 6), "RT @a: …", { referenced_tweets: [{ type: "retweeted", id: "3" }] }), includes);
  assert.equal(rt.kind, "repost");
  assert.equal(rt.refs[0].text, "the long reposted text", "note_tweet preferred");
  assert.equal(X.normalizePost(tweet(idAt(ms, 7), "x", { referenced_tweets: [{ type: "quoted", id: "9" }] }), {}).kind, "quote");
  assert.equal(X.normalizePost(tweet(idAt(ms, 8), "short", { note_tweet: { text: "the long version" } }), {}).text, "the long version");
  ok("normalizePost: kind post / reply / quote / repost, referenced post text (note_tweet first), media alt_text, snowflake ms time, detectLagMs");
}

// 2. ledger: UTC-day dedupe, user reads, budget, day roll; backoff / poll interval; masking
{
  let now = Date.parse("2026-11-20T23:59:00Z");
  const file = path.join(tmp("x-ledger-"), "spend.json");
  const L = X.createSpendLedger({ file, pricePerPost: 0.005, dailyBudgetUsd: 0.05, now: () => now });
  assert.equal(L.notePosts(["1", "2", "3"]), 0.015);
  assert.equal(L.notePosts(["2", "3", "4"]), 0.005, "a post re-read the same UTC day is not billed again");
  L.noteUserRead();
  assert.equal(L.usd(), 0.03);
  assert.equal(L.postsLeft(), 4);
  const L2 = X.createSpendLedger({ file, pricePerPost: 0.005, dailyBudgetUsd: 0.05, now: () => now });
  assert.equal(L2.usd(), 0.03, "persisted across processes");
  L2.notePosts(["5", "6", "7", "8"]);
  assert.equal(L2.exhausted(), true);
  now = Date.parse("2026-11-21T00:00:01Z");
  assert.equal(L2.usd(), 0, "a new UTC day");
  assert.equal(L2.notePosts(["1"]), 0.005, "the same post the next day is billed again");
  assert.equal(X.backoffMs({ status: 500, attempt: 3 }), 8000);
  assert.equal(X.backoffMs({ status: 500, attempt: 30 }), 120_000);
  assert.equal(X.backoffMs({ status: 429, attempt: 1, resetEpochSec: 1010, nowMs: 1_000_000 }), 10_500);
  assert.equal(X.pollWaitMs({ pollMs: 2000, rate: { limit: 10_000, remaining: 9000, reset: 0 } }), 2000, "10,000 / 15 min allows 113 ms: the configured 2 s rules");
  assert.equal(X.pollWaitMs({ pollMs: 2000, rate: { limit: 300, remaining: 200, reset: 0 } }), 3750);
  assert.equal(X.pollWaitMs({ pollMs: 2000, rate: { limit: 300, remaining: 1, reset: 1020 }, nowMs: 1_000_000 }), 20_500, "window almost used: wait for the reset");
  addSecretValue(TOKEN);
  assert.ok(!maskSecrets(`x ${TOKEN} y`).includes("secret123"));
  assert.equal(maskSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [REDACTED]");
  assert.equal(maskSecrets("key sk-ant-api03-ABCDEFGHIJKL_mn"), "key [REDACTED_API_KEY]");
  assert.ok(!X.safeSnippet(`{"detail":"Bearer ${TOKEN}"}`).includes("secret123"));
  ok("ledger: unique post ids per UTC day (+ user reads x 2), persisted, budget exhausted, next day billed again; backoff (429 reset, 5xx exponential, cap); poll interval from x-rate-limit; token masked in logs and error snippets");
}

// 3. api provider: 429 then posts, since_id, empty polls, budget stop; user id cached
{
  const t0 = Date.now() - 5000;
  const ids = [idAt(t0, 1), idAt(t0 + 1000, 2), idAt(t0 + 2000, 3)];
  let n = 0;
  const { server, reqs, base } = await mockX((r) => {
    if (r.path === `/2/users/by/username/elonmusk`) return { json: { data: { id: USER_ID, username: "elonmusk" } } };
    if (r.path !== `/2/users/${USER_ID}/tweets`) return null;
    n += 1;
    if (n === 1) return { status: 429, json: { title: "Too Many Requests" }, headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000)) } };
    if (n === 2) return { json: { data: [tweet(ids[1], "Saturn"), tweet(ids[0], "Yes", { referenced_tweets: [{ type: "replied_to", id: "77" }] })], includes: { tweets: [{ id: "77", text: "parent" }] }, meta: { newest_id: ids[1], result_count: 2 } } };
    if (n === 3) return { json: { meta: { result_count: 0 } } };
    if (n === 4) return { status: 503, json: {} };
    const id = n === 5 ? ids[2] : idAt(t0 + 3000 + n, n);
    return { json: { data: [tweet(id, "Mars")], meta: { newest_id: id, result_count: 1 } } };
  });
  const dir = tmp("x-api-");
  const ledger = X.createSpendLedger({ file: path.join(dir, "spend.json"), dailyBudgetUsd: 0.035 });
  const client = X.createXClient({ bearer: TOKEN, baseUrl: base });
  const userId = await X.resolveUserId(client, "elonmusk", { cacheFile: path.join(dir, "user.json"), ledger });
  assert.equal(userId, USER_ID);
  assert.equal(await X.resolveUserId(client, "elonmusk", { cacheFile: path.join(dir, "user.json"), ledger }), USER_ID);
  assert.equal(reqs.filter((r) => r.path.includes("by/username")).length, 1, "the user id is resolved once, then cached");
  const posts = [];
  const states = [];
  const waits = [];
  const src = X.createApiSource({ client, userId, ledger, pollMs: 1000, onPost: (p) => posts.push(p), onState: (s) => states.push(s), sleep: async (ms) => waits.push(ms) });
  await src.start();
  server.close();
  const tw = reqs.filter((r) => r.path.endsWith("/tweets"));
  assert.ok(tw.every((r) => r.auth === `Bearer ${TOKEN}`));
  assert.ok(tw[0].q.start_time && !tw[0].q.since_id, "the first poll looks back with start_time, not an old since_id");
  assert.equal(tw[2].q.since_id, ids[1], "then since_id = newest_id");
  assert.equal(tw[0].q.expansions, X.EXPANSIONS);
  assert.ok(tw[0].q["tweet.fields"].includes("note_tweet") && tw[0].q["media.fields"].includes("alt_text"));
  assert.ok(!("exclude" in tw[0].q), "replies / reposts included");
  assert.deepEqual(posts.slice(0, 3).map((p) => p.id), [ids[0], ids[1], ids[2]], "oldest first");
  assert.equal(posts.length, 4);
  assert.ok(posts.every((p) => p.provider === "api" && Number.isFinite(p.detectLagMs)));
  assert.equal(states.filter((s) => s.state === "down").map((s) => s.status).join(), "429,503");
  assert.ok(waits.includes(2000), "backoff after the 429 (reset already passed -> the 2 s floor)");
  assert.equal(states.at(-1).state, "budget");
  assert.equal(states.at(-1).usd, 0.035, "user read 0.01 + 5 billed posts (2 + the referenced one, then 1 + 1) x 0.005");
  assert.equal(src.stats.http429, 1);
  assert.equal(src.stats.http5xx, 1);
  assert.equal(tw.length, 6, "no request after the budget stop");
  ok("api provider: 429 / 503 backoff, never throws; start_time first, since_id after; expansions / fields as specified, no exclude=; oldest first; budget reached -> state budget and no more requests; user id resolved once");
}

// 4. replay provider and the stream provider (-> api fallback on 403)
{
  const dir = tmp("x-replay-");
  const file = path.join(dir, "posts.jsonl");
  fs.writeFileSync(file, [{ id: "2", postMs: 2000, kind: "post", text: "b" }, { id: "1", postMs: 1000, kind: "post", text: "a" }].map((p) => JSON.stringify(p)).join("\n") + "\n");
  const got = [];
  const states = [];
  await X.createReplaySource({ file, onPost: (p) => got.push(p), onState: (s) => states.push(s.state) }).start();
  assert.deepEqual(got.map((p) => [p.id, p.provider]), [["1", "replay"], ["2", "replay"]]);
  assert.deepEqual(states, ["up", "done"]);
  const sid = idAt(Date.now() - 800, 9);
  let connects = 0;
  const { server, reqs, base } = await mockX((r) => {
    if (r.path === "/2/tweets/search/stream/rules" && r.method === "GET") return { json: { meta: { result_count: 0 } } };
    if (r.path === "/2/tweets/search/stream/rules" && r.method === "POST") return { status: 201, json: { data: [{ id: "1" }] } };
    if (r.path === "/2/tweets/search/stream") {
      connects += 1;
      if (connects > 1) return { status: 403, json: { title: "Forbidden" } };
      return {
        stream: (res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("\r\n");
          res.write(JSON.stringify({ data: tweet(sid, "Saturn"), includes: {}, matching_rules: [{ id: "1" }] }) + "\r\n");
          setTimeout(() => res.end(), 50);
        },
      };
    }
    return null;
  });
  const ledger = X.createSpendLedger({ dailyBudgetUsd: 1 });
  const client = X.createXClient({ bearer: TOKEN, baseUrl: base });
  const posts = [];
  const st = [];
  let fallbackStarted = false;
  const src = X.createStreamSource({ client, username: "elonmusk", ledger, bearer: TOKEN, onPost: (p) => posts.push(p), onState: (s) => st.push(s), sleep: async () => {}, fallback: () => ({ start: async () => (fallbackStarted = true), stop: async () => {} }) });
  await src.start();
  server.close();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].provider, "stream");
  assert.equal(posts[0].id, sid);
  assert.equal(ledger.posts(), 1, "a delivered post is billed");
  assert.ok(reqs.some((r) => r.method === "POST" && JSON.parse(r.body).add[0].value === "from:elonmusk"), "the rule is added once missing");
  assert.equal(st.find((s) => s.state === "fallback")?.status, 403);
  assert.equal(fallbackStarted, true);
  assert.equal(connects, 2, "403 hands over at once (no third attempt)");
  ok("replay provider (postMs order, provider replay); stream provider: rule from:elonmusk, posts billed, 403 -> fallback to api");
}

// ---- processes -------------------------------------------------------------------------------------------------------------
const run = (script, args, env, { timeoutMs = 30_000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [...(env.__import ? ["--import", env.__import] : []), script, ...args], { cwd: root, env: cleanEnv(Object.fromEntries(Object.entries(env).filter(([k]) => k !== "__import"))) });
    let out = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (out += String(b)));
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });

// 5. scripts/elon-fetch.mjs: day windows oldest first, pagination, cache, no second read, budget stop
{
  const d20 = Date.parse("2026-11-20T10:00:00Z");
  const d21 = Date.parse("2026-11-21T10:00:00Z");
  const { server, reqs, base } = await mockX((r) => {
    if (r.path === "/2/users/by/username/elonmusk") return { json: { data: { id: USER_ID } } };
    if (r.path !== `/2/users/${USER_ID}/tweets`) return null;
    if (r.q.start_time.startsWith("2026-11-20")) {
      if (!r.q.pagination_token) return { json: { data: [tweet(idAt(d20 + 2000), "Saturn"), tweet(idAt(d20 + 1000), "Mars")], meta: { result_count: 2, next_token: "p2" } } };
      return { json: { data: [tweet(idAt(d20), "Pepe")], meta: { result_count: 1 } } };
    }
    return { json: { data: [tweet(idAt(d21), "Doge")], meta: { result_count: 1 } } };
  });
  const dir = tmp("elon-fetch-");
  const env = { X_API_BASE: base, X_BEARER_TOKEN: TOKEN, ELON_DIR: dir, X_DAILY_BUDGET_USD: "1" };
  const a = await run(path.join(here, "elon-fetch.mjs"), ["--from", "2026-11-20", "--to", "2026-11-22T00:00:00Z"], env);
  assert.equal(a.code, 0, a.out);
  assert.ok(!a.out.includes("secret123") && !a.out.includes(TOKEN), "the token is never printed");
  assert.match(a.out, /posts read 4 \(new in cache 4/);
  const tw = reqs.filter((r) => r.path.endsWith("/tweets"));
  assert.deepEqual(tw.map((r) => r.q.start_time.slice(0, 10)), ["2026-11-20", "2026-11-20", "2026-11-21"], "oldest day first, then its next page");
  assert.equal(tw[0].q.max_results, "100");
  assert.equal(tw[0].q.end_time, "2026-11-21T00:00:00.000Z");
  const cached = fs.readFileSync(path.join(dir, "posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(new Set(cached.map((p) => p.id)).size, 4);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "fetch-state.json"), "utf8")).doneDays), ["2026-11-20", "2026-11-21"]);
  const b = await run(path.join(here, "elon-fetch.mjs"), ["--from", "2026-11-20", "--to", "2026-11-22T00:00:00Z"], env);
  assert.equal(b.code, 0);
  assert.match(b.out, /done before/);
  assert.equal(reqs.filter((r) => r.path.endsWith("/tweets")).length, 3, "finished days are not read (paid) again");
  // budget stop: user read 0.01 + one page of 2 posts = 0.02 >= 0.015
  const dir2 = tmp("elon-fetch-b-");
  const c = await run(path.join(here, "elon-fetch.mjs"), ["--from", "2026-11-20", "--to", "2026-11-22T00:00:00Z"], { ...env, ELON_DIR: dir2, X_DAILY_BUDGET_USD: "0.015" });
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /STOPPED before the end of the window/);
  assert.ok(!fs.existsSync(path.join(dir2, "fetch-state.json")) || !JSON.parse(fs.readFileSync(path.join(dir2, "fetch-state.json"), "utf8")).doneDays["2026-11-20"], "a day cut by the budget is not marked done");
  const noTok = await run(path.join(here, "elon-fetch.mjs"), [], { ELON_DIR: dir2 });
  assert.equal(noTok.code, 1);
  assert.match(noTok.out, /X_BEARER_TOKEN is not set/);
  server.close();
  ok("elon-fetch: UTC day windows oldest first, pagination, posts cached (dedupe), finished days never read again, budget stop leaves the day not done, token never printed, no token -> exit 1");
}

// 6. bots/elon-watch/elon.mjs on the census fixture socket with a replayed post
{
  let rpcConnections = 0;
  const rpc = http.createServer((req, res) => {
    rpcConnections += 1;
    res.end("{}");
  });
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  const dir = tmp("elon-bot-");
  const replay = path.join(dir, "replay.jsonl");
  fs.writeFileSync(replay, JSON.stringify({ id: "1990000000000000123", postMs: 0, kind: "post", text: "Census Coin", refs: [], media: [{ type: "photo", url: "https://pbs.twimg.com/media/z.jpg" }], replayDelayMs: 0, replayLagMs: 3000 }) + "\n");
  const sdkLog = path.join(dir, "sdk.log");
  const hook = path.join(dir, "hook.mjs");
  fs.writeFileSync(hook, `import { registerHooks } from "node:module";\nimport fs from "node:fs";\nregisterHooks({ resolve(spec, ctx, next) { if (spec.startsWith("@anthropic-ai/sdk")) fs.appendFileSync(${JSON.stringify(sdkLog)}, spec + "\\n"); return next(spec, ctx); } });\n`);
  const env = { RPC_URL: `http://127.0.0.1:${rpc.address().port}`, WS_MOCK: path.join(here, "mocks", "ws-mock-census.mjs"), X_PROVIDER: "replay", X_REPLAY_FILE: replay, ELON_DIR: dir, ELON_META: "0", ELON_MAX_SEC: "4", X_BEARER_TOKEN: TOKEN, __import: pathToFileURL(hook).href };
  const r = await run(path.join(root, "bots", "elon-watch", "elon.mjs"), [], env);
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.out.includes("secret123"));
  assert.ok(!fs.existsSync(sdkLog), "ELON_VISION=0: the Anthropic SDK is never imported");
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  assert.equal(files.length, 1, "one MSK-day journal");
  const rows = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const of = (t) => rows.filter((x) => x.type === t);
  assert.equal(of("elon_post").length, 1);
  assert.ok(of("elon_kw").some((k) => k.norm === "censuscoin"));
  const ms = of("elon_match");
  assert.ok(ms.some((m) => m.mint === CM.MIG_MINT && m.eventId.endsWith(":censuscoin")), "the create named after the post");
  assert.ok(ms.some((m) => m.mint === CM.MODE_MINT && m.eventId.endsWith(":coin")), "a whole-word match");
  assert.ok(ms.every((m) => Number.isFinite(m.streamLagSec)));
  const paths = of("elon_path");
  assert.equal(paths.find((p) => p.mint === CM.MIG_MINT)?.final, "complete");
  assert.equal(paths.find((p) => p.mint === CM.MODE_MINT)?.final, "shutdown");
  assert.ok(of("elon_paper").some((p) => p.variant === "first"));
  assert.ok(of("elon_cost").some((c) => c.final) && of("elon_mem").some((m) => m.final && Number.isFinite(m.rssMB)));
  assert.equal(rpcConnections, 0, "no HTTP RPC call");
  const lockGone = !fs.existsSync(path.join(dir, ".elon.lock"));
  assert.ok(lockGone, "the instance lock is released");
  const bad = await run(path.join(root, "bots", "elon-watch", "elon.mjs"), [], { ...env, X_POLL_MS: "500", __import: undefined });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /X_POLL_MS/);
  const noTok = await run(path.join(root, "bots", "elon-watch", "elon.mjs"), [], { RPC_URL: env.RPC_URL, ELON_DIR: dir });
  assert.equal(noTok.code, 1);
  assert.match(noTok.out, /X_BEARER_TOKEN is not set/);
  const live = await run(path.join(root, "bots", "elon-watch", "elon.mjs"), ["--live"], { RPC_URL: env.RPC_URL, ELON_DIR: dir });
  assert.equal(live.code, 1);
  assert.match(live.out, /--live is not accepted/);
  rpc.close();
  ok("elon-watch process (fixture socket + replayed post): post / kw / matches with stream lag / complete and partial paths / paper / cost / mem rows in one MSK-day file; SDK not loaded; no RPC call; lock released; bad env, no token, --live -> exit 1");
}

console.log(`x-source: ${passed} checks passed`);
