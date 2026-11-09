// Общий RPC-клиент с учётом кредитов (data/credits.json) и жёстким лимитом CREDIT_BUDGET из .env.
// Оценка консервативная: архивные методы по 10 кредитов, остальные по 1. Каждая попытка списывается.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const line of fs.existsSync(path.join(ROOT, ".env")) ? fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
export const RPC = process.env.RPC_URL;
if (!RPC || !/^https?:\/\//.test(RPC)) {
  // A2: no silent fallback to the public cluster. Fail with a clear message.
  console.error("[rpc] RPC_URL is required (http/https). Set RPC_URL in .env — research scripts do not fall back to the public cluster.");
  process.exit(1);
}
export const IS_PUBLIC = RPC.includes("api.mainnet-beta");
export const BUDGET = Number(process.env.CREDIT_BUDGET || 200000);
const LEDGER = path.join(ROOT, "data", "credits.json");
const COST = { getTransaction: 10, getSignaturesForAddress: 10, getBlock: 10 };

fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
export const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : { used: 0, calls: {} };
export const saveLedger = () => fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BudgetExceeded extends Error {}
function charge(method) {
  if (IS_PUBLIC) return;
  const c = COST[method] ?? 1;
  if (ledger.used + c > BUDGET) throw new BudgetExceeded(`бюджет ${BUDGET} кредитов исчерпан (использовано ${ledger.used})`);
  ledger.used += c;
  ledger.calls[method] = (ledger.calls[method] || 0) + 1;
}

let id = 0;
export async function rpc(method, params, attempt = 0) {
  charge(method);
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 6) throw new Error(`${method}: HTTP ${res.status}`);
    await sleep(500 * 2 ** Math.min(attempt, 4));
    return rpc(method, params, attempt + 1);
  }
  const j = await res.json();
  if (j.error) {
    if (j.error.code === -32015 || j.error.code === -32602) throw new Error(`${method}: ${j.error.message}`);
    if (attempt > 6) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    await sleep(500 * 2 ** Math.min(attempt, 4));
    return rpc(method, params, attempt + 1);
  }
  return j.result;
}

export const getTx = (sig) => rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);

export async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: IS_PUBLIC ? 1 : n }, async () => {
    while (q.length) await fn(q.shift());
  }));
}
