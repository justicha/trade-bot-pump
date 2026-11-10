# Security

This page collects everything a reader should know about keys, secrets and trust. Nothing here is
optional advice — it is how the code actually behaves.

## The key file is a plain secret on disk

`keys/<name>.json` (default: `keys/default.json`) contains the wallet's **secret key** as a JSON
array of 64 numbers. There is no password, no encryption and no hardware wallet support. Anyone who
reads that file owns the wallet.

- It lives only on your machine. The bot never uploads it.
- `keys/` is listed in `.gitignore`. Check with `git ls-files keys` — it must print nothing.
- `node lib/wallet.mjs generate` writes the file atomically and refuses to overwrite an existing
  one unless you pass `--force`, so a funded wallet cannot be erased by accident.
- The name you pass is restricted to `[A-Za-z0-9_-]+`, so it cannot point outside `keys/`.

Details of generating, funding and backing up: [wallet-and-keys.md](wallet-and-keys.md).

## `.env` holds your RPC URL (and often an API key)

`RPC_URL` frequently looks like `https://mainnet.helius-rpc.com/?api-key=…`, which means the file
contains a paid credential even though it holds no wallet.

- `.env` is gitignored. Verify with `git ls-files .env` — it must print nothing.
- Never paste a full `.env` into an issue, a chat or a screenshot.
- A leaked RPC key is less dangerous than a leaked private key, but it is still someone else's bill.

## What to read before running live

Live mode signs and sends real transactions. The whole path is short — read it first:

| File | Role |
|---|---|
| `lib/wallet.mjs` | loads the key file, generates a wallet |
| `lib/tx.mjs` | builds the versioned transaction (compute budget, instructions) |
| `lib/send.mjs` | simulates, sends, confirms |
| `lib/exec.mjs` | reads the actual fill from the transaction meta afterwards |

If you run a fork or a copy you found elsewhere, read those four files in that copy. A single added
line can redirect a transfer.

## Logs and journals are not private

The console logger (`lib/logger.mjs`) masks things that look like secrets: an array of 60+ small
integers, `secretKey=…` / `privateKey=…` pairs, base58 runs of 80–90 characters, and raw
`Buffer`/`Uint8Array` values. That protects the console output only.

- Your terminal scrollback, `data/journal/*.jsonl` and the raw captures under `data/raw/` are
  plain text on disk. They contain mints, your public key, sizes and results.
- Before publishing a screenshot or a log: blur the `RPC_URL`, and remove your wallet address if you
  do not want it public.
- Never capture `keys/` or `.env` in a screenshot.

## Trusting the endpoint

Every bot trusts the RPC it is pointed at. A slow, throttled or malicious endpoint can hide events,
delay them, or feed wrong account data.

- Use a private endpoint you pay for; public ones throttle `logsSubscribe` and the bot will look idle.
- Watch `rpcStats` in the session summary (429 share, errors, latency).
- The code has a hard per-request timeout (`RPC_TIMEOUT_MS`, 15 s default) exactly because a
  throttled endpoint can accept the connection and never answer.

## Dependencies

Four runtime dependencies, declared in `package.json` and locked by `package-lock.json`:
`@solana/web3.js`, `@solana/spl-token`, `bs58` and `ws`. Install with `npm ci --ignore-scripts` so
the lock file is authoritative and dependency lifecycle scripts do not run. Read
[commands.md](commands.md) for what each command does.

## Not audited

There has been **no third-party security review** of this code. Treat it as source you are reading
yourself, not as a product with a guarantee.
