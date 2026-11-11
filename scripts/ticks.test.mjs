// Unit test for the task-B instrumentation: run metadata, the tick log (write, rotate, drain).
import { makeTempKeys, cleanEnv } from "./lib/test-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TickLog } from "../lib/ticks.mjs";
import { newSessionId, paramsHash, gitSha } from "../lib/runmeta.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---- run meta ---------------------------------------------------------------
{
  asrt(/^sniper-/.test(newSessionId("sniper")), "session id has the prefix");
  asrt(newSessionId() !== newSessionId(), "session ids are unique");
  asrt(paramsHash({ a: 1, b: 2 }) === paramsHash({ b: 2, a: 1 }), "paramsHash ignores key order");
  asrt(paramsHash({ a: 1 }) !== paramsHash({ a: 2 }), "paramsHash changes with a value");
  asrt(paramsHash({ a: 1 }).length === 12, "paramsHash is 12 hex chars");
  const sha = gitSha();
  asrt(sha === null || /^[0-9a-f]{7}$/.test(sha), "gitSha is a 7-char sha or null, got " + sha);
}

// ---- tick log ---------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticks-"));
{
  const log = [];
  const ticks = new TickLog({ dir, sessionId: "test-session", intervalMs: 20, maxBytesPerFile: 120, log: (m) => log.push(m) });
  let calls = 0;
  ticks.start(async () => {
    calls += 1;
    return { ratio: 1 + calls / 100, vSol: 30e9 + calls, vTok: 1.073e15, buys: calls, sells: 0, buyers: calls };
  });
  ticks.track("MINT_A", { phase: "hold", entryPrice: 1 });
  ticks.track("MINT_B", { phase: "post", entryPrice: 1, until: Date.now() + 150 });
  await new Promise((r) => setTimeout(r, 220));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("ticks-"));
  asrt(files.length >= 1, "tick file created, got " + files.length);
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  asrt(lines.length >= 2, "tick lines written, got " + lines.length);
  asrt(lines.every((r) => r.sessionId === "test-session"), "every tick line carries the session id");
  asrt(lines.some((r) => r.mint === "MINT_A" && r.phase === "hold"), "a hold window is logged");
  asrt(lines.some((r) => r.mint === "MINT_B" && r.phase === "post"), "a post window is logged");
  asrt(lines.every((r) => Number.isFinite(r.ratio) && Number.isFinite(r.t) && r.tsMsk), "tick fields are complete");
  asrt(ticks.size === 1, "the post window closed on its `until`, hold stays open (size " + ticks.size + ")");
  // rotation: maxBytesPerFile was tiny, so more than one file must exist
  asrt(files.length >= 2, "tick log rotated by size, got " + files.length);
  const drained = await ticks.drain({ maxMs: 300 });
  asrt(drained.remaining === 0, "drain closes the remaining window");
  asrt(ticks.size === 0, "nothing tracked after drain");
  ticks.close();
}

// ---- TICKS=0 must disable the tick log (the trading path stays identical) ----
{
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const jdir = fs.mkdtempSync(path.join(os.tmpdir(), "ticks-off-"));
  const run = spawnSync(process.execPath, [path.join(repo, "bots", "sniper", "sniper.mjs"), "--dry-run"], {
    cwd: repo,
    timeout: 25_000,
    env: cleanEnv({
      RPC_URL: "http://127.0.0.1:1",
      RPC_MOCK: path.join(repo, "scripts", "mocks", "rpc-mock.mjs"),
      WS_MOCK: path.join(repo, "scripts", "mocks", "ws-mock.mjs"),
      JOURNAL_DIR: jdir,
      KEYS_DIR: makeTempKeys(),
      SNIPER_MAX_SEC: "6",
      SNIPER_DRAIN_MAX_SEC: "0",
      TICKS: "0",
      // Pin the filters so a local .env cannot change this test.
      SNIPER_MIN_HOLDERS: "4",
      SNIPER_HOLDER_WAIT_SEC: "45",
      SNIPER_MIN_DEV_BUY: "0",
      SNIPER_MIN_SLOTS: "1",
      SNIPER_MIN_DELAY_MS: "0",
    }),
  });
  asrt(run.status === 0, "sniper with TICKS=0 exits cleanly, got " + run.status);
  const tickFiles = fs.readdirSync(jdir).filter((f) => f.startsWith("ticks-"));
  asrt(tickFiles.length === 0, "TICKS=0 writes no tick file, got " + tickFiles.length);
  fs.rmSync(jdir, { recursive: true, force: true });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ sessionId: newSessionId("sniper"), paramsHash: paramsHash({ a: 1 }) }));
console.log("PASS: run metadata (sessionId/paramsHash/gitSha) and the tick log (write, rotate, drain) behave");
