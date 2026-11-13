# Project: Solana / pump.fun trading bot (Node >=22, ESM)
Goal: a strategy with positive expected value AFTER costs. Dry-run/shadow first.
Reply language: Russian, short. Code and commands as is. Files, comments and docs: English.

## Bans (everyone)
- Do not read or print .env, keys/, private keys, seed phrases, RPC keys.
- Do not run --live, do not set LIVE_CONFIRM=yes / LIVE_CONFIRM_AMM=yes, do not send transactions.
- Commit/push only via `npm run ship -- "message"` and only on my command.
- Do not change TP/SL/bet size/limits without my decision.

## Roles
- CODING: edits critical code (money, fees, PnL, live gates, AMM sell). Every change comes with a test.
- PROMPT: does not edit code; writes prompts, reviews, analyses journals. Writes only to agents/.
- Cline (DeepSeek): mechanical edits from agents/TASK.md, report in agents/REPORT.md.

## Statistics
Unique mints = independent observations. Bootstrap only at n>=30, a profitability conclusion only at n>=200. Never mix different costsScheme.