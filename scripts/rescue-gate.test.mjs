// rescue-sell safety gate (C3): --dry-run must always win over --live (no send), and --live alone
// without LIVE_CONFIRM=yes must be refused by lib/config.mjs before any transaction.
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
const MINT = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // valid base58, used only as a --mint arg

const run = (argv) =>
  new Promise((resolve) => {
    const env = cleanEnv({
      RPC_URL: "http://127.0.0.1:1",
      RPC_MOCK: path.join(here, "mocks", "rescue-rpc-mock.mjs"),
      KEYS_DIR: makeTempKeys(),
    });
    const child = spawn(process.execPath, [path.join(root, "scripts", "rescue-sell.mjs"), ...argv], { cwd: root, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 10000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err });
    });
  });

// 1) --live --dry-run: config LIVE=false -> DRY RUN, nothing is sent.
{
  const { c, out } = await run(["--live", "--dry-run", "--mint", MINT]);
  asrt(c === 0, `--live --dry-run exits 0 (got ${c})`);
  asrt(/DRY RUN/.test(out), "banner says DRY RUN");
  asrt(!/sold /.test(out) && !/sell failed/.test(out), "nothing sent (no 'sold' / 'sell failed' in output)");
}

// 2) --live without LIVE_CONFIRM=yes: the config gate aborts the process.
{
  const { c, out, err } = await run(["--live", "--mint", MINT]);
  asrt(c === 1, `--live without LIVE_CONFIRM exits 1 (got ${c})`);
  asrt(/LIVE_CONFIRM/.test(out + err), "gate message mentions LIVE_CONFIRM");
}

console.log("PASS: rescue-sell gate — --dry-run never sends, --live requires LIVE_CONFIRM");
