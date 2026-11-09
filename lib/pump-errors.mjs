// pump.fun program error codes, copied from the official IDL (@pump-fun/pump-sdk/idl/pump.json).
// A failed trade must report "6024 Overflow", not a bare {Custom:6024} — the difference between
// "curve cannot pay" and "slippage" is what decides whether a retry can ever succeed.
export const PUMP_ERRORS = {
  6000: ["NotAuthorized", "not authorized to execute this instruction"],
  6001: ["AlreadyInitialized", "already initialized"],
  6002: ["TooMuchSolRequired", "slippage: too much SOL required to buy the given tokens"],
  6003: ["TooLittleSolReceived", "slippage: too little SOL received to sell the given tokens"],
  6004: ["MintDoesNotMatchBondingCurve", "mint does not match the bonding curve"],
  6005: ["BondingCurveComplete", "bonding curve completed, liquidity migrated"],
  6006: ["BondingCurveNotComplete", "bonding curve not completed"],
  6007: ["NotInitialized", "not initialized"],
  6008: ["WithdrawTooFrequent", "withdraw too frequent"],
  6010: ["AccountTypeNotSupported", "account type not supported"],
  6013: ["FeeBasisPointsGreaterThanMaximum", "fee basis points above the maximum"],
  6019: ["InvalidCreator", "invalid creator pubkey"],
  6020: ["BuyZeroAmount", "buy zero amount"],
  6021: ["NotEnoughTokensToBuy", "not enough tokens to buy"],
  6022: ["SellZeroAmount", "sell zero amount"],
  6023: ["NotEnoughTokensToSell", "not enough tokens to sell"],
  6024: ["Overflow", "arithmetic overflow (typical when the curve cannot pay the sell)"],
  6025: ["Truncation", "arithmetic truncation"],
  6026: ["DivisionByZero", "division by zero"],
  6027: ["NotEnoughRemainingAccounts", "not enough remaining accounts"],
  6028: ["AllFeeRecipientsShouldBeNonZero", "a fee recipient is the zero key"],
  6029: ["UnsortedNotUniqueFeeRecipients", "fee recipients unsorted or not unique"],
  6030: ["CreatorShouldNotBeZero", "creator is the zero key"],
  6040: ["BuyNotEnoughSolToCoverRent", "buy: not enough SOL to cover rent"],
  6041: ["BuyNotEnoughSolToCoverFees", "buy: not enough SOL to cover fees"],
  6042: ["BuySlippageBelowMinTokensOut", "slippage: would buy fewer tokens than min_tokens_out"],
  6047: ["CpitializeMayhemFailed", "mayhem init failed"],
  6048: ["MayhemModeDisabled", "mayhem mode disabled"],
  6049: ["CreatorMigratedToSharingConfig", "creator migrated to a sharing config"],
  6077: ["CreatorFeeNotConfigurable", "configurable creator fees are disabled"],
  6079: ["CreatorFeeNotEditable", "creator fee not editable for this curve"],
  6080: ["CreatorFeeNotAllowedForCashbackCoin", "creator fee not allowed on a cashback coin"],
  6081: ["BondingCurveAlreadyMigrated", "bonding curve already migrated"],
  6082: ["CashbackDeprecated", "cashback coins can no longer be created"],
  6084: ["HolderRewardDisabled", "holder-reward coins are disabled"],
  6088: ["CtoNotAllowedForMayhemCoin", "CTO not allowed on a mayhem coin"],
  6094: ["CashbackCoinNotSupported", "v3 trades do not support cashback coins; use the v2 instructions"],
  6096: ["FeeTiersEmpty", "the fee config tier table is empty"],
  6098: ["MultiHopDiscontinuousPath", "multi-hop: discontinuous input mint"],
  6099: ["InvalidQuoteBondingCurve", "quote bonding curve account does not match"],
  6100: ["QuoteBondingCurveNotEligible", "quote bonding curve not eligible as a quote"],
  6101: ["QuotePoolAccountsRequired", "migrated quote curve: pool and vault accounts required"],
  6102: ["QuotePoolNotFound", "quote pool is not an initialized pump-amm pool"],
  6103: ["InvalidQuotePool", "quote pool accounts do not match derivation"],
  6104: ["QuoteReservesOutOfRange", "derived quote reserves are zero"],
  6105: ["CurveDepthExceeded", "curve depth exceeds Global.max_curve_depth"],
  6107: ["QuoteCurveAwaitingMigration", "quote curve complete but not migrated yet"],
  6108: ["MultiHopMayhemCurveNotSupported", "mayhem curves are not routable; use v2"],
};

export function describeCustom(code) {
  const hit = PUMP_ERRORS[code];
  return hit ? `${code} ${hit[0]} (${hit[1]})` : `Custom ${code} (unknown pump error)`;
}

// Normalize the shapes web3.js throws: {InstructionError:[i,{Custom:n}]}, [i,"ProgramFailedToComplete"],
// TransactionExpiredBlockheightExceededError, plain Error, or a raw object.
export function parseInstructionError(err) {
  const raw = err?.InstructionError ?? err?.err?.InstructionError ?? null;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const [ixIndex, reason] = raw;
  if (reason && typeof reason === "object" && "Custom" in reason) {
    return { ixIndex, kind: "custom", code: Number(reason.Custom) };
  }
  return { ixIndex, kind: "system", name: String(reason) };
}

export function describeTxError(err) {
  const p = parseInstructionError(err);
  if (p) {
    return p.kind === "custom"
      ? `instruction ${p.ixIndex}: ${describeCustom(p.code)}`
      : `instruction ${p.ixIndex}: ${p.name}`;
  }
  if (err instanceof Error && err.message) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

const codeOf = (err) => parseInstructionError(err)?.code ?? null;
export const isCurveCompleteError = (err) => [6005, 6081].includes(codeOf(err));
export const isSlippageError = (err) => [6002, 6003, 6042].includes(codeOf(err));
export const isOverflowError = (err) => codeOf(err) === 6024;
