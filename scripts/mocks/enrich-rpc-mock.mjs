// RPC mock for scripts/enrich-mints.test.mjs (CLI wiring + resume). Every read prints a marker
// line so the test can prove which mints were touched. Nothing here can sign or send: the methods
// that would are absent, so a call to them throws.
export const connection = {
  async getSignaturesForAddress(pk) {
    console.log(`MOCK getSignatures ${pk.toBase58()}`);
    return []; // no history: the row must carry an error, not crash
  },
  async getTransaction(sig) {
    console.log(`MOCK getTransaction ${sig}`);
    return null;
  },
  async getAccountInfo(pk) {
    console.log(`MOCK getAccountInfo ${pk.toBase58()}`);
    return null;
  },
};
