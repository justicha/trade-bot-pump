import "./lib/test-env.mjs";
// P3 (audit bug 4): the rent of a token ATA created by a buy is NOT the price of the tokens.
// readExecution must MEASURE it from the transaction meta (no constant) and keep it out of
// solSpentSol; the session ledger tracks it apart from spent and costs.
//
// Fails without the fix: readExecution has no ataRentPaidSol and solSpentSol contains the rent
// (0.09707408 instead of 0.095); SessionLedger has no ataRent().
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b) => Math.abs(a - b) < 1e-12;

process.env.RPC_MOCK = path.join(here, "mocks", "live-accounting-mock.mjs");

const { readExecution } = await import("../lib/exec.mjs");
const { liveEntry } = await import("../lib/live-pnl.mjs");
const { SessionLedger } = await import("../lib/session.mjs");
const mock = await import("./mocks/live-accounting-mock.mjs");
const owner = new PublicKey(mock.OWNER);
const mint = new PublicKey(mock.MINT);
const opts = { retries: 1, delayMs: 0 };
const SPENT = mock.SPENT / 1e9;
const RENT = mock.RENT / 1e9;

// --- a buy that CREATES the ATA: rent measured, entry without it --------------------------------
const created = await readExecution("BUY_NEW_ATA", owner, mint, opts);
asrt(created.found === true, "buy tx found");
asrt(created.tokensReceived === mock.TOKENS, `tokensReceived, got ${created.tokensReceived}`);
asrt(near(created.ataRentPaidSol, RENT), `ataRentPaidSol = ${RENT} (measured from the ATA balance 0 -> rent), got ${created.ataRentPaidSol}`);
asrt(created.ataRentPaidSol > 0, "ataRentPaidSol > 0 when the ATA is created in this tx");
asrt(created.ataRentKnown === true, "ataRentKnown: the ATA is among the tx accounts");
asrt(near(created.solSpentSol, SPENT), `solSpentSol excludes fee AND rent (expected ${SPENT}), got ${created.solSpentSol}`);
asrt(near(created.feeSol, mock.FEE / 1e9), `feeSol is the real network fee, got ${created.feeSol}`);
// Nothing is lost: delta = -(entry + fee + rent).
asrt(near(-created.solDeltaSol, created.solSpentSol + created.feeSol + created.ataRentPaidSol), "wallet delta = entry + fee + rent");

// --- a buy into an EXISTING ATA: no rent -------------------------------------------------------
const existing = await readExecution("BUY_EXISTING_ATA", owner, mint, opts);
asrt(existing.ataRentPaidSol === 0, `no ATA created -> ataRentPaidSol 0, got ${existing.ataRentPaidSol}`);
asrt(existing.ataRentKnown === true, "existing ATA: still known (found, nothing paid)");
asrt(near(existing.solSpentSol, SPENT), `solSpentSol unchanged for a re-buy, got ${existing.solSpentSol}`);

// --- ATA loaded through an address lookup table: balances follow static + loaded keys -----------
const alt = await readExecution("BUY_ALT_ATA", owner, mint, opts);
asrt(near(alt.ataRentPaidSol, RENT) && alt.ataRentKnown === true, `ALT-loaded ATA is found, got rent ${alt.ataRentPaidSol} known ${alt.ataRentKnown}`);
asrt(near(alt.solSpentSol, SPENT), `ALT: entry without rent, got ${alt.solSpentSol}`);

// --- ATA not among the tx accounts: rent 0 and FLAGGED, never guessed --------------------------
const absent = await readExecution("BUY_ATA_ABSENT", owner, mint, opts);
asrt(absent.ataRentPaidSol === 0 && absent.ataRentKnown === false, `ATA not found -> rent 0 + ataRentKnown:false, got ${absent.ataRentPaidSol}/${absent.ataRentKnown}`);

// --- a sell never reports ATA rent (the bot does not close the ATA) ----------------------------
const sell = await readExecution("SELL", owner, mint, opts);
asrt(sell.ataRentPaidSol === 0, "a sell pays no ATA rent");
asrt(near(sell.solReceivedSol, mock.RECV / 1e9), `sell proceeds unchanged, got ${sell.solReceivedSol}`);

// --- liveEntry: what the bots store in the position ---------------------------------------------
const e = liveEntry(created, 0.1);
asrt(near(e.entrySolSol, SPENT) && e.entrySource === "chain-meta", "entry = actual spend, source chain-meta");
asrt(near(e.ataRentSol, RENT) && e.ataRentKnown === true, "position carries the rent");
asrt(near(e.buyFeeSol, mock.FEE / 1e9), "position carries the actual buy fee");
const fb = liveEntry({ found: false }, 0.1);
asrt(fb.entrySolSol === 0.1 && fb.entrySource === "quote-fallback" && fb.ataRentSol === 0 && fb.ataRentKnown === false && fb.buyFeeSol === null, "meta missing -> nominal size, flagged quote-fallback");

// --- session ledger: rent is neither spent nor a cost ------------------------------------------
{
  const s = new SessionLedger({ label: "T", mode: "LIVE", startSol: 2 });
  s.buy(e.entrySolSol).ataRent(e.ataRentSol);
  asrt(near(s.spentSol, SPENT), `spent does not include the rent, got ${s.spentSol}`);
  asrt(s.costsSol === 0, "rent is not a cost");
  asrt(near(s.ataRentSol, RENT), `ledger.ataRentSol, got ${s.ataRentSol}`);
  s.ataRent(0).ataRent(NaN).ataRent(-1);
  asrt(near(s.ataRentSol, RENT), "zero / invalid rent is ignored");
  s.sell(0.1, 0.005, { costSol: 0.001 });
  const sum = s.report({ reason: "test" });
  asrt(near(sum.ataRentSol, RENT), "summary carries ataRentSol");
  asrt(near(sum.netAfterCostsSol, 0.004), `existing netAfterCostsSol keeps its meaning (no rent), got ${sum.netAfterCostsSol}`);
  asrt(near(sum.netAfterCostsInclRentSol, 0.004 - RENT), `netAfterCostsInclRentSol = net - costs - rent, got ${sum.netAfterCostsInclRentSol}`);
}

// --- wiring: all three bots store the rent in the position and in the ledger -------------------
for (const rel of ["bots/sniper/sniper.mjs", "bots/graduation-sniper/graduation.mjs", "bots/copy-trader/watcher.mjs"]) {
  const src = fs.readFileSync(path.join(here, "..", rel), "utf8");
  asrt(/liveEntry\(ex, BUY_SOL\)/.test(src), `${rel}: entry comes from liveEntry(ex, BUY_SOL)`);
  asrt(/session\.ataRent\(/.test(src), `${rel}: the rent reaches the session ledger`);
  asrt(/ataRentSol/.test(src), `${rel}: the position / journal carries ataRentSol`);
  asrt(!/ex\.solSpentSol > 0 \? ex\.solSpentSol : BUY_SOL/.test(src), `${rel}: no hand-rolled entry fallback left`);
}
// The rent must be measured, not assumed: no token-ATA rent constant in lib/exec.mjs.
asrt(!/2_?074_?080/.test(fs.readFileSync(path.join(here, "..", "lib", "exec.mjs"), "utf8")), "lib/exec.mjs has no hardcoded Token-2022 ATA rent");

console.log(JSON.stringify({ solSpentSol: created.solSpentSol, ataRentPaidSol: created.ataRentPaidSol, alt: alt.ataRentKnown, absentKnown: absent.ataRentKnown }));
console.log("PASS: ATA rent is measured from tx meta, kept out of the entry and tracked apart in the ledger");
