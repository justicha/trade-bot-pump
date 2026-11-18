#!/usr/bin/env node
// Mint census (KODING #19): a READ-ONLY stream recorder of every pump.fun mint, one row per mint.
//
//   node scripts/mint-census.mjs                     # until Ctrl+C
//   $env:CENSUS_MAX_SEC='1800'; node scripts/mint-census.mjs
//
// It subscribes to the pump program's logs (the same stream as the shadow lab) and nothing else:
// no RPC call of any kind, no keypair, nothing signed or sent. The only configuration it reads from
// .env is the RPC URL that lib/config.mjs turns into the websocket URL. --live is refused.
//
// Rows (lib/mint-census.mjs): census_mint (one per mint, when it migrates / goes idle / at the
// stop), census_stall (the process did not run for > 30 s), census_gap (no stream event for
// >= CENSUS_GAP_SEC: a socket drop / reconnect), census_mem (every 10 min and at the stop). File: data/census/census-YYYY-MM-DD.jsonl by UTC date (CENSUS_DIR overrides the folder).
// Its own instance lock (data/census/.census.lock): it can run on the PC beside a shadow lab.
//
// Env: CENSUS_MILESTONES (default 25,50,75,85,92,97,100), CENSUS_IDLE_SEC (1800),
// CENSUS_FULL_MIN_FILL (25), CENSUS_MAX_SEC (0 = until stopped), CENSUS_MEM_ROW_SEC (600),
// CENSUS_GAP_SEC (10).
// A bad value stops the recorder at the start with the variable named.
//
// RPC endpoint failover (KODING #20): with RPC_URLS set (comma list, order = priority) the stream
// moves to the next endpoint when a key is exhausted (handshake 429 / 401 / 402 / 403, a "limit / credits /
// max usage" JSON-RPC error, RPC_FAILOVER_AFTER times in a row, or 60 s without a connect). Each
// switch is an `rpc_switch` row in the census file; census_mem carries rpcIdx / rpcSwitches.
// Endpoints are printed as "#n host" only. Without RPC_URLS: the single RPC_URL as before.
//
// Rev 2 (KODING #21): after each curve completion the census watches the mint's PumpSwap pool
// (canonical PDA, no RPC) and writes one census_pool row (lib/census-pool.mjs). Stream: mode a = one
// logsSubscribe per watched pool (made at the completion, ended with the watch; ~15 at a time),
// mode b = one subscription on the whole PumpSwap program (heavy: ~0.7 MB/s measured 2026-11-16).
// A rejected pool subscription switches to mode b loudly (census_pool_mode row).
// Env: CENSUS_POOL (1; 0 = off, rev-1 behaviour), CENSUS_POOL_WATCH_SEC (3600), CENSUS_POOL_MODE (a),
// CENSUS_POOL_PRESUB_FILL (92: subscribe the pool when the fill reaches it; 100 = at the completion).
// Rev 3 (KODING #21c): the fill of mayhem curves and of curves quoted in another mint comes from the
// token side (they complete now too); a pending pool that shows its own event activates without the
// completion (completeSeen: false). See lib/mint-census.mjs.
// Rev 3.1 (KODING #21e): pool traffic budget. A pool's logs subscription ends at the first of
// CENSUS_POOL_LOGS_SEC (900) after its first trade or CENSUS_POOL_LOGS_MB (40) of logs; then the price
// follows accountSubscribe on its two vaults + the pool account until the window ends (phase 2,
// lib/census-pool.mjs). CENSUS_POOL_VAULTS=0 = logs for the whole window (rev 3); CENSUS_POOL_VAULT_CHECK=1
// subscribes the vaults from the first pool trade and measures the vault price against the trade
// events (census_mem vaultCheckErr*). census_mint `mayhem` is true / false / null.
if (process.argv.includes("--live")) {
  console.error("[census] mint-census is read-only; --live is not accepted.");
  process.exit(1);
}

const path = await import("node:path");
const C = await import("../lib/mint-census.mjs");
let cfg;
try {
  cfg = C.parseCensusEnv(process.env);
} catch (e) {
  console.error(`[census] ${e.message}`);
  process.exit(1);
}

const { ROOT } = await import("../lib/config.mjs");
const { PUMP_PROGRAM, PUMPSWAP_PROGRAM } = await import("../lib/constants.mjs");
const { attachPoolStream } = await import("../lib/census-pool.mjs");
const { SolanaWs } = await import("../lib/ws.mjs");
const { stallGapMs } = await import("../lib/stall-guard.mjs");
const { setupFailover } = await import("../lib/rpc-failover.mjs");

const log0 = (m) => console.log(`[census] ${m}`);
const DIR = process.env.CENSUS_DIR ? path.resolve(process.env.CENSUS_DIR) : path.join(ROOT, "data", "census");
const LOCK = path.join(DIR, ".census.lock");

let RPC;
try {
  RPC = setupFailover({ env: process.env, live: false, log: (level, m) => (level === "info" ? console.log : console.error)(`[census] ${m}`) });
} catch (e) {
  console.error(`[census] ${e.message}`);
  process.exit(1);
}

const lock = C.acquireLock(LOCK);
if (!lock.ok) {
  console.error(`[census] another mint-census is already running (PID ${lock.pid}, lock ${LOCK}).`);
  process.exit(1);
}
if (lock.warning) log0(`warning: ${lock.warning}`);

const startedAt = Date.now();
const census = C.createCensus({ ...cfg, startedAtMs: startedAt });
const writer = C.createWriter(DIR, { onError: (e) => process.stderr.write(`[census] writing disabled: ${e.message}\n`) });
const writeRows = (rows) => {
  for (const r of rows) writer.write(r);
};

let handlerErrors = 0;
let wsOpens = 0; // successful (re)connects of the socket; reconnects = opens - 1
for (const l of RPC.lines) log0(l);
if (RPC.failover) RPC.failover.onSwitch((row) => writer.write(row));
const rpcStats = () => (RPC.failover ? { rpcIdx: RPC.failover.idx, rpcSwitches: RPC.failover.switches } : { rpcIdx: 1, rpcSwitches: 0 });
const ws = new SolanaWs();
if (RPC.failover) ws.useFailover(RPC.failover);
ws.onOpen = () => {
  wsOpens += 1;
};
await ws.connect();
ws.subscribeLogs(PUMP_PROGRAM.toBase58(), (result) => {
  const logs = result?.value?.logs;
  if (!Array.isArray(logs)) return;
  if (!(logs[logs.length - 1] || "").includes("success")) return; // failed tx: no state change
  try {
    writeRows(C.handleLogs(census, logs, { slot: result?.context?.slot ?? null, nowMs: Date.now() }));
  } catch (e) {
    handlerErrors += 1;
    if (handlerErrors === 1) log0(`handler error: ${e?.stack || e}`);
  }
});
// PumpSwap pools of completed mints (rev 2). Subscriptions live in ws.subs like the pump one, so a
// reconnect / failover switch resubscribes exactly the pools still watched.
const poolStream = census.pools
  ? attachPoolStream({
      ws,
      pw: census.pools,
      programId: PUMPSWAP_PROGRAM.toBase58(),
      log: (m) => process.stderr.write(`[census] ${m}
`),
      onRow: (r) => writer.write(r),
      onLogs: (result, pool) => {
        const logs = result?.value?.logs;
        if (!Array.isArray(logs)) return;
        const failed = !(logs[logs.length - 1] || "").includes("success");
        try {
          writeRows(C.handlePoolLogs(census, logs, { signature: result?.value?.signature ?? null, nowMs: Date.now(), pool, failed, slot: result?.context?.slot ?? null }));
        } catch (e) {
          handlerErrors += 1;
          if (handlerErrors === 1) log0(`handler error: ${e?.stack || e}`);
        }
      },
      onAccount: (result, pool, kind) => {
        try {
          writeRows(C.handlePoolAccount(census, result, { pool, kind }));
        } catch (e) {
          handlerErrors += 1;
          if (handlerErrors === 1) log0(`handler error: ${e?.stack || e}`);
        }
      },
    })
  : null;

log0(
  `read-only, no RPC | milestones ${cfg.milestones.join(" ")} % | idle ${cfg.idleSec}s | gap after ${cfg.gapSec}s of silence | full row at maxFill >= ${cfg.fullMinFill} % | ` +
    `${census.pools ? `pools: mode ${census.pools.mode}, watch ${cfg.poolWatchSec}s, subscribe at fill ${cfg.poolPresubFill >= 100 ? "100 (completion)" : cfg.poolPresubFill}, ${cfg.poolVaults ? `logs until ${cfg.poolLogsSec}s / ${cfg.poolLogsMB} MB then vaults${cfg.poolVaultCheck ? " (vault check on)" : ""}` : "logs for the whole window (CENSUS_POOL_VAULTS=0)"}` : "pools: off (CENSUS_POOL=0)"} | ` +
    `output ${writer.file()} (UTC date) | rev ${C.CENSUS_REV}${cfg.maxSec > 0 ? ` | stops after ${cfg.maxSec}s` : ""}`,
);
log0("do not select text in this window: a paused console freezes the recorder (stalls are journaled)");

// ---- timer: stall guard, idle sweep, memory -------------------------------------------------------
const STALL_MS = C.STALL_SEC * 1000;
const STALL_CLEAR_MS = 60_000; // mints that appear this soon after a stall are still marked
const SWEEP_MS = 10_000;
const HOUSE_MS = 60_000;
const MEM_MS = cfg.memRowSec * 1000;
let lastTickAt = startedAt;
let stallAt = 0;
let sweptAt = startedAt;
let houseAt = startedAt;
let memAt = startedAt;

function writeMem(now) {
  const r = C.memRow(census, now, { rowsWritten: writer.written, bytesWritten: writer.bytes, handlerErrors, wsReconnects: Math.max(0, wsOpens - 1), ...rpcStats(), ...(poolStream ? { poolSubs: poolStream.poolSubs, vaultSubs: poolStream.vaultSubs } : {}) });
  writer.write(r);
  return r;
}

const timer = setInterval(() => {
  const now = Date.now();
  const notes = [];
  const gap = stallGapMs(now, lastTickAt, STALL_MS);
  lastTickAt = now;
  if (gap) {
    writer.write(C.noteStall(census, gap, now));
    stallAt = now;
    notes.push(`STALL: the process did not run for ${Math.round(gap / 1000)}s; ${census.live.size} live mint(s) marked stall: true`);
  } else if (stallAt && now - stallAt >= STALL_CLEAR_MS) {
    C.clearStall(census);
    stallAt = 0;
  }
  // Stream gap: no create / trade event for CENSUS_GAP_SEC (the socket is down or reconnecting). The
  // next event closes it and its census_gap row comes out of handleLogs.
  if (C.checkGap(census, now, cfg.gapSec)) notes.push(`stream silent for ${cfg.gapSec}s: gap open, ${census.live.size} live mint(s) marked gap: true`);
  writeRows(C.sweepPoolWatch(census)); // pool watches: window end / idle (cheap: ~15 pools)
  if (now - sweptAt >= SWEEP_MS) {
    sweptAt = now;
    writeRows(C.sweepIdle(census));
  }
  if (now - houseAt >= HOUSE_MS) {
    houseAt = now;
    C.housekeeping(census, now);
  }
  if (MEM_MS > 0 && now - memAt >= MEM_MS) {
    memAt = now;
    const r = writeMem(now);
    notes.push(`memory: rss ${r.rssMB} MB, heap ${r.heapMB} MB | live ${r.liveMints} | rows ${r.rows} (full ${r.full}, compact ${r.compact}, migrated ${r.migrated}) | launchers ${r.launchers} | ${census.pools ? `pools live ${r.poolLive}, pending ${r.poolPending}, phase 2 ${r.poolPhase2}, rows ${r.poolRows}, no-complete ${r.poolActivatedNoComplete}, subs ${r.poolSubs} + vault ${r.vaultSubs}, logs ${r.poolLogMB} MB, vaults ${r.vaultMB} MB, mode ${r.poolMode} | ` : ""}${(r.bytesWritten / 1048576).toFixed(2)} MB written`);
  }
  for (const n of notes) log0(n); // console last: it is the thing that can block
}, 1000);

// ---- stop -----------------------------------------------------------------------------------------
let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const g = C.closeGapAtStop(census, Date.now());
  if (g) writer.write(g);
  const rows = C.finishAll(census);
  writeRows(rows);
  const poolRows = C.finishPoolsAtStop(census);
  writeRows(poolRows);
  const r = writeMem(Date.now());
  log0(`=== CENSUS STOP (${reason}) === ${rows.length} live mint(s) + ${poolRows.length} pool watch(es) written as partial | rows ${r.rows} (full ${r.full}, compact ${r.compact}, migrated ${r.migrated}, idle ${r.idle}) | gaps ${r.gaps} (${r.gapSecTotal}s), ws reconnects ${r.wsReconnects} | ${(r.bytesWritten / 1048576).toFixed(2)} MB written | rss ${r.rssMB} MB`);
  log0(`file: ${writer.file()}`);
  await ws.close().catch(() => {});
  C.releaseLock(LOCK);
  process.exit(0);
}
if (cfg.maxSec > 0) setTimeout(() => stop("max-sec"), cfg.maxSec * 1000);
process.on("SIGINT", () => stop("sigint"));
process.on("SIGTERM", () => stop("sigterm"));
