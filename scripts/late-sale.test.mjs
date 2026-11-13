import "./lib/test-env.mjs";
// A sale that landed late (KODING №10, D): lib/late-sale.mjs + graduation-sniper's own sellPosition.
//
// The bug: a sell attempt "fails" (confirm error / timeout, nothing on the chain yet), the tx lands
// afterwards, the next attempt reads 0 tokens -> the position was dropped as "no tokens in wallet"
// WITHOUT a sale row: the proceeds were never booked, TradeGuard and the daily loss limit never saw
// the trade.
//
// Covered here (the sniper and the copy-trader run through the same scenarios with their real code
// in scripts/sell-retry.test.mjs, section 5):
//   1. the pieces of lib/late-sale.mjs (remembering signatures, the read-only lookup, the three
//      outcomes: reconciled / retry / stuck);
//   2. bots/graduation-sniper/graduation.mjs sellPosition, cut out of the bot file and run against
//      mocks (a real --live run cannot be spawned: RPC_MOCK is refused with --live);
//   3. lib/rpc.mjs: a send request that errors still tells the caller the tx's own signature.
// No network, no keys, nothing is sent: every chain call is a mock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

process.env.CU_PRICE = "1500000";
process.env.CU_LIMIT = "120000";
process.env.RPC_MOCK = path.join(here, "mocks", "send-fail-mock.mjs");

const { noteFailedSell, failedSellSigs, findLandedSales, resolveTokensGone, TOKENS_GONE_REASON, MAX_GONE_LOOKUPS } = await import("../lib/late-sale.mjs");
const { applyLiveSell, balanceBeforeSell } = await import("../lib/live-pnl.mjs");
const { createSellRetry } = await import("../lib/sell-retry.mjs");
const { recordStuck } = await import("../lib/stuck.mjs");
const { TradeGuard } = await import("../lib/guards.mjs");
const { TradeJournal, readJournal } = await import("../lib/journal.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const { netSolForDay } = await import("../lib/daily-loss.mjs");
const { mskDateKey } = await import("../lib/time.mjs");
const { ammSellTxCostSol } = await import("../lib/fees.mjs");
const { chooseSellVenue } = await import("../lib/amm-sell.mjs");
const { planSellParts } = await import("../lib/sell-plan.mjs");
const { describeTxError } = await import("../lib/pump-errors.mjs");
const { TOKEN_2022_PROGRAM } = await import("../lib/constants.mjs");
const { sendTxWithRetry, ownSignature } = await import("../lib/rpc.mjs");
const { buildVersionedTx } = await import("../lib/tx.mjs");

const BUY_SOL = 0.02;
const FEE = 0.000185;
const BAL = 40_000_000n;
const MINT = Keypair.generate().publicKey.toBase58();
const OWNER = Keypair.generate().publicKey;
const exSold = (amount, { proceeds = 0.03, feeSol = FEE } = {}) => ({
  found: true, feeSol, solDeltaSol: proceeds, solReceivedSol: proceeds, rentReturnedSol: 0,
  tokensDelta: -amount, tokensReceived: 0n, tokensSold: amount, err: null,
});
const exFailed = () => ({ found: true, feeSol: FEE, solDeltaSol: -FEE, solReceivedSol: 0, rentReturnedSol: 0, tokensDelta: 0n, tokensReceived: 0n, tokensSold: 0n, err: { InstructionError: [2, { Custom: 6003 }] } });
const OK = { err: null, confirmationStatus: "confirmed" };
const FAILED = { err: { InstructionError: [2, { Custom: 6003 }] }, confirmationStatus: "confirmed" };

// =============================================================================================
// 1. lib/late-sale.mjs
// =============================================================================================
// --- remembering the signature of a failed attempt ---
{
  const pos = {};
  asrt(noteFailedSell(pos, Object.assign(new Error("x"), { sig: "A" }), { venue: "curve", attempt: 1 }) === "A", "err.sig is remembered");
  asrt(noteFailedSell(pos, Object.assign(new Error("x"), { unconfirmedSig: "B" }), { venue: "pumpswap", attempt: 2 }) === "B", "err.unconfirmedSig (the send request errored) is remembered too");
  asrt(noteFailedSell(pos, "C") === "C" && noteFailedSell(pos, "A") === "A", "a plain signature works; a repeat is not stored twice");
  asrt(JSON.stringify(pos.failedSells) === JSON.stringify([{ sig: "A", venue: "curve", attempt: 1 }, { sig: "B", venue: "pumpswap", attempt: 2 }, { sig: "C", venue: null, attempt: null }]), `stored in attempt order with venue/attempt, got ${JSON.stringify(pos.failedSells)}`);
  asrt(JSON.stringify(failedSellSigs(pos)) === '["A","B","C"]' && failedSellSigs({}).length === 0, "failedSellSigs lists them");
  const none = {};
  asrt(noteFailedSell(none, new Error("simulation failed")) === null && none.failedSells === undefined, "an attempt that was never sent (no signature) leaves nothing");
  asrt(noteFailedSell(null, "X") === null, "no position -> no-op");
  const many = {};
  for (let i = 0; i < 40; i++) noteFailedSell(many, `S${i}`);
  asrt(many.failedSells.length === 16 && many.failedSells[15].sig === "S39", "the list is bounded (the latest 16)");
}

// --- lib/sell-retry.mjs fail() leaves the signature on the position (sniper / copy-trader) ---
{
  const positions = new Map();
  const pos = { entrySolSol: 0.02 };
  positions.set(MINT, pos);
  const rows = [];
  const retry = createSellRetry({ maxAttempts: 3, positions, journal: { write: (r) => rows.push(r) }, buySol: BUY_SOL, now: () => 0 });
  retry.fail(MINT, pos, Object.assign(new Error("confirm failed"), { sig: "SIG1" }));
  retry.fail(MINT, pos, new Error("simulation failed"));
  asrt(JSON.stringify(pos.failedSells) === JSON.stringify([{ sig: "SIG1", venue: "curve", attempt: 1 }]) && rows[0].sig === "SIG1" && rows[1].sig === null, `fail() remembers the attempt's signature (not a simulation failure), got ${JSON.stringify(pos.failedSells)}`);
  const stale = { entrySolSol: 0.02 };
  retry.fail(MINT, stale, Object.assign(new Error("x"), { sig: "SIG2" }));
  asrt(stale.failedSells === undefined, "a stale position is not touched");
}

// --- the read-only lookup ---
{
  const pos = { failedSells: [{ sig: "NEVER", venue: "curve", attempt: 1 }, { sig: "FAILED", venue: "curve", attempt: 2 }, { sig: "LANDED", venue: "pumpswap", attempt: 3 }] };
  const reads = [];
  const statusArgs = [];
  const connection = { getSignatureStatuses: async (sigs, opts) => (statusArgs.push([sigs, opts]), { value: [null, FAILED, OK] }) };
  const readExecution = async (sig, owner, mint, opts) => (reads.push([sig, opts]), sig === "LANDED" ? exSold(BAL) : { found: false });
  const r = await findLandedSales({ connection, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution });
  asrt(r.sales.length === 1 && r.sales[0].sig === "LANDED" && r.sales[0].venue === "pumpswap" && r.sales[0].attempt === 3 && r.checked === 3 && r.lookupFailed === false, `only the landed, successful attempt is a sale: ${JSON.stringify(r.sales.map((s) => s.sig))}`);
  asrt(JSON.stringify(statusArgs[0][0]) === '["NEVER","FAILED","LANDED"]' && statusArgs[0][1].searchTransactionHistory === true, "one getSignatureStatuses request for all attempts, history included");
  asrt(reads.length === 1 && reads[0][0] === "LANDED" && reads[0][1] === undefined, "getTransaction is read only for the attempt that landed");

  // A landed tx that sold nothing of this mint, or errored, is not a sale.
  const r2 = await findLandedSales({ connection, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => ({ ...exSold(0n), tokensSold: 0n }) });
  asrt(r2.sales.length === 0 && r2.lookupFailed === false, "landed but no tokens of this mint left the wallet -> not a sale");
  const r3 = await findLandedSales({ connection, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => ({ ...exSold(BAL), err: { x: 1 } }) });
  asrt(r3.sales.length === 0, "meta with an error -> not a sale");

  // Status says landed but the meta cannot be read: the answer is not trustworthy.
  const r4 = await findLandedSales({ connection, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => ({ found: false }) });
  asrt(r4.sales.length === 0 && r4.lookupFailed === true, "landed per status, meta unreadable -> lookupFailed");
  const r4b = await findLandedSales({ connection, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => { throw new Error("rpc"); } });
  asrt(r4b.sales.length === 0 && r4b.lookupFailed === true, "readExecution throwing -> lookupFailed, never an exception");

  // The status request fails: every signature is tried once directly; unknown stays unknown.
  const reads5 = [];
  const down = { getSignatureStatuses: async () => { throw new Error("rpc down"); } };
  const r5 = await findLandedSales({ connection: down, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async (sig, o, m, opts) => (reads5.push([sig, opts]), sig === "LANDED" ? exSold(BAL) : { found: false }) });
  asrt(r5.sales.length === 1 && r5.lookupFailed === true && reads5.length === 3 && reads5.every((x) => x[1]?.retries === 1), "statuses down: each attempt read once (retries: 1); a sale that IS readable is still found");
  const r6 = await findLandedSales({ connection: { getSignatureStatuses: async () => ({ value: [OK] }) }, pos, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => ({ found: false }) });
  asrt(r6.lookupFailed === true, "a malformed status answer (wrong length) is treated as a failed lookup");

  const empty = await findLandedSales({ connection: { getSignatureStatuses: async () => { throw new Error("must not be called"); } }, pos: {}, owner: OWNER, mintPk: new PublicKey(MINT), readExecution: async () => { throw new Error("must not be called"); } });
  asrt(empty.sales.length === 0 && empty.checked === 0 && empty.lookupFailed === false, "no failed attempts -> nothing is asked");
}

// --- resolveTokensGone: the three outcomes, on a small world ---
function world({ pos, statuses = () => [], meta = () => ({ found: false }), statusThrows = false } = {}) {
  const w = { rows: [], results: [], sells: [], drops: [], closes: [], sales: [], stuckCalls: [], logs: [], statusCalls: 0 };
  w.positions = new Map([[MINT, pos]]);
  w.pos = pos;
  w.guard = new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses: 2 });
  w.args = (over = {}) => ({
    connection: {
      getSignatureStatuses: async (sigs) => {
        w.statusCalls += 1;
        if (statusThrows) throw new Error("rpc down");
        return { value: statuses(sigs) };
      },
    },
    owner: OWNER,
    mint: MINT,
    mintPk: new PublicKey(MINT),
    pos: w.pos,
    positions: w.positions,
    buySol: BUY_SOL,
    readExecution: async (sig) => meta(sig),
    applyLiveSell,
    recordResult: (pnlSol, opts) => (w.results.push({ pnlSol, opts }), w.guard.recordResult(pnlSol, opts)),
    session: { sell: (...a) => w.sells.push(a), drop: (n) => w.drops.push(n) },
    journal: { write: (r) => w.rows.push(r) },
    ataCloser: { schedule: (mint, o) => w.closes.push({ mint, ...o }) },
    onSale: (sale, info) => w.sales.push({ sale, ...info }),
    onStuck: (lossSol, info) => w.stuckCalls.push({ lossSol, ...info }),
    stuckFields: { sessionId: "S1", venue: null },
    log: (m) => w.logs.push(m),
    now: 1_000_000,
    ...over,
  });
  return w;
}
const basePos = () => ({ tokens: BAL, entrySolSol: 0.02, entrySource: "chain-meta", buyFeeSol: FEE, ataRentSol: 0.00207408, ataRentKnown: true });

// reconciled: one landed sale
{
  const pos = { ...basePos(), failedSells: [{ sig: "S1", venue: "curve", attempt: 1 }] };
  const ref = applyLiveSell(basePos(), { buySol: BUY_SOL, ex: exSold(BAL), soldRaw: BAL, totalRaw: BAL });
  const w = world({ pos, statuses: () => [OK], meta: () => exSold(BAL) });
  const r = await resolveTokensGone(w.args());
  asrt(r.status === "reconciled" && r.sales === 1, `status reconciled, got ${JSON.stringify(r)}`);
  asrt(w.results.length === 1 && w.results[0].pnlSol === ref.acc.pnlSol && w.results[0].opts.guardPnlSol === ref.guardPnlSol, `the guard gets the same result as a normal sale (${ref.acc.pnlSol})`);
  asrt(w.sells.length === 1 && w.sells[0][0] === ref.acc.ledger.receivedSol && w.sells[0][1] === ref.acc.ledger.pnlSol && JSON.stringify(w.sells[0][2]) === JSON.stringify(ref.acc.costs), "the ledger gets gross proceeds / pnl + the real costs");
  asrt(w.sales.length === 1 && w.sales[0].sig === "S1" && w.sales[0].soldRaw === BAL && w.sales[0].totalRaw === BAL && w.sales[0].venue === "curve" && w.sales[0].attempt === 1 && w.sales[0].sale.closed === true, "onSale gets the sale and where it came from");
  asrt(!w.positions.has(MINT) && w.closes.length === 1 && w.closes[0].venue === "curve", "position closed, ATA close scheduled");
  asrt(w.rows.length === 0 && w.drops.length === 0 && w.stuckCalls.length === 0 && w.pos.goneLookups === undefined, "no stuck row, nothing dropped");
}

// reconciled: two partial sales that both landed late — the entry is split by tokens, used once
{
  const A = 30_000_000n;
  const B = 10_000_000n;
  const pos = { ...basePos(), failedSells: [{ sig: "P1", venue: "curve", attempt: 1 }, { sig: "P2", venue: "pumpswap", attempt: 2 }] };
  const w = world({ pos, statuses: () => [OK, OK], meta: (sig) => (sig === "P1" ? exSold(A, { proceeds: 0.021 }) : exSold(B, { proceeds: 0.006, feeSol: 0.000245 })) });
  const r = await resolveTokensGone(w.args());
  asrt(r.status === "reconciled" && r.sales === 2 && w.sales.length === 2, "both landed sales are booked");
  asrt(w.sales[0].totalRaw === A + B && w.sales[0].sale.closed === false && w.sales[1].totalRaw === B && w.sales[1].sale.closed === true, "each is measured against what was held before it; the last one closes");
  const shares = w.sales.map((s) => s.sale.acc.shareEntry);
  asrt(near(shares[0], 0.015) && near(shares[1], 0.005) && near(shares[0] + shares[1], 0.02), `entry split 3:1 and used exactly once (${shares})`);
  asrt(near(w.results[0].pnlSol + w.results[1].pnlSol, 0.021 + 0.006 - 0.02 - FEE), "total PnL = total proceeds (wallet deltas) - entry - the buy fee, both sell fees inside the deltas");
  asrt(!w.positions.has(MINT) && w.closes.length === 1 && w.closes[0].venue === "pumpswap", "closed once, by the last sale");
}

// reconciled: a landed sale whose meta has no fee -> the estimate of ITS venue, never added to a known fee
{
  const pos = { ...basePos(), failedSells: [{ sig: "A1", venue: "pumpswap", attempt: 1 }] };
  const noFee = { ...exSold(BAL), feeSol: undefined };
  const w = world({ pos, statuses: () => [OK], meta: () => noFee });
  await resolveTokensGone(w.args({ sellFeeEstSol: (v) => (v === "pumpswap" ? ammSellTxCostSol() : null) }));
  asrt(near(w.sales[0].sale.acc.costs.sellFeeSol, 0.000245) && w.sales[0].sale.acc.costs.feesActual === false, `unknown fee of an AMM sale: AMM_SELL_CU_LIMIT estimate, got ${w.sales[0].sale.acc.costs.sellFeeSol}`);
  const w2 = world({ pos: { ...basePos(), failedSells: [{ sig: "A1", venue: "pumpswap", attempt: 1 }] }, statuses: () => [OK], meta: () => exSold(BAL, { feeSol: 0.000111 }) });
  await resolveTokensGone(w2.args({ sellFeeEstSol: () => ammSellTxCostSol() }));
  asrt(w2.sales[0].sale.acc.costs.sellFeeSol === 0.000111, "a fee read from the chain is used as it is");
}

// stuck: failed attempts exist, none of them sold the tokens
{
  const pos = { ...basePos(), failedSells: [{ sig: "F1", venue: "curve", attempt: 1 }, { sig: "N1", venue: "curve", attempt: 2 }] };
  const w = world({ pos, statuses: () => [FAILED, null], meta: () => exFailed() });
  const r = await resolveTokensGone(w.args());
  asrt(r.status === "stuck" && r.lossSol === -0.02, `status stuck with the remaining entry as the loss, got ${JSON.stringify(r)}`);
  asrt(w.rows.length === 1 && w.rows[0].type === "stuck" && w.rows[0].reason === "tokens gone, no landed sale found" && w.rows[0].reason === TOKENS_GONE_REASON && w.rows[0].lossAssumed === true && w.rows[0].pnlSol === -0.02, `stuck row: ${JSON.stringify(w.rows[0])}`);
  asrt(w.rows[0].tokens === "0" && JSON.stringify(w.rows[0].failedSigs) === '["F1","N1"]' && w.rows[0].sessionId === "S1" && w.rows[0].lookupFailed === undefined && w.rows[0].ataRentSol === 0.00207408, "row: 0 tokens, the signatures that were checked, bot fields, the ATA rent apart");
  asrt(w.results.length === 1 && w.results[0].pnlSol === -0.02 && w.guard.consecLosses === 1, "TradeGuard sees the assumed loss");
  asrt(!w.positions.has(MINT) && w.closes.length === 0 && w.sales.length === 0 && w.sells.length === 0, "position closed; no sale, no ATA close");
  asrt(w.drops.length === 1 && /STUCK tokens gone, no landed sale found/.test(w.drops[0]) && w.stuckCalls.length === 1 && w.stuckCalls[0].checked === 2, "ledger note + the bot's onStuck hook");
}

// stuck: no failed attempt at all — the same row, nothing asked
{
  const w = world({ pos: basePos(), statuses: () => { throw new Error("must not be asked"); } });
  const r = await resolveTokensGone(w.args());
  asrt(r.status === "stuck" && w.statusCalls === 0 && w.rows[0].reason === TOKENS_GONE_REASON && w.rows[0].lossAssumed === true && w.rows[0].pnlSol === -0.02 && JSON.stringify(w.rows[0].failedSigs) === "[]", "no attempts: stuck lossAssumed without a lookup");
  asrt(w.guard.consecLosses === 1 && !w.positions.has(MINT), "the guard sees it; position closed");
}

// retry: the chain cannot be asked -> kept, bounded, then stuck with lookupFailed
{
  const pos = { ...basePos(), failedSells: [{ sig: "S1", venue: "curve", attempt: 1 }] };
  const w = world({ pos, statusThrows: true });
  const r1 = await resolveTokensGone(w.args({ now: 5000 }));
  asrt(r1.status === "retry" && r1.backoffMs === 2000 && pos.goneLookups === 1 && pos.nextSellAt === 7000 && w.positions.get(MINT) === pos && w.rows.length === 0 && w.results.length === 0, `lookup failed: position kept, asked again in 2 s, got ${JSON.stringify(r1)}`);
  const r2 = await resolveTokensGone(w.args({ now: 7000 }));
  asrt(r2.status === "retry" && r2.backoffMs === 4000 && pos.nextSellAt === 11000, "second failed lookup: 4 s");
  const r3 = await resolveTokensGone(w.args({ now: 11000 }));
  asrt(MAX_GONE_LOOKUPS === 3 && r3.status === "stuck" && w.rows.length === 1 && w.rows[0].lookupFailed === true && w.rows[0].lossAssumed === true && !w.positions.has(MINT), "third failed lookup: closed as stuck, lookupFailed journaled");

  // final (shutdown): there is no later call — never "retry"
  const pf = { ...basePos(), failedSells: [{ sig: "S1", venue: "curve", attempt: 1 }] };
  const wf = world({ pos: pf, statusThrows: true });
  const rf = await resolveTokensGone(wf.args({ final: true }));
  asrt(rf.status === "stuck" && wf.rows[0].lookupFailed === true && pf.goneLookups === undefined, "final call: stuck at once");
}

// stale: the position was closed / replaced while the chain was being asked -> nothing is booked
{
  const pos = { ...basePos(), failedSells: [{ sig: "S1", venue: "curve", attempt: 1 }] };
  const w = world({ pos, statuses: () => [OK], meta: () => exSold(BAL) });
  const args = w.args();
  args.readExecution = async () => {
    w.positions.delete(MINT); // a concurrent path booked and removed it
    return exSold(BAL);
  };
  const r = await resolveTokensGone(args);
  asrt(r.status === "stale" && w.results.length === 0 && w.rows.length === 0 && w.sales.length === 0 && w.closes.length === 0, "stale position: nothing booked twice");
}

// =============================================================================================
// 2. graduation-sniper: the real sellPosition
// =============================================================================================
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
const count = (s, re) => (s.match(re) || []).length;
const gradSrc = read("bots/graduation-sniper/graduation.mjs");
const cut = (src, from, to, what) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  asrt(a >= 0 && b > a, `${what}: source markers found`);
  return src.slice(a, b);
};
const sellCode = cut(gradSrc, "async function sellPosition(", "// Position monitoring loop", "graduation sellPosition");
const T0 = 1_800_000_000_000;
const TODAY = mskDateKey();

// plan(n): outcome of send number n — "late" (confirm error, not on the chain yet) | "fail"
// (landed and failed on-chain). `complete`: the curve is finished -> the PumpSwap path.
function mkGrad({ plan = () => "late", complete = false, maxConsecLosses = 3 } = {}) {
  const w = {
    clock: { t: T0 }, logs: [], results: [], sends: [], closes: [], statusCalls: [], stuck: new Set(),
    balance: BAL, landed: new Set(), statusDown: false, positions: new Map(), mint: MINT, sent: 0,
    wallet: { publicKey: OWNER },
    guard: new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses }),
    journal: new TradeJournal({ bot: "graduation", dir: fs.mkdtempSync(path.join(os.tmpdir(), "late-sale-journal-")) }),
    session: new SessionLedger({ label: "T", mode: "LIVE" }),
  };
  w.rows = (type) => readJournal(w.journal.dir).filter((r) => !type || r.type === type);
  w.log = (m) => w.logs.push(String(m));
  w.recordResult = (pnlSol, opts) => (w.results.push({ pnlSol, opts }), w.guard.recordResult(pnlSol, opts));
  const FakeDate = class extends Date {
    constructor(...a) {
      if (a.length) super(...a);
      else super(w.clock.t);
    }
    static now() {
      return w.clock.t;
    }
  };
  const send = () => {
    const n = w.sends.length;
    w.sends.push(w.clock.t);
    const outcome = plan(n);
    const sig = outcome === "late" ? `SIG_LATE_${n}` : `SIG_FAIL_${n}`;
    if (outcome === "late") throw Object.assign(new Error("network error: connection reset"), { sig });
    throw Object.assign(new Error(`tx ${sig} failed on-chain: {"InstructionError":[2,{"Custom":6003}]}`), { sig });
  };
  const deps = {
    Date: FakeDate,
    DRY_RUN: false, DRY_SELL: false, LIVE: true, BUY_SOL, SELL_MAX_ATTEMPTS: 3, SELL_MAX_SLIPPAGE: 2000,
    SESSION_ID: "S1", PARAMS_HASH: "P1", GIT_SHA: "G1",
    positions: w.positions, stuck: w.stuck, stopping: false, totalTrades: 0, totalPnl: 0, wins: 0,
    journal: w.journal, session: w.session, log: w.log, recordResult: w.recordResult,
    PublicKey, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM, wallet: w.wallet,
    connection: {
      getTokenAccountBalance: async () => ({ value: { amount: w.balance.toString() } }),
      getSignatureStatuses: async (sigs) => {
        w.statusCalls.push([...sigs]);
        if (w.statusDown) throw new Error("rpc down");
        return { value: sigs.map((s) => (s.startsWith("SIG_FAIL") ? FAILED : w.landed.has(s) ? OK : null)) };
      },
    },
    getBondingCurveState: async () => ({ virtualSolReserves: 60_000_000_000n, virtualTokenReserves: 1_073_000_000_000_000n, realSolReserves: 30_000_000_000n, realTokenReserves: 500_000_000_000_000n, complete, creator: null, isMayhemMode: false }),
    chooseSellVenue, planSellParts,
    computeBudgetIxs: () => [], sellIx: (_o, _m, amount) => ({ amount }),
    buildVersionedTx: async (_w, ixs) => ({ ixs }),
    simulateTx: async () => ({ ok: true, err: null, logs: [], units: 50_000 }),
    sendTxWithRetry: async () => send(),
    ammSellOnce: async () => send(), // the AMM attempt: its send error is thrown to the bot, like the real one
    readExecution: async (sig) => (w.landed.has(sig) && !w.statusDown ? exSold(BAL) : sig.startsWith("SIG_FAIL") ? exFailed() : { found: false }),
    applyLiveSell, balanceBeforeSell, ammSellTxCostSol, describeTxError, recordStuck,
    noteFailedSell, resolveTokensGone,
    ataCloser: { schedule: (mint, o) => w.closes.push({ mint, ...o }) },
    markStuck: (mint, pos, reason, extra) => {
      w.markStuckCalls = (w.markStuckCalls || 0) + 1;
      recordStuck({ journal: w.journal, recordResult: w.recordResult, mint, pos, buySol: BUY_SOL, reason, fields: extra });
      w.positions.delete(mint);
    },
    deferSell: () => { throw new Error("deferSell must not be reached in this test"); },
  };
  const names = Object.keys(deps);
  const api = new Function(...names, `"use strict";\n${sellCode}\nreturn { sellPosition, stats: () => ({ totalTrades, totalPnl, wins }) };`)(...names.map((n) => deps[n]));
  Object.assign(w, api);
  w.pos = { tokens: BAL, entryPrice: 1e-7, entrySolSol: 0.02, entrySource: "chain-meta", buyFeeSol: FEE, ataRentSol: 0.00207408, ataRentKnown: true, entryTime: T0 };
  w.positions.set(w.mint, w.pos);
  w.sell = (opts) => w.sellPosition(w.mint, new PublicKey(w.mint), w.pos, 1.5, opts);
  w.assertClean = (label) => asrt(!w.logs.some((l) => /is not defined|is not a function|Cannot read/.test(l)), `${label}: the bot code ran against complete mocks (${w.logs.find((l) => /is not defined|is not a function|Cannot read/.test(l))})`);
  return w;
}
const gradRef = applyLiveSell(basePos(), { buySol: BUY_SOL, ex: exSold(BAL), soldRaw: BAL, totalRaw: BAL });

// 2a. curve attempt "failed", its tx landed -> exactly one sale, the usual PnL, nothing re-sent
{
  const w = mkGrad();
  await w.sell(); // attempt 1: confirm error, the chain shows nothing yet
  asrt(w.sends.length === 1 && w.positions.get(w.mint) === w.pos && w.pos.attempts === 1 && w.pos.nextSellAt === T0 + 2000, "[grad late] attempt 1 failed, position kept, backoff 2 s");
  asrt(JSON.stringify(w.pos.failedSells) === JSON.stringify([{ sig: "SIG_LATE_0", venue: "curve", attempt: 1 }]), `[grad late] the failed attempt's signature and venue stay on the position, got ${JSON.stringify(w.pos.failedSells)}`);
  const failed = w.rows("sell_failed");
  asrt(failed.length === 1 && failed[0].sig === "SIG_LATE_0" && failed[0].venue === "curve" && failed[0].attempt === 1, "[grad late] the sell_failed row is as before");
  w.landed.add("SIG_LATE_0"); // the tx lands during the backoff
  w.balance = 0n;
  w.clock.t = T0 + 1000;
  await w.sell();
  asrt(w.statusCalls.length === 0 && w.positions.has(w.mint), "[grad late] inside the backoff nothing happens");
  w.clock.t = T0 + 2000;
  await w.sell(); // attempt 2 reads 0 tokens
  asrt(w.sends.length === 1, `[grad late] nothing is sent again (sends ${w.sends.length})`);
  const trades = w.rows("trade");
  asrt(trades.length === 1 && !w.positions.has(w.mint), "[grad late] exactly one sale row; position closed");
  const t = trades[0];
  asrt(t.pnlSol === gradRef.acc.pnlSol && t.entrySolSol === gradRef.fields.entrySolSol && t.solReceived === gradRef.fields.solReceived && t.sellFeeSol === FEE && t.buyFeeSol === FEE && t.feesActual === true && t.guardPnlSol === gradRef.guardPnlSol, `[grad late] PnL and live fields equal a normal sale (${gradRef.acc.pnlSol}), got ${t.pnlSol}`);
  asrt(t.reconciledFromSig === "SIG_LATE_0" && t.sig === "SIG_LATE_0" && t.reconciled === true && t.side === "sell" && t.venue === "curve" && t.priceSource === "chain-meta" && t.attempts === 1, "[grad late] the row names the attempt that carried the sale");
  asrt(t.amountRaw === BAL.toString() && t.balanceRaw === BAL.toString() && t.ataRentSol === 0.00207408 && typeof t.costsScheme === "string" && t.sessionId === "S1", "[grad late] amounts, the ATA rent of a closing sale, scheme and session on the row");
  asrt(w.results.length === 1 && w.results[0].pnlSol === gradRef.acc.pnlSol && w.results[0].opts.guardPnlSol === gradRef.guardPnlSol && w.guard.consecLosses === 0, "[grad late] the guard sees one (winning) result");
  asrt(w.session.sells === 1 && w.session.unresolved.length === 0 && JSON.stringify(w.stats()) === JSON.stringify({ totalTrades: 1, totalPnl: gradRef.acc.pnlSol, wins: 1 }), "[grad late] ledger and counters: one winning sell");
  asrt(w.closes.length === 1 && w.closes[0].venue === "curve" && w.rows("stuck").length === 0 && w.stuck.size === 0, "[grad late] ATA close scheduled once, no stuck");
  asrt(netSolForDay(readJournal(w.journal.dir), TODAY) === gradRef.acc.pnlSol, "[grad late] the day's net contains the sale");
  await w.sell();
  asrt(w.sends.length === 1 && w.rows("trade").length === 1, "[grad late] nothing happens afterwards");
  w.assertClean("[grad late]");
}

// 2b. the PumpSwap attempt "failed", its tx landed -> booked with its venue
{
  const w = mkGrad({ complete: true });
  await w.sell();
  asrt(JSON.stringify(w.pos.failedSells) === JSON.stringify([{ sig: "SIG_LATE_0", venue: "pumpswap", attempt: 1 }]), `[grad late amm] the AMM attempt is remembered with its venue, got ${JSON.stringify(w.pos.failedSells)}`);
  w.landed.add("SIG_LATE_0");
  w.balance = 0n;
  w.clock.t = T0 + 2000;
  await w.sell();
  const t = w.rows("trade")[0];
  asrt(w.sends.length === 1 && t && t.venue === "pumpswap" && t.reconciledFromSig === "SIG_LATE_0" && t.pnlSol === gradRef.acc.pnlSol && w.closes.length === 1 && w.closes[0].venue === "pumpswap" && !w.positions.has(w.mint), "[grad late amm] one sale, venue pumpswap, ATA close for that venue");
  w.assertClean("[grad late amm]");
}

// 2c. 0 tokens, the failed attempt did not sell them -> stuck lossAssumed, the limits see it
{
  const w = mkGrad({ plan: () => "fail", maxConsecLosses: 1 });
  await w.sell(); // landed and failed on-chain
  w.balance = 0n;
  w.clock.t = T0 + 2000;
  await w.sell();
  const stuck = w.rows("stuck");
  asrt(stuck.length === 1 && stuck[0].reason === "tokens gone, no landed sale found" && stuck[0].lossAssumed === true && stuck[0].pnlSol === -0.02 && stuck[0].tokens === "0", `[grad gone] stuck row, got ${JSON.stringify(stuck[0])}`);
  asrt(JSON.stringify(stuck[0].failedSigs) === '["SIG_FAIL_0"]' && stuck[0].sessionId === "S1" && stuck[0].attempts === 1 && stuck[0].maxAttempts === 3, "[grad gone] the checked signatures and the bot fields are journaled");
  asrt(!w.positions.has(w.mint) && w.rows("trade").length === 0 && w.sends.length === 1 && w.closes.length === 0 && !w.markStuckCalls, "[grad gone] closed without a sale row; nothing sent; not the 'tokens still in the wallet' STUCK");
  asrt(w.results.length === 1 && w.results[0].pnlSol === -0.02 && w.guard.halted === true, "[grad gone] MAX_CONSEC_LOSSES sees the loss");
  asrt(netSolForDay(readJournal(w.journal.dir), TODAY) === -0.02, "[grad gone] the daily loss limit sees it");
  asrt(w.stuck.size === 1 && [...w.stuck][0].includes("tokens gone, no landed sale found") && w.session.unresolved.length === 1, "[grad gone] listed in the session report");
  w.assertClean("[grad gone]");
}

// 2d. 0 tokens and no failed attempt at all -> the same stuck row
{
  const w = mkGrad();
  w.balance = 0n;
  await w.sell();
  const stuck = w.rows("stuck");
  asrt(stuck.length === 1 && stuck[0].reason === TOKENS_GONE_REASON && stuck[0].lossAssumed === true && stuck[0].pnlSol === -0.02 && JSON.stringify(stuck[0].failedSigs) === "[]", "[grad gone, no attempts] stuck lossAssumed");
  asrt(w.sends.length === 0 && w.statusCalls.length === 0 && !w.positions.has(w.mint) && w.guard.consecLosses === 1 && w.logs.some((l) => /no tokens in wallet/.test(l)), "[grad gone, no attempts] nothing sent or asked; the guard sees it");
  w.assertClean("[grad gone, no attempts]");
}

// 2e. the chain cannot be asked -> kept and asked again; booked when it answers; final = no waiting
{
  const w = mkGrad();
  await w.sell();
  w.landed.add("SIG_LATE_0");
  w.balance = 0n;
  w.statusDown = true;
  w.clock.t = T0 + 2000;
  await w.sell();
  asrt(w.positions.get(w.mint) === w.pos && w.pos.goneLookups === 1 && w.pos.nextSellAt === T0 + 4000 && w.rows("stuck").length === 0 && w.rows("trade").length === 0, "[grad rpc down] lookup failed: position kept, asked again in 2 s");
  w.statusDown = false;
  w.clock.t = T0 + 4000;
  await w.sell();
  asrt(w.rows("trade").length === 1 && w.rows("trade")[0].reconciledFromSig === "SIG_LATE_0" && !w.positions.has(w.mint) && w.sends.length === 1, "[grad rpc down] booked once the chain answers");

  const f = mkGrad();
  await f.sell();
  f.balance = 0n;
  f.statusDown = true;
  f.clock.t = T0 + 2000;
  await f.sell({ final: true }); // session stop: the last call for this position
  const stuck = f.rows("stuck");
  asrt(stuck.length === 1 && stuck[0].lookupFailed === true && stuck[0].lossAssumed === true && !f.positions.has(f.mint), "[grad rpc down, final] the last call does not wait: stuck with lookupFailed");
  f.assertClean("[grad rpc down]");
}

// 2f. graduation wiring
{
  asrt(/import \{ noteFailedSell, resolveTokensGone \} from "\.\.\/\.\.\/lib\/late-sale\.mjs";/.test(gradSrc), "graduation imports the helper");
  asrt(count(sellCode, /resolveTokensGone\(\{/g) === 1 && count(gradSrc, /resolveTokensGone\(\{/g) === 1, "graduation: one zero-balance resolver, inside sellPosition");
  asrt(!/session\.drop\([^)]*no tokens in wallet/.test(gradSrc), "graduation: the position is no longer dropped as 'no tokens in wallet'");
  const hook = sellCode.indexOf("noteFailedSell(pos, err, { venue, attempt });");
  asrt(hook > 0 && hook > sellCode.indexOf("(reconciled after confirm error)") && hook < sellCode.indexOf('type: "sell_failed"'), "graduation: the failed attempt is remembered after the reconciled branch returned, before sell_failed is journaled");
  asrt(/reconciled: true, reconciledFromSig: sig,/.test(sellCode), "graduation: the late sale's row carries reconciledFromSig");
  asrt(!/sell-retry/.test(gradSrc), "graduation still has its own retry policy (not switched to lib/sell-retry.mjs)");
}

// =============================================================================================
// 3. lib/rpc.mjs: a send request that errors still names the transaction
// =============================================================================================
{
  const kp = Keypair.generate();
  const tx = await buildVersionedTx(kp, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })]);
  const own = bs58.encode(tx.signatures[0]);
  asrt(ownSignature(tx) === own && own.length >= 80, "ownSignature = the tx's first signature, base58");
  asrt(ownSignature({ fake: "tx" }) === null && ownSignature({ signatures: [new Uint8Array(64)] }) === null && ownSignature(null) === null, "unsigned / fake transaction -> null");
  let err = null;
  try {
    await sendTxWithRetry(tx, { skipPreflight: true });
  } catch (e) {
    err = e;
  }
  asrt(err && /timed out/.test(err.message), "the fixture's send request fails");
  asrt(err.unconfirmedSig === own && err.sig === undefined, `the error carries unconfirmedSig (not sig: nothing says the node accepted it), got ${err.unconfirmedSig} / ${err.sig}`);
  const pos = {};
  noteFailedSell(pos, err, { venue: "pumpswap", attempt: 1 });
  asrt(pos.failedSells[0].sig === own, "…and a bot remembers it like any other failed attempt");
}

console.log(JSON.stringify({ reason: TOKENS_GONE_REASON, maxLookups: MAX_GONE_LOOKUPS, gradLatePnl: gradRef.acc.pnlSol }));
console.log("PASS: late-landed sale — failed attempts keep their signature; 0 tokens -> the landed sale is booked once (reconciledFromSig) or the position is closed as stuck lossAssumed; graduation sellPosition; send errors carry unconfirmedSig");
