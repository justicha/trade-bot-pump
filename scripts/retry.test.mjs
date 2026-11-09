// Unit test for withBackoff + isRetryable with REAL web3.js 429 shapes (by message and status/code).
import { withBackoff, isRetryable } from "../lib/retry.mjs";

// A request that hit its RPC deadline is transient: the retry loop must not give up on it.
const timeouts = [
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
  Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
  new Error("request timed out"),
];
for (const [i, t] of timeouts.entries()) {
  if (!isRetryable(t)) { console.error("FAIL: timeout form not retryable #" + i); process.exit(1); }
}

const forms = [
  new Error("429 Too Many Requests"),
  Object.assign(new Error("Server responded with 429 Too Many Requests.  Retrying after 500ms delay..."), { status: 429 }),
  Object.assign(new Error("HTTP error"), { code: 429 }),
];
for (const [i, f] of forms.entries()) {
  if (!isRetryable(f)) { console.error("FAIL: 429 form not retryable #" + i); process.exit(1); }
}
if (isRetryable(new Error("invalid input: not retryable"))) {
  console.error("FAIL: permanent error wrongly marked retryable");
  process.exit(1);
}
// negatives: a bare "429" inside a signature or a slot number must NOT be retryable
const notRetry = [
  new Error("failed at slot 429"),
  new Error("sig 3xK9p429qZabc7 not found"),
];
for (const [i, e] of notRetry.entries()) {
  if (isRetryable(e)) { console.error("FAIL: non-429 wrongly retryable #" + i + " -> " + e.message); process.exit(1); }
}

// mock: throw a real 429 message twice, then succeed
let calls = 0, retries = 0;
const sleeps = [];
const err429 = new Error("Server responded with 429 Too Many Requests.  Retrying after 500ms delay...");
const res = await withBackoff(
  () => { calls++; if (calls <= 2) throw err429; return "ok"; },
  { tries: 5, baseMs: 10, sleep: async (ms) => { sleeps.push(ms); }, onRetry: () => { retries++; } },
);

console.log(JSON.stringify({ forms: forms.length, permanentRetryable: isRetryable(new Error("invalid input")), res, calls, retries, sleeps }));
if (res !== "ok" || calls !== 3 || retries !== 2) { console.error("FAIL: retry flow"); process.exit(1); }
console.log("PASS: 3 real 429 shapes retryable, 3 timeout shapes retryable, permanent not, retried 2x -> success");
