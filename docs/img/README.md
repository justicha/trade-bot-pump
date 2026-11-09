# Image index

All images in this folder are hand-written SVG files. They use no external fonts, no CDN, no
`<image>` tags and no scripts, and every file has a solid background so it stays readable on both
light and dark GitHub themes. Each file carries a `<title>` and a `<desc>` for screen readers.

| File | Used by | Purpose |
|---|---|---|
| `banner.svg` | `README.md` | Title banner: deep navy, teal bonding-curve line, amber accent |
| `architecture.svg` | `README.md`, `docs/architecture.md` | Module map: RPC/WS → parser → bots → tx builder → send → journal |
| `modes.svg` | `README.md`, `docs/getting-started.md` | DRY RUN vs LIVE lane by lane |
| `sniper-flow.svg` | `docs/bots.md` | `bots/sniper/sniper.mjs` decision flow with env names |
| `graduation-flow.svg` | `docs/bots.md` | `bots/graduation-sniper/graduation.mjs` decision flow |
| `wallet-flow.svg` | `README.md`, `docs/wallet-and-keys.md` | Wallet creation, funding, dry run, optional live |

## Text prompts for raster versions (optional)

If you ever want PNG/JPEG versions, these prompts describe the same artwork. Keep the palette and
the "no hype" tone; do not add price charts that look like results.

- **banner.svg** — "Wide 4:1 tech banner, deep navy background #0b1220, a single teal bonding-curve line rising and flattening, small amber dot accents and a faint node grid. The words pump-bot in a modern sans-serif, subtitle 'pump.fun on-chain bots and analytics. Dry-run first.' Flat vector style, no gradients, no logos."
- **architecture.svg** — "Clean architecture diagram on navy, rounded boxes in teal and amber, arrows left to right: Solana RPC and WebSocket, parser, bots, transaction builder, signed transaction, RPC. Three side boxes for guards, logger and journal. Minimal, high contrast, 1200x700."
- **modes.svg** — "Two horizontal swimlanes on navy, the upper one teal labelled DRY RUN with five small boxes ending in 'no transaction', the lower one amber labelled LIVE with six boxes ending in 'journal'. Flat icons, generous spacing."
- **sniper-flow.svg** — "Decision flowchart, vertical list of filters on the left (dev buy, holder gate, organic crowd, cooldown) and exit rules on the right (take profit, stop loss, timeout), navy background, teal boxes, amber entry and session-end boxes."
- **graduation-flow.svg** — "Decision flowchart focused on a bonding curve nearing graduation: real fill band, holder count, exit preview, simulate-then-buy, partial sell planning, bounded retries and a STUCK state. Navy, teal, amber."
- **wallet-flow.svg** — "Five-step horizontal flow: generate wallet, key file, fund, dry run, optional live, with a bold amber shield icon warning never to share the key file."

## Screenshots

`docs/img/screenshots/` is reserved for real terminal or dashboard captures. See the README inside
that folder for the exact shots to take and the redaction checklist.
