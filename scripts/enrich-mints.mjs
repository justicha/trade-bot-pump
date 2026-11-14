#!/usr/bin/env node
// Read-only research tool: "who is behind the token" for historical pump.fun mints.
//
//   node scripts/enrich-mints.mjs --in agents/BROWSER_BATCH_1.txt [--in ...] --out agents/enrich-1.jsonl
//        [--max-pages 40] [--mint-max-pages 200] [--prior-cap 300] [--concurrency 2] [--rps N] [--retry-errors | --retry-match <regex>] [--record <dir>]
//
// Input lines: "<n>  <mint>  <YYYY-MM-DD HH:MM:SS>" (entry time UTC) or a bare mint per line.
// One JSON line per mint (see lib/enrich.mjs, emptyRow). Resumable: mints already in --out are
// skipped; with --retry-errors a mint whose line has errors is re-run (the old line is dropped from
// --out first, a copy of the old file is kept as <out>.bak). RPC: getSignaturesForAddress / getTransaction / getAccountInfo only, through the shared
// rate limiter (lib/ratelimit via lib/rpc rpcCall) with retries; plus one HTTP GET per mint for the
// metadata JSON. No keypair is loaded, nothing is signed or sent, the RPC URL is never printed.
// --record <dir> writes every RPC answer of a mint (compact, public keys only) to <dir>/<mint>.json
// so tests can replay the mint offline.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv.includes("--live")) {
  console.error("enrich-mints is read-only; --live is not accepted.");
  process.exit(2);
}
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const ins = argv.flatMap((a, i) => (a === "--in" && argv[i + 1] ? [argv[i + 1]] : []));
const outPath = opt("--out");
const maxPages = Number(opt("--max-pages", 40));
const priorCap = Number(opt("--prior-cap", 300));
const mintMaxPages = Number(opt("--mint-max-pages", 200));
const concurrency = Math.max(1, Number(opt("--concurrency", 2)));
const recordDir = opt("--record");
const rps = opt("--rps");
const retryErrors = argv.includes("--retry-errors");
// --retry-match <regex>: like --retry-errors, but only lines with an error matching the regex
const retryMatchSrc = opt("--retry-match");
const retryMatch = retryMatchSrc ? new RegExp(retryMatchSrc) : null;
const retrying = retryErrors || Boolean(retryMatch);
if (rps) process.env.RPC_MAX_RPS = String(rps); // before lib/rpc creates the limiter

if (!ins.length || !outPath || !Number.isFinite(maxPages) || !Number.isFinite(priorCap) || !Number.isFinite(mintMaxPages)) {
  console.error("Usage: node scripts/enrich-mints.mjs --in <file> [--in <file> ...] --out <file.jsonl> [--max-pages 40] [--mint-max-pages 200] [--prior-cap 300] [--concurrency 2] [--rps N] [--retry-errors | --retry-match <regex>] [--record <dir>]");
  process.exit(1);
}

const { PublicKey } = await import("@solana/web3.js");
const { connection, rpcCall } = await import("../lib/rpc.mjs");
const E = await import("../lib/enrich.mjs");
const { isRetryable } = await import("../lib/retry.mjs");
const SLOW_RETRY_MS = [2000, 4000, 8000, 15000, 30000, 30000];

// ---- input / resume ----
const rows = [];
for (const f of ins) {
  const { rows: r, bad } = E.parseInputText(fs.readFileSync(f, "utf8"));
  for (const b of bad) console.error(`[input] ${f}:${b.line} unparseable: ${b.text}`);
  rows.push(...r);
}
const seen = new Set();
const unique = rows.filter((r) => (seen.has(r.mint) ? false : (seen.add(r.mint), true)));
const prevText = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
const kept = E.keptLines(prevText, { retryErrors, retryMatch });
const done = new Set(kept.map((k) => k.mint));
const todo = unique.filter((r) => !done.has(r.mint));
// Only drop old lines of mints that will be re-run in THIS invocation; errored lines of mints not in
// --in stay untouched.
const rerun = new Set(todo.map((r) => r.mint));
const all = E.keptLines(prevText, { retryMatch, keepAll: true }); // last line per mint, hasErrors per the mode
const dropped = retrying ? all.filter((k) => k.hasErrors && rerun.has(k.mint)).length : 0;
if (dropped > 0) {
  fs.copyFileSync(outPath, outPath + ".bak");
  const keep = all.filter((k) => !(k.hasErrors && rerun.has(k.mint)));
  fs.writeFileSync(outPath, keep.map((k) => `${k.line}\n`).join(""));
}
console.log(`[enrich] ${unique.length} mints, ${done.size} done in ${path.basename(outPath)}${retrying ? `, ${dropped} errored lines dropped for re-run` : ""}, ${todo.length} to do; concurrency ${concurrency}`);

// ---- read-only RPC adapter (per mint: own tx cache and call counter) ----
function makeRpc() {
  const stats = { calls: 0, sigPages: 0, txs: 0, accounts: 0, slowRetries: 0 };
  const cache = new Map();
  const rec = recordDir ? { sigs: {}, txs: {}, accounts: {} } : null;
  // rpcCall already retries with a short backoff; a research run can afford to wait much longer on
  // a throttled endpoint instead of writing a row full of 429 errors.
  const call = async (fn) => {
    stats.calls += 1;
    for (let a = 0; ; a++) {
      try {
        return await rpcCall(fn, { priority: 3, retries: 3 });
      } catch (e) {
        if (a >= SLOW_RETRY_MS.length || !isRetryable(e)) throw e;
        stats.slowRetries += 1;
        await new Promise((r) => setTimeout(r, SLOW_RETRY_MS[a]));
      }
    }
  };
  return {
    stats,
    rec,
    async getSignatures(address, { before, until, limit }) {
      stats.sigPages += 1;
      const page = await call(() => connection.getSignaturesForAddress(new PublicKey(address), until ? { before, until, limit } : { before, limit }));
      const out = page.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err ? true : false }));
      if (rec) (rec.sigs[address] ??= []).push(...out);
      return out;
    },
    async getTransaction(sig) {
      if (cache.has(sig)) return cache.get(sig);
      stats.txs += 1;
      const resp = await call(() => connection.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
      const tx = E.normalizeTx(resp, sig);
      cache.set(sig, tx);
      if (rec) rec.txs[sig] = tx;
      return tx;
    },
    async getAccountInfo(address) {
      stats.accounts += 1;
      const a = await call(() => connection.getAccountInfo(new PublicKey(address)));
      const out = a ? { owner: a.owner.toBase58(), data: Buffer.from(a.data) } : null;
      if (rec) rec.accounts[address] = out ? { owner: out.owner, data: out.data.toString("base64") } : null;
      return out;
    },
  };
}

// Recording: the mint's signature list is trimmed to the slots actually fetched, which keeps the
// fixture small and is still a consistent (shorter) history for the offline replay.
function writeRecord(input, rpc, row, jsons) {
  const r = rpc.rec;
  const mintTxSlots = Object.values(r.txs).filter((t) => t && t.events.length && E.txEvents(t).some((e) => e.mint === input.mint)).map((t) => t.slot);
  const maxSlot = mintTxSlots.length ? Math.max(...mintTxSlots) : Infinity;
  const sigs = { ...r.sigs };
  if (sigs[input.mint]) sigs[input.mint] = sigs[input.mint].filter((s) => s.slot <= maxSlot);
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, `${input.mint}.json`), JSON.stringify({ input, sigs, txs: r.txs, accounts: r.accounts, json: jsons, row }));
}

// ---- run ----
const t0 = Date.now();
let next = 0;
let finished = 0;
const out = fs.openSync(outPath, "a");
async function worker() {
  while (next < todo.length) {
    const input = todo[next++];
    const rpc = makeRpc();
    const jsons = {};
    const fetchJson = async (url) => {
      const j = await E.fetchJsonWithFallback(url);
      jsons[url] = j;
      return j;
    };
    const t = Date.now();
    let row;
    try {
      row = await E.enrichMint(input, { rpc, fetchJson, maxPages, mintMaxPages, priorCap });
    } catch (e) {
      row = { ...E.emptyRow(input), errors: [`fatal: ${E.shortErr(e)}`] };
    }
    row.rpcCalls = rpc.stats.calls;
    row.elapsedSec = Math.round((Date.now() - t) / 100) / 10;
    fs.writeSync(out, JSON.stringify(row) + "\n");
    if (rpc.rec) writeRecord(input, rpc, row, jsons);
    finished += 1;
    console.log(
      `[enrich] ${finished}/${todo.length} n=${input.n ?? "-"} ${input.mint.slice(0, 8)}… ${row.elapsedSec}s calls=${row.rpcCalls}` +
        ` (sigPages ${rpc.stats.sigPages}, txs ${rpc.stats.txs}, slow retries ${rpc.stats.slowRetries}) prior=${row.creatorPriorTokens ?? "?"}${row.priorTokensIsLowerBound ? "+" : ""}` +
        ` age=${row.creatorAgeDays ?? "?"}d errors=${row.errors.length ? row.errors.join("; ") : "-"}`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
fs.closeSync(out);
console.log(`[enrich] done ${finished} mints in ${Math.round((Date.now() - t0) / 1000)} s`);
