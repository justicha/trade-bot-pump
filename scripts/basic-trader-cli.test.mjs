// basic-trader CLI validation (M4): invalid sell percentages must fail with a clear message
// before any RPC, instead of a TypeError/RangeError (fractional/negative/NaN pct).
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const MINT = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // valid base58, used only as the mint arg

const run = (amount) =>
  new Promise((resolve) => {
    const env = cleanEnv({
      RPC_URL: "http://127.0.0.1:1",
      RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
      KEYS_DIR: makeTempKeys(),
    });
    const child = spawn(
      process.execPath,
      [path.join(root, "bots", "basic-trader", "trade.mjs"), "sell", MINT, amount],
      { cwd: root, env },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 8000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err });
    });
  });

for (const bad of ["-5", "50.5", "abc"]) {
  const { c, out, err } = await run(bad);
  asrt(c === 1, `sell pct "${bad}" exits 1 (got ${c})`);
  asrt(/invalid percent/.test(out + err), `clear message for "${bad}"`);
}

console.log("PASS: basic-trader rejects invalid sell percentages before any RPC");
