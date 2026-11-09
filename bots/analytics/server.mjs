#!/usr/bin/env node
// Аналитический дашборд: собирает статистику pump.fun в реальном времени (V3 API)
// HTTP API на порту 3000, фронтенд на bots/analytics/dashboard.html
//
// Использование: node bots/analytics/server.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ANALYTICS_PORT || 3000);

// Read the dashboard once at startup. Reading it per request blocked the event loop, and an
// unreadable file threw inside the request handler (no try/catch there → process exit).
let dashboardHtml = null;
try {
  dashboardHtml = fs.readFileSync(path.join(__dirname, "dashboard.html"), "utf8");
} catch (err) {
  logger.warn(`[analytics] dashboard.html unavailable: ${err.message}`);
}

// In-memory state
const stats = {
  startTime: Date.now(),
  totalCreates: 0,
  totalTrades: 0,
  totalBuys: 0,
  totalSells: 0,
  totalVolumeSol: 0,
  recentTokens: [],    // last 50 creates
  topBuyers: new Map(), // user → { count, volume }
  tokenVolume: new Map(), // mint → volume SOL
  minuteData: [],       // { ts, creates, buys, sells, volume }
};

let currentMinute = { ts: Date.now(), creates: 0, buys: 0, sells: 0, volume: 0 };

function flushMinute() {
  if (currentMinute.creates + currentMinute.buys + currentMinute.sells > 0) {
    stats.minuteData.push({ ...currentMinute });
    if (stats.minuteData.length > 60) stats.minuteData.shift();
  }
  currentMinute = { ts: Date.now(), creates: 0, buys: 0, sells: 0, volume: 0 };
}
setInterval(flushMinute, 60_000);

function parseV3TradeEvent(data) {
  if (data.length < 89) return null;
  const mint = new PublicKey(data.subarray(8, 40)).toBase58();
  const solAmount = Number(data.readBigUInt64LE(40)) / 1e9;
  const tokenAmount = Number(data.readBigUInt64LE(48)) / 1e6;
  const user = new PublicKey(data.subarray(57, 89)).toBase58();
  return { mint, solAmount, tokenAmount, user };
}

function parseLogEvents(logs) {
  let isBuy = false, isSell = false, isCreate = false;
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
    const raw = Buffer.from(line.slice(14), "base64");
    if (raw.length < 8 || !raw.subarray(0, 8).equals(TRADE_EVENT_PREFIX)) continue;

    try {
      const parsed = parseV3TradeEvent(raw);
      if (!parsed) continue;

      if (isCreate) {
        events.push({ type: "create", mint: parsed.mint, creator: parsed.user, ts: Date.now() });
      }
      events.push({
        type: "trade",
        mint: parsed.mint,
        solAmount: parsed.solAmount,
        isBuy: isBuy && !isSell,
        user: parsed.user,
      });
    } catch { /* malformed Program data payload: skip this line, keep parsing the rest */ }
  }
  return events;
}

function processEvents(events) {
  for (const ev of events) {
    if (ev.type === "create") {
      stats.totalCreates++;
      currentMinute.creates++;
      stats.recentTokens.unshift({
        name: ev.mint.slice(0, 8),
        symbol: "?",
        mint: ev.mint,
        creator: ev.creator,
        ts: ev.ts,
      });
      if (stats.recentTokens.length > 50) stats.recentTokens.pop();
    } else if (ev.type === "trade") {
      stats.totalTrades++;
      stats.totalVolumeSol += ev.solAmount;
      currentMinute.volume += ev.solAmount;

      if (ev.isBuy) {
        stats.totalBuys++;
        currentMinute.buys++;
      } else {
        stats.totalSells++;
        currentMinute.sells++;
      }

      const buyer = stats.topBuyers.get(ev.user) || { count: 0, volume: 0 };
      buyer.count++;
      buyer.volume += ev.solAmount;
      stats.topBuyers.set(ev.user, buyer);
      if (stats.topBuyers.size > 5000) {
        const sorted = [...stats.topBuyers.entries()].sort((a, b) => b[1].volume - a[1].volume);
        stats.topBuyers.clear();
        for (const [k, v] of sorted.slice(0, 1000)) stats.topBuyers.set(k, v);
      }

      const tv = stats.tokenVolume.get(ev.mint) || 0;
      stats.tokenVolume.set(ev.mint, tv + ev.solAmount);
      if (stats.tokenVolume.size > 5000) {
        const sorted = [...stats.tokenVolume.entries()].sort((a, b) => b[1] - a[1]);
        stats.tokenVolume.clear();
        for (const [k, v] of sorted.slice(0, 1000)) stats.tokenVolume.set(k, v);
      }
    }
  }
}

// WebSocket listener
const ws = new SolanaWs();
await ws.connect();

ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const { value } = result;
  if (!value?.logs) return;

  const lastLog = value.logs[value.logs.length - 1] || "";
  if (!lastLog.includes("success")) return;

  processEvents(parseLogEvents(value.logs));
});

// HTTP server
function getApiResponse() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const topBuyers = [...stats.topBuyers.entries()]
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 20)
    .map(([addr, d]) => ({ addr: addr.slice(0, 12) + "...", count: d.count, volume: d.volume.toFixed(2) }));

  const topTokens = [...stats.tokenVolume.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([mint, vol]) => ({ mint: mint.slice(0, 12) + "...", volume: vol.toFixed(2) }));

  return {
    uptime: elapsed.toFixed(0),
    creates: stats.totalCreates,
    trades: stats.totalTrades,
    buys: stats.totalBuys,
    sells: stats.totalSells,
    volume: stats.totalVolumeSol.toFixed(2),
    createsPerMin: stats.minuteData.length
      ? (stats.minuteData.reduce((s, m) => s + m.creates, 0) / stats.minuteData.length).toFixed(1)
      : "0",
    tradesPerMin: stats.minuteData.length
      ? (stats.minuteData.reduce((s, m) => s + m.buys + m.sells, 0) / stats.minuteData.length).toFixed(0)
      : "0",
    recentTokens: stats.recentTokens.slice(0, 10),
    topBuyers,
    topTokens,
    minuteData: stats.minuteData,
  };
}

const server = http.createServer((req, res) => {
  // A throwing handler used to take the whole process down (unhandled exception inside the
  // request callback) — answer 500 and keep collecting.
  try {
    if (req.url === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getApiResponse()));
    } else if (req.url === "/" || req.url === "/dashboard.html") {
      if (!dashboardHtml) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("dashboard.html unavailable");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(dashboardHtml);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  } catch (err) {
    logger.error(`[analytics] request failed: ${err.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  logger.info(`[analytics] Dashboard: http://localhost:${PORT} (bound to 127.0.0.1)`);
  logger.info(`[analytics] API: http://localhost:${PORT}/api/stats`);
  logger.info(`[analytics] Listening for pump.fun V3 events...`);
});

process.on("SIGINT", async () => {
  await ws.close().catch(() => {});
  server.close();
  process.exit(0);
});
