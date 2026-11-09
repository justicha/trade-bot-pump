#!/usr/bin/env node
// Data-integrity audit over data/journal, data/research and data/raw: empty files, broken JSON
// lines, non-numeric values, duplicate mints and duplicate exits, lines missing a timestamp.
// Read-only. Numbers per file, one line each, so a regression is visible in a single diff.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { ROOT } from "../lib/config.mjs";

const DIRS = ["data/journal", "data/research", "data/raw"];
const out = {};

function fail(f) {
  return (out[f] = { file: f, error: "unreadable" });
}

for (const d of DIRS) {
  const dir = path.join(ROOT, d);
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, name);
    const st = fs.statSync(f);
    const rec = { file: path.join(d, name), bytes: st.size, lines: 0, broken: 0, noTime: 0, nonNumeric: 0, dupMints: 0, dupExits: 0, empty: st.size === 0 };
    out[path.join(d, name)] = rec;
    if (st.isDirectory()) continue;

    const mints = new Set();
    const tradesPerMint = new Map();
    // .json files are single documents (pretty-printed); .jsonl/.gz are line-delimited.
    if (name.endsWith(".json")) {
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        rec.lines = 1;
        if (!j || typeof j !== "object") rec.broken = 1;
      } catch {
        rec.broken = 1;
      }
      continue;
    }
    let stream;
    if (name.endsWith(".gz")) stream = fs.createReadStream(f).pipe(zlib.createGunzip());
    else stream = fs.createReadStream(f);

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        rec.lines += 1;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          rec.broken += 1;
          continue;
        }
        if (j && typeof j === "object" && !Array.isArray(j)) {
          if (j.type === "meta") continue;
          if (!j.ts && !j.tsMsk && !j.at && !j.iso) rec.noTime += 1;
          if (j.type === "trade" || j.type === "exit") {
            const mint = j.mint;
            if (mint) {
              mints.add(mint);
              tradesPerMint.set(mint, (tradesPerMint.get(mint) || 0) + 1);
            }
            if (j.pnlSol !== undefined && !Number.isFinite(Number(j.pnlSol))) rec.nonNumeric += 1;
            if (j.costsSol !== undefined && !Number.isFinite(Number(j.costsSol))) rec.nonNumeric += 1;
          }
        }
      }
    } catch {
      // a half-written gzip tail (capture still running) ends the stream: keep what was read
    }
    rec.dupMints = [...tradesPerMint.values()].filter((n) => n > 1).length;
    rec.dupExits = [...tradesPerMint.entries()].filter(([, n]) => n > 1).length;
  }
}

console.log("file                                             bytes      lines  broken  noTime  nonNumeric  dupMints");
let brokenTotal = 0;
let noTimeTotal = 0;
let nonNumTotal = 0;
for (const rec of Object.values(out).sort((a, b) => a.file.localeCompare(b.file))) {
  if (rec.error) {
    console.log(`${rec.file.padEnd(46)} ERROR: ${rec.error}`);
    continue;
  }
  brokenTotal += rec.broken;
  noTimeTotal += rec.noTime;
  nonNumTotal += rec.nonNumeric;
  console.log(
    `${rec.file.padEnd(46)} ${String(rec.bytes).padStart(8)} ${String(rec.lines).padStart(9)} ${String(rec.broken).padStart(7)} ${String(rec.noTime).padStart(7)} ${String(rec.nonNumeric).padStart(11)} ${String(rec.dupMints).padStart(9)}`,
  );
}
console.log("\nTOTALS: broken JSON lines " + brokenTotal + ", lines without a timestamp " + noTimeTotal + ", non-numeric pnl/costs " + nonNumTotal);
