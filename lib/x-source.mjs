// elon-watch (KODING #25): posts of one X account through the X API v2 (pay-per-use), READ ONLY.
//
// Providers (createSource):
//   api     poll GET /2/users/:id/tweets with since_id every X_POLL_MS (default 2000, min 1000)
//   stream  filtered stream GET /2/tweets/search/stream with the rule "from:<username>"; on repeated
//           failures (or 401 / 403: the plan has no stream) it falls back to "api" (state row)
//   replay  posts from a posts.jsonl (tests, dry runs); `replayDelayMs` on a row delays it
// Every post goes through normalizePost: { id, postMs (from the snowflake id, ms), createdAt, kind,
// text, refs, media, seenAtMs, detectLagMs, provider }.
//
// Billing (docs.x.com pricing / "Usage and Billing", read 2026-11-23): $0.005 per post read, $0.010
// per user read, a post read again in the same UTC day is not billed again, requests that return no
// data are not billed. Whether expanded objects (`includes.tweets` = referenced posts, media) are
// billed is NOT stated in the docs; the ledger counts the referenced posts as billed (upper bound).
// The spend ledger (createSpendLedger): unique post ids per UTC day
// (posts in `data` + referenced posts in `includes.tweets`) x X_PRICE_PER_POST, user lookups x 2; it
// refuses requests once X_DAILY_BUDGET_USD is reached. It is an ESTIMATE: the console is the truth.
//
// The bearer token comes from lib/config.mjs (X_BEARER_TOKEN, never logged). 429 / 5xx / network
// errors back off (x-rate-limit-reset when given) and never throw out of the source.
import fs from "node:fs";
import path from "node:path";

export const X_API_BASE = "https://api.x.com";
export const DEFAULT_PRICE_PER_POST = 0.005;
export const DEFAULT_DAILY_BUDGET_USD = 1.0;
export const DEFAULT_POLL_MS = 2000;
export const MIN_POLL_MS = 1000;
export const TWEET_FIELDS = "created_at,conversation_id,referenced_tweets,entities,attachments,note_tweet,author_id";
export const EXPANSIONS = "attachments.media_keys,referenced_tweets.id";
export const MEDIA_FIELDS = "url,preview_image_url,alt_text,type";
const TWITTER_EPOCH_MS = 1288834974657n;

// ms timestamp inside a post id (snowflake): sharper than created_at (whole seconds).
export function snowflakeMs(id) {
  try {
    return Number((BigInt(id) >> 22n) + TWITTER_EPOCH_MS);
  } catch {
    return null;
  }
}

// One API post (+ the response's `includes`) -> the stored post record.
export function normalizePost(tw, includes = {}, { seenAtMs = null, provider = null } = {}) {
  const refTweets = new Map((includes.tweets || []).map((t) => [t.id, t]));
  const media = new Map((includes.media || []).map((m) => [m.media_key, m]));
  const refs = (tw.referenced_tweets || []).map((r) => {
    const t = refTweets.get(r.id);
    return { type: r.type, id: r.id, text: t ? t.note_tweet?.text ?? t.text ?? null : null, mediaKeys: t?.attachments?.media_keys ?? [] };
  });
  const types = refs.map((r) => r.type);
  const kind = types.includes("retweeted") ? "repost" : types.includes("quoted") ? "quote" : types.includes("replied_to") ? "reply" : "post";
  const keys = [...(tw.attachments?.media_keys || []), ...refs.flatMap((r) => r.mediaKeys)];
  const mediaOut = [];
  for (const k of new Set(keys)) {
    const m = media.get(k);
    if (m) mediaOut.push({ key: k, type: m.type ?? null, url: m.url ?? m.preview_image_url ?? null, alt: m.alt_text ?? null, own: (tw.attachments?.media_keys || []).includes(k) });
  }
  const postMs = snowflakeMs(tw.id) ?? (tw.created_at ? Date.parse(tw.created_at) : null);
  return {
    id: tw.id,
    postMs,
    createdAt: tw.created_at ?? null,
    kind,
    text: tw.note_tweet?.text ?? tw.text ?? "",
    conversationId: tw.conversation_id ?? null,
    refs: refs.map(({ mediaKeys, ...r }) => r),
    media: mediaOut,
    entities: {
      cashtags: (tw.entities?.cashtags || []).map((c) => c.tag),
      hashtags: (tw.entities?.hashtags || []).map((c) => c.tag),
    },
    ...(seenAtMs !== null ? { seenAtMs, detectLagMs: postMs !== null ? seenAtMs - postMs : null } : {}),
    ...(provider ? { provider } : {}),
  };
}

// ---- posts cache (data/elon/posts.jsonl): every post read is kept, never paid for twice --------------
export function loadPostsCache(file) {
  const posts = new Map();
  if (!fs.existsSync(file)) return posts;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line);
      if (p?.id && !posts.has(p.id)) posts.set(p.id, p);
    } catch {
      /* a torn last line */
    }
  }
  return posts;
}

export function appendPosts(file, cache, posts) {
  const fresh = posts.filter((p) => p?.id && !cache.has(p.id));
  if (!fresh.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, fresh.map((p) => JSON.stringify(p)).join("\n") + "\n");
  for (const p of fresh) cache.set(p.id, p);
  return fresh.length;
}

// ---- spend ledger -----------------------------------------------------------------------------------
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createSpendLedger({ file = null, pricePerPost = DEFAULT_PRICE_PER_POST, dailyBudgetUsd = DEFAULT_DAILY_BUDGET_USD, now = () => Date.now() } = {}) {
  let st = { day: utcDay(now()), ids: [], userReads: 0, requests: 0 };
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (j?.day === st.day) st = { ...st, ...j };
    } catch {
      /* start fresh */
    }
  }
  let ids = new Set(st.ids);
  const roll = () => {
    const d = utcDay(now());
    if (d !== st.day) {
      st = { day: d, ids: [], userReads: 0, requests: 0 };
      ids = new Set();
    }
  };
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...st, ids: [...ids] }));
    } catch {
      /* the estimate is best effort */
    }
  };
  const usd = () => Math.round((ids.size * pricePerPost + st.userReads * pricePerPost * 2) * 1e4) / 1e4;
  return {
    pricePerPost,
    dailyBudgetUsd,
    usd() {
      roll();
      return usd();
    },
    posts() {
      roll();
      return ids.size;
    },
    // ids of the posts (and referenced posts) a response returned; returns the USD added
    notePosts(list) {
      roll();
      const before = usd();
      for (const id of list) if (id) ids.add(String(id));
      st.requests += 1;
      save();
      return Math.round((usd() - before) * 1e4) / 1e4;
    },
    noteUserRead() {
      roll();
      st.userReads += 1;
      save();
    },
    noteEmpty() {
      roll();
      st.requests += 1;
    },
    // how many NEW posts the budget still allows (0 = stop)
    postsLeft() {
      roll();
      return Math.max(0, Math.floor((dailyBudgetUsd - usd()) / pricePerPost + 1e-9));
    },
    exhausted() {
      return this.postsLeft() <= 0;
    },
    state() {
      roll();
      return { day: st.day, postsBilled: ids.size, userReads: st.userReads, requests: st.requests, usd: usd(), budgetUsd: dailyBudgetUsd };
    },
  };
}

// ---- HTTP client with backoff ------------------------------------------------------------------------
// The wait before attempt `attempt` (1-based) after a failure. 429: until x-rate-limit-reset (epoch s)
// when given, else exponential; 5xx / network: exponential 2 s .. 120 s.
export function backoffMs({ status = null, attempt = 1, resetEpochSec = null, nowMs = Date.now(), baseMs = 2000, maxMs = 120_000 }) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  if (status === 429 && Number.isFinite(resetEpochSec) && resetEpochSec > 0) {
    const until = resetEpochSec * 1000 - nowMs + 500;
    return Math.min(15 * 60_000, Math.max(baseMs, until));
  }
  return exp;
}

export class XApiError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

// GET with query params; never logs the token. Throws XApiError (status, retryable).
export function createXClient({ bearer, baseUrl = X_API_BASE, fetchImpl = (...a) => fetch(...a), timeoutMs = 15_000 } = {}) {
  if (!bearer) throw new XApiError("X_BEARER_TOKEN is not set (add it to .env)", { status: null, retryable: false });
  return {
    baseUrl,
    lastRate: null, // { limit, remaining, reset (epoch s), path } of the last response that carried the headers
    async get(p, params = {}) {
      const u = new URL(p, baseUrl);
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
      let res;
      try {
        res = await fetchImpl(u, { headers: { authorization: `Bearer ${bearer}`, "user-agent": "research-client" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new XApiError(`network: ${e?.name || "error"}`, { retryable: true });
      }
      const text = await res.text().catch(() => "");
      const rl = { limit: Number(res.headers.get("x-rate-limit-limit")), remaining: Number(res.headers.get("x-rate-limit-remaining")), reset: Number(res.headers.get("x-rate-limit-reset")) };
      if (Number.isFinite(rl.limit) && rl.limit > 0) this.lastRate = { ...rl, path: u.pathname };
      if (!res.ok) {
        const reset = Number(res.headers.get("x-rate-limit-reset"));
        const err = new XApiError(`HTTP ${res.status}${text ? ` ${safeSnippet(text)}` : ""}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
        err.resetEpochSec = Number.isFinite(reset) ? reset : null;
        throw err;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new XApiError("bad JSON", { status: res.status, retryable: true });
      }
    },
  };
}

// An error body without anything that looks like a credential.
export function safeSnippet(s, max = 160) {
  return String(s)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z0-9%_-]{40,}/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

// ---- endpoints ------------------------------------------------------------------------------------------
// The user id of `username`, cached in `cacheFile` (one user read, ever).
export async function resolveUserId(client, username, { cacheFile = null, ledger = null } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (j?.username?.toLowerCase() === username.toLowerCase() && j.id) return j.id;
    } catch {
      /* refetch */
    }
  }
  const j = await client.get(`/2/users/by/username/${encodeURIComponent(username)}`);
  ledger?.noteUserRead();
  const id = j?.data?.id;
  if (!id) throw new XApiError(`user ${username} not found`, { retryable: false });
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ username, id, resolvedAt: new Date().toISOString() }));
  }
  return id;
}

export const timelineParams = (extra = {}) => ({ "tweet.fields": TWEET_FIELDS, expansions: EXPANSIONS, "media.fields": MEDIA_FIELDS, ...extra });

// One timeline page. Bills the ledger; returns { posts (normalized), meta, billedUsd }.
export async function timelinePage(client, userId, params, { ledger = null, seenAtMs = null, provider = null } = {}) {
  const j = await client.get(`/2/users/${userId}/tweets`, timelineParams(params));
  const data = j?.data || [];
  const includes = j?.includes || {};
  const billedIds = [...data.map((t) => t.id), ...(includes.tweets || []).map((t) => t.id)];
  const billedUsd = billedIds.length ? ledger?.notePosts(billedIds) ?? 0 : (ledger?.noteEmpty(), 0);
  return { posts: data.map((t) => normalizePost(t, includes, { seenAtMs, provider })), meta: j?.meta || {}, billedUsd };
}

// ---- sources ---------------------------------------------------------------------------------------------
// Common callbacks: onPost(post), onState({ state, ... }) with state "up" | "down" | "budget" |
// "fallback" | "error"; the source never throws after start().
const realSleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener?.("abort", () => {
    clearTimeout(t);
    r();
  });
});

// The poll interval the rate limit allows (PROMPT N3). docs.x.com rate limits (read 2026-11-23):
// GET /2/users/:id/tweets 10,000 / 15 min per app (900 per user); the page names no different limit
// for pay-per-use. The live x-rate-limit-limit header wins: the interval keeps 25 % of the window
// free (10,000 -> 113 ms, so the configured 2000 ms rules); with <= 2 requests left in the window
// it waits for x-rate-limit-reset.
export const RATE_WINDOW_MS = 15 * 60_000;
export function pollWaitMs({ pollMs, rate = null, nowMs = Date.now() }) {
  let wait = pollMs;
  if (rate && rate.limit > 0) {
    wait = Math.max(wait, Math.ceil((RATE_WINDOW_MS / rate.limit) * 1.25));
    if (Number.isFinite(rate.remaining) && rate.remaining <= 2 && Number.isFinite(rate.reset)) wait = Math.max(wait, rate.reset * 1000 - nowMs + 500);
  }
  return wait;
}

export function createApiSource({ client, userId, ledger, pollMs = DEFAULT_POLL_MS, onPost = () => {}, onState = () => {}, now = () => Date.now(), sleep = realSleep, sinceId = null, lookbackSec = 60 }) {
  const ctl = new AbortController();
  let since = sinceId;
  let failures = 0;
  let downSinceMs = null;
  const stats = { polls: 0, posts: 0, errors: 0, http429: 0, http5xx: 0, lastError: null };
  async function pollOnce() {
    const left = ledger.postsLeft();
    if (left <= 0) return { budget: true };
    // a page of up to 100: the budget left caps it (min 5, the API minimum)
    const max = Math.max(5, Math.min(100, left));
    const params = since ? { since_id: since, max_results: max } : { start_time: new Date(now() - lookbackSec * 1000).toISOString(), max_results: max };
    const page = await timelinePage(client, userId, params, { ledger, seenAtMs: now(), provider: "api" });
    stats.polls += 1;
    if (page.meta.newest_id) since = page.meta.newest_id;
    const posts = [...page.posts].sort((a, b) => a.postMs - b.postMs);
    for (const p of posts) {
      stats.posts += 1;
      onPost(p);
    }
    return { budget: false };
  }
  async function loop() {
    onState({ state: "up", provider: "api" });
    while (!ctl.signal.aborted) {
      const t0 = now();
      try {
        const r = await pollOnce();
        if (downSinceMs !== null) {
          onState({ state: "up", provider: "api", downMs: now() - downSinceMs });
          downSinceMs = null;
        }
        failures = 0;
        if (r.budget) {
          onState({ state: "budget", provider: "api", ...ledger.state() });
          return;
        }
        stats.rate = client.lastRate ?? null;
        await sleep(Math.max(0, pollWaitMs({ pollMs, rate: client.lastRate, nowMs: now() }) - (now() - t0)), ctl.signal);
      } catch (e) {
        failures += 1;
        stats.errors += 1;
        stats.lastError = e.message;
        if (e.status === 429) stats.http429 += 1;
        if (e.status >= 500) stats.http5xx += 1;
        if (downSinceMs === null) downSinceMs = t0;
        if (e.retryable === false && (e.status === 401 || e.status === 403 || e.status === null)) {
          onState({ state: "error", provider: "api", status: e.status, message: e.message, fatal: true });
          return;
        }
        const wait = backoffMs({ status: e.status, attempt: failures, resetEpochSec: e.resetEpochSec ?? null, nowMs: now() });
        onState({ state: "down", provider: "api", status: e.status ?? null, message: e.message, waitMs: wait, downMs: now() - downSinceMs });
        await sleep(wait, ctl.signal);
      }
    }
  }
  let done = null;
  return {
    provider: "api",
    stats,
    start() {
      done = loop();
      return done;
    },
    stop() {
      ctl.abort();
      return done;
    },
  };
}

// Replay: posts from a file (or an array) in postMs order; `replayDelayMs` (from start) delays a row.
// seenAtMs = the replay clock; detectLagMs then measures nothing real (provider "replay").
export function createReplaySource({ file = null, posts = null, onPost = () => {}, onState = () => {}, now = () => Date.now(), sleep = realSleep }) {
  const ctl = new AbortController();
  const list = posts ?? [...loadPostsCache(file).values()];
  const stats = { polls: 0, posts: 0, errors: 0 };
  let done = null;
  async function run() {
    onState({ state: "up", provider: "replay" });
    const t0 = now();
    const sorted = [...list].sort((a, b) => (a.replayDelayMs ?? 0) - (b.replayDelayMs ?? 0) || a.postMs - b.postMs);
    for (const p of sorted) {
      if (ctl.signal.aborted) return;
      const wait = (p.replayDelayMs ?? 0) - (now() - t0);
      if (wait > 0) await sleep(wait, ctl.signal);
      if (ctl.signal.aborted) return;
      const seenAtMs = now();
      // a replayed post is re-timed to "just now" when it carries replayDelayMs (dry runs of the bot)
      const postMs = p.replayDelayMs !== undefined ? seenAtMs - (p.replayLagMs ?? 0) : p.postMs;
      stats.posts += 1;
      onPost({ ...p, postMs, seenAtMs, detectLagMs: seenAtMs - postMs, provider: "replay" });
    }
    onState({ state: "done", provider: "replay" });
  }
  return {
    provider: "replay",
    stats,
    start() {
      done = run();
      return done;
    },
    stop() {
      ctl.abort();
      return done;
    },
  };
}

// Filtered stream with the rule "from:<username>". Untested against the real endpoint (no token at
// build time): on 401 / 403 / 3 failed connects in a row it hands over to `fallback()` (the api
// provider). Each delivered post is billed like a read.
export function createStreamSource({ client, username, ledger, fetchImpl = (...a) => fetch(...a), bearer, onPost = () => {}, onState = () => {}, fallback = null, now = () => Date.now(), sleep = realSleep, heartbeatMs = 30_000 }) {
  const ctl = new AbortController();
  const stats = { polls: 0, posts: 0, errors: 0, connects: 0, http429: 0, http5xx: 0, lastError: null };
  let done = null;
  let fb = null;
  async function ensureRule() {
    const want = `from:${username}`;
    const j = await client.get("/2/tweets/search/stream/rules");
    if ((j?.data || []).some((r) => r.value === want)) return;
    const u = new URL("/2/tweets/search/stream/rules", client.baseUrl);
    const res = await fetchImpl(u, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ add: [{ value: want, tag: "elon-watch" }] }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new XApiError(`rules HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
  }
  async function connectOnce() {
    const u = new URL("/2/tweets/search/stream", client.baseUrl);
    for (const [k, v] of Object.entries(timelineParams())) u.searchParams.set(k, v);
    const hb = new AbortController();
    const res = await fetchImpl(u, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.any([ctl.signal, hb.signal]) });
    if (!res.ok) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const err = new XApiError(`stream HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      err.resetEpochSec = Number.isFinite(reset) ? reset : null;
      throw err;
    }
    stats.connects += 1;
    onState({ state: "up", provider: "stream" });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let timer = setTimeout(() => hb.abort(), heartbeatMs);
    try {
      while (!ctl.signal.aborted) {
        const { value, done: end } = await reader.read();
        if (end) break;
        clearTimeout(timer);
        timer = setTimeout(() => hb.abort(), heartbeatMs); // X sends \r\n keep-alives every ~20 s
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let j;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (!j?.data) continue;
          ledger.notePosts([j.data.id, ...(j.includes?.tweets || []).map((t) => t.id)]);
          stats.posts += 1;
          onPost(normalizePost(j.data, j.includes || {}, { seenAtMs: now(), provider: "stream" }));
          if (ledger.exhausted()) {
            onState({ state: "budget", provider: "stream", ...ledger.state() });
            ctl.abort();
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    throw new XApiError("stream ended", { retryable: true });
  }
  async function run() {
    let failures = 0;
    let downSinceMs = null;
    while (!ctl.signal.aborted) {
      if (ledger.exhausted()) {
        onState({ state: "budget", provider: "stream", ...ledger.state() });
        return;
      }
      try {
        await ensureRule();
        await connectOnce();
      } catch (e) {
        if (ctl.signal.aborted) return;
        failures += 1;
        stats.errors += 1;
        stats.lastError = e.message;
        if (e.status === 429) stats.http429 += 1;
        if (e.status >= 500) stats.http5xx += 1;
        downSinceMs ??= now();
        const noPlan = e.status === 401 || e.status === 403;
        if (fallback && (noPlan || failures >= 3)) {
          onState({ state: "fallback", provider: "stream", to: "api", status: e.status ?? null, message: e.message });
          fb = fallback();
          return fb.start();
        }
        const wait = backoffMs({ status: e.status, attempt: failures, resetEpochSec: e.resetEpochSec ?? null, nowMs: now() });
        onState({ state: "down", provider: "stream", status: e.status ?? null, message: e.message, waitMs: wait, downMs: now() - downSinceMs });
        await sleep(wait, ctl.signal);
      }
    }
  }
  return {
    provider: "stream",
    stats,
    start() {
      done = run();
      return done;
    },
    async stop() {
      ctl.abort();
      if (fb) await fb.stop();
      return done;
    },
  };
}
