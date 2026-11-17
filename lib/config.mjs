import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ROOT is overridable so tests can point the whole runtime (including the .env lookup) at a temp
// dir: `npm test` must pass without a developer's .env or keys/ in the repo.
export const ROOT = process.env.ROOT
  ? path.resolve(process.env.ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The research entry points (shadow lab, mint census): the only users of RPC_URLS.
const FAILOVER_SCRIPTS = new Set(["shadow.mjs", "mint-census.mjs"]);

// KODING #22: .env text -> { vars: [[NAME, value], ...] in file order, issues: [...] }.
// Every line goes through parseEnvLine as before, plus a multi-line array for the names in
// ENV_ARRAY_VARS (only RPC_URLS: one key per line is readable, a long comma line is not):
//     RPC_URLS=[
//       https://a.example/KEY_A
//       https://b.example/KEY_B|wss://b-ws.example/KEY_B,
//       # a commented-out key is skipped
//     ]
// "NAME=[" opens it (an inline " # comment" after "[" is allowed), one item per line, "]" on its own
// line closes it. Inside: blank lines and lines starting with # are skipped, an inline " # comment" is
// cut (as in parseEnvLine), a trailing comma is optional. The items are joined into the same comma
// string the single-line form gives, so lib/rpc-failover.mjs parseRpcUrlList validates both alike.
// Issues (messages carry line numbers only, never a value):
//   { kind: "unclosedArray", name, line } — no "]" before the end of the file or before the next
//     NAME= line (that line is read normally again); the variable is NOT set;
//   { kind: "strayUrl", line } — outside an array, a line without NAME= that starts with
//     http:// https:// ws:// wss:// (a URL continued on a new line, silently lost before #22).
export function parseEnvText(text) {
  const lines = String(text).split("\n");
  const vars = [];
  const issues = [];
  let arr = null; // { name, line, items }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const n = i + 1;
    if (arr) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const hash = t.search(/\s+#/);
      let item = (hash === -1 ? t : t.slice(0, hash)).trim();
      if (item === "]") {
        vars.push([arr.name, arr.items.join(",")]);
        arr = null;
        continue;
      }
      if (parseEnvLine(line)) {
        // the next variable began: the array was never closed
        issues.push({ kind: "unclosedArray", name: arr.name, line: arr.line });
        arr = null;
      } else {
        if (item.endsWith(",")) item = item.slice(0, -1).trim();
        if (item) arr.items.push(item);
        continue;
      }
    }
    const kv = parseEnvLine(line);
    if (kv) {
      if (ENV_ARRAY_VARS.has(kv[0]) && kv[1] === "[") arr = { name: kv[0], line: n, items: [] };
      else vars.push(kv);
      continue;
    }
    if (URL_LINE.test(line)) issues.push({ kind: "strayUrl", line: n });
  }
  if (arr) issues.push({ kind: "unclosedArray", name: arr.name, line: arr.line });
  return { vars, issues };
}

// A secret-free text for one issue (line numbers only).
export function envIssueText(x) {
  if (x.kind === "unclosedArray") return `${x.name}=[ at line ${x.line} of .env has no closing "]" line (${x.name} is not set)`;
  return `line ${x.line} of .env looks like a URL without NAME= (it is ignored; put it inside RPC_URLS=[ ... ] or after NAME=)`;
}

// The research processes (shadow lab, mint census; never live) stop on an .env issue: a lost key
// would silently shrink their RPC_URLS. Every other process warns once and goes on as before.
function researchProcess(argv) {
  const live = argv.includes("--live") && !argv.includes("--dry-run");
  return !live && FAILOVER_SCRIPTS.has(path.basename(argv[1] || ""));
}

export const ENV_ARRAY_VARS = new Set(["RPC_URLS"]);
const URL_LINE = /^\s*(https?|wss?):\/\//i;

const envPath = path.join(ROOT, ".env");
const envIssues = []; // KODING #22: an unclosed array / a URL line without NAME= (handled below)
if (fs.existsSync(envPath)) {
  const parsed = parseEnvText(fs.readFileSync(envPath, "utf8"));
  for (const [name, value] of parsed.vars) if (!(name in process.env)) process.env[name] = value;
  envIssues.push(...parsed.issues);
}

if (envIssues.length) {
  const text = envIssues.map(envIssueText).join("; ");
  if (researchProcess(process.argv)) fail(text);
  process.stderr.write(`[config] warning: ${text}\n`);
}

// Parse one .env line: NAME=value with an optional inline comment. Rules:
//   - quoted values ("x" / 'x') keep everything inside the quotes, a '#' included;
//   - unquoted values end at the first '#' preceded by whitespace (a bare '#' inside the value,
//     e.g. an URL fragment, is kept);
//   - full-line comments and malformed lines return null.
// Exported so tests can pin the exact behaviour ("92 # alias" must read as "92", not NaN).
export function parseEnvLine(line) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (!m) return null;
  let value = m[2];
  const q = value[0];
  if (q === '"' || q === "'") {
    const end = value.indexOf(q, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    const hash = value.search(/\s+#/);
    if (hash !== -1) value = value.slice(0, hash);
    value = value.trimEnd();
  }
  return [m[1], value];
}

// Fail fast with an actionable, secret-free message.
function fail(msg) {
  process.stderr.write(`\n[config] ERROR: ${msg}\n`);
  process.exit(1);
}

// Parse a numeric env value the bot layer reads through an alias chain (the single-name `num`
// helper cannot express those). An invalid value — e.g. a line copied from .env.example WITH its
// inline comment — must fail loudly with the variable name, never silently become NaN (a NaN
// filter would silently disable trading).
export function numOr(raw, def, name) {
  const v = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(v)) fail(`${name} must be a number (got "${raw}")`);
  return v;
}

// Parse a numeric env var with validation. Invalid / out-of-range aborts startup.
function num(name, def, { min, max } = {}) {
  const raw = process.env[name];
  const v = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(v)) fail(`${name} must be a number (got "${raw}")`);
  if (min !== undefined && v < min) fail(`${name} must be >= ${min} (got ${v})`);
  if (max !== undefined && v > max) fail(`${name} must be <= ${max} (got ${v})`);
  return v;
}

// --- RPC: required, NO fallback to the public cluster (A2) ---
export const RPC_URL = process.env.RPC_URL;
if (!RPC_URL || !/^https?:\/\//.test(RPC_URL)) {
  fail(
    "RPC_URL is required (must start with http:// or https://). " +
      "Copy .env.example to .env and set RPC_URL to your own endpoint, " +
      "e.g. https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
  );
}
export const WS_URL = RPC_URL.replace("https://", "wss://").replace("http://", "ws://");
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

// --- Trading parameters ---
export const SLIPPAGE_BPS = num("SLIPPAGE_BPS", 500, { min: 0, max: 1500 });
export const CU_PRICE = num("CU_PRICE", 1_500_000, { min: 0 });
export const CU_LIMIT = num("CU_LIMIT", 300_000, { min: 0 });
// Priority fee paid = CU_PRICE * CU_LIMIT / 1e6 lamports. Cap it at 0.002 SOL
// (2,000,000 lamports) per transaction; a higher combination aborts startup.
if ((CU_PRICE * CU_LIMIT) / 1e6 > 2_000_000) {
  fail(
    `CU_PRICE * CU_LIMIT / 1e6 = ${((CU_PRICE * CU_LIMIT) / 1e6).toFixed(0)} lamports ` +
      `exceeds the 0.002 SOL (2,000,000 lamports) priority-fee cap. Lower CU_PRICE or CU_LIMIT.`,
  );
}

// Compute-unit limit of the PumpSwap (AMM) sell transaction only. A real pool sell burns 73–86k CU
// on the instruction itself, plus ~25k to create the WSOL ATA and ~3k to close it: up to ~115k,
// which leaves a 120k CU_LIMIT under 5% of headroom (a tx that runs out fails and the position goes
// to retries / STUCK). Every other transaction keeps CU_LIMIT. The same 0.002 SOL priority-fee cap
// applies.
export const AMM_SELL_CU_LIMIT = num("AMM_SELL_CU_LIMIT", 160_000, { min: 0 });
if ((CU_PRICE * AMM_SELL_CU_LIMIT) / 1e6 > 2_000_000) {
  fail(
    `CU_PRICE * AMM_SELL_CU_LIMIT / 1e6 = ${((CU_PRICE * AMM_SELL_CU_LIMIT) / 1e6).toFixed(0)} lamports ` +
      `exceeds the 0.002 SOL (2,000,000 lamports) priority-fee cap. Lower CU_PRICE or AMM_SELL_CU_LIMIT.`,
  );
}

// --- Hard safety limits (A4). Breaching a limit aborts the trade / halts trading. ---
export const MAX_TRADE_SOL = num("MAX_TRADE_SOL", 0.05, { min: 0 });
export const MAX_SESSION_SOL = num("MAX_SESSION_SOL", 0.2, { min: 0 });
export const MAX_CONSEC_LOSSES = num("MAX_CONSEC_LOSSES", 3, { min: 0 });

// --- Bonding-curve state cache TTL in ms (D13); 0 disables caching ---
export const CURVE_CACHE_MS = num("CURVE_CACHE_MS", 0, { min: 0 });

// --- Hard per-request timeout for every HTTP RPC call ---
// A throttled public endpoint can accept the TCP connection and never answer. Without a timeout
// the promise never settles: the caller keeps its "entry in flight" slot forever and the bot stops
// entering mints without printing a single line (it looks dead while it is only stuck).
export const RPC_TIMEOUT_MS = num("RPC_TIMEOUT_MS", 15_000, { min: 1_000, max: 120_000 });

// --- Execution mode (A3): dry-run by default; real trading ONLY with --live ---
const argv = process.argv;
export const LIVE = argv.includes("--live") && !argv.includes("--dry-run");
export const DRY_RUN = !LIVE;

// RPC_URLS (endpoint failover, lib/rpc-failover.mjs) is read only by the two research processes —
// the shadow lab and the mint census — and never with --live. Every other process, and every live
// run, keeps the single RPC_URL above; when RPC_URLS is set there, say so once (no URL printed).
// (FAILOVER_SCRIPTS is declared at the top: the .env loader uses it too.)
export function rpcUrlsIgnoredWhy({ rpcUrls, live, script }) {
  if (!rpcUrls) return null;
  if (live) return "--live";
  if (!FAILOVER_SCRIPTS.has(path.basename(script || ""))) return "not the shadow lab / mint census";
  return null;
}
const rpcUrlsIgnored = rpcUrlsIgnoredWhy({ rpcUrls: process.env.RPC_URLS, live: LIVE, script: argv[1] });
if (rpcUrlsIgnored) {
  process.stderr.write(`[config] warning: RPC_URLS is ignored by this process (${rpcUrlsIgnored}): using the single RPC_URL, no failover\n`);
}

// Hard safety gate: --live alone is not enough. A second, independent switch must be set so a
// copy-pasted command or a stray flag cannot spend real SOL.
if (LIVE && process.env.LIVE_CONFIRM !== "yes") {
  fail(
    '--live requires LIVE_CONFIRM=yes. Set it for this run only, e.g. ' +
      '$env:LIVE_CONFIRM="yes"; node bots/graduation-sniper/graduation.mjs --live',
  );
}
