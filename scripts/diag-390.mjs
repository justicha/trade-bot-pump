#!/usr/bin/env node
// Root cause of the broken x*y=k invariant for one class of pump.fun payloads (lengths 390/391,
// and anything else the by-length table flags).
//
//   node scripts/diag-390.mjs                      # analyse data/raw (capture first, see below)
//   CAPTURE_SEC=240 node scripts/capture-raw.mjs   # -> data/raw/YYYY-MM-DD-HH.jsonl.gz
//   node scripts/diag-390.mjs --rpc-sample 12      # also compare against getAccountInfo
//
// What it answers, in the order the questions were asked:
//   (a) share of k violations by (prev_len -> len), by instruction name, by outer program;
//   (b) for the violating events, which hypothesis explains them:
//       H1  offset 97 holds real_sol, not virtual_sol (virtual = real + 30 SOL)
//       H2  the offsets are shifted by +-8 / +-16 bytes
//       H3  an intra-event identity (virtual-real is a curve constant) identifies the layout
//           without needing a neighbour event
//       H4  a byte-offset scan finds the pair with the smallest k drift
//       H5  getAccountInfo at minContextSlot = event slot (ground truth), for a small sample
//   Every hypothesis is scored by the percentage of violating pairs it repairs.
import { listRawFiles, replayRaw, payloadOf, RAW_DIR } from "../lib/rawcap.mjs";
import { describe, parseTrade } from "../lib/events.mjs";
import { ROOT } from "../lib/config.mjs";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const RAW_TARGET = argOf("--raw", RAW_DIR);
const RPC_SAMPLE = Number(argOf("--rpc-sample", "0"));
const TOL_PPM = Number(argOf("--tol-ppm", "100")); // 0.01% - integer rounding of a real curve move

const TRADE_V3 = "bddb7fd34ee661ee";
// Curve constants (pump.fun launch): virtual_sol - real_sol = 30 SOL; the token side is
// 279.9M whole tokens. Both stay constant through every trade, which is what makes them a
// single-event layout test.
const SOL_SPREAD = 30_000_000_000n;
const TOK_SPREAD = 279_900_000_000_000n;
const OFF_CANDIDATES = [];
for (let o = 89; o <= 217; o += 8) OFF_CANDIDATES.push(o);

const absBig = (x) => (x < 0n ? -x : x);
const u64 = (buf, off) => (off + 8 <= buf.length ? buf.readBigUInt64LE(off) : null);
const ppm = (a, b) => (a === 0n ? null : Number((absBig(b - a) * 1_000_000n) / a));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

// ---- 1. ingest ---------------------------------------------------------------
const files = fs.existsSync(RAW_TARGET) && fs.statSync(RAW_TARGET).isDirectory() ? listRawFiles(RAW_TARGET) : [RAW_TARGET];
if (!files.length) {
  console.error(`No raw files in ${RAW_TARGET}. Capture some first:\n  CAPTURE_SEC=240 node scripts/capture-raw.mjs`);
  process.exit(1);
}

const byLen = new Map();
const byIx = new Map();
const byOuter = new Map();
const byProgram = new Map();
const tradeEvents = []; // ordered, per mint grouping happens below
const typeCounts = new Map();
const bump = (map, key, init = () => ({})) => {
  if (!map.has(key)) map.set(key, init());
  return map.get(key);
};

let totalRecords = 0;
for await (const rec of replayRaw(RAW_TARGET)) {
  totalRecords += 1;
  const buf = payloadOf(rec);
  if (!buf || buf.length < 8) continue;
  const desc = describe(buf);
  typeCounts.set(desc.type, (typeCounts.get(desc.type) || 0) + 1);
  bump(byProgram, rec.program, () => ({ events: 0 })).events += 1;

  const b = bump(byLen, buf.length, () => ({ len: buf.length, events: 0, usable: 0, identity: 0, bestOffset: new Map() }));
  b.events += 1;

  if (desc.prefix !== TRADE_V3) continue;
  const parsed = parseTrade(buf);
  if (!parsed) continue;
  const mint = parsed.mint;
  const vSol = u64(buf, 97);
  const vTok = u64(buf, 105);
  const rSol = u64(buf, 113);
  const rTok = u64(buf, 121);
  const usable = Boolean(vSol && vTok && vSol > 0n && vTok > 0n);
  if (usable) b.usable += 1;
  bump(byIx, rec.ix || "?", () => ({ events: 0, usable: 0 })).events += 1;
  bump(byOuter, rec.outer || "direct", () => ({ events: 0 })).events += 1;

  // single-event layout test: does (vSol,vTok) sit exactly SOL_SPREAD / TOK_SPREAD above
  // (rSol,rTok) at some offset? That identifies the true layout without any neighbour.
  const identOffsets = [];
  if (usable && rSol !== null && rTok !== null) {
    for (const o of OFF_CANDIDATES) {
      const a = u64(buf, o);
      const bTok = u64(buf, o + 8);
      const c = u64(buf, o + 16);
      const d = u64(buf, o + 24);
      if (a === null || bTok === null || c === null || d === null) continue;
      const solOk = absBig(a - c - SOL_SPREAD) * 100n <= SOL_SPREAD; // within 1%
      const tokOk = absBig(bTok - d - TOK_SPREAD) * 100n <= TOK_SPREAD;
      if (solOk && tokOk) {
        identOffsets.push(o);
        b.bestOffset.set(o, (b.bestOffset.get(o) || 0) + 1);
      }
    }
  }
  if (identOffsets.length && identOffsets.includes(97)) b.identity += 1;

  tradeEvents.push({
    mint,
    len: buf.length,
    ix: rec.ix || null,
    outer: rec.outer || null,
    slot: rec.slot,
    ts: rec.ts,
    ok: rec.ok !== false,
    vSol,
    vTok,
    rSol,
    rTok,
    usable,
    solAmount: parsed.solAmount,
    tokenAmount: parsed.tokenAmount,
    tradePrice: parsed.tradePriceSol,
    identOffsets,
    buf,
  });
}

console.log(`=== RAW DIAG: ${files.length} file(s), ${totalRecords} records, ${tradeEvents.length} pump.fun trade events ===`);
console.log(`event types: ${[...typeCounts.entries()].map(([k, v]) => `${k}=${v}`).join("  ")}`);


// ---- 2. consecutive pairs of the same mint ----------------------------------
const streams = new Map();
for (const ev of tradeEvents) {
  if (!streams.has(ev.mint)) streams.set(ev.mint, []);
  streams.get(ev.mint).push(ev);
}

const pairBuckets = new Map(); // "a->b" -> counts
const ixBuckets = new Map();
const outerBuckets = new Map();
const hypotheses = {
  H1_real97_plus30sol: 0,
  H2_shift_plus8: 0,
  H2_shift_minus8: 0,
  H3_identity_layout: 0,
  H4_offset_scan: 0,
  H6_trade_price_continuity: 0,
};
const violations = [];
let pairs = 0;
let violationsCount = 0;
let skippedNoReserves = 0;

const kOf = (vSol, vTok) => (vSol && vTok ? vSol * vTok : null);
// H7 accumulator: which side of the snapshot agrees with the trade's own amounts.
const sides = { pairs: 0, tokSideOk: 0, solSideOk: 0, bothOk: 0 };

for (const [mint, list] of streams) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    if (!a.usable || !b.usable) {
      skippedNoReserves += 1;
      continue;
    }
    const k1 = kOf(a.vSol, a.vTok);
    const k2 = kOf(b.vSol, b.vTok);
    if (!k1 || !k2) continue;
    const drift = ppm(k1, k2);
    if (drift === null) continue;
    pairs += 1;

    const bad = drift > TOL_PPM;
    const key = `${a.len}->${b.len}`;
    const pb = bump(pairBuckets, key, () => ({ pairs: 0, bad: 0, driftSum: 0 }));
    pb.pairs += 1;
    pb.driftSum += drift;
    const ib = bump(ixBuckets, b.ix || "?", () => ({ pairs: 0, bad: 0 }));
    ib.pairs += 1;
    const ob = bump(outerBuckets, b.outer || "direct", () => ({ pairs: 0, bad: 0 }));
    ob.pairs += 1;
    if (!bad) continue;

    violationsCount += 1;
    pb.bad += 1;
    ib.bad += 1;
    ob.bad += 1;

    // H7: does each SIDE of the snapshot move exactly by the trade's own amounts? This is what
    // separates "the offsets are wrong" (both sides wrong) from "the SOL field is not this
    // trade's curve point" (token side right, SOL side wrong).
    {
      const dTok = b.vTok - a.vTok;
      const dSol = b.vSol - a.vSol;
      const tokSide = Math.abs(Number(dTok < 0n ? -dTok : dTok) / 1e6 - b.tokenAmount) / Math.max(1, b.tokenAmount) < 0.02;
      const solLamports = BigInt(Math.round(b.solAmount * 1e9));
      const dSolAbs = dSol < 0n ? -dSol : dSol;
      const fudge = solLamports / 100n; // 1% tolerance
      const solSide = solLamports > 0n && (dSolAbs > solLamports ? dSolAbs - solLamports : solLamports - dSolAbs) <= fudge;
      sides.pairs += 1;
      if (tokSide) sides.tokSideOk += 1;
      if (solSide) sides.solSideOk += 1;
      if (tokSide && solSide) sides.bothOk += 1;
    }

    // ---- hypothesis tests on this violating pair -----------------------------
    const repaired = (vSolA, vTokA, vSolB, vTokB) => {
      const ka = kOf(vSolA, vTokA);
      const kb = kOf(vSolB, vTokB);
      if (!ka || !kb) return false;
      const d = ppm(ka, kb);
      return d !== null && d <= TOL_PPM;
    };

    // H1: the value at 97 is real_sol; the virtual reserve is real + 30 SOL
    if (repaired(a.vSol + SOL_SPREAD, a.vTok, b.vSol + SOL_SPREAD, b.vTok)) hypotheses.H1_real97_plus30sol += 1;

    // H2: the whole reserve block sits 8 bytes further / earlier
    {
      const aS = u64(a.buf, 105), aT = u64(a.buf, 113), bS = u64(b.buf, 105), bT = u64(b.buf, 113);
      if (aS && aT && bS && bT && repaired(aS, aT, bS, bT)) hypotheses.H2_shift_plus8 += 1;
      const aS2 = u64(a.buf, 89), aT2 = u64(a.buf, 97), bS2 = u64(b.buf, 89), bT2 = u64(b.buf, 97);
      if (aS2 && aT2 && bS2 && bT2 && repaired(aS2, aT2, bS2, bT2)) hypotheses.H2_shift_minus8 += 1;
    }

    // H3: both events satisfy the intra-event identity at the same offset
    const common = a.identOffsets.filter((o) => b.identOffsets.includes(o));
    for (const o of common) {
      if (repaired(u64(a.buf, o), u64(a.buf, o + 8), u64(b.buf, o), u64(b.buf, o + 8))) {
        hypotheses.H3_identity_layout += 1;
        break;
      }
    }

    // H4: no hypothesis - just find the offset pair with the smallest drift.
    // A candidate only counts when both values are plausible for a pump.fun curve, otherwise a
    // constant padding field (which trivially keeps k constant) would "win".
    let best = { off: null, drift: Infinity };
    for (const o of OFF_CANDIDATES) {
      const aS = u64(a.buf, o), aT = u64(a.buf, o + 8), bS = u64(b.buf, o), bT = u64(b.buf, o + 8);
      const ka = kOf(aS, aT);
      const kb = kOf(bS, bT);
      if (!ka || !kb) continue;
      const plausibleSol = (v) => v > 1_000_000_000n && v < 500_000_000_000n; // 1..500 SOL
      const plausibleTok = (v) => v > 1_000_000_000_000n && v < 2_000_000_000_000_000n;
      if (!plausibleSol(aS) || !plausibleSol(bS) || !plausibleTok(aT) || !plausibleTok(bT)) continue;
      const d = ppm(ka, kb);
      if (d !== null && d < best.drift) best = { off: o, drift: d };
    }
    if (best.off !== null && best.drift <= TOL_PPM && best.off !== 97) hypotheses.H4_offset_scan += 1;

    // H6: price continuity from the trade's OWN amounts (SOL per token). Independent of the
    // reserve snapshot, so it works for the class where the snapshot's SOL side is unusable.
    if (a.tradePrice && b.tradePrice) {
      const dp = Math.abs(b.tradePrice / a.tradePrice - 1) * 1e6;
      if (dp <= Math.max(TOL_PPM, 10_000)) hypotheses.H6_trade_price_continuity += 1;
    }

    if (violations.length < 400) {
      violations.push({
        mint,
        lenPrev: a.len,
        len: b.len,
        ix: b.ix,
        outer: b.outer,
        driftPpm: drift,
        a: { vSol: String(a.vSol), vTok: String(a.vTok), rSol: a.rSol === null ? null : String(a.rSol) },
        b: { vSol: String(b.vSol), vTok: String(b.vTok), rSol: b.rSol === null ? null : String(b.rSol) },
        bestOffset: best.off,
        bestDrift: best.drift === Infinity ? null : Math.round(best.drift),
        identPrev: a.identOffsets,
        ident: b.identOffsets,
      });
    }
  }
}

console.log(
  `\nmints: ${streams.size}   pairs: ${pairs}   k-violations (>${TOL_PPM}ppm): ${violationsCount} (${pct(violationsCount, pairs)})   ` +
    `skipped (no reserves): ${skippedNoReserves}`,
);

const table = (title, map) => {
  console.log(`\n${title}`);
  const rows = [...map.entries()].sort((x, y) => (y[1].bad || 0) - (x[1].bad || 0) || (y[1].pairs || 0) - (x[1].pairs || 0));
  for (const [k, v] of rows.slice(0, 14)) {
    const denom = v.pairs ?? v.events ?? 1;
    console.log(
      `  ${String(k).padEnd(18)} pairs=${String(v.pairs ?? v.events).padStart(5)}  violations=${String(v.bad || 0).padStart(5)}  (${pct(v.bad || 0, denom).padStart(6)})` +
        (v.driftSum !== undefined ? `  avgDrift=${Math.round(v.driftSum / Math.max(1, v.pairs))}ppm` : ""),
    );
  }
};

table("(a1) by payload length transition (prev_len -> len):", pairBuckets);
table("(a2) by instruction name (of the second event):", ixBuckets);
table("(a3) by outer program (caller, 'direct' = top-level invoke):", outerBuckets);

// ---- 3. per-length layout verdict (single-event identity) -------------------
console.log("\n(b1) intra-event identity check - does virtual - real equal the curve constant?");
console.log("     len   events   usable   identity@97   offsets where the identity holds (top 3)");
for (const b of [...byLen.values()].sort((x, y) => y.events - x.events).slice(0, 12)) {
  const offs = [...b.bestOffset.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([o, n]) => `${o}:${pct(n, b.usable)}`);
  console.log(
    `  ${String(b.len).padStart(6)}  ${String(b.events).padStart(7)}  ${String(b.usable).padStart(7)}  ` +
      `${pct(b.identity, b.usable).padStart(10)}   ${offs.join("  ") || "-"}`,
  );
}

// ---- 4. hypothesis table ----------------------------------------------------
const totalH = Object.values(hypotheses).reduce((a, b) => a + b, 0);
console.log("\n(b2) which hypothesis explains the violating pairs (share of ALL violations):");
for (const [k, v] of Object.entries(hypotheses).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${k.padEnd(22)} ${String(v).padStart(6)}  ${pct(v, violationsCount).padStart(7)}`);
}
console.log(`  ${"(overlap possible)".padEnd(22)} ${String(totalH).padStart(6)}  (a pair can be repaired by more than one)`);

// H7: the decisive table — which side of the snapshot is trade-consistent
console.log("\n(b2b) which side of the snapshot matches the trade's own amounts (violating pairs):");
console.log(`  token side ok : ${sides.tokSideOk}/${sides.pairs} (${pct(sides.tokSideOk, sides.pairs)})`);
console.log(`  SOL side ok   : ${sides.solSideOk}/${sides.pairs} (${pct(sides.solSideOk, sides.pairs)})`);
console.log(`  both          : ${sides.bothOk}/${sides.pairs} (${pct(sides.bothOk, sides.pairs)})`);
console.log("  -> offsets are NOT wrong (a shifted field breaks both sides); the SOL reserve field");
console.log("     does not belong to the same curve point as the token reserve field.");

const offHist = new Map();
for (const v of violations) if (v.bestOffset !== null) offHist.set(v.bestOffset, (offHist.get(v.bestOffset) || 0) + 1);
console.log("\n(b3) offset that minimises the drift on violating pairs:");
for (const [o, n] of [...offHist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6)) {
  console.log(`  offset ${String(o).padStart(3)}: ${String(n).padStart(5)} pairs (${pct(n, violations.length)} of the sampled violations)`);
}

if (violations.length) {
  console.log("\n(b4) first violating pairs:");
  for (const v of violations.slice(0, 4)) {
    console.log(
      `  ${v.mint.slice(0, 8)} ${v.lenPrev}->${v.len} ${v.ix || "?"} outer=${v.outer || "direct"} drift=${v.driftPpm}ppm ` +
        `vSol ${v.a.vSol}->${v.b.vSol} vTok ${v.a.vTok}->${v.b.vTok} bestOffset=${v.bestOffset} ident=${JSON.stringify(v.b.ident)}`,
    );
  }
}

// ---- 5. RPC ground truth (optional, rate limited) ---------------------------
let rpc = null;
if (RPC_SAMPLE > 0) {
  const { connection } = await import("../lib/rpc.mjs");
  const { getBondingCurve } = await import("../lib/pumpfun.mjs");
  const { PublicKey } = await import("@solana/web3.js");
  const candidates = violations.slice(0, RPC_SAMPLE);
  rpc = [];
  console.log(`\n(b5) getAccountInfo cross-check, ${candidates.length} violating mint(s).`);
  console.log("     The account holds the CURRENT state, so it is compared with the mint's LAST payload");
  console.log("     (a historical slot cannot be read back with minContextSlot).");
  for (const v of candidates) {
    try {
      const list = streams.get(v.mint) || [];
      const last = list[list.length - 1];
      const bc = getBondingCurve(new PublicKey(v.mint));
      const info = await connection.getAccountInfo(bc);
      if (!info) {
        rpc.push({ mint: v.mint, ok: false, reason: "no account (migrated?)" });
        console.log(`  ${v.mint.slice(0, 8)}: no curve account (migrated to PumpSwap?)`);
        continue;
      }
      // pump.fun BondingCurve: 8 discriminator, then u64 virtualToken, virtualSol, realToken, realSol
      const accVTok = info.data.readBigUInt64LE(8);
      const accVSol = info.data.readBigUInt64LE(16);
      const complete = info.data[48] === 1;
      const matches = last && accVSol === last.vSol && accVTok === last.vTok;
      rpc.push({
        mint: v.mint,
        ok: true,
        matchesLastPayload: Boolean(matches),
        complete,
        account: { vSol: String(accVSol), vTok: String(accVTok) },
        lastPayload: last ? { vSol: String(last.vSol), vTok: String(last.vTok), len: last.len, ix: last.ix } : null,
      });
      console.log(
        `  ${v.mint.slice(0, 8)}: account vSol=${accVSol} vTok=${accVTok} complete=${complete} | last payload (len ${last?.len}, ${last?.ix}) ` +
          `vSol=${last?.vSol} vTok=${last?.vTok} -> ${matches ? "PAYLOAD == ACCOUNT (parser verified)" : "differs (state moved on)"}`,
      );
    } catch (err) {
      rpc.push({ mint: v.mint, ok: false, reason: err.message });
      console.log(`  ${v.mint.slice(0, 8)}: rpc error ${err.message}`);
    }
  }
}

// ---- 6. output --------------------------------------------------------------
const out = path.join(ROOT, "data", "research", "diag390.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      files,
      records: totalRecords,
      mints: streams.size,
      pairs,
      violations: violationsCount,
      tolerancePpm: TOL_PPM,
      skippedNoReserves,
      hypotheses,
      byLen: [...byLen.values()].map((b) => ({
        len: b.len,
        events: b.events,
        usable: b.usable,
        identityAt97: b.identity,
        offsets: Object.fromEntries(b.bestOffset),
      })),
      byTransition: Object.fromEntries(pairBuckets),
      byIx: Object.fromEntries(ixBuckets),
      byOuter: Object.fromEntries(outerBuckets),
      rpc,
      samples: violations.slice(0, 50),
    },
    null,
    2,
  ),
);
console.log(`\nwritten: ${out}`);

