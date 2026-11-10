// Unit: a LIVE buy is refused until the PumpSwap exit path is confirmed (LIVE_CONFIRM_AMM=yes).
//
// A position the bot cannot close is a one-way trade (AUDIT_SELL.md V7: the AMM sell currently
// fails with Custom 6062), so buyToken must stop before it signs or sends anything. A dry run
// sends nothing anyway and must keep working exactly as before.
//
// A real `--live` run cannot be spawned here: lib/rpc.mjs refuses RPC_MOCK together with --live
// ("test fixture cannot be used with --live"). That is why the gate is a small pure function and
// the test drives it directly, plus checks the call site order in the bot's source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUY_BLOCK_REASON, checkBuyGate } from "../lib/buy-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// --- the decision ---
const blocked = checkBuyGate({ live: true, confirmAmm: undefined });
asrt(blocked.ok === false, "LIVE without LIVE_CONFIRM_AMM is blocked");
asrt(blocked.reason === BUY_BLOCK_REASON, `reason is the documented one, got "${blocked.reason}"`);
asrt(BUY_BLOCK_REASON === "LIVE_CONFIRM_AMM not set, PumpSwap sell path unverified", "reason text is exactly the required one");
asrt(checkBuyGate({ live: true, confirmAmm: "no" }).ok === false, "any value other than yes is blocked");
asrt(checkBuyGate({ live: true, confirmAmm: "" }).ok === false, "an empty value is blocked");
asrt(checkBuyGate({ live: true, confirmAmm: "yes" }).ok === true, "LIVE with LIVE_CONFIRM_AMM=yes is allowed");
asrt(checkBuyGate({ live: false, confirmAmm: undefined }).ok === true, "dry run is unchanged (gate open)");

// --- no send, no position: the gate runs before anything that could spend SOL ---
{
  let sends = 0;
  let positionsOpened = 0;
  // Mirrors buyToken's order: gate first, then (and only then) build/send/open.
  const attemptBuy = ({ live, confirmAmm }) => {
    const gate = checkBuyGate({ live, confirmAmm });
    if (!gate.ok) return gate;
    sends += 1;
    positionsOpened += 1;
    return { ok: true };
  };
  attemptBuy({ live: true, confirmAmm: undefined });
  asrt(sends === 0, `sendTransaction must not be called, got ${sends} call(s)`);
  asrt(positionsOpened === 0, `no position may be opened, got ${positionsOpened}`);

  attemptBuy({ live: true, confirmAmm: "yes" });
  asrt(sends === 1 && positionsOpened === 1, "with LIVE_CONFIRM_AMM=yes the buy path proceeds");
}

// --- the bot really calls the gate inside buyToken, before its first send ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.indexOf("async function buyToken");
  asrt(fn > 0, "buyToken found in graduation.mjs");
  const gate = src.indexOf("checkBuyGate(", fn);
  const send = src.indexOf("sendTxWithRetry(", fn);
  asrt(gate > fn, "buyToken calls checkBuyGate");
  asrt(send === -1 || gate < send, "checkBuyGate is called before the first sendTxWithRetry in buyToken");
  asrt(/buy blocked: \$\{buyGate\.reason\}/.test(src), "the block is logged with the gate reason");
}

console.log(JSON.stringify({ reason: BUY_BLOCK_REASON, dryRunUnaffected: true }));
console.log("PASS: live buys are blocked until LIVE_CONFIRM_AMM=yes (no send, no position); dry run unchanged");
