// Fixture for scripts/late-sale.test.mjs: the send REQUEST itself fails (an RPC timeout), so the
// caller never gets a signature from the node. Nothing is sent anywhere.
export const connection = {
  async sendRawTransaction() {
    throw new Error("request timed out: the operation was aborted");
  },
  async getLatestBlockhash() {
    return { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 };
  },
  async getBlockHeight() {
    return 100;
  },
};
