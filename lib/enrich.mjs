// Read-only "who is behind the token" enrichment for historical pump.fun mints.
//
// Everything here is pure or works through an injected, read-only `rpc` interface, so the whole
// pipeline runs offline in tests against recorded fixtures:
//   rpc.getSignatures(address, { before, limit }) -> [{ signature, slot, blockTime, err }] newest first
//   rpc.getTransaction(signature)                 -> compact tx (see normalizeTx) or null
//   rpc.getAccountInfo(address)                   -> { owner: base58, data: Buffer } or null
//   fetchJson(url)                                -> parsed JSON (throws on failure)
// No keypair, no signing, no sending. Nothing in this module knows the RPC URL.
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { parseTrade, parseCreate, prefixHex, tradeCreator, toBase58Safe } from "./events.mjs";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const METAPLEX_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
// Anchor emit_cpi: the event is the data of a self-CPI into the program, prefixed by this tag.
const EVENT_IX_TAG = "e445a52e51cb9a1d";
const CREATE_PREFIX = "1b72a94ddeeb6376";
const TRADE_PREFIX = "bddb7fd34ee661ee";

export const DEFAULTS = {
  maxPages: 40, // getSignaturesForAddress pages of 1000 (wallets)
  mintMaxPages: 200, // the mint's own history: 1 call per 1000 sigs, far cheaper than the creator path
  priorCap: 300, // creator transactions scanned for prior creates
  fundingScan: 10, // oldest creator transactions scanned for the first funding
  earlyTxCap: 400, // mint transactions fetched for same-slot / first-20 buys
  first: 20,
};

// ---- input -------------------------------------------------------------------------------------

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Batch lines "<n>  <mint>  <YYYY-MM-DD HH:MM:SS>" (entry time UTC) or a bare mint per line.
// Blank lines and '#' comments are skipped; anything else unparseable is reported, not dropped.
export function parseInputText(text) {
  const rows = [];
  const bad = [];
  for (const [i, raw] of String(text).split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    let m = /^(\d+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})Z?$/.exec(line);
    if (m && MINT_RE.test(m[2])) {
      rows.push({ n: Number(m[1]), mint: m[2], entryUtc: `${m[3]} ${m[4]}` });
    } else if (parts.length === 1 && MINT_RE.test(parts[0])) {
      rows.push({ n: null, mint: parts[0], entryUtc: null });
    } else {
      bad.push({ line: i + 1, text: line.slice(0, 80) });
    }
  }
  return { rows, bad };
}

// Mints already written to an output JSONL (resume). Broken lines are ignored, so a mint whose
// line was cut off by a crash is simply re-done. retryErrors: a line with a non-empty `errors`
// does not count as done either.
export function doneMints(jsonlText, { retryErrors = false, retryMatch = null } = {}) {
  return new Set(keptLines(jsonlText, { retryErrors, retryMatch }).map((k) => k.mint));
}

// The lines of an output JSONL that stay on a resume: parseable, with a mint, the last line per
// mint, and (retryErrors) without errors. Used to rewrite the file before re-running mints.
// retryMatch (a RegExp): only errors matching it count, so permanent ones (a capped wallet
// history, a dead metadata link) are not re-run.
export function keptLines(jsonlText, { retryErrors = false, retryMatch = null, keepAll = false } = {}) {
  const byMint = new Map();
  for (const line of String(jsonlText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // partial line
    }
    if (!o || typeof o.mint !== "string") continue;
    const errs = Array.isArray(o.errors) ? o.errors : [];
    byMint.set(o.mint, { mint: o.mint, line, hasErrors: retryMatch ? errs.some((e) => retryMatch.test(e)) : errs.length > 0 });
  }
  return [...byMint.values()].filter((k) => keepAll || !((retryErrors || retryMatch) && k.hasErrors));
}

export function entryToSec(entryUtc) {
  if (!entryUtc) return null;
  const t = Date.parse(entryUtc.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export const secToUtc = (sec) => (sec == null ? null : new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 19));

// ---- transactions ------------------------------------------------------------------------------

// web3.js getTransaction (maxSupportedTransactionVersion 0) -> the compact form used everywhere
// here (and stored in fixtures): public keys, balances and raw pump.fun event payloads only.
export function normalizeTx(resp, signature) {
  if (!resp || !resp.transaction || !resp.meta) return null;
  const msg = resp.transaction.message;
  const statics = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) => String(k?.pubkey ?? k));
  const loaded = resp.meta.loadedAddresses ?? { writable: [], readonly: [] };
  const keys = [...statics, ...(loaded.writable ?? []).map(String), ...(loaded.readonly ?? []).map(String)];
  const nSigners = msg.header?.numRequiredSignatures ?? 1;
  // Events: the emit_cpi copies in the inner instructions are complete even when the log is
  // truncated; the "Program data:" log lines are the fallback for txs without them.
  const inner = [];
  for (const group of resp.meta.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      if (keys[ix.programIdIndex] !== PUMP_PROGRAM_ID) continue;
      let d;
      try {
        d = Buffer.from(typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data);
      } catch {
        continue;
      }
      if (d.length > 16 && d.subarray(0, 8).toString("hex") === EVENT_IX_TAG) inner.push(d.subarray(8).toString("base64"));
    }
  }
  const fromLogs = [];
  let pumpInvoked = false;
  for (const line of resp.meta.logMessages ?? []) {
    if (line.startsWith(`Program ${PUMP_PROGRAM_ID} invoke`)) pumpInvoked = true;
    if (line.startsWith("Program data: ")) {
      const b = Buffer.from(line.slice(14), "base64");
      const p = prefixHex(b);
      if (p === TRADE_PREFIX || p === CREATE_PREFIX) fromLogs.push(line.slice(14));
    }
  }
  return {
    sig: signature ?? resp.transaction.signatures?.[0] ?? null,
    slot: resp.slot ?? null,
    blockTime: resp.blockTime ?? null,
    err: resp.meta.err ? true : false,
    keys,
    signers: keys.slice(0, nSigners),
    pre: [...resp.meta.preBalances],
    post: [...resp.meta.postBalances],
    pumpInvoked: pumpInvoked || inner.length > 0,
    events: inner.length > 0 ? inner : fromLogs,
    eventsFrom: inner.length > 0 ? "inner" : "logs",
  };
}

// Trade-event fee fields (pump.fun IDL, same anchoring as events.tradeCreator): 161 fee_bps,
// 169 fee, 209 creator_fee_bps, 217 creator_fee. null when the payload is too short.
export function tradeFees(buf) {
  if (!buf || buf.length < 225) return null;
  try {
    if (buf.readBigUInt64LE(161) > 10_000n || buf.readBigUInt64LE(209) > 10_000n) return null;
    return { feeSol: Number(buf.readBigUInt64LE(169)) / 1e9, creatorFeeSol: Number(buf.readBigUInt64LE(217)) / 1e9 };
  } catch {
    return null;
  }
}

// Legacy CreateEvent (pump.fun `create` before the launch reserves were added to the event,
// seen on a 2025-04 mint): name, symbol, uri, mint, bonding_curve, user, creator, timestamp —
// no reserves, so lib/events parseCreate (which anchors on them) returns null. Only used as the
// fallback here; the bots keep parseCreate. creator/timestamp are read only when present.
export function parseCreateLegacy(b) {
  if (!b || b.length < 8 + 12 + 96 || prefixHex(b) !== CREATE_PREFIX) return null;
  try {
    let o = 8;
    const str = () => {
      const len = b.readUInt32LE(o);
      if (len > 512 || o + 4 + len > b.length) throw new Error("bad string");
      const v = b.subarray(o + 4, o + 4 + len).toString("utf8");
      o += 4 + len;
      return v;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    if (o + 96 > b.length) return null;
    const key = (k) => toBase58Safe(b.subarray(o + 32 * k, o + 32 * k + 32));
    const mint = key(0);
    const bondingCurve = key(1);
    const user = key(2);
    const creator = o + 128 <= b.length ? key(3) : user;
    const timestampSec = o + 136 <= b.length ? Number(b.readBigUInt64LE(o + 128)) : null;
    return { prefix: CREATE_PREFIX, len: b.length, name, symbol, uri, mint, bondingCurve, user, creator, timestampSec, legacy: true };
  } catch {
    return null;
  }
}

// Decoded events of one compact tx: { type: "create", ... } / { type: "trade", user, isBuy,
// solNet, solGross, ... }. solGross = what the trader paid in: sol_amount + protocol fee +
// creator fee (this is what explorers and pump.fun show; solNet is what reached the curve).
export function txEvents(tx) {
  const out = [];
  for (const b64 of tx?.events ?? []) {
    const b = Buffer.from(b64, "base64");
    const p = prefixHex(b);
    if (p === CREATE_PREFIX) {
      const c = parseCreate(b) ?? parseCreateLegacy(b);
      if (c) out.push({ type: "create", ...c, tail: undefined, tailHex: undefined });
    } else if (p === TRADE_PREFIX) {
      const t = parseTrade(b);
      if (!t) continue;
      const fees = tradeFees(b);
      out.push({
        type: "trade",
        mint: t.mint,
        user: t.user,
        creator: tradeCreator(b),
        isBuy: t.isBuy,
        solNet: t.solAmount,
        solGross: fees ? round9(t.solAmount + fees.feeSol + fees.creatorFeeSol) : null,
        tokenAmount: t.tokenAmount,
      });
    }
  }
  return out;
}

const round9 = (x) => (x == null ? null : Math.round(x * 1e9) / 1e9);

// ---- signatures --------------------------------------------------------------------------------

// All signatures of an address (newest first), starting before `before` when given.
// capped = the page cap was hit, so the list does not reach the address's first transaction.
// `until` (exclusive) stops the walk at that signature: with before/until the call returns one
// window of the history.
export async function paginateSignatures(rpc, address, { before, until, maxPages = DEFAULTS.maxPages, pageSize = 1000 } = {}) {
  const sigs = [];
  let cursor = before;
  for (let p = 0; p < maxPages; p++) {
    const page = await rpc.getSignatures(address, until ? { before: cursor, until, limit: pageSize } : { before: cursor, limit: pageSize });
    sigs.push(...page);
    if (page.length < pageSize) return { sigs, capped: false, pages: p + 1 };
    cursor = page[page.length - 1].signature;
  }
  return { sigs, capped: true, pages: maxPages };
}

// ---- creation ----------------------------------------------------------------------------------

// The pump.fun create among the oldest signatures (oldest first). Usually the very first one;
// a few failed/foreign txs may precede it, so up to `scan` successful ones are inspected.
export async function findCreate(rpc, mint, oldestFirst, { scan = 5 } = {}) {
  let looked = 0;
  for (const s of oldestFirst) {
    if (s.err) continue;
    if (looked++ >= scan) break;
    const tx = await rpc.getTransaction(s.signature);
    const ev = txEvents(tx).find((e) => e.type === "create" && e.mint === mint);
    if (ev) return { sig: s.signature, tx, create: ev };
  }
  return null;
}

// ---- long histories ----------------------------------------------------------------------------
// A mint with more signatures than the page cap never reaches its create through its own history.
// Then: creator = the creator field of the newest pump.fun trade event (lib/events tradeCreator),
// or, when the newest txs carry none (a migrated token trades on PumpSwap), the creator stored in
// the bonding-curve account; the create = the creator's own tx that created this mint; the early
// window = the mint's signatures between the create and the creator's next tx (before/until).

export function bondingCurvePda(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM_ID))[0].toBase58();
}

// Bonding-curve account: 8 discriminator, 5 x u64 reserves/supply, complete (bool) @48,
// creator @49..81 (layout as in lib/pumpfun getBondingCurveState).
export function curveCreator(data) {
  if (!data || data.length < 81) return null;
  const key = data.subarray(49, 81);
  return key.every((b) => b === 0) ? null : toBase58Safe(key);
}

export async function creatorFromNewest(rpc, mint, newestFirst, { scan = 10 } = {}) {
  let n = 0;
  for (const s of newestFirst) {
    if (s.err) continue;
    if (n++ >= scan) break;
    const ev = txEvents(await rpc.getTransaction(s.signature)).find((e) => e.type === "trade" && e.mint === mint && e.creator);
    if (ev) return { creator: ev.creator, source: "trade" };
  }
  const acc = await rpc.getAccountInfo(bondingCurvePda(mint));
  const c = acc ? curveCreator(acc.data) : null;
  return c ? { creator: c, source: "curve" } : null;
}

// The create of `mint` among the creator's txs no newer than `maxSlot` (the oldest mint tx seen).
// Returns the create plus the creator's full list (newest first) and the creator's next signature
// after the create (the anchor of the early window).
export async function findCreateViaCreator(rpc, mint, creator, { maxPages = DEFAULTS.maxPages, maxSlot = Infinity, scan = DEFAULTS.priorCap } = {}) {
  const h = await paginateSignatures(rpc, creator, { maxPages });
  let looked = 0;
  for (let i = 0; i < h.sigs.length; i++) {
    const s = h.sigs[i];
    if (s.err || s.slot > maxSlot) continue;
    if (looked++ >= scan) break;
    const tx = await rpc.getTransaction(s.signature);
    // Not createdBy(): a launcher's create is signed by the deployer, not by the creator address.
    const create = tx && !tx.err ? txEvents(tx).find((e) => e.type === "create" && e.mint === mint) : null;
    if (!create) continue;
    return { sig: s.signature, tx, create, creatorSigs: h.sigs, creatorCapped: h.capped, index: i, anchor: i > 0 ? h.sigs[i - 1].signature : null };
  }
  return { notFound: true, creatorCapped: h.capped, scanned: looked };
}

// ---- early buys --------------------------------------------------------------------------------

// Buy events of `mint` in chronological order (slot, then tx order within the slot, then event
// order within the tx). Within a slot the tx order is the reverse of getSignaturesForAddress
// (the RPC lists newest first), which the caller's oldestFirst list already encodes.
export function buysOf(mint, txsInOrder) {
  const buys = [];
  for (const tx of txsInOrder) {
    if (!tx || tx.err) continue;
    for (const e of txEvents(tx)) {
      if (e.type === "trade" && e.isBuy && e.mint === mint) {
        buys.push({ user: e.user, solGross: e.solGross, solNet: e.solNet, slot: tx.slot, blockTime: tx.blockTime, sig: tx.sig });
      }
    }
  }
  return buys;
}

// Early-buyer facts from the ordered buy list. The dev buy is included in the first-20 numbers;
// first20ExDevSol is the same 20 events without the creator's.
// "Dev" = the creator and the deployer (the create's signer, when it differs from the creator).
export function summarizeBuys(buys, { createSig, createSlot, createdAtSec, creator, deployer = null, first = DEFAULTS.first }) {
  const sum = (arr, k) => round9(arr.reduce((a, b) => a + (b[k] ?? 0), 0));
  const isDev = (u) => u === creator || (deployer != null && u === deployer);
  const dev = buys.filter((b) => b.sig === createSig && isDev(b.user));
  const sameSlot = buys.filter((b) => b.slot === createSlot && !isDev(b.user));
  const sameSecond = buys.filter((b) => b.blockTime === createdAtSec && !isDev(b.user));
  const f = buys.slice(0, first);
  const fExDev = f.filter((b) => !isDev(b.user));
  return {
    devBuySol: sum(dev, "solGross"),
    devBuySolNet: sum(dev, "solNet"),
    sameSlotBuyers: new Set(sameSlot.map((b) => b.user)).size,
    sameSlotBuySol: sum(sameSlot, "solGross"),
    sameSecondBuyers: new Set(sameSecond.map((b) => b.user)).size,
    sameSecondBuySol: sum(sameSecond, "solGross"),
    first20Complete: f.length >= first,
    first20Count: f.length,
    first20BuyersSol: sum(f, "solGross"),
    first20BuyersSolNet: sum(f, "solNet"),
    first20ExDevSol: sum(fExDev, "solGross"),
    first20Wallets: new Set(f.map((b) => b.user)).size,
    first20WalletList: [...new Set(f.map((b) => b.user))],
    first20LastBlockTime: f.length ? f[f.length - 1].blockTime : null,
  };
}

// Fetch the mint's earliest successful txs (oldest first) until the create slot and the create
// second are covered AND `first` buy events are seen, or `cap` txs were fetched.
export async function collectEarly(rpc, mint, oldestFirst, { createSlot, createdAtSec, first = DEFAULTS.first, cap = DEFAULTS.earlyTxCap }) {
  const txs = [];
  let buyCount = 0;
  let fetched = 0;
  for (const s of oldestFirst) {
    if (s.err) continue;
    const inWindow = s.slot === createSlot || (s.blockTime != null && s.blockTime === createdAtSec);
    if (!inWindow && buyCount >= first) break;
    if (fetched >= cap) return { txs, capped: true };
    const tx = await rpc.getTransaction(s.signature);
    fetched += 1;
    if (!tx) continue;
    txs.push(tx);
    buyCount += buysOf(mint, [tx]).length;
  }
  return { txs, capped: false };
}

// ---- creator -----------------------------------------------------------------------------------

// SOL inflow to `wallet` in one tx from another account: the wallet's balance went up and the
// funder is the other account with the largest decrease. null when the wallet did not gain.
export function fundingFromTx(tx, wallet) {
  if (!tx || tx.err) return null;
  const i = tx.keys.indexOf(wallet);
  if (i < 0) return null;
  const gain = tx.post[i] - tx.pre[i];
  if (!(gain > 0)) return null;
  let best = null;
  for (let j = 0; j < tx.keys.length; j++) {
    if (j === i) continue;
    const d = tx.pre[j] - tx.post[j];
    if (d > 0 && (!best || d > best.d)) best = { j, d };
  }
  if (!best) return null;
  return { funder: tx.keys[best.j], fundedSol: gain / 1e9, sig: tx.sig, blockTime: tx.blockTime };
}

// First funding among the wallet's oldest successful txs (oldest first, at most `scan` fetched).
export async function findFunding(rpc, wallet, oldestFirst, { scan = DEFAULTS.fundingScan } = {}) {
  let n = 0;
  for (const s of oldestFirst) {
    if (s.err) continue;
    if (n++ >= scan) return { found: null, exhausted: true };
    const f = fundingFromTx(await rpc.getTransaction(s.signature), wallet);
    if (f) return { found: f, exhausted: false };
  }
  return { found: null, exhausted: false };
}

// A pump.fun create signed by `wallet` (the create event's user or creator is the wallet and the
// wallet signed the tx). Returns the created mint or null.
export function createdBy(tx, wallet) {
  if (!tx || tx.err || !tx.signers.includes(wallet)) return null;
  const c = txEvents(tx).find((e) => e.type === "create" && (e.user === wallet || e.creator === wallet));
  return c ? c.mint : null;
}

// Creates by `wallet` in its successful txs before the token's create (newest first). Scans at
// most `cap` txs; any unscanned successful tx makes the count a lower bound.
export async function countPriorCreates(rpc, wallet, newestFirstBefore, { cap = DEFAULTS.priorCap, beforeSlot } = {}) {
  const ok = newestFirstBefore.filter((s) => !s.err && (beforeSlot == null || s.slot < beforeSlot));
  const mints = [];
  for (const s of ok.slice(0, cap)) {
    const m = createdBy(await rpc.getTransaction(s.signature), wallet);
    if (m) mints.push(m);
  }
  return { count: mints.length, mints, lowerBound: ok.length > cap, scanned: Math.min(cap, ok.length) };
}

// Age, first funding and prior creates of one wallet from its history before the create.
// A wallet with no tx before the create (a fresh fee address) is a fact, not an error:
// txsBefore 0, age 0, funding null. `preset` = an already fetched history (newest first).
export async function walletFacts(rpc, wallet, { beforeSig, createSlot, createdAtSec, maxPages = DEFAULTS.maxPages, priorCap = DEFAULTS.priorCap, preset = null }) {
  const out = { txsBefore: null, firstTxSec: null, ageDays: null, ageIsLowerBound: null, fundedBy: null, fundedSol: null, fundedAtSec: null, priorTokens: null, priorIsLowerBound: null, errors: [] };
  try {
    const h = preset ?? (await paginateSignatures(rpc, wallet, { before: beforeSig, maxPages }));
    const oldestFirst = h.sigs.slice().reverse();
    out.txsBefore = h.sigs.length;
    out.ageIsLowerBound = h.capped;
    const firstSec = oldestFirst.length ? oldestFirst[0].blockTime : createdAtSec;
    out.firstTxSec = firstSec ?? null;
    if (firstSec != null && createdAtSec != null) out.ageDays = Math.round(((createdAtSec - firstSec) / 86400) * 1000) / 1000;
    if (h.capped) {
      out.errors.push("history capped, funding unknown");
    } else if (oldestFirst.some((x) => !x.err)) {
      const f = await findFunding(rpc, wallet, oldestFirst);
      if (f.found) {
        out.fundedBy = f.found.funder;
        out.fundedSol = round9(f.found.fundedSol);
        out.fundedAtSec = f.found.blockTime;
      } else {
        out.errors.push(f.exhausted ? "no funding in the oldest txs scanned" : "no funding found");
      }
    }
    const p = await countPriorCreates(rpc, wallet, h.sigs, { cap: priorCap, beforeSlot: createSlot });
    out.priorTokens = p.count;
    out.priorIsLowerBound = p.lowerBound || h.capped;
  } catch (e) {
    out.errors.push(shortErr(e));
  }
  return out;
}

// ---- metadata ----------------------------------------------------------------------------------

function readBorshString(buf, o) {
  const len = buf.readUInt32LE(o);
  if (len > 4096 || o + 4 + len > buf.length) throw new Error("bad string length");
  return { s: buf.subarray(o + 4, o + 4 + len).toString("utf8").replace(/\0+$/g, "").trim(), o: o + 4 + len };
}

// Metaplex Token Metadata account: key(1) update_authority(32) mint(32) name symbol uri (borsh
// strings, zero-padded to fixed widths by the program).
export function decodeMetaplexMetadata(data) {
  if (!data || data.length < 1 + 32 + 32 + 12) return null;
  try {
    let o = 1 + 32 + 32;
    const name = readBorshString(data, o);
    const symbol = readBorshString(data, name.o);
    const uri = readBorshString(data, symbol.o);
    return { name: name.s, symbol: symbol.s, uri: uri.s, source: "metaplex" };
  } catch {
    return null;
  }
}

// Token-2022 mint with the TokenMetadata extension (TLV type 19): base mint (82) padded to 165,
// account type byte (1 = mint), then TLV entries u16 type, u16 length. Metadata payload:
// update_authority(32) mint(32) name symbol uri additional_metadata.
export function decodeToken2022Metadata(data) {
  if (!data || data.length < 166 || data[165] !== 1) return null;
  let o = 166;
  try {
    while (o + 4 <= data.length) {
      const type = data.readUInt16LE(o);
      const len = data.readUInt16LE(o + 2);
      const start = o + 4;
      if (type === 0 && len === 0) break; // uninitialized tail
      if (type === 19) {
        const v = data.subarray(start, start + len);
        let p = 64;
        const name = readBorshString(v, p);
        const symbol = readBorshString(v, name.o);
        const uri = readBorshString(v, symbol.o);
        return { name: name.s, symbol: symbol.s, uri: uri.s, source: "token-2022" };
      }
      o = start + len;
    }
  } catch {
    return null;
  }
  return null;
}

export function metaplexPda(mint) {
  const prog = new PublicKey(METAPLEX_PROGRAM_ID);
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), prog.toBuffer(), new PublicKey(mint).toBuffer()], prog)[0].toBase58();
}

export function normalizeUri(uri, gateway = "https://ipfs.io/ipfs/") {
  if (!uri) return null;
  const u = uri.trim();
  if (u.startsWith("ipfs://")) return gateway + u.slice(7).replace(/^ipfs\//, "");
  if (u.startsWith("ar://")) return "https://arweave.net/" + u.slice(5);
  return /^https?:\/\//i.test(u) ? u : null;
}

// Socials from a metadata JSON: top-level twitter/telegram/website (pump.fun) or the
// extensions.* style; "x" is accepted as twitter. A present, non-empty string counts.
export function socialsFromJson(json) {
  const has = (...keys) => {
    for (const k of keys) {
      for (const src of [json, json?.extensions, json?.properties?.links]) {
        const v = src?.[k];
        if (typeof v === "string" && v.trim() !== "") return true;
      }
    }
    return false;
  };
  if (!json || typeof json !== "object") return { hasTwitter: null, hasTelegram: null, hasWebsite: null };
  return { hasTwitter: has("twitter", "x"), hasTelegram: has("telegram", "tg"), hasWebsite: has("website", "web") };
}

// Default JSON fetch: 8 s timeout, no credentials, nothing but a GET.
export async function fetchJsonDefault(url, { timeoutMs = 8000 } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!r.ok) throw new Error(`http ${r.status}`);
  return await r.json();
}

// Public IPFS gateways throttle (ipfs.io answers 429 under load): the same CID is tried on the
// next gateway. Non-IPFS URLs get the one URL. `fetchOne` is injectable for tests.
export const IPFS_GATEWAYS = ["https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://gateway.pinata.cloud/ipfs/"];
export function gatewayCandidates(url) {
  const m = /^https?:\/\/[^/]+\/ipfs\/(.+)$/i.exec(url ?? "");
  if (!m) return url ? [url] : [];
  return [url, ...IPFS_GATEWAYS.map((g) => g + m[1]).filter((u) => u !== url)];
}
export async function fetchJsonWithFallback(url, { fetchOne = fetchJsonDefault } = {}) {
  let last;
  for (const u of gatewayCandidates(url)) {
    try {
      return await fetchOne(u);
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no url");
}

// ---- lookahead ---------------------------------------------------------------------------------

// null = cannot tell (no entry time, or the create is unknown, so no dated fact is used).
// The early-buy check uses the last buy actually counted (all 20, or fewer when incomplete).
export function lookahead(entrySec, { createdAtSec, first20LastBlockTime }) {
  if (entrySec == null) return { lookaheadOk: null, lookaheadIssues: ["no entry time"] };
  if (createdAtSec == null) return { lookaheadOk: null, lookaheadIssues: ["create unknown"] };
  const issues = [];
  if (!(createdAtSec < entrySec)) issues.push("create not before entry");
  if (first20LastBlockTime != null && !(first20LastBlockTime < entrySec)) issues.push("first-20 buys not all before entry");
  return { lookaheadOk: issues.length === 0, lookaheadIssues: issues };
}

// ---- errors ------------------------------------------------------------------------------------

// Short, secret-free error text: URLs and api keys never reach the output.
export function shortErr(e) {
  return String(e?.message ?? e ?? "error")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'`]*/gi, "<url>")
    .replace(/api[-_]?key=[^\s&"'`]*/gi, "api-key=<redacted>")
    .slice(0, 160);
}

// ---- one mint ----------------------------------------------------------------------------------

export function emptyRow({ n = null, mint, entryUtc = null }) {
  return {
    n, mint, entryUtc,
    createSig: null, createSlot: null, createdAtSec: null, createdAtUtc: null,
    mintSigs: null, program: null, tokenProgram: null, creator: null, deployer: null, deployerIsCreator: null, createFoundVia: null, creatorSource: null,
    devBuySol: null, devBuySolNet: null,
    sameSlotBuyers: null, sameSlotBuySol: null, sameSecondBuyers: null, sameSecondBuySol: null,
    first20BuyersSol: null, first20ExDevSol: null, first20BuyersSolNet: null, first20Wallets: null, first20Count: null,
    first20IncludesDev: true,
    creatorTxsBeforeCreate: null, creatorFirstTxSec: null, creatorAgeDays: null, creatorAgeIsLowerBound: null,
    creatorFundedBy: null, fundedSol: null, fundedAtSec: null, funderIsEarlyBuyer: null,
    creatorPriorTokens: null, priorTokensIsLowerBound: null,
    // deployer* only when the deployer differs from the creator
    deployerTxsBeforeCreate: null, deployerFirstTxSec: null, deployerAgeDays: null, deployerAgeIsLowerBound: null,
    deployerFundedBy: null, deployerFundedSol: null, deployerFundedAtSec: null, deployerFunderIsEarlyBuyer: null,
    deployerPriorTokens: null, deployerPriorTokensIsLowerBound: null,
    metadataUri: null, name: null, symbol: null, hasTwitter: null, hasTelegram: null, hasWebsite: null,
    lookaheadOk: null, lookaheadIssues: [],
    errors: [],
  };
}

export async function enrichMint(input, { rpc, fetchJson = fetchJsonDefault, maxPages = DEFAULTS.maxPages, mintMaxPages = DEFAULTS.mintMaxPages, priorCap = DEFAULTS.priorCap, first = DEFAULTS.first } = {}) {
  const row = emptyRow(input);
  const { mint } = input;
  const err = (where, e) => row.errors.push(`${where}: ${shortErr(e)}`);

  // 1) creation
  let createInfo = null;
  let mintOldestFirst = null;
  let viaCreator = null; // set when the create was found through the creator's history
  try {
    const h = await paginateSignatures(rpc, mint, { maxPages: Math.max(maxPages, mintMaxPages) });
    row.mintSigs = h.sigs.length;
    if (h.capped) {
      row.createFoundVia = "creator";
      const who = await creatorFromNewest(rpc, mint, h.sigs);
      if (!who) {
        row.errors.push("mint: history too long, creator unknown");
      } else {
        row.creatorSource = who.source;
        const oldestSeenSlot = h.sigs.length ? h.sigs[h.sigs.length - 1].slot : Infinity;
        const v = await findCreateViaCreator(rpc, mint, who.creator, { maxPages, maxSlot: oldestSeenSlot, scan: priorCap });
        if (v.notFound) {
          row.creator = who.creator;
          row.errors.push(`mint: history too long, create not found in ${v.scanned} creator txs${v.creatorCapped ? " (creator history capped)" : ""}`);
        } else {
          viaCreator = v;
          createInfo = { sig: v.sig, tx: v.tx, create: v.create };
          if (!v.anchor) {
            row.errors.push("early: history too long and no creator tx after the create");
          } else {
            // The early window ends at one of the creator's later txs. A creator who acts again
            // seconds after the create leaves too few buys in it, so later anchors are tried
            // (1, 2, 4, ... txs later); tx fetches repeat from the adapter cache.
            const cs = v.creatorSigs;
            for (let step = 1; v.index - step >= 0; step *= 2) {
              const anchor = cs[v.index - step].signature;
              const w = await paginateSignatures(rpc, mint, { before: anchor, until: v.sig, maxPages: Math.max(maxPages, mintMaxPages) });
              if (w.capped) {
                if (!mintOldestFirst) row.errors.push("early: window to the creator's next tx too long");
                break;
              }
              mintOldestFirst = [{ signature: v.sig, slot: v.tx.slot, blockTime: v.tx.blockTime, err: false }, ...w.sigs.slice().reverse()];
              const probe = await collectEarly(rpc, mint, mintOldestFirst, { createSlot: v.tx.slot, createdAtSec: v.tx.blockTime, first });
              if (buysOf(mint, probe.txs).length >= first || probe.capped || v.index - step === 0) break;
            }
          }
        }
      }
    } else {
      row.createFoundVia = "mint";
      mintOldestFirst = h.sigs.slice().reverse();
      createInfo = await findCreate(rpc, mint, mintOldestFirst);
      if (!createInfo) row.errors.push("mint: no pump.fun create among the oldest txs");
    }
  } catch (e) {
    err("mint", e);
  }
  if (createInfo) {
    const c = createInfo.create;
    row.createSig = createInfo.sig;
    row.createSlot = createInfo.tx.slot;
    row.createdAtSec = createInfo.tx.blockTime ?? c.timestampSec ?? null;
    row.createdAtUtc = secToUtc(row.createdAtSec);
    row.program = createInfo.tx.pumpInvoked ? "pump" : "unknown";
    row.creator = c.creator;
    row.deployer = c.user || null;
    row.creatorSource ??= "create";
    row.name = c.name || null;
    row.symbol = c.symbol || null;
    row.metadataUri = c.uri || null;
  }

  // 2) early buys
  if (createInfo && mintOldestFirst) {
    try {
      const early = await collectEarly(rpc, mint, mintOldestFirst, { createSlot: row.createSlot, createdAtSec: row.createdAtSec, first });
      if (early.capped) row.errors.push("early: tx cap hit");
      const s = summarizeBuys(buysOf(mint, early.txs), { createSig: row.createSig, createSlot: row.createSlot, createdAtSec: row.createdAtSec, creator: row.creator, deployer: row.deployer, first });
      Object.assign(row, {
        devBuySol: s.devBuySol, devBuySolNet: s.devBuySolNet,
        sameSlotBuyers: s.sameSlotBuyers, sameSlotBuySol: s.sameSlotBuySol,
        sameSecondBuyers: s.sameSecondBuyers, sameSecondBuySol: s.sameSecondBuySol,
        first20Count: s.first20Count,
      });
      if (s.first20Complete) {
        Object.assign(row, { first20BuyersSol: s.first20BuyersSol, first20ExDevSol: s.first20ExDevSol, first20BuyersSolNet: s.first20BuyersSolNet, first20Wallets: s.first20Wallets });
      } else {
        row.errors.push(`early: only ${s.first20Count} buys seen`);
      }
      row._first20 = s.first20WalletList;
      row._first20Last = s.first20LastBlockTime;
    } catch (e) {
      err("early", e);
    }
  }

  // 3) wallets: age, funding, prior creates — only history BEFORE the create (no lookahead).
  // creator = the create event's creator (receives the creator fee); deployer = the event's user,
  // the signer who paid for the create. Launchers often set a fresh creator address with no
  // history at all, so the deployer gets the same facts whenever it differs.
  if (row.creator && row.createSig) {
    const preset = viaCreator && !viaCreator.creatorCapped ? { sigs: viaCreator.creatorSigs.slice(viaCreator.index + 1), capped: false } : null;
    const w = await walletFacts(rpc, row.creator, { beforeSig: row.createSig, createSlot: row.createSlot, createdAtSec: row.createdAtSec, maxPages, priorCap, preset });
    Object.assign(row, {
      creatorTxsBeforeCreate: w.txsBefore,
      creatorFirstTxSec: w.firstTxSec, creatorAgeDays: w.ageDays, creatorAgeIsLowerBound: w.ageIsLowerBound,
      creatorFundedBy: w.fundedBy, fundedSol: w.fundedSol, fundedAtSec: w.fundedAtSec,
      creatorPriorTokens: w.priorTokens, priorTokensIsLowerBound: w.priorIsLowerBound,
    });
    row.errors.push(...w.errors.map((e) => `creator: ${e}`));
  }
  if (row.deployer && row.createSig) {
    row.deployerIsCreator = row.deployer === row.creator;
    if (!row.deployerIsCreator) {
      const w = await walletFacts(rpc, row.deployer, { beforeSig: row.createSig, createSlot: row.createSlot, createdAtSec: row.createdAtSec, maxPages, priorCap });
      Object.assign(row, {
        deployerTxsBeforeCreate: w.txsBefore,
        deployerFirstTxSec: w.firstTxSec, deployerAgeDays: w.ageDays, deployerAgeIsLowerBound: w.ageIsLowerBound,
        deployerFundedBy: w.fundedBy, deployerFundedSol: w.fundedSol, deployerFundedAtSec: w.fundedAtSec,
        deployerPriorTokens: w.priorTokens, deployerPriorTokensIsLowerBound: w.priorIsLowerBound,
      });
      row.errors.push(...w.errors.map((e) => `deployer: ${e}`));
    }
  }
  if (row.deployerFundedBy && row._first20) row.deployerFunderIsEarlyBuyer = row._first20.includes(row.deployerFundedBy);
  if (row.creatorFundedBy && row._first20) row.funderIsEarlyBuyer = row._first20.includes(row.creatorFundedBy);

  // 4) metadata: token program + on-chain metadata + uri JSON
  try {
    const acc = await rpc.getAccountInfo(mint);
    if (!acc) throw new Error("mint account not found");
    row.tokenProgram = acc.owner === TOKEN_2022_PROGRAM_ID ? "token-2022" : acc.owner === SPL_TOKEN_PROGRAM_ID ? "spl" : acc.owner;
    let md = null;
    if (row.tokenProgram === "token-2022") md = decodeToken2022Metadata(acc.data);
    if (!md) {
      const m = await rpc.getAccountInfo(metaplexPda(mint));
      if (m) md = decodeMetaplexMetadata(m.data);
    }
    if (md) {
      row.name = md.name || row.name;
      row.symbol = md.symbol || row.symbol;
      row.metadataUri = md.uri || row.metadataUri;
    } else {
      row.errors.push("metadata: no on-chain metadata (create event used)");
    }
  } catch (e) {
    err("metadata", e);
  }
  const url = normalizeUri(row.metadataUri);
  if (url) {
    try {
      Object.assign(row, socialsFromJson(await fetchJson(url)));
    } catch (e) {
      err("uri", e);
    }
  } else if (row.metadataUri) {
    row.errors.push("uri: unsupported scheme");
  }

  Object.assign(row, lookahead(entryToSec(row.entryUtc), { createdAtSec: row.createdAtSec, first20LastBlockTime: row._first20Last }));
  delete row._first20;
  delete row._first20Last;
  return row;
}
