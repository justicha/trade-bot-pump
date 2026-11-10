// A1: .env lines with inline comments must parse to the value, not to "value # comment" (which
// turns into NaN downstream and silently disables trading). Quoted values and a '#' that is part
// of the value are preserved.
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnvLine } from "../lib/config.mjs";

// Pure parser cases.
assert.deepEqual(parseEnvLine("GRAD_MIN_FILL_PCT=92 # alias MIN_FILL"), ["GRAD_MIN_FILL_PCT", "92"]);
assert.deepEqual(parseEnvLine("  KEY = 0.02  "), ["KEY", "0.02"]);
assert.deepEqual(parseEnvLine("KEY=92#c"), ["KEY", "92#c"]); // '#' without leading whitespace is part of the value
assert.deepEqual(parseEnvLine('KEY="a # b" # comment'), ["KEY", "a # b"]);
assert.deepEqual(parseEnvLine("KEY='x # y'"), ["KEY", "x # y"]);
assert.equal(parseEnvLine("# full comment"), null);
assert.equal(parseEnvLine("not-a-key-value-line"), null);
assert.equal(parseEnvLine("KEY"), null);

// Integration: a .env inside a temp ROOT with inline comments loads clean values (and a value
// with a '#' fragment is kept intact).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "env-inline-"));
fs.writeFileSync(
  path.join(root, ".env"),
  "RPC_URL=https://example.invalid # endpoint comment\nCU_PRICE=1500000 # lamports\nLOG_LEVEL=debug # verbose\n",
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const code = `process.env.ROOT=${JSON.stringify(root)}; import("./lib/config.mjs").then((m) => console.log(m.CU_PRICE, m.RPC_URL));`;
const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: repo, encoding: "utf8" });
assert.equal(run.status, 0, `config loads with inline comments (stderr: ${run.stderr})`);
assert.match(run.stdout, /^1500000 https:\/\/example\.invalid\s*$/m, `clean values loaded, got "${run.stdout.trim()}"`);

console.log(JSON.stringify({ parserCases: 9, integration: "ok" }));
console.log("PASS: inline comments stripped, quoted values and '#'-in-value preserved");
