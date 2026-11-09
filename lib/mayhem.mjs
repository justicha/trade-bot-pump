// Mayhem detection: one program id, three independent sources, one verdict per token.
//
// What Mayhem is (as far as the data shows): a third-party program that CPIs into pump.fun.
// It matters because its trades are exactly the class whose trade-event SOL reserve side breaks
// x*y=k (scripts/diag-390.mjs: 100% of violations, 0% for direct calls and every other router),
// and because tokens created in mayhem mode carry a flag in their curve account.
//
// Sources, strongest first:
//   1. curve account, byte 81 (`is_mayhem_mode`) — authoritative, verified on live accounts
//   2. create-v2 payload tail — validated against (1) by scripts/mayhem-report.mjs
//   3. a trade seen with Mayhem as the outer (calling) program — evidence at trade level
import { MAYHEM_PROGRAM } from "./constants.mjs";

export const MAYHEM_PROGRAM_ID = MAYHEM_PROGRAM.toBase58();

// BondingCurve account layout: 8 discriminator, 5 x u64 (8..48), complete (48),
// creator (49..81), is_mayhem_mode (81).
export const MAYHEM_ACCOUNT_FLAG_OFFSET = 81;
export const CREATOR_OFFSET = 49;

export function isMayhemCaller(outer) {
  return outer === MAYHEM_PROGRAM_ID;
}

// A trade can be reached through a chain (router -> mayhem -> pump.fun): any level counts.
export function isMayhemPath(path) {
  return Array.isArray(path) && path.includes(MAYHEM_PROGRAM_ID);
}

export function mayhemFromAccount(data) {
  if (!data || data.length <= MAYHEM_ACCOUNT_FLAG_OFFSET) return null;
  return { isMayhemMode: data[MAYHEM_ACCOUNT_FLAG_OFFSET] === 1 };
}

// Per-run index: remembers everything we learn about a token and answers "is this a Mayhem token".
export class MayhemIndex {
  constructor() {
    this.mints = new Map(); // mint -> { mayhem, source, trades, mayhemTrades, buyers:Set, mayhemBuyers:Set }
  }

  _rec(mint) {
    let r = this.mints.get(mint);
    if (!r) {
      r = { mint, mayhem: false, source: null, trades: 0, mayhemTrades: 0, buyers: new Set(), mayhemBuyers: new Set(), holders: new Set(), mayhemHolders: new Set() };
      this.mints.set(mint, r);
    }
    return r;
  }

  noteAccount(mint, accountData) {
    const f = mayhemFromAccount(accountData);
    if (!f) return null;
    const r = this._rec(mint);
    r.mayhem = f.isMayhemMode;
    r.source = "account";
    return r.mayhem;
  }

  // Returns { mayhem, via } when the create payload tail carries a usable flag, else null.
  noteCreate(mint, { flag } = {}) {
    const r = this._rec(mint);
    if (typeof flag === "boolean") {
      r.mayhem = flag;
      r.source = r.source === "account" ? "account" : "create";
      return r.mayhem;
    }
    return null;
  }

  noteTrade(mint, { outer = null, path = null, user = null, isBuy = false, tokenAmount = 0 } = {}) {
    const r = this._rec(mint);
    const viaMayhem = isMayhemCaller(outer) || isMayhemPath(path);
    r.trades += 1;
    if (user) {
      r.buyers.add(user);
      // holder bookkeeping: positive balance only (buys minus sells), mayhem excluded separately
      r.holders.add(user);
    }
    if (viaMayhem) {
      r.mayhemTrades += 1;
      r.mayhem = true;
      if (!r.source) r.source = "trade";
      if (user) r.mayhemBuyers.add(user);
      if (user) r.mayhemHolders.add(user);
    }
    return viaMayhem;
  }

  isMayhem(mint) {
    return this.mints.get(mint)?.mayhem ?? false;
  }

  get(mint) {
    return this.mints.get(mint) || null;
  }

  stats() {
    let mayhemTokens = 0;
    let trades = 0;
    let mayhemTrades = 0;
    for (const r of this.mints.values()) {
      if (r.mayhem) mayhemTokens += 1;
      trades += r.trades;
      mayhemTrades += r.mayhemTrades;
    }
    return { mints: this.mints.size, mayhemTokens, trades, mayhemTrades };
  }
}
