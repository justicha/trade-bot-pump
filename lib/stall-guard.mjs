// Stall guard for the trading bots (KODING №10, C).
//
// What it is for: on Windows a console write is synchronous. A classic PowerShell / cmd window that
// is "paused" (a click that starts a text selection — QuickEdit —, scrolling, Pause) blocks
// console.log, and with it the whole event loop, until a key is pressed. The shadow lab stood still
// for 22–39 minutes three times that way (KODING №9); a live bot prints far more often, so it
// freezes on the first line after the click — positions are not watched and nothing is sold.
//
// The guard cannot prevent the freeze (nothing in the process runs during it). It makes the bot
// behave correctly the moment it is back:
//   - a gap between two timer ticks longer than STALL_GUARD_SEC is a stall: a `stall` row is
//     journaled FIRST (the journal is a file, the console is what blocks), the open positions are
//     marked (pos.stallMs) and the bot's onStall hook re-checks them against the chain at once;
//   - the socket hands over everything it buffered during the pause. A stream notification whose
//     own on-chain timestamp is older than STALL_GUARD_SEC is that backlog, not the present: the
//     bot must not BUY on it (isStale). They are counted and journaled as one `stale_events` row.
//   - STALL_GUARD_SEC=0 switches all of it off.
//
// Pure helpers (stallGapMs, eventLagMs) used to live in lib/gshadow.mjs; the shadow lab imports
// them from here now.
import { numOr } from "./config.mjs";

export const STALL_GUARD_SEC = numOr(process.env.STALL_GUARD_SEC, 30, "STALL_GUARD_SEC");
// After a detected stall, notifications WITHOUT a readable timestamp are treated as backlog for
// this long (they cannot be shown to be fresh while the socket is draining).
export const STALL_DRAIN_MS = 5000;
export const CONSOLE_HINT =
  "do not select text in this window (a paused console freezes the bot); run it in Windows Terminal or the VS Code terminal";

// The gap between two timer ticks when it is long enough to be a stall, else 0.
export function stallGapMs(now, lastTickAt, thresholdMs) {
  if (!(thresholdMs > 0) || !(lastTickAt > 0)) return 0;
  const gap = now - lastTickAt;
  return gap > thresholdMs ? gap : 0;
}

// How old an event is when it is processed: its own on-chain timestamp (unix SECONDS — equal to the
// block time) against the local clock. An unknown timestamp is "not stale" (0): the guard must
// never blind a bot on a layout it cannot read.
export function eventLagMs(timestampSec, now) {
  const ts = Number(timestampSec);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return now - ts * 1000;
}

// On-chain timestamp of a parsed stream event, in seconds (null = unknown). lib/events.mjs names
// the trade field `timestampMs` although it carries seconds; a value that really is in
// milliseconds (> 1e12) is converted, so either unit is read correctly.
export function eventTimestampSec(ev) {
  const raw = ev?.timestampSec ?? ev?.timestampMs ?? null;
  const n = Number(raw);
  if (raw === null || !Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n / 1000 : n;
}

//   thresholdMs  STALL_GUARD_SEC * 1000; 0 = the guard does nothing
//   journal      anything with write(); the row goes there before any console line
//   log          console logger (called last)
//   positions    the bot's Map(mint -> pos): counted and marked (pos.stallMs)
//   onStall      ({ gapMs, now }) => void — the bot re-checks its positions against the chain
//   fields       object or () => object stamped into the rows (sessionId, …)
//   now          clock (tests inject one)
export function createStallGuard({
  thresholdMs = STALL_GUARD_SEC * 1000,
  journal = null,
  log = () => {},
  positions = null,
  onStall = null,
  fields = {},
  now = () => Date.now(),
  tickMs = 1000,
} = {}) {
  const enabled = thresholdMs > 0;
  const meta = () => (typeof fields === "function" ? fields() : fields) || {};
  const stale = { events: 0, maxLagMs: 0, lastAt: 0 };
  let lastTickAt = 0;
  let lastStallAt = 0;
  let stalls = 0;
  let timer = null;

  function flushStale(t) {
    if (!stale.events || t - stale.lastAt < tickMs) return null; // still draining: one row at the end
    const row = { events: stale.events, maxLagSec: Math.round(stale.maxLagMs / 1000) };
    stale.events = 0;
    stale.maxLagMs = 0;
    if (journal) journal.write({ type: "stale_events", ...meta(), ...row, thresholdSec: thresholdMs / 1000 });
    log(`STALE EVENTS: ${row.events} stream notification(s) up to ${row.maxLagSec}s old were not acted on (backlog after a pause; no buy is made on them)`);
    return row;
  }

  // One tick. Called by the guard's own 1 s timer and by the bot at the top of its stream handler
  // (so a stall is noticed before the first buffered event is looked at). Returns the gap (ms) when
  // this tick noticed a stall, else 0.
  function tick(t = now()) {
    if (!enabled) return 0;
    const gapMs = stallGapMs(t, lastTickAt, thresholdMs);
    lastTickAt = t;
    if (gapMs) {
      stalls += 1;
      lastStallAt = t;
      const mints = positions ? [...positions.keys()] : [];
      if (positions) for (const pos of positions.values()) pos.stallMs = (pos.stallMs || 0) + gapMs;
      const stallSec = Math.round(gapMs / 1000);
      // Journal first, the hook second, the console last: the console is the thing that blocks.
      if (journal) journal.write({ type: "stall", ...meta(), stallSec, open: mints.length, mints, at: new Date(t).toISOString(), thresholdSec: thresholdMs / 1000 });
      if (typeof onStall === "function") {
        try {
          onStall({ gapMs, now: t });
        } catch { /* a failing hook must not hide the stall */ }
      }
      log(`ALERT: the process stood still for ${stallSec}s (a paused console window?) — ${mints.length} open position(s) were not watched; re-checking them against the chain now. ${CONSOLE_HINT}`);
    }
    flushStale(t);
    return gapMs;
  }

  // Is this stream notification backlog? `events` = the parsed events of ONE notification.
  // true -> the bot must not buy on it. Counted for the `stale_events` row.
  function isStale(events, t = now()) {
    if (!enabled) return false;
    tick(t);
    let lagMs = 0;
    let known = false;
    for (const ev of events || []) {
      const ts = eventTimestampSec(ev);
      if (ts === null) continue;
      known = true;
      lagMs = Math.max(lagMs, eventLagMs(ts, t));
    }
    const drain = !known && lastStallAt > 0 && t - lastStallAt < STALL_DRAIN_MS;
    if (!(lagMs > thresholdMs) && !drain) return false;
    stale.events += 1;
    stale.maxLagMs = Math.max(stale.maxLagMs, lagMs);
    stale.lastAt = t;
    return true;
  }

  return {
    enabled,
    thresholdMs,
    tick,
    isStale,
    start() {
      if (!enabled || timer) return;
      lastTickAt = now();
      timer = setInterval(() => tick(), tickMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (enabled && stale.events) {
        stale.lastAt = 0;
        flushStale(now());
      }
    },
    stats: () => ({ stalls, lastStallAt, staleEvents: stale.events }),
    banner: () => (enabled ? `stall guard ${thresholdMs / 1000}s (stall / stale stream events) — ${CONSOLE_HINT}` : `stall guard OFF (STALL_GUARD_SEC=0) — ${CONSOLE_HINT}`),
  };
}
