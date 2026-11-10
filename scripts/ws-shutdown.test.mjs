// B8: a dropped connection must reconnect with backoff; close() must cancel a pending reconnect
// and never leave a zombie socket behind (a pending reconnect timer used to open a new socket
// AFTER close(), keeping the process alive).
import "./lib/test-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-shutdown-"));
const mockPath = path.join(dir, "flaky-mock.mjs");
fs.writeFileSync(
  mockPath,
  `import { EventEmitter } from "node:events";
export let created = 0;
export class Flaky extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    created += 1;
    setTimeout(() => this.emit("open"), 5);
    setTimeout(() => { this.readyState = 3; this.emit("close"); }, 60); // drop right after connecting
  }
  send() {}
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.readyState = 3; this.emit("close"); }
}
export function createSocket(url) { return new Flaky(url); }
`,
);
process.env.WS_MOCK = mockPath;
// WS_MOCK must be set BEFORE lib/ws.mjs is evaluated (it decides mock vs real socket at import).
const { SolanaWs } = await import("../lib/ws.mjs");
const mockMod = await import(pathToFileURL(mockPath).href); // namespace: read mockMod.created (live)

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => {
  console.error("FAIL: " + m);
  process.exit(1);
};

// 1) a dropped connection reconnects
const a = new SolanaWs();
a.baseReconnectMs = 20;
await a.connect();
await wait(300);
if (!(mockMod.created >= 2)) fail(`no reconnect happened (created=${mockMod.created})`);

// 2) close() cancels a pending reconnect and prevents zombie sockets
await a.close();
const atClose = mockMod.created;
await wait(300);
if (mockMod.created > atClose) fail(`zombie socket opened after close() (${mockMod.created} > ${atClose})`);

// 3) close() before the handshake completes must also stop everything
const b = new SolanaWs();
b.baseReconnectMs = 20;
void b.connect();
await b.close();
const atB = mockMod.created;
await wait(300);
if (mockMod.created > atB) fail(`socket opened after close()-before-open (${mockMod.created} > ${atB})`);

console.log(JSON.stringify({ reconnectedTo: mockMod.created, closedAt: atClose }));
console.log("PASS: ws reconnects on drop, close() cancels pending reconnects (no zombie sockets)");
