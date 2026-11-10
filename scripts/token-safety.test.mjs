// Unit: the token-safety gate (task 2) — Token-2022 extensions and Mayhem Mode must block a buy.
//
// The extension list is parsed by @solana/spl-token itself (ExtensionType / getExtensionTypes), the
// same library the transaction builder uses, so the type numbers cannot drift.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionType, MINT_SIZE } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { UNSAFE_EXTENSIONS, checkMintExtensions, mayhemReason } from "../lib/token-safety.mjs";
import { BUY_SKIP_REASON } from "../lib/buy-skip-reasons.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SPL = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// A mint account: 82-byte base + a TLV list of the given extension types (8-byte payload each).
function mintWith(types) {
  const payload = 8;
  const tlv = Buffer.alloc(types.length * (4 + payload));
  types.forEach((t, i) => {
    const off = i * (4 + payload);
    tlv.writeUInt16LE(t, off);
    tlv.writeUInt16LE(payload, off + 2);
  });
  return Buffer.concat([Buffer.alloc(MINT_SIZE), tlv]);
}

// --- extension table ---
asrt(UNSAFE_EXTENSIONS.get(ExtensionType.TransferFeeConfig) === "transfer fee", "transfer fee is unsafe");
asrt(UNSAFE_EXTENSIONS.get(ExtensionType.TransferHook) === "transfer hook", "transfer hook is unsafe");
asrt(UNSAFE_EXTENSIONS.get(ExtensionType.PermanentDelegate) === "permanent delegate", "permanent delegate is unsafe");
asrt(UNSAFE_EXTENSIONS.get(ExtensionType.NonTransferable) === "non-transferable", "non-transferable is unsafe");

// --- classic SPL: always fine ---
asrt(checkMintExtensions({ ownerProgram: SPL, data: mintWith([]) }).ok, "classic SPL mint passes (no extensions possible)");

// --- Token-2022 without extensions: fine ---
asrt(checkMintExtensions({ ownerProgram: T22, data: Buffer.alloc(MINT_SIZE) }).ok, "token-2022 without TLV passes");

// --- each unsafe extension is refused, with a readable reason ---
for (const [type, name] of UNSAFE_EXTENSIONS) {
  const res = checkMintExtensions({ ownerProgram: T22, data: mintWith([type]) });
  asrt(res.ok === false, `token-2022 with ${name} is refused`);
  asrt(res.reason === `${BUY_SKIP_REASON.token2022Unsafe}: ${name}`, `reason names the extension, got "${res.reason}"`);
}
// --- several at once: all listed ---
{
  const res = checkMintExtensions({
    ownerProgram: T22,
    data: mintWith([ExtensionType.TransferFeeConfig, ExtensionType.TransferHook]),
  });
  asrt(!res.ok && /transfer fee, transfer hook/.test(res.reason), `both extensions listed, got "${res.reason}"`);
}
// --- a safe extension is not a block ---
{
  const res = checkMintExtensions({ ownerProgram: T22, data: mintWith([ExtensionType.MetadataPointer]) });
  asrt(res.ok === true, "a metadata-pointer-only mint passes");
  asrt(res.extensions.includes(ExtensionType.MetadataPointer), "the parsed extension list is reported");
}

// --- unknown / broken input is never assumed safe ---
asrt(checkMintExtensions({ ownerProgram: null, data: null }).reason === BUY_SKIP_REASON.unverifiedExtensions, "unknown owner -> unverified");
asrt(checkMintExtensions({ ownerProgram: T22, data: null }).reason === BUY_SKIP_REASON.unverifiedExtensions, "no data -> unverified");
asrt(checkMintExtensions({ ownerProgram: T22, data: Buffer.alloc(10) }).reason === BUY_SKIP_REASON.unverifiedExtensions, "short account -> unverified");
{
  const malformed = Buffer.concat([Buffer.alloc(MINT_SIZE), Buffer.from([1, 0, 0xff, 0x7f])]); // length overruns the buffer
  const res = checkMintExtensions({ ownerProgram: T22, data: malformed });
  asrt(res.ok === false && res.reason === BUY_SKIP_REASON.unverifiedExtensions, `malformed TLV -> unverified, got "${res.reason}"`);
}

// --- Mayhem Mode, from the curve or from the pool ---
asrt(mayhemReason({ curveMayhem: true }) === BUY_SKIP_REASON.mayhemMode, "curve mayhem blocks");
asrt(mayhemReason({ poolMayhem: true }) === BUY_SKIP_REASON.mayhemMode, "pool mayhem blocks");
asrt(mayhemReason({ curveMayhem: false, poolMayhem: false }) === null, "no mayhem -> no reason");
asrt(BUY_SKIP_REASON.mayhemMode === "mayhem mode", "the reason string is 'mayhem mode'");

// --- the bot wires both checks inside buyToken, before any send ---
{
  const src = fs.readFileSync(path.join(here, "..", "bots", "graduation-sniper", "graduation.mjs"), "utf8");
  const fn = src.indexOf("async function buyToken");
  const mayhem = src.indexOf("mayhemReason(", fn);
  const ext = src.indexOf("checkMintExtensions(", fn);
  const send = src.indexOf("sendTxWithRetry(", fn);
  asrt(fn > 0 && mayhem > fn && ext > fn, "buyToken calls mayhemReason and checkMintExtensions");
  asrt(send === -1 || (mayhem < send && ext < send), "both run before the first sendTxWithRetry");
}

console.log(JSON.stringify({ unsafe: [...UNSAFE_EXTENSIONS.values()], mintSize: MINT_SIZE }));
console.log("PASS: token safety — Token-2022 extensions and Mayhem Mode block the buy, unreadable mints are refused");
