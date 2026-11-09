# Screenshots placeholder

No screenshots are published yet. If you add some, capture these three and keep the redaction rules.

1. **Terminal in dry-run** — the startup lines of `npm run sniper -- --dry-run`, including
   `MODE: DRY RUN`, a `SNIPING:` line and a `[DRY RUN] would buy` line.
2. **Analytics dashboard** — `npm run analytics`, then `http://localhost:3000` (the server binds
   `127.0.0.1` and the port comes from `ANALYTICS_PORT`, default 3000).
3. **Session summary** — the block printed after Ctrl+C: `SESSION SUMMARY`, spent / received / NET,
   wallet delta in LIVE, and the STUCK list if any.

Before publishing any screenshot:

- **Blur or crop the `RPC_URL`.** It usually contains `?api-key=YOUR_KEY`; treat that key as a secret.
- Remove the wallet address unless you are fine with it being public.
- Remove journal paths if they contain your Windows or macOS user name.
- Do not publish screenshots of `keys/`, `.env`, block explorers with a connected wallet, or any
  window that shows a private key or a seed phrase.
