#!/usr/bin/env node
// Read-only diagnostics for the volume-analyzer.
//   node scripts/probe.mjs isbuy   <wallet> [n]  — trade.isBuy@56 vs wallet token-balance delta
//   node scripts/probe.mjs cusurvey <mint> [n]   — median CU price per distinct trader
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { connection } from "../lib/rpc.mjs";
import { TRADE_EVENT_PREFIX, TRADE_EVENT_PREFIX_V2, PUMPSWAP_TRADE_PREFIX, PUMPSWAP_FEE_PREFIX } from "../lib/constants.mjs";

const [, , mode, target, nStr] = process.argv;
const N = Number(nStr || 10);
const PB = TRADE_EVENT_PREFIX, PB2 = TRADE_EVENT_PREFIX_V2;

function decodeTrade(buf) {
  if (!buf || buf.length < 113) return null;
  const p = buf.subarray(0, 8);
  if (!p.equals(PB) && !p.equals(PB2)) return null;
  try {
    const mint = new PublicKey(buf.subarray(8, 40)).toBase58();
    const sol = Number(buf.readBigUInt64LE(40)) / 1e9;
    const isBuy = buf[56] === 1; // <-- the field under test
    const user = new PublicKey(buf.subarray(57, 89)).toBase58();
    return { mint, sol, isBuy, user };
  } catch { return null; }
}
function keyList(msg) {
  if (typeof msg.getAccountKeys === "function") {
    try {
      const s = msg.getAccountKeys().keySegments();
      return [...s.staticAccountKeys, ...s.writable, ...s.readonly].map((k) => k.toBase58());
    } catch {}
  }
  return (msg.accountKeys || msg.staticAccountKeys || []).map((k) => (typeof k === "string" ? k : k.toBase58()));
}
function decodeIx(data) {
  if (data instanceof Uint8Array) return Buffer.from(data);
  try { return Buffer.from(bs58.decode(data)); } catch { return Buffer.alloc(0); }
}
function cuPriceOf(tx) {
  const msg = tx.transaction.message;
  const keys = keyList(msg);
  let cu = 0;
  for (const ix of msg.compiledInstructions || msg.instructions || []) {
    if (keys[ix.programIdIndex] === "ComputeBudget111111111111111111111111111111") {
      const d = decodeIx(ix.data);
      if (d[0] === 3 && d.length >= 9) cu = Number(d.readBigUInt64LE(1));
    }
  }
  return cu;
}
function tokDelta(tx, owner, mint) {
  const pre = (tx.meta.preTokenBalances || []).filter((b) => b.owner === owner && b.mint === mint)
    .reduce((a, b) => a + Number(b.uiTokenAmount.uiAmountString || 0), 0);
  const post = (tx.meta.postTokenBalances || []).filter((b) => b.owner === owner && b.mint === mint)
    .reduce((a, b) => a + Number(b.uiTokenAmount.uiAmountString || 0), 0);
  return post - pre;
}

async function isbuy(wallet, n) {
  const pk = new PublicKey(wallet);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 60 });
  let rows = 0, agree = 0, total = 0, shownBuy = false, shownSell = false;
  console.log(`is_buy@56 verification for ${wallet}\n`);
  console.log("  sig8     | mint8    | byte_isBuy | tokDelta      | verdict");
  for (const s of sigs) {
    if (rows >= n) break;
    if (s.err) continue;
    let tx;
    try { tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }); } catch { continue; }
    if (!tx) continue;
    let ev = null;
    for (const line of tx.meta.logMessages || []) {
      if (!line.startsWith("Program data: ")) continue;
      const t = decodeTrade(Buffer.from(line.slice(14), "base64"));
      if (t) { ev = t; break; }
    }
    if (!ev) continue;
    const d = tokDelta(tx, wallet, ev.mint);
    if (Math.abs(d) < 1e-9) continue; // wallet didn't trade this mint in this tx
    const deltaBuy = d > 0;
    const ok = deltaBuy === ev.isBuy;
    total++; if (ok) agree++;
    if (ev.isBuy && d > 0) shownBuy = true;
    if (!ev.isBuy && d < 0) shownSell = true;
    console.log(`  ${s.signature.slice(0, 8)} | ${ev.mint.slice(0, 8)} | ${String(ev.isBuy).padEnd(10)} | ${d.toFixed(4).padStart(13)} | ${ok ? "AGREE" : "MISMATCH"}`);
    rows++;
  }
  console.log(`\n  byte agrees with token-delta in ${agree}/${total}; sawClearBuy=${shownBuy} sawClearSell=${shownSell}`);
}

async function cusurvey(mint, n) {
  const pk = new PublicKey(mint);
  const sigs = await connection.getSignaturesForAddress(pk, { limit: 120 });
  const perUser = new Map(); // user -> [cu,...]
  let scanned = 0;
  for (const s of sigs) {
    if (scanned >= 80) break;
    if (s.err) continue;
    let tx;
    try { tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }); } catch { continue; }
    if (!tx) continue;
    scanned++;
    let ev = null;
    for (const line of tx.meta.logMessages || []) {
      if (!line.startsWith("Program data: ")) continue;
      const t = decodeTrade(Buffer.from(line.slice(14), "base64"));
      if (t) { ev = t; break; }
    }
    if (!ev) continue;
    const cu = cuPriceOf(tx);
    if (!perUser.has(ev.user)) perUser.set(ev.user, []);
    perUser.get(ev.user).push(cu);
  }
  const med = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  const rows = [...perUser.entries()].filter(([, a]) => a.length >= 2)
    .map(([u, a]) => ({ u, n: a.length, cu: med(a), max: Math.max(...a) }))
    .sort((a, b) => b.n - a.n).slice(0, n);
  console.log(`CU price survey for mint ${mint} (scanned ${scanned} tx)\n`);
  console.log("  wallet8  | tx | medianCU(µlamports/CU) | maxCU");
  for (const r of rows) console.log(`  ${r.u.slice(0, 8)} | ${String(r.n).padStart(2)} | ${String(r.cu).padStart(20)} | ${r.max}`);
  const allMedCUs = rows.map((r) => r.cu).sort((a, b) => a - b);
  console.log(`\n  distinct traders(>=2 tx)=${perUser.size}, medians=[${allMedCUs.join(", ")}]`);
  if (allMedCUs.length) console.log(`  min=${allMedCUs[0]} median=${allMedCUs[Math.floor(allMedCUs.length / 2)]} max=${allMedCUs[allMedCUs.length - 1]}`);
}

async function pswap(n) {
  const prog = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const BUY = PUMPSWAP_TRADE_PREFIX, SELL = PUMPSWAP_FEE_PREFIX;
  const sigs = await connection.getSignaturesForAddress(prog, { limit: 100 });
  console.log(`PumpSwap BuyEvent/SellEvent verification (program pAMMBay…)\n`);
  console.log("  sig8     | side | baseAmount   | userTokDelta  | solDelta      | verdict");
  let rows = 0, agree = 0;
  for (const s of sigs) {
    if (rows >= n) break;
    if (s.err) continue;
    let tx; try { tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }); } catch { continue; }
    if (!tx) continue;
    let ev = null;
    for (const line of tx.meta.logMessages || []) {
      if (!line.startsWith("Program data: ")) continue;
      const b = Buffer.from(line.slice(14), "base64");
      if (b.length < 184) continue;
      const p = b.subarray(0, 8);
      let side = null;
      if (p.equals(BUY)) side = "buy"; else if (p.equals(SELL)) side = "sell"; else continue;
      ev = { side, base: Number(b.readBigUInt64LE(16)), quote: Number(b.readBigUInt64LE(112)), user: new PublicKey(b.subarray(152, 184)).toBase58() };
      break;
    }
    if (!ev) continue;
    const pre = {}, post = {};
    for (const bb of tx.meta.preTokenBalances || []) if (bb.owner === ev.user) pre[bb.mint] = (pre[bb.mint] || 0) + Number(bb.uiTokenAmount.uiAmountString || 0);
    for (const bb of tx.meta.postTokenBalances || []) if (bb.owner === ev.user) post[bb.mint] = (post[bb.mint] || 0) + Number(bb.uiTokenAmount.uiAmountString || 0);
    let tokDelta = 0;
    for (const m of new Set([...Object.keys(pre), ...Object.keys(post)])) { const d = (post[m] || 0) - (pre[m] || 0); if (Math.abs(d) > Math.abs(tokDelta)) tokDelta = d; }
    const keys = keyList(tx.transaction.message);
    const idx = keys.indexOf(ev.user);
    const nativeSol = idx >= 0 ? (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9 : 0;
    const WSOL = "So11111111111111111111111111111111111111112";
    const wsolDelta = (post[WSOL] || 0) - (pre[WSOL] || 0);
    const solDelta = nativeSol + wsolDelta; // native lamports + wrapped SOL token
    const baseUi = ev.base / 1e6, quoteUi = ev.quote / 1e9;
    const dirOk = ev.side === "buy" ? tokDelta > 0 : tokDelta < 0;
    const amtOk = Math.abs(Math.abs(tokDelta) - baseUi) <= Math.max(1, baseUi * 0.05);
    const solOk = ev.side === "buy" ? solDelta < 0 : solDelta > 0;
    const solAmtOk = Math.abs(Math.abs(solDelta) - quoteUi) <= Math.max(0.001, quoteUi * 0.15); // |SOL delta| ~= quote@112
    const ok = dirOk && amtOk && solOk && solAmtOk;
    if (ok) agree++;
    console.log(`  ${s.signature.slice(0, 8)} | ${ev.side.padEnd(4)} | base ${baseUi.toFixed(2).padStart(11)} Δtok ${tokDelta.toFixed(2).padStart(11)} | quote@112 ${quoteUi.toFixed(6).padStart(10)} Δsol ${solDelta.toFixed(6).padStart(10)} | ${ok ? "AGREE" : "CHECK"}`);
    rows++;
  }
  console.log(`\n  agrees (buy:+tok&-sol, sell:-tok&+sol, base within 5%) in ${agree}/${rows}`);
}

async function who(prefix) {
  const prog = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const sigs = await connection.getSignaturesForAddress(prog, { limit: 200 });
  const hit = sigs.find((s) => s.signature.startsWith(prefix));
  if (!hit) { console.log("signature not found in last 200 program txs; try again later"); return; }
  const tx = await connection.getTransaction(hit.signature, { maxSupportedTransactionVersion: 1 });
  if (!tx) { console.log("tx not found"); return; }
  console.log("sig:", hit.signature);
  let evUser = null;
  for (const line of tx.meta.logMessages || []) {
    if (!line.startsWith("Program data: ")) continue;
    const b = Buffer.from(line.slice(14), "base64");
    if (b.length < 184) continue;
    const p = b.subarray(0, 8);
    if (p.equals(PUMPSWAP_TRADE_PREFIX) || p.equals(PUMPSWAP_FEE_PREFIX)) { evUser = new PublicKey(b.subarray(152, 184)).toBase58(); break; }
  }
  console.log("event.user:", evUser);
  const owners = new Map();
  for (const side of ["pre", "post"]) {
    for (const bb of (side === "pre" ? tx.meta.preTokenBalances : tx.meta.postTokenBalances) || []) {
      if (!owners.has(bb.owner)) owners.set(bb.owner, {});
      const o = owners.get(bb.owner);
      o[bb.mint] = (o[bb.mint] || 0) + (side === "pre" ? -1 : 1) * Number(bb.uiTokenAmount.uiAmountString || 0);
    }
  }
  console.log("owners whose token balance changed (owner != event.user possible):");
  for (const [owner, mints] of owners) {
    const nz = Object.entries(mints).filter(([, d]) => Math.abs(d) > 1e-9);
    if (nz.length) console.log("  ", owner, "=>", nz.map(([m, d]) => `${m.slice(0, 6)}:${d.toFixed(2)}`).join(", "));
  }
}

if (mode === "isbuy") await isbuy(target, N);
else if (mode === "cusurvey") await cusurvey(target, N);
else if (mode === "pswap") await pswap(N);
else if (mode === "who") await who(target);
else { console.log("Usage: probe.mjs isbuy <wallet> [n] | cusurvey <mint> [n] | pswap [n] | who <sigPrefix>"); process.exit(1); }
