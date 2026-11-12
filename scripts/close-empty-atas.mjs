#!/usr/bin/env node
// close-empty-atas: get the rent back from the wallet's OLD, EMPTY token accounts.
//
//   node scripts/close-empty-atas.mjs                 # PLAN ONLY: list them, send nothing
//   $env:LIVE_CONFIRM="yes"; node scripts/close-empty-atas.mjs --live
//
// Every buy of a new mint created a token account and locked ~0.00207 SOL of rent in it. The bots
// close it after a full sale now (lib/close-ata.mjs); this script is for the accounts left behind
// by earlier sessions, or by a close that failed.
//
// What it will and will not do:
//   * only accounts whose token balance is exactly 0 are ever closed. An account with ANY balance
//     is listed as kept and never touched — nothing is burned, nothing is sold;
//   * the WSOL account is skipped (the PumpSwap sell path opens and closes it itself);
//   * --live needs LIVE_CONFIRM=yes, otherwise the script exits before it builds an RPC client;
//   * several closeAccount instructions per transaction; every batch is simulated first and a
//     failed simulation is never sent.
//
// The listing, the batching and the sends live in lib/close-ata.mjs (tested with fakes); this file
// only parses the flags, enforces the gate and wires the real client.
const args = process.argv.slice(2);
const LIVE = args.includes("--live") && !args.includes("--dry-run");

// Gate BEFORE any import that builds the RPC client: --live alone must never be enough.
if (LIVE && process.env.LIVE_CONFIRM !== "yes") {
  console.error(
    '[close-empty-atas] --live requires LIVE_CONFIRM=yes for this run, e.g. $env:LIVE_CONFIRM="yes"; node scripts/close-empty-atas.mjs --live',
  );
  process.exit(1);
}

const { numOr } = await import("../lib/config.mjs"); // also enforces LIVE_CONFIRM (both agree)
const { connection } = await import("../lib/rpc.mjs");
const { WSOL, TOKEN_2022_PROGRAM } = await import("../lib/constants.mjs");
const { TradeJournal } = await import("../lib/journal.mjs");
const { loadKeypair } = await import("../lib/wallet.mjs");
const { closeEmptyAccounts, closeFeeLamports, listTokenAccounts, CLOSE_ATA_CU_LIMIT } = await import("../lib/close-ata.mjs");

const BATCH = Math.max(1, Math.min(12, Math.floor(numOr(process.env.CLOSE_ATA_BATCH, 8, "CLOSE_ATA_BATCH"))));
const wallet = loadKeypair();
const tag = "[close-empty-atas]";
const sol = (lamports) => (lamports / 1e9).toFixed(6);

console.log(`${tag} ${LIVE ? "LIVE" : "PLAN ONLY"} | wallet ${wallet.publicKey.toBase58().slice(0, 8)}… | batch ${BATCH}`);

const { empty, kept } = await listTokenAccounts({ connection, owner: wallet.publicKey, skipMints: [WSOL] });
const progName = (p) => (p.equals(TOKEN_2022_PROGRAM) ? "Token-2022" : "Token");

if (kept.length) {
  console.log(`${tag} kept (never closed): ${kept.length}`);
  for (const a of kept) {
    console.log(`  keep  ${a.address.toBase58()}  ${progName(a.program).padEnd(10)}  ${a.why}${a.amount != null ? `  balance ${a.amount}` : ""}`);
  }
}
if (!empty.length) {
  console.log(`${tag} no empty token accounts — nothing to close`);
  process.exit(0);
}

const rentLamports = empty.reduce((s, a) => s + a.lamports, 0);
const batches = Math.ceil(empty.length / BATCH);
let feeLamports = 0;
for (let i = 0; i < empty.length; i += BATCH) {
  feeLamports += closeFeeLamports({ cuLimit: CLOSE_ATA_CU_LIMIT * Math.min(BATCH, empty.length - i) });
}
console.log(`${tag} empty token accounts: ${empty.length}`);
for (const a of empty) {
  console.log(`  close ${a.address.toBase58()}  ${progName(a.program).padEnd(10)}  mint ${a.mint.toBase58()}  rent ${sol(a.lamports)} SOL`);
}
console.log(`${tag} rent to reclaim: ${sol(rentLamports)} SOL in ${batches} transaction(s), estimated fees ${sol(feeLamports)} SOL`);

if (!LIVE) {
  console.log(`${tag} PLAN ONLY — nothing was built, simulated or sent.`);
  console.log(`${tag} to close them: $env:LIVE_CONFIRM="yes"; node scripts/close-empty-atas.mjs --live`);
  process.exit(0);
}

const journal = new TradeJournal({ bot: "close-empty-atas" });
const res = await closeEmptyAccounts({ connection, wallet, accounts: empty, live: true, batchSize: BATCH, log: console.log });
for (const b of res.batches) {
  journal.write({ type: "ata_sweep", mode: "LIVE", accounts: b.accounts, sent: b.sent, sig: b.sig, error: b.error, unitsConsumed: b.unitsConsumed });
}
console.log(`${tag} closed ${res.closed} of ${res.planned} account(s): +${res.rentReclaimedSol.toFixed(6)} SOL rent, estimated fees ${res.feeSol.toFixed(6)} SOL`);
