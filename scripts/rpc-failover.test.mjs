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
//   9. #22: RPC_URLS as a multi-line array in .env (lib/config.mjs parseEnvText), stray URL lines.
//  10. #22 processes: the array from a real .env + a handshake 402 -> switch; a bad .env stops shadow /
//      census and only warns elsewhere. HTTP 402 is in section 3.
//  11. #23: "unreachable" (no connect 60 s, eligible again after RPC_FAILOVER_UNREACH_MIN) vs
//      "exhausted" (limit signal, 60 min); the network-down line; rpc_switch diagnostics (state,
//      lastClose, lastError, attempts) without key text; the ws disconnect line with the close code.
//  12. #23 point 4: thin stream (CENSUS_THIN_GAPS gaps in 10 min -> state "thin"), fake clock.
//  13. #23 point 4 in the census process: a mock endpoint with a gap every 2.5 s -> switch.
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
  assert.equal(F.wsErrorReason(new Error("Unexpected server response: 402")), "ws-handshake-402", "#22: 402 Payment Required = exhausted");
  assert.equal(F.httpReason(402, ""), "http-402", "#22: an HTTP RPC call answered 402");
  assert.match(F.httpReason(402, '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Payment required"},"id":1}'), /^http-402/);
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
  ok("exhaustion signals: 401/402/403/429; Helius / Alchemy / QuickNode documented codes and messages; generic limit words; 503 / refused / Solana -32005 node-unhealthy / other errors are not");
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
  assert.deepEqual({ ...rows[0], at: undefined }, { type: "rpc_switch", fromIdx: 1, toIdx: 2, host: "h2.example", reason: "http:http-429", failures: 3, at: undefined, state: "exhausted", lastClose: null, lastError: null, attempts: 0 });
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
  // #22: HTTP 402 (payment required) on an RPC call counts the same way.
  const h4 = await rpcServer((j, res) => reply(res, 402, { jsonrpc: "2.0", error: { code: -32000, message: "Payment required" }, id: j.id }));
  const rows4 = [];
  const fo4 = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`http://127.0.0.1:${h4.address().port}/?api-key=FIXTUREKEYH4,${u2}`) });
  fo4.onSwitch((r) => rows4.push(r));
  setRpcFailoverFetch(F.makeFailoverFetch(fo4, { timeoutMs: 5000 }));
  for (let i = 0; i < 3; i++) await assert.rejects(connection.getBalance(pk));
  assert.equal(fo4.idx, 2, "3 x HTTP 402 -> #2");
  assert.equal(await connection.getBalance(pk), 7_000_000_000);
  assert.match(rows4[0].reason, /^http:http-402/);
  assert.ok(!KEY_RE.test(JSON.stringify(rows4)));
  for (const s of [h1, h2, h3, h4]) s.close();
  ok('HTTP: "max usage reached" (and 429 / -32005, and 402) on #1 three times -> the next call goes to #2 with its own URL');
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
  const rpcErrs = [];
  ws.onRpcError = (e) => rpcErrs.push(e.code); // #23 observer (census rpcLimitErrors)
  ws.subscribeLogs("Prog1111111111111111111111111111111111111111", (r) => got.push(r.value.signature));
  await ws.connect();
  const t0 = Date.now();
  while (got.length < 5 && Date.now() - t0 < 10_000) await wait(50);
  assert.equal(w1.subs, 3, `#1 rejected the subscribe 3 times (got ${w1.subs})`);
  assert.deepEqual(rpcErrs, [-32429, -32429, -32429], "#23: onRpcError sees every error answer, the failover still acts on them");
  assert.equal(fo.idx, 2);
  assert.equal(w2.subs, 1, "resubscribed on #2");
  assert.deepEqual(got, ["sig-1", "sig-2", "sig-3", "sig-4", "sig-5"], "events flow from #2");
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /^ws:rpc-error -32429 max usage reached$/);
  // #23: the socket of #1 is terminated AFTER the switch; its close belongs to #1, not to #2.
  assert.equal(fo.st[0].lastClose?.code, 1006, `#1 keeps its own close (got ${JSON.stringify(fo.st[0].lastClose)})`);
  assert.equal(fo.st[1].lastClose, null, "#2 is not blamed for #1's close");
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
    sock.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || "Error"}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n`);
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
      // census rev 2 also subscribes the migrated mint's PumpSwap pool: acknowledged, no feed
      if (m.params?.[0]?.mentions?.[0] !== "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") {
        sock.send(JSON.stringify({ jsonrpc: "2.0", result: 92, id: m.id }));
        return;
      }
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
  const { ts: _ts, at, state, lastClose, lastError, attempts, ...swRest } = sw[0];
  assert.deepEqual(swRest, { type: "rpc_switch", fromIdx: 1, toIdx: 2, host: "127.0.0.1", reason: "ws:ws-handshake-429", failures: 3 });
  assert.ok(Number.isFinite(Date.parse(at)), "at is an ISO time");
  // #23 diagnostics: a limit status is "exhausted"; the socket's last close / error, attempts in the window.
  assert.equal(state, "exhausted");
  assert.equal(lastClose?.code, 1006, `the rejected handshake closes 1006 (got ${JSON.stringify(lastClose)})`);
  assert.match(lastError, /Unexpected server response: 429/);
  assert.equal(attempts, 3);
  assert.ok(rows.some((r) => r.type === "census_mint" && r.mint === W.MIG_MINT && r.migrated === true), "events flowed from #2 (the migrated mint row)");
  const mem = rows.filter((r) => r.type === "census_mem").at(-1);
  assert.equal(mem.rpcIdx, 2);
  assert.equal(mem.rpcSwitches, 1);
  assert.equal(mem.rpcUnreachable, 0, "#23: census_mem rpcUnreachable (a 429 switch is not one)");
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
  assert.ok(mem && mem.rpcIdx === 1 && mem.rpcSwitches === 0 && mem.rpcUnreachable === 0, `gshadow_mem rpcIdx / rpcSwitches / rpcUnreachable (#23) (got ${JSON.stringify(mem && { rpcIdx: mem.rpcIdx, rpcSwitches: mem.rpcSwitches, rpcUnreachable: mem.rpcUnreachable })})`);
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

// ---- 9. #22: RPC_URLS as a multi-line array in .env; stray URL lines; handshake 402 ----------------
{
  const Cfg = await import("../lib/config.mjs");
  const K = (s) => `https://${s}.example/?api-key=FIXTUREKEY${s}`;
  const comma = `${K("a")},${K("b")}|wss://b-ws.example/FIXTUREKEYb,${K("d")}`;
  // (a) 3 items: plain; http|ws with a trailing comma; a commented-out key, a blank line, an inline comment; CRLF
  const arrText = [
    "RPC_URL=http://127.0.0.1:1/?api-key=FIXTUREKEY0",
    "RPC_URLS=[   # keys, one per line",
    `  ${K("a")}`,
    `  ${K("b")}|wss://b-ws.example/FIXTUREKEYb,`,
    `  # ${K("c")}`,
    "",
    `  ${K("d")}, # the last one`,
    "]",
    "SHADOW_MAX_SEC=3 # after the array",
  ].join("\r\n");
  const p = Cfg.parseEnvText(arrText);
  assert.deepEqual(p.issues, []);
  const val = Object.fromEntries(p.vars);
  assert.equal(val.RPC_URLS, comma, "the array joins into the comma form");
  assert.equal(val.SHADOW_MAX_SEC, "3", "the line after ']' is read as before");
  assert.equal(val.RPC_URL, "http://127.0.0.1:1/?api-key=FIXTUREKEY0");
  assert.deepEqual(F.parseRpcUrlList(val.RPC_URLS), F.parseRpcUrlList(comma), "the same endpoints as the comma form");
  assert.equal(F.parseRpcUrlList(val.RPC_URLS).length, 3);
  // (b) the single-line form and every other line: exactly parseEnvLine, as before #22
  const plain = [`RPC_URLS=${comma} # inline`, "MIN_FILL=92 # alias", "# comment", "", 'NAME="a # b"', "lower=1", "  SPACED = 5  "];
  assert.deepEqual(Cfg.parseEnvText(plain.join("\n")).vars, plain.map(Cfg.parseEnvLine).filter(Boolean));
  assert.equal(Object.fromEntries(Cfg.parseEnvText(plain.join("\n")).vars).RPC_URLS, comma);
  // only RPC_URLS opens an array: another NAME=[ stays the literal value "["
  assert.deepEqual(Cfg.parseEnvText("OTHER=[\n]").vars, [["OTHER", "["]]);
  // (c) a missing "]": at the end of the file, or before the next NAME= line (which is still read)
  const open1 = Cfg.parseEnvText(["RPC_URL=http://x.example", "RPC_URLS=[", `  ${K("a")}`, `  ${K("b")}`].join("\n"));
  assert.deepEqual(open1.issues, [{ kind: "unclosedArray", name: "RPC_URLS", line: 2 }]);
  assert.ok(!open1.vars.some(([k]) => k === "RPC_URLS"), "RPC_URLS is not set from an unclosed array");
  const open2 = Cfg.parseEnvText(["RPC_URLS=[", `  ${K("a")}`, "MIN_FILL=92"].join("\n"));
  assert.deepEqual(open2.issues, [{ kind: "unclosedArray", name: "RPC_URLS", line: 1 }]);
  assert.deepEqual(open2.vars, [["MIN_FILL", "92"]]);
  // (d) a URL continued on a new line outside an array (silently lost before #22)
  const stray = Cfg.parseEnvText([`RPC_URLS=${K("a")},`, `  ${K("b")}`, "wss://w.example/FIXTUREKEYw", "# https://commented.example"].join("\n"));
  assert.deepEqual(stray.issues, [{ kind: "strayUrl", line: 2 }, { kind: "strayUrl", line: 3 }]);
  for (const x of [...open1.issues, ...stray.issues]) assert.ok(!KEY_RE.test(Cfg.envIssueText(x)) && !/example/.test(Cfg.envIssueText(x)), Cfg.envIssueText(x));
  assert.match(Cfg.envIssueText(stray.issues[0]), /^line 2 of \.env looks like a URL without NAME=/);
  ok("#22 .env array: 3 items (plain, http|ws + trailing comma, comment / blank / inline comment, CRLF) = the comma form; single-line form and other lines unchanged; missing ']' and stray URL lines found by line number, no key text");
}

// ---- 10. #22 processes: the array from a real .env, ws handshake 402 -> switch; bad .env -> stop / warn --
{
  const r1 = await rejectServer(402);
  const { wss: r2, W } = await censusFeedServer();
  const root9 = tmp("census-array-root-");
  const dir = tmp("census-array-");
  fs.writeFileSync(
    path.join(root9, ".env"),
    [
      "RPC_URL=http://127.0.0.1:1/?api-key=FIXTUREKEY0",
      "RPC_URLS=[",
      `  http://127.0.0.1:${r1.address().port}/?api-key=FIXTUREKEY1   # answers 402`,
      "  # http://127.0.0.1:1/?api-key=FIXTUREKEYoff",
      `  http://127.0.0.1:${r2.address().port}/?api-key=FIXTUREKEY2,`,
      "]",
    ].join("\n"),
  );
  const env = cleanEnv({ ROOT: root9, CENSUS_DIR: dir, CENSUS_MAX_SEC: "4" });
  delete env.RPC_URL; // only the .env
  const child = startCensus(env);
  const killer = setTimeout(() => child.kill(), 40_000);
  const code = await child.done;
  clearTimeout(killer);
  r1.close();
  r2.close();
  assert.equal(code, 0, `census exited 0 (stderr: ${child.err.split(/\r?\n/).slice(0, 3).join(" | ")})`);
  assert.match(child.out, /rpc endpoints: #1 127\.0\.0\.1, #2 127\.0\.0\.1 \|/, "two endpoints from the .env array (the commented one skipped)");
  assert.equal(r1.upgrades, 3, `3 handshakes answered 402 (got ${r1.upgrades})`);
  assert.match(child.err, /endpoint #1 127\.0\.0\.1 exhausted \(ws:ws-handshake-402, 3 failure\(s\)\) -> switching to #2/);
  const text = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  const rows = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.type === "rpc_switch")?.reason, "ws:ws-handshake-402");
  assert.ok(rows.some((r) => r.type === "census_mint" && r.mint === W.MIG_MINT), "events flowed from #2");
  assert.ok(!KEY_RE.test(child.out + child.err + text), "no key text");

  // A bad .env: the research processes stop at the start, every other process warns once.
  const bads = {
    unclosed: { lines: ["RPC_URL=http://127.0.0.1:1/?api-key=FIXTUREKEY0", "RPC_URLS=[", "  https://a.example/?api-key=FIXTUREKEY1", "  https://b.example/?api-key=FIXTUREKEY2"], re: /RPC_URLS=\[ at line 2 of \.env has no closing "\]" line/ },
    stray: { lines: ["RPC_URL=http://127.0.0.1:1/?api-key=FIXTUREKEY0", "RPC_URLS=https://a.example/?api-key=FIXTUREKEY1,", "https://b.example/?api-key=FIXTUREKEY2"], re: /line 3 of \.env looks like a URL without NAME=/ },
  };
  const run = (script, envRoot, extra = {}) =>
    new Promise((resolve) => {
      const e = cleanEnv({ ROOT: envRoot, CENSUS_DIR: tmp("census-badenv-"), ...extra });
      delete e.RPC_URL;
      const c = spawn(process.execPath, [script], { cwd: root, env: e });
      let t = "";
      c.stdout.on("data", (b) => (t += String(b)));
      c.stderr.on("data", (b) => (t += String(b)));
      c.on("exit", (code) => resolve({ code, t }));
    });
  const probeDir = tmp("rpcurls-other22-");
  const probe = path.join(probeDir, "other-bot.mjs");
  fs.writeFileSync(probe, `await import(${JSON.stringify(new URL("../lib/config.mjs", import.meta.url).href)}); console.log("loaded");\n`);
  for (const [name, b] of Object.entries(bads)) {
    const r = tmp(`badenv-${name}-`);
    fs.writeFileSync(path.join(r, ".env"), b.lines.join("\n"));
    for (const [who, script] of [["census", path.join(here, "mint-census.mjs")], ["shadow", path.join(root, "bots", "graduation-sniper", "shadow.mjs")]]) {
      const res = await run(script, r);
      assert.equal(res.code, 1, `${name}: ${who} stops (exit ${res.code}: ${res.t.slice(0, 200)})`);
      assert.match(res.t, b.re, `${name}: ${who} names the line`);
      assert.ok(!KEY_RE.test(res.t) && !/a\.example|b\.example/.test(res.t), `${name}: ${who}: no URL / key in the text`);
    }
    const other = await run(probe, r);
    assert.equal(other.code, 0, `${name}: another process goes on`);
    assert.match(other.t, /loaded/);
    assert.equal(other.t.match(/\[config\] warning: (RPC_URLS=\[ at|line \d+ of \.env)/g)?.length, 1, `${name}: one .env warning (${other.t})`);
    assert.match(other.t, b.re);
    assert.ok(!KEY_RE.test(other.t));
  }
  ok("#22 processes: census reads RPC_URLS from a .env array, #1 answers the handshake 402 x3 -> #2, rows flow; unclosed array / stray URL line -> census and shadow exit 1 naming the line, another process warns once; no key text");
}

// ---- 11. #23: unreachable vs exhausted, network-down line, close codes ------------------------------
// One no-connect window on the current endpoint: an attempt, then another one 61 s later.
const noConnect = (m) => {
  m.fo.beforeWsAttempt();
  m.adv(61_000);
  m.fo.beforeWsAttempt();
};
const loudLines = (logs) => logs.filter(([lv]) => lv === "error").map(([, m]) => m);
{
  // (a) no-connect-60s -> "unreachable": eligible again after 2 min (not after the 60 min cooldown).
  const a = mk(2);
  noConnect(a); // #1 unreachable -> #2
  assert.equal(a.fo.idx, 2);
  assert.equal(a.rows[0].state, "unreachable");
  assert.equal(a.rows[0].reason, "ws:no-connect-60s");
  assert.equal(a.fo.stats().rpcUnreachable, 1);
  assert.equal(a.fo.stats().rpcSwitches, 1);
  const warn = a.logs.find(([lv]) => lv === "warn")[1];
  assert.match(warn, /^\[rpc\] endpoint #1 h1\.example unreachable \(ws:no-connect-60s, 1 connect attempt\(s\), last close none\) -> switching to #2 h2\.example$/);
  assert.ok(!/exhausted/.test(warn), "the switch line does not call it exhausted");
  a.adv(60_000); // #1 unreachable 60 s ago
  for (let i = 0; i < 3; i++) a.fo.fail("ws", "ws-handshake-402"); // #2 out of credits
  assert.equal(a.fo.allDown, true, "1 min after: #1 is not eligible yet");

  const b = mk(2);
  noConnect(b);
  b.adv(121_000); // #1 unreachable 2 min 1 s ago
  for (let i = 0; i < 3; i++) b.fo.fail("ws", "ws-handshake-402");
  assert.equal(b.fo.allDown, false, "2 min after: #1 is eligible again (the 60 min cooldown would block it)");
  assert.equal(b.fo.idx, 1);
  assert.equal(b.rows.at(-1).state, "exhausted", "the 402 switch is an exhaustion");
  assert.equal(b.fo.stats().rpcUnreachable, 1);

  // RPC_FAILOVER_UNREACH_MIN: default 2, range 0..60, in the startup line.
  const env = { RPC_URLS: "https://a.example/?api-key=FIXTUREKEY1,https://b.example/?api-key=FIXTUREKEY2" };
  const d = F.setupFailover({ env });
  assert.equal(d.failover.unreachMs, 120_000);
  assert.match(d.lines.join("\n"), /cooldown 60 min \(exhausted\), 2 min \(unreachable\)/);
  assert.equal(F.setupFailover({ env: { ...env, RPC_FAILOVER_UNREACH_MIN: "0" } }).failover.unreachMs, 0);
  assert.equal(F.setupFailover({ env: { ...env, RPC_FAILOVER_UNREACH_MIN: "60" } }).failover.unreachMs, 3_600_000);
  assert.throws(() => F.setupFailover({ env: { ...env, RPC_FAILOVER_UNREACH_MIN: "61" } }), /RPC_FAILOVER_UNREACH_MIN must be a number in 0\.\.60/);
  ok("#23 no-connect-60s -> state unreachable, eligible again after 2 min (not 1 min, not 60); RPC_FAILOVER_UNREACH_MIN default 2, 0..60");
}
{
  // (b) 402 x3 -> exhausted, still blocked at 59 min, eligible at 61 min (unchanged).
  const a = mk(2);
  for (let i = 0; i < 3; i++) a.fo.fail("ws", "ws-handshake-402");
  assert.equal(a.rows[0].state, "exhausted");
  assert.equal(a.fo.stats().rpcUnreachable, 0);
  a.adv(59 * 60_000);
  for (let i = 0; i < 3; i++) a.fo.fail("ws", "ws-handshake-402");
  assert.equal(a.fo.allDown, true, "59 min: #1 still exhausted");
  const b = mk(2);
  for (let i = 0; i < 3; i++) b.fo.fail("ws", "ws-handshake-402");
  b.adv(61 * 60_000);
  for (let i = 0; i < 3; i++) b.fo.fail("ws", "ws-handshake-402");
  assert.equal(b.fo.allDown, false);
  assert.equal(b.fo.idx, 1, "61 min: back to #1");
  ok("#23 402 x3 -> still exhausted for 60 min (unchanged)");
}
{
  // (c1) every endpoint unreachable, 2 endpoints (all-down mode): the network-down line, no "add a key".
  const a = mk(2);
  noConnect(a); // #1 at +61 s
  a.adv(61_000);
  a.fo.beforeWsAttempt(); // #2 at +122 s: #1 only 61 s ago -> all down
  assert.equal(a.fo.allDown, true);
  const loud = loudLines(a.logs);
  assert.deepEqual(loud, ["[rpc] no endpoint reachable for 122 s (all 2 unreachable, none out of credits): the network of this device is likely down; retrying every 60 s"]);
  assert.ok(!/add a key|exhausted/i.test(loud.join("\n")));
  assert.match(a.rows.at(-1).reason, /^all-unreachable ws:no-connect-60s$/, "the 60 s probe row");
  assert.equal(a.rows.at(-1).state, "unreachable");
  assert.equal(a.fo.reconnectDelay(1000), 60_000, "retrying every 60 s");
  a.fo.wsHealthy();
  assert.ok(a.logs.some(([lv, m]) => lv === "warn" && /answers again: failover recovered/.test(m)), "recovery line as today");

  // (c2) 4 endpoints: still cycling (each eligible again after 2 min) -> the line is logged too, once per 10 min.
  const c = mk(4);
  c.fo.beforeWsAttempt();
  for (let k = 0; k < 8; k++) {
    c.adv(61_000);
    c.fo.beforeWsAttempt();
  }
  assert.equal(c.fo.allDown, false, "4 keys, 61 s each: one is always eligible again");
  assert.equal(c.rows.length, 8);
  assert.ok(c.rows.every((r) => r.state === "unreachable"));
  assert.equal(c.fo.stats().rpcUnreachable, 8);
  const loud4 = loudLines(c.logs);
  assert.equal(loud4.length, 1, `one loud line in 8 min (got ${loud4.length})`);
  assert.match(loud4[0], /^\[rpc\] no endpoint reachable for 244 s \(all 4 unreachable, none out of credits\): the network of this device is likely down/);
  c.fo.wsHealthy();
  assert.ok(c.logs.some(([lv, m]) => lv === "warn" && /answers again: failover recovered/.test(m)), "recovery line after the network-down line");

  // (c3) one exhausted + the rest unreachable -> the old "ALL ... exhausted ... add a key" line.
  const e = mk(3);
  e.fo.beforeWsAttempt();
  for (let i = 0; i < 3; i++) e.fo.fail("ws", "ws-handshake-402"); // #1 exhausted -> #2
  e.adv(61_000);
  e.fo.beforeWsAttempt(); // #2 unreachable -> #3
  e.adv(61_000);
  e.fo.beforeWsAttempt(); // #3 unreachable: #1 cooling, #2 61 s ago -> all down
  assert.equal(e.fo.allDown, true);
  const loudE = loudLines(e.logs);
  assert.equal(loudE.length, 1);
  assert.match(loudE[0], /^\[rpc\] ALL 3 RPC endpoint\(s\) exhausted \(last: ws:no-connect-60s\)\..*Add a key to RPC_URLS/);
  assert.ok(!/network/.test(loudE[0]));
  assert.match(e.rows.at(-1).reason, /^all-exhausted /);
  ok("#23 all unreachable -> network-down line (all-down and cycling), no 'add a key'; one exhausted + rest unreachable -> the old line; recovery line");
}
{
  // (d) rpc_switch diagnostics from the controller hooks: scrubbed, per endpoint, fresh per window.
  const a = mk(2);
  a.fo.beforeWsAttempt();
  a.fo.wsError(new Error("connect ETIMEDOUT https://h1.example/?api-key=FIXTUREKEY1 now"), 1);
  a.fo.wsClosed(1006, Buffer.from(""), 1);
  a.fo.beforeWsAttempt();
  a.fo.wsClosed(4000, Buffer.from("bye wss://h1.example/?api-key=FIXTUREKEY1"), 1);
  a.adv(61_000);
  a.fo.beforeWsAttempt();
  const r = a.rows[0];
  assert.deepEqual({ state: r.state, lastClose: r.lastClose, lastError: r.lastError, attempts: r.attempts }, { state: "unreachable", lastClose: { code: 4000, reason: "bye <url>" }, lastError: "connect ETIMEDOUT <url> now", attempts: 2 });
  assert.ok(!KEY_RE.test(JSON.stringify(a.rows) + JSON.stringify(a.logs)), "no key text in rows / lines");
  assert.match(a.logs.find(([lv]) => lv === "warn")[1], /unreachable \(ws:no-connect-60s, 2 connect attempt\(s\), last close 4000 bye <url>, last error: connect ETIMEDOUT <url> now\)/);
  // A late close of the old socket is recorded for the endpoint it belongs to, not the new one.
  a.fo.wsClosed(1006, "", 1);
  a.adv(61_000);
  a.fo.beforeWsAttempt();
  assert.deepEqual([a.rows[1].fromIdx, a.rows[1].lastClose, a.rows[1].lastError, a.rows[1].attempts], [2, null, null, 1], "#2's own window: nothing of #1's socket");
  ok("#23 rpc_switch row: state / lastClose {code, reason} / lastError / attempts, scrubbed, per endpoint");
}
{
  // (e) real sockets: #1 accepts TCP but kills every upgrade (key in the path), #2 serves. With a short
  // no-connect window the census-style socket moves to #2; the row and every line are key-free.
  const { log: wsLog } = await import("../lib/logger.mjs");
  const lines = [];
  const origWarn = wsLog.warn;
  wsLog.warn = (...a) => {
    lines.push(a.join(" "));
    origWarn(...a);
  };
  const dead = http.createServer((_req, res) => res.end());
  dead.upgrades = 0;
  dead.on("upgrade", (_req, sock) => {
    dead.upgrades += 1;
    sock.destroy();
  });
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const w2 = await wsServer();
  const fl = [];
  const fo = new F.RpcFailover({ endpoints: F.parseRpcUrlList(`http://127.0.0.1:${dead.address().port}/FIXTUREKEYD1/,http://127.0.0.1:${w2.address().port}/FIXTUREKEYD2/`), noConnectMs: 1500, log: (lv, m) => fl.push([lv, m]) });
  const rows = [];
  fo.onSwitch((r) => rows.push(r));
  const { SolanaWs } = await import("../lib/ws.mjs");
  const ws = new SolanaWs("ws://127.0.0.1:1");
  ws.baseReconnectMs = 100;
  ws.maxReconnectMs = 300;
  ws.useFailover(fo);
  const got = [];
  ws.subscribeLogs("Prog1111111111111111111111111111111111111111", (r) => got.push(r.value.signature));
  await ws.connect();
  const t0 = Date.now();
  while (got.length < 5 && Date.now() - t0 < 15_000) await wait(50);
  await ws.close();
  wsLog.warn = origWarn;
  dead.close();
  w2.close();
  assert.equal(got.length, 5, "events flow from #2");
  assert.ok(dead.upgrades >= 2, `#1 was retried in its window (upgrades ${dead.upgrades})`);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.state, "unreachable");
  assert.equal(r.reason, "ws:no-connect-60s");
  assert.equal(r.lastClose?.code, 1006, `a dead upgrade closes 1006 (got ${JSON.stringify(r.lastClose)})`);
  assert.equal(typeof r.lastError, "string");
  assert.ok(r.attempts >= 2 && r.attempts === dead.upgrades, `attempts ${r.attempts} = upgrades ${dead.upgrades}`);
  const disc = lines.filter((l) => /^\[ws\] disconnected/.test(l));
  assert.ok(disc.length >= 2 && disc.every((l) => /^\[ws\] disconnected \(code 1006\), reconnecting in \d+ms \(attempt \d+\)$/.test(l)), disc.join(" | "));
  assert.ok(!KEY_RE.test(JSON.stringify(rows) + lines.join("\n") + JSON.stringify(fl)), "no key text in the row or any line");
  ok("#23 real sockets: #1 kills every upgrade -> unreachable after the window, row lastClose 1006 / lastError / attempts, '[ws] disconnected (code 1006)', no key text");
}
{
  // (f) lib/ws.mjs disconnect line: with failover the code and scrubbed reason; without, as before.
  const { log: wsLog } = await import("../lib/logger.mjs");
  const { SolanaWs } = await import("../lib/ws.mjs");
  const closer = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
  closer.on("connection", (sock) => sock.close(4001, "bye https://x.example/?api-key=FIXTUREKEYz"));
  await new Promise((r) => closer.on("listening", r));
  const port = closer.address().port;
  const capture = async (mkWs) => {
    const lines = [];
    const origWarn = wsLog.warn;
    wsLog.warn = (...a) => lines.push(a.join(" "));
    const ws = mkWs();
    await ws.connect();
    const t0 = Date.now();
    while (!lines.some((l) => /^\[ws\] disconnected/.test(l)) && Date.now() - t0 < 5000) await wait(20);
    await ws.close();
    wsLog.warn = origWarn;
    return lines.find((l) => /^\[ws\] disconnected/.test(l));
  };
  const plainLine = await capture(() => new SolanaWs(`ws://127.0.0.1:${port}`));
  assert.match(plainLine, /^\[ws\] disconnected, reconnecting in \d+ms \(attempt 1\)$/, `without failover: the old line (${plainLine})`);
  const foLine = await capture(() => new SolanaWs("ws://127.0.0.1:1").useFailover(new F.RpcFailover({ endpoints: F.parseRpcUrlList(`http://127.0.0.1:${port}/?api-key=FIXTUREKEYc`) })));
  assert.match(foLine, /^\[ws\] disconnected \(code 4001, bye <url>\), reconnecting in \d+ms \(attempt 1\)$/, `with failover: code + reason (${foLine})`);
  assert.ok(!KEY_RE.test(foLine));
  closer.close();
  ok("#23 ws disconnect line: '(code 4001, bye <url>)' with failover; byte-for-byte the old line without");
}

// ---- 12. #23 point 4: thin stream (census) -----------------------------------------------------------
{
  const MIN = 60_000;
  // Fake clock: gap [start, end] closes at `end`; the detector + the failover share the clock.
  const thinSetup = (n = 2) => {
    const m = mk(n);
    const det = F.createThinStreamDetector({ gaps: 3 });
    m.fo.onSwitch(() => det.noteSwitch(m.now()));
    const gap = (lenMs = 12_000) => {
      const start = m.now();
      m.adv(lenMs);
      const v = det.noteGap(start, m.now());
      if (v) m.fo.thin(v);
      return v;
    };
    return { ...m, det, gap };
  };
  // (a) 3 gaps within 10 min -> switch, state thin, loud line, short cooldown.
  const a = thinSetup(2);
  a.fo.wsHealthy(); // the socket is "healthy" all along
  assert.equal(a.gap(), null);
  a.adv(3 * MIN);
  assert.equal(a.gap(), null);
  a.adv(3 * MIN);
  assert.deepEqual(a.gap(), { k: 3, windowMin: 10 }, "3rd gap within 10 min: thin");
  assert.equal(a.fo.idx, 2);
  assert.equal(a.rows.length, 1);
  const { at: _a, ...row } = a.rows[0];
  assert.deepEqual(row, { type: "rpc_switch", fromIdx: 1, toIdx: 2, host: "h2.example", reason: "census:thin-stream", failures: 0, state: "thin", lastClose: null, lastError: null, attempts: 0, thinGaps: 3 });
  assert.deepEqual(loudLines(a.logs), ["[rpc] endpoint #1 h1.example gives a thin stream (3 gaps in 10 min): switching to #2 h2.example"]);
  assert.equal(a.fo.stats().rpcThin, 1);
  assert.equal(a.fo.stats().rpcUnreachable, 0);
  a.adv(2 * MIN + 1000);
  for (let i = 0; i < 3; i++) a.fo.fail("ws", "ws-handshake-402");
  assert.equal(a.fo.idx, 1, "a thin endpoint is eligible again after RPC_FAILOVER_UNREACH_MIN (2), like unreachable");
  assert.equal(a.fo.allDown, false);

  // (b) 2 gaps -> no switch; 3 gaps spread over > 10 min -> no switch.
  const b = thinSetup(2);
  b.gap();
  b.adv(MIN);
  b.gap();
  b.adv(9 * MIN);
  assert.equal(b.fo.idx, 1, "2 gaps: no switch");
  b.gap(); // the first one closed > 10 min ago
  assert.equal(b.fo.idx, 1, "3 gaps over 10 min 12 s: no switch");
  assert.equal(b.rows.length, 0);

  // (c) gaps right after a census_stall -> no switch; a stall also drops the gaps counted before it.
  const c = thinSetup(2);
  c.gap();
  c.gap();
  c.det.noteStall(c.now()); // the phone slept
  for (let i = 0; i < 4; i++) {
    c.gap();
    c.adv(MIN);
  }
  assert.equal(c.fo.idx, 1, "gaps within 10 min after a stall: no switch");
  assert.equal(c.det.counted, 0);
  c.adv(6 * MIN); // > 10 min since the stall
  c.gap();
  c.gap();
  c.gap();
  assert.equal(c.fo.idx, 2, "10 min after the stall the detector counts again");

  // (d) a gap that started before the last switch (the switch's own silence) is not the new endpoint's.
  const d = thinSetup(3);
  d.gap();
  d.gap();
  d.gap(); // #1 thin -> #2 at t
  assert.equal(d.fo.idx, 2);
  const tSwitch = d.now();
  assert.equal(d.det.noteGap(tSwitch - 5000, tSwitch + 3000), null);
  assert.equal(d.det.counted, 0, "started before the switch: not counted");
  d.gap();
  d.gap();
  assert.equal(d.fo.idx, 2, "2 own gaps on #2: no switch yet");

  // (e) every endpoint thin (none out of credits) -> its own loud line, never "add a key" / "network".
  const e = thinSetup(2);
  for (let i = 0; i < 3; i++) e.gap(); // #1 thin -> #2
  for (let i = 0; i < 3; i++) e.gap(); // #2 thin, #1 still in its 2 min -> all down
  assert.equal(e.fo.allDown, true);
  const le = loudLines(e.logs);
  assert.match(le.at(-1), /^\[rpc\] no endpoint gives a full stream \(2 thin, 0 unreachable, none out of credits\); retrying/);
  assert.ok(!/add a key|network/i.test(le.join("\n")), le.join(" | "));
  assert.match(e.rows.at(-1).reason, /^all-down census:thin-stream$/);

  // (f) knobs and the plan-limit counter classification.
  assert.equal(F.thinGapsFromEnv({}), 3);
  assert.equal(F.thinGapsFromEnv({ CENSUS_THIN_GAPS: "0" }), 0);
  assert.throws(() => F.thinGapsFromEnv({ CENSUS_THIN_GAPS: "x" }), /CENSUS_THIN_GAPS must be a number in 0\.\.100/);
  const off = F.createThinStreamDetector({ gaps: 0 });
  for (let i = 0; i < 5; i++) assert.equal(off.noteGap(i * 1000, i * 1000 + 500), null, "0 = off");
  assert.ok(F.isLimitError({ code: -32005, message: "You've exceeded the RPS limit available on the current plan" }));
  assert.equal(F.limitErrorKey({ code: -32005, message: "x" }), "-32005");
  assert.ok(F.isLimitError({ message: "Concurrent websocket subscription limit reached: 1" }));
  assert.equal(F.limitErrorKey({ message: "Concurrent websocket subscription limit reached: 1" }), "?");
  assert.ok(F.isLimitError({ code: -32602, message: "too many subscriptions on this connection" }));
  assert.ok(!F.isLimitError({ code: -32602, message: "Invalid param: WrongSize" }));
  assert.ok(!F.isLimitError({ code: -32005, message: "Node is behind by 42 slots" }));
  ok("#23 thin stream: 3 gaps in 10 min -> switch (state thin, census:thin-stream, loud line, 2 min cooldown); 2 gaps / > 10 min -> none; gaps after a stall -> none; a switch's own gap not counted; all thin -> own line; CENSUS_THIN_GAPS; limit-error classification");
}

// ---- 13. #23 point 4 in the census process: a thin endpoint -> switch; rpcThin / rpcLimitErrors -------
{
  // #1 serves the pump stream with 2.5 s pauses (CENSUS_GAP_SEC=1 -> a gap per pause), #2 the full feed.
  async function thinFeedServer(pauseMs) {
    const W = await import("./mocks/ws-mock-census.mjs");
    const wss = new WebSocket.Server({ port: 0, host: "127.0.0.1" });
    wss.subs = 0;
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.method !== "logsSubscribe") return;
        if (m.params?.[0]?.mentions?.[0] !== "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") {
          sock.send(JSON.stringify({ jsonrpc: "2.0", result: 92, id: m.id }));
          return;
        }
        wss.subs += 1;
        sock.send(JSON.stringify({ jsonrpc: "2.0", result: 91, id: m.id }));
        (async () => {
          for (const n of W.buildNotifications()) {
            if (sock.readyState !== WebSocket.OPEN) return;
            sock.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 91, result: n.payload() } }));
            await wait(pauseMs);
          }
        })();
      });
    });
    await new Promise((r) => wss.on("listening", r));
    return wss;
  }
  const r1 = await thinFeedServer(2500);
  const { wss: r2 } = await censusFeedServer();
  const dir = tmp("census-thin-");
  const env = cleanEnv({
    ROOT: tmp("census-thin-root-"),
    RPC_URLS: `http://127.0.0.1:${r1.address().port}/FIXTUREKEYT1/,http://127.0.0.1:${r2.address().port}/FIXTUREKEYT2/`,
    CENSUS_DIR: dir,
    CENSUS_GAP_SEC: "1",
    CENSUS_MAX_SEC: "16",
  });
  const child = startCensus(env);
  const killer = setTimeout(() => child.kill(), 60_000);
  const code = await child.done;
  clearTimeout(killer);
  r1.close();
  r2.close();
  assert.equal(code, 0, `census exited 0 (stderr: ${child.err.split(/\r?\n/).slice(0, 3).join(" | ")})`);
  assert.match(child.out, /thin stream: 3 gaps in 10 min on one endpoint -> switch/);
  assert.match(child.err, /\[rpc\] endpoint #1 127\.0\.0\.1 gives a thin stream \(3 gaps in 10 min\): switching to #2 127\.0\.0\.1/);
  assert.equal(r2.subs, 1, "resubscribed on #2");
  const rows = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("").trim().split("\n").map((l) => JSON.parse(l));
  const sw = rows.filter((r) => r.type === "rpc_switch");
  assert.equal(sw.length, 1, `one switch (got ${JSON.stringify(sw)})`);
  assert.equal(sw[0].reason, "census:thin-stream");
  assert.equal(sw[0].state, "thin");
  assert.equal(sw[0].thinGaps, 3);
  assert.ok(rows.filter((r) => r.type === "census_gap").length >= 3, "the gaps that made the verdict are in the file");
  const mem = rows.filter((r) => r.type === "census_mem").at(-1);
  assert.deepEqual([mem.rpcIdx, mem.rpcSwitches, mem.rpcThin, mem.rpcUnreachable], [2, 1, 1, 0]);
  assert.deepEqual(mem.rpcLimitErrors, {}, "no plan-limit error here");
  assert.ok(!KEY_RE.test(child.out + child.err + JSON.stringify(rows)), "no key text");
  ok("#23 census process: #1 gives a gap every 2.5 s -> after 3 gaps a 'thin stream' switch to #2 (rpc_switch census:thin-stream, census_mem rpcThin 1, rpcLimitErrors {}); no key text");
}

console.log("PASS: rpc-failover");
process.exit(0);
