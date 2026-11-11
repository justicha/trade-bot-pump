// Actual execution of a confirmed transaction, read from chain meta.
//
// Why: the bot used to PnL off the pre-trade quote (vSol/vTok at the event). The curve moves
// while the tx lands, fees are taken, and a Mayhem route does not follow the simple formula —
// so the only honest entry price is "tokens that arrived" / "SOL that left the wallet".
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection } from "./rpc.mjs";
import { TOKEN_2022_PROGRAM, WSOL } from "./constants.mjs";

// Rent-exempt minimum of an SPL token account: 2_039_280 lamports (0.00203928 SOL). Closing a WSOL
// ATA returns it to the wallet, and that inflow is NOT sale proceeds — counting it inflated every
// AMM sell by ~0.00204 SOL (AUDIT_SELL.md §5).
// TODO(verify) V5: confirm on a real AMM sell tx that the closed account was created in an EARLIER
// transaction (a create+close inside one tx cancels out by itself) and that this rent is unchanged.
const ATA_RENT_LAMPORTS = 2_039_280;
const WSOL_STR = WSOL.toBase58();

// ATA rent that came back with THIS transaction: the owner's WSOL account existed before the tx
// (rent paid earlier) and does not exist after it (closed). Returns lamports, 0 when no rent moved.
export function wsolRentReturnedLamports(meta, ownerStr) {
  const has = (list) => (list || []).some((b) => b.owner === ownerStr && b.mint === WSOL_STR);
  if (!has(meta?.preTokenBalances)) return 0; // created in this same tx: rent paid and returned cancel
  if (has(meta?.postTokenBalances)) return 0; // still open: nothing returned
  return ATA_RENT_LAMPORTS;
}

// Rent paid in THIS transaction to create the owner's token ATA (pump mints are Token-2022).
//
// Why: a first buy of a mint creates the ATA, and its rent-exempt deposit (~0.00207 SOL) left the
// wallet together with the buy. It is NOT the price of the tokens — the deposit sits in the ATA and
// comes back when the account is closed — yet it used to be part of solSpentSol, i.e. of the entry
// price (4-10% of a 0.02-0.05 SOL buy).
//
// Measured, never assumed: the ATA address is derived, looked up in the transaction's account list
// (static keys, then the ALT-loaded writable/readonly keys — the order pre/postBalances use), and
// the rent is the account's own lamport balance when it went 0 -> >0 in this transaction.
//   known:false — the ATA is not among the transaction's accounts (or cannot be derived): rent 0,
//                 the caller must treat the entry as "rent not separated".
export function ataRentPaid(tx, ownerStr, mintStr) {
  try {
    // allowOwnerOffCurve = true only relaxes the owner check; the derived address is the same and
    // an accounting helper must never throw on a PDA owner.
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mintStr),
      new PublicKey(ownerStr),
      true,
      TOKEN_2022_PROGRAM,
    ).toBase58();
    const msg = tx.transaction.message;
    const str = (k) => (k?.toBase58 ? k.toBase58() : String(k));
    const loaded = tx.meta?.loadedAddresses;
    const keys = [
      ...(msg.staticAccountKeys || msg.accountKeys || []),
      ...(loaded?.writable || []),
      ...(loaded?.readonly || []),
    ].map(str);
    const i = keys.indexOf(ata);
    if (i < 0) return { lamports: 0, known: false };
    const pre = tx.meta.preBalances?.[i];
    const post = tx.meta.postBalances?.[i];
    if (!Number.isFinite(pre) || !Number.isFinite(post)) return { lamports: 0, known: false };
    return { lamports: pre === 0 && post > 0 ? post : 0, known: true };
  } catch {
    return { lamports: 0, known: false };
  }
}

export async function readExecution(sig, owner, mint, { retries = 4, delayMs = 400 } = {}) {
  const ownerStr = owner.toBase58 ? owner.toBase58() : String(owner);
  const mintStr = mint.toBase58 ? mint.toBase58() : String(mint);
  for (let i = 0; i < retries; i++) {
    let tx = null;
    try {
      tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    } catch { tx = null; }
    if (tx?.meta) {
      const msg = tx.transaction.message;
      const keys = (msg.staticAccountKeys || msg.accountKeys || []).map((k) => k.toBase58());
      const idx = keys.indexOf(ownerStr);
      const solDelta = idx >= 0 ? tx.meta.postBalances[idx] - tx.meta.preBalances[idx] : 0;
      const fee = tx.meta.fee ?? 0;
      let before = 0n;
      let after = 0n;
      for (const b of tx.meta.preTokenBalances || []) {
        if (b.owner === ownerStr && b.mint === mintStr) before = BigInt(b.uiTokenAmount.amount);
      }
      for (const b of tx.meta.postTokenBalances || []) {
        if (b.owner === ownerStr && b.mint === mintStr) after = BigInt(b.uiTokenAmount.amount);
      }
      const tokensDelta = after - before;
      // ATA rent paid by this tx (0 when the ATA already existed). Not part of the entry price.
      const ataRent = ataRentPaid(tx, ownerStr, mintStr);
      // The wallet also paid `fee` and, on a first buy, the ATA rent; the trade's own SOL flow is
      // the delta minus both (entry price WITHOUT network fee and WITHOUT rent).
      const spentLamports = solDelta < 0 ? -solDelta - fee - ataRent.lamports : 0;
      // A closed WSOL ATA hands back its rent; that is not a sale proceed (TODO(verify) V5).
      const rentLamports = wsolRentReturnedLamports(tx.meta, ownerStr);
      const receivedLamports = Math.max(0, solDelta - rentLamports);
      return {
        found: true,
        feeSol: fee / 1e9,
        solDeltaSol: solDelta / 1e9,
        solSpentSol: Math.max(0, spentLamports) / 1e9,
        solReceivedSol: receivedLamports / 1e9,
        rentReturnedSol: rentLamports / 1e9,
        // Token-ATA rent paid in this tx (already excluded from solSpentSol). ataRentKnown:false
        // means the ATA was not found among the tx accounts, so the rent could not be separated.
        ataRentPaidSol: ataRent.lamports / 1e9,
        ataRentKnown: ataRent.known,
        tokensDelta,
        tokensReceived: tokensDelta > 0n ? tokensDelta : 0n,
        tokensSold: tokensDelta < 0n ? -tokensDelta : 0n,
        err: tx.meta.err ?? null,
      };
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { found: false };
}

// Simulate before sending. A failed simulation means the tx would fail on-chain (and still pay
// the fee); the caller records the reason and does NOT send.
export async function simulateTx(tx) {
  try {
    const sim = await connection.simulateTransaction(tx);
    return {
      ok: !sim.value.err,
      err: sim.value.err ?? null,
      logs: sim.value.logs ?? [],
      units: sim.value.unitsConsumed ?? null,
    };
  } catch (e) {
    return { ok: false, err: { rpc: e.message }, logs: [], units: null };
  }
}

// What an immediate buy->sell round trip would return, from the curve math alone (no RPC).
// ratio < 1 by construction (fees + impact); EXIT_MIN_RATIO rejects entries whose own exit is
// already a losing trade.
export function previewExit(state, buySol, { buyFeeBps = 100, sellFeeBps = 100 } = {}) {
  const buyLamports = BigInt(Math.floor(Number(buySol) * 1e9));
  if (buyLamports <= 0n) return { ok: false, reason: "zero buy" };
  const netSol = buyLamports - (buyLamports * BigInt(buyFeeBps)) / 10000n;
  const tokensOut = (state.virtualTokenReserves * netSol) / (state.virtualSolReserves + netSol);
  if (tokensOut <= 0n) return { ok: false, reason: "buy yields no tokens" };
  const post = {
    virtualSolReserves: state.virtualSolReserves + netSol,
    virtualTokenReserves: state.virtualTokenReserves - tokensOut,
    realSolReserves: state.realSolReserves + netSol,
    realTokenReserves: state.realTokenReserves - tokensOut,
  };
  const gross = (post.virtualSolReserves * tokensOut) / (post.virtualTokenReserves + tokensOut);
  const solOut = gross - (gross * BigInt(sellFeeBps)) / 10000n;
  const ratio = Number(solOut) / Number(buyLamports);
  return {
    ok: true,
    tokensOut,
    solOut,
    ratio,
    // A sell pays out of the REAL reserves; below this the program overflows (Custom 6024).
    payable: BigInt(post.realSolReserves) >= solOut,
  };
}
