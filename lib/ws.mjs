import WebSocket from "ws";
import { WS_URL, LIVE } from "./config.mjs";
import { log } from "./logger.mjs";
import { pathToFileURL } from "node:url";

// Test hook: WS_MOCK=<path to an ESM module exporting createSocket(url)> replaces the socket.
// The real handler in bots/sniper/sniper.mjs then runs against synthetic notifications, which is
// what scripts/smoke.test.mjs exercises (see also RPC_MOCK in lib/rpc.mjs).
const MOCK_PATH = process.env.WS_MOCK;
const mockFactory = MOCK_PATH
  ? (await import(MOCK_PATH.startsWith(".") || MOCK_PATH.includes(":") ? pathToFileURL(MOCK_PATH).href : MOCK_PATH)).createSocket
  : null;

// A mock socket only ever produces synthetic data. Running it with --live would mean "send real
// money on fake prices", so refuse loudly before any socket is opened.
if (mockFactory && LIVE) {
  throw new Error("WS_MOCK is a test fixture and cannot be used with --live. Unset WS_MOCK or drop --live.");
}

export class SolanaWs {
  constructor(url = WS_URL) {
    this.url = url;
    this.ws = null;
    this.id = 0;
    this.subs = new Map();
    this.handlers = new Map();
    this.baseReconnectMs = 1000;
    this.maxReconnectMs = 30_000;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this._seenSigs = new Set();
    this._seenOrder = [];
  }

  connect() {
    return new Promise((resolve) => {
      const attempt = () => {
        this.ws = mockFactory ? mockFactory(this.url) : new WebSocket(this.url);
        this.ws.on("open", () => {
          this.reconnectAttempt = 0; // reset backoff once a connection is healthy
          log.info("[ws] connected");
          // Clear stale subId->handler mappings; fresh subIds arrive when we resubscribe.
          this.handlers.clear();
          for (const [id, { method, params }] of this.subs) {
            this._send(method, params, id);
          }
          resolve();
        });
        this.ws.on("message", (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg.method === "logsNotification" || msg.method === "accountNotification") {
            const subId = msg.params?.subscription;
            const handler = this.handlers.get(subId);
            if (!handler) return;
            const result = msg.params.result;
            // D12: drop duplicate notifications (e.g. re-delivered after a reconnect).
            if (msg.method === "logsNotification") {
              const sig = result?.value?.signature;
              if (sig) {
                // D12: dedup per subscription+signature. Different subscriptions (e.g. a
                // wallet sub and a program sub) can deliver the same signature; each must
                // still be processed once per subscription, so key on subId too.
                const dedupKey = `${subId}:${sig}`;
                if (this._seenSigs.has(dedupKey)) return;
                this._seenSigs.add(dedupKey);
                this._seenOrder.push(dedupKey);
                if (this._seenOrder.length > 10000) {
                  const old = this._seenOrder.splice(0, 5000);
                  for (const k of old) this._seenSigs.delete(k);
                }
              }
            }
            handler(result);
          }
          if (msg.result && typeof msg.result === "number") {
            const pending = this.subs.get(msg.id);
            if (pending) {
              this.handlers.set(msg.result, pending.handler);
              pending.subId = msg.result;
            }
          }
        });
        this.ws.on("close", () => {
          if (this.closedByUser) return;
          // D12: exponential backoff with jitter (50-100% of the exponential window), capped.
          const exp = Math.min(this.maxReconnectMs, this.baseReconnectMs * 2 ** this.reconnectAttempt);
          const delay = Math.round(exp * (0.5 + Math.random() * 0.5));
          this.reconnectAttempt++;
          log.warn(`[ws] disconnected, reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
          setTimeout(attempt, delay);
        });
        this.ws.on("error", (err) => {
          // A handshake error (e.g. RPC 429) is followed by 'close'. Log it and let the close
          // handler reconnect — never reject here, or `await connect()` becomes an unhandled
          // rejection and Node kills the process instead of retrying.
          log.error(`[ws] error: ${err.message}`);
        });
      };
      attempt();
    });
  }

  _send(method, params, id) {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  }

  subscribeLogs(programId, handler, commitment = "confirmed") {
    const id = ++this.id;
    const method = "logsSubscribe";
    const params = [{ mentions: [programId] }, { commitment }];
    this.subs.set(id, { method, params, handler });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send(method, params, id);
    }
    return id;
  }

  subscribeAccount(pubkey, handler, commitment = "confirmed") {
    const id = ++this.id;
    const method = "accountSubscribe";
    const params = [pubkey, { encoding: "jsonParsed", commitment }];
    this.subs.set(id, { method, params, handler });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send(method, params, id);
    }
    return id;
  }

  // Resolves once the socket is really closed (or after a 500ms grace period). Await it
  // before process.exit(): exiting while the close handshake is pending trips
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" on Windows.
  close() {
    this.closedByUser = true;
    const sock = this.ws;
    if (!sock || sock.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 500);
      sock.once("close", finish);
      try {
        sock.close();
      } catch {
        finish();
      }
    });
  }
}
