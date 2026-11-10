// Every reason the graduation bot refuses to buy, in one place: the journal, the log line and the
// tests all use these exact strings, so a typo cannot silently change what a skip means.
export const BUY_SKIP_REASON = {
  insufficientExitDepth: "insufficient exit depth",
  token2022Unsafe: "token-2022 extension", // suffix: ": transfer fee" etc.
  unverifiedExtensions: "unverified token extensions",
  mayhemMode: "mayhem mode",
  curveSellSimulation: "curve sell simulation failed",
  dailyLossLimit: "daily loss limit",
  liveGate: "LIVE_CONFIRM_AMM not set, PumpSwap sell path unverified",
};
