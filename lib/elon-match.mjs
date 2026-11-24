// elon-watch (KODING #25): does a pump.fun token (name / symbol) match a post keyword? Pure, no I/O.
//
// Match kinds, strongest first (the first that holds is reported):
//   symbol  the token symbol's norm equals the keyword norm or one of its variants
//   name    the token name's norm equals it
//   token   the name contains it as a whole word (name split on non-alphanumerics and camelCase)
//   fuzzy   Levenshtein distance <= 1 to the symbol or the name norm, keyword norm length >= 5
// Norms come from lib/elon-keywords.mjs normWord / normPhrase (NFKC, lower case, a-z0-9 only).
import { normWord, normPhrase } from "./elon-keywords.mjs";

export const MATCH_REV = 1;
export const FUZZY_MIN_LEN = 5;
export const BEFORE_SEC = 6 * 3600; // backtest window: creates from 6 h before the post ...
export const AFTER_SEC = 30 * 60; // ... to 30 min after it
export const GENERIC_WINDOW_SEC = 24 * 3600;
export const GENERIC_MIN = 6; // "generic": more than 5 matches created in the 24 h BEFORE the post
export const REPEAT_WINDOW_SEC = 24 * 3600;

// Levenshtein distance, early exit once it exceeds `max` (returns max + 1 then).
export function levenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Name words: "SaturnCoin 2.0" -> ["saturn", "coin", "2", "0"].
export function nameWords(name) {
  return String(name ?? "")
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map(normWord)
    .filter(Boolean);
}

// The match fields of a token, computed once per create (the live index stores them).
export function tokenKeys({ name, symbol }) {
  return { normName: normPhrase(name ?? ""), normSymbol: normWord(symbol ?? ""), words: nameWords(name) };
}

// keyword ({ norm, variants }) x token keys -> "symbol" | "name" | "token" | "fuzzy" | null
export function matchKind(kw, keys) {
  const vs = kw.variants?.length ? kw.variants : [kw.norm];
  if (!kw.norm) return null;
  if (keys.normSymbol && vs.includes(keys.normSymbol)) return "symbol";
  if (keys.normName && vs.includes(keys.normName)) return "name";
  if (keys.words?.length > 1 && keys.words.some((w) => vs.includes(w))) return "token";
  if (kw.norm.length >= FUZZY_MIN_LEN) {
    if (keys.normSymbol && levenshtein(kw.norm, keys.normSymbol, 1) <= 1) return "fuzzy";
    if (keys.normName && levenshtein(kw.norm, keys.normName, 1) <= 1) return "fuzzy";
  }
  return null;
}

// ---- token index (offline backtest and the live bot) --------------------------------------------------
// Entries: { mint, name, symbol, createSec, ... } (any extra fields are kept). Lookup by exact keys
// (symbol / name / name words) plus a length bucket for the fuzzy rule. `evictBefore` drops entries
// created before a second (the live 24 h index; entries must be added in time order for it).
export function createTokenIndex({ maxEntries = Infinity } = {}) {
  const idx = { byKey: new Map(), byLen: new Map(), byMint: new Map(), order: [], head: 0, maxEntries, evicted: 0 };
  return idx;
}

const keyAdd = (map, k, e) => {
  if (!k) return;
  let s = map.get(k);
  if (!s) map.set(k, (s = new Set()));
  s.add(e);
};
const keyDel = (map, k, e) => {
  const s = map.get(k);
  if (!s) return;
  s.delete(e);
  if (!s.size) map.delete(k);
};

function entryKeys(e) {
  const k = e.keys;
  return [`s:${k.normSymbol}`, `n:${k.normName}`, ...(k.words.length > 1 ? k.words.map((w) => `w:${w}`) : [])];
}

export function indexAdd(idx, token) {
  if (!token?.mint || idx.byMint.has(token.mint)) return null;
  const e = { ...token, keys: tokenKeys(token) };
  idx.byMint.set(e.mint, e);
  for (const k of entryKeys(e)) keyAdd(idx.byKey, k, e);
  for (const n of new Set([e.keys.normSymbol.length, e.keys.normName.length])) if (n >= FUZZY_MIN_LEN - 1) keyAdd(idx.byLen, n, e);
  idx.order.push(e);
  while (idx.order.length - idx.head > idx.maxEntries) removeEntry(idx, idx.order[idx.head++]);
  compact(idx);
  return e;
}

function removeEntry(idx, e) {
  if (!e || idx.byMint.get(e.mint) !== e) return;
  idx.byMint.delete(e.mint);
  for (const k of entryKeys(e)) keyDel(idx.byKey, k, e);
  for (const n of new Set([e.keys.normSymbol.length, e.keys.normName.length])) keyDel(idx.byLen, n, e);
  idx.evicted += 1;
}

function compact(idx) {
  if (idx.head > 4096 && idx.head * 2 > idx.order.length) {
    idx.order = idx.order.slice(idx.head);
    idx.head = 0;
  }
}

export function indexEvictBefore(idx, sec) {
  while (idx.head < idx.order.length && idx.order[idx.head].createSec < sec) removeEntry(idx, idx.order[idx.head++]);
  compact(idx);
}

export const indexSize = (idx) => idx.byMint.size;

// Matches of a keyword ({ norm, variants }) created in [fromSec, toSec]: [{ entry, kind }] by createSec.
export function indexFind(idx, kw, { fromSec = -Infinity, toSec = Infinity } = {}) {
  const cands = new Set();
  for (const v of kw.variants?.length ? kw.variants : [kw.norm]) for (const p of ["s:", "n:", "w:"]) for (const e of idx.byKey.get(p + v) || []) cands.add(e);
  if (kw.norm.length >= FUZZY_MIN_LEN) for (const n of [kw.norm.length - 1, kw.norm.length, kw.norm.length + 1]) for (const e of idx.byLen.get(n) || []) cands.add(e);
  const out = [];
  for (const e of cands) {
    if (!(e.createSec >= fromSec && e.createSec <= toSec)) continue;
    const kind = matchKind(kw, e.keys);
    if (kind) out.push({ entry: e, kind });
  }
  return out.sort((a, b) => a.entry.createSec - b.entry.createSec || (a.entry.mint < b.entry.mint ? -1 : 1));
}

// The matches of one keyword event split around the post: before = created in [post - beforeSec, post),
// after = [post, post + afterSec]; generic from the 24 h before the post.
export function matchEvent(idx, ev, { beforeSec = BEFORE_SEC, afterSec = AFTER_SEC } = {}) {
  const all = indexFind(idx, ev, { fromSec: ev.postSec - Math.max(beforeSec, GENERIC_WINDOW_SEC), toSec: ev.postSec + afterSec });
  const before = all.filter((m) => m.entry.createSec < ev.postSec && m.entry.createSec >= ev.postSec - beforeSec);
  const after = all.filter((m) => m.entry.createSec >= ev.postSec);
  return { before, after, generic: isGeneric(all.map((m) => m.entry), ev.postSec) };
}

// "generic": the keyword already had more than 5 matching creates in the 24 h before the post
// (pepe / doge words that always exist). `creates`: [{ createSec }] of the keyword's matches.
export function isGeneric(creates, postSec, { windowSec = GENERIC_WINDOW_SEC, min = GENERIC_MIN } = {}) {
  let n = 0;
  for (const c of creates) if (c.createSec < postSec && c.createSec >= postSec - windowSec) n += 1;
  return n >= min;
}

// Keyword events of a post list in time order; the same norm again within 24 h is repeat: true
// (counted once in the summaries). Returns [{ eventId, postId, postSec, kind, kw, norm, variants,
// reason, weight, repeat }].
export function keywordEvents(posts, extract, { repeatWindowSec = REPEAT_WINDOW_SEC } = {}) {
  const lastSeen = new Map();
  const out = [];
  const sorted = [...posts].sort((a, b) => a.postMs - b.postMs);
  for (const p of sorted) {
    const postSec = Math.floor(p.postMs / 1000);
    for (const k of extract(p)) {
      const prev = lastSeen.get(k.norm);
      const repeat = prev !== undefined && postSec - prev < repeatWindowSec;
      if (!repeat) lastSeen.set(k.norm, postSec);
      out.push({ eventId: `${p.id}:${k.norm}`, postId: p.id, postSec, postMs: p.postMs, kind: p.kind, kw: k.kw, norm: k.norm, variants: k.variants, reason: k.reason, weight: k.weight, repeat });
    }
  }
  return out;
}

// ---- "linked": the token's metadata points at THIS post ---------------------------------------------
// A metadata JSON (the create's uri) -> { linked, linkedField, elonStatus }:
//   linked      a twitter / website / description / ... field contains the post id or an
//               x.com|twitter.com/elonmusk/status/<id> URL of this post
//   elonStatus  some field contains an elonmusk/status URL (maybe of another post)
const ELON_STATUS_RE = /(?:x|twitter)\.com\/elonmusk\/status\/(\d{5,25})/i;
export function linkedInfo(meta, postId) {
  const out = { linked: false, linkedField: null, elonStatus: null };
  if (!meta || typeof meta !== "object") return out;
  const fields = ["twitter", "website", "telegram", "description", "name", "symbol"];
  const ext = meta.extensions && typeof meta.extensions === "object" ? meta.extensions : {};
  for (const f of fields) {
    for (const v of [meta[f], ext[f]]) {
      if (typeof v !== "string" || !v) continue;
      const m = v.match(ELON_STATUS_RE);
      if (m && !out.elonStatus) out.elonStatus = m[1];
      if (postId && (v.includes(String(postId)) || (m && m[1] === String(postId)))) {
        out.linked = true;
        out.linkedField = f;
        return out;
      }
    }
  }
  return out;
}

// The uri of a create -> a fetchable https URL, or null (only https and ipfs; never a local or private
// host: the uri is chosen by whoever launched the token).
export function metadataUrl(uri) {
  if (typeof uri !== "string" || uri.length > 400) return null;
  const s = uri.trim();
  if (s.startsWith("ipfs://")) {
    const cid = s.slice(7).replace(/^ipfs\//, "");
    // a CID (base58 / base32, no dots), optionally a sub-path without ".." segments
    return /^[A-Za-z0-9]{20,100}(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(cid) && !cid.includes("..") ? `https://ipfs.io/ipfs/${cid}` : null;
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return null; // bare IPs (incl. private ranges)
  if (u.username || u.password) return null;
  return u.toString();
}

// The uri plus public IPFS gateways for the same CID (ipfs.io answers 429 to bursts, seen 2026-11-23).
export const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
export function metadataUrls(uri) {
  const first = metadataUrl(uri);
  if (!first) return [];
  const m = new URL(first).pathname.match(/^\/ipfs\/([A-Za-z0-9]{20,100})(\/[A-Za-z0-9/._-]*)?$/);
  if (!m) return [first];
  return [...new Set([first, ...IPFS_GATEWAYS.map((g) => g + m[1] + (m[2] || ""))])];
}
