// Raw capture of every pump.fun / PumpSwap program event, plus the tools to read it back.
//
// Why raw: the parser (lib/events.mjs) is the thing under investigation. As long as only PARSED
// data is stored, every parser change throws away the evidence and you have to go back to the
// live stream (which moves) to re-test. Writing the untouched base64 payload lets a fix be
// re-validated offline on exactly the same bytes, as many times as needed.
//
// One NDJSON file per LOCAL hour, gzipped: data/raw/YYYY-MM-DD-HH.jsonl.gz
//   line 1 : {"type":"meta","createdAt":...,"pid":...,"file":...}
//   then   : {"ts":<ms>,"iso":...,"slot":...,"sig":...,"program":...,"ix":...,
//             "outer":...(null = direct call),"path":[...],"ok":true,"data":"<base64>"}
//
// `outer`/`path` come from the invoke stack in the transaction log: a "Program data:" line
// belongs to the program on top of the stack at that moment, and its caller is the level below.
// That is how a router/CPI buy is told apart from a direct call — needed to see whether one
// class of caller is responsible for the malformed payloads.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { ROOT } from "./config.mjs";
import { log } from "./logger.mjs";
import { mskHourKey } from "./time.mjs";

export const RAW_DIR = path.join(ROOT, "data", "raw");

const pad = (n) => String(n).padStart(2, "0");

// Local-time hour bucket for the raw file name. Explicitly Moscow (lib/time.mjs), so a capture on
// a UTC machine and one in Moscow produce the same, comparable file names.
export function hourKey(d = new Date()) {
  return mskHourKey(d);
}

// ---- log stack parsing ------------------------------------------------------
const RE_INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const RE_SUCCESS = /^Program (\w+) success$/;
const RE_FAILED = /^Program (\w+) failed/;
const RE_IX = /^Program log: Instruction: (\w+)/;
const RE_DATA = /^Program data: (.+)$/;

// Turns one transaction's log lines into the list of event payloads with their call context.
// Never throws: malformed lines are simply skipped (a bad log must not kill the capture).
export function parseProgramLogs(logs) {
  const out = [];
  if (!Array.isArray(logs)) return out;
  const stack = []; // [{ program, ix }]

  for (const line of logs) {
    if (typeof line !== "string") continue;

    const inv = RE_INVOKE.exec(line);
    if (inv) {
      stack.push({ program: inv[1], ix: null });
      continue;
    }
    const done = RE_SUCCESS.exec(line) || RE_FAILED.exec(line);
    if (done) {
      // Pop only when it matches the top: a truncated log leaves entries behind, and popping
      // blindly would mis-attribute every following payload.
      const top = stack[stack.length - 1];
      if (top && top.program === done[1]) stack.pop();
      continue;
    }
    const ix = RE_IX.exec(line);
    if (ix) {
      const top = stack[stack.length - 1];
      if (top) top.ix = ix[1];
      continue;
    }
    const data = RE_DATA.exec(line);
    if (!data) continue;
    const top = stack[stack.length - 1];
    if (!top) continue; // payload with no owning program: nothing to attribute it to
    out.push({
      program: top.program,
      ix: top.ix,
      outer: stack.length > 1 ? stack[stack.length - 2].program : null,
      path: stack.map((s) => s.program),
      data: data[1],
    });
  }
  return out;
}


// ---- writer -----------------------------------------------------------------
export class RawCapture {
  constructor({ dir = RAW_DIR, keepMeta = true, maxTotalBytes = 0 } = {}) {
    this.dir = dir;
    this.keepMeta = keepMeta;
    this.maxTotalBytes = Math.max(0, Number(maxTotalBytes) || 0);
    this.stream = null;
    this.file = null;
    this.key = null;
    this.records = 0;
    this.pruned = 0;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  get currentSize() {
    return this.stream?.gzip?.bytesWritten || 0;
  }

  _open(key) {
    if (this.stream) this._closeStream();
    this.key = key;
    this.file = path.join(this.dir, `${key}.jsonl.gz`);
    // Resume: the file is opened for append, so a restart continues the same hour instead of
    // starting a new file. The meta header is only written into an empty file (a second header
    // mid-file would be harmless — readers skip it — but it makes the file self-describing).
    const existing = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    const gzip = zlib.createGzip({ level: 6 });
    const target = fs.createWriteStream(this.file, { flags: "a" });
    gzip.pipe(target);
    target.on("error", (err) => log.error(`[raw] write error: ${err.message}`));
    this.stream = { gzip, target };
    if (this.keepMeta && existing === 0) {
      gzip.write(JSON.stringify({ type: "meta", createdAt: new Date().toISOString(), pid: process.pid, file: path.basename(this.file), costsScheme: undefined }) + "\n");
    } else if (existing > 0) {
      log.info(`[raw] resuming ${path.basename(this.file)} (${(existing / 1024 / 1024).toFixed(2)} MB on disk) — appending`);
    }
  }

  _closeStream() {
    try {
      this.stream?.gzip?.end();
    } catch {
      /* already closed */
    }
    this.stream = null;
  }

  // rec: { ts, slot, sig, ok, program, ix, outer, path, data }
  write(rec) {
    const ts = rec.ts ?? Date.now();
    const key = hourKey(new Date(ts));
    if (key !== this.key) {
      const prev = this.file;
      const prevSize = this.currentSize;
      this._open(key);
      if (prev) {
        log.info(`[raw] rotated ${path.basename(prev)} (${(prevSize / 1024).toFixed(1)} KB) -> ${path.basename(this.file)}`);
      }
      // Rotation is the natural moment to enforce the disk cap: the old file is closed, so it can
      // be deleted safely, and the new one is excluded from pruning.
      if (this.maxTotalBytes > 0) {
        this.pruned += pruneRawDir(this.dir, { maxBytes: this.maxTotalBytes, keep: this.file }).length;
      }
    }
    const line = {
      ts,
      iso: new Date(ts).toISOString(),
      slot: rec.slot ?? null,
      sig: rec.sig ?? null,
      ok: rec.ok !== false,
      program: rec.program,
      ix: rec.ix ?? null,
      outer: rec.outer ?? null,
      path: rec.path ?? null,
      data: rec.data,
    };
    this.stream.gzip.write(JSON.stringify(line) + "\n");
    this.records += 1;
    return line;
  }

  // Forces a zlib flush so a crash cannot lose the last seconds.
  flush() {
    try {
      this.stream?.gzip?.flush?.(zlib.constants.Z_SYNC_FLUSH);
    } catch {
      /* nothing to flush */
    }
  }

  async close() {
    const s = this.stream;
    if (!s) return;
    await new Promise((resolve) => {
      s.target.once("close", resolve);
      s.gzip.end();
    });
    this.stream = null;
  }
}

// ---- reader / replay --------------------------------------------------------
export function listRawFiles(dir = RAW_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl.gz"))
    .sort()
    .map((f) => path.join(dir, f));
}

// Per-hour sizes and the total, so a capture run can be watched (and pruned) without guessing.
export function rawDirStats(dir = RAW_DIR) {
  const files = listRawFiles(dir).map((file) => {
    const st = fs.statSync(file);
    return { file, name: path.basename(file), key: path.basename(file, ".jsonl.gz"), bytes: st.size, mtime: st.mtimeMs };
  });
  const total = files.reduce((s, f) => s + f.bytes, 0);
  return { dir, files, total, count: files.length };
}

// Deletes the oldest hour files until the directory fits into `maxBytes`. The file currently being
// written is never deleted. Returns the list of removed files.
export function pruneRawDir(dir = RAW_DIR, { maxBytes = 0, keep = null } = {}) {
  const removed = [];
  if (!maxBytes || maxBytes <= 0) return removed;
  let { files, total } = rawDirStats(dir);
  const byAge = files.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const f of byAge) {
    if (total <= maxBytes) break;
    if (keep && f.file === keep) continue;
    try {
      fs.rmSync(f.file, { force: true });
      total -= f.bytes;
      removed.push(f);
      log.info(`[raw] pruned ${f.name} (${(f.bytes / 1024 / 1024).toFixed(1)} MB) to stay under the ${(maxBytes / 1024 / 1024 / 1024).toFixed(2)} GB cap`);
    } catch (err) {
      log.warn(`[raw] could not prune ${f.name}: ${err.message}`);
    }
  }
  return removed;
}

export async function* readRawFile(file) {
  const input = fs.createReadStream(file).pipe(zlib.createGunzip());
  // A file that is still being written by a running capture ends mid-stream ("unexpected end of
  // file"). That must not kill the reader: everything up to that point is valid data.
  let streamError = null;
  input.on("error", (err) => {
    streamError = err;
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a half-written last line after a crash is expected
      }
      if (rec.type === "meta") continue;
      yield rec;
    }
  } catch (err) {
    streamError = streamError || err;
  }
  if (streamError) log.warn(`[raw] ${path.basename(file)}: read stopped early (${streamError.message}) — partial data only`);
}

// Replay every record from one file or a whole directory, oldest first.
export async function* replayRaw(target, { filter = null } = {}) {
  const files = fs.existsSync(target) && fs.statSync(target).isDirectory() ? listRawFiles(target) : [target];
  for (const file of files) {
    for await (const rec of readRawFile(file)) {
      if (filter && !filter(rec)) continue;
      yield rec;
    }
  }
}

// Decoded payload helper for replay/tools: base64 -> Buffer, null when it is not base64.
export function payloadOf(rec) {
  try {
    return Buffer.from(rec.data, "base64");
  } catch {
    return null;
  }
}
