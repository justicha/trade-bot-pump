#!/usr/bin/env node
// Volume Analyzer: анализирует кошелёк или токен (эвристики на данных обычного RPC).
//   node bots/volume-analyzer/analyzer.mjs wallet <address>
//   node bots/volume-analyzer/analyzer.mjs token <mint>
// Определяет: тип стратегии, multi-wallet кластеры (по общим transfer-получателям),
// launch-слот (эвристика), координированные exits, rapid buy-sell. Ограничения — в конце.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_URL } from "../../lib/config.mjs";
import { withBackoff } from "../../lib/retry.mjs";
import { COORDINATED_EXIT_MIN_WALLETS, JITO_TIP_ACCOUNTS } from "../../lib/constants.mjs";
import { fetchTxDetails as fetchTxDetailsCore } from "../../lib/analyzer-core.mjs";
// Jito tip accounts (excluded from cluster/transfer destinations).
const JITO_TIPS = new Set(JITO_TIP_ACCOUNTS);

// Own connection: disable web3.js built-in 429 retry so OUR retry (backoff+jitter) is the only one.
const connection = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: true });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY) || 3);

const [, , mode, address] = process.argv;
if (!mode || !address || !["wallet", "token"].includes(mode)) {
  console.log("Usage:");
  console.log("  node analyzer.mjs wallet <address>  — analyze wallet strategy");
  console.log("  node analyzer.mjs token <mint>       — analyze token traders");
  process.exit(1);
}

// ---- disk cache (processed results, incl. null/missing) ----
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "txcache");
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {} // best-effort; if it fails, cache writes fail (counted as cacheErrors)
// sig is a base58 signature from the RPC; reject any path separators so the cache stays in CACHE_DIR.
const safeSig = (sig) => typeof sig === "string" && !/[\\/]|\.\./.test(sig);
const cachePath = (sig) => (safeSig(sig) ? path.join(CACHE_DIR, `${sig}.json`) : null);
function readCache(sig) {
  try { const p = cachePath(sig); if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { stats.cacheErrors++; } // unreadable/corrupt entry -> treat as cache miss (counted in COVERAGE)
  return undefined;
}
// atomic write (tmp + rename): an interrupted run cannot leave a half-written, unparsable JSON file.
function writeCache(sig, val) {
  const p = cachePath(sig);
  if (!p) return;
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(val));
    fs.renameSync(tmp, p);
  } catch {
    stats.cacheErrors++; // write failed -> continue; the entry is simply re-fetched later (counted in COVERAGE)
    try { fs.rmSync(`${p}.tmp`, { force: true }); } catch {} // best-effort cleanup of the temp file
  }
}

const stats = { fetched: 0, cached: 0, missing: 0, errors: 0, retries: 0, pumpSwapTrades: 0, pswapUnresolved: 0, dupSuspect: 0, cacheErrors: 0 };
function log(m) { console.log(m); }
const fetchTxDetails = (sig, wallet = null) => fetchTxDetailsCore(sig, wallet, { getTx: getTxWithRetry, readCache, writeCache, stats, log });

// own retry (lib/retry.mjs, unit-tested). web3.js built-in retry is disabled above,
// so this is the only retry; onRetry feeds the COVERAGE retries counter.
const getTxWithRetry = (sig) =>
  withBackoff(() => connection.getTransaction(sig, { maxSupportedTransactionVersion: 1 }), { onRetry: () => stats.retries++ });
const getSigsWithRetry = (pk, opts) =>
  withBackoff(() => connection.getSignaturesForAddress(pk, opts), { onRetry: () => stats.retries++ });

// fetch up to `limit` items concurrently, preserving order
async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

function coverageLine() {
  log(`\n--- COVERAGE ---`);
  log(`  fetched=${stats.fetched} cached=${stats.cached} missing(pruned)=${stats.missing} errors=${stats.errors} retries=${stats.retries} pumpSwapTrades=${stats.pumpSwapTrades} pswapUnresolved=${stats.pswapUnresolved} dupSuspect=${stats.dupSuspect} cacheErrors=${stats.cacheErrors}`);
}

// ============================ WALLET ============================
async function analyzeWallet(addr) {
  log(`\n${"=".repeat(60)}`);
  log(`WALLET ANALYSIS: ${addr}`);
  log("=".repeat(60));

  let pk;
  try { pk = new PublicKey(addr); } catch { log(`Invalid address: ${addr}`); process.exit(1); }

  let sigs;
  try { sigs = await getSigsWithRetry(pk, { limit: 50 }); }
  catch (e) { log(`RPC error: ${e.message}`); process.exit(1); }

  log(`\nTransactions found: ${sigs.length}`);
  log(`  Successful: ${sigs.filter((s) => !s.err).length}`);
  log(`  Failed: ${sigs.filter((s) => s.err).length}`);

  const errorRate = sigs.length ? sigs.filter((s) => s.err).length / sigs.length : 0;
  if (errorRate > 0.5) log(`\n[!]  High error rate: ${(errorRate * 100).toFixed(0)}% — likely brute-force strategy`);

  const okSigs = sigs.filter((s) => !s.err).slice(0, 15);
  const detailsArr = await poolMap(okSigs, CONCURRENCY, (s) => fetchTxDetails(s.signature, addr));

  const trades = [];
  const programs = new Map();
  const tipDests = new Map();
  const cuPrices = [];
  let sample = 0;
  let evMatched = 0, addedDelta = 0, addedBuy = 0, addedSell = 0, feePayerExtra = 0;
  for (const d of detailsArr) {
    if (!d) continue;
    sample++;
    const wi = d.walletInfo;
    const deltaMintsSeen = new Set();
    for (const ev of d.events) {
      if (ev.type !== "trade") continue;
      if (ev.user === addr) {
        trades.push({ ...ev, slot: d.slot, time: d.time, src: "event" });
        evMatched++;
        if (wi) deltaMintsSeen.add(ev.mint);
      } else if (wi && Math.abs(wi.tokenDelta[ev.mint] || 0) > 1e-9) {
        const delta = wi.tokenDelta[ev.mint];
        const isBuy = delta > 0;
        trades.push({ mint: ev.mint, isBuy, solAmount: Math.abs(wi.solDelta || 0), slot: d.slot, time: d.time, src: "delta" });
        deltaMintsSeen.add(ev.mint);
        addedDelta++; if (isBuy) addedBuy++; else addedSell++;
      }
    }
    if (wi && wi.isFeePayer) {
      const anyOther = d.events.some((ev) => ev.type === "trade" && ev.user !== addr && !deltaMintsSeen.has(ev.mint));
      if (anyOther) feePayerExtra++;
    }
    for (const p of d.customPrograms) programs.set(p, (programs.get(p) || 0) + 1);
    for (const tip of d.tips) { const k = tip.to.slice(0, 12); tipDests.set(k, (tipDests.get(k) || 0) + 1); }
    if (d.cuPrice) cuPrices.push(d.cuPrice);
  }

  log("\n--- STRATEGY CLASSIFICATION ---");

  const buys = trades.filter((t) => t.isBuy);
  const sells = trades.filter((t) => t.isBuy === false);
  const mints = new Set(trades.map((t) => t.mint));
  const hasCustomProg = programs.size > 0;
  const medCU = cuPrices.length ? cuPrices.sort((a, b) => a - b)[Math.floor(cuPrices.length / 2)] : 0;
  const solIn = buys.reduce((s, t) => s + t.solAmount, 0);
  const solOut = sells.reduce((s, t) => s + t.solAmount, 0);
  const pnl = solOut - solIn;
  const tradeCount = buys.length + sells.length;

  log(`  Buys: ${buys.length}, Sells: ${sells.length}`);
  log(`  Trades: event.user matched=${evMatched}, added via token-delta=${addedDelta} (buy ${addedBuy}/sell ${addedSell}), fee-payer-only=${feePayerExtra}`);
  log(`  SOL in: ${solIn.toFixed(4)}, SOL out: ${solOut.toFixed(4)}`);
  log(`  PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL  (выборка ${sample} tx из ${sigs.length} sigs)`);
  log(`  Unique mints: ${mints.size}`);
  log(`  Median CU price: ${medCU.toLocaleString()} µlamports/CU`);
  log(`  Error rate: ${(errorRate * 100).toFixed(0)}%`);

  if (programs.size) {
    log(`\n  Custom programs:`);
    for (const [prog, count] of [...programs.entries()].sort((a, b) => b[1] - a[1])) log(`    ${prog.slice(0, 20)}… (${count}x)`);
  }
  if (tipDests.size) {
    log(`\n  Tip destinations (Jito):`);
    for (const [dest, count] of [...tipDests.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) log(`    ${dest}… (${count}x)`);
  }

  let strategy;
  if (errorRate > 0.8) strategy = "BRUTE_FORCE — спамит транзакциями, >80% фейлятся";
  else if (tradeCount === 0) strategy = "NO_TRADES — нет pump.fun сделок в выборке";
  else if (buys.length === 0 && sells.length > 0) strategy = "SELL_ONLY (в выборке) — возможно pre-loaded / другой кошелёк";
  else if (sells.length === 0 && buys.length > 0) strategy = "BUY_ONLY (в выборке) — holding / выход в другом месте";
  else if (hasCustomProg) {
    strategy = programs.size === 1
      ? `CUSTOM_BOT — собственная программа ${[...programs.keys()][0].slice(0, 16)}…`
      : "MULTI_PROGRAM — несколько нестандартных программ";
  }
  else if (medCU === 0 && tradeCount >= 3) strategy = "DIRECT_HIGHFREQ — без CU price, приоритет через bundle/landing";
  else strategy = "DIRECT_TRADER — прямой трейдер";

  const confidence = sample >= 15 ? "medium" : sample >= 7 ? "low" : "very low";
  log(`\n  >>> STRATEGY: ${strategy}`);
  log(`      (sample: ${sample} tx, confidence: ${confidence})`);

  if (trades.length) {
    log("\n--- RECENT TRADES ---");
    for (const t of trades.slice(0, 10)) {
      const time = t.time ? new Date(t.time * 1000).toISOString().slice(11, 19) : "?";
      log(`  ${time} | ${t.isBuy ? "BUY " : "SELL"} | ${t.solAmount.toFixed(4)} SOL | ${t.mint.slice(0, 12)}…`);
    }
  }
  coverageLine();
}

// ============================ TOKEN ============================
async function getSignaturesPaged(pk, maxSigs = 1000) {
  const out = [];
  let before;
  while (out.length < maxSigs) {
    const need = Math.min(1000, maxSigs - out.length);
    let batch;
    try { batch = await getSigsWithRetry(pk, { limit: need, before }); }
    catch (e) { log(`  RPC error (signatures): ${e.message}`); break; }
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < need) break; // reached the oldest available
    before = batch[batch.length - 1].signature;
  }
  return out;
}

async function analyzeToken(mint) {
  log(`\n${"=".repeat(60)}`);
  log(`TOKEN ANALYSIS: ${mint}`);
  log("=".repeat(60));

  let pk;
  try { pk = new PublicKey(mint); } catch { log(`Invalid mint: ${mint}`); process.exit(1); }

  const sigs = await getSignaturesPaged(pk, 1000);
  log(`\nSignatures scanned: ${sigs.length} (depth cap 1000 — launch slot точный только если токенов < cap)`);

  const ok = sigs.filter((s) => !s.err);
  const window = ok.slice(-30); // oldest 30 => район запуска (getSignaturesForAddress идёт новое->старое)
  const detailsArr = await poolMap(window, CONCURRENCY, (s) => fetchTxDetails(s.signature));

  const traders = new Map(); // user -> { buys, sells, solIn, solOut, dests:Set }
  const timeline = [];
  let createInfo = null;

  for (const d of detailsArr) {
    if (!d) continue;
    const dests = d.transferDests.map(([dest]) => dest);
    for (const ev of d.events) {
      if (ev.type === "create" && !createInfo) createInfo = { ...ev, slot: d.slot };
      if (ev.type === "trade") {
        const key = ev.user;
        if (!traders.has(key)) traders.set(key, { buys: 0, sells: 0, solIn: 0, solOut: 0, dests: new Set() });
        const t = traders.get(key);
        if (ev.isBuy) { t.buys++; t.solIn += ev.solAmount; } else { t.sells++; t.solOut += ev.solAmount; }
        for (const dest of dests) t.dests.add(dest);
        timeline.push({ time: d.time, slot: d.slot, user: ev.user, isBuy: ev.isBuy, sol: ev.solAmount });
      }
    }
  }

  if (createInfo) {
    log(`\n  Creator: ${createInfo.creator}`);
    log(`  Name: ${createInfo.name} (${createInfo.symbol})`);
  }
  log(`  Unique traders: ${traders.size}`);

  const sorted = [...traders.entries()]
    .map(([addr, t]) => ({ addr, ...t, pnl: t.solOut - t.solIn }))
    .sort((a, b) => b.pnl - a.pnl);

  log("\n--- TOP TRADERS BY PNL ---");
  for (const t of sorted.slice(0, 15)) {
    log(`  ${t.addr.slice(0, 16)} | B:${t.buys} S:${t.sells} | PnL:${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(4)}`);
  }

  log("\n--- PATTERN DETECTION ---");

  const firstSlot = timeline.length ? Math.min(...timeline.map((t) => t.slot)) : null;
  const sameSlot = firstSlot == null ? [] : timeline.filter((t) => t.slot === firstSlot);
  if (sameSlot.length > 1) {
    log(`  [!]  ${sameSlot.length} сделок в launch-слоте (+0) — это может быть бандл ИЛИ конкурирующие снайперы:`);
    for (const t of sameSlot.slice(0, 8)) log(`    ${t.user.slice(0, 12)} ${t.isBuy ? "BUY" : "SELL"} ${t.sol.toFixed(4)} SOL`);
  }

  const sellOnly = sorted.filter((t) => t.buys === 0 && t.sells > 0);
  if (sellOnly.length) {
    log(`\n  [!]  ${sellOnly.length} sell-only кошельков в выборке (bought раньше / pre-loaded — не гарантия):`);
    for (const t of sellOnly.slice(0, 5)) log(`    ${t.addr.slice(0, 16)} → ${t.solOut.toFixed(4)} SOL out`);
  }

  const rapid = [];
  for (const [addr, t] of traders) {
    if (t.buys > 0 && t.sells > 0) {
      const ut = timeline.filter((x) => x.user === addr).sort((a, b) => a.slot - b.slot);
      for (let i = 1; i < ut.length; i++) {
        const gap = ut[i].slot - ut[i - 1].slot;
        if (gap <= 2 && ut[i].isBuy !== ut[i - 1].isBuy) { rapid.push({ addr, gap }); break; }
      }
    }
  }
  if (rapid.length) {
    log(`\n  [!]  ${rapid.length} кошельков с rapid buy-sell (<3 слотов) — быстрый скальп/MEV (не обязательно wash):`);
    for (const t of rapid.slice(0, 5)) log(`    ${t.addr.slice(0, 16)} (${t.gap} slot gap)`);
  }

  // Coordinated exits: >=3 разных кошелька продают в одном слоте
  const sellsBySlot = new Map();
  for (const t of timeline) {
    if (t.isBuy) continue;
    if (!sellsBySlot.has(t.slot)) sellsBySlot.set(t.slot, new Set());
    sellsBySlot.get(t.slot).add(t.user);
  }
  const coordinated = [...sellsBySlot.entries()].filter(([, s]) => s.size >= COORDINATED_EXIT_MIN_WALLETS).sort((a, b) => b[1].size - a[1].size);
  if (coordinated.length) {
    log(`\n  [!]  Координированные exits (>=3 кошелька продают в одном слоте):`);
    for (const [slot, set] of coordinated.slice(0, 5)) log(`    slot ${slot}: ${set.size} кошельков`);
  }

  // Дешёвая кластеризация: общие transfer-получатели (не Jito — они у всех одинаковые)
  const destUsers = new Map();
  for (const [user, t] of traders) {
    for (const dest of t.dests) {
      if (JITO_TIPS.has(dest)) continue;
      if (!destUsers.has(dest)) destUsers.set(dest, new Set());
      destUsers.get(dest).add(user);
    }
  }
  // shared by a SUBSET of traders, not all — the bonding-curve/fee recipient is shared by
  // everyone trading the same token, so it is NOT a meaningful cluster.
  const traderCount = traders.size;
  const clusters = [...destUsers.entries()]
    .filter(([, s]) => s.size >= 2 && s.size < traderCount)
    .sort((a, b) => b[1].size - a[1].size);
  if (clusters.length) {
    log(`\n  [!]  Кластеры кошельков по общим transfer-получателям:`);
    for (const [dest, set] of clusters.slice(0, 5)) log(`    → ${dest.slice(0, 16)}… : ${[...set].map((u) => u.slice(0, 8)).join(",")}`);
  }

  log("\n--- TRADE TIMELINE (first 20) ---");
  const sortedTimeline = [...timeline].sort((a, b) => a.slot - b.slot);
  for (const t of sortedTimeline.slice(0, 20)) {
    const time = t.time ? new Date(t.time * 1000).toISOString().slice(11, 19) : "?";
    const off = firstSlot == null ? 0 : t.slot - firstSlot;
    log(`  +${String(off).padStart(5)} | ${time} | ${t.user.slice(0, 12)} | ${t.isBuy ? "BUY " : "SELL"} | ${t.sol.toFixed(4)} SOL`);
  }

  log(`\n--- LIMITS (обычный RPC) ---`);
  log(`  • bundle vs competing snipers: одним слотом не различить — нужен getBlock/Jito API`);
  log(`  • coordinated exits/кластеры — эвристика по слоту/получателям, не доказывает связь`);
  log(`  • PumpSwap(AMM): события парсятся (base, quote с комиссиями, user, mint через user_base_token_account); неразрешённые считаются в COVERAGE как pswapUnresolved`);
  coverageLine();
}

if (mode === "wallet") await analyzeWallet(address);
else await analyzeToken(address);




