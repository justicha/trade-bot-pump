// Census curve price path (KODING #24): one `census_path` row per mint whose fill reaches
// CENSUS_PATH_MIN_FILL, so curve entry / TP / SL rules can be backtested offline second by second.
//
// Research only, pure: no I/O, no RPC, no key. lib/mint-census.mjs feeds every trade event of a live
// mint here (`pathTrade`) and asks for the row when the mint finishes (`pathRow`, the same moment and
// the same `final` as its census_mint row). censusRev stays 3; the row carries its own `pathRev`.
//
// Row (columnar arrays of equal length, one entry per on-chain SECOND with >= 1 trade; seconds
// without trades are absent):
//   t        seconds from t0 (t0 = createSec when the create was seen, else the mint's first event
//            second; `t0Source` "create" | "first")
//   o h l c  fill (2 decimals; the census fill incl. fillSource rules and the badFill / 99.99 caps) of
//            the first / max / min / last event of that second in stream order (events without a fill
//            are left out; all four null when the second had none)
//   pc       SOL price of the last priced event of that second (6 significant digits), null if none
//   nb ns    buy / sell counts;  bs ss  buy / sell SOL (4 decimals; the event's sol amount field)
//   nw       wallets seen for the first time on this mint (this part, see `resumed`) in that second
// The path starts at the mint's first observed trade and ends at the finish or at maxSec after the
// threshold second (`cut: "maxSec"`: later events are not bucketed). At most maxBuckets buckets: on
// overflow the first ones are kept and `truncated: true`. `endT` = the end of the covered window
// (the finish, capped at the maxSec cut): a hole after the last bucket means trades may be missing.
// Holes (`holes: [[fromT, toT, "gap" | "stall"], ...]`): census_gap windows and process stalls that
// overlap [first bucket, endT], in the same t scale. Gap: from = the newest on-chain second seen
// before the silence, to = the newest on-chain second after the first event that ended it (or
// from + silence at the stop). Stall: from = the newest on-chain second at the last timer tick before
// the stall, to = from + stall length + 1. Nothing is guessed inside a hole.
// A resumed mint (trades again after its idle row) gets a new buffer: its row has `resumed: true`
// and covers only the resumed part; it is written when that part reaches the threshold OR the mint
// reached it before (`thresholdBefore: true`; thresholdSec is then this part's own crossing or null,
// and the maxSec cut still counts from the mint's first threshold second).
// Out-of-order seconds (an event older than the newest bucket) go into their own second's bucket;
// counted in `outOfOrder`.

export const PATH_REV = 1;
export const DEFAULT_PATH_MIN_FILL = 25;
export const DEFAULT_PATH_MAX_SEC = 3600;
export const DEFAULT_PATH_MAX_BUCKETS = 4000;
const HOLES_MAX = 2000; // kept holes (a day has ~10-50 gaps)
const HOLE_KEEP_SEC = 48 * 3600;

// One bucket = STRIDE float64 slots (NaN = null): t (absolute on-chain second), o, h, l, c, pc,
// nb, ns, bs, ss, nw. A typed array keeps a bucket at 88 bytes (plain arrays with nulls box numbers).
const T = 0, O = 1, H = 2, L = 3, Cc = 4, PC = 5, NB = 6, NS = 7, BS = 8, SS = 9, NW = 10;
const STRIDE = 11;
const INITIAL_BUCKETS = 8;

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const sig6 = (x) => Number(x.toPrecision(6));
const nn = (x) => (Number.isNaN(x) ? null : x);

export function createPathStore({ minFill = DEFAULT_PATH_MIN_FILL, maxSec = DEFAULT_PATH_MAX_SEC, maxBuckets = DEFAULT_PATH_MAX_BUCKETS } = {}) {
  return {
    cfg: { minFill, maxSec, maxBuckets },
    holes: [], // { from, to (null while a gap is open), kind }
    buffers: 0, // live buffers
    buckets: 0, // buckets in live buffers
    counts: { pathRows: 0, pathBytes: 0, pathDropped: 0, pathTruncated: 0, pathCut: 0, pathOutOfOrder: 0 },
  };
}

function newBuffer() {
  // thrAbs: the first BUCKET with h >= minFill; reached: any event of this part had fill >= minFill
  // (also one not bucketed after a truncation)
  return { a: new Float64Array(INITIAL_BUCKETS * STRIDE), n: 0, thrAbs: null, reached: false, cut: false, truncated: false, outOfOrder: 0 };
}

function grow(b) {
  const a = new Float64Array(b.a.length * 2);
  a.set(b.a);
  b.a = a;
}

function initBucket(a, i, sec) {
  const o = i * STRIDE;
  a[o + T] = sec;
  a[o + O] = NaN;
  a[o + H] = NaN;
  a[o + L] = NaN;
  a[o + Cc] = NaN;
  a[o + PC] = NaN;
  a[o + NB] = 0;
  a[o + NS] = 0;
  a[o + BS] = 0;
  a[o + SS] = 0;
  a[o + NW] = 0;
}

// The bucket index for `sec` (created if needed), or -1 when it cannot be kept (cap).
function bucketFor(ps, b, sec) {
  const a = b.a;
  const last = b.n - 1;
  if (last >= 0 && a[last * STRIDE + T] === sec) return last;
  let at = b.n; // insert position
  if (last >= 0 && sec < a[last * STRIDE + T]) {
    b.outOfOrder += 1;
    ps.counts.pathOutOfOrder += 1;
    let j = last;
    while (j >= 0 && a[j * STRIDE + T] > sec) j -= 1;
    if (j >= 0 && a[j * STRIDE + T] === sec) return j;
    at = j + 1;
  }
  if (b.n >= ps.cfg.maxBuckets) {
    if (!b.truncated) ps.counts.pathTruncated += 1;
    b.truncated = true;
    return -1;
  }
  if ((b.n + 1) * STRIDE > b.a.length) grow(b);
  if (at < b.n) b.a.copyWithin((at + 1) * STRIDE, at * STRIDE, b.n * STRIDE);
  initBucket(b.a, at, sec);
  b.n += 1;
  ps.buckets += 1;
  return at;
}

// One trade event of a live mint. `fill` null = an event without a fill (counted, not in o/h/l/c);
// `price` null = no SOL snapshot. `newWallet`: the trader was not seen on this mint (part) before.
export function pathTrade(ps, rec, { sec, fill = null, price = null, isBuy = false, sol = 0, newWallet = false }) {
  if (!Number.isFinite(sec)) return;
  if (!rec.path) {
    rec.path = newBuffer();
    ps.buffers += 1;
  }
  const b = rec.path;
  const thrAbs = rec.pathThrAbs ?? null; // the mint's first threshold second (an earlier part's for a resumed one)
  if (thrAbs !== null && sec > thrAbs + ps.cfg.maxSec) {
    if (!b.cut) ps.counts.pathCut += 1;
    b.cut = true;
    return;
  }
  const hit = fill !== null && Number.isFinite(fill) && fill >= ps.cfg.minFill;
  if (hit) {
    b.reached = true;
    if (rec.pathThrAbs === null || rec.pathThrAbs === undefined || sec < rec.pathThrAbs) rec.pathThrAbs = sec;
  }
  const i = bucketFor(ps, b, sec);
  if (i < 0) return;
  const a = b.a;
  const o = i * STRIDE;
  if (fill !== null && Number.isFinite(fill)) {
    if (Number.isNaN(a[o + O])) a[o + O] = fill;
    if (Number.isNaN(a[o + H]) || fill > a[o + H]) a[o + H] = fill;
    if (Number.isNaN(a[o + L]) || fill < a[o + L]) a[o + L] = fill;
    a[o + Cc] = fill;
    if (hit && (b.thrAbs === null || sec < b.thrAbs)) b.thrAbs = sec;
  }
  if (price !== null && price > 0) a[o + PC] = price;
  const s = Number(sol) > 0 ? Number(sol) : 0;
  if (isBuy) {
    a[o + NB] += 1;
    a[o + BS] += s;
  } else {
    a[o + NS] += 1;
    a[o + SS] += s;
  }
  if (newWallet) a[o + NW] += 1;
}

// ---- holes ------------------------------------------------------------------------------------------
export function openGapHole(ps, fromSec) {
  const h = { from: fromSec, to: null, kind: "gap" };
  pushHole(ps, h);
  return h;
}
export function closeHole(h, toSec) {
  if (h && h.to === null) h.to = Math.max(h.from, toSec);
}
export function stallHole(ps, fromSec, stallSec) {
  const h = { from: fromSec, to: fromSec + Math.ceil(stallSec) + 1, kind: "stall" };
  pushHole(ps, h);
  return h;
}
function pushHole(ps, h) {
  ps.holes.push(h);
  if (ps.holes.length > HOLES_MAX) ps.holes.splice(0, ps.holes.length - HOLES_MAX);
}
export function trimHoles(ps, nowSec) {
  const cut = nowSec - HOLE_KEEP_SEC;
  ps.holes = ps.holes.filter((h) => h.to === null || h.to >= cut);
}

// ---- the row ----------------------------------------------------------------------------------------
// Drops the mint's buffer. Returns the census_path row, or null (below the threshold / no buffer).
// `endSec`: the on-chain second the mint finished at (complete: its last event; idle / shutdown: the
// stream clock). `streamSec`: the stream clock (closes a still-open gap hole).
export function pathRow(ps, rec, final, { endSec, streamSec, censusRev }) {
  const b = rec.path;
  if (!b) return null;
  rec.path = null;
  ps.buffers -= 1;
  ps.buckets -= b.n;
  // an earlier part of this mint reached the threshold (set below when that part finished)
  const before = !!rec.pathReachedBefore;
  if (b.reached) rec.pathReachedBefore = true;
  if (b.n === 0 || (!b.reached && !before)) {
    ps.counts.pathDropped += 1;
    return null;
  }
  const createSeen = !!rec.createSeen && rec.createSec !== null;
  const t0 = createSeen ? rec.createSec : rec.firstSec ?? (b.n ? b.a[T] : endSec);
  const n = b.n;
  const a = b.a;
  const col = (k, f) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = f(a[i * STRIDE + k]);
    return out;
  };
  const fillOut = (x) => (Number.isNaN(x) ? null : r2(x));
  const thrRef = rec.pathThrAbs ?? null;
  let end = Number.isFinite(endSec) ? endSec : n ? a[(n - 1) * STRIDE + T] : t0;
  if (thrRef !== null && end > thrRef + ps.cfg.maxSec) end = thrRef + ps.cfg.maxSec;
  const start = n ? a[T] : end;
  const holes = [];
  for (const h of ps.holes) {
    const to = h.to === null ? Math.max(h.from, streamSec ?? h.from) : h.to;
    if (h.from <= end && to >= start) holes.push([h.from - t0, to - t0, h.kind]);
  }
  const row = {
    type: "census_path",
    censusRev,
    pathRev: PATH_REV,
    mint: rec.mint,
    mayhem: rec.mayhem ?? null,
    ...(rec.quoteMint ? { quoteMint: rec.quoteMint } : {}),
    createSeen,
    t0,
    t0Source: createSeen ? "create" : "first",
    minFill: ps.cfg.minFill,
    thresholdSec: b.thrAbs === null ? null : b.thrAbs - t0,
    ...(before ? { thresholdBefore: true } : {}),
    final,
    migrated: final === "complete" ? true : final === "idle" ? false : null,
    completeSec: rec.completeSec !== null && rec.completeSec !== undefined ? rec.completeSec - t0 : null,
    endT: end - t0,
    ...(rec.resumed ? { resumed: true } : {}),
    ...(b.cut ? { cut: "maxSec" } : {}),
    ...(b.truncated ? { truncated: true } : {}),
    ...(b.outOfOrder ? { outOfOrder: b.outOfOrder } : {}),
    buckets: n,
    holes,
    t: col(T, (x) => x - t0),
    o: col(O, fillOut),
    h: col(H, fillOut),
    l: col(L, fillOut),
    c: col(Cc, fillOut),
    pc: col(PC, (x) => (Number.isNaN(x) ? null : sig6(x))),
    nb: col(NB, (x) => x),
    ns: col(NS, (x) => x),
    bs: col(BS, r4),
    ss: col(SS, r4),
    nw: col(NW, (x) => x),
  };
  ps.counts.pathRows += 1;
  ps.counts.pathBytes += JSON.stringify(row).length + 1;
  return row;
}

// The mint was dropped without a row (no finish): free the buffer.
export function dropPath(ps, rec) {
  if (!rec.path) return;
  ps.buffers -= 1;
  ps.buckets -= rec.path.n;
  rec.path = null;
}

export function pathStats(ps) {
  return { pathMints: ps.buffers, pathBuckets: ps.buckets, ...ps.counts, pathHoles: ps.holes.length };
}

// ---- offline checks (scripts/census-path-check.mjs and the tests) -------------------------------------
// Milestone consistency: for each census_mint milestone m of the same mint (and part), the first
// bucket with h >= m must be the milestone's second (t0 + t === milestone.sec). Milestones outside the
// path (an earlier part of a resumed mint, after a cut / truncation) are skipped. Returns
// { checked, skipped, mismatches: [{ m, milestoneSec, bucketSec }] }.
export function checkMilestones(pathRow, mintRow) {
  const out = { checked: 0, skipped: 0, mismatches: [] };
  const ms = mintRow?.milestones;
  if (!ms || !pathRow?.t?.length) return out;
  const first = pathRow.t0 + pathRow.t[0];
  const last = pathRow.t0 + pathRow.t[pathRow.t.length - 1];
  for (const [k, s] of Object.entries(ms)) {
    const m = Number(k);
    if (s.sec < first || ((pathRow.cut || pathRow.truncated) && s.sec > last)) {
      out.skipped += 1;
      continue;
    }
    out.checked += 1;
    let at = null;
    for (let i = 0; i < pathRow.h.length; i++) {
      if (pathRow.h[i] !== null && pathRow.h[i] >= m) {
        at = pathRow.t0 + pathRow.t[i];
        break;
      }
    }
    if (at !== s.sec) out.mismatches.push({ m, milestoneSec: s.sec, bucketSec: at });
  }
  return out;
}
