// SOL/USD reference price — best effort, cached, never throws.
//
// Used only to print human-friendly dollar values (entry/exit price per token). Trading
// decisions are made in SOL and do not depend on this module: if every source fails the
// bot keeps working, it just logs "n/a".
const SOL_MINT = "So11111111111111111111111111111111111111112";
const TTL_MS = 60_000;

const SOURCES = [
  {
    name: "dexscreener",
    url: `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`,
    pick: (j) => Number(j?.pairs?.[0]?.priceUsd),
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    pick: (j) => Number(j?.data?.amount),
  },
];

let cache = { at: 0, usd: null, source: "" };

// Returns SOL price in USD, or null when unknown. Cached for 60s.
// SOL_PRICE_SOURCE=off disables the network sources: only SOL_USD from the env is used (useful
// offline / in tests). Default is on.
export async function getSolUsd({ force = false } = {}) {
  if (!force && cache.usd && Date.now() - cache.at < TTL_MS) return cache.usd;

  if ((process.env.SOL_PRICE_SOURCE || "").toLowerCase() !== "off") {
    for (const s of SOURCES) {
      try {
        const res = await fetch(s.url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) continue;
        const v = s.pick(await res.json());
        if (Number.isFinite(v) && v > 0) {
          cache = { at: Date.now(), usd: v, source: s.name };
          return v;
        }
      } catch {
        /* try the next source */
      }
    }
  }

  // Manual override / last known value.
  const env = Number(process.env.SOL_USD);
  if (Number.isFinite(env) && env > 0) return env;
  return cache.usd;
}

export function solUsdSource() {
  return cache.source;
}

// Pretty dollar amount: $188.24, $0.00528, $0.003997, $0.000000528
export function fmtUsd(x) {
  if (!Number.isFinite(x)) return "$n/a";
  const a = Math.abs(x);
  if (a === 0) return "$0";
  if (a >= 1) return `$${x.toFixed(2)}`;
  if (a >= 0.01) return `$${x.toFixed(4)}`;
  if (a >= 0.000000001) {
    // Keep the significant digits of micro-cap prices instead of rounding them away.
    const s = x.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
    return `$${s}`;
  }
  return `$${x.toExponential(2)}`;
}

// Format a token price given in SOL as dollars.
export function solPerTokenToUsd(priceSol, solUsd) {
  if (!Number.isFinite(priceSol) || !Number.isFinite(solUsd)) return null;
  return priceSol * solUsd;
}
