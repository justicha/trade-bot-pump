// Rebuilding the bonding curve from an anchor + trade amounts, instead of trusting the snapshot
// inside each trade event.
//
// Why: the trade event carries its own (vSol, vTok) snapshot, but for one class of calls the SOL
// side of that snapshot is not the same curve point as the token side (scripts/diag-390.mjs:
// token delta == trade amount in 99.6% of pairs, SOL delta 84-165x the trade amount in 100%).
// A state carried forward from an authoritative anchor and advanced by the amounts does not
// depend on that field at all, so it can be compared against the snapshot as an independent
// cross-check — and, when the error is small, used as the price source.
//
// Model (the protocol's own arithmetic, per trade):
//   buy : vSol += solAmount ; vTok -= tokenAmount
//   sell: vSol -= solAmount ; vTok += tokenAmount
// The fee is taken inside solAmount, so nothing else is subtracted here. scripts/rebuild-report.mjs
// measures both ratios (dvSol/solAmount, dvTok/tokenAmount) on "good" payload classes and prints
// them, so this convention is checked rather than assumed.
import { LAUNCH_RESERVES } from "./events.mjs";

const ppm = (a, b) => {
  if (!a || !b || a <= 0n || b <= 0n) return null;
  const d = a > b ? a - b : b - a;
  return Number((d * 1_000_000n) / a);
};

export class CurveRebuild {
  constructor({ reanchorOnLargeErrorPpm = 50_000 } = {}) {
    this.state = new Map(); // mint -> { vSol: BigInt, vTok: BigInt, source, ts, trades }
    this.reanchorOnLargeErrorPpm = reanchorOnLargeErrorPpm;
    this.stats = { seedsCreate: 0, seedsAccount: 0, seedsSnapshot: 0, reanchors: 0, applied: 0, skipped: 0 };
  }

  has(mint) {
    return this.state.has(mint);
  }

  seed(mint, { vSol, vTok, ts = null, source = "snapshot" }) {
    const a = BigInt(vSol);
    const b = BigInt(vTok);
    if (a <= 0n || b <= 0n) return null;
    const rec = { vSol: a, vTok: b, source, ts, trades: 0 };
    this.state.set(mint, rec);
    if (source === "create") this.stats.seedsCreate += 1;
    else if (source === "account") this.stats.seedsAccount += 1;
    else this.stats.seedsSnapshot += 1;
    return rec;
  }

  // The create event carries the documented launch reserves, so it is a free anchor at t0.
  seedFromCreate(mint, { ts = null } = {}) {
    return this.seed(mint, { vSol: LAUNCH_RESERVES.vSol, vTok: LAUNCH_RESERVES.vTok, ts, source: "create" });
  }

  seedFromAccount(mint, { virtualSolReserves, virtualTokenReserves, ts = null }) {
    return this.seed(mint, { vSol: virtualSolReserves, vTok: virtualTokenReserves, ts, source: "account" });
  }

  stateOf(mint) {
    return this.state.get(mint) || null;
  }

  // SOL per whole token, or null when the mint has no anchor yet.
  priceOf(mint) {
    const s = this.state.get(mint);
    if (!s) return null;
    return Number(s.vSol) / 1e9 / (Number(s.vTok) / 1e6);
  }

  // Advance the model by one trade. Returns the new state (or null without an anchor).
  apply(mint, { isBuy, solAmount, tokenAmount, ts = null }) {
    const s = this.state.get(mint);
    if (!s) {
      this.stats.skipped += 1;
      return null;
    }
    const dSol = BigInt(Math.round(Number(solAmount) * 1e9));
    const dTok = BigInt(Math.round(Number(tokenAmount) * 1e6));
    if (isBuy) {
      s.vSol += dSol;
      s.vTok = s.vTok > dTok ? s.vTok - dTok : 0n;
    } else {
      s.vSol = s.vSol > dSol ? s.vSol - dSol : 0n;
      s.vTok += dTok;
    }
    s.trades += 1;
    s.ts = ts ?? s.ts;
    this.stats.applied += 1;
    return s;
  }

  // Compare the model with an event snapshot. `predicted` must be the state AFTER applying the
  // event's own trade, because the snapshot in the payload is the post-trade state.
  // Returns { errKPpm, errPricePpm, unexplainedSol, reanchored }.
  compare(mint, snapshot) {
    const s = this.state.get(mint);
    if (!s || !snapshot) return null;
    const vSol = BigInt(snapshot.vSol);
    const vTok = BigInt(snapshot.vTok);
    if (vSol <= 0n || vTok <= 0n) return null;
    const errKPpm = ppm(s.vSol * s.vTok, vSol * vTok);
    const modelPrice = Number(s.vSol) / Number(s.vTok);
    const snapPrice = Number(vSol) / Number(vTok);
    const errPricePpm = snapPrice > 0 ? Math.round(Math.abs(modelPrice / snapPrice - 1) * 1e6) : null;
    const unexplainedSol = Number(vSol - s.vSol) / 1e9; // SOL the snapshot moved that the trades do not explain
    let reanchored = false;
    if (errKPpm !== null && errKPpm > this.reanchorOnLargeErrorPpm) {
      // The model has drifted away from reality (an unmodelled SOL flow, e.g. a fee collection):
      // take the snapshot as the new anchor instead of letting the error grow forever.
      s.vSol = vSol;
      s.vTok = vTok;
      s.source = "reanchor";
      this.stats.reanchors += 1;
      reanchored = true;
    }
    return { errKPpm, errPricePpm, unexplainedSol, reanchored };
  }
}
