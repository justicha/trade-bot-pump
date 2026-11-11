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

// Hermetic child env. lib/config.mjs never lets .env override an EXISTING env var, so a developer's
// shell (or IDE) that exports RPC_URL / CU_PRICE would win over the temp .env and the child would
// load the real endpoint instead of the values under test. Strip every setting the child could pick
// up (case-insensitive: Windows env names are) and point ROOT at the temp dir, so the repo .env is
// never read either.
const STRIP = new Set([
  "ROOT", "RPC_URL", "HELIUS_API_KEY", "CU_PRICE", "CU_LIMIT", "SLIPPAGE_BPS", "LOG_LEVEL",
  "MAX_TRADE_SOL", "MAX_SESSION_SOL", "MAX_CONSEC_LOSSES", "CURVE_CACHE_MS", "RPC_TIMEOUT_MS",
  "LIVE_CONFIRM", "LIVE_CONFIRM_AMM", "DRY_SELL", "SELL_ON_EXIT", "KEYS_DIR", "WS_MOCK", "RPC_MOCK",
]);
function childEnv(base, rootDir) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP.has(k.toUpperCase())) env[k] = v;
  env.ROOT = rootDir;
  return env;
}
// Failure messages must never echo a real endpoint / API key from the developer's environment.
const redact = (s) =>
  String(s ?? "")
    .replace(/\b(?:https?|wss?):\/\/(?!example\.invalid\b)[^\s"'`]*/gi, "<url-redacted>")
    .replace(/api[-_]?key=[^\s&"'`]*/gi, "api-key=<redacted>");

// Poison the inherited env on purpose: the result must not depend on what this machine exports.
// Without the stripping above the child would print "777 https://poison.invalid/..." and fail.
const inherited = {
  ...process.env,
  RPC_URL: "https://poison.invalid/?api-key=POISON",
  CU_PRICE: "777",
  LOG_LEVEL: "error",
  LIVE_CONFIRM: "yes",
};
const code = `import("./lib/config.mjs").then((m) => console.log(m.CU_PRICE, m.RPC_URL));`;
const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
  cwd: repo,
  encoding: "utf8",
  env: childEnv(inherited, root),
});
assert.equal(run.status, 0, `config loads with inline comments (stderr: ${redact(run.stderr)})`);
assert.match(run.stdout, /^1500000 https:\/\/example\.invalid\s*$/m, `clean values loaded, got "${redact(run.stdout.trim())}"`);

console.log(JSON.stringify({ parserCases: 9, integration: "ok" }));
console.log("PASS: inline comments stripped, quoted values and '#'-in-value preserved");
