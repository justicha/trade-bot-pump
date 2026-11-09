#!/usr/bin/env node
// Status report: how far is the recording from a verdict? Prints the raw window, the number of
// tokens, the decisions the frozen choice and its controls would take AFTER the freeze, and how
// many more hours/trades are still needed.
//
//   node scripts/status.mjs              # or: npm run status
//
// "N" is the do-nothing control, so it never has decisions; it is shown to make that explicit.
import fs from "node:fs";
import path from "node:path";
import { replayRaw, payloadOf, rawDirStats, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade, parseCreate } from "../lib/events.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { HolderTracker } from "../lib/holders.mjs";
import { isMayhemCaller, isMayhemPath } from "../lib/mayhem.mjs";
import { ROOT } from "../lib/config.mjs";
import { fmtMsk } from "../lib/time.mjs";

const FREEZE_FILE = path.join(ROOT, "data", "research", "frozen.json");
const frozen = fs.existsSync(FREEZE_FILE) ? JSON.parse(fs.readFileSync(FREEZE_FILE, "utf8")) : null;

const perMint = new Map();
let from = Infinity;
let to = -Infinity;
let trades = 0;
for await (const rec of replayRaw(RAW_DIR)) {
  const buf = payloadOf(rec);
  if (!buf) continue;
  const d = describe(buf);
  if (d.type === "create-v2") {
    const c = parseCreate(buf);
    if (!c || !c.launchParamsOk) continue;
    const m = perMint.get(c.mint) || { mint: c.mint, events: [] };
    m.createdAt = rec.ts;
    m.fromCreate = true;
    perMint.set(c.mint, m);
    from = Math.min(from, rec.ts);
    continue;
  }
  if (d.type !== "trade-v3") continue;
  const ev = parseTrade(buf);
  if (!ev) continue;
  trades += 1;
  from = Math.min(from, rec.ts);
  to = Math.max(to, rec.ts);
  const m = perMint.get(ev.mint) || { mint: ev.mint, events: [] };
  m.events.push({ ts: rec.ts, slot: rec.slot, isBuy: ev.isBuyByte, tokenAmount: ev.tokenAmount, solAmount: ev.solAmount, user: ev.user, hasReserves: ev.hasReserves, vSol: ev.reserves?.vSol ?? null, vTok: ev.reserves?.vTok ?? null, mayhem: isMayhemCaller(rec.outer) || isMayhemPath(rec.path) });
  perMint.set(ev.mint, m);
}

const hours = (to - from) / 3600_000;
const utcHours = new Set();
for (const m of perMint.values()) for (const e of m.events) utcHours.add(new Date(e.ts).getUTCHours());

// decisions per policy: A0 = organic gate over all trades, B2 = non-Mayhem wallet gate (2 slots)
const decisions = { A0: [], B2: [], N: [] };
for (const mint of perMint.keys()) {
  const m = perMint.get(mint);
  const list = m.events.slice().sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.ts - b.ts);
  if (!list.length) continue;
  const gate = (minSlots, skipMayhem) => {
    const t = new HolderTracker({ minHolders: 4, minSlots, minDelayMs: 0, waitMs: 60_000 });
    for (const ev of list) {
      if (skipMayhem && ev.mayhem) continue;
      t.track(mint, { at: ev.ts, slot: ev.slot });
      const snap = t.apply(mint, ev.user, ev.isBuy ? ev.tokenAmount : -ev.tokenAmount, { ts: ev.ts, slot: ev.slot });
      if (snap && snap.ready && t.organic(snap)) return ev.ts;
    }
    return null;
  };
  const mayhem = list.some((e) => e.mayhem);
  const a0 = gate(1, false);
  if (a0) decisions.A0.push({ ts: a0, mayhem });
  if (!mayhem) {
    const b2 = gate(2, true);
    if (b2) decisions.B2.push({ ts: b2, mayhem });
  }
}

const since = (list) => (frozen ? list.filter((d) => d.ts > frozen.frozenAt) : list);
const hoursSinceFreeze = frozen ? Math.max(0, (Date.now() - frozen.frozenAt) / 3600_000) : 0;
const need = frozen?.verdictRule || { minTrades: 300, minHours: 72 };
const st = rawDirStats(RAW_DIR);

console.log("=== STATUS ===");
console.log(`raw: ${(st.total / 1024 / 1024).toFixed(1)} MB in ${st.count} hour file(s), ${trades} trades, ${perMint.size} mints`);
console.log(`recording window: ${hours.toFixed(2)} h (${fmtMsk(new Date(from))} .. ${fmtMsk(new Date(to))}), UTC hours covered: ${utcHours.size}/24`);
console.log(`mayhem tokens: ${[...perMint.values()].filter((m) => m.events.some((e) => e.mayhem)).length}`);
if (!frozen) {
  console.log("\nno freeze yet: run  node scripts/lab-raw.mjs --freeze B2 --control A0 --control N");
  console.log(`decisions available now: A0 ${decisions.A0.length}, B2 ${decisions.B2.length}, N 0 (control: never buys)`);
} else {
  const a0 = since(decisions.A0).length;
  const b2 = since(decisions.B2).length;
  const rateB2 = hoursSinceFreeze > 0 ? b2 / hoursSinceFreeze : 0;
  const rateA0 = hoursSinceFreeze > 0 ? a0 / hoursSinceFreeze : 0;
  console.log(`\nfrozen: ${frozen.choice} (controls ${(frozen.controls || []).join(", ")}) at ${fmtMsk(new Date(frozen.frozenAt))}`);
  console.log(`hours since the freeze: ${hoursSinceFreeze.toFixed(2)} of ${need.minHours} needed -> ${Math.max(0, need.minHours - hoursSinceFreeze).toFixed(1)} h to go`);
  console.log(`decisions after the freeze: ${frozen.choice} ${b2}, A0 ${a0}, N 0 (control)`);
  const leftB2 = Math.max(0, need.minTrades - b2);
  const leftA0 = Math.max(0, need.minTrades - a0);
  console.log(
    `trades still needed: ${frozen.choice} ${leftB2} (${rateB2 > 0 ? `${(leftB2 / rateB2).toFixed(1)} h at the current rate of ${rateB2.toFixed(1)}/h` : "rate unknown — no decisions yet"}), ` +
      `A0 ${leftA0} (${rateA0 > 0 ? `${(leftA0 / rateA0).toFixed(1)} h at ${rateA0.toFixed(1)}/h` : "rate unknown"})`,
  );
  console.log(`UTC hours covered by post-freeze decisions: ${new Set(since(decisions[frozen.choice] ?? []).map((d) => new Date(d.ts).getUTCHours())).size}/24`);
}
