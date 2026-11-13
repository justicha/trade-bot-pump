import "./lib/test-env.mjs";
// Graduation shadow lab, pure logic (lib/gshadow.mjs, lib/pessimistic.mjs, lib/grad-config.mjs):
//   P2  an exit on PumpSwap is charged NO pump sell fee (the quote is net of the pool's fees);
//       curve exits are computed exactly as before;
//   P3  per-variant minFill / sl / holdSec, variant J = the live graduation config, A–I unchanged;
//   P1  the journal rows of the three kinds of exit (curve / amm / amm-unpriced).
//
// Fails without the fixes: lib/gshadow.mjs and lib/grad-config.mjs do not exist; the old cost model
// charges the pump sell fee on every exit; there is no variant J.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanEnv } from "./lib/test-env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;

// Pin every cost input: the expectations below are exact numbers.
process.env.CU_PRICE = "1500000";
process.env.CU_LIMIT = "300000";
process.env.SLIPPAGE_ASSUMED_BPS = "50";

const G = await import("../lib/gshadow.mjs");
const { pessimisticRoundTrip, SHADOW_COSTS_SCHEME } = await import("../lib/pessimistic.mjs");
const { roundTripCosts, txCostSol } = await import("../lib/fees.mjs");
const { readGradStrategy } = await import("../lib/grad-config.mjs");
const { calcBuyTokens } = await import("../lib/pumpfun.mjs");

const BUY = 0.02;
const TX = txCostSol(); // 0.000455
const SLIP_BPS = 54; // 50 assumed + 4 for a 0.02 SOL order

// ---------------------------------------------------------------------------------------------
// P2. Costs of an AMM exit
// ---------------------------------------------------------------------------------------------
{
  // solOut == BUY_SOL: the pool pays back exactly the buy size.
  const amm = pessimisticRoundTrip({ buySol: BUY, ratio: 1, delayMs: 500, exitVenue: "amm" });
  const buyFee = BUY * 0.01;
  const slip = (BUY * SLIP_BPS) / 10000 + (BUY * SLIP_BPS) / 10000;
  asrt(near(amm.feeSol, buyFee), `AMM exit: only the pump BUY fee (0.0002), got ${amm.feeSol}`);
  asrt(near(amm.netPnl, -(buyFee + slip + 2 * TX)), `AMM exit at solOut = buySol: net = -(pump buy fee + slip + tx x2), got ${amm.netPnl}`);
  asrt(amm.slipBps === SLIP_BPS && near(amm.txSol, 2 * TX), "buy side, slippage and the two network fees are as before");

  const curve = pessimisticRoundTrip({ buySol: BUY, ratio: 1, delayMs: 500 });
  asrt(near(curve.feeSol, 2 * buyFee), "curve exit: pump 1% in + 1% out, as before");
  asrt(near(curve.netPnl, -(2 * buyFee + slip + 2 * TX)), "curve exit: unchanged arithmetic");
  asrt(near(curve.netPnl - amm.netPnl, -buyFee), "the only difference is the pump sell fee");
  asrt(Math.round((curve.netPnl / BUY) * 10000) / 100 === -7.63, "curve flat round trip is still -7.63% (v3 number)");
  asrt(near(pessimisticRoundTrip({ buySol: BUY, ratio: 1, delayMs: 1, exitVenue: "curve" }).netPnl, curve.netPnl), 'exitVenue "curve" == the default');

  // roundTripCosts: sellFeeBps defaults to pumpFeeBps (no caller changes behaviour).
  const a = roundTripCosts({ buySol: BUY, ratio: 1.3 });
  const b = roundTripCosts({ buySol: BUY, ratio: 1.3, sellFeeBps: 100 });
  asrt(JSON.stringify(a) === JSON.stringify(b), "roundTripCosts without sellFeeBps is unchanged");
  asrt(near(roundTripCosts({ buySol: BUY, ratio: 1.3, sellFeeBps: 0 }).feeSol, BUY * 0.01), "sellFeeBps: 0 drops only the sell-side fee");
  asrt(SHADOW_COSTS_SCHEME.startsWith("v4-amm-exit"), `shadow scheme bumped, got ${SHADOW_COSTS_SCHEME}`);
}

// ---------------------------------------------------------------------------------------------
// P3. Variants: A–I exactly as before, J = the live config
// ---------------------------------------------------------------------------------------------
const live = readGradStrategy({ GRAD_MIN_FILL_PCT: "75", GRAD_MAX_FILL_PCT: "90", GRAD_MIN_HOLDERS: "5", GRAD_TAKE_PROFIT: "1.5", GRAD_STOP_LOSS: "0.7", GRAD_TIMEOUT_SEC: "300" });
const V = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live });
const AJ = "ABCDEFGHIJ"; // the variants that existed before revision 5 (K–N: scripts/gshadow-rev5.test.mjs)
{
  // The table the lab had before this change (minFill / sl / hold were lab-wide: 92 / SHADOW_SL / SHADOW_HOLD_SEC).
  const before = {
    A: { label: "baseline", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.5 },
    B: { label: "MIN_HOLDERS 7", minHolders: 7, maxFill: 100, exitCheck: false, tp: 1.5 },
    C: { label: "MIN_HOLDERS 15", minHolders: 15, maxFill: 100, exitCheck: false, tp: 1.5 },
    D: { label: "MAX_FILL 95", minHolders: 0, maxFill: 95, exitCheck: false, tp: 1.5 },
    E: { label: "MAX_FILL 97", minHolders: 0, maxFill: 97, exitCheck: false, tp: 1.5 },
    F: { label: "exit check >=0.9", minHolders: 0, maxFill: 100, exitCheck: true, tp: 1.5 },
    G: { label: "B+E+F", minHolders: 7, maxFill: 97, exitCheck: true, tp: 1.5 },
    H: { label: "TP 1.3", minHolders: 0, maxFill: 100, exitCheck: false, tp: 1.3 },
    I: { label: "enter after migration", postMigration: true, tp: 1.5 },
  };
  for (const [id, old] of Object.entries(before)) {
    for (const [k, val] of Object.entries(old)) asrt(V[id][k] === val, `variant ${id}.${k} unchanged (${val}), got ${V[id][k]}`);
    asrt(V[id].minFill === 92 && V[id].sl === 0.7 && V[id].holdSec === 300, `variant ${id} keeps the lab-wide minFill / SL / hold`);
    asrt(V[id].journalParams === undefined, `variant ${id} rows are not extended`);
  }
  // A different lab setting moves A–I and never J.
  const V2 = G.buildVariants({ minFill: 88, sl: 0.5, holdSec: 60, live });
  asrt(V2.A.minFill === 88 && V2.H.sl === 0.5 && V2.C.holdSec === 60, "A–I follow MIN_FILL / SHADOW_SL / SHADOW_HOLD_SEC");
  asrt(V2.J.minFill === 75 && V2.J.sl === 0.7 && V2.J.holdSec === 300, "J follows only the live config");

  asrt(JSON.stringify(G.variantParams(V.J)) === JSON.stringify({ minFill: 75, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300 }), `J = the live config, got ${JSON.stringify(G.variantParams(V.J))}`);
  asrt(V.J.label === "live config" && V.J.exitCheck === false && V.J.journalParams === true, "J: label, no extra RPC gate, rows carry params");
  // Revision 5 added K–N. The set these assertions were written for is A–J; SHADOW_VARIANTS pins it.
  asrt(G.activeVariantIds(V).join("") === "ABCDEFGHJKLMN", `active variants: A–H, J and K–N (I has no price source), got ${G.activeVariantIds(V).join("")}`);
  asrt(G.activeVariantIds(V, AJ).join("") === "ABCDEFGHJ", `SHADOW_VARIANTS=A–J: A–H and J (I has no price source), got ${G.activeVariantIds(V, AJ).join("")}`);
  asrt(G.candidateThreshold(V) === 75, "candidate threshold = the lowest minFill among active variants (75)");
  const Vd = G.buildVariants({ minFill: 92, sl: 0.7, holdSec: 300, live: readGradStrategy({}) });
  asrt(G.candidateThreshold(Vd, G.activeVariantIds(Vd, AJ)) === 92, "A–J with the default live config: the threshold stays 92");
  asrt(G.candidateThreshold(Vd) === 75, "with L (fill 75–90) active the threshold is L's 75 — still the lowest minFill of the active variants");

  // fill 80, 6 holders: only J. fill 93, 17 holders: A–H, not J (above its MAX_FILL 90).
  const accepts = (c) => G.activeVariantIds(V, AJ).filter((id) => G.variantAccepts(V[id], c)).join("");
  asrt(accepts({ fill: 80, holders: 6 }) === "J", `fill 80 / 6 holders opens only J, got "${accepts({ fill: 80, holders: 6 })}"`);
  asrt(accepts({ fill: 93, holders: 17 }) === "ABCDEFGH", `fill 93 / 17 holders opens A–H and not J, got "${accepts({ fill: 93, holders: 17 })}"`);
  asrt(accepts({ fill: 80, holders: 4 }) === "", "J respects its holder gate (5)");
  asrt(accepts({ fill: 96, holders: 3 }) === "AEFH", "above 95: D drops out; holder gates of B/C/G hold");
  asrt(accepts({ fill: 74.9, holders: 50 }) === "" && accepts({ fill: 90, holders: 5 }) === "J" && accepts({ fill: 90.1, holders: 5 }) === "", "J band edges: 75..90 inclusive");
  asrt(G.variantAccepts(V.I, { fill: 99, holders: 99 }) === false, "I never enters from the curve stream");
}
{
  // The env chain is the bot's: the short names win over GRAD_*; defaults are graduation.mjs's.
  const d = readGradStrategy({});
  asrt(JSON.stringify(d) === JSON.stringify({ minFillPct: 92, maxFillPct: 97, minHolders: 7, takeProfit: 1.5, stopLoss: 0.7, timeoutSec: 300 }), `defaults = graduation.mjs defaults, got ${JSON.stringify(d)}`);
  const c = readGradStrategy({ MIN_FILL: "80", GRAD_MIN_FILL_PCT: "75", MAX_FILL: "95", GRAD_MAX_FILL_PCT: "90", MIN_HOLDERS: "3", GRAD_MIN_HOLDERS: "5" });
  asrt(c.minFillPct === 80 && c.maxFillPct === 95 && c.minHolders === 3, "MIN_FILL / MAX_FILL / MIN_HOLDERS are read BEFORE the GRAD_* names");
  // graduation.mjs trades with the same reader (one source, no copy).
  const src = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  asrt(/const GRAD_STRATEGY = readGradStrategy\(\);/.test(src) && /const MIN_FILL_PCT = GRAD_STRATEGY\.minFillPct;/.test(src) && /const TIMEOUT_SEC = GRAD_STRATEGY\.timeoutSec;/.test(src), "graduation.mjs reads its band and exits through readGradStrategy");
  asrt(!/numOr\(process\.env\.MIN_FILL \|\| process\.env\.GRAD_MIN_FILL_PCT/.test(src), "graduation.mjs keeps no second copy of the env chain");
  const sh = fs.readFileSync(path.join(root, "bots", "graduation-sniper", "shadow.mjs"), "utf8");
  asrt(/buildVariants\(\{ minFill: MIN_FILL, sl: SL, holdSec: HOLD_SEC, live: readGradStrategy\(\), momentum: MOMENTUM \}\)/.test(sh), "shadow.mjs builds J from the same reader");
}

// exit rule order: tp, sl, timeout
asrt(G.exitReason({ ratio: 1.6, tp: 1.5, sl: 0.7, heldMs: 0, holdMs: 1000 }) === "tp", "tp");
asrt(G.exitReason({ ratio: 0.7, tp: 1.5, sl: 0.7, heldMs: 0, holdMs: 1000 }) === "sl", "sl (inclusive)");
asrt(G.exitReason({ ratio: 1.0, tp: 1.5, sl: 0.7, heldMs: 1000, holdMs: 1000 }) === "timeout", "timeout");
asrt(G.exitReason({ ratio: 1.0, tp: 1.5, sl: 0.7, heldMs: 999, holdMs: 1000 }) === null, "otherwise hold");
asrt(G.exitReason({ ratio: 1.0, tp: 1.5, sl: 0, heldMs: 0, holdMs: 1000 }) === null, "SL 0 never fires (as before)");

// ---------------------------------------------------------------------------------------------
// P1. Tokens of a paper position and the journal rows
// ---------------------------------------------------------------------------------------------
const reserves = { virtualSolReserves: 109_050_000_000n, virtualTokenReserves: 1_073_000_000_000_000n };
const tokens = G.ammEntryTokens(reserves, BUY);
{
  // The curve's constant product for the FULL buy size: the 1% pump fee is charged by the cost
  // model, so it must not be taken out of the tokens as well.
  asrt(tokens === (reserves.virtualTokenReserves * 20_000_000n) / (reserves.virtualSolReserves + 20_000_000n), "tokens = vTok * buy / (vSol + buy)");
  const feeNet = calcBuyTokens(reserves, BUY);
  asrt(tokens > feeNet && near(Number(feeNet) / Number(tokens), 0.99, 1e-4), "= calcBuyTokens without its 1% fee (about 1% more tokens)");
  asrt(G.ammEntryTokens(reserves, 0) === 0n && G.ammEntryTokens({ virtualSolReserves: 0n, virtualTokenReserves: 0n }, BUY) === 0n, "degenerate input -> 0");
  asrt(near(G.ammRatio(16_000_000n, BUY), 0.8), "ammRatio = solOut / buySol");
}
const pos = { variant: "J", mint: "MintJ", entryPrice: 1e-7, at: 1_000, tokens };
{
  const curve = G.tradeRow({ pos: { ...pos, variant: "A" }, v: V.A, reason: "timeout", venue: "curve", price: 1e-7, buySol: BUY, now: 301_000 });
  asrt(curve.exitVenue === "curve" && curve.migrated === false, "curve row: exitVenue curve, migrated false");
  asrt(curve.ratio === 1 && curve.netPct === -7.63 && curve.exitPrice === 1e-7 && curve.holdSec === 300, `curve row numbers as in v3 (${curve.netPct})`);
  asrt(curve.params === undefined && curve.costsScheme === SHADOW_COSTS_SCHEME, "A–I rows carry no params; the scheme is stamped");

  const amm = G.tradeRow({ pos, v: V.J, reason: "sl", venue: "amm", amm: { solOut: 12_000_000n, feeBps: 30, ageMs: 40 }, buySol: BUY, now: 61_000 });
  asrt(amm.exitVenue === "amm" && amm.migrated === true && amm.exitPrice === null, "amm row: exitVenue amm, migrated true, no curve price");
  asrt(amm.ratio === 0.6, `amm ratio = solOut / buySol (0.6), got ${amm.ratio}`);
  const exp = pessimisticRoundTrip({ buySol: BUY, ratio: 0.6, delayMs: 1, exitVenue: "amm" }).netPnl;
  asrt(near(amm.netSol, Math.round(exp * 1e9) / 1e9) && amm.netPct === Math.round((exp / BUY) * 10000) / 100, `amm net = cost model without the pump sell fee (${amm.netPct}%)`);
  asrt(amm.ammSolOut === 0.012 && amm.ammFeeBps === 30 && amm.ammQuoteAgeMs === 40 && amm.tokens === tokens.toString(), "amm row keeps the quote it was priced with");
  asrt(JSON.stringify(amm.params) === JSON.stringify({ minFill: 75, maxFill: 90, minHolders: 5, tp: 1.5, sl: 0.7, holdSec: 300 }), "J rows carry the parameters they were produced with");

  const un = G.tradeRow({ pos, v: V.J, reason: "timeout", venue: "amm-unpriced", buySol: BUY, now: 301_000 });
  asrt(un.exitVenue === "amm-unpriced" && un.migrated === true && un.unconfirmed === true, "unpriced row is flagged");
  asrt(un.netSol === null && un.netPct === null && un.ratio === null && un.exitPrice === null, "unpriced row has NO result (never the frozen curve price)");
  asrt(un.reason === "timeout" && un.holdSec === 300 && un.variant === "J" && un.params, "…but keeps what is known");

  // `extra` can add flags, never overwrite the accounting.
  const ex = G.tradeRow({ pos, v: V.J, reason: "manual stop", venue: "curve", price: 1e-7, buySol: BUY, now: 2_000, extra: { unconfirmed: true, netPct: 999, exitVenue: "x" } });
  asrt(ex.unconfirmed === true && ex.netPct === -7.63 && ex.exitVenue === "curve", "extra flags are merged without touching the numbers");

  const o = G.openRow({ variantId: "J", v: V.J, mint: "MintJ", fill: 80, holders: 6, spot: 1e-7, buySol: BUY, tokens });
  asrt(o.type === "gshadow_open" && o.tokens === tokens.toString() && o.slipBps === 54 && o.params.minFill === 75, "J open row: tokens + params");
  const oa = G.openRow({ variantId: "A", v: V.A, mint: "M", fill: 93, holders: 17, spot: 1e-7, buySol: BUY, tokens });
  asrt(oa.params === undefined && oa.label === "baseline" && oa.entryPrice === 1e-7 && oa.spot === 1e-7, "A open row as before (+tokens)");
}

// ---------------------------------------------------------------------------------------------
// The report: epochs are not mixed and unpriced rows are not averaged as 0%
// ---------------------------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gshadow-report-"));
  const file = path.join(dir, "j.jsonl");
  const V3 = "v3-single-slip: entry=curve spot, buy slip charged once in roundTripCosts";
  const row = (scheme, variant, mint, netPct, more = {}) => JSON.stringify({ ts: "2026-11-12T10:00:00.000Z", type: "gshadow_trade", costsScheme: scheme, variant, mint, netPct, reason: "timeout", ...more });
  fs.writeFileSync(file, [
    row(V3, "A", "M1", 10),
    row(V3, "A", "M2", -4),
    row(SHADOW_COSTS_SCHEME, "J", "M3", 6, { exitVenue: "curve", migrated: false }),
    row(SHADOW_COSTS_SCHEME, "J", "M4", -20, { exitVenue: "amm", migrated: true }),
    row(SHADOW_COSTS_SCHEME, "J", "M5", null, { exitVenue: "amm-unpriced", migrated: true, unconfirmed: true }),
    row(SHADOW_COSTS_SCHEME, "J", "M6", null, { exitVenue: "amm-unpriced", migrated: true, unconfirmed: true }),
  ].join("\n") + "\n");
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "analyze-graduation.mjs"), file], { cwd: root, encoding: "utf8", env: cleanEnv({}) });
  asrt(r.status === 0, `the report runs (stderr: ${String(r.stderr).split("\n")[0]})`);
  const out = r.stdout;
  asrt(/=== costsScheme: v3-single-slip[^\n]*— 2 trade\(s\) ===/.test(out), "v3 rows have their own table");
  asrt(/=== costsScheme: v4-amm-exit[^\n]*— 4 trade\(s\) ===/.test(out), "v4 rows have their own table (not mixed with v3)");
  asrt(/смешаны версии учёта \(2\)/.test(out), "the report says two schemes are present");
  const v4 = out.slice(out.indexOf("=== costsScheme: v4-amm-exit"));
  asrt(/exit venues: curve=1 amm=1 amm-unpriced=2/.test(v4), `the venue mix is printed: ${(v4.match(/exit venues:.*/) || [""])[0]}`);
  asrt(/UNPRICED: 2 of 4/.test(v4), `unpriced trades are counted separately: ${(v4.match(/UNPRICED.*/) || [""])[0]}`);
  const jRow = (v4.match(/^J\s+.*$/m) || [""])[0];
  asrt(/^J\s+2\s/.test(jRow), `J statistics use the 2 PRICED trades only, got "${jRow}"`);
  asrt(/-7\.00%/.test(jRow), `J mean is (6 - 20) / 2 = -7.00%, not diluted by unpriced rows as 0% (got "${jRow}")`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ variants: G.activeVariantIds(V).join(""), threshold: G.candidateThreshold(V), scheme: SHADOW_COSTS_SCHEME.slice(0, 11) }));
console.log("PASS: shadow variants (A–I unchanged, J = live config), AMM exit costs without pump sell fee, journal rows, report");
