// Fixture for scripts/ata-rent.test.mjs and scripts/live-pnl.test.mjs: getTransaction returns
// hand-built transaction metas of a pump.fun buy/sell. No network, no keys.
//
// Numbers (lamports):
//   FEE   455_000     = 5000 base + 300k CU * 1.5 µlamports (what a live tx pays)
//   RENT  2_074_080   = rent-exempt minimum of a Token-2022 ATA (170 bytes) — the test never
//                       hardcodes it in lib/, readExecution must MEASURE it from the meta
//   SPENT 95_000_000  = what the buy itself took (0.095 SOL)
//   RECV  100_000_000 = wallet delta of the sell, already net of its fee (0.1 SOL)
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

export const OWNER = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const FEE = 455_000;
export const RENT = 2_074_080;
export const SPENT = 95_000_000;
export const RECV = 100_000_000;
export const TOKENS = 3_000_000_000n;

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const owner = new PublicKey(OWNER);
const mint = new PublicKey(MINT);
const other = new PublicKey("11111111111111111111111111111111");
export const ATA = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022);

const START = 2_000_000_000;
const tok = (amount) => ({ owner: OWNER, mint: MINT, uiTokenAmount: { amount: String(amount) } });

// A buy. `ata`: "new" (created here: 0 -> RENT), "existing" (RENT -> RENT), "alt" (created here but
// the ATA key is loaded through an address lookup table), "absent" (not among the tx accounts).
function buy(ata) {
  const rent = ata === "new" || ata === "alt" ? RENT : 0;
  const ownerPost = START - SPENT - FEE - rent;
  const base = {
    err: null,
    fee: FEE,
    preTokenBalances: ata === "existing" ? [tok(0)] : [],
    postTokenBalances: [tok(TOKENS)],
  };
  if (ata === "alt") {
    return {
      transaction: { message: { staticAccountKeys: [owner, mint, other] } },
      meta: {
        ...base,
        loadedAddresses: { writable: [ATA], readonly: [] },
        preBalances: [START, 0, 0, 0],
        postBalances: [ownerPost, 0, 0, RENT],
      },
    };
  }
  if (ata === "absent") {
    return {
      transaction: { message: { staticAccountKeys: [owner, mint, other] } },
      meta: { ...base, preBalances: [START, 0, 0], postBalances: [ownerPost, 0, 0] },
    };
  }
  const ataPre = ata === "existing" ? RENT : 0;
  return {
    transaction: { message: { staticAccountKeys: [owner, ATA, mint, other] } },
    meta: { ...base, preBalances: [START, ataPre, 0, 0], postBalances: [ownerPost, RENT, 0, 0] },
  };
}

// A sell of the whole balance: the wallet delta is +`delta` lamports (net of the fee). The token
// ATA stays open (the bot never closes it), so its rent does not move.
function sell(delta) {
  return {
    transaction: { message: { staticAccountKeys: [owner, ATA, mint, other] } },
    meta: {
      err: null,
      fee: FEE,
      preBalances: [START, RENT, 0, 0],
      postBalances: [START + delta, RENT, 0, 0],
      preTokenBalances: [tok(TOKENS)],
      postTokenBalances: [tok(0)],
    },
  };
}

export const connection = {
  async getTransaction(sig) {
    if (sig === "MISSING") return null;
    if (sig === "BUY_NEW_ATA") return buy("new");
    if (sig === "BUY_EXISTING_ATA") return buy("existing");
    if (sig === "BUY_ALT_ATA") return buy("alt");
    if (sig === "BUY_ATA_ABSENT") return buy("absent");
    if (sig === "SELL") return sell(RECV);
    if (sig === "SELL_DUST") return sell(-FEE); // proceeds 0: the wallet only paid the fee
    throw new Error(`unexpected signature ${sig}`);
  },
};
