// Unit: the PumpSwap `sell` instruction this repo builds (lib/pumpswap-sell.mjs).
//
// Reference: the official SDK @pump-fun/pump-sdk@4.3.1 (AUDIT_SELL.md §13). The 21 named accounts,
// their order and their writable flags come from src/idl/pump_amm.json; the remaining accounts
// come from src/swap/offlinePumpAmm.ts sellInstructionsNoPool (pool_v2 when the pool has a
// coin_creator, then the buyback fee recipient + its quote ATA, always). The discriminator
// 33e685a4017f83ad = sha256("global:sell")[0..8] was checked offline in AUDIT_SELL.md §3.1.
//
// TODO(verify): still no successful on-chain sell in this repo — the last simulation reached the
// program's final check and failed on the missing pool_v2 (Custom 6062). Re-run the probe.
import "./lib/test-env.mjs";
import { PublicKey } from "@solana/web3.js";
import {
  AMM_GLOBAL_CONFIG,
  AMM_SELL_ACCOUNT_COUNT,
  TOKEN_PROGRAM,
  ammSellIx,
  canonicalPool,
  poolV2Pda,
} from "../lib/pumpswap-sell.mjs";
import { ATA_PROGRAM, PUMPSWAP_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, WSOL } from "../lib/constants.mjs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const pk = (b) => new PublicKey(Buffer.alloc(32, b));
// Derived here, independently of the module, so a wrong seed/constant in the builder shows up.
const AMM_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const AMM_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMPSWAP_PROGRAM.toBuffer()],
  AMM_FEE_PROGRAM,
)[0];

const user = pk(0x11);
const baseMint = pk(0x22);
const pool = pk(0x33);
const BUYBACK = pk(0x88);
const p = {
  baseMint,
  quoteMint: WSOL,
  baseVault: pk(0x44),
  quoteVault: pk(0x55),
  coinCreator: pk(0x66),
  isMayhem: false,
  isCashback: false,
};
const g = {
  lpFeeBps: 20,
  protocolFeeBps: 5,
  coinCreatorFeeBps: 5,
  protocolFeeRecipients: [pk(0x77)],
  reservedFeeRecipient: PublicKey.default,
  reservedFeeRecipients: [],
  buybackFeeRecipients: [BUYBACK],
};
const baseAmountIn = 1_234_567_890n;
const minQuoteOut = 98_765_432n;
const ix = ammSellIx(user, baseMint, pool, p, g, baseAmountIn, minQuoteOut);


// --- data ---
asrt(ix.data.length === 24, `data is 24 bytes (8 discriminator + 2 u64), got ${ix.data.length}`);
asrt(
  ix.data.subarray(0, 8).toString("hex") === "33e685a4017f83ad",
  `discriminator is 33e685a4017f83ad, got ${ix.data.subarray(0, 8).toString("hex")}`,
);
asrt(ix.data.readBigUInt64LE(8) === baseAmountIn, "base_amount_in at offset 8 (u64 LE)");
asrt(ix.data.readBigUInt64LE(16) === minQuoteOut, "min_quote_amount_out at offset 16 (u64 LE)");
asrt(ix.programId.equals(PUMPSWAP_PROGRAM), "programId is the PumpSwap program");

// --- accounts: count, order, flags ---
asrt(ix.keys.length === 24, `21 named + 3 remaining (creator set) = 24 accounts, got ${ix.keys.length}`);
asrt(AMM_SELL_ACCOUNT_COUNT === 21, "AMM_SELL_ACCOUNT_COUNT is the named-account count");
const expected = [
  ["pool", pool, true],
  ["user", user, true],
  ["global_config", AMM_GLOBAL_CONFIG, false],
  ["base_mint", baseMint, false],
  ["quote_mint", WSOL, false],
  ["user_base_token_account", null, true],
  ["user_quote_token_account", null, true],
  ["pool_base_token_account", p.baseVault, true],
  ["pool_quote_token_account", p.quoteVault, true],
  ["protocol_fee_recipient", pk(0x77), false], // IDL: NOT writable (AUDIT_SELL.md §13.3)
  ["protocol_fee_recipient_token_account", null, true],
  ["base_token_program", TOKEN_2022_PROGRAM, false],
  ["quote_token_program", TOKEN_PROGRAM, false],
  ["system_program", SYSTEM_PROGRAM, false],
  ["associated_token_program", ATA_PROGRAM, false],
  ["event_authority", null, false],
  ["program", PUMPSWAP_PROGRAM, false],
  ["coin_creator_vault_ata", null, true],
  ["coin_creator_vault_authority", null, false],
  ["fee_config", AMM_FEE_CONFIG, false],
  ["fee_program", new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"), false],
  // --- remaining accounts, SDK order (offlinePumpAmm.ts sellInstructionsNoPool) ---
  ["pool_v2", poolV2Pda(baseMint), false],
  ["buyback_fee_recipient", BUYBACK, false],
  ["buyback_fee_recipient_token_account", null, true],
];
for (let i = 0; i < expected.length; i++) {
  const [name, pubkey, writable] = expected[i];
  const key = ix.keys[i];
  asrt(key.isSigner === (i === 1), `account[${i}] ${name}: only the user signs`);
  asrt(key.isWritable === writable, `account[${i}] ${name}: writable=${writable}, got ${key.isWritable}`);
  if (pubkey) asrt(key.pubkey.equals(pubkey), `account[${i}] ${name}: unexpected pubkey ${key.pubkey.toBase58()}`);
}
// The SDK order puts pool_v2 FIRST among the remaining accounts, buyback pair last.
asrt(ix.keys[21].pubkey.equals(poolV2Pda(baseMint)), "pool_v2 is the first remaining account");
asrt(ix.keys[22].pubkey.equals(BUYBACK), "buyback fee recipient is the second remaining account");
asrt(
  ix.keys[23].pubkey.equals(getAssociatedTokenAddressSync(WSOL, BUYBACK, true, TOKEN_PROGRAM)),
  "buyback ATA is last, derived with allowOwnerOffCurve = true",
);


// --- derived addresses that must not drift ---
const creatorAuth = PublicKey.findProgramAddressSync(
  [Buffer.from("creator_vault"), p.coinCreator.toBuffer()],
  PUMPSWAP_PROGRAM,
)[0];
asrt(ix.keys[18].pubkey.equals(creatorAuth), "account[18] is PDA(creator_vault, pool.coin_creator)");
const eventAuth = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP_PROGRAM)[0];
asrt(ix.keys[15].pubkey.equals(eventAuth), "account[15] is PDA(__event_authority)");
asrt(
  ix.keys[2].pubkey.equals(PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP_PROGRAM)[0]),
  "account[2] is PDA(global_config)",
);

// canonical pool derivation: same seeds, deterministic per mint, never the mint itself.
asrt(canonicalPool(baseMint).equals(canonicalPool(baseMint)), "canonicalPool is deterministic");
asrt(!canonicalPool(baseMint).equals(canonicalPool(pk(0x23))), "canonicalPool differs per mint");
asrt(!canonicalPool(baseMint).equals(baseMint), "canonicalPool is not the mint");

// --- PDA-owned ATAs must not throw TokenOwnerOffCurveError ---
// The protocol fee recipient and the creator vault authority are PDAs (off the ed25519 curve):
// deriving their ATA with allowOwnerOffCurve = false throws. The builder must pass true for them
// and keep the wallet-owned (user) ATAs exactly as they were.
const feeVault = PublicKey.findProgramAddressSync([Buffer.from("fee-recipient-vault")], PUMPSWAP_PROGRAM)[0];
asrt(!PublicKey.isOnCurve(feeVault.toBytes()), "fixture: the fee vault is off-curve (PDA)");

// Sanity: the OLD call really fails for this owner, so the assertion below is not vacuous.
let offCurveThrew = false;
try {
  getAssociatedTokenAddressSync(WSOL, feeVault, false, TOKEN_PROGRAM);
} catch (e) {
  offCurveThrew = true;
  asrt(
    /offcurve/i.test(`${e?.name ?? ""} ${e?.message ?? ""}`),
    `fixture: expected TokenOwnerOffCurveError, got ${e?.name}: ${e?.message}`,
  );
}
asrt(offCurveThrew, "fixture: getAssociatedTokenAddressSync(owner=PDA, allowOwnerOffCurve=false) throws");

const gPda = { ...g, protocolFeeRecipients: [feeVault] };
let ixPda = null;
try {
  ixPda = ammSellIx(user, baseMint, pool, p, gPda, baseAmountIn, minQuoteOut);
} catch (e) {
  asrt(false, `ammSellIx must not throw for an off-curve fee recipient, got ${e?.name}: ${e?.message}`);
}
asrt(ixPda.keys.length === 24, `off-curve fee recipient: still 24 accounts, got ${ixPda.keys.length}`);
asrt(ixPda.keys[9].pubkey.equals(feeVault), "off-curve fee recipient is still account[9]");
asrt(
  ixPda.keys[10].pubkey.equals(getAssociatedTokenAddressSync(WSOL, feeVault, true, TOKEN_PROGRAM)),
  "account[10] is the PDA's ATA, derived with allowOwnerOffCurve = true",
);
asrt(
  ixPda.keys[5].pubkey.equals(getAssociatedTokenAddressSync(baseMint, user, false, TOKEN_2022_PROGRAM)),
  "account[5] user base ATA: still derived with allowOwnerOffCurve = false",
);
asrt(
  ixPda.keys[6].pubkey.equals(getAssociatedTokenAddressSync(WSOL, user, false, TOKEN_PROGRAM)),
  "account[6] user quote ATA: still derived with allowOwnerOffCurve = false",
);
asrt(
  ixPda.keys[17].pubkey.equals(getAssociatedTokenAddressSync(WSOL, creatorAuth, true, TOKEN_PROGRAM)),
  "account[17] creator vault ATA: derived with allowOwnerOffCurve = true",
);
asrt(ixPda.data.equals(ix.data), "the owner fix does not change the instruction data");
asrt(ixPda.keys.length === ix.keys.length, "the owner fix does not change the account count");

// --- pool_v2 is conditional on a real coin_creator (SDK: !pool.coinCreator.equals(default)) ---
{
  const noCreator = ammSellIx(user, baseMint, pool, { ...p, coinCreator: PublicKey.default }, g, baseAmountIn, minQuoteOut);
  asrt(noCreator.keys.length === 23, `without a creator: 23 accounts (no pool_v2), got ${noCreator.keys.length}`);
  asrt(
    !noCreator.keys.some((k) => k.pubkey.equals(poolV2Pda(baseMint))),
    "pool_v2 is absent when coin_creator == default",
  );
  asrt(noCreator.keys[21].pubkey.equals(BUYBACK), "without pool_v2 the buyback recipient is the first remaining account");
  asrt(noCreator.keys[22].pubkey.equals(getAssociatedTokenAddressSync(WSOL, BUYBACK, true, TOKEN_PROGRAM)), "buyback ATA is still last");
  asrt(noCreator.data.equals(ix.data), "no-creator pool does not change the instruction data");
}

// --- buyback pair is ALWAYS present (SDK pushes it unconditionally) ---
{
  const g2 = { ...g, buybackFeeRecipients: [pk(0x91), pk(0x92)] };
  const old = Math.random;
  Math.random = () => 0; // first entry
  const ix2 = ammSellIx(user, baseMint, pool, p, g2, baseAmountIn, minQuoteOut);
  Math.random = old;
  asrt(ix2.keys[22].pubkey.equals(pk(0x91)), "buyback recipient is picked from globalConfig.buybackFeeRecipients");
  asrt(
    ix2.keys[23].pubkey.equals(getAssociatedTokenAddressSync(WSOL, pk(0x91), true, TOKEN_PROGRAM)),
    "buyback ATA follows the picked recipient",
  );
  asrt(ix2.keys[22].isWritable === false && ix2.keys[23].isWritable === true, "buyback flags: recipient read-only, ATA writable");
}

// --- a cashback pool must not build a v1 sell (SDK uses sell_v2 for it) ---
{
  let threw = null;
  try {
    ammSellIx(user, baseMint, pool, { ...p, isCashback: true }, g, baseAmountIn, minQuoteOut);
  } catch (e) {
    threw = e;
  }
  asrt(threw instanceof Error, "a cashback pool throws instead of returning an instruction");
  asrt(/cashback pool: sell_v2 not supported/.test(threw.message), `the error says sell_v2 is not supported, got: ${threw.message}`);
}

// --- the IDL flag fix is explicit ---
asrt(ix.keys[9].isWritable === false, "protocol_fee_recipient (index 9) is NOT writable, per the IDL");
asrt(ix.keys[1].isSigner === true && ix.keys[1].isWritable === true, "user is still signer+writable");

console.log(
  JSON.stringify({
    dataBytes: ix.data.length,
    discriminator: ix.data.subarray(0, 8).toString("hex"),
    accounts: ix.keys.length,
    remaining: ["pool_v2", "buyback_fee_recipient", "buyback_fee_recipient_token_account"],
  }),
);
console.log("PASS: sell ix — 21 IDL accounts + pool_v2/buyback remaining accounts per the official SDK, cashback refused");
