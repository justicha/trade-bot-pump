// Unit test for the raw capture layer and the single-event curve identity.
//
// The parser fix (390/391) depends on both: raw files are the evidence, and the identity check is
// what lets a snapshot be accepted without a neighbour event. Both are tested on synthetic data
// so a failure points at the code, not at the network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProgramLogs, RawCapture, readRawFile, replayRaw, hourKey } from "../lib/rawcap.mjs";
import { CurveConsistency } from "../lib/consistency.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const ROUTER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// ---- 1. log stack: direct call -------------------------------------------------
{
  const evs = parseProgramLogs([
    `Program ${PUMP} invoke [1]`,
    "Program log: Instruction: Buy",
    "Program data: AAAAbG9s",
    `Program ${PUMP} consumed 1234 of 200000 compute units`,
    `Program ${PUMP} success`,
  ]);
  asrt(evs.length === 1, "one payload from a direct call, got " + evs.length);
  asrt(evs[0].program === PUMP, "payload belongs to the pump program");
  asrt(evs[0].ix === "Buy", "instruction name is captured, got " + evs[0].ix);
  asrt(evs[0].outer === null, "a top-level invoke has no outer program");
  asrt(evs[0].data === "AAAAbG9s", "payload is stored as the untouched base64 string");
}

// ---- 2. log stack: CPI through a router ----------------------------------------
{
  const evs = parseProgramLogs([
    `Program ${ROUTER} invoke [1]`,
    "Program log: Instruction: Route",
    `Program ${PUMP} invoke [2]`,
    "Program log: Instruction: Sell",
    "Program data: c2VsbA==",
    `Program ${PUMP} success`,
    `Program ${ROUTER} success`,
  ]);
  asrt(evs.length === 1, "one payload through a CPI, got " + evs.length);
  asrt(evs[0].outer === ROUTER, "outer program is the router, got " + evs[0].outer);
  asrt(evs[0].path.length === 2 && evs[0].path[0] === ROUTER, "invoke path keeps the caller");
  asrt(evs[0].ix === "Sell", "instruction comes from the innermost program");
}

// ---- 3. truncated / malformed logs must not throw ------------------------------
{
  const evs = parseProgramLogs([`Program ${PUMP} invoke [1]`, "Program log: Instruction: Buy", "Program data: x"]);
  asrt(evs.length === 1, "payload without a closing 'success' is still captured");
  asrt(parseProgramLogs([null, 42, "garbage"]).length === 0, "non-log lines are ignored");
  asrt(parseProgramLogs(undefined).length === 0, "missing logs array returns []");
  // a 'failed' from an outer program must not pop the inner one
  const nested = parseProgramLogs([
    `Program ${ROUTER} invoke [1]`,
    `Program ${PUMP} invoke [2]`,
    "Program data: aW5uZXI=",
    `Program ${ROUTER} failed: error`,
  ]);
  asrt(nested[0].program === PUMP, "inner payload attributed before the outer failure");
}

// ---- 4. hourly rotation + read back ------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rawcap-"));
{
  const cap = new RawCapture({ dir: tmp });
  const rec = (ts, data) => cap.write({ ts, slot: 1, sig: "sig-" + data, ok: true, program: PUMP, ix: "Buy", outer: null, path: [PUMP], data });
  const h1 = new Date(2026, 10, 8, 10, 5, 0).getTime();
  const h2 = new Date(2026, 10, 8, 11, 5, 0).getTime();
  rec(h1, "b25l");
  rec(h1 + 1000, "dHdv");
  rec(h2, "dGhyZWU="); // different hour -> rotate
  cap.flush();
  await cap.close();

  const files = fs.readdirSync(tmp).filter((f) => f.endsWith(".jsonl.gz")).sort();
  asrt(files.length === 2, "two hours -> two files, got " + files.length);
  asrt(files[0] === `${hourKey(new Date(h1))}.jsonl.gz`, "file name is the local hour key, got " + files[0]);

  // resume: a fresh capture on the same directory appends to the current hour file
  const sizeBefore = fs.statSync(path.join(tmp, `${hourKey(new Date(h2))}.jsonl.gz`)).size;
  const cap2 = new RawCapture({ dir: tmp });
  cap2.write({ ts: h2 + 5000, slot: 2, sig: "sig-resume", ok: true, program: PUMP, ix: "Buy", outer: null, path: [PUMP], data: "cmVzdW1lZA==" });
  cap2.flush();
  await cap2.close();
  const filesAfter = fs.readdirSync(tmp).filter((f) => f.endsWith(".jsonl.gz")).sort();
  asrt(filesAfter.length === 2, "resume does not create a new file, got " + filesAfter.length);
  asrt(fs.statSync(path.join(tmp, filesAfter[1])).size > sizeBefore, "the resumed file grew (appended, not truncated)");

  const got = [];
  for (const f of files) for await (const r of readRawFile(path.join(tmp, f))) got.push(r);
  asrt(got.length === 4, "all records read back (3 original + 1 resumed), got " + got.length);
  asrt(got[0].data === "b25l" && got[2].data === "dGhyZWU=", "payload survives the gzip roundtrip");
  asrt(got[0].type === undefined, "the meta header line is not returned as a record");

  const replayed = [];
  for await (const r of replayRaw(tmp)) replayed.push(r.sig);
  asrt(replayed.length === 4 && replayed[0] === "sig-b25l", "replayRaw walks the directory in order");
}

// ---- 5. single-event curve identity ------------------------------------------
{
  const SOL = 30_000_000_000n;
  const TOK = 279_900_000_000_000n;
  const vSol = 45_000_000_000n;
  const vTok = 1_000_000_000_000_000n;
  const good = { vSol, vTok, rSol: vSol - SOL, rTok: vTok - TOK };
  const gate = new CurveConsistency();

  asrt(gate.identity(good).ok === true, "virtual-real equals the curve constant -> identity holds");
  asrt(gate.identity({ ...good, rSol: good.rSol + 1_000_000_000n }).ok === false, "a 1 SOL error breaks the identity");
  asrt(gate.identity({ vSol, vTok, rSol: null, rTok: null }).ok === false, "no real reserves -> no identity");

  // no anchor yet: only a self-proving payload is accepted
  const fresh = new CurveConsistency();
  const rejected = fresh.checkSnapshot("M1", { vSol, vTok, rSol: vSol - SOL + 5_000_000_000n, rTok: vTok - TOK });
  asrt(rejected.ok === false, "without an anchor an implausible snapshot must be refused");
  const accepted = new CurveConsistency().checkSnapshot("M2", good);
  asrt(accepted.ok === true && accepted.via === "identity", "a self-proving snapshot is accepted without neighbours");

  // with an anchor, the k test does the work and the identity can rescue a real move
  const anchored = new CurveConsistency();
  anchored.anchor("M3", good.vSol, good.vTok, "account");
  asrt(anchored.checkSnapshot("M3", good).via === "k", "same point passes the k test");
  const next = { vSol: good.vSol + 2_000_000_000n, vTok: good.vTok - 40_000_000_000_000n };
  const moved = anchored.checkSnapshot("M3", { ...next, rSol: next.vSol - SOL, rTok: next.vTok - TOK });
  asrt(moved.ok === true && moved.via === "identity-reanchor", "a real move re-anchors through the identity");

  // the broken class: token delta right, sol reserve from another curve point, no identity
  const broken = anchored.checkSnapshot("M3", { vSol: good.vSol + 19_000_000_000n, vTok: good.vTok, rSol: null, rTok: null });
  asrt(broken.ok === false, "a snapshot that matches neither test is refused (the 45% drift class)");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ files: 2, records: 3 }));
console.log("PASS: raw capture rotates hourly and replays offline; curve identity accepts a snapshot without neighbours");

