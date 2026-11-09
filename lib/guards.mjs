import { MAX_CONSEC_LOSSES, MAX_SESSION_SOL, MAX_TRADE_SOL } from "./config.mjs";

// Session-level trade guard (A4): caps per-trade and per-session exposure and
// halts trading after N consecutive losing trades. Never changes entry/exit
// conditions or position sizing — it only refuses trades that breach a limit.
export class TradeGuard {
  // Limits fall back to the .env values; 0 disables the matching check.
  constructor({
    maxTradeSol = MAX_TRADE_SOL,
    maxSessionSol = MAX_SESSION_SOL,
    maxConsecLosses = MAX_CONSEC_LOSSES,
  } = {}) {
    this.maxTradeSol = maxTradeSol;
    this.maxSessionSol = maxSessionSol; // 0 = no session-turnover cap
    this.maxConsecLosses = maxConsecLosses; // 0 = no consecutive-loss limit
    this.spentSol = 0;
    this.consecLosses = 0;
    this.halted = false;
    this.haltReason = "";
  }

  // Returns { ok:boolean, terminal?:boolean, code?:string, reason?:string }. Never throws.
  //
  // `terminal: true` means "this session is over — stop the bot, do not keep scanning":
  //   HALTED      — a loss limit was hit earlier
  //   SESSION_CAP — MAX_SESSION_SOL is used up, no trade can ever pass again
  // `terminal: false` is a per-trade refusal only (bad size / single trade too big), the
  // bot keeps running.
  checkOpen(amountSol) {
    if (this.halted) {
      return { ok: false, terminal: true, code: "HALTED", reason: `trading halted: ${this.haltReason}` };
    }
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      return { ok: false, terminal: false, code: "INVALID", reason: `invalid trade size ${amountSol}` };
    }
    if (amountSol > this.maxTradeSol) { // MAX_TRADE_SOL=0 blocks everything (fail-safe)
      return {
        ok: false,
        terminal: false,
        code: "TRADE_CAP",
        reason: `trade ${amountSol} SOL exceeds MAX_TRADE_SOL ${this.maxTradeSol}`,
      };
    }
    // MAX_SESSION_SOL=0 means "no session cap" (long runs); any other value is a hard stop.
    if (this.maxSessionSol > 0 && this.spentSol + amountSol > this.maxSessionSol) {
      // Nothing can pass this cap any more, so treat it as the end of the session.
      this.halted = true;
      this.haltReason = `session budget exhausted: spent ${this.spentSol} of MAX_SESSION_SOL ${this.maxSessionSol} SOL`;
      return { ok: false, terminal: true, code: "SESSION_CAP", reason: this.haltReason };
    }
    return { ok: true };
  }

  // Reserve funds for an open trade synchronously, immediately after checkOpen() and
  // before any await — this closes the race where two concurrent events both pass
  // checkOpen() before either has recorded its spend.
  reserve(amountSol) {
    // Round to lamport precision (9 dp) so repeated adds don't drift into 0.1999999… .
    this.spentSol = Math.round((this.spentSol + amountSol) * 1e9) / 1e9;
  }

  // Roll back a reservation when the trade fails to send.
  release(amountSol) {
    this.spentSol = Math.max(0, Math.round((this.spentSol - amountSol) * 1e9) / 1e9);
  }

  recordResult(pnlSol) {
    if (pnlSol < 0) {
      this.consecLosses += 1;
      if (this.maxConsecLosses > 0 && this.consecLosses >= this.maxConsecLosses) {
        this.halted = true;
        this.haltReason = `${this.consecLosses} consecutive losing trades (MAX_CONSEC_LOSSES=${this.maxConsecLosses})`;
      }
    } else {
      this.consecLosses = 0;
    }
  }

  get state() {
    return {
      spentSol: this.spentSol,
      consecLosses: this.consecLosses,
      halted: this.halted,
      haltReason: this.haltReason,
    };
  }
}
