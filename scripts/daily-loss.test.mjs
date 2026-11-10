// Unit: the daily loss limit (task 5) — it blocks BUYS, never sells.
//
// The day's net is summed from journal trade rows (pnlSol, Moscow date), so a restart on the same
// day keeps the limit. The decision itself is pure; the bot wires it before any buy is sent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DAILY_LOSS_LIMIT_SOL, dailyLossBlocked, netSolForDay } from "../lib/daily-loss.mjs";
import { mskDateKey } from "../lib/time.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const TODAY = mskDateKey();
const trade = (pnlSol, day = TODAY) => ({ type: "trade", pnlSol, tsMsk: `${day}T10:00:00+03:00` });

// --- default and threshold ---
asrt(DEFAULT_DAILY_LOSS_LIMIT_SOL === 0.05, "the default limit is 0.05 SOL");
{
  const atLimit = dailyLossBlocked({ netSol: -0.05, limitSol: 0.05 });
  asrt(atLimit.blocked === true && atLimit.reason === "daily loss limit", "exactly -0.05 blocks buying");
  const below = dailyLossBlocked({ netSol: -0.0499, limitSol: 0.05 });
  asrt(below.blocked === false && below.reason === null, "-0.0499 is still allowed");
  asrt(dailyLossBlocked({ netSol: 0.2, limitSol: 0.05 }).blocked === false, "a profitable day is never blocked");
  asrt(dailyLossBlocked({ netSol: -10, limitSol: 0 }).blocked === false, "limit 0 disables the check");
  asrt(dailyLossBlocked({ netSol: -0.06 }).blocked === true, "the default limit is applied when none is given");
}

// --- the day's net comes from the journal, today only ---
{
  const records = [
    trade(-0.02),
    trade(-0.02),
    trade(0.01),
    { type: "trade", pnlSol: -5, tsMsk: "2026-01-01T10:00:00+03:00" }, // another day
    { type: "buy_skipped", reason: "insufficient exit depth" }, // not a trade
    { type: "trade", pnlSol: null }, // broken row
  ];
  const net = netSolForDay(records, TODAY);
  asrt(Math.abs(net - -0.03) < 1e-9, `net is -0.03 for today, got ${net}`);
  const blocked = dailyLossBlocked({ netSol: net, limitSol: 0.05 });
  asrt(blocked.blocked === false, "a -0.03 day still trades");
  asrt(dailyLossBlocked({ netSol: netSolForDay([...records, trade(-0.02)], TODAY), limitSol: 0.05 }).blocked === true, "-0.05 after another loss blocks");
  asrt(netSolForDay([], TODAY) === 0, "an empty journal is a zero day");
  // ts without tsMsk (legacy rows) still counts towards the right day
  asrt(netSolForDay([{ type: "trade", pnlSol: -0.01, ts: new Date().toISOString() }], TODAY) !== 0, "legacy rows without tsMsk count for today");
}

// --- the bot checks it before buying and updates it on every realised trade ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.indexOf("async function buyToken");
  const check = src.indexOf("dailyLossBlocked(", fn);
  const send = src.indexOf("sendTxWithRetry(", fn);
  asrt(check > fn, "buyToken consults the daily loss limit");
  asrt(send === -1 || check < send, "the check runs before the buy is sent");
  asrt(/dayNetSol = Math\.round\(\(dayNetSol \+/.test(src), "recordResult keeps the day's net up to date");
  asrt(/DAILY_LOSS_LIMIT_SOL/.test(src) && /netSolForDay\(readJournal\(journal\.dir\)/.test(src), "the limit is configurable and seeded from the journal");
  // The limit gates buys only: the sell path must never look at it, or a bad day could not exit.
  const sellFn = src.indexOf("async function sellPosition");
  const sellBody = src.slice(sellFn, src.indexOf("async function monitorPositions"));
  asrt(sellFn > 0 && sellBody.length > 0, "sellPosition found");
  asrt(!/dailyLossBlocked|DAILY_LOSS_LIMIT_SOL/.test(sellBody), "the sell path never consults the daily loss limit");
}

console.log(JSON.stringify({ defaultLimitSol: DEFAULT_DAILY_LOSS_LIMIT_SOL, todayNet: netSolForDay([trade(-0.02), trade(-0.02), trade(0.01)]) }));
console.log("PASS: daily loss limit — buys stop at -0.05 SOL for the day, sells are never blocked");
