// Close the bot's EMPTY token ATA after a full sale and get its rent back (~0.00207 SOL).
//
// Why: every live buy of a new mint creates the wallet's token ATA and locks its rent-exempt
// deposit there (lib/exec.mjs ataRentPaid). The sale empties the account but leaves it open, so
// the deposit never came back: at a 0.02 SOL stake that is about 10% of the stake on EVERY trade.
//
// The rule this file is built around: THE SALE MUST NEVER SUFFER FROM THE CLOSE.
//   - The close is its OWN transaction, built only after the sale is confirmed and booked. It is
//     never part of the sell transaction: a closeAccount fails when the account holds anything, so
//     one stray token (dust / airdrop arriving between the balance read and the sell) or a partial
//     curve sell would take the whole sale down with it.
//   - Best effort: any failure is a WARN and a journal row. The position, its PnL and the trading
//     loop are not touched, and a mint is tried at most once per session.
//   - Never burns, never closes a non-empty account: a balance other than 0 is a refusal.
//   - The per-trade pnlSol does not change (the rent was never in it, lib/live-pnl.mjs). The rent
//     that came back and the fee of the close go to the session summary and to an `ata_close` row.
//
// Everything that touches the network is injectable (`connection`, `deps`), so `npm test` drives it
// with mocks: no network, no sendTransaction.
import { PublicKey } from "@solana/web3.js";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { CU_PRICE, numOr } from "./config.mjs";
import { TOKEN_2022_PROGRAM } from "./constants.mjs";
import { TOKEN_PROGRAM } from "./pumpswap-sell.mjs";
import { BASE_TX_FEE_LAMPORTS, priorityFeeLamports } from "./fees.mjs";
import { describeTxError } from "./pump-errors.mjs";
import { simulateTx } from "./exec.mjs";
import { sendTxWithRetry } from "./rpc.mjs";
import { buildVersionedTx, computeBudgetIxs } from "./tx.mjs";

// Compute budget of the close transaction. A closeAccount is a few thousand CU (plus 150 per
// compute-budget instruction); the priority fee is charged on the REQUESTED limit, so the bot's
// CU_LIMIT (120k–300k) would cost more than the close is worth. Not measured on a real
// transaction yet: the simulation's unitsConsumed is journaled in every `ata_close` row, and a
// limit that is too low fails the SIMULATION (nothing sent, nothing lost).
export const CLOSE_ATA_CU_LIMIT = numOr(process.env.CLOSE_ATA_CU_LIMIT, 10_000, "CLOSE_ATA_CU_LIMIT");

// Kill switch: ATA_CLOSE=no|0|false|off disables the close (the sale path is then exactly the old
// one). Anything else — including unset — leaves it on.
export function ataCloseEnabled(env = process.env) {
  return !/^(0|no|false|off)$/i.test(String(env.ATA_CLOSE ?? "").trim());
}

const TOKEN_PROGRAMS = [TOKEN_2022_PROGRAM, TOKEN_PROGRAM];
const TOKEN_ACCOUNT_MIN_LEN = 165; // legacy size; Token-2022 accounts are this long or longer
const toPk = (x) => (x instanceof PublicKey ? x : new PublicKey(String(x)));
const sol = (lamports) => Math.round(Number(lamports)) / 1e9;

// What the close transaction costs when the chain cannot be asked: base fee + priority fee on the
// requested limit.
export function closeFeeLamports({ cuPrice = CU_PRICE, cuLimit = CLOSE_ATA_CU_LIMIT } = {}) {
  return BASE_TX_FEE_LAMPORTS + priorityFeeLamports({ cuPrice, cuLimit });
}

// Fields of an SPL token account (both programs share the first 165 bytes):
//   mint 0..32, owner (authority) 32..64, amount u64 LE at 64.
export function decodeTokenAccount(data) {
  if (!data || data.length < TOKEN_ACCOUNT_MIN_LEN) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return {
    mint: new PublicKey(buf.subarray(0, 32)),
    owner: new PublicKey(buf.subarray(32, 64)),
    amount: buf.readBigUInt64LE(64),
  };
}

// The wallet's ATA of `mint`, read from the chain (read-only, one request).
//
// The ATA address depends on the token program, and pump mints exist under both (Token-2022 now,
// legacy Token earlier), so both addresses are derived and looked up. The token program used for
// the close is the OWNER OF THE ACCOUNT as the chain reports it — never a constant.
//   { found:false }                                   no such account
//   { found:true, ok:false, reason }                  an account is there but is not ours to close
//   { found:true, ok:true, ata, program, amount, lamports }
export async function readTokenAta({ connection, owner, mint }) {
  const ownerPk = toPk(owner);
  const mintPk = toPk(mint);
  const candidates = TOKEN_PROGRAMS.map((program) => getAssociatedTokenAddressSync(mintPk, ownerPk, true, program));
  const infos = await connection.getMultipleAccountsInfo(candidates, "confirmed");
  for (let i = 0; i < candidates.length; i++) {
    const info = infos?.[i];
    if (!info) continue;
    const ata = candidates[i];
    const program = toPk(info.owner);
    const base = { found: true, ata, program, lamports: Number(info.lamports) };
    // The account must belong to the very token program its address was derived with.
    if (!program.equals(TOKEN_PROGRAMS[i])) return { ...base, ok: false, reason: "unknown-program" };
    const acc = decodeTokenAccount(info.data);
    if (!acc) return { ...base, ok: false, reason: "not-a-token-account" };
    if (!acc.mint.equals(mintPk) || !acc.owner.equals(ownerPk)) return { ...base, ok: false, reason: "not-owner" };
    return { ...base, ok: true, amount: acc.amount };
  }
  return { found: false };
}

// What a landed close transaction did, from its meta (measured, like lib/exec.mjs readExecution):
//   rent  = the ATA's own lamports that left it (its balance went >0 -> 0)
//   fee   = meta.fee
// `found:false` when the meta is not available yet (the caller falls back and FLAGS it).
export async function readCloseExecution(connection, sig, ata, { retries = 4, delayMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ataStr = toPk(ata).toBase58();
  for (let i = 0; i < retries; i++) {
    let tx = null;
    try {
      tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch {
      tx = null;
    }
    if (tx?.meta) {
      const msg = tx.transaction.message;
      const str = (k) => (k?.toBase58 ? k.toBase58() : String(k));
      const loaded = tx.meta.loadedAddresses;
      const keys = [...(msg.staticAccountKeys || msg.accountKeys || []), ...(loaded?.writable || []), ...(loaded?.readonly || [])].map(str);
      const idx = keys.indexOf(ataStr);
      const pre = idx >= 0 ? tx.meta.preBalances?.[idx] : null;
      const post = idx >= 0 ? tx.meta.postBalances?.[idx] : null;
      const measured = Number.isFinite(pre) && Number.isFinite(post);
      return {
        found: true,
        err: tx.meta.err ?? null,
        feeLamports: tx.meta.fee ?? 0,
        // Rent came back only if the account was really emptied by this transaction.
        rentLamports: measured && pre > 0 && post === 0 ? pre : 0,
        rentMeasured: measured,
      };
    }
    if (i < retries - 1) await sleep(delayMs);
  }
  return { found: false };
}

const refusal = (reason, extra = {}) => ({ closed: false, reason, sig: null, rentReclaimedSol: 0, feeSol: 0, ...extra });

/**
 * Close the wallet's token ATA of `mint` if — and only if — it exists and is EMPTY.
 *
 * Result: { closed, reason, sig, rentReclaimedSol, feeSol, ... }
 *   reason  "closed"       the account is closed, the rent is back in the wallet
 *           "dry-run"      not live: nothing is read, built or sent
 *           "absent"       there is no such account
 *           "not-empty"    the balance is not 0 — never closed, never burned
 *           "unknown-program" | "not-a-token-account" | "not-owner"   not ours to close
 *           "sim-fail"     the simulation failed — NOT sent (error + logs returned)
 *           "send-fail"    the send / confirmation failed (maybeLanded: the tx has a signature and
 *                          its outcome is unknown)
 *   rentSource "chain-meta" (measured from the transaction) | "account-balance" (the meta was not
 *              available: the account's lamports read before the close)
 *   feeActual  false when the fee is the estimate (meta not available)
 *
 * Throws only on a read error before anything is built; createAtaCloser turns that into a WARN.
 */
export async function closeEmptyTokenAta({ connection, wallet, mint, live, cuPrice = CU_PRICE, cuLimit = CLOSE_ATA_CU_LIMIT, deps = {} }) {
  // DRY RUN: no RPC, no transaction, nothing.
  if (!live) return refusal("dry-run");
  const D = { buildVersionedTx, simulateTx, sendTxWithRetry, readCloseExecution, ...deps };

  const acct = await readTokenAta({ connection, owner: wallet.publicKey, mint });
  if (!acct.found) return refusal("absent");
  const ident = { ata: acct.ata.toBase58(), tokenProgram: acct.program.toBase58() };
  if (!acct.ok) return refusal(acct.reason, ident);
  // Anything left on the account (dust, an airdrop, an RPC that still shows the pre-sale balance)
  // is a refusal: closing would need a burn, and burning is not this bot's decision.
  if (acct.amount !== 0n) return refusal("not-empty", { ...ident, balanceRaw: acct.amount.toString() });

  const ixs = [
    ...computeBudgetIxs(cuPrice, cuLimit),
    // destination = authority = the bot's wallet; the program is the account's own owner.
    createCloseAccountInstruction(acct.ata, wallet.publicKey, wallet.publicKey, [], acct.program),
  ];
  const tx = await D.buildVersionedTx(wallet, ixs);
  const sim = await D.simulateTx(tx);
  const units = sim.units ?? null;
  if (!sim.ok) {
    return refusal("sim-fail", { ...ident, error: describeTxError(sim.err), logs: sim.logs ?? [], unitsConsumed: units });
  }

  let sig = null;
  let reconciled = false;
  try {
    sig = await D.sendTxWithRetry(tx, { skipPreflight: true });
  } catch (err) {
    // The close may have landed although the confirmation failed. Only the chain can tell.
    const landed = err?.sig ? await D.readCloseExecution(connection, err.sig, acct.ata).catch(() => null) : null;
    if (!(landed?.found && !landed.err)) {
      return refusal("send-fail", { ...ident, sig: err?.sig ?? null, error: describeTxError(err), unitsConsumed: units, maybeLanded: !!err?.sig && !landed?.found });
    }
    sig = err.sig;
    reconciled = true;
  }

  const ex = await D.readCloseExecution(connection, sig, acct.ata).catch(() => null);
  const fromMeta = ex?.found === true && ex.rentMeasured === true;
  return {
    closed: true,
    reason: "closed",
    sig,
    // Measured from the transaction; if its meta is not available, the lamports the account held
    // right before the close (a closeAccount moves all of them to the destination).
    rentReclaimedSol: sol(fromMeta ? ex.rentLamports : acct.lamports),
    feeSol: sol(ex?.found ? ex.feeLamports : closeFeeLamports({ cuPrice, cuLimit })),
    rentSource: fromMeta ? "chain-meta" : "account-balance",
    feeActual: ex?.found === true,
    unitsConsumed: units,
    ...ident,
    ...(reconciled ? { reconciled: true } : {}),
  };
}

/**
 * The bots' entry point: closes ATAs in the BACKGROUND after full sales, never throws, never
 * blocks the sell loop, at most one attempt per mint per session.
 *
 *   closer.schedule(mint, { venue })   call right after a sale that CLOSED the position
 *   await closer.drain(timeoutMs)      before the session summary (so the ledger has the closes)
 *
 * Each attempt writes one `ata_close` journal row and, when the account was closed, feeds the
 * session ledger (SessionLedger.ataClose). A failure is a WARN; the trade is already booked.
 */
export function createAtaCloser({ connection, wallet, live, enabled = ataCloseEnabled(), session = null, journal = null, log = () => {}, warn = log, meta = {}, cuPrice, cuLimit, deps = {} }) {
  const attempted = new Set();
  const pending = new Set();

  async function run(mint, extra) {
    let r;
    try {
      r = await closeEmptyTokenAta({ connection, wallet, mint, live, ...(cuPrice != null ? { cuPrice } : {}), ...(cuLimit != null ? { cuLimit } : {}), deps });
    } catch (e) {
      r = refusal("error", { error: String(e?.message || e) });
    }
    const short = mint.slice(0, 12);
    try {
      if (r.closed) session?.ataClose({ rentReclaimedSol: r.rentReclaimedSol, feeSol: r.feeSol });
    } catch (e) {
      warn(`  WARN ATA close ${short}: ledger not updated (${e?.message || e})`);
    }
    try {
      journal?.write({
        type: "ata_close",
        ...meta,
        mode: "LIVE",
        mint,
        ...extra,
        closed: r.closed,
        reason: r.reason,
        sig: r.sig ?? null,
        rentReclaimedSol: r.rentReclaimedSol,
        closeFeeSol: r.feeSol,
        ata: r.ata ?? null,
        tokenProgram: r.tokenProgram ?? null,
        unitsConsumed: r.unitsConsumed ?? null,
        ...(r.closed ? { rentSource: r.rentSource, feeActual: r.feeActual } : {}),
        ...(r.reconciled ? { reconciled: true } : {}),
        ...(r.balanceRaw != null ? { balanceRaw: r.balanceRaw } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(r.logs?.length ? { logs: r.logs } : {}),
        ...(r.maybeLanded ? { maybeLanded: true } : {}),
      });
    } catch (e) {
      warn(`  WARN ATA close ${short}: journal row not written (${e?.message || e})`);
    }
    if (r.closed) {
      log(`  ATA closed ${short}: +${r.rentReclaimedSol.toFixed(6)} SOL rent back, fee ${r.feeSol.toFixed(6)} SOL${r.reconciled ? " (reconciled after confirm error)" : ""}`);
    } else if (r.reason === "absent" || r.reason === "not-empty") {
      log(`  ATA not closed ${short}: ${r.reason}${r.balanceRaw ? ` (balance ${r.balanceRaw})` : ""} — rent stays locked`);
    } else {
      warn(`  WARN ATA close failed ${short}: ${r.reason}${r.error ? ` — ${r.error}` : ""}; the sale is booked, rent stays locked (scripts/close-empty-atas.mjs can retry)`);
    }
    return r;
  }

  return {
    // Never rejects and never throws: whatever happens here must not reach the sell path.
    schedule(mint, extra = {}) {
      try {
        const m = typeof mint === "string" ? mint : toPk(mint).toBase58();
        if (!live) return Promise.resolve(refusal("dry-run"));
        if (!enabled) return Promise.resolve(refusal("disabled"));
        if (attempted.has(m)) return Promise.resolve(refusal("already-attempted"));
        attempted.add(m);
        const p = run(m, extra).catch((e) => refusal("error", { error: String(e?.message || e) }));
        pending.add(p);
        p.finally(() => pending.delete(p));
        return p;
      } catch (e) {
        return Promise.resolve(refusal("error", { error: String(e?.message || e) }));
      }
    },
    // Wait for the closes still in flight (bounded: a stop must not hang on a slow confirmation).
    async drain(timeoutMs = 30_000) {
      if (pending.size) {
        let timer;
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((r) => {
            timer = setTimeout(r, timeoutMs);
          }),
        ]);
        clearTimeout(timer);
      }
      return { pending: pending.size };
    },
    get pending() {
      return pending.size;
    },
    get attempted() {
      return attempted.size;
    },
  };
}

// ---- wallet sweep (scripts/close-empty-atas.mjs) -------------------------------------------------

// Every token account of the wallet under both token programs, split into the EMPTY ones (the only
// ones that may ever be closed) and the rest. Read-only.
//   skipMints: mints never offered for closing (the script passes WSOL: its account belongs to the
//   AMM sell path, which opens and closes it itself).
export async function listTokenAccounts({ connection, owner, skipMints = [] }) {
  const ownerPk = toPk(owner);
  const skip = new Set(skipMints.map((m) => toPk(m).toBase58()));
  const empty = [];
  const kept = [];
  for (const program of TOKEN_PROGRAMS) {
    const res = await connection.getTokenAccountsByOwner(ownerPk, { programId: program }, "confirmed");
    for (const { pubkey, account } of res?.value ?? []) {
      const acc = decodeTokenAccount(account.data);
      const row = { address: toPk(pubkey), program, lamports: Number(account.lamports), mint: acc?.mint ?? null, amount: acc?.amount ?? null };
      // The program is the account's owner as the chain reports it; a mismatch is never closed.
      const ours = acc && toPk(account.owner).equals(program) && acc.owner.equals(ownerPk);
      if (ours && acc.amount === 0n && !skip.has(acc.mint.toBase58())) empty.push(row);
      else kept.push({ ...row, why: !ours ? "not-owner" : acc.amount !== 0n ? "not-empty" : "skipped-mint" });
    }
  }
  return { empty, kept };
}

// Close EMPTY token accounts in batches: several closeAccount per transaction, each batch
// simulated before it is sent. `accounts` must come from listTokenAccounts().empty — and every
// account is still re-checked here: anything with a balance is dropped, not closed.
//   live:false -> plan only: nothing is built, simulated or sent.
export async function closeEmptyAccounts({ connection, wallet, accounts, live, batchSize = 8, cuPrice = CU_PRICE, cuLimitPerClose = CLOSE_ATA_CU_LIMIT, log = () => {}, deps = {} }) {
  const D = { buildVersionedTx, simulateTx, sendTxWithRetry, ...deps };
  const safe = accounts.filter((a) => a.amount === 0n);
  const batches = [];
  for (let i = 0; i < safe.length; i += batchSize) batches.push(safe.slice(i, i + batchSize));
  const out = { planned: safe.length, refused: accounts.length - safe.length, closed: 0, rentReclaimedSol: 0, feeSol: 0, batches: [] };
  if (!live) return out;
  for (const batch of batches) {
    const cuLimit = cuLimitPerClose * batch.length;
    const ixs = [
      ...computeBudgetIxs(cuPrice, cuLimit),
      ...batch.map((a) => createCloseAccountInstruction(a.address, wallet.publicKey, wallet.publicKey, [], a.program)),
    ];
    const rec = { accounts: batch.map((a) => a.address.toBase58()), sent: false, sig: null, error: null, unitsConsumed: null };
    out.batches.push(rec);
    try {
      const tx = await D.buildVersionedTx(wallet, ixs);
      const sim = await D.simulateTx(tx);
      rec.unitsConsumed = sim.units ?? null;
      if (!sim.ok) {
        rec.error = `simulation: ${describeTxError(sim.err)}`;
        log(`  batch of ${batch.length}: simulation failed (${rec.error}) — NOT sent`);
        continue;
      }
      rec.sig = await D.sendTxWithRetry(tx, { skipPreflight: true });
      rec.sent = true;
      const rent = batch.reduce((s, a) => s + a.lamports, 0);
      out.closed += batch.length;
      out.rentReclaimedSol = sol(Math.round(out.rentReclaimedSol * 1e9) + rent);
      out.feeSol = sol(Math.round(out.feeSol * 1e9) + closeFeeLamports({ cuPrice, cuLimit }));
      log(`  batch of ${batch.length}: closed, +${sol(rent).toFixed(6)} SOL (${rec.sig})`);
    } catch (e) {
      rec.error = describeTxError(e);
      rec.sig = e?.sig ?? null;
      log(`  batch of ${batch.length}: send failed (${rec.error})`);
    }
  }
  return out;
}
