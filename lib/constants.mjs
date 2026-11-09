import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
export const PUMP_EVENT_AUTH = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

// --- Current pump.fun instruction layout (verified against the official IDL + mainnet, 2026-11) ---
// The fee config and fee/buyback routing now live in a separate program.
export const PUMP_FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
// fee_config PDA = ["fee_config", <32-byte const>] under the FEE program (NOT pump.fun).
const PUMP_FEE_CONFIG_SEED = Buffer.from(
  "0156e0f693665acf44db1568bf175baa5189cb97f5d2ff3b655d2bb6fd6d18b0",
  "hex",
);
export const PUMP_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from("fee_config"), PUMP_FEE_CONFIG_SEED],
  PUMP_FEE_PROGRAM,
)[0];
// Required by the current `buy`: PDA(["global_volume_accumulator"]).
export const PUMP_GLOBAL_VOLUME_ACCUMULATOR = PublicKey.findProgramAddressSync(
  [Buffer.from("global_volume_accumulator")],
  PUMP_PROGRAM,
)[0];
// Only a fallback: the authoritative fee recipient is read from the `global` account at runtime
// (getGlobalFeeState()), because pump.fun rotates it. This wallet is `global.fee_recipient`.
export const PUMP_FEE_RECIPIENT_FALLBACK = new PublicKey("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");

// Mayhem: a third-party program that CPIs into pump.fun. Trades routed through it are the ones
// whose trade-event SOL reserve side breaks the x*y=k invariant (see data/research/diag390.json:
// 100% of violations, 0% for every other caller).
export const MAYHEM_PROGRAM = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");

// PumpSwap AMM for graduated tokens.
export const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

// V3 (current) event prefixes
export const TRADE_EVENT_PREFIX = Buffer.from("bddb7fd34ee661ee", "hex");

// PumpSwap AMM event prefixes
export const PUMPSWAP_TRADE_PREFIX = Buffer.from("67f4521f2cf57777", "hex");
export const PUMPSWAP_FEE_PREFIX = Buffer.from("3e2f370aa503dc2a", "hex");

// V2 (legacy) prefixes — kept for historical data analysis
export const TRADE_EVENT_PREFIX_V2 = Buffer.from("e445a52e51cb9a1d", "hex");
// Verified on a live pump.fun CreateV2 tx (2026-11): the create event prefix is
// 1b72a94ddeeb6376 (352 bytes). The old 1b72a94ddeef6e60 was stale/wrong.
export const CREATE_EVENT_PREFIX_V2 = Buffer.from("1b72a94ddeeb6376", "hex");

// Buy/sell/create determined from instruction names in logs
export const BUY_INSTRUCTIONS = new Set([
  "Buy", "BuyV2", "BuyV3", "BuyExactQuoteInV2", "BuyExactQuoteInV3", "BuyExactSolIn",
]);
export const SELL_INSTRUCTIONS = new Set([
  "Sell", "SellV2", "SellV3",
]);
// Create is detected from pump.fun's OWN create instruction (CreateV2 / Create),
// NOT from router instruction names like BondingCurveV3/BondingCurveJupiter — those
// are third-party router BUY instructions (e.g. program 6Vo3245es…) and previously
// caused false "new token" buys of tokens that already existed. Verified on-chain.
export const CREATE_INSTRUCTIONS = new Set([
  "Create", "CreateV2",
]);
// --- Volume-analyzer heuristics (shared) ---
// Jito tip accounts — used by the analyzer to DETECT tips in transactions.
// (The trading bots themselves no longer send Jito tips — priority fee only.)
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];


// Minimum number of DISTINCT wallets selling within the same slot to flag a coordinated exit.
export const COORDINATED_EXIT_MIN_WALLETS = 3;

