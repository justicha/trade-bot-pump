// H2: graduation must process EVERY buy event in a tx, not just the first (the old `break`). Two
// events — 90% then 95% fill — must end with the watchlist showing the higher fill.
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

const jdir = fs.mkdtempSync(path.join(os.tmpdir(), "grad-events-journal-"));
const env = cleanEnv({
  RPC_URL: "http://127.0.0.1:1",
  RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"),
  WS_MOCK: path.join(here, "mocks", "grad-ws-mock.mjs"),
  KEYS_DIR: makeTempKeys(),
  JOURNAL_DIR: jdir,
  GRAD_BUY_SOL: "0.02",
  GRAD_MIN_FILL_PCT: "92",
  GRAD_MAX_FILL_PCT: "97",
  MIN_HOLDERS: "0",
  GRAD_MAX_POSITIONS: "3",
});

const child = spawn(process.execPath, [path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "--dry-run"], { cwd: root, env });
let out = "";
child.stdout.on("data", (b) => (out += String(b)));
child.stderr.on("data", () => {});
const code = await new Promise((resolve) => {
  const killer = setTimeout(() => child.kill(), 4000);
  child.on("exit", (c) => { clearTimeout(killer); resolve(c); });
});
void code;

asrt(/fill=95\.0%/.test(out), "the second (95%) fill event was processed (no early break)");
fs.rmSync(jdir, { recursive: true, force: true });

console.log(JSON.stringify({ sawFill95: /fill=95\.0%/.test(out) }));
console.log("PASS: graduation processes every buy event in a tx (no early break on the first)");
