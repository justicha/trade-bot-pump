// Creator launch registry persisted on disk, so the "launches in the last 30 minutes" counter
// survives a bot restart (observation: it used to reset after every restart).
//
//   data/creators.json  ->  { "<creator base58>": [<launch epoch ms>, ...] }
//
// Every entry keeps only the launches inside the 30-minute window, so the file stays small.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

export const CREATOR_WINDOW_MS = 30 * 60 * 1000;
const FILE = process.env.CREATORS_FILE || path.join(ROOT, "data", "creators.json");

export function loadCreatorRegistry() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (j && typeof j === "object" && !Array.isArray(j)) return j;
  } catch {
    /* no registry yet */
  }
  return {};
}

export function saveCreatorRegistry(reg) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(reg));
  } catch {
    /* best effort — the registry is instrumentation only */
  }
}

// Record one launch, keeping only the entries inside the window. Returns the mutated registry.
export function noteCreatorLaunch(reg, creator, ts = Date.now()) {
  if (!creator) return reg;
  const cutoff = ts - CREATOR_WINDOW_MS;
  const list = (reg[creator] || []).filter((x) => x >= cutoff);
  list.push(ts);
  reg[creator] = list;
  return reg;
}

// Number of launches for this creator inside the window (null when the creator is unknown).
export function creatorLaunches30m(reg, creator, now = Date.now()) {
  if (!creator) return null;
  const cutoff = now - CREATOR_WINDOW_MS;
  return (reg[creator] || []).filter((x) => x >= cutoff).length;
}
