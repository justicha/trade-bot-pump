# Verification status

Short answer: **the code is tested, the strategy is not proven.** Those are different things.

## What is tested

- `npm test` runs **73 test files** (the list lives in `package.json`). All of them run offline and
  without a wallet: the ones that touch the network point at local RPC/WebSocket fixtures, and the
  rest are pure unit tests that boot a temporary data directory. No network, no SOL.
- The suite covers the parts that are easy to get silently wrong: the log parser, the curve and fee
  math, sell splitting when a curve cannot pay, retries and timeouts, key handling, the journal, and
  bot wiring (a synthetic create/buy/sell stream drives the real sniper handler).
- `node --check` is run over every `.mjs` file; a syntax error cannot reach a run.

Tests prove that the code does what its comments say. They do **not** prove that trading with it
makes money.

## What is not tested

- The **live** branches of the three trading bots (real signing, real sending, real fill
  reconciliation). They cannot be exercised without a funded wallet and a real network, so they are
  reviewed by reading the code, not executed by an automated test.
- Anything about market behaviour: no backtest, no forward test, no track record, no profit figure.
- The token-ATA close after a full live sale (and the `close-empty-atas.mjs` sweep) is verified on mocks only, never on a real transaction.

## The audit log

The file [`dev-reports/BUGS_VERIFICATION.md`](dev-reports/BUGS_VERIFICATION.md) is a historical
audit of 29 reported issues plus follow-up findings, with a verdict and a status per row. Read it
like a changelog, not like a certificate:

- A row marked **FIXED** usually names the test that confirms it.
- A row marked **DEFERRED** (or **NEEDS VERIFICATION**, e.g. the exact semantics of the buy
  instruction's `amount` field) means the log was not updated — not that the problem is still
  present in the code you are reading.
- Line numbers in that file refer to the code at the time of the audit and will drift.

## How to reproduce

```powershell
npm ci --ignore-scripts
npm test
```

The run prints one `PASS:` line per test file. A failure prints `FAIL:` and exits non-zero;
`npm test` stops at the first failure, so run a single file directly when debugging
(`node scripts/smoke.test.mjs`).

A harmless `bigint: Failed to load bindings` warning may appear. It is safe.
