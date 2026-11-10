// Pessimistic execution model test (step 5).
import "./lib/test-env.mjs";
import { sizeSlippageBps, pessimisticRoundTrip, bothModes, executionDelay, DELAY_MIN_MS, DELAY_MAX_MS } from "../lib/pessimistic.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

asrt(sizeSlippageBps(0.02) === Math.round(0.02 * 200), "size slippage scales with SOL");
asrt(sizeSlippageBps(0.1) > sizeSlippageBps(0.02), "bigger order -> more slippage");

const { optimistic, pessimistic } = bothModes({ buySol: 0.02, ratio: 2 });
asrt(pessimistic.slipBps > optimistic.slipBps, `pessimistic slippage is higher (${pessimistic.slipBps} > ${optimistic.slipBps})`);
asrt(pessimistic.netPnl < optimistic.netPnl, "pessimistic net is lower than optimistic");

for (let i = 0; i < 200; i++) {
  const d = executionDelay({ rng: Math.random });
  asrt(d >= DELAY_MIN_MS && d <= DELAY_MAX_MS, `delay in [200,800]ms (got ${d})`);
}

const pr = pessimisticRoundTrip({ buySol: 0.02, ratio: 2, delayMs: 500 });
asrt(pr.delayMs === 500, "explicit delay respected");
asrt(Number.isFinite(pr.netPnl), "pessimistic net computed");

console.log("PASS: pessimistic model (delay, size slippage, two modes) behaves");
