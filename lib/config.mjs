import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ROOT is overridable so tests can point the whole runtime (including the .env lookup) at a temp
// dir: `npm test` must pass without a developer's .env or keys/ in the repo.
export const ROOT = process.env.ROOT
  ? path.resolve(process.env.ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const kv = parseEnvLine(line);
    if (kv && !(kv[0] in process.env)) process.env[kv[0]] = kv[1];
  }
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

// Hard safety gate: --live alone is not enough. A second, independent switch must be set so a
// copy-pasted command or a stray flag cannot spend real SOL.
if (LIVE && process.env.LIVE_CONFIRM !== "yes") {
  fail(
    '--live requires LIVE_CONFIRM=yes. Set it for this run only, e.g. ' +
      '$env:LIVE_CONFIRM="yes"; node bots/graduation-sniper/graduation.mjs --live',
  );
}
