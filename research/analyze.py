"""Behavioural analysis of a wallet from downloaded transactions.
python3 research/analyze.py <wallet> [--json out.json]

What it computes:
  * tx classification: buy / sell / transfer_in / transfer_out / other
  * venue (pump.fun bonding curve, PumpSwap, Jupiter, Raydium, custom routers)
  * pump.fun TradeEvent events -> price, mcap in SOL, bonding curve progress at entry
  * priority fee, CU limit, tips (Jito and other small transfers in swap txs)
  * per mint: SOL in / out, PnL, number of buys/sells, holding time
"""
import collections
import hashlib
import json
import os
import statistics as st
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
from solparse import JITO_TIPS, KNOWN, PUMP, PUMP_AMM, WSOL, b58decode, b58encode, compute_budget  # noqa: E402

EVENT_IX_TAG = bytes.fromhex("e445a52e51cb9a1d")  # anchor emit_cpi
DISC = lambda name: hashlib.sha256(f"event:{name}".encode()).digest()[:8]
TRADE_EVENT = DISC("TradeEvent")
CREATE_EVENT = DISC("CreateEvent")
AMM_BUY, AMM_SELL = DISC("BuyEvent"), DISC("SellEvent")
TOTAL_SUPPLY = 1_000_000_000  # pump.fun tokens: 1B, 6 decimals
STABLES = {WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}


def parse_trade_event(b: bytes):
    o = 0
    mint = b58encode(b[o:o + 32]); o += 32
    sol, tok = struct.unpack_from("<QQ", b, o); o += 16
    is_buy = b[o] == 1; o += 1
    user = b58encode(b[o:o + 32]); o += 32
    ts, vsol, vtok, rsol, rtok = struct.unpack_from("<qQQQQ", b, o); o += 40
    return dict(mint=mint, sol=sol / 1e9, tokens=tok / 1e6, is_buy=is_buy, user=user, ts=ts,
                vsol=vsol / 1e9, vtok=vtok / 1e6, real_sol=rsol / 1e9, real_tok=rtok / 1e6,
                mcap_sol=(vsol / 1e9) / (vtok / 1e6) * TOTAL_SUPPLY if vtok and vsol else None,
                quote_is_sol=vsol > 0)


def events(tx):
    """pump.fun TradeEvent from inner self-CPIs and/or logs."""
    out = []
    for g in tx["meta"].get("innerInstructions") or []:
        for ii in g["instructions"]:
            if ii.get("programId") != PUMP or "data" not in ii:
                continue
            d = b58decode(ii["data"])
            if d[:8] == EVENT_IX_TAG and d[8:16] == TRADE_EVENT:
                try:
                    out.append(parse_trade_event(d[16:]))
                except Exception:
                    pass
    return out


def all_programs(tx):
    p = [ix["programId"] for ix in tx["transaction"]["message"]["instructions"]]
    for g in tx["meta"].get("innerInstructions") or []:
        p += [ii["programId"] for ii in g["instructions"]]
    return p


def token_deltas(tx, owner):
    d = collections.defaultdict(float)
    for side, sign in (("preTokenBalances", -1), ("postTokenBalances", 1)):
        for b in tx["meta"].get(side) or []:
            if b.get("owner") == owner:
                d[b["mint"]] += sign * float(b["uiTokenAmount"]["uiAmountString"] or 0)
    return {m: v for m, v in d.items() if abs(v) > 1e-9}


def sol_transfers_from(tx, src):
    """All system transfers from src (top-level + inner)."""
    ixs = list(tx["transaction"]["message"]["instructions"])
    for g in tx["meta"].get("innerInstructions") or []:
        ixs += g["instructions"]
    out = []
    for ix in ixs:
        p = ix.get("parsed")
        if ix.get("programId") == "11111111111111111111111111111111" and isinstance(p, dict) and p.get("type") == "transfer":
            if p["info"]["source"] == src:
                out.append((p["info"]["destination"], p["info"]["lamports"] / 1e9))
    return out


def venue(progs):
    s = set(progs)
    if PUMP in s:
        return "pump.fun"
    if PUMP_AMM in s:
        return "pumpswap"
    for k in s:
        if KNOWN.get(k, "").startswith(("JUPITER", "RAYDIUM", "METEORA", "ORCA")):
            return KNOWN[k].lower()
    return "other"


def analyze(wallet):
    d = os.path.join(os.path.dirname(__file__), "..", "data", "raw", wallet)
    txs = []
    for f in os.listdir(d):
        t = json.load(open(os.path.join(d, f)))
        if t:
            txs.append(t)
    txs.sort(key=lambda t: (t["slot"], t["blockTime"] or 0))

    rows, fails = [], collections.Counter()
    for t in txs:
        keys = [k["pubkey"] for k in t["transaction"]["message"]["accountKeys"]]
        progs = all_programs(t)
        if t["meta"]["err"] is not None:
            fails[(venue(progs), json.dumps(t["meta"]["err"]))] += 1
            continue
        if wallet not in keys:
            continue
        i = keys.index(wallet)
        sol = (t["meta"]["postBalances"][i] - t["meta"]["preBalances"][i]) / 1e9
        tk = token_deltas(t, wallet)
        wsol = tk.pop(WSOL, 0.0)
        sol_total = sol + wsol
        meme = {m: v for m, v in tk.items() if m not in STABLES}
        signer = t["transaction"]["message"]["accountKeys"][i]["signer"]
        cb = compute_budget(t["transaction"]["message"]["instructions"])
        outs = sol_transfers_from(t, wallet)
        tips = [(dst, amt) for dst, amt in outs if dst in JITO_TIPS]
        ev = [e for e in events(t) if e["user"] == wallet]
        if meme:
            mint, amt = max(meme.items(), key=lambda kv: abs(kv[1]))
            kind = "buy" if amt > 0 and sol_total < 0 else "sell" if amt < 0 and sol_total > 0 else (
                "token_in" if amt > 0 else "token_out")
        else:
            mint, amt = None, 0
            kind = "transfer_out" if outs and sol < 0 else "transfer_in" if sol > 0 else "other"
        rows.append(dict(sig=t["transaction"]["signatures"][0], slot=t["slot"], ts=t["blockTime"], kind=kind,
                         mint=mint, tokens=amt, sol=sol_total, fee=t["meta"]["fee"] / 1e9, signer=signer,
                         payer=keys[0], venue=venue(progs), cu_price=cb.get("cu_price"), cu_limit=cb.get("cu_limit"),
                         cu_used=t["meta"].get("computeUnitsConsumed"), tips=sum(a for _, a in tips),
                         other_outs=[(dst, a) for dst, a in outs if dst not in JITO_TIPS],
                         ev=ev[0] if ev else None,
                         top_programs=[KNOWN.get(ix["programId"], ix["programId"]) for ix in t["transaction"]["message"]["instructions"]]))
    return rows, fails


def summarize(wallet, rows, fails):
    P = print
    P(f"\n================ {wallet} ================")
    if not rows:
        P("no successful transactions involving the wallet")
        return {}
    span_h = (rows[-1]["ts"] - rows[0]["ts"]) / 3600 or 1e-9
    kinds = collections.Counter(r["kind"] for r in rows)
    P(f"successful tx: {len(rows)} in {span_h:.1f} h  ({len(rows) / span_h:.1f}/h);  failed in the sample: {sum(fails.values())}")
    P("types:", dict(kinds))
    P("signs itself:", sum(r["signer"] for r in rows), "/", len(rows))
    P("venues (buy/sell):", collections.Counter(r["venue"] for r in rows if r["kind"] in ("buy", "sell")).most_common())
    P("top-level programs:", collections.Counter(p for r in rows for p in set(r["top_programs"])).most_common(10))
    if fails:
        P("errors:", fails.most_common(6))

    trades = [r for r in rows if r["kind"] in ("buy", "sell")]
    buys = [r for r in trades if r["kind"] == "buy"]
    sells = [r for r in trades if r["kind"] == "sell"]
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))] if xs else None
    if buys:
        sz = [-r["sol"] for r in buys]
        P(f"buy size SOL: median={st.median(sz):.3f} p10={q(sz, .1):.3f} p90={q(sz, .9):.3f} max={max(sz):.3f}")
    cup = [r["cu_price"] for r in trades if r["cu_price"]]
    if cup:
        P(f"priority fee (µlamports/CU): median={st.median(cup):,.0f} p90={q(cup, .9):,.0f};  CU limit median={st.median([r['cu_limit'] for r in trades if r['cu_limit']] or [0]):,.0f}")
    fees = [r["fee"] for r in trades]
    tips = [r["tips"] for r in trades if r["tips"]]
    if fees:
        P(f"tx fee SOL: median={st.median(fees):.6f};  jito tips in {len(tips)}/{len(trades)} trades, median={st.median(tips) if tips else 0:.5f}")
    extra = collections.Counter(dst for r in trades for dst, _ in r["other_outs"])
    if extra:
        P("extra SOL transfers in trades (terminal/node fees):", [(KNOWN.get(k, k), n) for k, n in extra.most_common(6)])
    evb = [r["ev"] for r in buys if r["ev"]]
    if evb:
        evb = [e for e in evb if e["quote_is_sol"]]
        mc = [e["mcap_sol"] for e in evb] or [0]
        rs = [e["real_sol"] for e in evb] or [0]
        P(f"pump.fun entry: mcap SOL median={st.median(mc):.1f} p10={q(mc, .1):.1f} p90={q(mc, .9):.1f};  real_sol in the curve median={st.median(rs):.2f} (≈{st.median(rs) / 85 * 100:.0f}% until graduation)")

    # per token
    by = collections.defaultdict(list)
    for r in trades + [r for r in rows if r["kind"] in ("token_in", "token_out")]:
        by[r["mint"]].append(r)
    per = []
    for m, rs in by.items():
        b = [r for r in rs if r["kind"] == "buy"]
        s = [r for r in rs if r["kind"] == "sell"]
        spent = -sum(r["sol"] for r in b)
        got = sum(r["sol"] for r in s)
        tok_net = sum(r["tokens"] for r in rs)
        per.append(dict(mint=m, buys=len(b), sells=len(s), spent=spent, got=got, pnl=got - spent,
                        closed=bool(b and s and tok_net <= max(1e-6, 0.01 * sum(r["tokens"] for r in b))),
                        hold_s=(s[-1]["ts"] - b[0]["ts"]) if b and s else None,
                        first=rs[0]["ts"]))
    closed = [p for p in per if p["closed"] and p["spent"] > 0]
    P(f"tokens: {len(per)}, closed positions: {len(closed)}")
    if closed:
        wins = [p for p in closed if p["pnl"] > 0]
        holds = [p["hold_s"] for p in closed if p["hold_s"] is not None]
        rois = [p["pnl"] / p["spent"] for p in closed]
        P(f"win rate: {len(wins) / len(closed) * 100:.0f}%   PnL of closed: {sum(p['pnl'] for p in closed):+.3f} SOL   ROI median={st.median(rois) * 100:+.1f}% avg={st.mean(rois) * 100:+.1f}%")
        P(f"holding sec: median={st.median(holds):.0f} p10={q(holds, .1):.0f} p90={q(holds, .9):.0f}")
        P(f"buys per token median={st.median([p['buys'] for p in closed])}, sells per token median={st.median([p['sells'] for p in closed])}")
    hours = collections.Counter(__import__("datetime").datetime.fromtimestamp(r["ts"], __import__("datetime").UTC).hour for r in trades)
    if hours:
        P("activity by UTC hour:", " ".join(f"{h}:{hours.get(h, 0)}" for h in range(24)))
    tr = [r for r in rows if r["kind"].startswith("transfer")]
    cp = collections.Counter()
    for r in tr:
        for dst, a in r["other_outs"]:
            cp[dst] += 1
    if tr:
        P(f"transfers: out={kinds.get('transfer_out', 0)} in={kinds.get('transfer_in', 0)}; top recipients:", cp.most_common(5))
    return dict(wallet=wallet, rows=rows, per_token=per)


if __name__ == "__main__":
    w = sys.argv[1]
    rows, fails = analyze(w)
    res = summarize(w, rows, fails)
    if "--json" in sys.argv:
        json.dump(res, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1, default=str)
