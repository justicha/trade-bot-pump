// A throttled RPC can accept the connection and never send a response. web3.js sets no deadline, so
// without RPC_TIMEOUT_MS the promise never settles: the caller holds its "entry in flight" slot
// forever and the bot silently stops entering mints while the process stays alive (observed live as
// "it went quiet at ~97% fill"). This proves the deadline is real and reaches the retry counter.
import http from "node:http";
import { PublicKey } from "@solana/web3.js";

const asrt = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
};

// A server that accepts requests and never answers — exactly what a throttled endpoint does.
const hung = http.createServer(() => {});
await new Promise((resolve) => hung.listen(0, "127.0.0.1", resolve));
const { port } = hung.address();

process.env.RPC_URL = `http://127.0.0.1:${port}`;
process.env.RPC_TIMEOUT_MS = "1000"; // the lowest value config.mjs allows
// Ambient test hooks from a previous run must not replace the real client (RPC_MOCK = fixtures).
delete process.env.RPC_MOCK;
delete process.env.WS_MOCK;

const { getSOLBalance, rpcStats } = await import("../lib/rpc.mjs");

const t0 = Date.now();
let err = null;
try {
  await getSOLBalance(new PublicKey("11111111111111111111111111111111"));
} catch (e) {
  err = e;
}
const ms = Date.now() - t0;
hung.closeAllConnections?.();
hung.close();

asrt(err !== null, "a hung RPC call must fail instead of hanging forever");
asrt(ms < 8000, `the call must be cut by RPC_TIMEOUT_MS, took ${ms}ms`);
asrt(rpcStats.errors >= 1, `the timeout must reach the retry counter (errors ${rpcStats.errors})`);
asrt(rpcStats.retries429 >= 1, `timeouts are transient and must be retried (429 counter ${rpcStats.retries429})`);

console.log(`PASS: hung RPC cut after ${ms}ms, ${rpcStats.retries429} retr(y/ies) counted, ${err.name}`);
