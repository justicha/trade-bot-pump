// Unit: exit depth (task 1) — a buy must not be sent when the bot could not sell it back.
//
// Pure decision + the real previewExit math from lib/exec.mjs (the same call the bot uses for
// TP/SL), plus a source guard that the bot wires it inside buyToken before any send.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_EXIT_RATIO, exitDepth } from "../lib/buy-checks.mjs";
import { previewExit } from "../lib/exec.mjs";
import { BUY_SKIP_REASON } from "../lib/buy-skip-reasons.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const ENTRY = 20_000_000n; // 0.02 SOL

// --- the threshold: 0.9 x 0.02 SOL = 0.018 SOL ---
asrt(MIN_EXIT_RATIO === 0.9, "the documented ratio is 0.9");
{
  const d = exitDepth({ solOutLamports: ENTRY, entryLamports: ENTRY });
  asrt(d.ok === true && d.reason === null, "a full-value exit passes");
  asrt(d.minOutLamports === 18_000_000n, `min out is 0.018 SOL, got ${d.minOutLamports}`);
}
{
  const atLimit = exitDepth({ solOutLamports: 18_000_000n, entryLamports: ENTRY });
  asrt(atLimit.ok === true, "exactly 0.9 x the buy still passes (inclusive)");
}
{
  const below = exitDepth({ solOutLamports: 17_999_999n, entryLamports: ENTRY });
  asrt(below.ok === false, "one lamport below the limit fails");
  asrt(below.reason === BUY_SKIP_REASON.insufficientExitDepth, `reason is "${BUY_SKIP_REASON.insufficientExitDepth}", got "${below.reason}"`);
  asrt(BUY_SKIP_REASON.insufficientExitDepth === "insufficient exit depth", "the journal reason is exactly the required string");
}
{
  const zero = exitDepth({ solOutLamports: 0n, entryLamports: ENTRY });
  asrt(zero.ok === false, "a zero exit fails");
}

// --- the real curve math the bot uses (previewExit, the same call as TP/SL) ---
// Note: on a constant-product curve the round trip of our own buy is ~0.98 x the buy by
// construction, so this gate mostly catches states where the exit CANNOT be computed or paid
// (broken/zero reserves, a curve the program would reject) — exactly the situations where the
// bot must not enter. It is the same math the TP/SL decision uses, not a second model.
{
  const healthy = {
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualSolReserves: 90_000_000_000n,
    realTokenReserves: 793_000_000_000_000n,
    realSolReserves: 60_000_000_000n,
  };
  const prev = previewExit(healthy, 0.02);
  const depth = exitDepth({ solOutLamports: prev.solOut, entryLamports: ENTRY });
  asrt(prev.ok === true, "healthy curve: previewExit returns a quote");
  asrt(depth.ok === true, `healthy curve passes (exit ${(Number(prev.solOut) / 1e9).toFixed(6)} SOL)`);
  asrt(prev.ratio > 0.9, `a normal round trip keeps >90% (got ${prev.ratio.toFixed(3)})`);
}

{
  // Reserves that make the exit uncomputable (no tokens out) must fail the gate, not crash it.
  const broken = {
    virtualTokenReserves: 0n,
    virtualSolReserves: 30_000_000_000n,
    realTokenReserves: 0n,
    realSolReserves: 0n,
  };
  const prev = previewExit(broken, 0.02);
  asrt(prev.ok === false, "broken reserves: previewExit refuses to quote");
  const depth = exitDepth({ solOutLamports: 0n, entryLamports: ENTRY });
  asrt(depth.ok === false, "no quote means no depth: the buy is skipped");
}


// --- the bot really calls it inside buyToken, before it signs anything ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.indexOf("async function buyToken");
  asrt(fn > 0, "buyToken found");
  const depthCall = src.indexOf("exitDepth(", fn);
  const firstSend = src.indexOf("sendTxWithRetry(", fn);
  asrt(depthCall > fn, "buyToken calls exitDepth");
  asrt(firstSend === -1 || depthCall < firstSend, "exitDepth runs before the first sendTxWithRetry");
  asrt(/type: "buy_skipped"/.test(src), "refusals are journaled as buy_skipped");
  asrt(/import \{ exitDepth \} from "\.\.\/\.\.\/lib\/buy-checks\.mjs"/.test(src), "the bot imports the depth check");
}

console.log(JSON.stringify({ ratio: MIN_EXIT_RATIO, minOutSol: Number(18_000_000n) / 1e9 }));
console.log("PASS: exit depth — a buy is refused when the expected exit is below 0.9 of the buy");
