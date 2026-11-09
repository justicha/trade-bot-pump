// Pure analyzer core: normalized-tx cache helpers + details computation.
// No top-level await. fetchTxDetails takes injected deps (getTx/readCache/writeCache/stats/log).
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { TRADE_EVENT_PREFIX, TRADE_EVENT_PREFIX_V2, CREATE_EVENT_PREFIX_V2, JITO_TIP_ACCOUNTS } from "./constants.mjs";
import { parsePumpSwapEvent, resolvePswapMint } from "./pumpswap.mjs";
// Known programs — NOT counted as "custom" (avoids false CUSTOM_BOT on normal users).
const KNOWN = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ComputeBudget111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fee program
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // pump event authority
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",  // Memo
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",  // Meteora DLMM
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",  // Meteora DAMM v2
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e",  // Mayhem (pump helper)
  "6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB", // pump-stables-router
]);

// Jito tip accounts (now defined in lib/constants.mjs).
const JITO_TIPS = new Set(JITO_TIP_ACCOUNTS);

function decodeIxData(data) {
  if (data instanceof Uint8Array) return Buffer.from(data); // v0 compiledInstructions
  try { return Buffer.from(bs58.decode(data)); } catch { return Buffer.alloc(0); } // base58 (inner/legacy)
}

function keyAt(keys, i) {
  if (!keys || i == null || i < 0) return undefined;
  try {
    if (typeof keys.get === "function") {
      const k = keys.get(i);
      return k ? (k.toBase58 ? k.toBase58() : String(k)) : undefined;
    }
    const k = keys[i];
    if (!k) return undefined;
    return typeof k === "string" ? k : (k.toBase58 ? k.toBase58() : String(k.pubkey ?? k));
  } catch { return undefined; }
}

// ---- v2 + v3 trade event (same field order: mint, sol u64, tok u64, is_buy byte, user) ----
function parseTradeEvent(data) {
  if (data.length < 113) return null;
  const p = data.subarray(0, 8);
  const isV3 = p.equals(TRADE_EVENT_PREFIX);
  const isV2 = p.equals(TRADE_EVENT_PREFIX_V2);
  if (!isV3 && !isV2) return null;
  try {
    let off = 8;
    const mint = new PublicKey(data.subarray(off, off + 32)).toBase58(); off += 32;
    const solAmount = Number(data.readBigUInt64LE(off)) / 1e9; off += 8;
    const tokenAmount = Number(data.readBigUInt64LE(off)) / 1e6; off += 8;
    const isBuy = data[off] === 1; off += 1;
    const user = new PublicKey(data.subarray(off, off + 32)).toBase58();
    return { mint, solAmount, tokenAmount, isBuy, user, version: isV3 ? "v3" : "v2" };
  } catch { return null; }
}

// ---- create event: disc + name + symbol + uri + mint + bonding_curve + user(creator) ----
function parseCreateEvent(data) {
  if (data.length < 12) return null;
  if (!data.subarray(0, 8).equals(CREATE_EVENT_PREFIX_V2)) return null;
  try {
    let off = 8;
    const nameLen = data.readUInt32LE(off); off += 4;
    const name = data.subarray(off, off + nameLen).toString("utf8"); off += nameLen;
    const symLen = data.readUInt32LE(off); off += 4;
    const symbol = data.subarray(off, off + symLen).toString("utf8"); off += symLen;
    const uriLen = data.readUInt32LE(off); off += 4 + uriLen;
    const mint = new PublicKey(data.subarray(off, off + 32)).toBase58(); off += 32;
    const bondingCurve = new PublicKey(data.subarray(off, off + 32)).toBase58(); off += 32;
    const creator = new PublicKey(data.subarray(off, off + 32)).toBase58();
    return { name, symbol, mint, creator, bondingCurve };
  } catch { return null; }
}

// PumpSwap parsing moved to lib/pumpswap.mjs (parsePumpSwapEvent + resolvePswapMint).

function fullKeyArray(msg, meta) {
  // canonical account order used by balances/tokenBalances accountIndex and ix programIdIndex:
  // staticAccountKeys, then loadedAddresses.writable, then loadedAddresses.readonly.
  const stat = (msg.staticAccountKeys || msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  const la = meta?.loadedAddresses || {};
  const wr = (la.writable || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  const ro = (la.readonly || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
  return [...stat, ...wr, ...ro];
}

// wallet-centric view: SOL side = native lamports delta + WSOL token delta, fee-payer flag,
// and token balance deltas (owner = wallet).
function walletInfoFor(meta, msg, wallet) {
  const full = fullKeyArray(msg, meta);
  const idx = full.indexOf(wallet);
  const isFeePayer = full[0] === wallet;
  const pre = {};
  for (const b of meta?.preTokenBalances || []) if (b.owner === wallet) pre[b.mint] = (pre[b.mint] || 0) + Number(b.uiTokenAmount.uiAmountString || 0);
  const post = {};
  for (const b of meta?.postTokenBalances || []) if (b.owner === wallet) post[b.mint] = (post[b.mint] || 0) + Number(b.uiTokenAmount.uiAmountString || 0);
  const tokenDelta = {};
  for (const m of new Set([...Object.keys(pre), ...Object.keys(post)])) tokenDelta[m] = (post[m] || 0) - (pre[m] || 0);
  const nativeSol = (idx >= 0 && meta?.preBalances && meta?.postBalances) ? (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9 : 0;
  const solDelta = nativeSol + (tokenDelta["So11111111111111111111111111111111111111112"] || 0); // native + wrapped
  return { solDelta, isFeePayer, tokenDelta };
}

// ---- normalized raw cache (no message serialize/deserialize; works for v0/legacy/v1) ----
const ixDataB64 = (d) => Buffer.from(d instanceof Uint8Array ? d : bs58.decode(d)).toString("base64");
export function normalizeTx(tx) {
  const msg = tx.transaction.message;
  const meta = tx.meta || {};
  const keys = fullKeyArray(msg, meta); // flat: static + loaded.writable + loaded.readonly (canonical order)
  const top = (msg.compiledInstructions || msg.instructions || []).map((ix) => ({ p: ix.programIdIndex, a: ix.accounts || ix.accountKeyIndexes || [], d: ixDataB64(ix.data) }));
  const inner = [];
  for (const g of meta.innerInstructions || []) for (const ix of g.instructions) inner.push({ p: ix.programIdIndex, a: ix.accounts || [], d: ixDataB64(ix.data) });
  const tok = (arr) => (arr || []).map((b) => ({ i: b.accountIndex, mint: b.mint, owner: b.owner, amt: Number(b.uiTokenAmount?.uiAmountString || 0) }));
  return {
    cacheFormat: 2, slot: tx.slot, blockTime: tx.blockTime, err: meta.err ?? null, version: tx.version ?? null,
    keys, numRequiredSignatures: msg.header?.numRequiredSignatures || 1,
    top, inner, logs: (meta.logMessages || []).filter((l) => l.startsWith("Program data: ")),
    preBal: meta.preBalances || [], postBal: meta.postBalances || [],
    preTok: tok(meta.preTokenBalances), postTok: tok(meta.postTokenBalances),
  };
}
export function txLikeFromNorm(n) {
  const innerIx = n.inner.map((ix) => ({ programIdIndex: ix.p, accounts: ix.a, data: Buffer.from(ix.d, "base64") }));
  const tok = (arr) => (arr || []).map((b) => ({ accountIndex: b.i, mint: b.mint, owner: b.owner, uiTokenAmount: { uiAmountString: String(b.amt) } }));
  return {
    slot: n.slot, blockTime: n.blockTime,
    transaction: { message: {
      staticAccountKeys: n.keys,
      compiledInstructions: n.top.map((ix) => ({ programIdIndex: ix.p, accountKeyIndexes: ix.a, data: Buffer.from(ix.d, "base64") })),
      header: { numRequiredSignatures: n.numRequiredSignatures || 1 },
    } },
    meta: {
      logMessages: n.logs,
      innerInstructions: innerIx.length ? [{ index: 0, instructions: innerIx }] : [],
      preBalances: n.preBal, postBalances: n.postBal,
      preTokenBalances: tok(n.preTok), postTokenBalances: tok(n.postTok),
    },
  };
}

export async function fetchTxDetails(sig, wallet = null, deps = {}) {
  const { getTx, readCache, writeCache, stats, log } = deps;
  // Cache a NORMALIZED raw structure (no message serialize/deserialize), so v0/legacy/v1 all
  // cache and wallet mode recomputes walletInfo from it.
  let tx;
  let norm = readCache(sig);
  if (norm && norm.cacheFormat !== 2) norm = undefined; // old (msgB64) format -> regenerate
  if (norm !== undefined) {
    stats.cached++;
    if (!norm || norm.missing) return null;
    tx = txLikeFromNorm(norm);
  } else {
    try { tx = await getTx(sig); }
    catch { stats.errors++; writeCache(sig, { missing: true }); return null; }
    if (!tx) { stats.missing++; writeCache(sig, { missing: true }); return null; }
    stats.fetched++;
    try { writeCache(sig, normalizeTx(tx)); } catch {} // cache write is best-effort; the tx is still analyzed
  }

  const msg = tx.transaction.message;
  const meta = tx.meta;
  const keys = fullKeyArray(msg, meta); // flat final order: static + loaded.writable + loaded.readonly

  const fullKeys = keys;
  const acctMintMap = {};
  for (const b of [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])]) {
    const acct = fullKeys[b.accountIndex];
    if (acct && b.mint) acctMintMap[acct] = b.mint;
  }
  // owner -> distinct non-WSOL mints (fallback for PumpSwap when user_base_token_account has no
  // token-balance entry, e.g. it is the WSOL/temporary side; the single base mint is the token).
  const ownerMints = {};
  for (const b of [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])]) {
    if (!b.owner || !b.mint || b.mint === "So11111111111111111111111111111111111111112") continue;
    (ownerMints[b.owner] ||= []);
    if (!ownerMints[b.owner].includes(b.mint)) ownerMints[b.owner].push(b.mint);
  }

  const events = [];
  let pumpSwap = 0;
  for (const line of meta?.logMessages || []) {
    if (!line.startsWith("Program data: ")) continue;
    const raw = Buffer.from(line.slice(14), "base64");
    const trade = parseTradeEvent(raw);
    if (trade) events.push({ type: "trade", ...trade });
    const create = parseCreateEvent(raw);
    if (create) events.push({ type: "create", ...create });
    const ps = parsePumpSwapEvent(raw);
    if (ps) {
      pumpSwap++;
      const mint = resolvePswapMint(ps, acctMintMap, ownerMints); // ubase -> mint, else event user's single non-WSOL mint
      if (!mint) stats.pswapUnresolved++;
      events.push({ type: "trade", isBuy: ps.side === "buy", solAmount: ps.quoteAmount / 1e9, tokenAmount: ps.baseAmount / 1e6, user: ps.user, mint, unresolved: !mint, src: "pumpswap" });
    }
  }
  stats.pumpSwapTrades += pumpSwap;

  // Possible double counting: the same (user, mint) appears as BOTH a pump.fun trade event and a
  // PumpSwap event within one transaction. Counter only — trade counting itself is unchanged.
  const pumpPairs = new Set();
  const pswapPairs = new Set();
  for (const e of events) {
    if (e.type !== "trade" || !e.mint) continue;
    const k = e.user + ":" + e.mint;
    if (e.src === "pumpswap") pswapPairs.add(k); else pumpPairs.add(k);
  }
  for (const k of pswapPairs) if (pumpPairs.has(k)) { stats.dupSuspect = (stats.dupSuspect || 0) + 1; break; }

  const topIxs = msg.compiledInstructions || msg.instructions || [];
  const inner = meta?.innerInstructions || [];
  // validate account indices against flat keys (canonical order: static + loaded.writable + loaded.readonly)
  try {
    let bad = 0;
    const chk = (i) => { if (!(i >= 0 && i < keys.length)) bad++; };
    for (const b of meta?.preTokenBalances || []) chk(b.accountIndex);
    for (const b of meta?.postTokenBalances || []) chk(b.accountIndex);
    for (const ix of topIxs) { chk(ix.programIdIndex); for (const a of (ix.accounts || ix.accountKeyIndexes || [])) chk(a); }
    for (const g of inner) for (const ix of g.instructions) { chk(ix.programIdIndex); for (const a of ix.accounts || []) chk(a); }
    if (bad) { stats.errors++; log(`  [idx-out-of-range] ${sig}: ${bad} index(es) >= keys.length(${keys.length})`); }
  } catch {} // index validation is advisory; never break parsing on malformed metadata

  const programs = new Set();
  const addProg = (ix) => { const pid = keyAt(keys, ix.programIdIndex); if (pid) programs.add(pid); };
  for (const ix of topIxs) addProg(ix);
  for (const g of inner) for (const ix of g.instructions) addProg(ix);

  // compute unit price (top-level ComputeBudget; v0 data = Uint8Array, legacy = base58)
  let cuPrice = 0;
  for (const ix of topIxs) {
    if (keyAt(keys, ix.programIdIndex) === "ComputeBudget111111111111111111111111111111") {
      const data = decodeIxData(ix.data);
      if (data[0] === 3 && data.length >= 9) cuPrice = Number(data.readBigUInt64LE(1));
    }
  }

  // System transfers: top-level AND inner. Jito tip = recipient in whitelist.
  const tips = [];
  const transferDests = new Map();
  const scanTransfer = (ix) => {
    if (keyAt(keys, ix.programIdIndex) !== "11111111111111111111111111111111") return;
    const data = decodeIxData(ix.data); // inner data is base58 -> bs58
    if (!(data[0] === 2 && data.length >= 12)) return; // SystemInstruction::Transfer
    const lamports = Number(data.readBigUInt64LE(4));
    const accs = ix.accounts || ix.accountKeyIndexes || [];
    const dest = keyAt(keys, accs[1]);
    if (!dest) return;
    transferDests.set(dest, (transferDests.get(dest) || 0) + lamports / 1e9);
    if (JITO_TIPS.has(dest) && lamports > 1000 && lamports < 1e9) tips.push({ to: dest, sol: lamports / 1e9 });
  };
  for (const ix of topIxs) scanTransfer(ix);
  for (const g of inner) for (const ix of g.instructions) scanTransfer(ix);

  const result = {
    slot: tx.slot, time: tx.blockTime, events, pumpSwapTrades: pumpSwap,
    customPrograms: [...programs].filter((p) => !KNOWN.has(p)),
    cuPrice, tips, transferDests: [...transferDests.entries()],
  };
  if (wallet) result.walletInfo = walletInfoFor(meta, msg, wallet);
  return result;
}

