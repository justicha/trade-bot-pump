// Unit test for the Mayhem flag, the create-v2 parser, the curve rebuild and capture pruning.
//
// The three things the analysis depends on:
//   * isMayhem for a TRADE comes from the calling program (outer / invoke path)
//   * isMayhem for a TOKEN comes from byte 81 of the curve account (is_mayhem_mode)
//   * the rebuilt curve reproduces the snapshot exactly when the amounts explain the trade, and
//     must not pretend when they do not
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCreate, LAUNCH_RESERVES, toBase58Safe, describe } from "../lib/events.mjs";
import { isMayhemCaller, isMayhemPath, mayhemFromAccount, MayhemIndex, MAYHEM_PROGRAM_ID, MAYHEM_ACCOUNT_FLAG_OFFSET } from "../lib/mayhem.mjs";
import { CurveRebuild } from "../lib/rebuild.mjs";
import { rawDirStats, pruneRawDir, RawCapture } from "../lib/rawcap.mjs";
import { TradeJournal, readJournal } from "../lib/journal.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---- Mayhem, trade level ----------------------------------------------------
asrt(MAYHEM_PROGRAM_ID === "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", "program id is the one measured in the raw capture");
asrt(isMayhemCaller(MAYHEM_PROGRAM_ID) === true, "a direct Mayhem call is Mayhem");
asrt(isMayhemCaller("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") === false, "pump.fun itself is not Mayhem");
asrt(isMayhemCaller(null) === false, "a direct call (no outer) is not Mayhem");
asrt(isMayhemPath(["Router111", MAYHEM_PROGRAM_ID, "6EF8rrec"]) === true, "a Mayhem hop deeper in the path counts");
asrt(isMayhemPath(["Router111", "6EF8rrec"]) === false, "a path without Mayhem is not Mayhem");
asrt(isMayhemPath(null) === false, "no path is not Mayhem");

// ---- Mayhem, token level (curve account byte 81) ----------------------------
{
  const acct = Buffer.alloc(166);
  acct[MAYHEM_ACCOUNT_FLAG_OFFSET] = 1;
  asrt(mayhemFromAccount(acct)?.isMayhemMode === true, "byte 81 = 1 means the token is mayhem mode");
  acct[MAYHEM_ACCOUNT_FLAG_OFFSET] = 0;
  asrt(mayhemFromAccount(acct)?.isMayhemMode === false, "byte 81 = 0 means it is not");
  asrt(mayhemFromAccount(Buffer.alloc(60)) === null, "a short account cannot be judged");
  asrt(mayhemFromAccount(null) === null, "no account cannot be judged");
}

// ---- MayhemIndex -----------------------------------------------------------
{
  const idx = new MayhemIndex();
  idx.noteTrade("M1", { outer: null, path: null, user: "U1" });
  asrt(idx.isMayhem("M1") === false, "a plain trade does not make a token Mayhem");
  idx.noteTrade("M1", { outer: MAYHEM_PROGRAM_ID, path: null, user: "U2" });
  asrt(idx.isMayhem("M1") === true, "one Mayhem trade marks the token");
  const rec = idx.get("M1");
  asrt(rec.trades === 2 && rec.mayhemTrades === 1, "trade counters split by caller, got " + JSON.stringify({ t: rec.trades, m: rec.mayhemTrades }));
  asrt(rec.buyers.size === 2 && rec.mayhemBuyers.size === 1, "buyers are tracked with and without Mayhem");
  const acct = Buffer.alloc(166);
  acct[MAYHEM_ACCOUNT_FLAG_OFFSET] = 0;
  idx.noteAccount("M2", acct);
  asrt(idx.isMayhem("M2") === false && idx.get("M2").source === "account", "the account flag sets the source of truth");
  const st = idx.stats();
  asrt(st.mints === 2 && st.mayhemTokens === 1 && st.trades === 2, "stats aggregate, got " + JSON.stringify(st));

// ---- create-v2 parser -------------------------------------------------------
{
  // Built exactly the way the program serialises it: three anchor strings (u32 length + bytes),
  // four keys, timestamp (seconds), four u64 reserves, then a variable tail.
  const enc = (s) => {
    const b = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length, 0);
    return Buffer.concat([len, b]);
  };
  const key = (ch) => Buffer.alloc(32, ch);
  const u64 = (v) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    return b;
  };
  const mint = toBase58Safe(key(7));
  const buf = Buffer.concat([
    Buffer.from("1b72a94ddeeb6376", "hex"),
    enc("Test Token"),
    enc("TST"),
    enc("https://example.invalid/meta.json"),
    key(7),
    key(8),
    key(9),
    key(10),
    u64(1794111586),
    u64(LAUNCH_RESERVES.vTok),
    u64(LAUNCH_RESERVES.vSol),
    u64(LAUNCH_RESERVES.rTok),
    u64(LAUNCH_RESERVES.supply),
    Buffer.from([1, 0]),
  ]);
  asrt(describe(buf).type === "create-v2", "the synthetic payload is recognised as create-v2");
  const c = parseCreate(buf);
  asrt(c !== null, "the create payload parses");
  asrt(c.mint === mint, "mint offset is right, got " + c.mint);
  asrt(c.name === "Test Token" && c.symbol === "TST", "name/symbol decode, got " + JSON.stringify({ n: c.name, s: c.symbol }));
  asrt(c.launchParamsOk === true, "the launch reserves match the documented start values");
  asrt(c.timestampSec === 1794111586, "timestamp is read as seconds");
  asrt(c.tail.length === 2 && c.tail[0] === 1, "the tail is kept raw for later analysis");
  asrt(parseCreate(buf.subarray(0, 40)) === null, "a truncated create returns null instead of throwing");
  asrt(parseCreate(Buffer.from("00")) === null, "garbage returns null");
}

// ---- rebuild ---------------------------------------------------------------
{
  const rb = new CurveRebuild({ reanchorOnLargeErrorPpm: 1000 });
  asrt(rb.priceOf("M") === null, "no anchor -> no price");
  rb.seedFromCreate("M");
  const p0 = rb.priceOf("M");
  asrt(Math.abs(p0 - 30 / 1.073e9) < 1e-15, "the create anchor gives the launch price, got " + p0);
  rb.apply("M", { isBuy: true, solAmount: 1, tokenAmount: 30_000_000 });
  const st = rb.stateOf("M");
  asrt(st.vSol === LAUNCH_RESERVES.vSol + 1_000_000_000n, "vSol grew by exactly the trade's SOL");
  asrt(st.vTok === LAUNCH_RESERVES.vTok - 30_000_000_000_000n, "vTok shrank by exactly the trade's tokens");
  const cmp = rb.compare("M", { vSol: st.vSol, vTok: st.vTok });
  asrt(cmp.errKPpm === 0, "a snapshot that matches the model gives 0 ppm, got " + cmp.errKPpm);
  asrt(cmp.reanchored === false, "no re-anchor when the model is right");
  const vSolBefore = st.vSol; // stateOf returns the live object: keep the value, not the reference
  const cmp2 = rb.compare("M", { vSol: st.vSol + 19_000_000_000n, vTok: st.vTok });
  asrt(cmp2.errKPpm > 1000, "an unexplained SOL jump is detected, got " + cmp2.errKPpm + " ppm");
  asrt(cmp2.unexplainedSol > 18, "and its size is reported, got " + cmp2.unexplainedSol);
  asrt(cmp2.reanchored === true, "the healer re-anchors instead of drifting forever");
  asrt(rb.stateOf("M").vSol === vSolBefore + 19_000_000_000n, "the snapshot became the new anchor");
  const beforeV = rb.stateOf("M").vSol;
  const beforeT = rb.stateOf("M").vTok;
  rb.apply("M", { isBuy: false, solAmount: 0.5, tokenAmount: 10_000_000 });
  asrt(rb.stateOf("M").vSol === beforeV - 500_000_000n, "a sell removes the SOL");
  asrt(rb.stateOf("M").vTok === beforeT + 10_000_000_000_000n, "a sell returns the tokens");
}

// ---- capture hygiene -------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rawprune-"));
  const cap = new RawCapture({ dir });
  const t0 = new Date(2026, 10, 8, 10, 1, 0).getTime();
  for (let h = 0; h < 3; h++) {
    cap.write({ ts: t0 + h * 3600_000, slot: 1, sig: `s${h}`, program: "P", ix: "Buy", outer: null, path: ["P"], data: Buffer.from(`payload-${h}`).toString("base64") });
  }
  cap.flush();
  await cap.close();
  let st = rawDirStats(dir);
  asrt(st.count === 3, "three hours -> three files, got " + st.count);
  const removed = pruneRawDir(dir, { maxBytes: 1 });
  st = rawDirStats(dir);
  asrt(removed.length >= 1, "pruning removed the oldest files");
  asrt(st.count < 3, "files were actually deleted, got " + st.count);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- journal cost-scheme stamp ---------------------------------------------
// A journal that spans a change of the cost model must not mix epochs silently: every trade line
// carries the scheme that produced costsSol/pnlSol.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-scheme-"));
  const j = new TradeJournal({ bot: "scheme-test", dir });
  j.trade({ mint: "M", buySol: 0.02, pnlSol: 0.001, costsSol: 0.0007 });
  const lines = readJournal(dir).filter((r) => r.type === "trade");
  asrt(lines.length === 1, "one journal line written");
  asrt(typeof lines[0].costsScheme === "string" && lines[0].costsScheme.startsWith("v"), "the line carries a cost-scheme version, got " + lines[0].costsScheme);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ mayhemProgram: MAYHEM_PROGRAM_ID, flagOffset: MAYHEM_ACCOUNT_FLAG_OFFSET }));
console.log("PASS: Mayhem flags (trade + account), create-v2 parser, curve rebuild and capture pruning behave");

}
