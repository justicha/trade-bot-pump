// Unit test (multi-hop fixture): two events for the SAME user on DIFFERENT pools/mints must
// group separately; a different user on the same mint must not mix; unresolved -> null (no pool).
import { parsePumpSwapEvent, resolvePswapMint, decodeGlobalConfig, pickProtocolFeeRecipient } from "../lib/pumpswap.mjs";
import { PublicKey } from "@solana/web3.js";

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

// --- decodeGlobalConfig + pickProtocolFeeRecipient (official pump-amm IDL offsets) ---
// GlobalConfig is borsh WITH the 8-byte discriminator: lp@40, protocol@48, recipients[8]@57,
// coin_creator@313, reserved_fee_recipient@385, reserved_fee_recipients[8]@418.
function mkGlobalConfig({ normal0, reserved, reserved0 } = {}) {
  const b = Buffer.alloc(931);
  b.writeBigUInt64LE(25n, 40);   // lp_fee_basis_points
  b.writeBigUInt64LE(5n, 48);    // protocol_fee_basis_points
  b.writeBigUInt64LE(100n, 313); // coin_creator_fee_basis_points
  if (normal0) normal0.copy(b, 57);
  if (reserved) reserved.copy(b, 385);
  if (reserved0) reserved0.copy(b, 418);
  return b;
}
const n0 = Buffer.alloc(32, 0x11);
const r0 = Buffer.alloc(32, 0x22);
const r1 = Buffer.alloc(32, 0x33);
const g = decodeGlobalConfig(mkGlobalConfig({ normal0: n0, reserved: r0, reserved0: r1 }));
asrt(g.lpFeeBps === 25 && g.protocolFeeBps === 5 && g.coinCreatorFeeBps === 100, "global config numeric fields");
asrt(g.protocolFeeRecipients[0].toBase58() === new PublicKey(n0).toBase58(), "protocol_fee_recipients[0] decoded");
asrt(g.protocolFeeRecipients[1].toBase58() === PublicKey.default.toBase58(), "unset recipient decodes as the zero key");
asrt(g.reservedFeeRecipient.toBase58() === new PublicKey(r0).toBase58(), "reserved_fee_recipient decoded");
asrt(g.reservedFeeRecipients[0].toBase58() === new PublicKey(r1).toBase58(), "reserved_fee_recipients[0] decoded");
asrt(pickProtocolFeeRecipient(g, false).toBase58() === new PublicKey(n0).toBase58(), "non-mayhem picks from the normal list");
const may = pickProtocolFeeRecipient(g, true).toBase58();
asrt(may === new PublicKey(r0).toBase58() || may === new PublicKey(r1).toBase58(), "mayhem picks from the reserved list");
let threw = false;
try { pickProtocolFeeRecipient({ protocolFeeRecipients: [], reservedFeeRecipient: null, reservedFeeRecipients: [] }, false); } catch { threw = true; }
asrt(threw, "empty recipient list throws (fail closed)");

console.log(JSON.stringify({ groups: keys, unresolvedNull: true, globalConfigOk: true }));
console.log("PASS: multihop grouped by user+mint (not mixed); unresolved -> null; global config + fee recipient per IDL");
