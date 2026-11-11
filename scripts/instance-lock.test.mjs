// Instance-lock test (step 1): a second sniper must refuse to start while another instance holds
// the journal lock, but a stale lock (dead PID) must not block a start.
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
const run = (env, ms) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, "bots", "sniper", "sniper.mjs"), "--dry-run"], { cwd: root, env });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  let err = "";
  child.stderr.on("data", (b) => (err += String(b)));
  const killer = setTimeout(() => child.kill(), ms);
  child.on("exit", (c) => {
    clearTimeout(killer);
    resolve({ c, out, err });
  });
});

// 1) a live PID in the lock file -> refuse to start
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-journal-"));
  fs.writeFileSync(path.join(dir, ".sniper.lock"), String(process.pid)); // our own (alive) PID
  const env = cleanEnv({ RPC_URL: "http://127.0.0.1:1", RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"), WS_MOCK: path.join(here, "mocks", "ws-mock.mjs"), JOURNAL_DIR: dir, KEYS_DIR: makeTempKeys() });
  const { c, out, err } = await run(env, 8000);
  asrt(c === 1, `refuses to start while another instance holds the lock (exit ${c})`);
  asrt(/already running/i.test(out + err), "prints a clear 'already running' message");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) a dead PID in the lock file -> start normally (and self-stop via SNIPER_MAX_SEC)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-journal-"));
  fs.writeFileSync(path.join(dir, ".sniper.lock"), "999999"); // dead PID
  const env = cleanEnv({ RPC_URL: "http://127.0.0.1:1", RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"), WS_MOCK: path.join(here, "mocks", "ws-mock.mjs"), JOURNAL_DIR: dir, KEYS_DIR: makeTempKeys(), SNIPER_MAX_SEC: "3", SNIPER_DRAIN_MAX_SEC: "0", TICKS: "0" });
  const { c, out } = await run(env, 10000);
  asrt(c === 0, `starts when the lock PID is dead (exit ${c})`);
  asrt(/SESSION SUMMARY/.test(out), "ran and printed the summary (stale lock did not block it)");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) a garbage lock file -> not a live PID, so the bot replaces it and starts (atomic capture)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-journal-"));
  fs.writeFileSync(path.join(dir, ".sniper.lock"), "garbage-not-a-pid");
  const env = cleanEnv({ RPC_URL: "http://127.0.0.1:1", RPC_MOCK: path.join(here, "mocks", "rpc-mock.mjs"), WS_MOCK: path.join(here, "mocks", "ws-mock.mjs"), JOURNAL_DIR: dir, KEYS_DIR: makeTempKeys(), SNIPER_MAX_SEC: "3", SNIPER_DRAIN_MAX_SEC: "0", TICKS: "0" });
  const { c, out } = await run(env, 10000);
  asrt(c === 0, `starts over a garbage lock file (exit ${c})`);
  asrt(/SESSION SUMMARY/.test(out), "ran and printed the summary (garbage lock replaced)");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("PASS: instance lock refuses a second live instance, ignores stale locks, replaces garbage");
