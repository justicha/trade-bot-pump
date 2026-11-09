#!/usr/bin/env node
// Монитор новых токенов на pump.fun в реальном времени (V3 API)
// Подписывается на логи программы pump.fun через WebSocket
// Использование: node bots/monitor/stream.mjs [--filter-dev-buy <min_sol>]

import { PublicKey } from "@solana/web3.js";
import {
  PUMP_PROGRAM,
  TRADE_EVENT_PREFIX,
  BUY_INSTRUCTIONS,
  SELL_INSTRUCTIONS,
  CREATE_INSTRUCTIONS,
} from "../../lib/constants.mjs";
import { SolanaWs } from "../../lib/ws.mjs";
import { log as logger } from "../../lib/logger.mjs";

const MIN_DEV_BUY = Number(process.argv.includes("--filter-dev-buy")
  ? process.argv[process.argv.indexOf("--filter-dev-buy") + 1]
  : 0);

function parseInstructions(logs) {
  const instrs = [];
  for (const line of logs) {
    const m = line.match(/Instruction: (\w+)/);
    if (m) instrs.push(m[1]);
  }
  return instrs;
}

function getTradeDirection(instrs) {
  let isBuy = false, isSell = false, isCreate = false;
  for (const name of instrs) {
    if (BUY_INSTRUCTIONS.has(name)) isBuy = true;
    if (SELL_INSTRUCTIONS.has(name)) isSell = true;
    if (CREATE_INSTRUCTIONS.has(name)) isCreate = true;
  }
  return { isBuy, isSell, isCreate };
}

function parseV3TradeEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  return { mint, solAmount, tokenAmount, user };
}

function parseLogEvents(logs) {
  const instrs = parseInstructions(logs);
  const { isBuy, isSell, isCreate } = getTradeDirection(instrs);
  const events = [];

  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8) continue;
    if (!raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const parsed = parseV3TradeEvent(raw);
      if (!parsed) continue;

      if (isCreate) {
        events.push({ type: "create", name: "?", symbol: "?", mint: parsed.mint, creator: parsed.user });
      }
      events.push({
        type: "trade",
        mint: parsed.mint,
        solAmount: parsed.solAmount,
        tokenAmount: parsed.tokenAmount,
        isBuy: isBuy && !isSell,
        user: parsed.user,
      });
    } catch {}
  }
  return events;
}

// Stats
let createCount = 0;
let tradeCount = 0;
const startTime = Date.now();

// Count each mint only once, at first sighting (the V3 log stream re-reports the same
// mint as a "create" on later trades). Capped so memory stays bounded.
const seenMints = new Set();
const SEEN_MINT_CAP = 50_000;
function markSeen(mint) {
  seenMints.add(mint);
  if (seenMints.size > SEEN_MINT_CAP) {
    const it = seenMints.values();
    for (let i = 0; i < SEEN_MINT_CAP / 2; i++) seenMints.delete(it.next().value);
  }
}

const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  const events = parseLogEvents(value.logs);
  for (const ev of events) {
    if (ev.type === "create") {
      if (seenMints.has(ev.mint)) continue;
      markSeen(ev.mint);
      createCount++;
      const devBuy = events.find(
        (e) => e.type === "trade" && e.isBuy && e.mint === ev.mint && e.user === ev.creator,
      );
      const devSol = devBuy ? devBuy.solAmount : 0;

      if (MIN_DEV_BUY && devSol < MIN_DEV_BUY) continue;

      logger.info(
        `NEW TOKEN #${createCount}` +
          `\n  Mint:    ${ev.mint}` +
          `\n  Creator: ${ev.creator}` +
          `\n  Dev buy: ${devSol > 0 ? devSol.toFixed(3) + " SOL" : "none"}`,
      );
    } else if (ev.type === "trade") {
      tradeCount++;
      if (tradeCount % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        logger.info(
          `stats: ${createCount} creates, ${tradeCount} trades in ${elapsed}s`,
        );
      }
    }
  }
});

logger.info(`Monitoring pump.fun V3 for new tokens...`);
if (MIN_DEV_BUY) logger.info(`  Filter: dev buy >= ${MIN_DEV_BUY} SOL`);
logger.info("  Press Ctrl+C to stop");

process.on("SIGINT", async () => {
  logger.info(`Stopped. ${createCount} creates, ${tradeCount} trades observed.`);
  await ws.close().catch(() => {});
  process.exit(0);
});
