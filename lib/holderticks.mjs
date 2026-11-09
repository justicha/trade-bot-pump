// Holder milestones + post-4-holder price trajectory, written to holders-<date>.jsonl.
//
// This is the raw material for "what would have happened if we entered at 4 / 6 / 8 / 10 holders"
// and for partial-exit / trailing evaluation from tick trajectories (NOT from hindsight peak).
//
//   milestone line: {ts, sessionId, mint, phase:"milestone", holders, sec, price, source}
//   price line:     {ts, sessionId, mint, phase:"price", t, price, source}
//
// Instrumentation only: prices never feed a decision. Milestones use the ACCOUNT price (fetched by
// the caller at priority 3); the 1/s trajectory uses the STREAM price (zero extra RPC) so the RPC
// budget stays under the limit.
import fs from "node:fs";
import path from "node:path";
import { mskDateKey, mskIso } from "./time.mjs";

const MILESTONES = [4, 6, 8, 10];

export class HolderTickLog {
  constructor({ dir, sessionId = null, log = null, trajectorySec = 150 } = {}) {
    this.dir = dir;
    this.sessionId = sessionId;
    this.log = log;
    this.trajectorySec = trajectorySec;
    this.tokens = new Map(); // mint -> { createTs, milestones: {n: sec}, written:Set, reached4At, lastTrajSec }
    this.written = 0;
  }

  get size() {
    return this.tokens.size;
  }

  noteCreate(mint, ts = Date.now()) {
    if (this.tokens.has(mint)) return;
    this.tokens.set(mint, { createTs: ts, milestones: {}, written: new Set(), reached4At: null, lastTrajSec: -1 });
  }

  // Record the holder count; returns the milestone numbers newly reached (empty when none).
  noteHolders(mint, holders, ts = Date.now()) {
    const t = this.tokens.get(mint);
    if (!t) return [];
    const newly = [];
    for (const n of MILESTONES) {
      if (holders >= n && t.milestones[n] === undefined) {
        t.milestones[n] = Math.round((ts - t.createTs) / 1000);
        if (n === 4) t.reached4At = ts;
        newly.push(n);
      }
    }
    return newly;
  }

  // Write a milestone (the caller supplies the account price + source).
  writeMilestone(mint, n, { price = null, source = null } = {}) {
    const t = this.tokens.get(mint);
    if (!t || t.written.has(n)) return;
    t.written.add(n);
    this._write({ phase: "milestone", mint, holders: n, sec: t.milestones[n], price, source });
  }

  // Mints whose 4-holder trajectory is still running (within trajectorySec of reaching 4).
  activeTrajectoryMints(now = Date.now()) {
    return [...this.tokens.entries()]
      .filter(([, t]) => t.reached4At !== null && now - t.reached4At <= this.trajectorySec * 1000)
      .map(([mint]) => mint);
  }

  // Write one 1/s trajectory sample (stream price). Returns false when not active or a dup second.
  sampleTrajectory(mint, price, { source = null, ts = Date.now() } = {}) {
    const t = this.tokens.get(mint);
    if (!t || t.reached4At === null) return false;
    const sec = Math.floor((ts - t.reached4At) / 1000);
    if (sec < 0 || sec > this.trajectorySec || sec === t.lastTrajSec) return false;
    t.lastTrajSec = sec;
    this._write({ phase: "price", mint, t: sec, price, source });
    return true;
  }

  _write(rec) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `holders-${mskDateKey()}.jsonl`);
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), tsMsk: mskIso(), sessionId: this.sessionId, ...rec }) + "\n");
      this.written += 1;
    } catch {
      /* instrumentation is best effort */
    }
  }
}
