// Downloads on-chain program ELFs (upgradeable loader) and saves metadata:
// upgrade authority, last deploy slot, size. node research/programs.mjs <programId...>
// Output: data/programs/<id>.so, data/programs/<id>.json
import fs from "node:fs";
import path from "node:path";
import { BUDGET, ROOT, ledger, rpc, saveLedger } from "./rpc.mjs";

const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (buf) => {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b) break; s = "1" + s; }
  return s;
};
const out = path.join(ROOT, "data", "programs");
fs.mkdirSync(out, { recursive: true });

for (const id of process.argv.slice(2)) {
  try {
    const acc = await rpc("getAccountInfo", [id, { encoding: "base64" }]);
    const v = acc.value;
    if (!v) { console.log(id, "not found"); continue; }
    const d = Buffer.from(v.data[0], "base64");
    const meta = { id, owner: v.owner, executable: v.executable };
    let elf;
    if (v.owner === "BPFLoaderUpgradeab1e11111111111111111111111") {
      const pd = b58(d.subarray(4, 36));
      const p = (await rpc("getAccountInfo", [pd, { encoding: "base64" }])).value;
      const b = Buffer.from(p.data[0], "base64");
      meta.programData = pd;
      meta.lastDeploySlot = Number(b.readBigUInt64LE(4));
      meta.upgradeAuthority = b[12] ? b58(b.subarray(13, 45)) : null;
      elf = b.subarray(45);
    } else {
      elf = d; // loader v2/v4 — ELF right in the account
    }
    // trim trailing zeros (space reserved for upgrades)
    let end = elf.length;
    while (end > 0 && elf[end - 1] === 0) end--;
    elf = elf.subarray(0, end);
    meta.elfBytes = elf.length;
    fs.writeFileSync(path.join(out, `${id}.so`), elf);
    fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify(meta, null, 1));
    console.log(id.slice(0, 8), meta.owner.slice(0, 12), "elf", elf.length, "auth", meta.upgradeAuthority?.slice(0, 8), "slot", meta.lastDeploySlot);
  } catch (e) { console.log(id, "error", e.message); }
}
saveLedger();
console.log(`credits ${ledger.used}/${BUDGET}`);
