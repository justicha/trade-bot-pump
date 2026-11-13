// Bounded sell retries for the bots that sell on the bonding curve (sniper, copy-trader) — M6.
//
// Why: a failed live sell used to be only a log line.
//   - sniper: the position stayed in the book and the 2 s poll tried to sell it AGAIN, forever — no
//     counter, no backoff, no STUCK. Every attempt is RPC load, and a tx that lands and fails pays
//     its network fee each time. The limits (MAX_CONSEC_LOSSES, daily loss) never saw the position.
//   - copy-trader: nothing retried at all; the position waited for the target to sell once more.
//
// The policy is the one bots/graduation-sniper/graduation.mjs already has (it keeps its own copy,
// untouched): at most SELL_MAX_ATTEMPTS attempts, backoff 2000 ms x 2^(attempt-1) between them, and
// when the budget is gone the position becomes STUCK — lib/stuck.mjs books the remaining entry as
// an assumed loss (`lossAssumed: true`) so TradeGuard and the daily loss limit see it. The tokens
// stay in the wallet (scripts/rescue-sell.mjs); nothing is burned, nothing is sent from here.
//
// Not touched here: pnlSol, applyLiveSell, the ATA closer. A retried sale that finally lands is
// booked by the bot exactly like a first-try sale. The fee of a failed tx that landed is already
// counted in lib/rpc.mjs (rpcStats.txFails) and is not counted again.
import { noteFailedSell } from "./late-sale.mjs";
import { recordStuck } from "./stuck.mjs";

// The default of the SELL_MAX_ATTEMPTS env var — the same value graduation-sniper uses
// (scripts/sell-retry.test.mjs pins the two together).
export const DEFAULT_SELL_MAX_ATTEMPTS = 3;
export const SELL_BACKOFF_BASE_MS = 2000;

// Wait after failed attempt number `attempt` (1-based): 2 s, 4 s, 8 s, …
export function sellBackoffMs(attempt) {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  return SELL_BACKOFF_BASE_MS * 2 ** (n - 1);
}

// May the position be sold right now? False only while a failed attempt is backing off.
export function sellDue(pos, now = Date.now()) {
  return !((pos?.nextSellAt || 0) > now);
}

// Count one failed attempt on the position. `stuck: true` = the budget is gone (no further retry).
// maxAttempts < 1 behaves like 1: the first failure is final (a sale is always attempted once).
export function noteSellFailure(pos, { maxAttempts = DEFAULT_SELL_MAX_ATTEMPTS, now = Date.now() } = {}) {
  const attempt = (pos.attempts || 0) + 1;
  pos.attempts = attempt;
  const stuck = attempt >= maxAttempts;
  const backoffMs = stuck ? 0 : sellBackoffMs(attempt);
  pos.nextSellAt = stuck ? 0 : now + backoffMs;
  return { attempt, maxAttempts, stuck, backoffMs };
}

// A sale went through and part of the position is still open (copy-trader SELL_PCT < 100): the
// remainder starts with a fresh budget and is no longer "on its way out".
export function clearSellRetry(pos) {
  pos.attempts = 0;
  pos.nextSellAt = 0;
  pos.pendingExit = false;
  return pos;
}

// One retry policy bound to a bot's own book.
//   positions    — the bot's Map(mint -> pos); a STUCK position is deleted from it
//   journal      — TradeJournal (or anything with write()); optional
//   recordResult — the bot's result hook (TradeGuard, and through it the stop); optional
//   session      — SessionLedger (drop note for the report); optional
//   buySol       — nominal buy size, the assumed loss when the position has no entrySolSol
//   fields       — object or () => object: run metadata stamped into every row
//   now          — clock (tests inject a fake one)
export function createSellRetry({
  maxAttempts = DEFAULT_SELL_MAX_ATTEMPTS,
  positions,
  journal = null,
  recordResult = null,
  session = null,
  log = () => {},
  buySol,
  fields = {},
  now = () => Date.now(),
} = {}) {
  const meta = () => (typeof fields === "function" ? fields() : fields) || {};
  return {
    maxAttempts,
    due: (pos) => sellDue(pos, now()),
    reset: clearSellRetry,
    // A live sell attempt failed (the bot has already ruled out "it landed after all").
    //   reason — why the bot was selling (take-profit, timeout, target sold, …)
    //   tokens — wallet balance read before the attempt, when known
    //   extra  — bot-specific row fields (copiedFrom, …)
    // Returns { stale } | { stuck, attempt, maxAttempts, backoffMs, lossSol }.
    fail(mint, pos, err, { reason = null, tokens = null, extra = {} } = {}) {
      // The position was closed or replaced while this attempt was in flight (a concurrent sale
      // landed): counting it — or worse, booking it as STUCK — would invent a loss.
      if (!positions || positions.get(mint) !== pos) return { stale: true, stuck: false };
      const error = String(err?.message ?? err);
      const f = noteSellFailure(pos, { maxAttempts, now: now() });
      // The attempt may still land after this: its signature stays on the position, so a later
      // "0 tokens in the wallet" can be traced to it (lib/late-sale.mjs).
      noteFailedSell(pos, err, { venue: "curve", attempt: f.attempt });
      const tokensStr = tokens != null ? tokens.toString() : (pos.tokens ?? 0n).toString();
      const common = { ...meta(), ...extra, venue: "curve", exitReason: reason };
      if (journal) {
        journal.write({
          type: "sell_failed",
          ...common,
          mint,
          attempt: f.attempt,
          maxAttempts,
          error,
          sig: err?.sig ?? null,
          nextRetryMs: f.stuck ? null : f.backoffMs,
          tokens: tokensStr,
        });
      }
      if (!f.stuck) {
        log(`  sell attempt ${f.attempt}/${maxAttempts} failed — next try in ${Math.round(f.backoffMs / 1000)}s; position kept`);
        return { stale: false, ...f, lossSol: 0 };
      }
      const why = `sell failed ${f.attempt}/${maxAttempts}: ${error}`;
      const lossSol = recordStuck({
        journal,
        recordResult,
        mint,
        pos: tokens != null ? { ...pos, tokens } : pos,
        buySol,
        reason: why,
        fields: { ...common, attempts: f.attempt, maxAttempts },
      });
      log(`  ALERT: ${mint.slice(0, 12)} STUCK (attempts=${f.attempt}/${maxAttempts}): ${error} — retries stopped after ${f.attempt}/${maxAttempts} attempts, use scripts/rescue-sell.mjs`);
      log(`  STUCK booked as an assumed loss of ${Math.abs(lossSol).toFixed(6)} SOL for the limits (tokens are still in the wallet)`);
      if (session) session.drop(`${mint.slice(0, 8)}: STUCK ${why}`);
      positions.delete(mint);
      return { stale: false, ...f, lossSol };
    },
  };
}
