"""A wallet's role in its transactions: signer / writable / SOL change / which programs.
python3 research/roles.py <wallet>"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from solparse import KNOWN  # noqa: E402

w = sys.argv[1]
d = os.path.join(os.path.dirname(__file__), "..", "data", "raw", w)
c = collections.Counter()
progs = collections.Counter()
payers = collections.Counter()
recv = []
for f in os.listdir(d):
    t = json.load(open(os.path.join(d, f)))
    if not t:
        continue
    ok = t["meta"]["err"] is None
    keys = t["transaction"]["message"]["accountKeys"]
    pk = [k["pubkey"] for k in keys]
    if w not in pk:
        c["wallet_via_ALT_or_inner"] += 1
        continue
    k = keys[pk.index(w)]
    i = pk.index(w)
    delta = t["meta"]["postBalances"][i] - t["meta"]["preBalances"][i]
    c[f"{'ok' if ok else 'fail'} signer={k['signer']} writable={k['writable']} solΔ={'+' if delta > 0 else '-' if delta < 0 else '0'}"] += 1
    if ok:
        payers[pk[0]] += 1
        for ix in t["transaction"]["message"]["instructions"]:
            progs[KNOWN.get(ix["programId"], ix["programId"])] += 1
        if delta:
            recv.append(delta / 1e9)
print("roles:", *c.most_common(), sep="\n  ")
print("top-level programs (ok):", progs.most_common(8))
print("distinct fee payers (ok):", len(payers), payers.most_common(5))
if recv:
    print(f"SOL deltas: n={len(recv)} sum={sum(recv):+.4f} min={min(recv):+.6f} max={max(recv):+.6f}")
