// Fixture RPC for scripts/prebuy-buy-sell.test.mjs (RPC_MOCK=<this file>): the same curve fixture
// as rpc-mock.mjs, but EVERY simulation fails the way a sell without tokens fails on-chain
// (6023 NotEnoughTokensToSell). A dry run must still track the position: the pre-buy simulation is
// informational there.
import { connection as base } from "./rpc-mock.mjs";

export const connection = {
  ...base,
  async simulateTransaction() {
    return {
      value: {
        err: { InstructionError: [3, { Custom: 6023 }] },
        logs: ["Program log: Instruction: Sell", "Program log: Error Code: NotEnoughTokensToSell", "Program log: Left: 0", "Program log: Right: 123"],
        unitsConsumed: 31_000,
      },
    };
  },
};
