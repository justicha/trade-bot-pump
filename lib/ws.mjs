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
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._alive = true; // pong watchdog: a dead TCP never fires 'close', so ping/pong decides
  }

  connect() {
    return new Promise((resolve) => {
      const attempt = () => {
        // A close() may land while a reconnect timer is still pending: do not open a new socket.
        if (this.closedByUser) return;
        this.ws = mockFactory ? mockFactory(this.url) : new WebSocket(this.url);
        this._alive = true;
        this.ws.on("open", () => {
          // close() may win the race against a slow handshake: never start the heartbeat on a
          // socket that was already abandoned.
          if (this.closedByUser) {
            if (typeof this.ws.close === "function") this.ws.close();
            return;
          }
          this.reconnectAttempt = 0; // reset backoff once a connection is healthy
          this._alive = true;
          log.info("[ws] connected");
          // Clear stale subId->handler mappings; fresh subIds arrive when we resubscribe.
          this.handlers.clear();
          for (const [id, { method, params }] of this.subs) {
            this._send(method, params, id);
          }
          // Ping/pong heartbeat: a silently dead connection (dropped without FIN/RST) never
          // fires 'close', so without this the bot would sit on a dead socket forever. No pong
          // within the window -> terminate() -> the close handler reconnects.
          clearInterval(this._pingTimer);
          this._pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (!this._alive) {
              if (typeof this.ws.terminate === "function") this.ws.terminate();
              return;
            }
            this._alive = false;
            if (typeof this.ws.ping === "function") this.ws.ping();
          }, 30_000);
          this._pingTimer.unref?.();
          resolve();
        });
        this.ws.on("pong", () => {
          this._alive = true;
        });
        this.ws.on("message", (raw) => {
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (msg.method === "logsNotification" || msg.method === "accountNotification") {
            const subId = msg.params?.subscription;
            const sub = this.handlers.get(subId);
            if (!sub) return;
            const result = msg.params.result;
            // H8: drop duplicate notifications per subscription. The seen-set lives on the
            // subscription entry (this.subs), which survives a reconnect — the old `${subId}:${sig}`
            // key broke after reconnect because the subId changes while the server replays. A key of
            // sig alone would also be wrong: different subscriptions (e.g. two copy-trader targets)
            // deliver the same signature and each must still process it.
            if (msg.method === "logsNotification") {
              const sig = result?.value?.signature;
              if (sig) {
                if (sub.seen.has(sig)) return;
                sub.seen.add(sig);
                sub.seenOrder.push(sig);
                if (sub.seenOrder.length > 10000) {
                  const old = sub.seenOrder.splice(0, 5000);
                  for (const k of old) sub.seen.delete(k);
                }
              }
            }
            sub.handler(result);
          }
          if (msg.result && typeof msg.result === "number") {
            const pending = this.subs.get(msg.id);
            if (pending) {
              this.handlers.set(msg.result, pending);
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
          this._reconnectTimer = setTimeout(attempt, delay);
          this._reconnectTimer.unref?.();
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
    this.subs.set(id, { method, params, handler, seen: new Set(), seenOrder: [] });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._send(method, params, id);
    }
    return id;
  }

  subscribeAccount(pubkey, handler, commitment = "confirmed") {
    const id = ++this.id;
    const method = "accountSubscribe";
    const params = [pubkey, { encoding: "jsonParsed", commitment }];
    this.subs.set(id, { method, params, handler, seen: new Set(), seenOrder: [] });
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
    clearInterval(this._pingTimer);
    clearTimeout(this._reconnectTimer);
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
