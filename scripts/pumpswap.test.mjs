// Unit test (multi-hop fixture): two events for the SAME user on DIFFERENT pools/mints must
// group separately; a different user on the same mint must not mix; unresolved -> null (no pool).
import { parsePumpSwapEvent, resolvePswapMint } from "../lib/pumpswap.mjs";

function mk(side, base, quote, poolByte, userByte, ubaseByte) {
  const b = Buffer.alloc(216);
  (side === "buy" ? Buffer.from("67f4521f2cf57777", "hex") : Buffer.from("3e2f370aa503dc2a", "hex")).copy(b, 0);
  b.writeBigUInt64LE(BigInt(base), 16);
  b.writeBigUInt64LE(BigInt(quote), 112);
  b.fill(poolByte, 120, 152);
  b.fill(userByte, 152, 184);
  b.fill(ubaseByte, 184, 216);
  return b;
}
const asrt = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } };

const e1 = parsePumpSwapEvent(mk("buy", 100, 5000, 1, 9, 50)); // user0x09 pool1 ubase0x50
const e2 = parsePumpSwapEvent(mk("sell", 40, 2000, 2, 9, 51)); // user0x09 pool2 ubase0x51
const e3 = parsePumpSwapEvent(mk("buy", 10, 300, 3, 7, 50));   // user0x07 pool3 ubase0x50
asrt(e1 && e2 && e3, "parse all");
asrt(e1.side === "buy" && e2.side === "sell" && e3.side === "buy", "sides");
asrt(e1.baseAmount === 100 && e1.quoteAmount === 5000, "e1 amounts");
asrt(e2.baseAmount === 40 && e2.quoteAmount === 2000, "e2 amounts");
asrt(e1.user === e2.user && e1.user !== e3.user, "user identity");
asrt(e1.pool !== e2.pool, "different pools");

const map = { [e1.userBaseTokenAccount]: "MINT_A", [e2.userBaseTokenAccount]: "MINT_B", [e3.userBaseTokenAccount]: "MINT_A" };
const groups = {};
for (const [ev, mint] of [[e1, resolvePswapMint(e1, map)], [e2, resolvePswapMint(e2, map)], [e3, resolvePswapMint(e3, map)]]) {
  asrt(mint, "mint resolved");
  const k = ev.user + ":" + mint;
  groups[k] = groups[k] || { base: 0, quote: 0, n: 0 };
  groups[k].base += ev.baseAmount; groups[k].quote += ev.quoteAmount; groups[k].n++;
}
const keys = Object.keys(groups).sort();
asrt(keys.length === 3, "3 groups (user+mint) not mixed, got " + keys.length);
asrt(groups[e1.user + ":MINT_A"].base === 100 && groups[e1.user + ":MINT_B"].base === 40, "same user split per mint");
asrt(groups[e1.user + ":MINT_A"].base === 100 && groups[e3.user + ":MINT_A"].base === 10, "same mint split per user");
asrt(resolvePswapMint(e1, {}) === null, "unresolved -> null (no pool fallback)");
asrt(resolvePswapMint(e1, {}, { [e1.user]: ["MINT_A"] }) === "MINT_A", "owner-mint fallback (ubase not in balances)");
asrt(resolvePswapMint(e1, {}, { [e1.user]: ["A", "B"] }) === null, "ambiguous owner mints -> null");

console.log(JSON.stringify({ groups: keys, unresolvedNull: true }));
console.log("PASS: multihop grouped by user+mint (not mixed); unresolved -> null");
