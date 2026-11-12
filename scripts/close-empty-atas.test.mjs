import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
// Task 7 / P4: scripts/close-empty-atas.mjs returns the rent of OLD empty token accounts.
//   - plan only by default: nothing is built, simulated or sent;
//   - --live without LIVE_CONFIRM=yes is refused before an RPC client exists;
//   - an account with ANY token balance is never closed; WSOL is skipped;
//   - batches of several closeAccount per transaction, each simulated before it is sent.
// No network: an RPC mock for the spawned script, fakes for the library functions.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b) => Math.abs(a - b) < 1e-12;

// ---- the script: gate and plan-only run ---------------------------------------------------------
const run = (argv, extraEnv = {}) =>
  new Promise((resolve) => {
    const env = cleanEnv({
      RPC_URL: "http://127.0.0.1:1",
      RPC_MOCK: path.join(here, "mocks", "close-atas-rpc-mock.mjs"),
      KEYS_DIR: makeTempKeys(),
      ...extraEnv,
    });
    const child = spawn(process.execPath, [path.join(root, "scripts", "close-empty-atas.mjs"), ...argv], { cwd: root, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    const killer = setTimeout(() => child.kill(), 20000);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve({ c, out, err });
    });
  });

{
  const { c, out, err } = await run([]);
  asrt(c === 0, `plan-only run exits 0 (got ${c}); stderr: ${err.split(/\r?\n/).find((l) => /Error/.test(l)) || ""}`);
  asrt(/PLAN ONLY/.test(out) && /nothing was built, simulated or sent/.test(out), "the default run is a plan");
  asrt(/empty token accounts: 2/.test(out), `two empty accounts are offered: ${(out.match(/empty token accounts.*/) || [""])[0]}`);
  asrt(/Token-2022\s+mint/.test(out) && /close \S+\s+Token\s+mint/.test(out), "both token programs are listed");
  asrt(/rent to reclaim: 0\.004113 SOL in 1 transaction\(s\)/.test(out), `the rent total is shown (0.00207408 + 0.00203928): ${(out.match(/rent to reclaim.*/) || [""])[0]}`);
  asrt(/kept \(never closed\): 2/.test(out) && /not-empty\s+balance 5000000/.test(out) && /skipped-mint/.test(out), "the account with tokens and the WSOL account are kept");
  asrt(!/MOCK_CALL/.test(out), `plan only: no blockhash, no simulation, no send (${(out.match(/MOCK_CALL.*/) || [""])[0]})`);
}
{
  const { c, out } = await run(["--live", "--dry-run"]);
  asrt(c === 0 && /PLAN ONLY/.test(out) && !/MOCK_CALL/.test(out), "--dry-run wins over --live: plan only");
}
{
  const { c, out, err } = await run(["--live"]);
  asrt(c === 1, `--live without LIVE_CONFIRM exits 1 (got ${c})`);
  // The script's OWN gate (before any import that builds an RPC client), not only lib/config.mjs.
  asrt(/\[close-empty-atas\] --live requires LIVE_CONFIRM=yes/.test(err), `the script's own gate refuses: ${err.split(/\r?\n/)[0]}`);
  asrt(!/MOCK_CALL/.test(out + err) && !/empty token accounts/.test(out) && !/PLAN ONLY|LIVE \|/.test(out), "refused before anything is read or built");
}
{
  const { c, out, err } = await run(["--live"], { LIVE_CONFIRM: "no" });
  asrt(c === 1 && /LIVE_CONFIRM/.test(out + err) && !/MOCK_CALL/.test(out + err), "LIVE_CONFIRM=no is not a confirmation");
}

// ---- the library: listing and batched closes (fakes) --------------------------------------------
const { listTokenAccounts, closeEmptyAccounts, closeFeeLamports, CLOSE_ATA_CU_LIMIT } = await import("../lib/close-ata.mjs");
const { TOKEN_2022_PROGRAM, WSOL } = await import("../lib/constants.mjs");
const { TOKEN_PROGRAM } = await import("../lib/pumpswap-sell.mjs");

const wallet = Keypair.generate();
const data = (mint, owner, amount) => {
  const buf = Buffer.alloc(165);
  mint.toBuffer().copy(buf, 0);
  owner.toBuffer().copy(buf, 32);
  buf.writeBigUInt64LE(BigInt(amount), 64);
  return buf;
};
const acct = (amount, program, { mint = Keypair.generate().publicKey, owner = wallet.publicKey, heldBy = program, lamports = 2_074_080 } = {}) => ({
  pubkey: Keypair.generate().publicKey,
  account: { owner: heldBy, lamports, data: data(mint, owner, amount) },
});
const full = acct(123n, TOKEN_2022_PROGRAM);
const foreign = acct(0n, TOKEN_2022_PROGRAM, { owner: Keypair.generate().publicKey });
const wsol = acct(0n, TOKEN_PROGRAM, { mint: WSOL, lamports: 2_039_280 });
const empties2022 = Array.from({ length: 5 }, () => acct(0n, TOKEN_2022_PROGRAM));
const emptyLegacy = acct(0n, TOKEN_PROGRAM, { lamports: 2_039_280 });
const connection = {
  async getTokenAccountsByOwner(owner, { programId }) {
    asrt(owner.equals(wallet.publicKey), "accounts are listed for the bot's wallet");
    if (programId.equals(TOKEN_2022_PROGRAM)) return { value: [...empties2022, full, foreign] };
    if (programId.equals(TOKEN_PROGRAM)) return { value: [emptyLegacy, wsol] };
    return { value: [] };
  },
};

const listed = await listTokenAccounts({ connection, owner: wallet.publicKey, skipMints: [WSOL] });
asrt(listed.empty.length === 6, `6 empty accounts are closable (5 Token-2022 + 1 legacy), got ${listed.empty.length}`);
asrt(listed.empty.every((a) => a.amount === 0n), "only zero-balance accounts are offered");
asrt(!listed.empty.some((a) => a.address.equals(full.pubkey)), "an account with tokens is never offered");
asrt(listed.kept.find((a) => a.address.equals(full.pubkey))?.why === "not-empty", "…it is listed as kept: not-empty");
asrt(listed.kept.find((a) => a.address.equals(foreign.pubkey))?.why === "not-owner", "an account with another authority is kept");
asrt(listed.kept.find((a) => a.address.equals(wsol.pubkey))?.why === "skipped-mint", "the WSOL account is kept (it belongs to the AMM sell path)");
asrt(listed.empty.filter((a) => a.program.equals(TOKEN_PROGRAM)).length === 1 && listed.empty.filter((a) => a.program.equals(TOKEN_2022_PROGRAM)).length === 5, "each account keeps its own token program");

const mkDeps = ({ failSimOn = -1 } = {}) => {
  const calls = { built: [], simulated: 0, sent: [] };
  return {
    calls,
    deps: {
      buildVersionedTx: async (payer, ixs) => {
        calls.built.push(ixs);
        return { ixs };
      },
      simulateTx: async () => {
        calls.simulated += 1;
        return calls.simulated - 1 === failSimOn ? { ok: false, err: { InstructionError: [3, { Custom: 11 }] }, logs: [], units: null } : { ok: true, err: null, logs: [], units: 9_000 };
      },
      sendTxWithRetry: async (tx) => {
        calls.sent.push(tx);
        return `SIG${calls.sent.length}`;
      },
    },
  };
};
const closes = (ixs) => ixs.filter((ix) => ix.data.length === 1 && ix.data[0] === 9);
const cuOf = (ixs) => ixs.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2).data.readUInt32LE(1);

// plan only: nothing built
{
  const { calls, deps } = mkDeps();
  const res = await closeEmptyAccounts({ connection, wallet, accounts: listed.empty, live: false, batchSize: 4, deps });
  asrt(res.planned === 6 && res.closed === 0 && res.batches.length === 0, "live:false is a plan");
  asrt(calls.built.length === 0 && calls.simulated === 0 && calls.sent.length === 0, "plan: nothing built, simulated or sent");
}
// live (fakes): batches of 4 -> 4 + 2
{
  const { calls, deps } = mkDeps();
  const res = await closeEmptyAccounts({ connection, wallet, accounts: listed.empty, live: true, batchSize: 4, deps });
  asrt(calls.built.length === 2 && calls.simulated === 2 && calls.sent.length === 2, "6 accounts in batches of 4: two transactions, each simulated before the send");
  asrt(closes(calls.built[0]).length === 4 && closes(calls.built[1]).length === 2, "4 + 2 closeAccount instructions");
  asrt(calls.built.every((ixs) => ixs.length === 2 + closes(ixs).length), "only compute budget + closeAccount (no burn, no transfer)");
  asrt(cuOf(calls.built[0]) === 4 * CLOSE_ATA_CU_LIMIT && cuOf(calls.built[1]) === 2 * CLOSE_ATA_CU_LIMIT, "CU limit scales with the batch");
  const all = calls.built.flatMap(closes);
  for (const ix of all) {
    const a = listed.empty.find((x) => x.address.equals(ix.keys[0].pubkey));
    asrt(a && ix.programId.equals(a.program), "each closeAccount uses the token program of its own account");
    asrt(ix.keys[1].pubkey.equals(wallet.publicKey) && ix.keys[2].pubkey.equals(wallet.publicKey), "destination and authority = the wallet");
  }
  asrt(all.some((ix) => ix.programId.equals(TOKEN_PROGRAM)) && all.some((ix) => ix.programId.equals(TOKEN_2022_PROGRAM)), "both token programs appear");
  asrt(!all.some((ix) => ix.keys[0].pubkey.equals(full.pubkey) || ix.keys[0].pubkey.equals(wsol.pubkey) || ix.keys[0].pubkey.equals(foreign.pubkey)), "kept accounts are in no transaction");
  const rent = (5 * 2_074_080 + 2_039_280) / 1e9;
  const fee = (closeFeeLamports({ cuLimit: 4 * CLOSE_ATA_CU_LIMIT }) + closeFeeLamports({ cuLimit: 2 * CLOSE_ATA_CU_LIMIT })) / 1e9;
  asrt(res.closed === 6 && near(res.rentReclaimedSol, rent) && near(res.feeSol, fee), `closed 6, rent ${rent}, fees ${fee} (got ${res.closed}, ${res.rentReclaimedSol}, ${res.feeSol})`);
}
// a batch whose simulation fails is not sent; the next one still goes
{
  const { calls, deps } = mkDeps({ failSimOn: 0 });
  const res = await closeEmptyAccounts({ connection, wallet, accounts: listed.empty, live: true, batchSize: 4, deps });
  asrt(calls.simulated === 2 && calls.sent.length === 1, "failed simulation: that batch is not sent, the run continues");
  asrt(res.closed === 2 && res.batches[0].sent === false && /^simulation: /.test(res.batches[0].error) && res.batches[1].sent === true, "the result says which batch failed and why");
}
// a non-empty account handed in by mistake is dropped, never closed
{
  const { calls, deps } = mkDeps();
  const dirty = [...listed.empty.slice(0, 2), { address: full.pubkey, program: TOKEN_2022_PROGRAM, lamports: 2_074_080, mint: new PublicKey(full.account.data.subarray(0, 32)), amount: 123n }];
  const res = await closeEmptyAccounts({ connection, wallet, accounts: dirty, live: true, batchSize: 8, deps });
  asrt(res.planned === 2 && res.refused === 1 && closes(calls.built[0]).length === 2, "an account with a balance is refused even if it is passed in");
  asrt(!closes(calls.built[0]).some((ix) => ix.keys[0].pubkey.equals(full.pubkey)), "…and is in no instruction");
}

console.log("PASS: close-empty-atas — plan by default, --live needs LIVE_CONFIRM, only zero-balance accounts, batches simulated before the send");
