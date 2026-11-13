#!/usr/bin/env node
// Analytics dashboard: collects pump.fun statistics in real time (V3 API)
// HTTP API on port 3000, frontend at bots/analytics/dashboard.html
//
// Usage: node bots/analytics/server.mjs

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM } from "../../lib/constants.mjs";
import { parseLogEvents } from "../../lib/events.mjs";
import { applyEvent } from "../../lib/analytics-stats.mjs";
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

function processEvents(events) {
  for (const ev of events) applyEvent(stats, currentMinute, ev);
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
