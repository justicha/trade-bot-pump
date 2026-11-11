// H1: the copy-trader must copy ONLY the subscribed target's own trades — a tx that also carries a
// foreign wallet's trade must not be copied.
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGET } from "./mocks/copy-ws-mock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const env = cleanEnv({
  RPC_URL: "http://127.0.0.1:1",
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "copy-ws-mock.mjs"),
  KEYS_DIR: makeTempKeys(),
  COPY_TARGETS: TARGET,
  COPY_BUY_SOL: "0.02",
  COPY_MAX_POSITIONS: "5",
  COPY_SELL_PCT: "100",
});

const child = spawn(process.execPath, [path.join(root, "bots", "copy-trader", "watcher.mjs"), "--dry-run"], { cwd: root, env });
let out = "";
child.stdout.on("data", (b) => (out += String(b)));
child.stderr.on("data", () => {});
const code = await new Promise((resolve) => {
  const killer = setTimeout(() => child.kill(), 4000);
  child.on("exit", (c) => { clearTimeout(killer); resolve(c); });
});
void code;

const buys = (out.match(/COPY BUY/g) || []).length;
asrt(buys === 1, `only the target's trade is copied (COPY BUY once), got ${buys}`);
asrt(!/foreign/i.test(out), "no foreign-trade copy in the output");

console.log(JSON.stringify({ copyBuyCount: buys }));
console.log("PASS: copy-trader filters out foreign wallets' trades in a tx mentioning the target");
