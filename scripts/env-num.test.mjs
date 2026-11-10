// Numeric env validation (H7): an invalid numeric env var must abort startup with the variable
// name (lib/config.mjs numOr), never silently become NaN (a NaN COPY_MAX_POSITIONS used to disable
// the copy-trader position cap entirely).
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

const run = (relScript, argv, extraEnv) =>
  new Promise((resolve) => {
    const env = { ...process.env, RPC_URL: "http://127.0.0.1:1", ...extraEnv };
    const child = spawn(process.execPath, [path.join(root, relScript), ...argv], { cwd: root, env });
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

// copy-trader: COPY_MAX_POSITIONS=abc (fails at import, before any wallet/RPC work)
{
  const { c, out, err } = await run(path.join("bots", "copy-trader", "watcher.mjs"), [], { COPY_MAX_POSITIONS: "abc" });
  asrt(c === 1, `COPY_MAX_POSITIONS=abc exits 1 (got ${c})`);
  asrt(/COPY_MAX_POSITIONS/.test(out + err), "error names the variable COPY_MAX_POSITIONS");
}

// rescue-sell: SELL_SLIPPAGE_BPS=abc (fails at import, before loadKeypair)
{
  const { c, out, err } = await run(path.join("scripts", "rescue-sell.mjs"), ["--dry-run"], { SELL_SLIPPAGE_BPS: "abc" });
  asrt(c === 1, `SELL_SLIPPAGE_BPS=abc exits 1 (got ${c})`);
  asrt(/SELL_SLIPPAGE_BPS/.test(out + err), "error names the variable SELL_SLIPPAGE_BPS");
}

console.log("PASS: numeric env validated loudly (watcher COPY_MAX_POSITIONS, rescue SELL_SLIPPAGE_BPS)");
