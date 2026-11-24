#!/usr/bin/env node
// elon-watch Part A1 (KODING #25): fetch the posts of @elonmusk for the offline backtest. READ ONLY.
//
//   node scripts/elon-fetch.mjs                                  # 2026-11-18 00:00 UTC -> now
//   node scripts/elon-fetch.mjs --from 2026-11-19 --to 2026-11-23T12:00:00Z
//
// GET /2/users/by/username/elonmusk once (cached in data/elon/user.json), then
// GET /2/users/:id/tweets per UTC day window, OLDEST day first (so a budget stop keeps whole early days),
// max_results 100 with pagination, replies / quotes / reposts included (no exclude=), with the
// referenced posts (expansion) and media (alt_text). Every post goes to data/elon/posts.jsonl
// (deduplicated by id); a finished day is remembered in data/elon/fetch-state.json and never read
// again, so a post is not paid for twice.
// Cost guard (lib/x-source.mjs createSpendLedger): X_PRICE_PER_POST (0.005 USD), X_DAILY_BUDGET_USD
// (1.00, per UTC day, shared with the elon-watch bot through data/elon/spend.json). The fetch stops
// when the budget is reached and prints posts read and the USD estimate.
// Env: ELON_DIR (data/elon), X_USERNAME (elonmusk), X_API_BASE (tests only).
if (process.argv.includes("--live")) {
  console.error("[elon-fetch] read-only research script; --live is not accepted.");
  process.exit(1);
}
const path = await import("node:path");
const fs = await import("node:fs");
const { ROOT, X_BEARER_TOKEN } = await import("../lib/config.mjs");
const X = await import("../lib/x-source.mjs");

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const num = (name, def, min) => {
  const raw = process.env[name];
  const v = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(v) || v < min) {
    console.error(`[elon-fetch] ${name} must be a number >= ${min} (got "${raw}")`);
    process.exit(1);
  }
  return v;
};
const DIR = process.env.ELON_DIR ? path.resolve(process.env.ELON_DIR) : path.join(ROOT, "data", "elon");
const USERNAME = process.env.X_USERNAME || "elonmusk";
const price = num("X_PRICE_PER_POST", X.DEFAULT_PRICE_PER_POST, 0);
const budget = num("X_DAILY_BUDGET_USD", X.DEFAULT_DAILY_BUDGET_USD, 0);
const fromMs = Date.parse(arg("--from", "2026-11-18T00:00:00Z"));
const toMs = Math.min(Date.parse(arg("--to", new Date().toISOString())), Date.now() - 15_000);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  console.error("[elon-fetch] bad --from / --to");
  process.exit(1);
}
if (!X_BEARER_TOKEN) {
  console.error("[elon-fetch] X_BEARER_TOKEN is not set: add it to .env (pay-per-use bearer token). Nothing fetched.");
  process.exit(1);
}

const log = (m) => console.log(`[elon-fetch] ${m}`);
const ledger = X.createSpendLedger({ file: path.join(DIR, "spend.json"), pricePerPost: price, dailyBudgetUsd: budget });
const client = X.createXClient({ bearer: X_BEARER_TOKEN, baseUrl: process.env.X_API_BASE || X.X_API_BASE });
const postsFile = path.join(DIR, "posts.jsonl");
const stateFile = path.join(DIR, "fetch-state.json");
const cache = X.loadPostsCache(postsFile);
let state = { doneDays: {} };
try {
  if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
} catch {
  /* start over */
}
const saveState = () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
};
const usd0 = ledger.usd();
log(`window ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()} | cache ${cache.size} posts | price $${price}/post | budget $${budget}/UTC day, spent today $${usd0} (est.)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!e.retryable || attempt >= 6) throw e;
      const wait = X.backoffMs({ status: e.status, attempt, resetEpochSec: e.resetEpochSec ?? null });
      log(`${e.message}: retry in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}

let userId;
try {
  userId = await withRetry(() => X.resolveUserId(client, USERNAME, { cacheFile: path.join(DIR, "user.json"), ledger }));
} catch (e) {
  console.error(`[elon-fetch] user lookup failed: ${e.message}`);
  process.exit(1);
}
log(`@${USERNAME} = user ${userId}`);

let read = 0;
let added = 0;
let budgetStop = false;
const DAY = 86_400_000;
for (let d = Math.floor(fromMs / DAY) * DAY; d < toMs && !budgetStop; d += DAY) {
  const key = new Date(d).toISOString().slice(0, 10);
  const start = Math.max(d, fromMs);
  const end = Math.min(d + DAY, toMs);
  const whole = end === d + DAY && start === d;
  if (whole && state.doneDays[key]) {
    log(`${key}: done before (${state.doneDays[key].posts} posts), skipped`);
    continue;
  }
  let token = null;
  let dayPosts = 0;
  let pages = 0;
  for (;;) {
    const left = ledger.postsLeft();
    if (left <= 0) {
      budgetStop = true;
      break;
    }
    const params = { start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(), max_results: Math.max(5, Math.min(100, left)), ...(token ? { pagination_token: token } : {}) };
    let page;
    try {
      page = await withRetry(() => X.timelinePage(client, userId, params, { ledger, provider: "fetch" }));
    } catch (e) {
      console.error(`[elon-fetch] ${key}: ${e.message} — stopping (the day stays not done)`);
      budgetStop = true;
      token = "error";
      break;
    }
    pages += 1;
    read += page.posts.length;
    dayPosts += page.posts.length;
    added += X.appendPosts(postsFile, cache, page.posts);
    token = page.meta.next_token || null;
    if (!token) break;
  }
  if (!budgetStop && whole) {
    state.doneDays[key] = { posts: dayPosts, at: new Date().toISOString() };
    saveState();
  }
  log(`${key}: ${dayPosts} posts in ${pages} page(s)${budgetStop ? " (stopped: budget / error — not marked done)" : whole ? "" : " (partial day, fetched again next time)"}`);
}
const st = ledger.state();
log(`posts read ${read} (new in cache ${added}, cache now ${cache.size}) | billed resources today ${st.postsBilled} posts + ${st.userReads} user read(s), ${st.requests} request(s) | spent this run $${Math.round((ledger.usd() - usd0) * 1e4) / 1e4}, today $${st.usd} of $${budget} (estimate; the developer console is the truth)`);
if (budgetStop) log("STOPPED before the end of the window: raise X_DAILY_BUDGET_USD (or wait for the next UTC day) and run again; finished days are not read again.");
// No process.exit() right after fetch(): on Windows it can abort while an HTTP socket is closing (libuv
// assertion, exit 0xC0000409). Let the loop drain; force the exit after 300 ms if something holds it.
process.exitCode = 0;
setTimeout(() => process.exit(0), 300).unref();
