import { Connection } from "@solana/web3.js";
import { RPC_URL, WS_URL, LIVE, CU_PRICE, CU_LIMIT, RPC_TIMEOUT_MS } from "./config.mjs";
import { pathToFileURL } from "node:url";
import { rpcLimiter } from "./ratelimit.mjs";
import { withBackoff, isRetryable } from "./retry.mjs";

// Test hook: RPC_MOCK=<path to an ESM module exporting `connection`> replaces the network client.
const MOCK_PATH = process.env.RPC_MOCK;
const mock = MOCK_PATH ? await import(MOCK_PATH.startsWith(".") || MOCK_PATH.includes(":") ? pathToFileURL(MOCK_PATH).href : MOCK_PATH) : null;

if (mock && LIVE) {
  throw new Error("RPC_MOCK is a test fixture and cannot be used with --live. Unset RPC_MOCK or drop --live.");
}

// Every HTTP RPC call gets a hard deadline. web3.js never sets one, so a half-open/throttled
// connection hangs the call forever; a retry wrapper only helps if the call actually fails.
// Timeouts abort the request, `isRetryable` treats them as transient, and the caller recovers.
function timedFetch(input, init = {}) {
  return fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
}

export const connection = mock
  ? mock.connection
  : new Connection(RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: WS_URL,
      // Web3's built-in retry re-issues the request with its own backoff and prints
      // "Server responded with 429 Too Many Requests" every attempt. Our limiter controls the
      // cadence and counts each 429, so the built-in retry is off.
      disableRetryOnRateLimit: true,
      // Hard per-request deadline (RPC_TIMEOUT_MS). Without it a throttled endpoint hangs the
      // request forever and the bot silently stops trading while its process stays alive.
      fetch: timedFetch,
    });

// ---- RPC stats ----------------------------------------------------------------
// Solana charges the priority fee against the REQUESTED compute-unit limit, not the units used:
// 300k CU at 1.5 µlamports/CU = 450k lamports + 5k base = 455k — exactly what the live txs paid.
// So failed-but-landed txs cost a real, predictable fee; we count it separately.
const TX_BASE_FEE_LAMPORTS = 5000;
export const estTxFeeLamports = () => TX_BASE_FEE_LAMPORTS + (CU_PRICE * CU_LIMIT) / 1e6;

export const rpcStats = {
  calls: 0,
  errors: 0,
  retries429: 0,
  maxDelayMs: 0,
  txOk: 0,
  txFails: 0, // txs that landed on-chain and failed (they still paid the fee)
  txFailFeeLamports: 0, // estimated fee paid by those failed txs
  get degraded() {
    return rpcStats.calls > 0 && rpcStats.retries429 / rpcStats.calls > 0.05;
  },
  snapshot() {
    return {
      calls: rpcStats.calls,
      errors: rpcStats.errors,
      retries429: rpcStats.retries429,
      maxDelayMs: rpcStats.maxDelayMs,
      txOk: rpcStats.txOk,
      txFails: rpcStats.txFails,
      txFailFeeSol: Math.round((rpcStats.txFailFeeLamports / 1e9) * 1e9) / 1e9,
      degraded: rpcStats.degraded,
    };
  },
};

// One rate-limited RPC call. `priority`: 0 = exit, 1 = entry, 2 = ticks, 3 = rest.
export async function rpcCall(fn, { priority = 3, retries = 2 } = {}) {
  await rpcLimiter.acquire(priority);
  const t0 = Date.now();
  rpcStats.calls += 1;
  try {
    return await withBackoff(fn, {
      tries: retries + 1,
      baseMs: 250,
      onRetry: (_attempt, err) => {
        rpcStats.errors += 1;
        if (isRetryable(err)) rpcStats.retries429 += 1;
      },
    });
  } finally {
    rpcStats.maxDelayMs = Math.max(rpcStats.maxDelayMs, Date.now() - t0);
  }
}

export async function sendTxWithRetry(tx, opts = {}) {
  const blockhash = tx.message.recentBlockhash;
  let lastValidBlockHeight = tx.lastValidBlockHeight;

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? false,
    maxRetries: opts.maxRetries ?? 3,
    preflightCommitment: "confirmed",
  });
  console.log(`tx sent: ${sig}`);

  if (!lastValidBlockHeight) {
    lastValidBlockHeight = (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
  }

  let result;
  try {
    result = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
  } catch (e) {
    // The tx was sent: if it landed, the fee was paid even though it failed. An EXPIRED tx never
    // landed (web3.js rejects with TransactionExpiredBlockheightExceededError / TimeoutError,
    // which carry a `.name`, not an `.expired` field) — count only real landed failures.
    if (!isExpiredTxError(e)) {
      rpcStats.txFails += 1;
      rpcStats.txFailFeeLamports += estTxFeeLamports();
    }
    throw txError(e, sig);
  }
  if (result.value.err) {
    rpcStats.txFails += 1;
    rpcStats.txFailFeeLamports += estTxFeeLamports();
    throw txError(result.value.err, sig);
  }
  rpcStats.txOk += 1;
  console.log(`tx confirmed: ${sig}`);
  return sig;
}

// web3.js (1.99) rejects an expired transaction with a TransactionExpiredBlockheightExceededError
// or TransactionExpiredTimeoutError — plain Error classes identified by `.name`, without an
// `.expired` field. A tx that expired NEVER landed, so its fee must not be counted as a
// landed-but-failed tx fee.
export function isExpiredTxError(e) {
  if (!e) return false;
  if (e.expired === true) return true;
  const n = e.name ?? "";
  if (n === "TransactionExpiredBlockheightExceededError" || n === "TransactionExpiredTimeoutError") return true;
  return /has expired/i.test(String(e.message ?? ""));
}

// Normalize on-chain errors. web3.js `confirmTransaction` can `reject(value.err)` with the
// raw error object (no `.message`), so callers would otherwise log "buy failed: undefined".
// The raw payload is attached as `err` so pump-errors.parseInstructionError can still decode the
// code (6005/6081 must be recognized to blacklist a completed curve even on the send path).
// The signature is attached as `sig` on every throw so a caller can reconcile a possibly-landed
// transaction via readExecution(sig) instead of dropping the position (C2).
function txError(err, sig) {
  if (err instanceof Error && err.message) {
    err.sig ??= sig;
    return err;
  }
  const e = new Error(`tx ${sig} failed on-chain: ${JSON.stringify(err)}`);
  e.err = err;
  e.sig = sig;
  return e;
}

export async function getSOLBalance(pubkey) {
  return (await rpcCall(() => connection.getBalance(pubkey), { priority: 3 })) / 1e9;
}
