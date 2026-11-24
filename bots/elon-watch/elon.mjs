#!/usr/bin/env node
// elon-watch (KODING #25): @elonmusk posts -> keywords -> matching pump.fun tokens. RECORDER + PAPER ONLY.
//
//   npm run elon                               # until Ctrl+C
//   $env:ELON_MAX_SEC='3600'; npm run elon      # one hour
//
// No order, no signature, no key file: it reads the X API (X_BEARER_TOKEN) and the pump program's logs
// stream (RPC_URL / RPC_URLS failover, as the mint census), and writes data/elon/YYYY-MM-DD.jsonl (MSK
// day). --live is refused. The core is lib/elon-watch.mjs (keyword events, matching, paths, paper
// variants); this file wires the sources, the metadata fetches, the optional vision path and the journal.
//
// Env:
//   X_PROVIDER          api (default) | stream (filtered stream, falls back to api) | replay (X_REPLAY_FILE)
//   X_POLL_MS           2000 (min 1000; raised automatically from the x-rate-limit-limit header)
//   X_PRICE_PER_POST    0.005    X_DAILY_BUDGET_USD 1.00 (per UTC day, shared with scripts/elon-fetch.mjs)
//   X_USERNAME          elonmusk
//   ELON_FOLLOW_SEC     1800 (follow a matched mint / match new creates for this long after the post)
//   ELON_INDEX_MAX      300000 (creates kept in the 24 h index)
//   ELON_META           1 (fetch the metadata uri of matched mints: https / ipfs only, 3 s, 3 parallel)
//   ELON_VISION         0 (1 = read attached images with Claude, lib/elon-vision.mjs; ANTHROPIC_API_KEY)
//   ELON_VISION_TIMEOUT_MS 4000
//   ELON_MAX_SEC        0 (= until stopped)
//   ELON_DIR            data/elon
//   SHADOW_BUY_SOL      0.02 (the paper bet; no new bet size)
// Rows: elon_post, elon_kw, elon_match, elon_path, elon_paper, elon_cost, elon_gap, elon_mem, elon_state.
if (process.argv.includes("--live")) {
  console.error("[elon] elon-watch is research / paper only; --live is not accepted.");
  process.exit(1);
}
const path = await import("node:path");
const { ROOT, X_BEARER_TOKEN, ANTHROPIC_API_KEY } = await import("../../lib/config.mjs");
const { PUMP_PROGRAM } = await import("../../lib/constants.mjs");
const { parseTrade, parseCreate } = await import("../../lib/events.mjs");
const { SolanaWs } = await import("../../lib/ws.mjs");
const { setupFailover } = await import("../../lib/rpc-failover.mjs");
const { stallGapMs } = await import("../../lib/stall-guard.mjs");
const { acquireLock, releaseLock } = await import("../../lib/mint-census.mjs");
const { metadataUrl, metadataUrls } = await import("../../lib/elon-match.mjs");
const { createElonWriter } = await import("../../lib/elon-journal.mjs");
const W0 = await import("../../lib/elon-watch.mjs");
const X = await import("../../lib/x-source.mjs");

const fail = (m) => {
  console.error(`[elon] ${m}`);
  process.exit(1);
};
const env = process.env;
const num = (name, def, { min = -Infinity, max = Infinity, int = false } = {}) => {
  const raw = env[name];
  const v = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) fail(`${name} must be ${int ? "an integer" : "a number"} in ${min}..${max} (got "${raw}")`);
  return v;
};
const flag = (name, def) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  if (raw === "0" || raw === "1") return raw === "1";
  return fail(`${name} must be 0 or 1 (got "${raw}")`);
};
const PROVIDER = env.X_PROVIDER || "api";
if (!["api", "stream", "replay"].includes(PROVIDER)) fail(`X_PROVIDER must be api / stream / replay (got "${PROVIDER}")`);
const cfg = {
  pollMs: num("X_POLL_MS", X.DEFAULT_POLL_MS, { min: X.MIN_POLL_MS, max: 600_000 }),
  price: num("X_PRICE_PER_POST", X.DEFAULT_PRICE_PER_POST, { min: 0 }),
  budget: num("X_DAILY_BUDGET_USD", X.DEFAULT_DAILY_BUDGET_USD, { min: 0 }),
  username: env.X_USERNAME || "elonmusk",
  followSec: num("ELON_FOLLOW_SEC", 1800, { min: 60, max: 6 * 3600, int: true }),
  indexMax: num("ELON_INDEX_MAX", 300_000, { min: 1000, int: true }),
  meta: flag("ELON_META", true),
  vision: flag("ELON_VISION", false),
  visionTimeoutMs: num("ELON_VISION_TIMEOUT_MS", 4000, { min: 500, max: 60_000 }),
  maxSec: num("ELON_MAX_SEC", 0, { min: 0 }),
  buySol: num("SHADOW_BUY_SOL", 0.02, { min: 0.0001, max: 10 }),
};
const DIR = env.ELON_DIR ? path.resolve(env.ELON_DIR) : path.join(ROOT, "data", "elon");
const LOCK = path.join(DIR, ".elon.lock");
if (PROVIDER !== "replay" && !X_BEARER_TOKEN) fail("X_BEARER_TOKEN is not set: add it to .env (or X_PROVIDER=replay with X_REPLAY_FILE for a dry run).");
if (PROVIDER === "replay" && !env.X_REPLAY_FILE) fail("X_PROVIDER=replay needs X_REPLAY_FILE (a posts.jsonl)");
if (cfg.vision && !ANTHROPIC_API_KEY) fail("ELON_VISION=1 needs ANTHROPIC_API_KEY in .env");

let RPC;
try {
  RPC = setupFailover({ env, live: false, log: (level, m) => (level === "info" ? console.log : console.error)(`[elon] ${m}`) });
} catch (e) {
  fail(e.message);
}
const lock = acquireLock(LOCK);
if (!lock.ok) fail(`another elon-watch is already running (PID ${lock.pid}, lock ${LOCK}).`);

const log0 = (m) => console.log(`[elon] ${m}`);
const startedAt = Date.now();
const writer = createElonWriter(DIR, { onError: (e) => process.stderr.write(`[elon] writing disabled: ${e.message}\n`) });
const write = (rows) => {
  for (const r of rows) writer.write(r);
};
const W = W0.createWatch({ followSec: cfg.followSec, indexMax: cfg.indexMax, meta: cfg.meta, buySol: cfg.buySol });
let handlerErrors = 0;
const guard = (fn) => {
  try {
    write(fn());
  } catch (e) {
    handlerErrors += 1;
    if (handlerErrors <= 3) log0(`handler error: ${e?.stack || e}`);
  }
};

// ---- vision (lazy: the SDK is never loaded with ELON_VISION=0) ---------------------------------------------
let vision = null;
if (cfg.vision) {
  const V = await import("../../lib/elon-vision.mjs");
  vision = { V, vc: await V.createVisionClient({ apiKey: ANTHROPIC_API_KEY, timeoutMs: cfg.visionTimeoutMs }) };
}
const postsById = new Map();
function drainVision() {
  if (!W.visionQueue.length) return;
  const byPost = new Map();
  for (const q of W.visionQueue.splice(0)) {
    if (!vision) continue;
    const l = byPost.get(q.postId) || [];
    if (l.length < 4) l.push(q.url);
    byPost.set(q.postId, l);
  }
  for (const [postId, urls] of byPost) {
    const post = postsById.get(postId);
    Promise.all(urls.map((u) => vision.V.readImage(vision.vc, u).then((r) => ({ ...r, url: u })))).then((results) => guard(() => W0.onVision(W, post, results, { nowMs: Date.now() })));
  }
}

// ---- metadata of matched mints ("linked") ---------------------------------------------------------------------
let metaActive = 0;
// One URL: 3 s, at most 2 redirects (each target re-checked by metadataUrl), 64 KB.
async function fetchMetaUrl(start) {
  let url = start;
  for (let hop = 0; url && hop < 3; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    if (res.status >= 300 && res.status < 400) {
      url = metadataUrl(new URL(res.headers.get("location") || "", url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).slice(0, 65_536);
    return JSON.parse(text);
  }
  throw new Error(url ? "redirects" : "uri not allowed");
}
// The uri, then the other IPFS gateways for the same CID (429 / 5xx / timeout on one gateway).
async function fetchMeta(uri) {
  const urls = metadataUrls(uri);
  if (!urls.length) throw new Error("uri not allowed");
  let last;
  for (const u of urls) {
    try {
      return await fetchMetaUrl(u);
    } catch (e) {
      last = e;
      if (e instanceof SyntaxError) throw e;
    }
  }
  throw last;
}
function drainMeta() {
  while (metaActive < 3 && W.metaQueue.length) {
    const mint = W.metaQueue.shift();
    const w = W.watches.get(mint);
    if (!w || !w.uri) continue;
    metaActive += 1;
    fetchMeta(w.uri)
      .then((meta) => guard(() => W0.onMeta(W, mint, { meta }, { nowMs: Date.now() })))
      .catch((e) => guard(() => W0.onMeta(W, mint, { error: String(e?.name === "TimeoutError" ? "timeout" : e?.message || e).slice(0, 60) }, { nowMs: Date.now() })))
      .finally(() => {
        metaActive -= 1;
      });
  }
}

// ---- X source ----------------------------------------------------------------------------------------------------
const ledger = X.createSpendLedger({ file: path.join(DIR, "spend.json"), pricePerPost: cfg.price, dailyBudgetUsd: cfg.budget });
let xDownSince = null;
let xState = "starting";
const onPost = (p) => {
  postsById.set(p.id, p);
  if (postsById.size > 5000) postsById.delete(postsById.keys().next().value);
  guard(() => W0.onPost(W, p, { nowMs: Date.now() }));
  drainMeta();
  drainVision();
  const kws = W.counts.kwEvents;
  log0(`POST ${p.kind} ${p.id} detectLag ${p.detectLagMs} ms | "${String(p.text).replace(/\s+/g, " ").slice(0, 80)}" | keyword events total ${kws}`);
};
const onState = (s) => {
  const now = Date.now();
  if (s.state === "down") {
    xDownSince ??= now - (s.downMs ?? 0);
    log0(`X source down (${s.provider}): ${s.message}; retry in ${Math.round((s.waitMs ?? 0) / 1000)} s`);
  } else if (s.state === "up" && xDownSince !== null) {
    const sec = Math.round((now - xDownSince) / 100) / 10;
    if (sec > 30) writer.write({ type: "elon_gap", source: "x", provider: s.provider, startedAt: new Date(xDownSince).toISOString(), endedAt: new Date(now).toISOString(), sec });
    xDownSince = null;
  }
  if (s.state !== "up" || xState !== "up") writer.write({ type: "elon_state", ...s, ...(s.message ? { message: String(s.message).slice(0, 160) } : {}) });
  xState = s.state;
  if (s.state === "budget") log0(`X budget reached ($${s.usd} of $${s.budgetUsd} today): no more posts until the next UTC day; the token side keeps recording`);
  if (s.state === "error") log0(`X source stopped: ${s.message}`);
  if (s.state === "fallback") log0(`filtered stream unavailable (${s.message}): falling back to polling`);
};
let source;
if (PROVIDER === "replay") {
  source = X.createReplaySource({ file: env.X_REPLAY_FILE, onPost, onState });
} else {
  const client = X.createXClient({ bearer: X_BEARER_TOKEN, baseUrl: env.X_API_BASE || X.X_API_BASE });
  let userId;
  try {
    userId = await X.resolveUserId(client, cfg.username, { cacheFile: path.join(DIR, "user.json"), ledger });
  } catch (e) {
    releaseLock(LOCK);
    fail(`user lookup failed: ${e.message}`);
  }
  const api = () => X.createApiSource({ client, userId, ledger, pollMs: cfg.pollMs, onPost, onState });
  source = PROVIDER === "stream" ? X.createStreamSource({ client, username: cfg.username, ledger, bearer: X_BEARER_TOKEN, onPost, onState, fallback: api }) : api();
}

// ---- pump stream ---------------------------------------------------------------------------------------------------
let wsOpens = 0;
for (const l of RPC.lines) log0(l);
if (RPC.failover) RPC.failover.onSwitch((row) => writer.write({ ...row, type: "elon_rpc_switch" }));
const ws = new SolanaWs();
if (RPC.failover) ws.useFailover(RPC.failover);
ws.onOpen = () => {
  wsOpens += 1;
};
await ws.connect();
ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const logs = result?.value?.logs;
  if (!Array.isArray(logs) || !(logs[logs.length - 1] || "").includes("success")) return;
  const nowMs = Date.now();
  for (const line of logs) {
    if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    if (data.length < 8) continue;
    const t = parseTrade(data);
    if (t) {
      guard(() => W0.onTrade(W, t, data, { nowMs }));
      continue;
    }
    const c = parseCreate(data);
    if (c) guard(() => W0.onCreate(W, c, { nowMs }));
  }
  drainMeta();
});

log0(
  `paper only | X: ${PROVIDER}${PROVIDER === "api" ? ` every ${cfg.pollMs} ms` : ""}, @${cfg.username}, $${cfg.price}/post, budget $${cfg.budget}/UTC day (spent today $${ledger.usd()} est.) | follow ${cfg.followSec}s | meta ${cfg.meta ? "on" : "off"} | vision ${cfg.vision ? "on" : "off"} | bet ${cfg.buySol} SOL | output ${writer.file()} (MSK day)${cfg.maxSec ? ` | stops after ${cfg.maxSec}s` : ""}`,
);
log0("do not select text in this window: a paused console freezes the recorder");
source.start();

// ---- timer --------------------------------------------------------------------------------------------------------------
let lastTick = startedAt;
let statusAt = startedAt;
let memAt = startedAt;
let costKey = "";
const memRow = (now) => {
  const mu = process.memoryUsage();
  const s = W0.stats(W);
  return { type: "elon_mem", upSec: Math.round((now - startedAt) / 1000), rssMB: Math.round(mu.rss / 1048576), heapMB: Math.round(mu.heapUsed / 1048576), ...s, handlerErrors, wsReconnects: Math.max(0, wsOpens - 1), rowsWritten: writer.written, bytesWritten: writer.bytes, x: source.stats };
};
const costRow = () => ({ type: "elon_cost", provider: source.provider, ...ledger.state(), pricePerPost: cfg.price, xStats: source.stats });
const timer = setInterval(() => {
  const now = Date.now();
  const gap = stallGapMs(now, lastTick, 30_000);
  lastTick = now;
  if (gap) {
    writer.write({ type: "elon_gap", source: "process", sec: Math.round(gap / 100) / 10, endedAt: new Date(now).toISOString() });
    log0(`STALL: the process did not run for ${Math.round(gap / 1000)} s`);
  }
  if (xDownSince !== null && now - xDownSince > 30_000 && xState !== "gap-noted") {
    log0(`X source down for ${Math.round((now - xDownSince) / 1000)} s`);
    xState = "gap-noted";
  }
  guard(() => W0.tick(W, { nowMs: now }));
  drainMeta();
  if (now - statusAt >= 60_000) {
    statusAt = now;
    const s = W0.stats(W);
    const k = JSON.stringify(ledger.state());
    if (k !== costKey) {
      costKey = k;
      writer.write(costRow());
    }
    log0(
      `posts ${s.posts} | kw events ${s.kwEvents} (repeat ${s.repeats}) | matches ${s.matches}, watching ${s.watches} | paper rows ${s.paperRows}, open ${s.positions} | detectLag last ${s.detectLagMs.last ?? "-"} ms p50 ${s.detectLagMs.p50 ?? "-"} | stream lag p50 ${s.streamLag.p50 ?? "-"} s p90 ${s.streamLag.p90 ?? "-"} | X $${ledger.usd()} today (${source.stats.polls} polls, ${source.stats.errors} errors) | index ${s.indexSize} | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
    );
  }
  if (now - memAt >= 600_000) {
    memAt = now;
    writer.write(memRow(now));
  }
}, 1000);

let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await Promise.race([source.stop(), new Promise((r) => setTimeout(r, 3000))]);
  const now = Date.now();
  write(W0.finishAll(W, { nowMs: now }));
  if (xDownSince !== null) writer.write({ type: "elon_gap", source: "x", startedAt: new Date(xDownSince).toISOString(), endedAt: null, open: true, sec: Math.round((now - xDownSince) / 100) / 10 });
  writer.write({ ...costRow(), final: true });
  const m = memRow(now);
  writer.write({ ...m, final: true });
  log0(`=== ELON-WATCH STOP (${reason}) === posts ${m.posts}, kw events ${m.kwEvents}, matches ${m.matches}, paths ${m.watchesDone}, paper rows ${m.paperRows} | detectLag p50 ${m.detectLagMs.p50 ?? "-"} p90 ${m.detectLagMs.p90 ?? "-"} ms | stream lag p50 ${m.streamLag.p50 ?? "-"} p90 ${m.streamLag.p90 ?? "-"} s | X $${ledger.usd()} today | rss ${m.rssMB} MB | errors ${handlerErrors}`);
  log0(`file: ${writer.file()}`);
  await ws.close().catch(() => {});
  releaseLock(LOCK);
  // not process.exit() at once: on Windows an exit while an HTTP (fetch) socket is closing can abort
  // (libuv assertion); the loop drains, or the exit is forced after 300 ms
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 300).unref();
}
if (cfg.maxSec > 0) setTimeout(() => stop("max-sec"), cfg.maxSec * 1000);
process.on("SIGINT", () => stop("sigint"));
process.on("SIGTERM", () => stop("sigterm"));
