// Token-safety gate for the graduation sniper.
//
// Why: WELDERS (FMosXPu8…pump) was a Token-2022 mint in Mayhem Mode. Transfer fee / transfer hook
// / permanent delegate / non-transferable extensions can make a token unsellable or silently tax
// every exit, and Mayhem pools break the curve invariant the sell math relies on. The bot must not
// buy what it cannot trust.
//
// Pure functions: the caller passes the mint account it already fetched. No RPC here.
import { ExtensionType, MINT_SIZE, getExtensionTypes } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM } from "./constants.mjs";
import { BUY_SKIP_REASON } from "./buy-skip-reasons.mjs";

// Extensions that make a position unsafe to hold (index values from @solana/spl-token 0.4.15).
export const UNSAFE_EXTENSIONS = new Map([
  [ExtensionType.TransferFeeConfig, "transfer fee"],
  [ExtensionType.TransferHook, "transfer hook"],
  [ExtensionType.PermanentDelegate, "permanent delegate"],
  [ExtensionType.NonTransferable, "non-transferable"],
]);

const UNVERIFIED = { ok: false, reason: BUY_SKIP_REASON.unverifiedExtensions, extensions: [] };

// TLV bounds check before the SDK parser: getExtensionTypes() trusts the length field, so a
// truncated/garbage TLV could be read as a complete extension list. Anything malformed is
// "unverified" — never silently safe, never guessed.
function tlvIsWellFormed(buf) {
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) return false;
    const len = buf.readUInt16LE(off + 2);
    if (off + 4 + len > buf.length) return false;
    off += 4 + len;
  }
  return true;
}

/**
 * @param {PublicKey|string|null} ownerProgram owner of the mint account
 * @param {Buffer|Uint8Array|null} data mint account data
 * @returns {{ok: boolean, reason: string|null, extensions: number[]}}
 */
export function checkMintExtensions({ ownerProgram, data }) {
  if (!ownerProgram) return UNVERIFIED; // owner unknown -> cannot judge -> refuse
  const owner = typeof ownerProgram === "string" ? ownerProgram : ownerProgram.toBase58();
  // Classic SPL mints cannot carry Token-2022 extensions at all.
  if (owner !== TOKEN_2022_PROGRAM.toBase58()) return { ok: true, reason: null, extensions: [] };
  if (!data) return UNVERIFIED;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < MINT_SIZE) return UNVERIFIED;
  if (buf.length === MINT_SIZE) return { ok: true, reason: null, extensions: [] }; // Token-2022, no TLV
  const tlv = buf.subarray(MINT_SIZE);
  if (!tlvIsWellFormed(tlv)) return UNVERIFIED;
  let types;
  try {
    types = getExtensionTypes(tlv);
  } catch {
    return UNVERIFIED;
  }
  const unsafe = types.filter((t) => UNSAFE_EXTENSIONS.has(t));
  if (unsafe.length > 0) {
    const names = unsafe.map((t) => UNSAFE_EXTENSIONS.get(t));
    return { ok: false, reason: `${BUY_SKIP_REASON.token2022Unsafe}: ${names.join(", ")}`, extensions: types };
  }
  return { ok: true, reason: null, extensions: types };
}

// Mayhem Mode: a third-party program that CPIs into pump.fun and breaks the trade-event reserves
// (data/research/diag390.json: 100% of invariant violations). Either side marks the pool unsafe.
export function mayhemReason({ curveMayhem, poolMayhem } = {}) {
  return curveMayhem === true || poolMayhem === true ? BUY_SKIP_REASON.mayhemMode : null;
}
