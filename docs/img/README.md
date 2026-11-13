# Images

All files in this folder are hand-written SVGs. They have no external fonts, CDNs, `<image>` tags or
scripts. Every image has a solid dark background, so it reads the same in GitHub's light and
dark theme. Every file has `<title>` and `<desc>` — screen readers read them, and they
become the alt text on pages.

| File | Where used | What it shows |
|---|---|---|
| `banner.svg` | `README.md` | Banner: dark grid background, neon bonding curve to graduation (100% ≈ 85 SOL), the entry band (configurable, animated), the PumpSwap pool; badges DRY-RUN by default, Solana, pump.fun → PumpSwap |
| `flow.svg` | `README.md` | Five steps left to right: watch → filters → buy → exit → journal |
| `architecture.svg` | `docs/architecture.md` | Module map: RPC and WebSocket → parser → calculations → bots → transaction build → send → journal; guards, logger and journal at the side |
| `modes.svg` | `docs/getting-started.md` | Two paths: dry-run (0 transactions) and live (simulation, signing, confirmation) |
| `sniper-flow.svg` | `docs/bots.md` | `bots/sniper/sniper.mjs`: entry filters, buy, exit polling, session summary |
| `graduation-flow.svg` | `docs/bots.md` | `bots/graduation-sniper/graduation.mjs`: the fill corridor, holders, exit check, partial sells, STUCK, the PumpSwap path |
| `wallet-flow.svg` | `docs/wallet-and-keys.md` | Wallet: create → key file → fund → dry-run → (optional) live, plus a key warning |
| `dryrun-terminal.svg` | `README.md`, `docs/getting-started.md` | An illustration of the bot's dry-run output. Addresses and amounts are placeholders; the window title says "example output, not real data" |

## Rules for new images

- Palette: background `#0b1220`–`#0d1523`, panels `#141d2b` and `#122238`, teal `#2dd4bf`, amber
  `#fbbf24`, text `#e6f1ff` / `#9fb3c8` / `#8aa0b8`.
- Platform fonts only: `system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif` for
  text and `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for the "terminal".
- No profit promises, no "profit" charts and no real addresses. If you show bot output —
  use placeholders (`MINT_EXAMPLE`, `WALLET_EXAMPLE`, `0.00`) and label it as an illustration.
- Check that text stays inside its box: split long variable names into two
  lines rather than shrinking the font below 10 px.
- The file must parse as XML: `python -c "import xml.dom.minidom as m; m.parse('docs/img/x.svg')"`.

## Screenshots

The `docs/img/screenshots/` folder is reserved for real terminal or dashboard screenshots. What to capture
and what to redact before publishing is in `screenshots/README.md`. There are no such screenshots in the repo:
an empty folder with `.gitkeep` is normal.
