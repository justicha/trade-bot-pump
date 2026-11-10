import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { ROOT } from "./config.mjs";

// KEYS_DIR is overridable so tests can supply a throwaway keypair in a temp dir instead of a
// keys/default.json committed to the repo.
const KEYS_DIR = process.env.KEYS_DIR ? path.resolve(process.env.KEYS_DIR) : path.join(ROOT, "keys");

// Keypair names are file names inside KEYS_DIR: allow only a safe alphabet so a CLI argument can
// never escape the directory ("../evil", "a/b", "..\\x") or overwrite an arbitrary file.
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function loadKeypair(name = "default") {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid keypair name "${name}" — allowed: letters, digits, _ and -`);
  }
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Keypair not found: ${file}\nGenerate with: node lib/wallet.mjs generate [name]`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function generateKeypair(name = "default", { force = false } = {}) {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid keypair name "${name}" — allowed: letters, digits, _ and -`);
  }
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const file = path.join(KEYS_DIR, `${name}.json`);
  // Never silently overwrite an existing (possibly funded) wallet.
  if (fs.existsSync(file) && !force) {
    throw new Error(`Keypair already exists: ${file}\nRefusing to overwrite. Run: node lib/wallet.mjs generate ${name} --force`);
  }
  const kp = Keypair.generate();
  // Atomic write: temp file in the same directory, then rename — no half-written key files.
  const tmp = path.join(KEYS_DIR, `.${name}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(Array.from(kp.secretKey)));
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* no chmod semantics on this platform */ }
  console.log(`Keypair saved: ${file}`);
  console.log(`Public key: ${kp.publicKey.toBase58()}`);
  return kp;
}

if (process.argv[1] && process.argv[1].includes("wallet.mjs")) {
  const cmd = process.argv[2];
  const name = process.argv[3] || "default";
  const force = process.argv.includes("--force");
  if (cmd === "generate") {
    try {
      generateKeypair(name, { force });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else if (cmd === "show") {
    try {
      const kp = loadKeypair(name);
      console.log(`Public key: ${kp.publicKey.toBase58()}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    console.log("Usage: node lib/wallet.mjs generate [name] [--force] | show [name]");
  }
}
