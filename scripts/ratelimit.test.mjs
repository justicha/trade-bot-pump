// Unit test: the RPC rate limiter, 429 counting, degraded marking, and degraded-session exclusion.
// The mock returns 429 on every 2nd call and must NOT make the loop spin forever or exceed a sane
// total delay; the stats must mark the session degraded and the journal helper must exclude it.
process.env.RPC_URL = process.env.RPC_URL || "http://127.0.0.1:1";
process.env.RPC_MAX_RPS = "20"; // fast for the test

const { rpcCall, rpcStats } = await import("../lib/rpc.mjs");
const { RateLimiter } = await import("../lib/ratelimit.mjs");
const { excludeDegraded } = await import("../lib/journal.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

// ---- 429 counting + degraded + bounded delay --------------------------------
{
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n % 2 === 0) {
      const e = new Error("429 Too Many Requests");
      e.status = 429;
      throw e;
    }
    return "ok";
  };
  const before = rpcStats.calls;
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await rpcCall(flaky, { retries: 1, priority: 3 });
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  asrt(ok === 10 && failed === 0, `the retry succeeds on the next attempt, got ok ${ok} / failed ${failed}`);
  asrt(rpcStats.calls === before + 10, `every call is counted, got ${rpcStats.calls - before}`);
  asrt(rpcStats.retries429 >= 5, `429s counted (>=5), got ${rpcStats.retries429}`);
  asrt(rpcStats.degraded === true, "a 50% 429 rate marks the session degraded");
  asrt(rpcStats.maxDelayMs < 10_000, `no pathological delay: max ${rpcStats.maxDelayMs}ms`);
}

// ---- priority: an exit (0) is served before a rest (3) when both queue ---------
{
  const lim = new RateLimiter({ maxRps: 0.5, burst: 1 });
  const order = [];
  await lim.acquire(3); // takes the burst token immediately
  const pExit = lim.acquire(0).then(() => order.push("exit"));
  const pRest = lim.acquire(3).then(() => order.push("rest"));
  await Promise.all([pExit, pRest]);
  asrt(order[0] === "exit", `exit is served first, got ${order.join(",")}`);
}

// ---- degraded sessions are excluded from evaluation --------------------------
{
  const records = [
    { type: "session", sessionId: "s-degraded", degraded: true },
    { type: "session", sessionId: "s-ok", degraded: false },
    { type: "trade", mint: "A", sessionId: "s-degraded" },
    { type: "trade", mint: "B", sessionId: "s-ok" },
    { type: "trade", mint: "C" }, // no sessionId (old line): kept
  ];
  const res = excludeDegraded(records);
  asrt(res.excludedCount === 1 && res.trades.length === 2, `excluded ${res.excludedCount}, kept ${res.trades.length}`);
  asrt(res.trades.find((t) => t.mint === "A") === undefined, "the degraded session's trade is gone");
  asrt(res.trades.find((t) => t.mint === "C") !== undefined, "a line without sessionId is kept (old journal)");
}

console.log(JSON.stringify({ calls: rpcStats.calls, retries429: rpcStats.retries429, degraded: rpcStats.degraded }));
console.log("PASS: rate limiter orders by priority, 429s are counted, degraded sessions are excluded");
