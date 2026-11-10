// H6: analytics topBuyers must count BUYS only (a sell must not inflate a user's buy volume).
import { applyEvent } from "../lib/analytics-stats.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

function fresh() {
  return {
    stats: {
      startTime: Date.now(),
      totalCreates: 0, totalTrades: 0, totalBuys: 0, totalSells: 0, totalVolumeSol: 0,
      recentTokens: [], topBuyers: new Map(), tokenVolume: new Map(), minuteData: [],
    },
    minute: { ts: Date.now(), creates: 0, buys: 0, sells: 0, volume: 0 },
  };
}

{
  const { stats, minute } = fresh();
  applyEvent(stats, minute, { type: "trade", mint: "M", solAmount: 1, user: "ALICE", isBuy: true });
  applyEvent(stats, minute, { type: "trade", mint: "M", solAmount: 5, user: "ALICE", isBuy: false });
  applyEvent(stats, minute, { type: "trade", mint: "M", solAmount: 2, user: "BOB", isBuy: true });
  const alice = stats.topBuyers.get("ALICE");
  asrt(alice && alice.volume === 1 && alice.count === 1, `ALICE's buy volume counts only her buy (1 SOL), got ${JSON.stringify(alice)}`);
  asrt(stats.topBuyers.get("BOB").volume === 2, "BOB's buy volume is recorded");
  asrt(stats.totalSells === 1 && stats.totalBuys === 2, "buy/sell counters stay separate");
}

console.log("PASS: topBuyers counts buys only (sells do not inflate buy volume)");
