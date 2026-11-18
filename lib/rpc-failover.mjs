// RPC endpoint failover for the RESEARCH processes only (KODING #20): the shadow lab
// (bots/graduation-sniper/shadow.mjs) and the mint census (scripts/mint-census.mjs).
//
// One provider key runs out after ~15 h of streaming; both processes then kept running on a dead
// stream. With RPC_URLS set (comma list, order = priority) they switch to the next endpoint by
// themselves. Live bots and every other bot never install this: with --live, or without RPC_URLS,
// the process uses the single RPC_URL exactly as before (lib/config.mjs warns once when RPC_URLS is
// set where it is ignored).
//
// Secrets: endpoint URLs carry API keys in their query string. Nothing here ever prints or returns
// a URL in a message, a reason or a journal row: endpoints are named `#<n> <host>`.
//
// Exhaustion (per endpoint, websocket and HTTP alike), RPC_FAILOVER_AFTER times in a row:
//   - HTTP status 401 / 402 / 403 / 429 (websocket handshake "Unexpected server response: 429" or an
//     HTTP JSON-RPC answer with that status; 402 Payment Required = credits used up, KODING #22: a PC
//     key answered the handshake with it and lib/ws.mjs reconnected to it forever);
//   - a JSON-RPC error with a documented provider limit code (429, -32429, -32007, -32008, -32029)
//     or whose message says limit / credits / capacity / quota / "max usage" / "too many requests"
//     (provider-neutral; the per-provider sources are listed at EXHAUST_CODES below).
// Unreachable (KODING #23, a separate state): the websocket has had no healthy (re)connect
// (subscription confirmed) for 60 s. This is NOT a credit signal (a phone that loses its network or
// is put to sleep by Android drops every key in turn), so the endpoint is eligible again after
// RPC_FAILOVER_UNREACH_MIN (default 2), not after the 60 min exhaustion cooldown.
// Stream silence alone is never a reason (pump can be quiet).
//
// On a switch: the next endpoint in order that is eligible (an exhausted one again after
// RPC_FAILOVER_COOLDOWN_MIN: a key may refill; an unreachable one after RPC_FAILOVER_UNREACH_MIN).
// None eligible -> "all down": the least-recently-failed endpoint is retried every 60 s and a loud
// line is logged once per 10 min. That line says "ALL ... exhausted ... add a key" only when at least
// one endpoint is really exhausted (cooling after a limit signal); when every endpoint's last state
// is "unreachable" it says the device's network is likely down instead (also logged while the
// endpoints are still cycling, i.e. with enough keys that one is always eligible again).
// The process never exits on its own because of this.
//
// Thin (KODING #23, census only): the socket is up but the stream is a fraction of the real one; the
// census reports it (createThinStreamDetector below, CENSUS_THIN_GAPS gaps in 10 min) via thin(). It
// switches like "unreachable" (state "thin", RPC_FAILOVER_UNREACH_MIN).
//
// Diagnostics (secret-free): per endpoint the last websocket close {code, reason}, the last websocket
// error text and the connect attempts in the current no-connect window; every rpc_switch row carries
// them for the endpoint left, with `state` ("exhausted" | "unreachable").
//
// This module is pure (no network, no timers): the caller passes a clock, and the websocket
// (lib/ws.mjs, opt-in `useFailover`) and the HTTP client (lib/rpc.mjs, opt-in fetch) report to it.

export const FAILOVER_DEFAULTS = Object.freeze({
  after: 3,
  cooldownMin: 60,
  unreachMin: 2,
  noConnectMs: 60_000,
  retryMs: 60_000,
  loudMs: 600_000,
});

const SCHEME = /^https?:\/\//i;

// Host name of an endpoint, never anything else of the URL (path / query may carry a key).
export function hostOf(url) {
  try {
    return new URL(url).hostname || "?";
  } catch {
    return "?";
  }
}

export function wsUrlOf(httpUrl) {
  // The same derivation as lib/config.mjs WS_URL.
  return httpUrl.replace("https://", "wss://").replace("http://", "ws://");
}

export const endpointLabel = (ep) => `#${ep.idx} ${ep.host}`;

function endpoint(url, idx) {
  return { idx, url, wsUrl: wsUrlOf(url), host: hostOf(url) };
}

const WS_SCHEME = /^wss?:\/\//i;

function urlHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
}

// RPC_URLS -> endpoints. Throws an Error with a secret-free message on a bad list.
// An item is `http_url` (websocket derived: https -> wss, http -> ws) or `http_url|ws_url` (providers
// whose websocket lives on another path or host, e.g. Ankr, Chainstack). Duplicates are judged by the
// http part; the printed host is always the http part's.
export function parseRpcUrlList(raw) {
  const items = String(raw).split(",").map((s) => s.trim());
  const seen = new Map();
  const out = [];
  items.forEach((item, i) => {
    const n = i + 1;
    if (!item) throw new Error(`RPC_URLS item #${n} is empty (check for a stray comma)`);
    const parts = item.split("|").map((s) => s.trim());
    if (parts.length > 2) throw new Error(`RPC_URLS item #${n} has more than one "|" (expected http_url or http_url|ws_url)`);
    const [u, w] = parts;
    if (!u) throw new Error(`RPC_URLS item #${n}: the http part is empty`);
    if (!SCHEME.test(u)) throw new Error(`RPC_URLS item #${n} must start with http:// or https://`);
    const host = urlHost(u);
    if (host === null) throw new Error(`RPC_URLS item #${n} is not a valid URL`);
    if (!host) throw new Error(`RPC_URLS item #${n} has no host`);
    if (parts.length === 2) {
      if (!w) throw new Error(`RPC_URLS item #${n}: the websocket part after "|" is empty`);
      if (!WS_SCHEME.test(w)) throw new Error(`RPC_URLS item #${n}: the websocket part must start with ws:// or wss://`);
      const wh = urlHost(w);
      if (wh === null) throw new Error(`RPC_URLS item #${n}: the websocket part is not a valid URL`);
      if (!wh) throw new Error(`RPC_URLS item #${n}: the websocket part has no host`);
    }
    const k = u.replace(/\/+$/, "");
    if (seen.has(k)) throw new Error(`RPC_URLS item #${n} duplicates item #${seen.get(k)}`);
    seen.set(k, n);
    const ep = endpoint(u, n);
    if (parts.length === 2) {
      ep.wsUrl = w;
      ep.wsExplicit = true;
    }
    out.push(ep);
  });
  return out;
}

function intEnv(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in ${min}..${max} (got "${raw}")`);
  return v;
}

// Shared startup of the two research processes. Returns
//   { failover: RpcFailover | null, endpoints, lines: [startup log lines] }
// `failover` is null (single RPC_URL, behaviour identical to before) when RPC_URLS is unset or the
// process is live. Throws on a bad RPC_URLS / RPC_FAILOVER_* value (the caller exits 1).
export function setupFailover({ env = process.env, live = false, now = () => Date.now(), log = () => {} } = {}) {
  const after = intEnv(env, "RPC_FAILOVER_AFTER", FAILOVER_DEFAULTS.after, 1, 100);
  const cooldownMin = intEnv(env, "RPC_FAILOVER_COOLDOWN_MIN", FAILOVER_DEFAULTS.cooldownMin, 0, 10_080);
  const unreachMin = intEnv(env, "RPC_FAILOVER_UNREACH_MIN", FAILOVER_DEFAULTS.unreachMin, 0, 60);
  const lines = [];
  const rawList = env.RPC_URLS;
  if (live || rawList === undefined || rawList === "") {
    if (live && rawList) lines.push("RPC_URLS is ignored with --live: single RPC_URL, no failover");
    const single = env.RPC_URL ? [endpoint(env.RPC_URL, 1)] : [];
    lines.push(`rpc: ${single.map(endpointLabel).join(", ") || "none"} (RPC_URL, failover off)`);
    return { failover: null, endpoints: single, lines };
  }
  const endpoints = parseRpcUrlList(rawList);
  if (env.RPC_URL) lines.push("RPC_URLS is set: RPC_URL is ignored by this process");
  lines.push(`rpc endpoints: ${endpoints.map(endpointLabel).join(", ")} | failover after ${after} failures in a row or 60 s without a connect | cooldown ${cooldownMin} min (exhausted), ${unreachMin} min (unreachable)`);
  const failover = new RpcFailover({ endpoints, after, cooldownMs: cooldownMin * 60_000, unreachMs: unreachMin * 60_000, now, log });
  return { failover, endpoints, lines };
}

// ---- classification -------------------------------------------------------------------------------
// Provider-neutral: HTTP 401 / 402 / 403 / 429 plus generic limit wording, and the provider codes /
// messages that are documented (read 2026-11-16):
//   any      402 Payment Required: the plan / credits are used up (seen 2026-11-18 on a websocket
//            handshake, "Unexpected server response: 402"; the same status on an HTTP RPC call counts
//            the same way).
//   Helius   429 + {"code":-32005,"message":"Too many requests"} (rate limit); -32429 "max usage
//            reached" (credits; from the task / community reports, not in the docs).
//   Alchemy  429 + "Your app has exceeded its compute units per second capacity" (over WebSocket a
//            JSON-RPC error with code 429, no HTTP status); 403 + -32600 "Monthly capacity limit
//            exceeded" (monthly), 401 "Invalid access key".
//   QuickNode 429; -32007 per-second, -32008 per-minute, -32029 rate limit exceeded (message text not
//            documented). -32011 is NOT matched by code: Solana uses it for "Transaction history not
//            available" (QuickNode's "Method rate limit reached" still matches by its words).
// -32005 is NOT matched by code either: standard Solana uses it for "Node is unhealthy / behind";
// Helius's -32005 "Too many requests" matches by its message.
const EXHAUST_STATUS = new Set([401, 402, 403, 429]);
const EXHAUST_CODES = new Set([429, -32429, -32007, -32008, -32029]);
const EXHAUST_MSG = /max usage|credits?\b|\blimit|too many requests|capacity|quota/i;

// A JSON-RPC error object -> reason string, or null when it is not an exhaustion signal.
export function rpcErrorReason(err) {
  if (!err || typeof err !== "object") return null;
  const code = Number(err.code);
  const msg = typeof err.message === "string" ? err.message : "";
  if (EXHAUST_CODES.has(code) || EXHAUST_MSG.test(msg)) return `rpc-error ${Number.isFinite(code) ? code : "?"} ${safeText(msg)}`.trim();
  return null;
}

// A websocket 'error' -> reason, or null. `ws` reports a rejected handshake as
// "Unexpected server response: <status>".
export function wsErrorReason(err) {
  const m = /Unexpected server response: (\d{3})/.exec(String(err?.message ?? ""));
  if (m && EXHAUST_STATUS.has(Number(m[1]))) return `ws-handshake-${m[1]}`;
  return null;
}

// An HTTP response status + body text -> reason, or null.
export function httpReason(status, bodyText) {
  if (EXHAUST_STATUS.has(status)) {
    const body = parseJson(bodyText);
    const inner = firstRpcError(body);
    return `http-${status}${inner ? ` ${rpcErrorReason(inner) ?? `rpc-error ${inner.code ?? "?"}`}` : ""}`;
  }
  if (!bodyText || !bodyText.includes('"error"')) return null;
  const inner = firstRpcError(parseJson(bodyText), true);
  return inner ? rpcErrorReason(inner) : null;
}

function parseJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function firstRpcError(body, exhaustOnly = false) {
  const list = Array.isArray(body) ? body : body ? [body] : [];
  for (const r of list) {
    if (r && r.error && (!exhaustOnly || rpcErrorReason(r.error))) return r.error;
  }
  return null;
}

// Short, single-line, without anything that looks like a URL or a key=value query.
export function safeText(s, max = 60) {
  return String(s ?? "")
    .replace(/[a-z]+:\/\/\S+/gi, "<url>")
    .replace(/[?&][\w-]+=[^\s&]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---- plan-limit error counter (census_mem rpcLimitErrors, KODING #23) ---------------------------------
// Counting only, never a failover signal by itself: a JSON-RPC error answer (to the main subscription,
// a pool / vault subscription, an unsubscribe) that names a plan limit. Wider than rpcErrorReason: it
// also takes "subscription limit" / "too many subscriptions" / RPS wording (Chainstack 2026-11-18:
// "Concurrent websocket subscription limit reached: 1", -32005 "You've exceeded the RPS limit ...").
const LIMIT_COUNT_MSG = /\blimit|too many|\brps\b|rate|credits?\b|quota|capacity|max usage/i;
export function isLimitError(err) {
  if (!err || typeof err !== "object") return false;
  const msg = typeof err.message === "string" ? err.message : "";
  return rpcErrorReason(err) !== null || LIMIT_COUNT_MSG.test(msg);
}
// The census_mem key of such an error: its code only (secret-free), "?" without a numeric code.
export function limitErrorKey(err) {
  const c = Number(err?.code);
  return err && err.code !== undefined && err.code !== null && Number.isFinite(c) ? String(c) : "?";
}

// ---- thin stream (census, KODING #23) -----------------------------------------------------------------
// A key that keeps the socket "healthy" while delivering a few % of the stream (Chainstack on the phone
// 2026-11-18, rpcfast in #21e) is the silent failure: the census sees it only as stream gaps. The census
// reports every census_gap it closes; CENSUS_THIN_GAPS (default 3; 0 = off) of them within 10 min on
// the same endpoint -> RpcFailover.thin(). A gap counts only when it started after the last endpoint
// switch (the silence of a switch itself is not the new endpoint's fault) and when no census_stall was
// noted in the 10 min window up to its end (a stall = the process itself did not run: the phone slept,
// so its gaps are not the endpoint's); a stall also drops the gaps counted so far.
export const THIN_DEFAULTS = Object.freeze({ gaps: 3, windowMs: 600_000 });

export function thinGapsFromEnv(env = process.env) {
  return intEnv(env, "CENSUS_THIN_GAPS", THIN_DEFAULTS.gaps, 0, 100);
}

export function createThinStreamDetector({ gaps = THIN_DEFAULTS.gaps, windowMs = THIN_DEFAULTS.windowMs } = {}) {
  let ends = []; // close times (ms) of the counted gaps on the current endpoint
  let lastStallAt = -Infinity;
  let lastSwitchAt = -Infinity;
  return {
    get counted() {
      return ends.length;
    },
    noteStall(nowMs) {
      lastStallAt = nowMs;
      ends = [];
    },
    noteSwitch(nowMs) {
      lastSwitchAt = nowMs;
      ends = [];
    },
    // A closed census_gap [startMs, endMs]. Returns { k, windowMin } when the endpoint is thin (the
    // counted gaps are then dropped: the next verdict needs `gaps` new ones), else null.
    noteGap(startMs, endMs) {
      if (!(gaps > 0) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
      if (startMs < lastSwitchAt) return null;
      if (lastStallAt >= endMs - windowMs) return null;
      ends = ends.filter((e) => e > endMs - windowMs);
      ends.push(endMs);
      if (ends.length < gaps) return null;
      const k = ends.length;
      ends = [];
      return { k, windowMin: Math.round(windowMs / 60_000) };
    },
  };
}

// ---- the controller --------------------------------------------------------------------------------
const EXHAUSTED = "exhausted";
const UNREACHABLE = "unreachable";
const THIN = "thin"; // census: the socket is up but the stream is a fraction of the real one

export class RpcFailover {
  constructor({ endpoints, after = FAILOVER_DEFAULTS.after, cooldownMs = FAILOVER_DEFAULTS.cooldownMin * 60_000, unreachMs = FAILOVER_DEFAULTS.unreachMin * 60_000, noConnectMs = FAILOVER_DEFAULTS.noConnectMs, retryMs = FAILOVER_DEFAULTS.retryMs, loudMs = FAILOVER_DEFAULTS.loudMs, now = () => Date.now(), log = () => {} }) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error("RpcFailover needs at least one endpoint");
    this.endpoints = endpoints;
    this.after = after;
    this.cooldownMs = cooldownMs;
    this.unreachMs = unreachMs;
    this.noConnectMs = noConnectMs;
    this.retryMs = retryMs;
    this.loudMs = loudMs;
    this.now = now;
    this.log = log; // (level: "info" | "warn" | "error", message) — messages never hold a URL
    this.cur = 0;
    // state: null (usable / never failed) | "exhausted" (limit signal) | "unreachable" (no connect);
    // blockedAt: when that state began (eligible again after cooldownMs / unreachMs).
    // lastClose / lastError / attempts: diagnostics of the current window (KODING #23).
    this.st = endpoints.map(() => ({ fails: 0, state: null, blockedAt: null, lastFailAt: 0, lastClose: null, lastError: null, attempts: 0 }));
    this.switches = 0;
    this.unreachableSwitches = 0;
    this.thinSwitches = 0;
    this.allDown = false;
    this.netDown = false; // the "network likely down" line was logged and nothing has answered since
    this.lastLoudAt = -Infinity;
    this.lastProbeAt = -Infinity;
    this.wsDownSince = null; // the websocket is not healthy since (ms), null = healthy / never tried
    this.downSince = null; // as wsDownSince, but not restarted by a switch (the "for N s" of the loud line)
    this.fastReconnect = false;
    this.listeners = [];
  }

  current() {
    return this.endpoints[this.cur];
  }
  get idx() {
    return this.cur + 1;
  }
  onSwitch(fn) {
    this.listeners.push(fn);
  }
  stats() {
    return { rpcIdx: this.idx, rpcSwitches: this.switches, rpcUnreachable: this.unreachableSwitches, rpcThin: this.thinSwitches, rpcAllDown: this.allDown };
  }

  // The census saw a thin stream on endpoint `idx` (createThinStreamDetector: `k` gaps in
  // `windowMin` min). Switch like "unreachable" (state "thin", eligible again after unreachMs); a stale
  // report (an endpoint we already left) is ignored. An endpoint still cooling as exhausted stays so.
  thin({ k, windowMin = 10 } = {}, idx = this.idx) {
    if (idx !== this.idx) return false;
    const t = this.now();
    const s = this.st[this.cur];
    s.lastFailAt = t;
    const state = s.state === EXHAUSTED && !this._eligible(this.cur, t) ? EXHAUSTED : THIN;
    this._thinInfo = `${k} gaps in ${windowMin} min`;
    this._thinK = k;
    try {
      if (this.allDown) {
        if (state === THIN) this._block(this.cur, THIN, t);
        this.log("error", `[rpc] endpoint ${endpointLabel(this.current())} gives a thin stream (${this._thinInfo}): switching`);
        return this._probe(t, "census:thin-stream");
      }
      return this._exhaust(t, "census:thin-stream", s.fails, state);
    } finally {
      this._thinInfo = null;
      this._thinK = null;
    }
  }

  // An exhaustion signal observed on endpoint `idx` (1-based; default the current one). A stale
  // observation (an answer from an endpoint we already left) is ignored.
  fail(channel, reason, idx = this.idx) {
    if (idx !== this.idx) return false;
    const t = this.now();
    const s = this.st[this.cur];
    s.fails += 1;
    s.lastFailAt = t;
    if (this.allDown) {
      // A limit signal in all-down mode: this key really is out (an unreachable one included).
      if (s.fails >= this.after && s.state !== EXHAUSTED) this._block(this.cur, EXHAUSTED, t);
      return this._probe(t, `${channel}:${reason}`);
    }
    if (s.fails >= this.after) return this._exhaust(t, `${channel}:${reason}`, s.fails, EXHAUSTED);
    return false;
  }

  // A healthy answer from endpoint `idx`.
  ok(_channel, idx = this.idx) {
    if (idx !== this.idx) return;
    const s = this.st[this.cur];
    s.fails = 0;
    s.state = null;
    s.blockedAt = null;
    if (this.allDown || this.netDown) {
      this.allDown = false;
      this.netDown = false;
      this.log("warn", `[rpc] endpoint ${endpointLabel(this.current())} answers again: failover recovered`);
    }
  }

  // ---- websocket hooks (lib/ws.mjs) ----
  wsHealthy() {
    this.wsDownSince = null;
    this.downSince = null;
    this.st[this.cur].attempts = 0;
    this.ok("ws");
  }
  wsDown() {
    const t = this.now();
    if (this.wsDownSince === null) this.wsDownSince = t;
    if (this.downSince === null) this.downSince = t;
  }
  // `idx`: the endpoint of the socket that raised it (default the current one); the text is kept
  // for diagnostics, only a limit status counts as a failure (of the current endpoint, as before).
  wsError(err, idx = this.idx) {
    const s = this.st[idx - 1];
    if (s) s.lastError = safeText(err?.message, 80) || null;
    const r = wsErrorReason(err);
    if (r) this.fail("ws", r);
    return r;
  }
  // The socket of endpoint `idx` closed: diagnostics only, never a failover signal by itself.
  wsClosed(code, reason, idx = this.idx) {
    const s = this.st[idx - 1];
    if (!s) return;
    const c = Number(code);
    s.lastClose = { code: code !== undefined && code !== null && Number.isFinite(c) ? c : null, reason: safeText(reason, 80) };
  }
  wsRpcError(errObj) {
    const r = rpcErrorReason(errObj);
    if (r) this.fail("ws", r);
    return r;
  }
  // Called right before every (re)connect attempt; returns the websocket URL to use.
  beforeWsAttempt() {
    this.wsDown(); // not healthy until a subscription is confirmed (the first connect included)
    const t = this.now();
    if (this.wsDownSince !== null && t - this.wsDownSince >= this.noConnectMs) {
      const s = this.st[this.cur];
      s.lastFailAt = t;
      // An endpoint still cooling after a limit signal stays exhausted; otherwise it is unreachable.
      const state = s.state === EXHAUSTED && !this._eligible(this.cur, t) ? EXHAUSTED : UNREACHABLE;
      if (this.allDown) {
        if (state === UNREACHABLE) this._block(this.cur, UNREACHABLE, t); // an exhausted one keeps its cooldown
        this._probe(t, "ws:no-connect-60s");
      } else {
        this._exhaust(t, "ws:no-connect-60s", s.fails, state);
        // Still cycling (an endpoint was eligible again) but none has answered: say so.
        if (!this.allDown && this._allUnreachable()) this._loud(t, "ws:no-connect-60s");
      }
      this.wsDownSince = t; // a fresh window for the next endpoint
    }
    this.st[this.cur].attempts += 1;
    return this.current().wsUrl;
  }
  // The reconnect delay to use instead of the socket's own backoff `defMs`.
  reconnectDelay(defMs) {
    if (this.allDown) return this.retryMs;
    if (this.fastReconnect) {
      this.fastReconnect = false;
      return 250;
    }
    return defMs;
  }

  // ---- internals ----
  _block(j, state, t) {
    this.st[j].state = state;
    this.st[j].blockedAt = t;
  }
  _eligible(j, t) {
    const s = this.st[j];
    if (s.state === null || s.blockedAt === null) return true;
    return t - s.blockedAt >= (s.state === EXHAUSTED ? this.cooldownMs : this.unreachMs);
  }
  // At least one endpoint was left for a limit signal (credits / rate).
  _anyExhausted() {
    return this.st.some((s) => s.state === EXHAUSTED);
  }
  // Every endpoint's last state is "unreachable": none answered since, none out of credits.
  _allUnreachable() {
    return this.st.every((s) => s.state === UNREACHABLE);
  }

  // The current endpoint is out (`state`): the next eligible one, or all-down mode.
  _exhaust(t, reason, failures, state = EXHAUSTED) {
    const n = this.endpoints.length;
    this._block(this.cur, state, t);
    for (let k = 1; k < n; k++) {
      const j = (this.cur + k) % n;
      if (this._eligible(j, t)) return this._switchTo(j, reason, failures, t);
    }
    this.allDown = true;
    this.lastProbeAt = -Infinity;
    return this._probe(t, reason, failures);
  }

  // At most one loud line per loudMs: "network likely down" when every endpoint is unreachable,
  // otherwise "ALL ... exhausted ... add a key" (at least one endpoint is really out of credits).
  _loud(t, reason) {
    if (t - this.lastLoudAt < this.loudMs) return;
    this.lastLoudAt = t;
    const n = this.endpoints.length;
    const retry = Math.round(this.retryMs / 1000);
    if (this._anyExhausted()) {
      this.log("error", `[rpc] ALL ${n} RPC endpoint(s) exhausted (last: ${reason}). Retrying the least-recently-failed one every ${retry} s; the stream has NO data meanwhile. Add a key to RPC_URLS and restart, or wait for a refill.`);
    } else if (this._allUnreachable()) {
      this.netDown = true;
      const forSec = Math.round((t - (this.downSince ?? t)) / 1000);
      this.log("error", `[rpc] no endpoint reachable for ${forSec} s (all ${n} unreachable, none out of credits): the network of this device is likely down; retrying every ${retry} s`);
    } else {
      // None out of credits, at least one thin (the rest thin or unreachable).
      const thin = this.st.filter((s) => s.state === THIN).length;
      this.log("error", `[rpc] no endpoint gives a full stream (${thin} thin, ${n - thin} unreachable, none out of credits); retrying the least-recently-failed one every ${retry} s`);
    }
  }

  // All endpoints down: move to the least-recently-failed endpoint at most once per retryMs.
  _probe(t, reason, failures = this.st[this.cur].fails) {
    this._loud(t, reason);
    if (t - this.lastProbeAt < this.retryMs) return false;
    this.lastProbeAt = t;
    let best = this.cur;
    for (let j = 0; j < this.endpoints.length; j++) {
      if (this.st[j].lastFailAt < this.st[best].lastFailAt) best = j;
    }
    if (best === this.cur) return false;
    const prefix = this._anyExhausted() ? "all-exhausted" : this._allUnreachable() ? "all-unreachable" : "all-down";
    return this._switchTo(best, `${prefix} ${reason}`, failures, t, { quiet: true });
  }

  _switchTo(j, reason, failures, t, { quiet = false } = {}) {
    const from = this.cur;
    const fst = this.st[from];
    const state = fst.state ?? EXHAUSTED;
    this.cur = j;
    this.st[j].fails = 0;
    this.switches += 1;
    if (state === UNREACHABLE) this.unreachableSwitches += 1;
    if (state === THIN) this.thinSwitches += 1;
    this.fastReconnect = !this.allDown;
    if (this.wsDownSince !== null) this.wsDownSince = t;
    const to = this.endpoints[j];
    const row = {
      type: "rpc_switch",
      fromIdx: from + 1,
      toIdx: j + 1,
      host: to.host,
      reason: safeText(reason, 120),
      failures,
      at: new Date(t).toISOString(),
      // KODING #23: the endpoint left — why (state) and what its socket last saw (secret-free).
      state,
      lastClose: fst.lastClose ? { ...fst.lastClose } : null,
      lastError: fst.lastError,
      attempts: fst.attempts,
      ...(state === THIN && this._thinK ? { thinGaps: this._thinK } : {}),
    };
    // A fresh window on the new endpoint: its own attempts / close / error from now on.
    Object.assign(this.st[j], { attempts: 0, lastClose: null, lastError: null });
    if (!quiet) {
      let what = `exhausted (${row.reason}, ${failures} failure(s))`;
      if (state === UNREACHABLE) {
        const lc = row.lastClose ? `${row.lastClose.code ?? "?"}${row.lastClose.reason ? ` ${row.lastClose.reason}` : ""}` : "none";
        what = `unreachable (${row.reason}, ${row.attempts} connect attempt(s), last close ${lc}${row.lastError ? `, last error: ${row.lastError}` : ""})`;
      }
      if (state === THIN && this._thinInfo) {
        // Loud: the socket looked healthy, so nothing else would have said it.
        this.log("error", `[rpc] endpoint ${endpointLabel(this.endpoints[from])} gives a thin stream (${this._thinInfo}): switching to ${endpointLabel(to)}`);
      } else {
        this.log("warn", `[rpc] endpoint ${endpointLabel(this.endpoints[from])} ${what} -> switching to ${endpointLabel(to)}`);
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(row);
      } catch {
        /* a listener must not break the switch */
      }
    }
    return true;
  }
}

// The fetch used by lib/rpc.mjs once a research process installs the failover: every HTTP RPC
// request goes to the CURRENT endpoint (whatever URL web3.js passes), with the same hard timeout,
// and its answer is classified. Network errors / timeouts are not exhaustion signals.
export function makeFailoverFetch(fo, { timeoutMs, fetchImpl = (...a) => fetch(...a) }) {
  return async (_input, init = {}) => {
    const ep = fo.current();
    const res = await fetchImpl(ep.url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let text = "";
    if (EXHAUST_STATUS.has(res.status) || res.ok) {
      try {
        text = await res.clone().text();
      } catch {
        text = "";
      }
    }
    const reason = httpReason(res.status, text);
    if (reason) fo.fail("http", reason, ep.idx);
    else if (res.ok) fo.ok("http", ep.idx);
    return res;
  };
}
