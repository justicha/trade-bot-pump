// A sell attempt that "failed" can still land (KODING №10, D).
//
// The bot sends a sale, the confirmation times out or errors, the immediate look at the chain finds
// nothing — so the attempt is counted as failed and retried after a backoff. Meanwhile the first
// transaction lands. The retry then reads the wallet: 0 tokens. That used to be
// "no tokens in wallet": the position was dropped WITHOUT a sale — the proceeds were never booked
// and neither MAX_CONSEC_LOSSES nor the daily loss limit ever saw the trade.
//
// Now every failed attempt leaves its signature on the position (noteFailedSell), and a zero
// balance is resolved against those signatures (resolveTokensGone), read-only
// (getSignatureStatuses + getTransaction through readExecution):
//   - a landed sale is found  -> it is booked like any other live sale (applyLiveSell -> the bot's
//     recordResult -> ledger -> the ATA closer), its journal row carries `reconciledFromSig`;
//   - nothing is found        -> the position is closed with a `stuck` row, reason
//     "tokens gone, no landed sale found", lossAssumed: true — the remaining entry is an assumed
//     loss for the limits (the same cautious rule as every other STUCK: lib/stuck.mjs);
//   - the chain cannot be asked (RPC error) -> the position is kept and asked again, at most
//     MAX_GONE_LOOKUPS times, then it is closed as above with `lookupFailed: true`.
//
// Nothing is built, signed or sent from here.
import { recordStuck } from "./stuck.mjs";

export const TOKENS_GONE_REASON = "tokens gone, no landed sale found";
export const MAX_GONE_LOOKUPS = 3;
const MAX_REMEMBERED_SIGS = 16;

// Remember the signature of a sell attempt that did not end in a booked sale.
//   errOrSig — the thrown error (its .sig, or .unconfirmedSig when the send itself errored after
//              the tx was signed: lib/rpc.mjs) or a signature string
//   info     — { venue, attempt } of the attempt, journaled with a sale found later
export function noteFailedSell(pos, errOrSig, info = {}) {
  const sig = typeof errOrSig === "string" ? errOrSig : (errOrSig?.sig ?? errOrSig?.unconfirmedSig ?? null);
  if (!pos || typeof sig !== "string" || !sig) return null;
  const list = Array.isArray(pos.failedSells) ? pos.failedSells : (pos.failedSells = []);
  if (!list.some((f) => f.sig === sig)) {
    list.push({ sig, venue: info.venue ?? null, attempt: info.attempt ?? null });
    if (list.length > MAX_REMEMBERED_SIGS) list.splice(0, list.length - MAX_REMEMBERED_SIGS);
  }
  return sig;
}

export const failedSellSigs = (pos) => (Array.isArray(pos?.failedSells) ? pos.failedSells.map((f) => f.sig) : []);

// Which of the position's failed attempts are on the chain as a successful sale of `mintPk` from
// `owner`? Read-only. Returns
//   sales        [{ sig, ex, venue, attempt }] in attempt order (ex = readExecution result)
//   checked      how many signatures were looked at
//   lookupFailed true when the answer is not trustworthy: the status request failed, or a tx the
//                node reports as landed could not be read
export async function findLandedSales({ connection, pos, owner, mintPk, readExecution }) {
  const attempts = Array.isArray(pos?.failedSells) ? pos.failedSells : [];
  if (attempts.length === 0) return { sales: [], checked: 0, lookupFailed: false };
  const sigs = attempts.map((f) => f.sig);
  let statuses = null;
  try {
    const r = await connection.getSignatureStatuses(sigs, { searchTransactionHistory: true });
    statuses = Array.isArray(r?.value) && r.value.length === sigs.length ? r.value : null;
  } catch {
    statuses = null;
  }
  const sales = [];
  let lookupFailed = statuses === null;
  for (let i = 0; i < attempts.length; i++) {
    if (statuses) {
      const st = statuses[i];
      if (!st) continue; // the cluster has never seen it: it did not land
      if (st.err) continue; // landed and failed: it sold nothing
    }
    let ex = null;
    try {
      // Without statuses every signature is tried once (no waiting for a tx that may not exist).
      ex = await readExecution(sigs[i], owner, mintPk, statuses ? undefined : { retries: 1 });
    } catch {
      ex = null;
    }
    if (!ex?.found) {
      lookupFailed = true; // landed per the status (or unknown) but its meta is not readable now
      continue;
    }
    if (!ex.err && ex.tokensSold > 0n) sales.push({ sig: sigs[i], ex, venue: attempts[i].venue, attempt: attempts[i].attempt });
  }
  return { sales, checked: sigs.length, lookupFailed };
}

// The wallet holds 0 tokens of an open position. Resolve it (see the header).
//   positions     the bot's Map(mint -> pos)
//   applyLiveSell lib/live-pnl.mjs applyLiveSell (injected: this module computes no PnL itself)
//   recordResult  the bot's result hook (TradeGuard + daily loss, and through it the stop)
//   session       SessionLedger
//   ataCloser     the bot's ATA closer (schedule(mint, { venue })) — after a booked closing sale
//   onSale        (sale, { sig, ex, soldRaw, totalRaw, venue, attempt }) => void | Promise — the bot's own
//                 journal row (must carry reconciledFromSig: sig), counters and log line
//   onStuck       (lossSol, { reason, checked, lookupFailed }) => void — optional bot bookkeeping
//   stuckFields   bot-specific fields of the `stuck` row
//   sellFeeEstSol (venue) => estimate of the sell fee when the meta has none; optional
//   final         true = no later call will come (shutdown): never answer "retry"
// Returns { status: "reconciled", sales: n } | { status: "retry", backoffMs } | { status: "stuck", lossSol }.
export async function resolveTokensGone({
  connection,
  owner,
  mint,
  mintPk,
  pos,
  positions,
  buySol,
  readExecution,
  applyLiveSell,
  recordResult = null,
  session = null,
  journal = null,
  ataCloser = null,
  onSale = null,
  onStuck = null,
  stuckFields = {},
  sellFeeEstSol = null,
  defaultVenue = "curve",
  final = false,
  log = () => {},
  now = Date.now(),
}) {
  const label = mint.slice(0, 12);
  const found = await findLandedSales({ connection, pos, owner, mintPk, readExecution });
  // The position was closed or replaced while the chain was being asked (a concurrent sale was
  // booked): booking anything now would count it twice.
  if (positions && positions.get(mint) !== pos) return { status: "stale" };

  if (found.sales.length > 0) {
    // Usually one sale. Several partial sales that all landed late are booked in attempt order,
    // each against what was still held before it, so the entry is split by tokens and used once.
    let remaining = found.sales.reduce((a, s) => a + s.ex.tokensSold, 0n);
    for (const s of found.sales) {
      const venue = s.venue ?? defaultVenue;
      const soldRaw = s.ex.tokensSold;
      const totalRaw = remaining;
      const est = typeof sellFeeEstSol === "function" ? sellFeeEstSol(venue) : null;
      const sale = applyLiveSell(pos, { buySol, ex: s.ex, soldRaw, totalRaw, ...(est != null ? { sellFeeEstSol: est } : {}) });
      if (typeof recordResult === "function") recordResult(sale.acc.pnlSol, { guardPnlSol: sale.guardPnlSol });
      if (session) session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
      if (typeof onSale === "function") await onSale(sale, { sig: s.sig, ex: s.ex, soldRaw, totalRaw, venue, attempt: s.attempt });
      remaining -= soldRaw;
      if (sale.closed) {
        if (positions) positions.delete(mint);
        if (ataCloser) ataCloser.schedule(mint, { venue });
      } else {
        Object.assign(pos, sale.remainder);
      }
    }
    log(`  ${label}: 0 tokens in the wallet — ${found.sales.length} earlier sell attempt(s) had landed; booked from the chain (${found.sales.map((s) => s.sig.slice(0, 8)).join(", ")})`);
    return { status: "reconciled", sales: found.sales.length };
  }

  if (found.lookupFailed && !final) {
    const n = (pos.goneLookups || 0) + 1;
    pos.goneLookups = n;
    if (n < MAX_GONE_LOOKUPS) {
      const backoffMs = 2000 * 2 ** (n - 1);
      pos.nextSellAt = now + backoffMs;
      log(`  ${label}: 0 tokens in the wallet and the chain could not be asked about ${found.checked} earlier attempt(s) — position kept, asking again in ${Math.round(backoffMs / 1000)}s (${n}/${MAX_GONE_LOOKUPS})`);
      return { status: "retry", backoffMs };
    }
  }

  // No sale of ours took the tokens (or it cannot be shown): close the position on the cautious
  // side. The assumed loss is the remaining entry; a sale found later by hand is not credited back.
  const lossSol = recordStuck({
    journal,
    recordResult,
    mint,
    pos: { ...pos, tokens: 0n },
    buySol,
    reason: TOKENS_GONE_REASON,
    fields: { ...stuckFields, failedSigs: failedSellSigs(pos), ...(found.lookupFailed ? { lookupFailed: true } : {}) },
  });
  if (session) session.drop(`${label}: STUCK ${TOKENS_GONE_REASON}`);
  if (typeof onStuck === "function") onStuck(lossSol, { reason: TOKENS_GONE_REASON, checked: found.checked, lookupFailed: found.lookupFailed });
  if (positions) positions.delete(mint);
  log(`  ALERT: ${label}: 0 tokens in the wallet and none of ${found.checked} earlier sell attempt(s) landed as a sale${found.lookupFailed ? " (the chain could not be read)" : ""} — position closed, ${Math.abs(lossSol).toFixed(6)} SOL booked as an assumed loss for the limits`);
  return { status: "stuck", lossSol };
}
