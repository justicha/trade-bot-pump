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
//   - HTTP status 401 / 403 / 429 (websocket handshake "Unexpected server response: 429" or an HTTP
//     JSON-RPC answer with that status);
//   - a JSON-RPC error with a documented provider limit code (429, -32429, -32007, -32008, -32029)
//     or whose message says limit / credits / capacity / quota / "max usage" / "too many requests"
//     (provider-neutral; the per-provider sources are listed at EXHAUST_CODES below).
// Or: the websocket has had no healthy (re)connect (subscription confirmed) for 60 s.
// Stream silence alone is never a reason (pump can be quiet).
//
// On exhaustion: the next endpoint in order that is not exhausted (an exhausted one is eligible
// again after RPC_FAILOVER_COOLDOWN_MIN: a key may refill). None eligible -> "all exhausted": the
// least-recently-failed endpoint is retried every 60 s and a loud line is logged once per 10 min.
// The process never exits on its own because of this.
//
// This module is pure (no network, no timers): the caller passes a clock, and the websocket
// (lib/ws.mjs, opt-in `useFailover`) and the HTTP client (lib/rpc.mjs, opt-in fetch) report to it.

export const FAILOVER_DEFAULTS = Object.freeze({
  after: 3,
  cooldownMin: 60,
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
  lines.push(`rpc endpoints: ${endpoints.map(endpointLabel).join(", ")} | failover after ${after} failures in a row or 60 s without a connect | cooldown ${cooldownMin} min`);
  const failover = new RpcFailover({ endpoints, after, cooldownMs: cooldownMin * 60_000, now, log });
  return { failover, endpoints, lines };
}

// ---- classification -------------------------------------------------------------------------------
// Provider-neutral: HTTP 401 / 403 / 429 plus generic limit wording, and the provider codes /
// messages that are documented (read 2026-11-16):
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
const EXHAUST_STATUS = new Set([401, 403, 429]);
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

// ---- the controller --------------------------------------------------------------------------------
export class RpcFailover {
  constructor({ endpoints, after = FAILOVER_DEFAULTS.after, cooldownMs = FAILOVER_DEFAULTS.cooldownMin * 60_000, noConnectMs = FAILOVER_DEFAULTS.noConnectMs, retryMs = FAILOVER_DEFAULTS.retryMs, loudMs = FAILOVER_DEFAULTS.loudMs, now = () => Date.now(), log = () => {} }) {
    if (!Array.isArray(endpoints) || endpoints.length === 0) throw new Error("RpcFailover needs at least one endpoint");
    this.endpoints = endpoints;
    this.after = after;
    this.cooldownMs = cooldownMs;
    this.noConnectMs = noConnectMs;
    this.retryMs = retryMs;
    this.loudMs = loudMs;
    this.now = now;
    this.log = log; // (level: "info" | "warn" | "error", message) — messages never hold a URL
    this.cur = 0;
    this.st = endpoints.map(() => ({ fails: 0, exhaustedAt: null, lastFailAt: 0 }));
    this.switches = 0;
    this.allDown = false;
    this.lastLoudAt = -Infinity;
    this.lastProbeAt = -Infinity;
    this.wsDownSince = null; // the websocket is not healthy since (ms), null = healthy / never tried
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
    return { rpcIdx: this.idx, rpcSwitches: this.switches, rpcAllDown: this.allDown };
  }

  // An exhaustion signal observed on endpoint `idx` (1-based; default the current one). A stale
  // observation (an answer from an endpoint we already left) is ignored.
  fail(channel, reason, idx = this.idx) {
    if (idx !== this.idx) return false;
    const t = this.now();
    const s = this.st[this.cur];
    s.fails += 1;
    s.lastFailAt = t;
    if (this.allDown) return this._probe(t, `${channel}:${reason}`);
    if (s.fails >= this.after) return this._exhaust(t, `${channel}:${reason}`, s.fails);
    return false;
  }

  // A healthy answer from endpoint `idx`.
  ok(_channel, idx = this.idx) {
    if (idx !== this.idx) return;
    const s = this.st[this.cur];
    s.fails = 0;
    s.exhaustedAt = null;
    if (this.allDown) {
      this.allDown = false;
      this.log("warn", `[rpc] endpoint ${endpointLabel(this.current())} answers again: failover recovered`);
    }
  }

  // ---- websocket hooks (lib/ws.mjs) ----
  wsHealthy() {
    this.wsDownSince = null;
    this.ok("ws");
  }
  wsDown() {
    if (this.wsDownSince === null) this.wsDownSince = this.now();
  }
  wsError(err) {
    const r = wsErrorReason(err);
    if (r) this.fail("ws", r);
    return r;
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
      if (this.allDown) this._probe(t, "ws:no-connect-60s");
      else this._exhaust(t, "ws:no-connect-60s", s.fails);
      this.wsDownSince = t; // a fresh window for the next endpoint
    }
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
  _exhaust(t, reason, failures) {
    const n = this.endpoints.length;
    this.st[this.cur].exhaustedAt = t;
    for (let k = 1; k < n; k++) {
      const j = (this.cur + k) % n;
      const s = this.st[j];
      if (s.exhaustedAt === null || t - s.exhaustedAt >= this.cooldownMs) return this._switchTo(j, reason, failures, t);
    }
    this.allDown = true;
    this.lastProbeAt = -Infinity;
    return this._probe(t, reason, failures);
  }

  // All endpoints exhausted: move to the least-recently-failed endpoint at most once per retryMs.
  _probe(t, reason, failures = this.st[this.cur].fails) {
    if (t - this.lastLoudAt >= this.loudMs) {
      this.lastLoudAt = t;
      this.log("error", `[rpc] ALL ${this.endpoints.length} RPC endpoint(s) exhausted (last: ${reason}). Retrying the least-recently-failed one every ${Math.round(this.retryMs / 1000)} s; the stream has NO data meanwhile. Add a key to RPC_URLS and restart, or wait for a refill.`);
    }
    if (t - this.lastProbeAt < this.retryMs) return false;
    this.lastProbeAt = t;
    let best = this.cur;
    for (let j = 0; j < this.endpoints.length; j++) {
      if (this.st[j].lastFailAt < this.st[best].lastFailAt) best = j;
    }
    if (best === this.cur) return false;
    return this._switchTo(best, `all-exhausted ${reason}`, failures, t, { quiet: true });
  }

  _switchTo(j, reason, failures, t, { quiet = false } = {}) {
    const from = this.cur;
    this.cur = j;
    this.st[j].fails = 0;
    this.switches += 1;
    this.fastReconnect = !this.allDown;
    if (this.wsDownSince !== null) this.wsDownSince = t;
    const to = this.endpoints[j];
    const row = { type: "rpc_switch", fromIdx: from + 1, toIdx: j + 1, host: to.host, reason: safeText(reason, 120), failures, at: new Date(t).toISOString() };
    if (!quiet) this.log("warn", `[rpc] endpoint ${endpointLabel(this.endpoints[from])} exhausted (${row.reason}, ${failures} failure(s)) -> switching to ${endpointLabel(to)}`);
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
