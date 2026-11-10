// Analytics aggregation, extracted from bots/analytics/server.mjs so the topBuyers direction fix
// (H6) is unit-testable without booting the HTTP server. applyEvent mutates the passed stats and
// minute objects in place and returns nothing.
export function applyEvent(stats, minute, ev) {
  if (ev.type === "create") {
    stats.totalCreates++;
    minute.creates++;
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
    minute.volume += ev.solAmount;

    if (ev.isBuy) {
      stats.totalBuys++;
      minute.buys++;
    } else {
      stats.totalSells++;
      minute.sells++;
    }

    // H6: topBuyers must count BUYS only (a sell must not inflate a user's buy volume).
    if (ev.isBuy) {
      const buyer = stats.topBuyers.get(ev.user) || { count: 0, volume: 0 };
      buyer.count++;
      buyer.volume += ev.solAmount;
      stats.topBuyers.set(ev.user, buyer);
      if (stats.topBuyers.size > 5000) {
        const sorted = [...stats.topBuyers.entries()].sort((a, b) => b[1].volume - a[1].volume);
        stats.topBuyers.clear();
        for (const [k, v] of sorted.slice(0, 1000)) stats.topBuyers.set(k, v);
      }
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
