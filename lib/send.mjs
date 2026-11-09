// Send helper for the trading bots: simulate first, then send.
//
// Why: `skipPreflight: true` used to be the default, so a fundamentally broken tx was broadcast,
// landed, failed on-chain and still paid 5000 lamports + the priority fee. simulateTransaction
// runs the same checks locally: if it fails we throw a readable reason and never broadcast.
// The broadcast itself still uses skipPreflight — the simulation above already did the preflight,
// and repeating it would add a round trip inside the latency budget.
import { simulateTx } from "./exec.mjs";
import { sendTxWithRetry } from "./rpc.mjs";
import { describeTxError } from "./pump-errors.mjs";

export async function simulateThenSend(tx, { maxRetries = 3 } = {}) {
  const sim = await simulateTx(tx);
  if (!sim.ok) throw new Error(`simulation failed: ${describeTxError(sim.err)}`);
  return sendTxWithRetry(tx, { skipPreflight: true, maxRetries });
}
