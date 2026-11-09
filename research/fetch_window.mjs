// Качает ВСЕ успешные транзакции токена в окне [createSig .. beforeSig] (от запуска до выхода создателя).
// Вход: файл с JSON [{mint, createSig, beforeSig}], выход: data/raw/<mint>/*.json + <mint>.window.json
// Использование: node research/fetch_window.mjs data/windows.json [maxTxPerToken]
import fs from "node:fs";
import path from "node:path";
import { BUDGET, BudgetExceeded, ROOT, getTx, ledger, pool, rpc, saveLedger } from "./rpc.mjs";

const windows = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const maxTx = Number(process.argv[3] || 300);

async function main() {
  console.log(`кредиты: ${ledger.used}/${BUDGET}`);
  for (const w of windows) {
    const dir = path.join(ROOT, "data", "raw", w.mint);
    fs.mkdirSync(dir, { recursive: true });
    const sigs = [];
    let before = w.beforeSig;
    for (;;) {
      const batch = await rpc("getSignaturesForAddress", [w.mint, { limit: 1000, before, until: w.createSig }]);
      sigs.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    fs.writeFileSync(path.join(ROOT, "data", "raw", `${w.mint}.window.json`), JSON.stringify(sigs));
    // create и before сами не входят в окно (until/before эксклюзивны) — добавляем явно
    const todo = [w.createSig, w.beforeSig, ...sigs.filter((s) => !s.err).map((s) => s.signature).reverse()] // от старых к новым
      .slice(0, maxTx)
      .filter((s) => !fs.existsSync(path.join(dir, `${s}.json`)));
    console.log(`${w.mint.slice(0, 8)}: в окне ${sigs.length} подписей (упавших ${sigs.filter((s) => s.err).length}), качаю ${todo.length}`);
    await pool(todo, 8, async (s) => fs.writeFileSync(path.join(dir, `${s}.json`), JSON.stringify(await getTx(s))));
    saveLedger();
  }
}

main()
  .then(() => console.log(`done; кредиты ${ledger.used}/${BUDGET}`))
  .catch((e) => { saveLedger(); console.error(e instanceof BudgetExceeded ? `STOP: ${e.message}` : e); process.exit(1); });
