#!/usr/bin/env node
// Research collector: one WS stream -> all strategy variants in parallel, dry-run only.
//
// This bot NEVER trades and never loads a wallet: it only watches the pump.fun log stream,
// marks prices to market from the trade events, and writes two kinds of data:
//   data/research/candidates.jsonl      — every observed token: features at decision time,
//                                          every variant's decision + reject reason, and the
//                                          price at +30/60/120/300 s after the create
//   data/research/variants/<name>.jsonl — closed paper trades per variant (with costs)
//
// Usage: node bots/research/lab.mjs        (refuses --live on purpose)
import { PublicKey } from "@solana/web3.js";
import {
  PUMP_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import { log as logger } from "../../lib/logger.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import { HolderTracker } from "../../lib/holders.mjs";
import { StrategyLab, buildVariants } from "../../lib/strategy.mjs";
import { checkCurve } from "../../lib/curve.mjs";
import { TradeJournal } from "../../lib/journal.mjs";
import { ROOT } from "../../lib/config.mjs";
import { CurveConsistency } from "../../lib/consistency.mjs";
import { formatStatus } from "../../lib/status.mjs";
import fs from "node:fs";
import path from "node:path";

if (process.argv.includes("--live")) {
  console.error("lab.mjs is dry-run only: it never sends transactions. Remove --live.");
  process.exit(1);
}

// ---- config (all optional) --------------------------------------------------
const BUY_SOL = Number(process.env.LAB_BUY_SOL || 0.02);
const MIN_HOLDERS = Number(process.env.LAB_MIN_HOLDERS || 4);
const MIN_SLOTS = Number(process.env.LAB_MIN_SLOTS || 2);
const MIN_DELAY_MS = Number(process.env.LAB_MIN_DELAY_MS || 2500);
const WAIT_SEC = Number(process.env.LAB_WAIT_SEC || 45);
const SAMPLE_SECS = (process.env.LAB_SAMPLES || "30,60,120,300").split(",").map(Number).filter((n) => n > 0);
const KEEP_SEC = Math.max(...SAMPLE_SECS, 10) + 20; // keep the token until the last sample landed

const outDir = path.join(ROOT, "data", "research");
const varDir = path.join(outDir, "variants");
fs.mkdirSync(varDir, { recursive: true });

// Optional global overrides for every variant (handy for short experiments):
//   LAB_TAKE_PROFIT=2 LAB_STOP_LOSS=0.5 LAB_TIMEOUT_SEC=30
const globalOverrides = {};
if (process.env.LAB_TAKE_PROFIT) globalOverrides.takeProfit = Number(process.env.LAB_TAKE_PROFIT);
if (process.env.LAB_STOP_LOSS) globalOverrides.stopLoss = Number(process.env.LAB_STOP_LOSS);
if (process.env.LAB_TIMEOUT_SEC) globalOverrides.timeoutSec = Number(process.env.LAB_TIMEOUT_SEC);
if (process.env.LAB_TIME_STOP_SEC) globalOverrides.timeStopSec = Number(process.env.LAB_TIME_STOP_SEC);

// Execution latency: a fill happens at the first price at least LAB_LATENCY_MS after the
// decision. LAB_LATENCY_GRID runs the whole matrix at several latencies (names become A@600).
const LATENCY_MS = Number(process.env.LAB_LATENCY_MS || 600);
const LATENCY_GRID = (process.env.LAB_LATENCY_GRID || "")
  .split(",")
  .map((x) => Number(x))
  .filter((x) => Number.isFinite(x) && x >= 0);

const candidates = new TradeJournal({ bot: "lab", dir: outDir });
const journals = new Map(); // variant -> TradeJournal
const baseVariants = buildVariants({}, globalOverrides);
const variants = LATENCY_GRID.length
  ? LATENCY_GRID.flatMap((ms) => baseVariants.map((v) => ({ ...v, name: `${v.name}@${ms}`, latencyMs: ms })))
  : baseVariants;
for (const cfg of variants) {
  journals.set(cfg.name, new TradeJournal({ bot: cfg.name, dir: varDir }));
}

// A token whose own state is implausible must be recorded, not traded.
const lab = new StrategyLab({ variants, buySol: BUY_SOL, latencyMs: LATENCY_MS });
lab.onEvent = (ev) => {
  if (ev.type === "exit") {
    const tok = tokens.get(ev.mint);
    closed.set(ev.variant, (closed.get(ev.variant) || 0) + 1);
    journals.get(ev.variant)?.trade({
      ...ev,
      createTs: tok?.createTs ?? null,
      priceAnomaly: tok?.anomaly ?? null,
    });
    if (tok) tok.exitedBy.add(ev.variant);
  } else if (ev.type === "entry") {
    const tok = tokens.get(ev.mint);
    if (tok) {
      tok.enteredBy.add(ev.variant);
      if (tok.decisionTs === null) tok.decisionTs = ev.ts;
    }
  }
};

const consistency = new CurveConsistency(); // x*y=k guard for event snapshots
const tracker = new HolderTracker({ minHolders: MIN_HOLDERS, waitMs: WAIT_SEC * 1000, minSlots: MIN_SLOTS, minDelayMs: MIN_DELAY_MS });
const tokens = new Map(); // mint -> research record
const creators = new Map(); // creator -> launches seen in this session

function log(msg) {
  logger.info(msg);
}

// V3 trade event: shared parser (lib/events.mjs) — offsets verified against the on-chain
// account by scripts/dump-layout.mjs; payloads without a reserve snapshot are marked.
function parseEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  let state = null;
  if (data.length >= 113) {
    state = {
      virtualSolReserves: data.readBigUInt64LE(97),
      virtualTokenReserves: data.readBigUInt64LE(105),
      complete: false,
    };
  }
  return { mint, solAmount, tokenAmount, user, state };
}

function parseLogs(logs) {
  let isBuy = false;
  let isSell = false;
  let isCreate = false;
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (!m) continue;
    if (BUY_INSTRUCTIONS.has(m[1])) isBuy = true;
    if (SELL_INSTRUCTIONS.has(m[1])) isSell = true;
    if (CREATE_INSTRUCTIONS.has(m[1])) isCreate = true;
  }
  const events = [];
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    let raw;
    try {
      raw = Buffer.from(line.slice(14), "base64");
    } catch {
      continue;
    }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    const ev = parseEvent(raw);
    if (ev) events.push({ ...ev, isBuy, isSell, isCreate });
  }
  return { events, isCreate, isBuy, isSell };
}

// ---- token bookkeeping ------------------------------------------------------
function ensureToken(mint, { creator = null, ts = Date.now(), slot = null, price = null } = {}) {
  let t = tokens.get(mint);
  if (!t) {
    t = {
      mint,
      creator,
      createTs: ts,
      createSlot: slot,
      createPrice: price,
      lastPrice: price,
      lastTs: ts,
      maxPrice: price,
      anomaly: null,
      samples: {},
      enteredBy: new Set(),
      exitedBy: new Set(),
      decisionTs: null,
      dropped: null,
    };
    tokens.set(mint, t);
    if (creator) creators.set(creator, (creators.get(creator) || 0) + 1);
  }
  if (creator && !t.creator) t.creator = creator;
  return t;
}

function priceOf(mint) {
  return tokens.get(mint)?.lastPrice ?? null;
}

function rejectReason(t, cfg) {
  if (t.enteredBy.has(cfg.name)) return null;
  if (t.anomaly) return `price anomaly: ${t.anomaly}`;
  if (cfg.entry === "create") return "not entered (no create-entry for this variant)";
  const snap = t.featuresSnap || tracker.features(t.mint);
  const buyers = snap?.uniqueBuyers ?? 0;
  const slots = snap?.buySlots ?? 0;
  const ms = snap?.msToReady;
  if (buyers < cfg.minHolders) return `buyers ${buyers}<${cfg.minHolders}`;
  if (slots < cfg.minSlots) return `single-slot bundle (${slots})`;
  if (ms !== null && ms < cfg.minDelayMs) return `instant crowd ${ms}ms<${cfg.minDelayMs}`;
  if (t.dropped === "wait") return `not ready within ${WAIT_SEC}s`;
  return "no entry";
}

function writeCandidate(t) {
  const anomaly = t.createPrice ? null : t.pendingAnomaly || "no parseable price";
  const featuresSnap = t.featuresSnap || tracker.features(t.mint) || null;
  const canary = t.createPrice ? (p) => Math.round((p / t.createPrice) * 1e4) / 1e4 : () => null;
  candidates.write({
    type: "candidate",
    mint: t.mint,
    creator: t.creator,
    creatorRuns: t.creator ? creators.get(t.creator) : null,
    createTs: t.createTs,
    createSlot: t.createSlot,
    createPrice: t.createPrice,
    maxRatioAfterCreate: canary(t.maxPrice),
    priceSamples: Object.fromEntries(Object.entries(t.samples).map(([k, v]) => [k, canary(v)])),
    anomaly,
    features: featuresSnap,
    decisions: variants.map((cfg) => ({
      variant: cfg.name,
      action: t.enteredBy.has(cfg.name) ? "buy" : "skip",
      reason: rejectReason({ ...t, anomaly, featuresSnap }, cfg),
    })),
    enteredBy: [...t.enteredBy],
    exitedBy: [...t.exitedBy],
  });
}
// ---- stream ----------------------------------------------------------------
process.on("unhandledRejection", (e) => log(`unhandled rejection (ignored): ${e?.message || e}`));

const ws = new SolanaWs();
await ws.connect();

log("=== STRATEGY LAB (dry-run, no wallet, no transactions) ===");
log(`Variants: ${variants.map((v) => v.name).join(", ")}  (buy ${BUY_SOL} SOL each)`);
log(`Organic: >=${MIN_HOLDERS} buyers, >=${MIN_SLOTS} slots, >=${MIN_DELAY_MS}ms after create; wait ${WAIT_SEC}s`);
log("Output: data/research/candidates.jsonl + data/research/variants/*.jsonl");

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), async (result) => {
  const slot = result?.context?.slot ?? null;
  const { value } = result;
  if (!value?.logs) return;
  const last = value.logs[value.logs.length - 1] || "";
  if (!last.includes("success")) return;

  const { events, isCreate } = parseLogs(value.logs);
  if (!events.length) return;
  const now = Date.now();

  for (const ev of events) {
    let price = null;
    let anomaly = null;
    if (ev.state) {
      const chk = checkCurve(ev.state, { buySol: BUY_SOL });
      if (chk.ok) {
        // x*y=k must match what we know about this mint: measured drift is 0 ppm for 405/403
        // payloads but 45-52% for 390/391 (see scripts/verify-invariants.mjs).
        const cons = consistency.check(ev.mint, ev.state.virtualSolReserves, ev.state.virtualTokenReserves);
        if (cons.ok) price = chk.price;
        else anomaly = `inconsistent snapshot: ${cons.reason}`;
      } else anomaly = chk.reason;
    }

    // A bad payload on an already-priced token (many sell/router events carry reserves we
    // cannot trust) must not kill the whole token: keep the last good price instead.
    const known = tokens.get(ev.mint);
    if (!price && known && known.lastPrice) price = known.lastPrice;

    if (anomaly && !price) {
      const t = ensureToken(ev.mint, { ts: now, slot, price });
      if (!t.anomaly) {
        t.anomaly = anomaly;
        log(`ANOMALY ${ev.mint.slice(0, 8)}: ${anomaly} (vSol=${ev.state?.virtualSolReserves} vTok=${ev.state?.virtualTokenReserves})`);
      }
    }

    if (isCreate && ev.isCreate) {
      const t = ensureToken(ev.mint, { creator: ev.user, ts: now, slot, price });
      // Many create payloads carry reserve fields we cannot trust. Do not condemn the token:
      // anchor its price on the first event that parses cleanly and only mark it anomalous if
      // no valid price ever shows up.
      if (anomaly && !t.pendingAnomaly) t.pendingAnomaly = anomaly;
      tracker.track(ev.mint, { at: now, slot, creator: ev.user });
      lab.onCreate({
        mint: ev.mint,
        creator: ev.user,
        ts: now,
        price: price ?? 0,
        ctx: { holders: 0, slots: 0, buyers: 0, createTs: now },
      });
      continue;
    }

    const t = ensureToken(ev.mint, { ts: now, slot, price });
    if (price) {
      if (!t.createPrice) t.createPrice = price; // first trustworthy price = anchor
      t.lastPrice = price;
      t.lastTs = now;
      t.anomaly = null;
      if (!t.maxPrice || price > t.maxPrice) t.maxPrice = price;
    }

    const isBuy = ev.isBuy && !ev.isSell;
    const snap = tracker.apply(ev.mint, ev.user, isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: now, slot });
    if (snap && price) {
      lab.onTrade({
        mint: ev.mint,
        creator: t.creator,
        ts: now,
        price,
        isBuy,
        user: ev.user,
        organic: tracker.organic(snap),
        freshPrice: Boolean(price) && !anomaly,
        ctx: { ...snap, createTs: t.createTs, entryGroup: [] },
      });
    }
  }
});

// ---- status / resume -------------------------------------------------------
import("../../lib/journal.mjs").then(() => {});
const TARGET_TRADES = Number(process.env.LAB_TARGET_TRADES || 1000);
const startedAt = Date.now();
const closed = new Map(variants.map((v) => [v.name, 0]));

function statusLine() {
  log(formatStatus({ closed, startedAt, target: TARGET_TRADES }));
}

const statusLineTimer = setInterval(statusLine, 10 * 60 * 1000);

// 1s timer: time-based exits, price samples at +30/60/120/300s, tracker pruning, flush
const tickTimer = setInterval(() => {
  const now = Date.now();
  lab.onTick({ ts: now, priceOf });

  // A mint is pruned only when no variant still holds an open position on it: deleting the entry
  // freezes priceOf -> null, and an open paper position could then never exit (stuck forever).
  const openMints = lab.openMints();
  for (const [mint, t] of tokens) {
    const ageSec = (now - t.createTs) / 1000;
    for (const s of SAMPLE_SECS) {
      if (ageSec >= s && t.samples[s] === undefined) t.samples[s] = t.lastPrice;
    }
    if (ageSec > KEEP_SEC && !openMints.has(mint)) {
      writeCandidate(t);
      tokens.delete(mint);
    }
  }

  for (const d of tracker.prune(now)) {
    const t = tokens.get(d.mint);
    if (t) {
      if (!t.dropped) t.dropped = d.ready ? "blocked" : "wait";
      t.featuresSnap = d.features; // keep the decision-time features for candidates.jsonl
    }
    // counters at DECISION time, so the message can never contradict itself
    const why = d.ready
      ? `ready at ${d.holdersAtReady} holders but never entered (${d.blocked || "no slot"})`
      : `${d.holders} holders < ${MIN_HOLDERS}`;
    log(`drop ${d.mint.slice(0, 8)}: ${why} after ${Math.round(d.waitedMs / 1000)}s`);
  }
}, 1000);

process.on("SIGINT", async () => {
  clearInterval(tickTimer);
  clearInterval(statusLineTimer);
  log("\nFlushing candidates...");
  for (const [, t] of tokens) writeCandidate(t);
  await ws.close().catch(() => {});
  log(`Done. ${variants.length} variants, journals in data/research/variants/`);
  process.exit(0);
});


