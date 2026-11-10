// Unit: the PumpSwap `sell` instruction this repo builds (lib/pumpswap-sell.mjs).
//
// Reference bytes: the discriminator is sha256("global:sell")[0..8] = 33e685a4017f83ad, checked
// offline against the Anchor rule in AUDIT_SELL.md §3.1 (the same rule reproduced the
// buy_exact_quote_in discriminator of the 4 real transactions in data/txcache).
//
// TODO(verify) V1/V2/V6: there is NO on-chain `sell` transaction and NO pump_amm.json in this
// repository, so the ACCOUNT LIST below is the transcribed one, asserted to be stable — not
// proven correct by the chain. If the chain disagrees, this test is the place that must change.
import "./lib/test-env.mjs";
import { PublicKey } from "@solana/web3.js";
import {
  AMM_GLOBAL_CONFIG,
  AMM_SELL_ACCOUNT_COUNT,
  TOKEN_PROGRAM,
  ammSellIx,
  canonicalPool,
} from "../lib/pumpswap-sell.mjs";
import { ATA_PROGRAM, PUMPSWAP_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, WSOL } from "../lib/constants.mjs";

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
  buybackFeeRecipients: [],
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
asrt(ix.keys.length === 21, `21 accounts, got ${ix.keys.length}`);
asrt(AMM_SELL_ACCOUNT_COUNT === 21, "AMM_SELL_ACCOUNT_COUNT mirrors the builder");
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
  ["protocol_fee_recipient", pk(0x77), true],
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
];
for (let i = 0; i < expected.length; i++) {
  const [name, pubkey, writable] = expected[i];
  const key = ix.keys[i];
  asrt(key.isSigner === (i === 1), `account[${i}] ${name}: only the user signs`);
  asrt(key.isWritable === writable, `account[${i}] ${name}: writable=${writable}, got ${key.isWritable}`);
  if (pubkey) asrt(key.pubkey.equals(pubkey), `account[${i}] ${name}: unexpected pubkey ${key.pubkey.toBase58()}`);
}

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

console.log(
  JSON.stringify({
    dataBytes: ix.data.length,
    discriminator: ix.data.subarray(0, 8).toString("hex"),
    accounts: ix.keys.length,
  }),
);
console.log("PASS: sell ix — 24 bytes, sha256(global:sell)[0..8], 21 accounts in the audited order (V1/V2/V6 unverified)");
