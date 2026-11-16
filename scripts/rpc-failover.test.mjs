// KODING #20: RPC endpoint failover for the research processes (shadow lab, mint census).
//
//   1. RPC_URLS parsing: good list, bad scheme, empty item, duplicate, bad RPC_FAILOVER_*; the
//      "RPC_URL only" path installs nothing (failover null, SolanaWs/rpc.mjs untouched).
//   2. the controller with a fake clock: N in a row, a success resets, cooldown before going back to
//      an exhausted endpoint, all endpoints exhausted -> no exit, a probe at most every 60 s, one loud
//      line per 10 min, recovery.
//   3. HTTP: JSON-RPC "max usage reached" on fixture #1 -> after RPC_FAILOVER_AFTER the next call goes
//      to fixture #2 (the real web3.js Connection of lib/rpc.mjs, opt-in fetch).
//   4. websocket (in process, real `ws` sockets): a subscribe answered with -32429 -> the socket is
//      dropped and retried; after 3 in a row it moves to #2, resubscribes, events flow.
//   5. the mint census process: fixture #1 rejects the handshake with 429 -> after 3 attempts it
//      connects to #2, resubscribes, rows flow, an rpc_switch row; no URL / key text anywhere.
//   6. the census with every endpoint answering 429: it keeps running, one loud line, no hammering.
//   7. the shadow lab with RPC_URLS: startup line, gshadow_mem rpcIdx / rpcSwitches, no key text.
//   8. live / other bots: RPC_URLS ignored with a warning; only shadow.mjs and mint-census.mjs
//      install the failover (static check), and both opt-in hooks refuse --live in code.
import "./lib/test-env.mjs";
import { cleanEnv } from "./lib/test-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log(`ok - ${m}`);
const KEY_RE = /FIXTUREKEY|api-key/i;

delete process.env.RPC_MOCK;
delete process.env.WS_MOCK;
delete process.env.RPC_URLS;

const F = await import("../lib/rpc-failover.mjs");

// ---- 1. parsing -------------------------------------------------------------------------------------
{
  const eps = F.parseRpcUrlList(" https://mainnet.helius-rpc.com/?api-key=FIXTUREKEYa , https://rpc.example.org/x?token=FIXTUREKEYb,http://127.0.0.1:8899");
  assert.equal(eps.length, 3);
  assert.deepEqual(eps.map((e) => [e.idx, e.host]), [[1, "mainnet.helius-rpc.com"], [2, "rpc.example.org"], [3, "127.0.0.1"]]);
  assert.equal(eps[0].wsUrl, "wss://mainnet.helius-rpc.com/?api-key=FIXTUREKEYa", "ws URL derived per endpoint as lib/config.mjs does");
  assert.equal(eps[2].wsUrl, "ws://127.0.0.1:8899");
  assert.equal(F.endpointLabel(eps[1]), "#2 rpc.example.org");
  const bad = (raw, re) => {
    let msg = "";
    try {
      F.parseRpcUrlList(raw);
    } catch (e) {
      msg = e.message;
    }
    assert.match(msg, re, `"${raw.replace(/FIXTUREKEY\w*/g, "K")}" is refused`);
    assert.ok(!KEY_RE.test(msg), `the error does not echo the URL: ${msg}`);
  };
  bad("https://a.example/?api-key=FIXTUREKEY1,wss://b.example/?api-key=FIXTUREKEY2", /item #2 must start with http/);
  bad("https://a.example/?api-key=FIXTUREKEY1,,https://b.example", /item #2 is empty/);
  bad("https://a.example/?api-key=FIXTUREKEY1,", /item #2 is empty/);
  bad("https://a.example/?api-key=FIXTUREKEY1,https://a.example/?api-key=FIXTUREKEY1/", /item #2 duplicates item #1/);
  bad("ftp://a.example/?api-key=FIXTUREKEY1", /item #1 must start with http/);

  // #20b: `http_url|ws_url` (Ankr / Chainstack style: the websocket on another path / host).
  const pair = F.parseRpcUrlList("https://rpc.ankr.com/solana/FIXTUREKEYa | wss://rpc.ankr.com/solana/ws/FIXTUREKEYa,https://mainnet.helius-rpc.com/?api-key=FIXTUREKEYb");
  assert.equal(pair[0].url, "https://rpc.ankr.com/solana/FIXTUREKEYa", "HTTP goes to the http part");
  assert.equal(pair[0].wsUrl, "wss://rpc.ankr.com/solana/ws/FIXTUREKEYa", "the websocket goes to the ws part as given");
  assert.equal(pair[0].host, "rpc.ankr.com");
  assert.equal(pair[1].wsUrl, "wss://mainnet.helius-rpc.com/?api-key=FIXTUREKEYb", "no '|': derived as before");
  const hw = F.parseRpcUrlList("https://a.example/FIXTUREKEY1|wss://ws.other.example/FIXTUREKEY1");
  assert.equal(hw[0].host, "a.example", "the printed host is the http part's");
  bad("https://a.example/FIXTUREKEY1|https://a.example/ws/FIXTUREKEY1", /item #1: the websocket part must start with ws:\/\/ or wss:\/\//);
  bad("https://a.example/FIXTUREKEY1|", /item #1: the websocket part after "\|" is empty/);
  bad("|wss://a.example/FIXTUREKEY1", /item #1: the http part is empty/);
  bad("https://a.example/FIXTUREKEY1|wss://a.example/FIXTUREKEY1|wss://b.example", /item #1 has more than one "\|"/);
  bad("https://a.example/FIXTUREKEY1|wss://", /item #1: the websocket part (is not a valid URL|has no host)/);
  bad("https://a.example/FIXTUREKEY1|wss://x.example/1,https://a.example/FIXTUREKEY1|wss://y.example/2", /item #2 duplicates item #1/);

  // RPC_URL only: nothing installed, the old single endpoint.
  const single = F.setupFailover({ env: { RPC_URL: "https://mainnet.helius-rpc.com/?api-key=FIXTUREKEY0" } });
  assert.equal(single.failover, null, "without RPC_URLS no failover is created");
  assert.deepEqual(single.endpoints.map((e) => e.host), ["mainnet.helius-rpc.com"]);
  assert.ok(single.lines.every((l) => !KEY_RE.test(l)) && /#1 mainnet\.helius-rpc\.com \(RPC_URL, failover off\)/.test(single.lines.join("\n")), single.lines.join(" | "));
  // Both set: RPC_URLS wins, RPC_URL ignored (said once).
  const both = F.setupFailover({ env: { RPC_URL: "https://x.example/?api-key=FIXTUREKEY0", RPC_URLS: "https://a.example/?api-key=FIXTUREKEY1,https://b.example/?api-key=FIXTUREKEY2" } });
  assert.ok(both.failover instanceof F.RpcFailover);
  assert.match(both.lines.join("\n"), /RPC_URL is ignored by this process/);
  assert.match(both.lines.join("\n"), /rpc endpoints: #1 a\.example, #2 b\.example \| failover after 3 failures/);
  assert.ok(both.lines.every((l) => !KEY_RE.test(l)));
  // live: never a failover, a warning.
  const live = F.setupFailover({ env: { RPC_URL: "https://x.example/?k=FIXTUREKEY0", RPC_URLS: "https://a.example,https://b.example" }, live: true });
  assert.equal(live.failover, null, "live: RPC_URLS ignored");
  assert.match(live.lines.join("\n"), /RPC_URLS is ignored with --live/);
  assert.deepEqual(live.endpoints.map((e) => e.host), ["x.example"]);
  // bad knobs
  assert.throws(() => F.setupFailover({ env: { RPC_URLS: "https://a.example", RPC_FAILOVER_AFTER: "0" } }), /RPC_FAILOVER_AFTER/);
  assert.throws(() => F.setupFailover({ env: { RPC_URLS: "https://a.example", RPC_FAILOVER_COOLDOWN_MIN: "abc" } }), /RPC_FAILOVER_COOLDOWN_MIN/);
  ok("RPC_URLS parsing: list / bad scheme / empty item / duplicate / knobs; RPC_URL-only installs nothing; errors never echo a URL");
}

// ---- classification ---------------------------------------------------------------------------------
{
  assert.equal(F.wsErrorReason(new Error("Unexpected server response: 429")), "ws-handshake-429");
  assert.equal(F.wsErrorReason(new Error("Unexpected server response: 401")), "ws-handshake-401");
  assert.equal(F.wsErrorReason(new Error("Unexpected server response: 503")), null, "a 503 is not exhaustion (only the 60 s no-connect rule)");
  assert.equal(F.wsErrorReason(new Error("connect ECONNREFUSED 127.0.0.1:1")), null);
  assert.match(F.rpcErrorReason({ code: -32429, message: "max usage reached" }), /^rpc-error -32429 max usage reached$/);
  assert.match(F.rpcErrorReason({ code: -32005, message: "Too many requests" }), /-32005/, "Helius rate limit (by its message)");
  assert.equal(F.rpcErrorReason({ code: -32005, message: "Node is behind by 42 slots" }), null, "standard Solana -32005 (node unhealthy) is not a limit");
  assert.equal(F.rpcErrorReason({ code: -32011, message: "Transaction history is not available from this node" }), null, "Solana -32011 is not matched by code");
  // Alchemy (docs: error-reference / throughput): WS rate limit = JSON-RPC code 429; monthly = 403 + -32600.
  assert.match(F.rpcErrorReason({ code: 429, message: "Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message. If not, check out /docs/reference/throughput" }), /^rpc-error 429 /);
  assert.match(F.rpcErrorReason({ code: 429, message: "" }), /^rpc-error 429/, "Alchemy WS limit by code alone");
  assert.match(F.rpcErrorReason({ code: -32600, message: "Monthly capacity limit exceeded." }), /Monthly capacity/);
  assert.match(F.httpReason(403, '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Monthly capacity limit exceeded."},"id":1}'), /^http-403 rpc-error -32600 Monthly capacity limit exceeded/);
  assert.match(F.httpReason(401, '{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid access key"},"id":1}'), /^http-401/);
  // QuickNode (docs: solana/error-references): -32007 / -32008 / -32029 (message text undocumented), 429.
  for (const code of [-32007, -32008, -32029]) assert.match(F.rpcErrorReason({ code, message: "" }), new RegExp(`^rpc-error ${code}`), `QuickNode ${code}`);
  assert.match(F.rpcErrorReason({ code: -32011, message: "Method rate limit reached" }), /-32011/, "QuickNode method limit by its words");
  assert.match(F.httpReason(429, "429 Client Error: Too Many Requests"), /^http-429$/, "QuickNode 429 with a plain-text body");
  assert.match(F.rpcErrorReason({ code: -32000, message: "credits exhausted" }), /credits/);
  assert.equal(F.rpcErrorReason({ code: -32602, message: "Invalid param: WrongSize" }), null);
  assert.match(F.httpReason(429, '{"jsonrpc":"2.0","error":{"code":-32005,"message":"Too many requests"},"id":"1"}'), /^http-429 rpc-error -32005/);
  assert.equal(F.httpReason(401, ""), "http-401");
  assert.match(F.httpReason(200, '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"},"id":1}'), /max usage reached/);
  assert.equal(F.httpReason(200, '{"jsonrpc":"2.0","result":{"value":1},"id":1}'), null);
  assert.equal(F.httpReason(500, "oops"), null);
  assert.equal(F.safeText("bad https://mainnet.helius-rpc.com/?api-key=FIXTUREKEY9 x"), "bad <url> x");
  ok("exhaustion signals: 401/403/429; Helius / Alchemy / QuickNode documented codes and messages; generic limit words; 503 / refused / Solana -32005 node-unhealthy / other errors are not");
}

// ---- 2. the controller (fake clock) --------------------------------------------------------------------
function mk(n, opts = {}) {
  let t = 1_000_000;
  const logs = [];
  const rows = [];
  const eps = F.parseRpcUrlList(Array.from({ length: n }, (_, i) => `https://h${i + 1}.example/?api-key=FIXTUREKEY${i + 1}`).join(","));
  const fo = new F.RpcFailover({ endpoints: eps, now: () => t, log: (lv, m) => logs.push([lv, m]), ...opts });
  fo.onSwitch((r) => rows.push(r));
  return { fo, logs, rows, adv: (ms) => (t += ms), now: () => t };
}
{
  const { fo, rows, adv } = mk(2);
  fo.fail("http", "http-429");
  fo.fail("http", "http-429");
  fo.ok("http"); // a healthy answer in between resets the run
  fo.fail("http", "http-429");
  fo.fail("http", "http-429");
  assert.equal(fo.idx, 1, "2 in a row after a success: still #1");
  adv(10);
  fo.fail("http", "http-429");
  assert.equal(fo.idx, 2, "3 in a row: switched");
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], at: undefined }, { type: "rpc_switch", fromIdx: 1, toIdx: 2, host: "h2.example", reason: "http:http-429", failures: 3, at: undefined });
  assert.equal(fo.fail("http", "x", 1), false, "a late answer of the endpoint we left is ignored");
  assert.equal(fo.stats().rpcSwitches, 1);
  ok("N in a row (default 3) switches; a success resets the run; stale answers of the old endpoint are ignored");
}
{
  // Cooldown: 3 endpoints, back to an exhausted one only after RPC_FAILOVER_COOLDOWN_MIN.
  const { fo, rows, adv, logs } = mk(3, { after: 1, cooldownMs: 60 * 60_000 });
  fo.fail("ws", "ws-handshake-429"); // #1 out at t0
  assert.equal(fo.idx, 2);
  adv(10 * 60_000);
  fo.fail("ws", "ws-handshake-429"); // #2 out at t0+10 min
  assert.equal(fo.idx, 3, "#2 -> #3 (next in order)");
  adv(10 * 60_000);
  fo.fail("ws", "ws-handshake-429"); // #3 out at t0+20 min: #1 (20 min) and #2 (10 min) still cooling
  assert.equal(fo.allDown, true, "nothing eligible before the cooldown: all exhausted");
  assert.equal(logs.filter(([lv, m]) => lv === "error" && /ALL 3 RPC endpoint/.test(m)).length, 1, "a loud line");
  assert.equal(rows.at(-1).reason.startsWith("all-exhausted"), true, "the probe goes to the least-recently-failed endpoint");
  assert.equal(rows.at(-1).toIdx, 1, "least-recently-failed = #1");

  const b = mk(2, { after: 1, cooldownMs: 60 * 60_000 });
  b.fo.fail("ws", "ws-handshake-429"); // #1 out at t0 -> #2
  b.adv(59 * 60_000);
  b.fo.fail("ws", "ws-handshake-429"); // #2 out at t0+59 min: #1 is still cooling
  assert.equal(b.fo.allDown, true, "59 min: no normal switch back to #1");
  const c = mk(2, { after: 1, cooldownMs: 60 * 60_000 });
  c.fo.fail("ws", "ws-handshake-429");
  c.adv(61 * 60_000);
  c.fo.fail("ws", "ws-handshake-429"); // #2 out at t0+61 min: #1 has cooled
  assert.equal(c.fo.allDown, false);
  assert.equal(c.fo.idx, 1, "61 min: back to #1 as a normal switch");
  assert.equal(c.rows.at(-1).reason, "ws:ws-handshake-429");
  assert.equal(c.fo.reconnectDelay(5000), 250, "after a normal switch the socket reconnects at once");
  ok("cooldown: an exhausted endpoint is used again only after RPC_FAILOVER_COOLDOWN_MIN; otherwise all-exhausted mode");
}
{
  // All endpoints failing for 30 min, a failure every 5 s: no throw, probes <= 1 per 60 s, one loud
  // line per 10 min, reconnect delay 60 s; a healthy answer recovers.
  const { fo, logs, rows, adv } = mk(2, { after: 1 });
  for (let i = 0; i < 360; i++) {
    fo.fail(i % 2 ? "http" : "ws", "http-429");
    adv(5000);
  }
  const loud = logs.filter(([lv, m]) => lv === "error" && /ALL 2 RPC endpoint\(s\) exhausted/.test(m));
  assert.equal(loud.length, 3, `one loud line per 10 min over 30 min (got ${loud.length})`);
  assert.ok(rows.length <= 32 && rows.length >= 20, `a probe at most once per 60 s (switches ${rows.length})`);
  assert.equal(fo.reconnectDelay(1000), 60_000, "all exhausted: the websocket retries every 60 s");
  assert.ok(loud.every(([, m]) => !KEY_RE.test(m)));
  fo.ok("ws");
  assert.equal(fo.allDown, false, "a healthy answer ends all-exhausted mode");
  assert.ok(logs.some(([lv, m]) => lv === "warn" && /answers again/.test(m)));
  assert.equal(fo.reconnectDelay(1000), 1000, "back to the socket's own backoff");
  ok("all endpoints exhausted: never exits, probes the least-recently-failed every 60 s, one loud line per 10 min, recovers");
}
{
  // 60 s without a healthy (re)connect -> switch, even when the errors are not 429s.
  const { fo, rows, adv } = mk(2);
  fo.beforeWsAttempt();
  adv(30_000);
  assert.equal(fo.beforeWsAttempt(), "wss://h1.example/?api-key=FIXTUREKEY1");
  adv(31_000);
  assert.equal(fo.beforeWsAttempt(), "wss://h2.example/?api-key=FIXTUREKEY2", "61 s down: next endpoint");
  assert.equal(rows[0].reason, "ws:no-connect-60s");
  fo.wsHealthy();
  adv(600_000);
  fo.wsDown(); // a drop after a healthy period starts a fresh window
  adv(30_000);
  fo.beforeWsAttempt();
  assert.equal(fo.idx, 2, "a fresh window after a healthy period");
  ok("no healthy (re)connect for 60 s switches; silence after a healthy connect starts a fresh window");
}

// ---- 3. HTTP through the real lib/rpc.mjs Connection -----------------------------------------------
function rpcServer(handler) {
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      s.hits += 1;
      s.paths.push(req.url);
      const j = JSON.parse(body);
      handler(j, res);
    });
  });
  s.hits = 0;
  s.paths = [];
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const reply = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
{
  const h1 = await rpcServer((j, res) => reply(res, 200, { jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" }, id: j.id }));
  const h2 = await rpcServer((j, res) => reply(res, 200, { jsonrpc: "2.0", result: { context: { slot: 1 }, value: 7_000_000_000 }, id: j.id }));
  const u1 = `http://127.0.0.1:${h1.address().port}/?api-key=FIXTUREKEYH1`;
  const u2 = `http://127.0.0.1:${h2.address().port}/?api-key=FIXTUREKEYH2`;
  process.env.RPC_URL = u1; // the Connection is built on RPC_URL: the failover fetch reroutes it
  const { connection, setRpcFailoverFetch } = await import("../lib/rpc.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  const pk = new PublicKey("11111111111111111111111111111111");
  // Default path first: no failover installed -> the call goes to RPC_URL (#1) and fails as before.
  await assert.rejects(connection.getBalance(pk), /max usage reached/);
  assert.equal(h1.hits, 1);
  const rows = [];
  const fo = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`${u1},${u2}`) });
  fo.onSwitch((r) => rows.push(r));
  setRpcFailoverFetch(F.makeFailoverFetch(fo, { timeoutMs: 5000 }));
  for (let i = 0; i < 3; i++) await assert.rejects(connection.getBalance(pk), /max usage reached/);
  assert.equal(h1.hits, 4);
  assert.equal(fo.idx, 2, "after 3 in a row the failover moved to #2");
  assert.equal(await connection.getBalance(pk), 7_000_000_000, "the next call is answered by #2");
  assert.equal(h2.hits, 1);
  assert.equal(h2.paths[0], "/?api-key=FIXTUREKEYH2", "the call carried #2's own URL (its key)");
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /^http:rpc-error -32429 max usage reached$/);
  assert.ok(!KEY_RE.test(JSON.stringify(rows)), "no key in the row");
  // HTTP 429 (Helius documented rate limit: 429 + -32005 "Too many requests") counts the same way.
  const h3 = await rpcServer((j, res) => reply(res, 429, { jsonrpc: "2.0", error: { code: -32005, message: "Too many requests" }, id: j.id }));
  const fo3 = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`http://127.0.0.1:${h3.address().port}/?api-key=FIXTUREKEYH3,${u2}`) });
  setRpcFailoverFetch(F.makeFailoverFetch(fo3, { timeoutMs: 5000 }));
  for (let i = 0; i < 3; i++) await assert.rejects(connection.getBalance(pk));
  assert.equal(await connection.getBalance(pk), 7_000_000_000);
  assert.equal(fo3.idx, 2);
  for (const s of [h1, h2, h3]) s.close();
  ok('HTTP: "max usage reached" (and 429 / -32005) on #1 three times -> the next call goes to #2 with its own URL');
}

// ---- 4. websocket in process: subscribe rejected with -32429 -----------------------------------------
function wsServer({ subscribeError = false } = {}) {
  const wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
  wss.conns = 0;
  wss.subs = 0;
  wss.on("connection", (sock) => {
    wss.conns += 1;
    sock.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method !== "logsSubscribe") return;
      wss.subs += 1;
      if (subscribeError) {
        sock.send(JSON.stringify({ jsonrpc: "2.0", error: { code: -32429, message: "max usage reached" }, id: m.id }));
        return;
      }
      sock.send(JSON.stringify({ jsonrpc: "2.0", result: 77, id: m.id }));
      let k = 0;
      const iv = setInterval(() => {
        if (sock.readyState !== WebSocket.OPEN) return clearInterval(iv);
        k += 1;
        sock.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 77, result: { context: { slot: k }, value: { signature: `sig-${k}`, err: null, logs: ["x"] } } } }));
        if (k >= 5) clearInterval(iv);
      }, 20);
    });
  });
  return new Promise((r) => wss.on("listening", () => r(wss)));
}
{
  const w1 = await wsServer({ subscribeError: true });
  const w2 = await wsServer();
  const { SolanaWs } = await import("../lib/ws.mjs");
  const plain = new SolanaWs("ws://127.0.0.1:1");
  assert.equal(plain.failover, null, "SolanaWs has no failover by default");
  const fo = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`http://127.0.0.1:${w1.address().port}/?api-key=FIXTUREKEYW1,http://127.0.0.1:${w2.address().port}/?api-key=FIXTUREKEYW2`) });
  const rows = [];
  fo.onSwitch((r) => rows.push(r));
  const ws = new SolanaWs("ws://127.0.0.1:1"); // the constructor URL is not used once a failover is installed
  ws.baseReconnectMs = 50;
  ws.useFailover(fo);
  const got = [];
  ws.subscribeLogs("Prog1111111111111111111111111111111111111111", (r) => got.push(r.value.signature));
  await ws.connect();
  const t0 = Date.now();
  while (got.length < 5 && Date.now() - t0 < 10_000) await wait(50);
  assert.equal(w1.subs, 3, `#1 rejected the subscribe 3 times (got ${w1.subs})`);
  assert.equal(fo.idx, 2);
  assert.equal(w2.subs, 1, "resubscribed on #2");
  assert.deepEqual(got, ["sig-1", "sig-2", "sig-3", "sig-4", "sig-5"], "events flow from #2");
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /^ws:rpc-error -32429 max usage reached$/);
  await ws.close();
  w1.close();
  w2.close();
  ok("websocket: a subscribe rejected with -32429 drops the socket; 3 in a row -> #2, resubscribed, events flow");
}

// ---- 4b. `http|ws` endpoints: websocket to the ws part, HTTP to the http part -----------------------
{
  const w = await wsServer();
  const h = await rpcServer((j, res) => reply(res, 200, { jsonrpc: "2.0", result: { context: { slot: 1 }, value: 42 }, id: j.id }));
  w.paths = [];
  w.on("connection", (_s, req) => w.paths.push(req.url));
  // http part = the HTTP fixture; ws part = the websocket fixture on another port and path. The
  // derived URL (ws://<http host:port>/...) would hit the HTTP fixture, which refuses upgrades.
  const list = `http://127.0.0.1:${h.address().port}/rpc/FIXTUREKEYP1|ws://127.0.0.1:${w.address().port}/ws/FIXTUREKEYP1`;
  const fo = new F.RpcFailover({ endpoints: F.parseRpcUrlList(list) });
  const { SolanaWs } = await import("../lib/ws.mjs");
  const ws = new SolanaWs("ws://127.0.0.1:1");
  ws.useFailover(fo);
  const got = [];
  ws.subscribeLogs("Prog1111111111111111111111111111111111111111", (r) => got.push(r.value.signature));
  await ws.connect();
  const t0 = Date.now();
  while (got.length < 5 && Date.now() - t0 < 5000) await wait(50);
  assert.deepEqual(w.paths, ["/ws/FIXTUREKEYP1"], "the websocket connected to the ws part (its path)");
  assert.equal(got.length, 5, "events flow on the ws part");
  await ws.close();
  const { connection, setRpcFailoverFetch } = await import("../lib/rpc.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  setRpcFailoverFetch(F.makeFailoverFetch(fo, { timeoutMs: 5000 }));
  assert.equal(await connection.getBalance(new PublicKey("11111111111111111111111111111111")), 42);
  assert.deepEqual(h.paths, ["/rpc/FIXTUREKEYP1"], "HTTP went to the http part");
  w.close();
  h.close();
  ok("http|ws item: the websocket goes to the ws part, HTTP to the http part");
}

// ---- 5. the mint census process: handshake 429 on #1 -------------------------------------------------
function rejectServer(status = 429) {
  const s = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  s.upgrades = 0;
  s.on("upgrade", (req, sock) => {
    s.upgrades += 1;
    sock.end(`HTTP/1.1 ${status} Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
async function censusFeedServer() {
  const W = await import("./mocks/ws-mock-census.mjs");
  const wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
  wss.subs = 0;
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.method !== "logsSubscribe") return;
      wss.subs += 1;
      sock.send(JSON.stringify({ jsonrpc: "2.0", result: 91, id: m.id }));
      (async () => {
        for (const n of W.buildNotifications()) {
          await wait(n.delayMs);
          if (sock.readyState !== WebSocket.OPEN) return;
          sock.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 91, result: n.payload() } }));
        }
      })();
    });
  });
  await new Promise((r) => wss.on("listening", r));
  return { wss, W };
}
function startCensus(env) {
  const child = spawn(process.execPath, [path.join(here, "mint-census.mjs")], { cwd: root, env });
  child.out = "";
  child.err = "";
  child.stdout.on("data", (b) => (child.out += String(b)));
  child.stderr.on("data", (b) => (child.err += String(b)));
  child.done = new Promise((resolve) => child.on("exit", (c) => resolve(c)));
  return child;
}
{
  const r1 = await rejectServer(429);
  const { wss: r2, W } = await censusFeedServer();
  const dir = tmp("census-failover-");
  const env = cleanEnv({
    ROOT: tmp("census-failover-root-"),
    RPC_URL: "http://127.0.0.1:1/?api-key=FIXTUREKEY0",
    RPC_URLS: `http://127.0.0.1:${r1.address().port}/?api-key=FIXTUREKEY1,http://127.0.0.1:${r2.address().port}/?api-key=FIXTUREKEY2`,
    CENSUS_DIR: dir,
    CENSUS_MAX_SEC: "4",
  });
  const child = startCensus(env);
  const killer = setTimeout(() => child.kill(), 40_000);
  const code = await child.done;
  clearTimeout(killer);
  r1.close();
  r2.close();
  assert.equal(code, 0, `census exited 0 (stderr: ${child.err.split(/\r?\n/).slice(0, 3).join(" | ")})`);
  assert.equal(r1.upgrades, 3, `3 handshakes rejected by #1 (got ${r1.upgrades})`);
  assert.equal(r2.subs, 1, "resubscribed on #2");
  assert.match(child.out, /rpc endpoints: #1 127\.0\.0\.1, #2 127\.0\.0\.1/);
  assert.match(child.out, /RPC_URL is ignored by this process/);
  assert.match(child.err, /endpoint #1 127\.0\.0\.1 exhausted \(ws:ws-handshake-429, 3 failure\(s\)\) -> switching to #2 127\.0\.0\.1/);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const text = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  const sw = rows.filter((r) => r.type === "rpc_switch");
  assert.equal(sw.length, 1);
  const { ts: _ts, at, ...swRest } = sw[0];
  assert.deepEqual(swRest, { type: "rpc_switch", fromIdx: 1, toIdx: 2, host: "127.0.0.1", reason: "ws:ws-handshake-429", failures: 3 });
  assert.ok(Number.isFinite(Date.parse(at)), "at is an ISO time");
  assert.ok(rows.some((r) => r.type === "census_mint" && r.mint === W.MIG_MINT && r.migrated === true), "events flowed from #2 (the migrated mint row)");
  const mem = rows.filter((r) => r.type === "census_mem").at(-1);
  assert.equal(mem.rpcIdx, 2);
  assert.equal(mem.rpcSwitches, 1);
  assert.ok(!KEY_RE.test(child.out + child.err + text), `no URL / key text in stdout, stderr or rows: ${(child.out + child.err + text).match(new RegExp(`.{0,60}(${KEY_RE.source}).{0,20}`, "i"))?.[0]}`);
  ok("census: #1 rejects the handshake with 429 x3 -> #2, resubscribed, rows flow, rpc_switch row, census_mem rpcIdx 2; no key text anywhere");
}

// ---- 6. the census with every endpoint exhausted: no exit, no hammering --------------------------------
{
  const a = await rejectServer(429);
  const b = await rejectServer(401);
  const env = cleanEnv({
    ROOT: tmp("census-alldown-root-"),
    RPC_URLS: `http://127.0.0.1:${a.address().port}/?api-key=FIXTUREKEY1,http://127.0.0.1:${b.address().port}/?api-key=FIXTUREKEY2`,
    RPC_FAILOVER_AFTER: "1",
    CENSUS_DIR: tmp("census-alldown-"),
  });
  const child = startCensus(env);
  let exited = null;
  child.done.then((c) => (exited = c));
  await wait(6000);
  const alive = exited === null;
  child.kill();
  await child.done;
  a.close();
  b.close();
  assert.ok(alive, `the census keeps running with every endpoint exhausted (exited ${exited}; stderr ${child.err.split(/\r?\n/)[0]})`);
  const loud = child.err.split(/\r?\n/).filter((l) => /ALL 2 RPC endpoint\(s\) exhausted/.test(l));
  assert.equal(loud.length, 1, `one loud line (got ${loud.length})`);
  assert.equal(a.upgrades + b.upgrades, 2, `then a retry every 60 s, not a tight loop (attempts ${a.upgrades}+${b.upgrades})`);
  assert.ok(!KEY_RE.test(child.out + child.err));
  ok("census, every endpoint exhausted: still running after 6 s, one loud line, no tight reconnect loop");
}

// ---- 7. the shadow lab with RPC_URLS (fixture stream + RPC mocks) -------------------------------------
{
  const jdir = tmp("shadow-failover-journal-");
  const env = cleanEnv({
    ROOT: tmp("shadow-failover-root-"),
    RPC_URL: "http://127.0.0.1:1/?api-key=FIXTUREKEY0",
    RPC_URLS: "http://127.0.0.1:1/?api-key=FIXTUREKEY1,https://mainnet.helius-rpc.com/?api-key=FIXTUREKEY2",
    RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
    WS_MOCK: path.join(here, "mocks", "ws-mock-shadow.mjs"),
    WS_MOCK_SCENARIO: "single",
    JOURNAL_DIR: jdir,
    SHADOW_MAX_SEC: "3",
    MIN_FILL: "92",
  });
  const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "shadow.mjs")], { cwd: root, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  const killer = setTimeout(() => child.kill(), 40_000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(killer);
  assert.equal(code, 0, `shadow exited 0 (stderr ${err.split(/\r?\n/)[0]})`);
  assert.match(out, /\[shadow\] rpc endpoints: #1 127\.0\.0\.1, #2 mainnet\.helius-rpc\.com/);
  assert.match(out, /\[shadow\] RPC_URLS is set: RPC_URL is ignored by this process/);
  const text = fs.readdirSync(jdir).map((f) => fs.readFileSync(path.join(jdir, f), "utf8")).join("");
  const rows = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const mem = rows.filter((r) => r.type === "gshadow_mem").at(-1);
  assert.ok(mem && mem.rpcIdx === 1 && mem.rpcSwitches === 0, `gshadow_mem rpcIdx / rpcSwitches (got ${JSON.stringify(mem && { rpcIdx: mem.rpcIdx, rpcSwitches: mem.rpcSwitches })})`);
  assert.ok(rows.some((r) => r.type === "gshadow_open"), "the lab still trades on the stream");
  assert.ok(!KEY_RE.test(out + err + text), "no key text in the shadow output or journal");
  // Bad list: loud stop, no key echoed.
  const bad = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "shadow.mjs")], { cwd: root, env: { ...env, RPC_URLS: "https://a.example/?api-key=FIXTUREKEY1,https://a.example/?api-key=FIXTUREKEY1" } });
  let berr = "";
  bad.stderr.on("data", (b) => (berr += String(b)));
  bad.stdout.on("data", (b) => (berr += String(b)));
  const bcode = await new Promise((r) => bad.on("exit", r));
  assert.equal(bcode, 1);
  assert.match(berr, /RPC_URLS item #2 duplicates item #1/);
  assert.ok(!KEY_RE.test(berr));
  // #20b: a bad websocket part stops both processes (exit 1), without the URL in the text.
  const badWs = "https://a.example/?api-key=FIXTUREKEY1|https://a.example/ws?api-key=FIXTUREKEY1";
  for (const [name, script] of [["shadow", path.join(root, "bots", "graduation-sniper", "shadow.mjs")], ["census", path.join(here, "mint-census.mjs")]]) {
    const c = spawn(process.execPath, [script], { cwd: root, env: { ...env, CENSUS_DIR: tmp("census-badws-"), RPC_URLS: badWs } });
    let t = "";
    c.stderr.on("data", (b) => (t += String(b)));
    c.stdout.on("data", (b) => (t += String(b)));
    const cc = await new Promise((r) => c.on("exit", r));
    assert.equal(cc, 1, `${name}: a bad ws part -> exit 1`);
    assert.match(t, /RPC_URLS item #1: the websocket part must start with ws:\/\/ or wss:\/\//, `${name}: ${t}`);
    assert.ok(!KEY_RE.test(t) && !/a\.example/.test(t), `${name}: no URL in the text: ${t}`);
  }
  ok("shadow: startup line lists #n host, gshadow_mem carries rpcIdx / rpcSwitches, a bad RPC_URLS (duplicate, bad ws part) stops shadow and census (exit 1); no key text");
}

// ---- 8. live and other bots ------------------------------------------------------------------------------
{
  const { rpcUrlsIgnoredWhy } = await import("../lib/config.mjs");
  assert.equal(rpcUrlsIgnoredWhy({ rpcUrls: "https://a.example", live: true, script: "/x/bots/graduation-sniper/shadow.mjs" }), "--live");
  assert.equal(rpcUrlsIgnoredWhy({ rpcUrls: "https://a.example", live: true, script: "/x/bots/graduation-sniper/graduation.mjs" }), "--live");
  assert.equal(rpcUrlsIgnoredWhy({ rpcUrls: "https://a.example", live: false, script: "/x/bots/sniper/sniper.mjs" }), "not the shadow lab / mint census");
  assert.equal(rpcUrlsIgnoredWhy({ rpcUrls: "https://a.example", live: false, script: "/x/scripts/mint-census.mjs" }), null);
  assert.equal(rpcUrlsIgnoredWhy({ rpcUrls: undefined, live: true, script: "/x/bots/graduation-sniper/graduation.mjs" }), null, "no RPC_URLS: nothing printed (the old path)");

  // Another process (a dry-run of any other entry point loading the config): one warning, no URL.
  const d = tmp("rpcurls-other-");
  const probe = path.join(d, "other-bot.mjs");
  fs.writeFileSync(probe, `await import(${JSON.stringify(new URL("../lib/config.mjs", import.meta.url).href)}); console.log("loaded");\n`);
  const child = spawn(process.execPath, [probe], { cwd: root, env: cleanEnv({ RPC_URLS: "https://a.example/?api-key=FIXTUREKEY1,https://b.example/?api-key=FIXTUREKEY2" }) });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (err += String(b)));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.match(out, /loaded/);
  assert.equal(err.match(/RPC_URLS is ignored by this process \(not the shadow lab \/ mint census\)/g)?.length, 1, `one warning (stderr: ${err})`);
  assert.ok(!KEY_RE.test(out + err));

  // Static: only the two research entry points install the failover; live bots never reference it.
  const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
  const HOOK = /rpc-failover\.mjs|useFailover|setRpcFailoverFetch/;
  for (const p of ["bots/graduation-sniper/graduation.mjs", "bots/sniper/sniper.mjs", "bots/copy-trader/watcher.mjs", "bots/basic-trader/trade.mjs", "lib/send.mjs", "lib/tx.mjs", "lib/amm-sell.mjs", "lib/pumpfun.mjs", "lib/fees.mjs"]) {
    if (fs.existsSync(path.join(root, p))) assert.ok(!HOOK.test(src(p)), `${p} does not touch the failover`);
  }
  assert.ok(HOOK.test(src("bots/graduation-sniper/shadow.mjs")) && HOOK.test(src("scripts/mint-census.mjs")));
  // Both opt-in hooks refuse --live in code (the live path cannot reach them).
  assert.match(src("lib/ws.mjs"), /useFailover\(fo\) \{\r?\n\s+if \(LIVE\) throw/);
  assert.match(src("lib/rpc.mjs"), /setRpcFailoverFetch\(fn\) \{\r?\n\s+if \(LIVE\) throw/);
  ok("live / other bots: RPC_URLS ignored with one warning; only shadow + census install the failover; both hooks throw under --live");
}

console.log("PASS: rpc-failover");
process.exit(0);
