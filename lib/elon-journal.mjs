// elon-watch (KODING #25) journal: data/elon/YYYY-MM-DD.jsonl by the MOSCOW date of the write (like the
// other journals, lib/time.mjs), one JSON row per line with `ts` (ISO UTC) first. Row types:
// elon_post, elon_kw, elon_match, elon_path, elon_paper, elon_cost, elon_gap, elon_mem, elon_state.
// The writer never throws (a full disk must not kill the recorder): the first error goes to onError and
// writing stops.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { mskDateKey } from "./time.mjs";

export const elonFileName = (ms) => `${mskDateKey(new Date(ms))}.jsonl`;

export function createElonWriter(dir, { now = () => Date.now(), onError = () => {} } = {}) {
  let enabled = true;
  let written = 0;
  let bytes = 0;
  return {
    file: (ms = now()) => path.join(dir, elonFileName(ms)),
    write(row) {
      if (!enabled) return false;
      try {
        const ms = now();
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({ ts: new Date(ms).toISOString(), ...row }) + "\n";
        fs.appendFileSync(path.join(dir, elonFileName(ms)), line);
        written += 1;
        bytes += Buffer.byteLength(line);
        return true;
      } catch (e) {
        enabled = false;
        onError(e);
        return false;
      }
    },
    get written() {
      return written;
    },
    get bytes() {
      return bytes;
    },
  };
}

// Rows of the journal files: a directory (every YYYY-MM-DD.jsonl[.gz] in it) or a list of files.
export function readElonRows(target) {
  const files = [];
  for (const t of Array.isArray(target) ? target : [target]) {
    if (fs.existsSync(t) && fs.statSync(t).isDirectory()) {
      for (const f of fs.readdirSync(t).sort()) if (/^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)) files.push(path.join(t, f));
    } else if (fs.existsSync(t)) files.push(t);
  }
  const rows = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const text = f.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* a torn last line */
      }
    }
  }
  return { files, rows };
}
