"""Человекочитаемый дамп одной транзакции: python3 research/inspect_tx.py <file.json> [wallet]"""
import json
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from solparse import KNOWN, b58decode, compute_budget  # noqa: E402

t = json.load(open(sys.argv[1]))
wallet = sys.argv[2] if len(sys.argv) > 2 else None
meta, msg = t["meta"], t["transaction"]["message"]
keys = [a["pubkey"] for a in msg["accountKeys"]]
name = lambda k: KNOWN.get(k, k)

print(f"sig={t['transaction']['signatures'][0]} slot={t['slot']} time={t['blockTime']} fee={meta['fee']} err={meta['err']} cu={meta.get('computeUnitsConsumed')}")
print("signers:", [a["pubkey"] for a in msg["accountKeys"] if a["signer"]])
print("compute budget:", compute_budget(msg["instructions"]))
if wallet and wallet in keys:
    i = keys.index(wallet)
    print(f"wallet SOL delta: {(meta['postBalances'][i] - meta['preBalances'][i]) / 1e9:+.6f}")

for n, ix in enumerate(msg["instructions"]):
    p = ix.get("parsed")
    if isinstance(p, dict):
        print(f"[{n}] {name(ix['programId'])} {p.get('type')} {json.dumps(p.get('info'))[:200]}")
    else:
        d = b58decode(ix.get("data", ""))
        accs = [name(a) for a in ix.get("accounts", [])]
        print(f"[{n}] {name(ix['programId'])} data={d[:16].hex()}..({len(d)}b) accs={len(accs)} {accs[:6]}")
    for g in meta.get("innerInstructions") or []:
        if g["index"] != n:
            continue
        for ii in g["instructions"]:
            p = ii.get("parsed")
            info = json.dumps(p.get("info"))[:160] if isinstance(p, dict) else b58decode(ii.get("data", ""))[:8].hex()
            print(f"     └ {name(ii['programId'])} {p.get('type') if isinstance(p, dict) else ''} {info}")

print("token deltas:")
pre = {(b["accountIndex"]): b for b in meta["preTokenBalances"]}
post = {(b["accountIndex"]): b for b in meta["postTokenBalances"]}
for idx in sorted(set(pre) | set(post)):
    b = post.get(idx) or pre.get(idx)
    a0 = float((pre.get(idx) or {}).get("uiTokenAmount", {}).get("uiAmountString") or 0)
    a1 = float((post.get(idx) or {}).get("uiTokenAmount", {}).get("uiAmountString") or 0)
    if a0 != a1:
        print(f"   {b['mint'][:10]}.. owner={name(b.get('owner', ''))[:14]} {a1 - a0:+,.4f}")
print("logs:")
for line in meta["logMessages"][:60]:
    print("  ", line[:170])
