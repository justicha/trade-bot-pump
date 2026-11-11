import "./lib/test-env.mjs";
// P1 + P2 (audit bugs 1 and 6): a STUCK position must be visible to the limits.
//   P1 graduation markStuck: the REMAINING entry is booked as an assumed loss — TradeGuard sees a
//      losing trade and the daily loss limit sums the journal row (`pnlSol`, `lossAssumed: true`).
//   P2 sniper / copy-trader: a completed curve is no longer a silent session.drop — it is the same
//      journaled STUCK with the same assumed loss.
//
// Fails without the fix: lib/stuck.mjs does not exist; netSolForDay ignores `stuck` rows (0 instead
// of -entry); the bots still drop the position without recordResult.
//
// The live branches themselves cannot be executed here: lib/rpc.mjs refuses RPC_MOCK together with
// --live. So the accounting lives in lib/stuck.mjs (tested directly, real TradeGuard + real
// journal file) and the bots are checked for calling it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const { TradeGuard } = await import("../lib/guards.mjs");
const { TradeJournal, readJournal } = await import("../lib/journal.mjs");
const { netSolForDay, dailyLossBlocked } = await import("../lib/daily-loss.mjs");
const { recordStuck, stuckLossSol } = await import("../lib/stuck.mjs");
const { mskDateKey } = await import("../lib/time.mjs");

const TODAY = mskDateKey();
const BUY_SOL = 0.05;
const newJournal = () => new TradeJournal({ bot: "stuck-test", dir: fs.mkdtempSync(path.join(os.tmpdir(), "stuck-journal-")) });

// --- P1: one stuck position -> one losing trade for the guard, -entry for the day --------------
{
  const guard = new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses: 3 });
  const journal = newJournal();
  const before = guard.consecLosses;
  const pos = { entrySolSol: 0.02, tokens: 123_456n, ataRentSol: 0.00207408 };
  const booked = recordStuck({
    journal,
    recordResult: (p) => guard.recordResult(p),
    mint: "MintStuck1111111111111111111111111111111111",
    pos,
    buySol: BUY_SOL,
    reason: "simulation: Custom 6062",
    fields: { sessionId: "s1", venue: "pumpswap", attempts: 3, maxAttempts: 3 },
  });
  asrt(booked === -0.02, `the remaining entry is the assumed loss, got ${booked}`);
  asrt(guard.consecLosses === before + 1, `guard.consecLosses grew by 1 (${before} -> ${guard.consecLosses})`);

  const rows = readJournal(journal.dir);
  asrt(rows.length === 1 && rows[0].type === "stuck", `one stuck row in the journal, got ${rows.length}`);
  const r = rows[0];
  asrt(r.pnlSol === -0.02 && r.lossAssumed === true, `row carries pnlSol=-0.02 + lossAssumed:true, got ${r.pnlSol}/${r.lossAssumed}`);
  asrt(r.entrySolSol === 0.02 && r.tokens === "123456", "row carries the entry and the token amount");
  asrt(r.ataRentSol === 0.00207408, "row carries the locked ATA rent separately (not inside pnlSol)");
  asrt(r.venue === "pumpswap" && r.attempts === 3 && r.sessionId === "s1" && r.bot === "stuck-test", "bot-specific fields are kept");
  asrt(netSolForDay(rows, TODAY) === -0.02, `netSolForDay over a journal with one stuck row = -entry, got ${netSolForDay(rows, TODAY)}`);
}

// --- the limits really trip: 3 stuck positions halt the guard and block the day ----------------
{
  const guard = new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses: 3 });
  const journal = newJournal();
  for (let i = 0; i < 3; i++) {
    recordStuck({ journal, recordResult: (p) => guard.recordResult(p), mint: `M${i}`, pos: { entrySolSol: 0.02 }, buySol: BUY_SOL, reason: "r" });
  }
  asrt(guard.halted === true, "MAX_CONSEC_LOSSES trips on stuck positions alone");
  const net = netSolForDay(readJournal(journal.dir), TODAY);
  asrt(net === -0.06, `three stuck rows sum to -0.06, got ${net}`);
  asrt(dailyLossBlocked({ netSol: net, limitSol: 0.05 }).blocked === true, "the daily loss limit blocks new buys after stuck losses");
}

// --- only the REMAINING entry after partial sells, never the sold part again -------------------
asrt(stuckLossSol({ entrySolSol: 0.008 }, BUY_SOL) === -0.008, "after partial sells the remaining entry share is the loss");
asrt(stuckLossSol({}, BUY_SOL) === -BUY_SOL, "no recorded entry -> the nominal buy size");
asrt(stuckLossSol(null, BUY_SOL) === -BUY_SOL, "no position object -> the nominal buy size");

// --- a zero remainder must not touch the guard (recordResult(0) would RESET the streak) --------
{
  const guard = new TradeGuard({ maxTradeSol: 1, maxSessionSol: 0, maxConsecLosses: 5 });
  guard.recordResult(-0.01);
  let calls = 0;
  const booked = recordStuck({ recordResult: (p) => { calls += 1; guard.recordResult(p); }, mint: "Z", pos: { entrySolSol: 0 }, buySol: BUY_SOL, reason: "r" });
  asrt(booked === 0 && calls === 0 && guard.consecLosses === 1, "zero remaining entry: nothing booked, losing streak intact");
}

// --- bot fields can add context but cannot fake the accounting ---------------------------------
{
  const journal = newJournal();
  recordStuck({ journal, mint: "F", pos: { entrySolSol: 0.03, tokens: 1n }, buySol: BUY_SOL, reason: "r", fields: { pnlSol: 99, lossAssumed: false, tokens: "777" } });
  const r = readJournal(journal.dir)[0];
  asrt(r.pnlSol === -0.03 && r.lossAssumed === true, "fields cannot override pnlSol / lossAssumed");
  asrt(r.tokens === "777", "fields may override the token amount (wallet balance)");
}

// --- journal epochs: old rows keep their meaning ----------------------------------------------
{
  const ts = new Date().toISOString();
  const legacyStuck = { type: "stuck", ts, mint: "L", reason: "no venue", attempts: 0 }; // before this change
  const openAtStop = { type: "stuck", ts, mint: "O", reason: "open at stop", attempts: 0 }; // not loss-assumed
  const odd = { type: "stuck", ts, mint: "X", pnlSol: -1 }; // pnlSol without the flag: ignored
  asrt(netSolForDay([legacyStuck, openAtStop, odd], TODAY) === 0, "stuck rows without lossAssumed:true do not move the day");
  const trade = { type: "trade", ts, pnlSol: 0.01 };
  const stuck = { type: "stuck", ts, pnlSol: -0.02, lossAssumed: true };
  asrt(netSolForDay([trade, stuck], TODAY) === -0.01, "trades and assumed stuck losses add up");
  const yesterday = { type: "stuck", tsMsk: "2000-01-01T00:00:00+03:00", pnlSol: -0.02, lossAssumed: true };
  asrt(netSolForDay([yesterday], TODAY) === 0, "a stuck row of another day is not counted");
  // Recovery tools write no `trade` row, so a later rescue cannot be counted twice.
  const rescue = { type: "sell_all_sent", ts, solReceived: 0.015 };
  asrt(netSolForDay([stuck, rescue], TODAY) === -0.02, "sell_all_sent is not a day result: no double counting, no credit");
}

// --- wiring: the bots call the helper where they used to drop the position ---------------------
const read = (rel) => fs.readFileSync(path.join(here, "..", rel), "utf8");
{
  const src = read("bots/graduation-sniper/graduation.mjs");
  const body = src.slice(src.indexOf("function markStuck("), src.indexOf("function deferSell("));
  asrt(body.length > 0 && /recordStuck\(\{/.test(body), "graduation markStuck books the loss through recordStuck");
  asrt(/recordResult,/.test(body) && /buySol: BUY_SOL/.test(body) && /\bpos,/.test(body), "markStuck passes the bot's recordResult (guard + daily net), the position and BUY_SOL");
  asrt(!/journal\.write\(\{\s*type: "stuck"/.test(body), "markStuck has no second, loss-free stuck row");
  asrt(/positions\.delete\(mint\)/.test(body), "markStuck still removes the position");
}
for (const [rel, tokens] of [["bots/sniper/sniper.mjs", "tokenAmount"], ["bots/copy-trader/watcher.mjs", "total"]]) {
  const src = read(rel);
  const at = src.indexOf('"curve complete: no AMM sell in this bot"');
  asrt(at > 0, `${rel}: completed curve has the stuck reason`);
  const block = src.slice(src.lastIndexOf("if (!state || state.complete) {", at), src.indexOf("return;", at));
  asrt(/recordStuck\(\{/.test(block) && /recordResult/.test(block) && /journal/.test(block), `${rel}: the completed-curve branch journals STUCK and reports the loss`);
  asrt(new RegExp(`tokens: ${tokens}`).test(block), `${rel}: the row carries the wallet balance`);
  asrt(/positions\.delete\(mint\)/.test(block), `${rel}: the position is still removed (no AMM sell is attempted)`);
  asrt(!/ammSell|pumpswap-sell|amm-sell/.test(src), `${rel}: no AMM sell was added to this bot`);
}
asrt(/new TradeJournal\(\{ bot: "copy-trader" \}\)/.test(read("bots/copy-trader/watcher.mjs")), "copy-trader has a journal (bot: copy-trader)");
asrt(!/graduated, unsold`\)/.test(read("bots/sniper/sniper.mjs")), "sniper: the silent 'graduated, unsold' drop is gone");

console.log(JSON.stringify({ stuckLoss: stuckLossSol({ entrySolSol: 0.02 }, BUY_SOL), dayNet: netSolForDay([{ type: "stuck", ts: new Date().toISOString(), pnlSol: -0.02, lossAssumed: true }], TODAY) }));
console.log("PASS: STUCK is an assumed loss for TradeGuard and the daily limit; sniper/copy-trader journal a completed curve as STUCK");
