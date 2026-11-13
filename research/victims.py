"""A token's life from launch to the creator's exit: who made money, who lost.
python3 research/victims.py data/windows.json

Accounting by real balance changes (not by events): for each successful tx we take the fee payer,
their ΔSOL (+ΔWSOL) and Δtoken. This is correct even for BuyV2/SellV2 with non-SOL quotes.

Participant categories:
  dev     — the creator + wallets that received SOL from them in our sample (sub-wallets) + create-tx co-signers
  slot0   — third-party wallets that bought in the same slot as create (a bundle or an ultra-fast sniper)
  sniper  — bought in the first 10 slots (~4 s)
  late    — everyone else
"""
import collections
import json
import os
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(__file__))
from analyze import all_programs, analyze, events, sol_transfers_from  # noqa: E402
from solparse import JITO_TIPS, KNOWN, WSOL, compute_budget  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")
windows = json.load(open(sys.argv[1]))
creator_rows = {}
summary, launch = [], []


def sub_wallets(creator):
    if creator not in creator_rows:
        creator_rows[creator] = analyze(creator)[0]
    subs = set()
    for r in creator_rows[creator]:
        for dst, amt in r["other_outs"]:
            if amt >= 0.05:
                subs.add(dst)
    return subs


def deltas(t, owner, mint):
    keys = [k["pubkey"] for k in t["transaction"]["message"]["accountKeys"]]
    i = keys.index(owner)
    sol = (t["meta"]["postBalances"][i] - t["meta"]["preBalances"][i]) / 1e9
    tok = 0.0
    for side, sign in (("preTokenBalances", -1), ("postTokenBalances", 1)):
        for b in t["meta"].get(side) or []:
            if b.get("owner") == owner:
                v = float(b["uiTokenAmount"]["uiAmountString"] or 0)
                if b["mint"] == mint:
                    tok += sign * v
                elif b["mint"] == WSOL:
                    sol += sign * v
    return sol, tok


for w in windows:
    mint, creator = w["mint"], w["creator"]
    d = os.path.join(ROOT, "data", "raw", mint)
    txs = {f[:-5]: json.load(open(os.path.join(d, f))) for f in os.listdir(d)}
    c = txs.get(w["createSig"])
    if not c:
        continue
    slot0 = c["slot"]
    co_signers = {k["pubkey"] for k in c["transaction"]["message"]["accountKeys"] if k["signer"]}
    dev = {creator} | sub_wallets(creator) | (co_signers - {mint})
    sigs = json.load(open(os.path.join(ROOT, "data", "raw", f"{mint}.window.json")))
    per = collections.defaultdict(lambda: dict(sol=0.0, tok=0.0, first=None, n=0))
    last_price = None
    for sig, t in sorted(txs.items(), key=lambda kv: kv[1]["slot"] if kv[1] else 0):
        if not t or t["meta"]["err"]:
            continue
        payer = t["transaction"]["message"]["accountKeys"][0]["pubkey"]
        sol, tok = deltas(t, payer, mint)
        if abs(tok) < 1e-9:
            continue
        p = per[payer]
        p["sol"] += sol; p["tok"] += tok; p["n"] += 1
        off = t["slot"] - slot0
        if p["first"] is None:
            p["first"] = off
        ev = [e for e in events(t) if e["mint"] == mint and e["quote_is_sol"] and e["vtok"]]
        if ev:
            last_price = ev[-1]["vsol"] / ev[-1]["vtok"]  # curve price after the trade
        elif abs(sol) > 0.05 and abs(tok) > 0:
            last_price = abs(sol) / abs(tok)
        cb = compute_budget(t["transaction"]["message"]["instructions"])
        outs = sol_transfers_from(t, payer)
        launch.append(dict(mint=mint, creator=creator, user=payer, sig=sig, slot_off=off, sol=sol, tok=tok,
                           is_buy=tok > 0, cu_price=cb.get("cu_price"), cu_limit=cb.get("cu_limit"),
                           programs=sorted({KNOWN.get(x, x) for x in all_programs(t)}),
                           top=[KNOWN.get(ix["programId"], ix["programId"]) for ix in t["transaction"]["message"]["instructions"]],
                           tips=[(KNOWN.get(dst, dst), a) for dst, a in outs if a < 0.05],
                           in_dev=payer in dev))

    def cat(u, p):
        if u in dev:
            return "dev"
        if p["first"] == 0:
            return "slot0"
        return "sniper" if p["first"] <= 10 else "late"

    groups = collections.defaultdict(lambda: dict(n=0, sol=0.0, left=0.0, losers=0))
    for u, p in per.items():
        g = groups[cat(u, p)]
        left = max(p["tok"], 0) * (last_price or 0)
        g["n"] += 1; g["sol"] += p["sol"]; g["left"] += left
        if p["sol"] + left < 0:
            g["losers"] += 1
    fail = sum(1 for s in sigs if s["err"]) / max(len(sigs), 1)
    row = dict(mint=mint, creator=creator[:6], window_sigs=len(sigs), fail_share=fail,
               **{f"{k}_{m}": v[m] for k, v in groups.items() for m in ("n", "sol", "left", "losers")})
    summary.append(row)
    print(f"\n{mint[:10]} (creator {creator[:6]}): signatures in the window {len(sigs)}, failed {fail * 100:.0f}%")
    for k in ("dev", "slot0", "sniper", "late"):
        if k in groups:
            g = groups[k]
            print(f"  {k:6s}: {g['n']:3d} wallets, realized {g['sol']:+8.2f} SOL, remainder ~{g['left']:6.2f} SOL, at a loss {g['losers']}")

print("\n===== TOTAL =====")
tot = collections.defaultdict(lambda: [0, 0.0, 0.0, 0])
for r in summary:
    for k in ("dev", "slot0", "sniper", "late"):
        if f"{k}_n" in r:
            t = tot[k]; t[0] += r[f"{k}_n"]; t[1] += r[f"{k}_sol"]; t[2] += r[f"{k}_left"]; t[3] += r[f"{k}_losers"]
for k, (n, s, l, lo) in tot.items():
    print(f"{k:6s}: {n:4d} wallets; realized {s:+8.2f} SOL; remainder ~{l:6.2f}; total {s + l:+8.2f}; at a loss {lo} ({lo / max(n, 1) * 100:.0f}%)")
print(f"median share of failed signatures in the window: {st.median([r['fail_share'] for r in summary]) * 100:.0f}%")
json.dump(summary, open(os.path.join(ROOT, "data", "victims_summary.json"), "w"), indent=1)
json.dump(launch, open(os.path.join(ROOT, "data", "launch_trades.json"), "w"), indent=1)
