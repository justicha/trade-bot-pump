// Retry helper: exponential backoff + jitter. Pure (sleep injectable) so it can be unit-tested.
// Retries on transient errors only: HTTP 429, HTTP 5xx, request timeouts/aborts, and common
// network failures (ECONNRESET/ECONNREFUSED/ETIMEDOUT, "fetch failed", "socket hang up"). Permanent
// errors (4xx other than 429, program errors) are NOT retried — the number of tries is bounded by
// the caller (rpcCall uses retries=2 → 3 attempts total, so retries never loop forever).
export function isRetryable(err) {
  if (!err) return false;
  // A request that hit its deadline (lib/rpc.mjs timedFetch) is transient: retry it instead of
  // letting the caller hang or give up on a single slow response.
  const name = err.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = err.status ?? err.code;
  if (code === 429) return true; // HTTP status / error code first
  // Transient server-side failures: any HTTP 5xx.
  const status = err.status ?? err.statusCode;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  const m = String(err.message ?? err);
  const cause = String(err.cause?.code ?? err.cause?.message ?? "");
  if (/timed? ?out|aborted|socket hang up|fetch failed|network error/i.test(`${m} ${cause}`)) return true;
  if (/^E(CONNRESET|CONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/i.test(cause.trim())) return true;
  if (/too many requests/i.test(m)) return true;
  if (/^\s*429\b/.test(m)) return true; // message begins with status 429
  if (/(?:http|status|error|code)\D{0,3}\b429\b/i.test(m)) return true; // "HTTP 429", "status 429"
  return false; // e.g. "429" embedded in a signature / slot number -> NOT retryable
}

export async function withBackoff(fn, opts = {}) {
  const {
    tries = 5,
    baseMs = 300,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onRetry,
    retryable = isRetryable,
  } = opts;
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (a === tries - 1 || !retryable(e)) break;
      if (onRetry) onRetry(a, e);
      const base = baseMs * 2 ** a;               // 300, 600, 1200, 2400 ms (default)
      const jitter = Math.floor(Math.random() * base);
      await sleep(base + jitter);
    }
  }
  throw lastErr;
}
