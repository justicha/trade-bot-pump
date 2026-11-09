// Holder gate for brand-new tokens — and the feature source for the research lab.
//
// A freshly created pump.fun token with 2-3 holders is almost always the dev plus his own
// wallets — the classic soft rug. This tracker counts DISTINCT wallets with a POSITIVE net
// token delta (bought − sold) seen in the live trade stream.
//
// BUGFIX: prune() used to report the CURRENT holder count at drop time, so a mint that had
// already reached the threshold (but could not be bought because all slots were busy or the
// cooldown was active) got logged as "6 holders < 4" — a contradiction between the counter and
// the filter. The tracker now remembers WHEN it became ready (readyAt / holdersAtReady) and why
// the entry was blocked, so the log and the counters always agree.
//
// Organic vs bundled: a bundle buys many wallets in the SAME slot right after the create. That
// is one actor, not a crowd, so the tracker also records distinct buy slots and the delay since
// the create, and `organic()` requires several slots plus a minimum delay.
const EPS = 1e-9; // token amounts are floats after the 1e6 division

export class HolderTracker {
  // minHolders: 0 disables the gate (track() then always returns false).
  // waitMs: how long a mint may stay in the "waiting" set before prune() drops it.
  // minSlots: distinct buy slots required by organic() (1 slot = a bundle of one actor).
  // minDelayMs: a mint that gathers its holders faster than this is treated as instant/atomic.
  constructor({ minHolders = 0, waitMs = 45_000, minSlots = 2, minDelayMs = 2500 } = {}) {
    const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
    this.minHolders = Math.max(0, Math.floor(num(minHolders, 0)));
    this.waitMs = Math.max(1000, num(waitMs, 45_000));
    this.minSlots = Math.max(1, Math.floor(num(minSlots, 2)));
    this.minDelayMs = Math.max(0, num(minDelayMs, 2500)); // 0 = no delay requirement
    this.pending = new Map();
  }

  get enabled() {
    return this.minHolders > 0;
  }

  get size() {
    return this.pending.size;
  }

  // Start watching a mint. Returns false when the gate is off or the mint is already watched.
  track(mint, { at = Date.now(), slot = null, creator = null } = {}) {
    if (!this.enabled || !mint || this.pending.has(mint)) return false;
    this.pending.set(mint, {
      mint,
      at,
      createSlot: slot,
      creator,
      balances: new Map(), // user -> net tokens
      firstBuy: new Map(), // user -> { ts, slot } first positive delta
      slots: new Set(), // distinct slots with a positive delta
      readyAt: null,
      holdersAtReady: null,
      blocked: null, // why a ready mint still was not bought
      maxHolders: 0,
    });
    return true;
  }

  watching(mint) {
    return this.pending.has(mint);
  }

  // Distinct wallets currently holding a positive balance.
  holders(mint) {
    const p = this.pending.get(mint);
    if (!p) return 0;
    let n = 0;
    for (const v of p.balances.values()) if (v > EPS) n += 1;
    return n;
  }

  markBlocked(mint, reason) {
    const p = this.pending.get(mint);
    if (!p) return false;
    if (!p.blocked) p.blocked = String(reason);
    return true;
  }

  drop(mint) {
    return this.pending.delete(mint);
  }

  // Forget every watched mint (called on stop: no new entries after the signal).
  clear() {
    this.pending.clear();
  }

  // Apply one trade: +tokens for a buy, -tokens for a sell.
  // Returns null when the mint is not tracked, else a snapshot of the crowd.
  apply(mint, user, deltaTokens, { ts = Date.now(), slot = null } = {}) {
    const p = this.pending.get(mint);
    if (!p || !user) return null;
    const d = Number(deltaTokens);
    if (!Number.isFinite(d) || d === 0) return null;

    p.balances.set(user, (p.balances.get(user) || 0) + d);

    if (d > 0) {
      if (!p.firstBuy.has(user)) p.firstBuy.set(user, { ts, slot });
      if (slot !== null) p.slots.add(String(slot));
    }

    const holders = this.holders(mint);
    if (holders > p.maxHolders) p.maxHolders = holders;
    const ready = holders >= this.minHolders;
    if (ready && p.readyAt === null) {
      p.readyAt = ts;
      p.holdersAtReady = holders;
    }
    return {
      holders,
      ready,
      buyers: p.firstBuy.size,
      slots: p.slots.size,
      msSinceCreate: ts - p.at,
      holdersAtReady: p.holdersAtReady,
      maxHolders: p.maxHolders,
    };
  }

  // Organic = a real crowd: enough distinct buyers, spread over several slots, not an instant
  // bundle. `snap` is the object returned by apply().
  organic(snap) {
    if (!snap) return false;
    return (
      snap.holders >= this.minHolders &&
      snap.buyers >= this.minHolders &&
      snap.slots >= this.minSlots &&
      snap.msSinceCreate >= this.minDelayMs
    );
  }

  // Features for data/research/candidates.jsonl.
  features(mint) {
    const p = this.pending.get(mint);
    if (!p) return null;
    let bought = 0;
    let top = 0;
    for (const v of p.balances.values()) {
      if (v > EPS) {
        bought += v;
        if (v > top) top = v;
      }
    }
    return {
      mint,
      creator: p.creator,
      createSlot: p.createSlot,
      createTs: p.at,
      holders: this.holders(mint),
      maxHolders: p.maxHolders,
      buySlots: p.slots.size,
      uniqueBuyers: p.firstBuy.size,
      msToReady: p.readyAt === null ? null : p.readyAt - p.at,
      holdersAtReady: p.holdersAtReady,
      blocked: p.blocked,
      topHolderShare: bought > 0 ? Math.round((top / bought) * 1000) / 1000 : null,
    };
  }

  // Forget mints that waited longer than waitMs. Reports the state at DECISION time so the
  // caller can tell "never got a crowd" from "was ready but we had no free slot".
  prune(now = Date.now()) {
    const dropped = [];
    for (const [mint, p] of this.pending) {
      if (now - p.at < this.waitMs) continue;
      dropped.push({
        mint,
        holders: this.holders(mint),
        holdersAtReady: p.holdersAtReady,
        maxHolders: p.maxHolders,
        ready: p.readyAt !== null,
        blocked: p.blocked,
        waitedMs: now - p.at,
        features: this.features(mint), // snapshot before the entry disappears
      });
      this.pending.delete(mint);
    }
    return dropped;
  }
}
