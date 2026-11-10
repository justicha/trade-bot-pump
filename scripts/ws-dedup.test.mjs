// H8: WS dedup must be PER-SUBSCRIPTION, not per `${subId}:${sig}` (which broke after a reconnect
// because the subId changes while the server replays), and not per sig alone (two subscriptions
// that both deliver the same tx must each process it).
import "./lib/test-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dedup-"));
const mockPath = path.join(dir, "dedup-mock.mjs");
fs.writeFileSync(
  mockPath,
  `import { EventEmitter } from "node:events";
export class Dedup extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.subId = 0;
    setTimeout(() => this.emit("open"), 0);
  }
  send(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method && typeof msg.id === "number") {
      this.subId += 1;
      const sub = this.subId;
      this.emit("message", JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: sub }));
      const note = (sig) => ({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: sub, result: { context: { slot: 0 }, value: { signature: sig, err: null, logs: ["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success"] } } } });
      setTimeout(() => this.emit("message", JSON.stringify(note("SIG-A"))), 5);
      setTimeout(() => this.emit("message", JSON.stringify(note("SIG-A"))), 10);
    }
  }
  close() { this.readyState = 3; setTimeout(() => this.emit("close"), 0); }
  terminate() { this.readyState = 3; this.emit("close"); }
}
export function createSocket(url) { return new Dedup(url); }
`,
);
process.env.WS_MOCK = mockPath;
const { SolanaWs } = await import("../lib/ws.mjs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  console.error("FAIL: " + m);
  process.exit(1);
};

// 1) the same signature delivered twice on ONE subscription -> handler runs once
{
  const ws = new SolanaWs();
  await ws.connect();
  let calls = 0;
  ws.subscribeLogs("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", () => { calls += 1; });
  await wait(80);
  if (calls !== 1) fail(`one subscription must see SIG-A once, got ${calls}`);
  await ws.close();
}

// 2) the same signature on TWO subscriptions -> both handlers run (per-sub dedup, not global)
{
  const ws = new SolanaWs();
  await ws.connect();
  let a = 0;
  let b = 0;
  ws.subscribeLogs("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", () => { a += 1; });
  ws.subscribeLogs("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", () => { b += 1; });
  await wait(80);
  if (a !== 1 || b !== 1) fail(`two subscriptions must each process SIG-A once, got a=${a} b=${b}`);
  await ws.close();
}

console.log("PASS: WS dedup is per-subscription (replays dropped, cross-sub preserved)");
