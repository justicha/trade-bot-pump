// Fixture RPC for scripts/rescue-gate.test.mjs: empty holdings, no sends.
// sendRawTransaction throws so the test can prove it is never reached.
export const connection = {
  async getTokenAccountsByOwner() {
    return { value: [] };
  },
  async getAccountInfo() {
    return null; // refreshGlobalFeeState -> "global account unavailable/short" -> caught
  },
  async getBalance() {
    return 2_000_000_000;
  },
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  },
  async sendRawTransaction() {
    throw new Error("sendRawTransaction must not be called in this test");
  },
};
