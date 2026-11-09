// Tick log: one line per second per tracked token — during the hold and during the post-exit
// window. This is the only way to answer "would trailing / a partial take-profit have helped"
// (the journal only has the sampled peak, which is hindsight).
//
//   ticks-YYYY-MM-DD.jsonl in the journal dir, rotated by size (ticks-YYYY-MM-DD.p2.jsonl, ...)
//   line: {ts, tsMsk, sessionId, mint, phase:"hold"|"post", t, ratio, vSol, vTok, buys, sells, buyers}
//
// Instrumentation only: it reads the curve, it never decides anything.
import fs from "node:fs";
import path from "node:path";
import { mskDateKey, mskIso } from "./time.mjs";

export class TickLog {
  constructor({ dir, sessionId = null, intervalMs = 1000, maxBytesPerFile = 32 * 1024 * 1024, log = null } = {}) {
    this.dir = dir;
    this.sessionId = sessionId;
    this.intervalMs = intervalMs;
    this.maxBytesPerFile = maxBytesPerFile;
    this.log = log;
    this.entries = new Map(); // mint -> { phase, startAt, until, entryPrice, stats, lastSec }
    this.timer = null;
    this.sampler = null;
    this.busy = false;
    this.stream = null;
    this.file = null;
    this.part = 0;
    this.written = 0;
    this.dropped = 0;
  }

  // phase "hold" is open-ended (until = null); phase "post" always has an `until` timestamp.
  track(mint, { phase, entryPrice, until = null, stats = null }) {
    if (!(entryPrice > 0)) return;
    this.entries.set(mint, { phase, startAt: Date.now(), until, entryPrice, stats, lastSec: -1, lastWriteAt: null });
    if (!this.stream) this._open();
  }

  untrack(mint) {
    this.entries.delete(mint);
  }

  get size() {
    return this.entries.size;
  }

  start(sampler) {
    this.sampler = sampler;
    if (this.timer) return;
    this.timer = setInterval(() => void this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref(); // never keep the process alive on its own
  }

  // One sampling pass. Never throws: a tick failure must not touch the trading loop.
  async _tick() {
    if (this.busy || !this.sampler) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const [mint, e] of [...this.entries]) {
        // close an expired window FIRST: the dedupe below `continue`s and would otherwise keep a
        // window open for as long as the interval is shorter than a second
        if (e.until !== null && now >= e.until) {
          this.entries.delete(mint);
          if (this.log) this.log(`[ticks] ${mint.slice(0, 8)} ${e.phase} window closed at ${Math.round((now - e.startAt) / 1000)}s`);
          continue;
        }
        const sec = Math.floor((now - e.startAt) / 1000);
        if (sec === e.lastSec) continue; // one line per second, even if the interval drifts
        let sample = null;
        try {
          sample = await this.sampler(mint, e);
        } catch {
          sample = null;
        }
        if (sample && Number.isFinite(sample.ratio) && sample.ratio > 0) {
          // A gap means the sampler missed at least one interval (RPC timeout, event-loop stall).
          // It is recorded so the analysis can tell "no trade happened" from "we did not look".
          const gapSec = e.lastWriteAt === null ? 0 : (now - e.lastWriteAt) / 1000;
          const gap = e.lastWriteAt !== null && gapSec > 2;
          e.lastSec = sec;
          e.lastWriteAt = now;
          this._write({
            ts: now,
            tsMsk: mskIso(new Date(now)),
            sessionId: this.sessionId,
            mint,
            phase: e.phase,
            t: sec,
            ratio: Math.round(sample.ratio * 1e6) / 1e6,
            ageMs: sample.ageMs === null || sample.ageMs === undefined ? null : Math.round(sample.ageMs),
            stale: sample.stale === true,
            vSol: sample.vSol === null || sample.vSol === undefined ? null : String(sample.vSol),
            vTok: sample.vTok === null || sample.vTok === undefined ? null : String(sample.vTok),
            buys: sample.buys ?? null,
            sells: sample.sells ?? null,
            buyers: sample.buyers ?? null,
            ...(gap ? { gap: true, gapSec: Math.round(gapSec * 10) / 10 } : {}),
          });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  // Used on shutdown: keep sampling until every window ends or maxMs elapses.
  // Returns { closed, remaining, elapsedMs }.
  async drain({ maxMs = 300_000 } = {}) {
    const startedAt = Date.now();
    // Open-ended (hold) windows have no end to finish, so they are cut here; a post-exit window
    // has a fixed `until` and is the only thing worth waiting for.
    for (const [mint, e] of [...this.entries]) if (e.until === null) this.entries.delete(mint);
    if (!this.entries.size) {
      this.close();
      return { closed: true, remaining: 0, elapsedMs: 0 };
    }
    const phaseMax = Math.max(...[...this.entries.values()].map((e) => (e.until === null ? 0 : e.until - Date.now())));
    const budget = Math.min(maxMs, Math.max(0, phaseMax));
    if (this.log) this.log(`[ticks] draining ${this.entries.size} window(s), budget ${Math.round(budget / 1000)}s`);
    while (this.entries.size > 0 && Date.now() - startedAt < budget) {
      await new Promise((r) => setTimeout(r, Math.min(this.intervalMs, 250)));
      await this._tick();
    }
    const remaining = this.entries.size;
    if (this.log && remaining) this.log(`[ticks] ${remaining} window(s) still open after the drain budget — closing`);
    this.entries.clear();
    this.close();
    return { closed: remaining === 0, remaining, elapsedMs: Date.now() - startedAt };
  }

  _open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const base = `ticks-${mskDateKey()}`;
    const name = this.part === 0 ? `${base}.jsonl` : `${base}.p${this.part}.jsonl`;
    this.file = path.join(this.dir, name);
    // Append synchronously: a tick that is still buffered when the bot calls process.exit() is
    // lost, and "the last seconds before shutdown" are exactly the interesting ones.
    try {
      this.bytes = fs.statSync(this.file).size;
    } catch {
      this.bytes = 0;
    }
    this.stream = true; // marker: a file is open (there is no stream any more)
  }

  _write(rec) {
    if (!this.stream) this._open();
    try {
      const line = JSON.stringify(rec) + "\n";
      fs.appendFileSync(this.file, line);
      this.bytes += Buffer.byteLength(line);
      this.written += 1;
      if (this.bytes >= this.maxBytesPerFile) {
        this.part += 1;
        this._open();
      }
    } catch {
      this.dropped += 1;
    }
  }

  _closeStream() {
    this.stream = null;
  }

  _close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._closeStream();
  }

  close() {
    this._close();
  }
}
