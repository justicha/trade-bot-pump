#!/usr/bin/env node
// Run every offline package.json script with a 20 s timeout and report the exit code + last lines.
// Scripts that need a live RPC/WS are skipped here and listed separately. Read-only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const scripts = Object.keys(pkg.scripts).filter((s) => s !== "test");
const NEEDS_RPC = new Set(["trade", "sniper", "copy", "graduation", "monitor", "analytics", "analyze", "lab", "capture-raw", "verify-invariants", "probe-layout", "dump-layout", "validate-parser"]);

console.log("=== offline scripts (20 s timeout) ===");
for (const name of scripts) {
  if (NEEDS_RPC.has(name)) continue;
  const cmd = pkg.scripts[name];
  const run = spawnSync(process.execPath, cmd.replace(/^node\s+/, "").split(/\s+/), {
    cwd: root,
    env: { ...process.env, RPC_URL: process.env.RPC_URL || "https://example.invalid/" },
    timeout: 20_000,
  });
  const tail = String(run.stdout).trim().split(/\r?\n/).slice(-5).join(" | ").slice(0, 160);
  const status = run.error ? `ERR ${run.error.message}` : run.status === null ? "TIMEOUT" : String(run.status);
  console.log(`${name.padEnd(22)} ${status.padEnd(8)} ${tail}`);
}

console.log("\n=== RPC/WS-requiring scripts (skipped from the timed run) ===");
console.log([...NEEDS_RPC].join(", "));
console.log("\nbehavior on a missing/invalid RPC_URL is covered by lib/config.mjs, which aborts with a clear message before connecting:");
const bad = spawnSync(process.execPath, ["bots/monitor/stream.mjs"], { cwd: root, env: { ...process.env, RPC_URL: "" }, timeout: 10_000 });
console.log(`  monitor (empty RPC_URL): exit ${bad.status}, ${String(bad.stderr).trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 160)}`);
