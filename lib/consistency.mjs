// Curve consistency: the constant-product invariant (x*y = k) as a runtime guard.
//
// Measured on live data (scripts/diag-390.mjs, scripts/verify-invariants.mjs): payloads of length
// 403/405/425/439 keep k exactly constant between consecutive events of the same mint (0 ppm
// drift), while 390/391 jump by tens of percent even though the token delta equals the trade
// amount byte for byte — i.e. the sol-reserve field in those snapshots does not belong to the
// same curve point. Numbers: data/research/diag390.json.
//
// Two independent ways to accept a snapshot, and why both exist:
//   1. k matches the anchor for this mint. The anchor comes from getAccountInfo at the mint's
//      first appearance (authoritative) or from the last accepted snapshot.
//   2. the snapshot satisfies the intra-event identities: virtual_sol - real_sol and
//      virtual_token - real_token are curve constants (30 SOL / 279.9M tokens), so a single
//      event can be validated without waiting for a neighbour event.
// A snapshot that satisfies neither is treated as "no price": the caller keeps its last value
// instead of trading on a number that is off by 45%.
export const DEFAULT_TOLERANCE_PPM = 100; // 0.01%

// pump.fun launch parameters: virtual 30 SOL vs 0 real, virtual 1.073B vs 793.1M real tokens.
export const CURVE_SPREAD = {
  sol: 30_000_000_000n,
  tok: 279_900_000_000_000n,
  tolerance: 0.01, // 1% — fees/rounding must not flip the verdict
};

export class CurveConsistency {
  constructor({ tolerancePpm = DEFAULT_TOLERANCE_PPM, spread = CURVE_SPREAD } = {}) {
    this.tolerancePpm = Math.max(1, Number(tolerancePpm) || DEFAULT_TOLERANCE_PPM);
    this.spread = spread;
    this.kByMint = new Map();
    this.source = new Map(); // mint -> "account" | "snapshot" (where the anchor came from)
  }

  // Authoritative anchor: k read from the curve account at minContextSlot = the event's slot.
  anchor(mint, vSol, vTok, source = "account") {
    const a = BigInt(vSol);
    const b = BigInt(vTok);
    if (a <= 0n || b <= 0n) return false;
    this.kByMint.set(mint, a * b);
    this.source.set(mint, source);
    return true;
  }

  has(mint) {
    return this.kByMint.has(mint);
  }

  // Does a single payload satisfy virtual - real == curve constant on both reserves?
  identity({ vSol, vTok, rSol, rTok } = {}) {
    if (rSol === null || rTok === null || rSol === undefined || rTok === undefined) {
      return { ok: false, reason: "no real reserves in this payload" };
    }
    const t = this.spread.tolerance;
    const dSol = BigInt(vSol) - BigInt(rSol);
    const dTok = BigInt(vTok) - BigInt(rTok);
    const solDiff = dSol > this.spread.sol ? dSol - this.spread.sol : this.spread.sol - dSol;
    const tokDiff = dTok > this.spread.tok ? dTok - this.spread.tok : this.spread.tok - dTok;
    const solOk = Number(solDiff) / Number(this.spread.sol) <= t;
    const tokOk = Number(tokDiff) / Number(this.spread.tok) <= t;
    return { ok: solOk && tokOk, solOk, tokOk, dSol: String(dSol), dTok: String(dTok) };
  }

  // Full gate for one parsed snapshot.
  // Returns { ok, reason, driftPpm, k, via } — `via` says which test accepted it.
  checkSnapshot(mint, { vSol, vTok, rSol = null, rTok = null } = {}) {
    const a = BigInt(vSol);
    const b = BigInt(vTok);
    if (a <= 0n || b <= 0n) return { ok: false, driftPpm: null, k: null, via: null, reason: "zero reserve" };

    const ident = this.identity({ vSol, vTok, rSol, rTok });
    const k = a * b;
    const prev = this.kByMint.get(mint);

    if (!prev) {
      // No anchor yet: accept only if the payload proves itself.
      if (ident.ok) {
        this.anchor(mint, vSol, vTok, "snapshot");
        return { ok: true, driftPpm: 0, k, via: "identity", reason: null, identity: ident };
      }
      return {
        ok: false,
        driftPpm: null,
        k,
        via: null,
        reason: `no anchor and no identity (${ident.reason || "spread mismatch"})`,
        identity: ident,
      };
    }

    const diff = k > prev ? k - prev : prev - k;
    const driftPpm = Number((diff * 1_000_000n) / prev);
    if (driftPpm <= this.tolerancePpm) return { ok: true, driftPpm, k, via: "k", reason: null, identity: ident };

    if (ident.ok) {
      // The payload proves itself: re-anchor instead of rejecting a valid curve point.
      this.anchor(mint, vSol, vTok, "snapshot");
      return { ok: true, driftPpm, k, via: "identity-reanchor", reason: null, identity: ident };
    }

    return {
      ok: false,
      driftPpm,
      k,
      via: null,
      reason: `k drift ${driftPpm}ppm > ${this.tolerancePpm}ppm and no identity`,
      identity: ident,
    };
  }

  // Kept for callers that only have the reserves (bots, tests).
  check(mint, vSol, vTok) {
    const a = BigInt(vSol);
    const b = BigInt(vTok);
    if (a <= 0n || b <= 0n) return { ok: false, driftPpm: null, k: null, reason: "zero reserve" };
    const k = a * b;
    const prev = this.kByMint.get(mint);
    if (!prev) {
      this.anchor(mint, vSol, vTok, "snapshot");
      return { ok: true, driftPpm: 0, k };
    }
    const diff = k > prev ? k - prev : prev - k;
    const driftPpm = Number((diff * 1_000_000n) / prev);
    if (driftPpm <= this.tolerancePpm) return { ok: true, driftPpm, k };
    this.anchor(mint, vSol, vTok, "snapshot");
    return { ok: false, driftPpm, k, reason: `k drift ${driftPpm}ppm > ${this.tolerancePpm}ppm` };
  }

  forget(mint) {
    this.source.delete(mint);
    return this.kByMint.delete(mint);
  }

  get size() {
    return this.kByMint.size;
  }
}
