import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { ROOT } from "./config.mjs";

// KEYS_DIR is overridable so tests can supply a throwaway keypair in a temp dir instead of a
// keys/default.json committed to the repo.
const KEYS_DIR = process.env.KEYS_DIR ? path.resolve(process.env.KEYS_DIR) : path.join(ROOT, "keys");

export function loadKeypair(name = "default") {
  const file = path.join(KEYS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Keypair not found: ${file}\nGenerate with: node lib/wallet.mjs generate [name]`);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function generateKeypair(name = "default") {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const kp = Keypair.generate();
  const file = path.join(KEYS_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  fs.chmodSync(file, 0o600);
  console.log(`Keypair saved: ${file}`);
  console.log(`Public key: ${kp.publicKey.toBase58()}`);
  return kp;
}

if (process.argv[1] && process.argv[1].includes("wallet.mjs")) {
  const cmd = process.argv[2];
  const name = process.argv[3] || "default";
  if (cmd === "generate") {
    generateKeypair(name);
  } else if (cmd === "show") {
    const kp = loadKeypair(name);
    console.log(`Public key: ${kp.publicKey.toBase58()}`);
  } else {
    console.log("Usage: node lib/wallet.mjs generate [name] | show [name]");
  }
}
