#!/usr/bin/env node
// Raw event capture bot: writes every pump.fun and PumpSwap program event to compressed NDJSON.
//
//   node scripts/capture-raw.mjs              # until Ctrl+C
//   CAPTURE_SEC=300 node scripts/capture-raw.mjs
//   node scripts/capture-raw.mjs --dir data/raw
//
// Read-only: no wallet, no transactions. Files: data/raw/YYYY-MM-DD-HH.jsonl.gz (one per local
// hour). Every record carries slot, signature, program, instruction name, the outer program
// (null = direct call) and the untouched base64 payload, so the parser can be re-validated
// offline after a fix (scripts/diag-390.mjs, scripts/replay-raw.mjs).
import { SolanaWs } from "../lib/ws.mjs";
import fs from "node:fs";
import { PUMP_PROGRAM } from "../lib/constants.mjs";
import { RawCapture, parseProgramLogs, rawDirStats, RAW_DIR } from "../lib/rawcap.mjs";
import { log } from "../lib/logger.mjs";

// PumpSwap AMM (graduated tokens) — see GUIDE.md / lib/analyzer-core.mjs.
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const argv = process.argv.slice(2);
const dirArg = argv.indexOf("--dir");
const DIR = dirArg >= 0 ? argv[dirArg + 1] : RAW_DIR;
const SECONDS = Number(process.env.CAPTURE_SEC || 0); // 0 = run until Ctrl+C
const MAX_GB = Number(process.env.CAPTURE_MAX_GB ?? 10); // disk cap; ~1.1 GB per day at full rate
// Which programs to record. Foreign programs (routers, Jupiter, ...) are only visible as the
// `outer`/`path` of a payload and are never written as events of their own — that is what keeps
// the file small. `--programs pumpfun` drops PumpSwap as well.
const programsArg = (() => {
  const i = argv.indexOf("--programs");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : process.env.CAPTURE_PROGRAMS || "both";
})();
const WANT = new Set(
  programsArg === "pumpfun"
    ? [PUMP_PROGRAM.toBase58()]
    : programsArg === "pumpswap"
      ? [PUMPSWAP_PROGRAM]
      : [PUMP_PROGRAM.toBase58(), PUMPSWAP_PROGRAM],
);
const WATCHED = WANT;

const cap = new RawCapture({ dir: DIR, maxTotalBytes: MAX_GB * 1024 * 1024 * 1024 });
const stats = { records: 0, txs: 0, byProgram: new Map(), byIx: new Map(), failed: 0 };
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

const ws = new SolanaWs();
await ws.connect();

for (const program of WATCHED) {
  ws.subscribeLogs(program, (result) => {
    const { value } = result;
    if (!value?.logs) return;
    const ts = Date.now();
    const slot = result?.context?.slot ?? null;
    const ok = !value.err;
    stats.txs += 1;
    if (!ok) stats.failed += 1;

    for (const ev of parseProgramLogs(value.logs)) {
      // "mentions:" subscriptions also deliver the caller's logs (e.g. a router that CPI'd into
      // pump.fun). Only the payloads the watched programs emitted belong in the raw file.
      if (!WATCHED.has(ev.program)) continue;
      cap.write({ ts, slot, sig: value.signature ?? null, ok, ...ev });
      stats.records += 1;
      bump(stats.byProgram, ev.program);
      bump(stats.byIx, `${ev.program.slice(0, 4)}:${ev.ix || "?"}`);
    }
  });
}

log.info(`[raw] capturing ${WATCHED.size} program(s) [${programsArg}] -> ${DIR}` + (MAX_GB > 0 ? ` (cap ${MAX_GB} GB)` : "") + " — Ctrl+C to stop");
cap.flush();
let lastBeat = { records: 0, ts: Date.now() };

const status = setInterval(() => {
  cap.flush(); // keep the file readable while it grows
  const top = [...stats.byIx.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const dirBytes = rawDirStats(DIR).total;
  // Heartbeat: records/min over the last interval (not since start, so a hiccup shows up) and the
  // free space on the volume — the two numbers that decide whether a long capture is healthy.
  const nowMs = Date.now();
  const perMin = ((stats.records - lastBeat.records) * 60_000) / Math.max(1, nowMs - lastBeat.ts);
  lastBeat = { records: stats.records, ts: nowMs };
  let freeGb = null;
  try {
    const st = fs.statfsSync(DIR);
    freeGb = (st.bavail * st.bsize) / 1024 / 1024 / 1024;
  } catch {
    freeGb = null; // statfs is not available on every platform/filesystem
  }
  log.info(
    `[raw] ${stats.records} events (${perMin.toFixed(0)}/min) / ${stats.txs} txs (${stats.failed} failed) | this file ${(cap.currentSize / 1024).toFixed(0)} KB | ` +
      `dir ${(dirBytes / 1024 / 1024).toFixed(1)} MB of ${MAX_GB} GB | free ${freeGb === null ? "n/a" : `${freeGb.toFixed(1)} GB`} | ` +
      `${cap.file ? cap.file.split(/[\\/]/).pop() : "-"} | ${top}`,
  );
}, 15_000);

let stopping = false;
async function finish(why) {
  if (stopping) return;
  stopping = true;
  clearInterval(status);
  await ws.close().catch(() => {});
  await cap.close();
  const top = [...stats.byIx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  log.info(`\n=== RAW CAPTURE SUMMARY (${why}) ===`);
  log.info(`  records : ${stats.records} events from ${stats.txs} txs (${stats.failed} failed)`);
  log.info(`  file    : ${cap.file}`);
  log.info(`  size    : ${(cap.currentSize / 1024).toFixed(1)} KB`);
  for (const [k, v] of top) log.info(`    ${k.padEnd(28)} ${v}`);
  process.exit(0);
}

process.on("SIGINT", () => void finish("manual stop (Ctrl+C)"));
process.on("SIGTERM", () => void finish("SIGTERM"));
if (SECONDS > 0) setTimeout(() => void finish(`${SECONDS}s elapsed`), SECONDS * 1000);
