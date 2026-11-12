import "./lib/test-env.mjs";
// Task 7: after a FULL live sale the bot closes its EMPTY token ATA and gets the rent back.
//
// The rule under test: the sale never suffers from the close. The close is a separate transaction,
// best effort, at most once per mint; a balance other than 0 is a refusal (no burn); the per-trade
// pnlSol does not move; the session summary still reconciles with the wallet.
//
// No network: the "chain" below is a fake that keeps token accounts and EXECUTES the instructions
// of a simulated / sent transaction (a closeAccount of a non-empty account or with the wrong token
// program fails), so the helper cannot pass by building the wrong thing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

const { closeEmptyTokenAta, createAtaCloser, readCloseExecution, readTokenAta, closeFeeLamports, ataCloseEnabled, CLOSE_ATA_CU_LIMIT } = await import("../lib/close-ata.mjs");
const { TOKEN_2022_PROGRAM } = await import("../lib/constants.mjs");
const { TOKEN_PROGRAM } = await import("../lib/pumpswap-sell.mjs");
const { CU_LIMIT, CU_PRICE } = await import("../lib/config.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const { applyLiveSell, liveEntry } = await import("../lib/live-pnl.mjs");
const { netSolForDay } = await import("../lib/daily-loss.mjs");
const { COSTS_SCHEME } = await import("../lib/fees.mjs");

const RENT_2022 = 2_074_080; // lamports, as measured for a pump Token-2022 ATA
const RENT_LEGACY = 2_039_280;
const WALLET_START = 1_000_000_000;
const wallet = Keypair.generate();

function tokenAccountData({ mint, owner, amount = 0n, len = 165 }) {
  const buf = Buffer.alloc(len);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  buf[108] = 1; // initialized
  return buf;
}

// ---- the fake chain -----------------------------------------------------------------------------
function makeChain() {
  const accounts = new Map(); // address -> { owner (program), lamports, data }
  const txs = new Map(); // sig -> getTransaction() result
  const calls = { reads: 0, getTx: 0, built: [], simulated: 0, sent: [] };
  const opts = { simFail: false, sendThrow: null, metaMissing: false, readThrows: false };
  let walletLamports = WALLET_START;
  let n = 0;

  const isClose = (ix) => ix.data.length === 1 && ix.data[0] === 9; // spl-token CloseAccount
  const budget = (tx) => {
    let limit = 200_000;
    let price = 0;
    for (const ix of tx.ixs) {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) continue;
      if (ix.data[0] === 2) limit = ix.data.readUInt32LE(1);
      if (ix.data[0] === 3) price = Number(ix.data.readBigUInt64LE(1));
    }
    return { limit, price, fee: 5000 + Math.ceil((price * limit) / 1e6) };
  };
  // What the token program would answer to each closeAccount of this transaction.
  const programError = (tx) => {
    for (const ix of tx.ixs.filter(isClose)) {
      const acc = accounts.get(ix.keys[0].pubkey.toBase58());
      if (!acc) return "AccountNotFound";
      if (!acc.owner.equals(ix.programId)) return "IncorrectProgramId";
      if (!ix.keys[1].pubkey.equals(wallet.publicKey) || !ix.keys[2].pubkey.equals(wallet.publicKey)) return "wrong destination/authority";
      if (!ix.keys[2].isSigner) return "authority must sign";
      if (acc.data.readBigUInt64LE(64) !== 0n) return { InstructionError: [2, { Custom: 11 }] }; // NonNativeHasBalance
    }
    return null;
  };
  const land = (tx, sig) => {
    const { fee } = budget(tx);
    const keys = [wallet.publicKey];
    const pre = [walletLamports];
    const post = [walletLamports];
    for (const ix of tx.ixs.filter(isClose)) {
      const addr = ix.keys[0].pubkey;
      const acc = accounts.get(addr.toBase58());
      keys.push(addr);
      pre.push(acc.lamports);
      post.push(0);
      post[0] += acc.lamports;
      accounts.delete(addr.toBase58());
    }
    post[0] -= fee;
    walletLamports = post[0];
    txs.set(sig, { meta: { err: null, fee, preBalances: pre, postBalances: post }, transaction: { message: { staticAccountKeys: keys } } });
  };

  const connection = {
    async getMultipleAccountsInfo(keys) {
      calls.reads += 1;
      if (opts.readThrows) throw new Error("429 Too Many Requests");
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
    async getTransaction(sig) {
      calls.getTx += 1;
      return opts.metaMissing ? null : (txs.get(sig) ?? null);
    },
  };
  const deps = {
    buildVersionedTx: async (payer, ixs) => {
      const tx = { ixs, payer: payer.publicKey };
      calls.built.push(tx);
      return tx;
    },
    simulateTx: async (tx) => {
      calls.simulated += 1;
      if (opts.simFail) return { ok: false, err: { InstructionError: [2, { Custom: 11 }] }, logs: ["Program log: Error: Non-native account can only be closed if its balance is zero"], units: 1_800 };
      const err = programError(tx);
      return err ? { ok: false, err, logs: [`Program log: ${JSON.stringify(err)}`], units: null } : { ok: true, err: null, logs: [], units: 3_150 };
    },
    sendTxWithRetry: async (tx) => {
      const sig = `SIG${++n}`;
      calls.sent.push({ tx, sig });
      if (opts.sendThrow === "nosig") throw new Error("failed to send: rpc down");
      if (opts.sendThrow === "landed" || opts.sendThrow === "lost") {
        if (opts.sendThrow === "landed") land(tx, sig);
        const e = new Error("confirmation timed out");
        e.sig = sig;
        throw e;
      }
      const err = programError(tx);
      if (err) {
        const e = new Error(`tx ${sig} failed on-chain: ${JSON.stringify(err)}`);
        e.sig = sig;
        e.err = err;
        throw e;
      }
      land(tx, sig);
      return sig;
    },
    readCloseExecution: (c, sig, ata) => readCloseExecution(c, sig, ata, { retries: 1, delayMs: 0 }),
  };
  const addAta = ({ mint = Keypair.generate().publicKey, program = TOKEN_2022_PROGRAM, amount = 0n, lamports = RENT_2022, owner = wallet.publicKey, heldBy = program, len = 165 } = {}) => {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, true, program);
    accounts.set(ata.toBase58(), { owner: heldBy, lamports, data: tokenAccountData({ mint, owner, amount, len }) });
    return { mint, ata };
  };
  return { accounts, txs, calls, opts, connection, deps, addAta, walletDelta: () => (walletLamports - WALLET_START) / 1e9 };
}

const closeIx = (tx) => tx.ixs.find((ix) => ix.data.length === 1 && ix.data[0] === 9);
const cuOf = (tx) => tx.ixs.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2).data.readUInt32LE(1);
const priceOf = (tx) => Number(tx.ixs.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3).data.readBigUInt64LE(1));
const run = (c, mint, extra = {}) => closeEmptyTokenAta({ connection: c.connection, wallet, mint, live: true, deps: c.deps, ...extra });

// ---- 1. Token-2022 ATA, empty: closed, rent measured from the transaction ----------------------
{
  const c = makeChain();
  const { mint, ata } = c.addAta({ program: TOKEN_2022_PROGRAM, len: 170 }); // Token-2022 accounts can be longer
  const r = await run(c, mint.toBase58()); // the bots pass the mint as a string
  asrt(r.closed === true && r.reason === "closed", `empty Token-2022 ATA is closed (got ${r.reason})`);
  asrt(c.calls.built.length === 1 && c.calls.simulated === 1 && c.calls.sent.length === 1, "one transaction: built, simulated, sent");
  const tx = c.calls.built[0];
  const ix = closeIx(tx);
  asrt(ix && ix.programId.equals(TOKEN_2022_PROGRAM), "closeAccount goes to the Token-2022 program (the account's owner)");
  asrt(ix.keys[0].pubkey.equals(ata) && ix.keys[1].pubkey.equals(wallet.publicKey) && ix.keys[2].pubkey.equals(wallet.publicKey) && ix.keys[2].isSigner, "account = the ATA; destination and authority = the bot's wallet");
  asrt(tx.ixs.length === 3, "the transaction is compute budget x2 + closeAccount, nothing else (no burn, no sell)");
  asrt(cuOf(tx) === CLOSE_ATA_CU_LIMIT && CLOSE_ATA_CU_LIMIT === 10_000, `small CU limit for the close (10 000), got ${cuOf(tx)}`);
  asrt(cuOf(tx) < CU_LIMIT, "not the bot's trading CU_LIMIT (the priority fee is charged on the requested limit)");
  asrt(priceOf(tx) === CU_PRICE, "CU price as the bot's");
  asrt(near(r.rentReclaimedSol, RENT_2022 / 1e9), `rentReclaimedSol = the ATA's lamports from the tx meta (${RENT_2022 / 1e9}), got ${r.rentReclaimedSol}`);
  const fee = closeFeeLamports();
  asrt(fee === 5000 + Math.ceil((CU_PRICE * 10_000) / 1e6), "close fee = base 5000 + priority on 10 000 CU");
  asrt(near(r.feeSol, fee / 1e9) && r.feeActual === true && r.rentSource === "chain-meta", `feeSol from the tx meta (${fee / 1e9}), got ${r.feeSol}`);
  asrt(r.sig === "SIG1" && r.ata === ata.toBase58() && r.tokenProgram === TOKEN_2022_PROGRAM.toBase58() && r.unitsConsumed === 3_150, "result carries sig, ata, token program, unitsConsumed");
  asrt(!c.accounts.has(ata.toBase58()), "the account is gone from the chain");
  asrt(near(c.walletDelta(), (RENT_2022 - fee) / 1e9), "wallet delta = rent - fee");
  // The close is worth it: its fee is a small part of the rent.
  asrt(fee < RENT_2022 / 50, `close fee (${fee} lamports) is under 2% of the rent`);
}

// ---- 2. legacy Token ATA: the program comes from the account, not from a constant --------------
{
  const c = makeChain();
  const { mint, ata } = c.addAta({ program: TOKEN_PROGRAM, lamports: RENT_LEGACY });
  const seen = await readTokenAta({ connection: c.connection, owner: wallet.publicKey, mint });
  asrt(seen.found && seen.ok && seen.program.equals(TOKEN_PROGRAM) && seen.ata.equals(ata) && seen.amount === 0n, "legacy ATA is found under the legacy program");
  const r = await run(c, mint);
  asrt(r.closed === true, `legacy ATA is closed (got ${r.reason}: ${r.error ?? ""})`);
  const ix = closeIx(c.calls.built[0]);
  asrt(ix.programId.equals(TOKEN_PROGRAM) && !ix.programId.equals(TOKEN_2022_PROGRAM), "closeAccount goes to the legacy Token program");
  asrt(ix.keys[0].pubkey.equals(ata), "…and closes the ATA derived under that program");
  asrt(near(r.rentReclaimedSol, RENT_LEGACY / 1e9) && r.tokenProgram === TOKEN_PROGRAM.toBase58(), "legacy rent measured (0.00203928)");
}

// ---- 3. balance != 0 (dust / airdrop): never closed, never burned ------------------------------
{
  const c = makeChain();
  const { mint, ata } = c.addAta({ amount: 1n });
  const r = await run(c, mint);
  asrt(r.closed === false && r.reason === "not-empty" && r.balanceRaw === "1", `1 raw token left -> not-empty (got ${r.reason})`);
  asrt(c.calls.built.length === 0 && c.calls.simulated === 0 && c.calls.sent.length === 0, "not-empty: nothing built, simulated or sent");
  asrt(c.accounts.has(ata.toBase58()) && r.rentReclaimedSol === 0 && r.feeSol === 0 && r.sig === null, "the account and its tokens are untouched");
}

// ---- 4. no account / not ours ------------------------------------------------------------------
{
  const c = makeChain();
  const r = await run(c, Keypair.generate().publicKey);
  asrt(r.closed === false && r.reason === "absent" && c.calls.built.length === 0, "no ATA -> absent, nothing built");

  const other = makeChain();
  const a = other.addAta({ owner: Keypair.generate().publicKey }); // token account authority is someone else
  const r2 = await run(other, a.mint);
  asrt(r2.closed === false && r2.reason === "not-owner" && other.calls.built.length === 0, `foreign authority -> not-owner (got ${r2.reason})`);

  const odd = makeChain();
  const b = odd.addAta({ heldBy: Keypair.generate().publicKey }); // account owned by an unknown program
  const r3 = await run(odd, b.mint);
  asrt(r3.closed === false && r3.reason === "unknown-program" && odd.calls.built.length === 0, `unknown owner program -> refused (got ${r3.reason})`);
}

// ---- 5. DRY RUN: not one RPC call, not one transaction -----------------------------------------
{
  const c = makeChain();
  const { mint, ata } = c.addAta();
  const r = await closeEmptyTokenAta({ connection: c.connection, wallet, mint, live: false, deps: c.deps });
  asrt(r.closed === false && r.reason === "dry-run", "dry run -> reason dry-run");
  asrt(c.calls.reads === 0 && c.calls.built.length === 0 && c.calls.simulated === 0 && c.calls.sent.length === 0 && c.calls.getTx === 0, "dry run: no read, no build, no simulation, no send");
  asrt(c.accounts.has(ata.toBase58()), "dry run: the account stays");
}

// ---- 6. simulation failed: NOT sent ------------------------------------------------------------
{
  const c = makeChain();
  const { mint, ata } = c.addAta();
  c.opts.simFail = true;
  const r = await run(c, mint);
  asrt(r.closed === false && r.reason === "sim-fail", `failed simulation -> sim-fail (got ${r.reason})`);
  asrt(c.calls.simulated === 1 && c.calls.sent.length === 0, "a failed simulation is never sent");
  asrt(typeof r.error === "string" && r.error.length > 0 && r.logs.length === 1 && r.unitsConsumed === 1_800, "the reason, the program logs and the CU are returned for the journal");
  asrt(c.accounts.has(ata.toBase58()) && r.rentReclaimedSol === 0 && r.feeSol === 0, "nothing reclaimed, nothing paid");
}

// ---- 7. send failures --------------------------------------------------------------------------
{
  // never reached the chain
  const c = makeChain();
  const { mint } = c.addAta();
  c.opts.sendThrow = "nosig";
  const r = await run(c, mint);
  asrt(r.closed === false && r.reason === "send-fail" && r.sig === null && !r.maybeLanded, `send error without a signature -> send-fail (got ${r.reason})`);
  asrt(r.rentReclaimedSol === 0 && r.feeSol === 0, "send-fail books nothing");

  // confirm error, but the close LANDED: the chain is the truth
  const l = makeChain();
  const a = l.addAta();
  l.opts.sendThrow = "landed";
  const r2 = await run(l, a.mint);
  asrt(r2.closed === true && r2.reconciled === true && r2.sig === "SIG1", `a close that landed despite a confirm error is booked (got ${r2.reason})`);
  asrt(near(r2.rentReclaimedSol, RENT_2022 / 1e9) && near(r2.feeSol, closeFeeLamports() / 1e9), "…with the rent and the fee from its meta");

  // confirm error and nothing on the chain yet: unknown outcome, flagged
  const u = makeChain();
  const b = u.addAta();
  u.opts.sendThrow = "lost";
  const r3 = await run(u, b.mint);
  asrt(r3.closed === false && r3.reason === "send-fail" && r3.sig === "SIG1" && r3.maybeLanded === true, "confirm error + no meta -> send-fail with maybeLanded");

  // sent and confirmed, but the meta is not available: flagged fallback, never silent
  const m = makeChain();
  const d = m.addAta();
  m.opts.metaMissing = true;
  const r4 = await run(m, d.mint);
  asrt(r4.closed === true && r4.rentSource === "account-balance" && r4.feeActual === false, "meta missing -> rent from the pre-close balance, fee estimated, both flagged");
  asrt(near(r4.rentReclaimedSol, RENT_2022 / 1e9) && near(r4.feeSol, closeFeeLamports() / 1e9), "…with the same numbers");
}

// ---- 8. kill switch -----------------------------------------------------------------------------
asrt(ataCloseEnabled({}) === true && ataCloseEnabled({ ATA_CLOSE: "yes" }) === true, "ATA close is on by default");
asrt(["no", "0", "false", "OFF"].every((v) => ataCloseEnabled({ ATA_CLOSE: v }) === false), "ATA_CLOSE=no|0|false|off turns it off");

// ---- 9. the bots' entry point: createAtaCloser --------------------------------------------------
const quiet = () => {};
const captureStdout = async (fn) => {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => ((out += String(s)), true);
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
};

// One live round trip as every bot books it (lib/live-pnl.mjs), numbers in SOL.
const ENTRY = 0.0198;
const BUY_FEE = 0.000185;
const SELL_FEE = 0.000185;
const SELL_DELTA = 0.0205; // wallet delta of the sell, already net of its fee
const RENT = RENT_2022 / 1e9;
const CLOSE_FEE = closeFeeLamports() / 1e9;
function bookRoundTrip(session, { sold = 1000n, total = 1000n } = {}) {
  const pos = { tokens: total, ...liveEntry({ found: true, solSpentSol: ENTRY, feeSol: BUY_FEE, ataRentPaidSol: RENT, ataRentKnown: true }, 0.02) };
  session.buy(pos.entrySolSol).ataRent(pos.ataRentSol);
  const ex = { found: true, feeSol: SELL_FEE, solDeltaSol: SELL_DELTA, solReceivedSol: SELL_DELTA, rentReturnedSol: 0, tokensSold: sold };
  const sale = applyLiveSell(pos, { buySol: 0.02, ex, soldRaw: sold, totalRaw: total });
  session.sell(sale.acc.ledger.receivedSol, sale.acc.ledger.pnlSol, sale.acc.costs);
  return sale;
}
const mkCloser = (c, session, journal, logs, extra = {}) =>
  createAtaCloser({
    connection: c.connection,
    wallet,
    live: true,
    enabled: true,
    session,
    journal,
    log: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    meta: { sessionId: "S1", paramsHash: "P1", gitSha: "G1" },
    deps: c.deps,
    ...extra,
  });
const mkJournal = () => ({ rows: [], write(r) { this.rows.push(r); } });
const mkLogs = () => ({ info: [], warn: [] });

// 9a. full sale -> closed; the summary reconciles with the wallet; the trade's numbers do not move
{
  const c = makeChain();
  const { mint } = c.addAta();
  const m = mint.toBase58();
  const session = new SessionLedger({ label: "T", mode: "LIVE", startSol: 2 });
  const twin = new SessionLedger({ label: "TWIN", mode: "LIVE", startSol: 2 }); // the same trade, no close
  const journal = mkJournal();
  const logs = mkLogs();
  const sale = bookRoundTrip(session);
  const saleTwin = bookRoundTrip(twin);
  asrt(sale.closed === true, "the round trip is a full sale");

  const closer = mkCloser(c, session, journal, logs);
  const p = closer.schedule(m, { venue: "curve" });
  asrt(p instanceof Promise && closer.pending === 1, "schedule returns at once: the close runs in the background");
  const left = await closer.drain(5_000);
  asrt(left.pending === 0 && closer.pending === 0, "drain waits for the close");
  const r = await p;
  asrt(r.closed === true && c.calls.sent.length === 1, "full sale -> the closeAccount transaction is sent");

  asrt(near(session.ataRentReclaimedSol, RENT) && near(session.ataCloseFeeSol, CLOSE_FEE) && session.ataCloses === 1, "the ledger has the reclaimed rent and the close fee");
  asrt(near(session.ataRentLockedSol, 0), `rent locked = paid - reclaimed = 0, got ${session.ataRentLockedSol}`);

  let sum;
  let sumTwin;
  const out = await captureStdout(async () => {
    sum = session.report({ reason: "test", endSol: 2 + c.walletDelta() });
    sumTwin = twin.report({ reason: "test" });
  });
  // wallet: buy (-entry - fee - rent), sell (+delta), close (+rent - fee)
  const walletDelta = -(ENTRY + BUY_FEE + RENT) + SELL_DELTA + (RENT - CLOSE_FEE);
  asrt(near(sum.netAfterCostsInclRentSol, walletDelta, 1e-9), `NET after costs incl. rent == wallet delta incl. the close (${walletDelta.toFixed(9)}), got ${sum.netAfterCostsInclRentSol}`);
  asrt(near(sumTwin.netAfterCostsInclRentSol, walletDelta - RENT + CLOSE_FEE, 1e-9), "without a close the same trade is short by the locked rent (old behaviour, unchanged)");
  asrt(near(sum.ataRentSol, RENT) && near(sum.ataRentReclaimedSol, RENT) && near(sum.ataRentLockedSol, 0) && near(sum.ataCloseFeeSol, CLOSE_FEE) && sum.ataCloses === 1, "summary fields: paid, reclaimed, locked, close fee, count");
  asrt(sumTwin.ataRentReclaimedSol === 0 && sumTwin.ataCloseFeeSol === 0 && near(sumTwin.ataRentLockedSol, RENT) && sumTwin.ataCloses === 0, "summary without a close: nothing reclaimed, all of it locked");
  // The trade itself is not touched by the close.
  asrt(sale.acc.pnlSol === saleTwin.acc.pnlSol && near(sale.acc.pnlSol, SELL_DELTA + SELL_FEE - ENTRY - BUY_FEE - SELL_FEE, 1e-9), `pnlSol is the same with and without the close (${sale.acc.pnlSol})`);
  for (const k of ["spentSol", "receivedSol", "netSol", "costsSol", "netAfterCostsSol", "pnlTrades", "wins", "losses", "sells", "buys"]) {
    asrt(sum[k] === sumTwin[k], `summary.${k} is not changed by the close (${sum[k]} vs ${sumTwin[k]})`);
  }
  const first = out.slice(0, out.indexOf("SESSION SUMMARY — TWIN"));
  const second = out.slice(out.indexOf("SESSION SUMMARY — TWIN"));
  asrt(/ATA rent locked\s+: 0\.000000 SOL\s+\(paid 0\.002074 SOL - reclaimed 0\.002074 SOL\)/.test(first), `summary row "ATA rent locked" = paid - reclaimed: ${(first.match(/ATA rent locked.*/) || [""])[0]}`);
  asrt(/ATA rent reclaimed\s+: 0\.002074 SOL\s+\(1 empty token account\(s\) closed\)/.test(first), "summary row \"ATA rent reclaimed\"");
  asrt(/ATA close fees\s+: 0\.000020 SOL/.test(first), `summary row "ATA close fees": ${(first.match(/ATA close fees.*/) || [""])[0]}`);
  asrt(/NET after costs incl\. rent\s+: \+0\.000495 SOL/.test(first), `summary row "NET after costs incl. rent": ${(first.match(/NET after costs incl.*/) || [""])[0]}`);
  asrt(/ATA rent locked\s+: 0\.002074 SOL\s+\(in token accounts; returned only if they are closed\)/.test(second) && !/ATA rent reclaimed|ATA close fees/.test(second), "without a close the summary rows are exactly the old ones");

  // journal row
  asrt(journal.rows.length === 1, "one ata_close row");
  const row = journal.rows[0];
  asrt(row.type === "ata_close" && row.mint === m && row.closed === true && row.reason === "closed" && row.sig === "SIG1", "ata_close row: mint, closed, reason, sig");
  asrt(near(row.rentReclaimedSol, RENT) && near(row.closeFeeSol, CLOSE_FEE), "ata_close row: rentReclaimedSol, closeFeeSol");
  asrt(row.sessionId === "S1" && row.paramsHash === "P1" && row.gitSha === "G1" && row.mode === "LIVE" && row.venue === "curve", "ata_close row: run metadata, mode, venue");
  asrt(row.tokenProgram === TOKEN_2022_PROGRAM.toBase58() && row.unitsConsumed === 3_150 && row.rentSource === "chain-meta" && row.feeActual === true, "ata_close row: token program, unitsConsumed, sources");
  // Not a trade for any limit: no pnlSol, and the daily-loss reader ignores the row.
  asrt(!("pnlSol" in row) && !("lossAssumed" in row), "ata_close row has no pnlSol / lossAssumed");
  asrt(netSolForDay([{ ...row, ts: new Date().toISOString() }]) === 0, "the daily loss limit does not see ata_close rows");
  asrt(logs.warn.length === 0 && logs.info.some((l) => /ATA closed .*\+0\.002074 SOL rent back, fee 0\.000020 SOL/.test(l)), "a successful close is an info line, not a warning");

  // at most one attempt per mint per session
  const again = await closer.schedule(m, { venue: "curve" });
  asrt(again.closed === false && again.reason === "already-attempted" && c.calls.reads === 1 && c.calls.sent.length === 1 && journal.rows.length === 1, "a second schedule for the same mint does nothing");
  asrt(closer.attempted === 1, "one attempted mint");
}

// 9b. dust on the ATA: no close, and the sale that was booked before stays exactly as it was
{
  const c = makeChain();
  const { mint } = c.addAta({ amount: 7n });
  const session = new SessionLedger({ label: "T", mode: "LIVE" });
  const twin = new SessionLedger({ label: "T", mode: "LIVE" });
  const journal = mkJournal();
  const logs = mkLogs();
  bookRoundTrip(session);
  bookRoundTrip(twin);
  const r = await mkCloser(c, session, journal, logs).schedule(mint.toBase58());
  asrt(r.closed === false && r.reason === "not-empty" && c.calls.sent.length === 0 && c.calls.built.length === 0, "dust -> no close transaction");
  asrt(JSON.stringify(session.state) === JSON.stringify(twin.state) && session.ataCloses === 0 && session.ataRentReclaimedSol === 0 && session.ataCloseFeeSol === 0, "dust: the booked sale and the ledger are unchanged");
  asrt(journal.rows.length === 1 && journal.rows[0].closed === false && journal.rows[0].reason === "not-empty" && journal.rows[0].balanceRaw === "7", "dust: journaled as not-empty with the balance");
  asrt(journal.rows[0].rentReclaimedSol === 0 && journal.rows[0].closeFeeSol === 0 && journal.rows[0].sig === null, "dust: nothing reclaimed, nothing paid");
}

// 9c. the close fails (simulation / send / RPC / journal): WARN + journal row, PnL untouched, no throw
for (const [name, setup, reason] of [
  ["simulation failed", (c) => (c.opts.simFail = true), "sim-fail"],
  ["send failed", (c) => (c.opts.sendThrow = "nosig"), "send-fail"],
  ["RPC read failed", (c) => (c.opts.readThrows = true), "error"],
]) {
  const c = makeChain();
  const { mint } = c.addAta();
  setup(c);
  const session = new SessionLedger({ label: "T", mode: "LIVE" });
  const twin = new SessionLedger({ label: "T", mode: "LIVE" });
  const journal = mkJournal();
  const logs = mkLogs();
  const sale = bookRoundTrip(session);
  const saleTwin = bookRoundTrip(twin);
  const closer = mkCloser(c, session, journal, logs);
  let threw = false;
  let r = null;
  try {
    r = await closer.schedule(mint.toBase58(), { venue: "pumpswap" });
  } catch {
    threw = true;
  }
  asrt(!threw && r && r.closed === false && r.reason === reason, `[${name}] the closer does not throw and reports ${reason} (got ${r && r.reason})`);
  asrt(JSON.stringify(session.state) === JSON.stringify(twin.state) && sale.acc.pnlSol === saleTwin.acc.pnlSol, `[${name}] the sale, its pnlSol and the ledger are unchanged`);
  asrt(session.ataCloses === 0 && session.ataRentReclaimedSol === 0 && session.ataCloseFeeSol === 0 && near(session.ataRentLockedSol, RENT), `[${name}] nothing reclaimed: the rent stays locked`);
  asrt(logs.warn.length === 1 && /WARN ATA close failed/.test(logs.warn[0]) && logs.warn[0].includes(reason), `[${name}] one WARN line: ${logs.warn[0] ?? "(none)"}`);
  asrt(journal.rows.length === 1 && journal.rows[0].type === "ata_close" && journal.rows[0].closed === false && journal.rows[0].reason === reason && typeof journal.rows[0].error === "string", `[${name}] journal row with the reason and the error`);
  asrt(journal.rows[0].venue === "pumpswap", `[${name}] the row says where the sale happened (AMM exits use the same token ATA)`);
  // the bot lives on: another mint is still handled, the failed one is not retried
  const next = c.addAta();
  c.opts.simFail = false;
  c.opts.sendThrow = null;
  c.opts.readThrows = false;
  const sentBefore = c.calls.sent.length;
  const ok = await closer.schedule(next.mint.toBase58());
  asrt(ok.closed === true, `[${name}] the next mint is closed normally afterwards`);
  const retry = await closer.schedule(mint.toBase58());
  asrt(retry.reason === "already-attempted" && c.calls.sent.length === sentBefore + 1, `[${name}] the failed mint is not retried in this session`);
}
{
  // a journal that throws and a ledger that throws must not escape either
  const c = makeChain();
  const { mint } = c.addAta();
  const logs = mkLogs();
  const closer = mkCloser(c, { ataClose() { throw new Error("ledger broke"); } }, { write() { throw new Error("disk full"); } }, logs);
  let threw = false;
  const r = await closer.schedule(mint.toBase58()).catch(() => ((threw = true), null));
  asrt(!threw && r.closed === true && logs.warn.length === 2, "a failing journal / ledger is two WARN lines, never an exception");
  // garbage in: still no throw
  const bad = await closer.schedule("not a public key").catch(() => ((threw = true), null));
  asrt(!threw && bad.closed === false && bad.reason === "error", "an invalid mint is a refusal, not an exception");
}

// 9d. DRY RUN and the kill switch: nothing at all
{
  const c = makeChain();
  const { mint } = c.addAta();
  const session = new SessionLedger({ label: "T", mode: "DRY RUN" });
  const journal = mkJournal();
  const logs = mkLogs();
  const dry = mkCloser(c, session, journal, logs, { live: false });
  const r = await dry.schedule(mint.toBase58());
  asrt(r.reason === "dry-run" && dry.pending === 0 && dry.attempted === 0, "dry run: schedule is a no-op");
  const off = mkCloser(c, session, journal, logs, { enabled: false });
  const r2 = await off.schedule(mint.toBase58());
  asrt(r2.reason === "disabled", "ATA_CLOSE off: schedule is a no-op");
  asrt(c.calls.reads === 0 && c.calls.built.length === 0 && c.calls.simulated === 0 && c.calls.sent.length === 0, "dry run / disabled: not one RPC call, not one transaction");
  asrt(journal.rows.length === 0 && session.ataCloses === 0 && (await dry.drain(10)).pending === 0, "dry run / disabled: no journal row, no ledger entry");
}

// 9e. drain is bounded: a close that never confirms does not hang the stop
{
  const c = makeChain();
  const { mint } = c.addAta();
  c.deps.sendTxWithRetry = () => new Promise(() => {}); // never resolves
  const closer = mkCloser(c, new SessionLedger({ label: "T", mode: "LIVE" }), mkJournal(), mkLogs());
  closer.schedule(mint.toBase58());
  const t0 = Date.now();
  const left = await closer.drain(60);
  asrt(left.pending === 1 && Date.now() - t0 < 2_000, "drain returns after its timeout and reports what is still pending");
}

// 9f. an ATA created before the session: reclaimed > paid, and the summary still reconciles
{
  const s = new SessionLedger({ label: "T", mode: "LIVE" });
  s.buy(ENTRY); // no rent paid by this buy (the account already existed)
  s.sell(SELL_DELTA + SELL_FEE, SELL_DELTA + SELL_FEE - ENTRY, { costSol: BUY_FEE + SELL_FEE });
  s.ataClose({ rentReclaimedSol: RENT, feeSol: CLOSE_FEE });
  s.ataClose({ rentReclaimedSol: NaN, feeSol: -1 }); // invalid numbers are ignored (the close is counted)
  let sum;
  await captureStdout(async () => (sum = s.report({ reason: "test" })));
  const walletDelta = -(ENTRY + BUY_FEE) + SELL_DELTA + (RENT - CLOSE_FEE);
  asrt(near(sum.ataRentLockedSol, -RENT) && near(sum.netAfterCostsInclRentSol, walletDelta, 1e-9), `pre-existing ATA closed: the reclaimed rent shows up in the result (${walletDelta.toFixed(9)}), got ${sum.netAfterCostsInclRentSol}`);
  asrt(near(sum.ataRentReclaimedSol, RENT) && near(sum.ataCloseFeeSol, CLOSE_FEE) && sum.ataCloses === 2, "invalid amounts are ignored");
}

// ---- 10. accounting scheme: pnlSol did not change, so the stamp did not either ------------------
asrt(COSTS_SCHEME.startsWith("v2.3"), `COSTS_SCHEME is untouched (v2.3), got ${COSTS_SCHEME}`);

// ---- 11. wiring in the three bots ---------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
const count = (s, re) => (s.match(re) || []).length;
for (const rel of ["bots/sniper/sniper.mjs", "bots/graduation-sniper/graduation.mjs", "bots/copy-trader/watcher.mjs"]) {
  const src = read(rel);
  asrt(/import \{ createAtaCloser \} from "\.\.\/\.\.\/lib\/close-ata\.mjs";/.test(src), `${rel}: imports createAtaCloser`);
  const ctor = src.slice(src.indexOf("createAtaCloser({"), src.indexOf("createAtaCloser({") + 400);
  asrt(/live: LIVE/.test(ctor) && /session/.test(ctor) && /journal/.test(ctor) && /warn: \(m\) => logger\.warn\(m\)/.test(ctor), `${rel}: the closer is LIVE-gated and wired to the ledger, the journal and WARN`);
  asrt(count(src, /ataCloser\.schedule\(/g) === 2, `${rel}: exactly two close calls (normal + reconciled sale), got ${count(src, /ataCloser\.schedule\(/g)}`);
  // Every close call comes after a live sale was booked — never from a STUCK / drop path.
  let from = 0;
  for (;;) {
    const i = src.indexOf("ataCloser.schedule(", from);
    if (i < 0) break;
    from = i + 1;
    const sale = src.lastIndexOf("applyLiveSell(pos,", i);
    const booked = src.indexOf("session.sell(", sale);
    asrt(sale > 0 && booked > sale && booked < i, `${rel}: the close is scheduled after applyLiveSell + session.sell`);
    asrt(src.lastIndexOf("recordStuck(", i) < sale && src.lastIndexOf("markStuck(", i) < sale, `${rel}: no STUCK path between the sale and the close`);
    asrt(src.lastIndexOf("positions.delete(mint)", i) > sale, `${rel}: the position is already removed when the close is scheduled`);
    asrt(!/await\s*$/.test(src.slice(i - 8, i)), `${rel}: the close is not awaited (it must not delay the sell loop)`);
  }
  // The stop path waits for the closes before it reads the wallet for the summary.
  const drain = src.indexOf("await ataCloser.drain()");
  const end = src.indexOf("const endSol = LIVE ? await getSOLBalance", drain);
  asrt(drain > 0 && end > drain && end - drain < 400, `${rel}: finish() drains the closes right before reading the wallet`);
}
{
  // Partial sales never close: the call sits in the branch that deleted the position.
  const grad = read("bots/graduation-sniper/graduation.mjs");
  asrt(count(grad, /\} else \{\s+positions\.delete\(mint\);\s+(?:\/\/[^\n]*\n\s+)?ataCloser\.schedule\(mint, \{ venue \}\);\s+\}/g) === 2, "graduation: the close is in the else-branch of `if (!sale.closed)` (both paths), with the venue (curve or pumpswap)");
  const copy = read("bots/copy-trader/watcher.mjs");
  asrt(count(copy, /if \(sale\.closed\) ataCloser\.schedule\(mint, \{ venue: "curve" \}\);/g) === 2, "copy-trader: closes only when sale.closed (SELL_PCT < 100 keeps the ATA)");
  const sniper = read("bots/sniper/sniper.mjs");
  asrt(count(sniper, /positions\.delete\(mint\);\s+(?:\/\/[^\n]*\n\s+|log\([^\n]*\n\s+)?ataCloser\.schedule\(mint, \{ venue: "curve" \}\);/g) === 2, "sniper: closes after the position is removed (it always sells the whole balance)");
  // The AMM sell itself and the instruction builders are not touched by this task.
  const amm = read("lib/amm-sell.mjs");
  asrt(!/close-ata|ataCloser/.test(amm) && count(amm, /createCloseAccountInstruction\(userWsol, wallet\.publicKey, wallet\.publicKey, \[\], TOKEN_PROGRAM\)/g) === 1, "lib/amm-sell.mjs: the WSOL close is as it was");
  const lib = read("lib/close-ata.mjs");
  asrt(!/createBurn|burnChecked|BurnInstruction/i.test(lib), "lib/close-ata.mjs never builds a burn");
}

console.log(JSON.stringify({ rent: RENT, closeFee: CLOSE_FEE, cuLimit: CLOSE_ATA_CU_LIMIT, feeShareOfRent: +(CLOSE_FEE / RENT).toFixed(4) }));
console.log("PASS: empty token ATA is closed after a full sale (separate tx, best effort); rent and close fee reconcile with the wallet; pnlSol unchanged");
