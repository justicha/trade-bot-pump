// Downloads address transactions into data/raw/<address>/<sig>.json
// Usage: node research/fetch.mjs [scanSigs] [maxOkTx] [address...]
// Scans scanSigs signatures, downloads up to maxOkTx successful transactions + 15 failed (for error analysis).
// OLDEST=1 — take the earliest successful txs from the scanned window.
// Credit budget — see research/rpc.mjs (CREDIT_BUDGET in .env, ledger in data/credits.json).
import fs from "node:fs";
import path from "node:path";
import { BUDGET, BudgetExceeded, IS_PUBLIC, ROOT, getTx, ledger, pool, rpc, saveLedger, sleep } from "./rpc.mjs";

const OUT = path.join(ROOT, "data", "raw");
const DEFAULT_WALLETS = [
  "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt",
  "DjM7Tu7whh6P3pGVBfDzwXAx2zaw51GJWrJE3PwtuN7s",
  "ardinRsN1mNYVeoJWTBsWeYeXvuR9UUDGMsCDKpb6AT",
  "8ZN71XTdVo8yRovnGLmNgW3Tgniw6A4J3JGLvPD686FP",
  "Aqje5DsN4u2PHmQxGF9PKfpsDGwQRCBhWeLKHCFhSMXk",
];

const limit = Number(process.argv[2] || 5000);
const maxOk = Number(process.argv[3] || 400);
const wallets = process.argv.slice(4).length ? process.argv.slice(4) : DEFAULT_WALLETS;

async function main() {
  console.log(`RPC: ${IS_PUBLIC ? "public" : "helius"}; credits: ${ledger.used}/${BUDGET}`);
  for (const w of wallets) {
    const dir = path.join(OUT, w);
    fs.mkdirSync(dir, { recursive: true });
    const sigFile = path.join(OUT, `${w}.signatures.json`);
    let sigs = fs.existsSync(sigFile) ? JSON.parse(fs.readFileSync(sigFile, "utf8")) : [];
    if (sigs.length < limit) {
      sigs = [];
      let before;
      while (sigs.length < limit) {
        const batch = await rpc("getSignaturesForAddress", [w, { limit: Math.min(1000, limit - sigs.length), before }]);
        if (!batch.length) break;
        sigs.push(...batch);
        before = batch[batch.length - 1].signature;
      }
      fs.writeFileSync(sigFile, JSON.stringify(sigs, null, 1));
    }
    const okAll = sigs.filter((s) => !s.err);
    const ok = process.env.OLDEST ? okAll.slice(-maxOk) : okAll.slice(0, maxOk);
    const failed = sigs.filter((s) => s.err).slice(0, 15);
    const todo = [...ok, ...failed].filter((s) => !fs.existsSync(path.join(dir, `${s.signature}.json`)));
    console.log(`${w}: sigs=${sigs.length} ok=${okAll.length} failed=${sigs.length - okAll.length}; to download ${todo.length}`);

    let done = 0;
    await pool(todo, 8, async (s) => {
      fs.writeFileSync(path.join(dir, `${s.signature}.json`), JSON.stringify(await getTx(s.signature)));
      if (++done % 100 === 0) { console.log(`  ${w.slice(0, 6)} ${done}; credits ${ledger.used}/${BUDGET}`); saveLedger(); }
      if (IS_PUBLIC) await sleep(110);
    });
    saveLedger();
  }
}

main()
  .then(() => console.log(`done; credits ${ledger.used}/${BUDGET}`))
  .catch((e) => { saveLedger(); console.error(e instanceof BudgetExceeded ? `STOP: ${e.message}` : e); process.exit(1); });
