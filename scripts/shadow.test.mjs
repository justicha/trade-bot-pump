// Shadow V0-V7 unit test: entry filters, V4/V5 exit replay on synthetic tick trajectories, skip
// share + skipped mean net, and the no-data path.
import { evaluateShadow, LAUNCH_RAW } from "../lib/shadow.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const f = LAUNCH_RAW;
let n = 0;
const t = (pnlSol, { entrySol = f, mayhemMode = false, holders = 4, launches = 0, ratio = 1, exit = "timeout 120s", mint = null } = {}) => ({
  mint: mint || `MINT_${(n += 1)}`,
  buySol: 0.02,
  pnlSol,
  entrySol,
  mayhemMode,
  holdersAtEntry: holders,
  creatorLaunches30m: launches,
  ratio,
  exitReason: exit,
  sellAt: "2026-11-08T10:00:00Z",
});
const mkTicks = (mint, samples) => new Map([[mint, samples.map(([tt, r]) => ({ t: tt, ratio: r, stale: false }))]]);

// ---- entry-filter variants ----
{
  const trades = [
    t(0.001, { mint: "A" }), // floor, standard
    t(0.002, { mint: "B", entrySol: f * 2 }), // 2x floor -> V1/V7 skip
    t(-0.003, { mint: "C", mayhemMode: true }), // mayhem -> V3 skip
    t(-0.004, { mint: "D", holders: 10 }), // holders>=9 -> V2 skip
    t(-0.005, { mint: "E", launches: 5 }), // creator>=4/30m -> V6 skip
  ];
  const { variants, checkedVariants } = evaluateShadow(trades, { floorPrice: f });
  const by = Object.fromEntries(variants.map((v) => [v.id, v]));
  asrt(checkedVariants === 8, "8 variants checked");
  asrt(by.V0.n === 5, "V0 baseline keeps all");
  asrt(by.V1.n === 3, `V1 skips >1.2x floor + mayhem (got ${by.V1.n})`);
  asrt(by.V2.n === 4, `V2 skips holders>=9 (got ${by.V2.n})`);
  asrt(by.V3.n === 4, `V3 skips mayhem (got ${by.V3.n})`);
  asrt(by.V6.n === 4, `V6 skips creator>=4/30m (got ${by.V6.n})`);
  asrt(by.V7.n === 2, `V7 = V1+V2+V3 (got ${by.V7.n})`);
  asrt(by.V1.skipped === 2 && by.V1.skipShare === 2 / 5, "skip share reported");
  asrt(Number.isFinite(by.V1.skippedMeanNetPct), "skipped mean net reported (baseline outcome)");
  asrt(by.V0.verdict === null && by.V1.verdict === null, "no verdict below 200 trades");
}

// ---- V5 (timeout 180s) replay ----
{
  const trades = [
    t(0, { mint: "TP", ratio: 2, exit: "take-profit 2.0x" }),
    t(0, { mint: "TO", ratio: 1, exit: "timeout 120s" }),
    t(0, { mint: "ND", ratio: 1, exit: "timeout 120s" }),
  ];
  const ticks = new Map([
    ["TP", [{ t: 0, ratio: 1, stale: false }, { t: 50, ratio: 2.1, stale: false }]],
    ["TO", [{ t: 0, ratio: 1, stale: false }, { t: 180, ratio: 1.1, stale: false }]],
    ["ND", [{ t: 0, ratio: 1, stale: false }, { t: 100, ratio: 1.1, stale: false }]], // ends before 180s, no TP/SL
  ]);
  const { variants } = evaluateShadow(trades, { floorPrice: f, ticks });
  const v5 = variants.find((v) => v.id === "V5");
  asrt(v5.n === 2, `V5 replayed 2 exits (got ${v5.n})`);
  asrt(v5.noData === 1, `V5 marks 1 no-data (got ${v5.noData})`);
  asrt(v5.tpShare === 0.5 && v5.timeoutShare === 0.5, "V5 exit shares correct");
}

// ---- V4 (partial 50% @1.5x + trailing) replay ----
{
  const trades = [t(0, { mint: "PT", ratio: 1, exit: "timeout 120s" })];
  // 1.5x at t=5 (partial), then 1.05x at t=10 <= 1.5*0.7=1.05 (trail exit)
  const ticks = mkTicks("PT", [[0, 1], [5, 1.5], [10, 1.0]]);
  const { variants } = evaluateShadow(trades, { floorPrice: f, ticks });
  const v4 = variants.find((v) => v.id === "V4");
  asrt(v4.n === 1, `V4 replayed 1 exit (got ${v4.n})`);
  asrt(v4.tpShare === 1, `V4 partial+trail counts as a profit exit (got tpShare=${v4.tpShare})`);
}

// ---- stale ticks are excluded from the replay ----
{
  const trades = [t(0, { mint: "STALE", ratio: 1, exit: "timeout 120s" })];
  const ticks = new Map([["STALE", [{ t: 0, ratio: 1, stale: false }, { t: 50, ratio: 3, stale: true }]]]);
  const { variants } = evaluateShadow(trades, { floorPrice: f, ticks });
  const v5 = variants.find((v) => v.id === "V5");
  asrt(v5.n === 0 && v5.noData === 1, `V5 ignores stale ticks -> no data (got n=${v5.n}, noData=${v5.noData})`);
}

console.log("PASS: shadow V0-V7 entry filters + V4/V5 tick replay + skip/no-data stats");
