// What to do with open positions when the bot stops (Ctrl+C / SIGTERM / max seconds).
//
// Rules (task 6):
//   * only positions THIS session opened are ever touched (positionsToSell);
//   * a dry run has nothing to send: the exit is simulated, as before;
//   * LIVE sells on exit only with SELL_ON_EXIT=yes (LIVE_CONFIRM is enforced by lib/config.mjs);
//   * a PumpSwap exit without LIVE_CONFIRM_AMM=yes is skipped with a journal reason, not attempted.
export function exitDecision({ live, sellOnExit, venue, confirmAmm }) {
  if (!live) return { sell: true, mode: "simulate", reason: null };
  if (!sellOnExit) return { sell: false, mode: "skip", reason: "SELL_ON_EXIT not set" };
  if (venue === "pumpswap" && confirmAmm !== "yes") {
    return { sell: false, mode: "skip", reason: "PumpSwap sell unverified" };
  }
  return { sell: true, mode: "send", reason: null };
}

// The bot's own positions only: `boughtMints` is filled when a buy is journaled, so a token that
// merely sits in the wallet (bought elsewhere) can never be sold by the exit path.
export function positionsToSell({ positions, boughtMints }) {
  const out = [];
  for (const [mint, pos] of positions ?? []) {
    if (!boughtMints || boughtMints.has(mint)) out.push({ mint, pos });
  }
  return out;
}
