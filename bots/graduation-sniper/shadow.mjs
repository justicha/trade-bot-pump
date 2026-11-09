#!/usr/bin/env node
// Graduation shadow lab (DRY RUN ONLY): one candidate stream, one virtual wallet per variant.
//
// It never sends a transaction. It follows pump.fun trade events, turns every mint that reaches
// MIN_FILL% of REAL reserves into a candidate, and lets each variant decide whether to "enter".
// Entries/exits are priced pessimistically (200-800 ms delay, size slippage, 1%+1% pump fees,
// priority + tx fee) through lib/pessimistic.mjs; every trade is journaled for
// scripts/analyze-graduation.mjs.
//
//   node bots/graduation-sniper/shadow.mjs               # until Ctrl+C
//   $env:SHADOW_MAX_SEC='60'; node bots/graduation-sniper/shadow.mjs
//
// Variant I (enter after migration) needs an AMM price source this stream does not carry, so it
// reports "no data" instead of inventing a price.
import { PublicKey } from "@solana/web3.js";
import { LIVE } from "../../lib/config.mjs";
import { PUMP_PROGRAM, TRADE_EVENT_PREFIX, BUY_INSTRUCTIONS } from "../../lib/constants.mjs";
import { gradFillPct } from "../../lib/curve.mjs";
import { previewExit } from "../../lib/exec.mjs";
import { getBondingCurveState } from "../../lib/pumpfun.mjs";
import { pessimisticRoundTrip, sizeSlippageBps } from "../../lib/pessimistic.mjs";
import { TradeJournal } from "../../lib/journal.mjs";
import { SolanaWs } from "../../lib/ws.mjs";

if (LIVE) {
  console.error("[shadow] refuses to run with --live: this is a paper lab.");
  process.exit(1);
}

const MIN_FILL = Number(process.env.MIN_FILL || 92);
const BUY_SOL = Number(process.env.SHADOW_BUY_SOL || 0.02);
const SL = Number(process.env.SHADOW_SL || 0.7);
const HOLD_MS = Number(process.env.SHADOW_HOLD_SEC || 300) * 1000;
const MAX_SEC = Number(process.env.SHADOW_MAX_SEC || 0);
const journal = new TradeJournal({ bot: "graduation-shadow" });

const VARIANTS = {
  A: { label: "baseline", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.5 },
  B: { label: "MIN_HOLDERS 7", minHolders: 7, maxFill: 100, exitCheck: false, tp: 1.5 },
  C: { label: "MIN_HOLDERS 15", minHolders: 15, maxFill: 100, exitCheck: false, tp: 1.5 },
  D: { label: "MAX_FILL 95", minHolders: 0, maxFill: 95, exitCheck: false, tp: 1.5 },
  E: { label: "MAX_FILL 97", minHolders: 0, maxFill: 97, exitCheck: false, tp: 1.5 },
  F: { label: "exit check >=0.9", minHolders: 0, maxFill: 100, exitCheck: true, tp: 1.5 },
  G: { label: "B+E+F", minHolders: 7, maxFill: 97, exitCheck: true, tp: 1.5 },
  H: { label: "TP 1.3", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.3 },
  I: { label: "enter after migration", postMigration: true, tp: 1.5 },
};

const mintState = new Map(); // mint -> { buyers:Set, entered:Set, fill, rSol, price, vsol, vtok }
const open = new Map(); // `${variant}:${mint}` -> position

function parseEvent(data) {
  if (data.length < 129) return null;
  try {
    return {
      mint: new PublicKey(data.subarray(8, 40)).toBase58(),
      user: new PublicKey(data.subarray(57, 89)).toBase58(),
      virtualSolReserves: data.readBigUInt64LE(97),
      virtualTokenReserves: data.readBigUInt64LE(105),
      realSolReserves: data.readBigUInt64LE(113),
    };
  } catch {
    return null;
  }
}

const priceOf = (s) => (Number(s.virtualSolReserves) / Number(s.virtualTokenReserves)) * 1e-3;
const log0 = (m) => console.log(`[shadow] ${m}`);

function enter(variantId, v, mint, s) {
  const key = `${variantId}:${mint}`;
  if (open.has(key) || s.entered.has(variantId)) return;
  const slipBps = 50 + sizeSlippageBps(BUY_SOL);
  const spot = priceOf(s);
  if (!(spot > 0)) return;
  s.entered.add(variantId);
  const pos = { variant: variantId, mint, entryPrice: spot * (1 + slipBps / 10000), at: Date.now(), spot };
  open.set(key, pos);
  journal.write({
    type: "gshadow_open",
    variant: variantId,
    label: v.label,
    mint,
    fill: s.fill,
    holders: s.buyers.size,
    entryPrice: pos.entryPrice,
    spot,
    slipBps,
    buySol: BUY_SOL,
  });
}

function tryEnter(variantId, v, mint, s) {
  const key = `${variantId}:${mint}`;
  if (open.has(key) || s.entered.has(variantId)) return;
  if (s.buyers.size < v.minHolders) return;
  if (s.fill > v.maxFill) return;
  if (!v.exitCheck) {
    enter(variantId, v, mint, s);
    return;
  }
  getBondingCurveState(new PublicKey(mint), 0, 3)
    .then((state) => {
      if (state && !state.complete) {
        const prev = previewExit(state, BUY_SOL);
        if (!prev.ok || prev.ratio < 0.9) return;
      }
      enter(variantId, v, mint, s);
    })
    .catch(() => {});
}

function closePos(key, pos, reason, price) {
  const ratio = price / pos.entryPrice;
  const rt = pessimisticRoundTrip({ buySol: BUY_SOL, ratio });
  journal.write({
    type: "gshadow_trade",
    variant: pos.variant,
    mint: pos.mint,
    entryPrice: pos.entryPrice,
    exitPrice: price,
    ratio: Math.round(ratio * 1e6) / 1e6,
    holdSec: Math.round((Date.now() - pos.at) / 1000),
    reason,
    netSol: Math.round(rt.netPnl * 1e9) / 1e9,
    netPct: Math.round((rt.netPnl / BUY_SOL) * 100 * 100) / 100,
    slipBps: rt.slipBps,
    delayMs: rt.delayMs,
    buySol: BUY_SOL,
  });
  open.delete(key);
}

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;
  if (!(value.logs[value.logs.length - 1] || "").includes("success")) return;
  let isBuy = false;
  for (const l of value.logs) {
    const m = l.match(/Instruction: (\w+)/);
    if (m && BUY_INSTRUCTIONS.has(m[1])) { isBuy = true; break; }
  }
  for (const l of value.logs) {
    if (!l.startsWith("Program data: ")) continue;
    const data = Buffer.from(l.slice(14), "base64");
    if (data.length < 129 || !data.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;
    const ev = parseEvent(data);
    if (!ev) return;
    let s = mintState.get(ev.mint);
    if (!s) {
      s = { buyers: new Set(), entered: new Set(), fill: 0, rSol: 0n, price: 0 };
      mintState.set(ev.mint, s);
    }
    if (isBuy) s.buyers.add(ev.user);
    s.virtualSolReserves = ev.virtualSolReserves;
    s.virtualTokenReserves = ev.virtualTokenReserves;
    s.rSol = ev.realSolReserves;
    s.fill = gradFillPct(ev.realSolReserves);
    s.price = priceOf(s);
    if (s.fill >= MIN_FILL) {
      journal.write({ type: "gshadow_candidate", mint: ev.mint, fill: s.fill, holders: s.buyers.size, price: s.price });
      for (const [id, v] of Object.entries(VARIANTS)) {
        if (!v.postMigration) tryEnter(id, v, ev.mint, s);
      }
    }
    return;
  }
});

log0("Listening for candidates in the shadow lab...");

const timer = setInterval(() => {
  const now = Date.now();
  for (const [key, pos] of [...open]) {
    const s = mintState.get(pos.mint);
    const price = s?.price;
    if (!(price > 0)) continue;
    const ratio = price / pos.entryPrice;
    if (ratio >= (VARIANTS[pos.variant].tp ?? 1.5)) closePos(key, pos, "tp", price);
    else if (ratio <= SL) closePos(key, pos, "sl", price);
    else if (now - pos.at >= HOLD_MS) closePos(key, pos, "timeout", price);
  }
  if (mintState.size > 20_000) {
    const live = new Set([...open.values()].map((p) => p.mint));
    for (const m of mintState.keys()) if (!live.has(m)) mintState.delete(m);
  }
}, 1000);

if (MAX_SEC > 0) {
  setTimeout(async () => {
    clearInterval(timer);
    for (const [key, pos] of [...open]) {
      const s = mintState.get(pos.mint);
      closePos(key, pos, s?.price ? "timeout" : "no_data", s?.price || pos.entryPrice);
    }
    await ws.close().catch(() => {});
    log0(`stopped after ${MAX_SEC}s; journal ${journal.file()}`);
    process.exit(0);
  }, MAX_SEC * 1000);
}

process.on("SIGINT", async () => {
  clearInterval(timer);
  await ws.close().catch(() => {});
  process.exit(0);
});
