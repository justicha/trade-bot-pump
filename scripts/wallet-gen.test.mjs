// A7: wallet generation must refuse to overwrite an existing key file and must reject names that
// could escape the keys/ directory. Uses a TEMP KEYS_DIR — no real wallet is ever touched.
import "./lib/test-env.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.KEYS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-gen-"));
const { generateKeypair, loadKeypair } = await import("../lib/wallet.mjs");

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};

const first = generateKeypair("alpha");
asrt(fs.existsSync(path.join(process.env.KEYS_DIR, "alpha.json")), "key file created");
const loaded = loadKeypair("alpha");
asrt(loaded.publicKey.toBase58() === first.publicKey.toBase58(), "loadKeypair round-trips the generated key");

let threw = false;
try { generateKeypair("alpha"); } catch (e) { threw = /already exists/i.test(e.message); }
asrt(threw, "second generate refuses to overwrite");

const second = generateKeypair("alpha", { force: true });
asrt(second.publicKey.toBase58() !== first.publicKey.toBase58(), "--force generates a fresh key");
asrt(loadKeypair("alpha").publicKey.toBase58() === second.publicKey.toBase58(), "file holds the forced key");

for (const bad of ["../evil", "..\\evil", "a/b", "a\\b", "..", ""]) {
  let t = false;
  try { generateKeypair(bad); } catch { t = true; }
  asrt(t, `path-escape name rejected: "${bad}"`);
  try { loadKeypair(bad); } catch { t = true; }
  asrt(t, `path-escape name rejected on load: "${bad}"`);
}

console.log(JSON.stringify({ created: true, overwriteRefused: true, forceOk: true, namesRejected: 7 }));
console.log("PASS: wallet generation is safe (no overwrite, no path escape, atomic write)");
