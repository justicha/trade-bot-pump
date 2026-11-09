#!/usr/bin/env node
// Per-hour raw capture sizes: what is on disk, how many records each hour holds, and the total.
//
//   node scripts/raw-stats.mjs                    # data/raw
//   node scripts/raw-stats.mjs --raw data/raw --prune-gb 2
//
// `--prune-gb N` deletes the oldest hour files until the directory fits into N GB (the same rule
// CAPTURE_MAX_GB applies during a capture run, available here for an existing directory).
import { rawDirStats, pruneRawDir, RAW_DIR, readRawFile } from "../lib/rawcap.mjs";

const argv = process.argv.slice(2);
const argOf = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DIR = argOf("--raw", RAW_DIR);
const PRUNE_GB = Number(argOf("--prune-gb", "0"));
const COUNT_RECORDS = !argv.includes("--no-count");

let st = rawDirStats(DIR);
console.log(`=== RAW CAPTURE SIZES (${st.dir}) ===`);
if (!st.count) {
  console.log("  no files yet");
  process.exit(0);
}
console.log("  hour file                 size        records");
for (const f of st.files) {
  let records = "-";
  if (COUNT_RECORDS) {
    records = 0;
    for await (const _ of readRawFile(f.file)) records += 1;
  }
  console.log(`  ${f.name.padEnd(24)} ${(`${(f.bytes / 1024 / 1024).toFixed(2)} MB`).padStart(9)}   ${String(records).padStart(7)}`);
}
console.log(`  ${"total".padEnd(24)} ${(`${(st.total / 1024 / 1024).toFixed(2)} MB`).padStart(9)}   ${st.count} file(s)`);

if (PRUNE_GB > 0) {
  const removed = pruneRawDir(DIR, { maxBytes: PRUNE_GB * 1024 * 1024 * 1024 });
  st = rawDirStats(DIR);
  console.log(`\n  pruned ${removed.length} file(s); ${st.count} left, ${(st.total / 1024 / 1024).toFixed(2)} MB`);
}
