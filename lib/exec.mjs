// Actual execution of a confirmed transaction, read from chain meta.
//
// Why: the bot used to PnL off the pre-trade quote (vSol/vTok at the event). The curve moves
// while the tx lands, fees are taken, and a Mayhem route does not follow the simple formula —
// so the only honest entry price is "tokens that arrived" / "SOL that left the wallet".
import { connection } from "./rpc.mjs";

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
      // The wallet also paid `fee`; the trade's own SOL flow is the delta minus that fee.
      const spentLamports = solDelta < 0 ? -solDelta - fee : 0;
      return {
        found: true,
        feeSol: fee / 1e9,
        solDeltaSol: solDelta / 1e9,
        solSpentSol: Math.max(0, spentLamports) / 1e9,
        solReceivedSol: solDelta > 0 ? solDelta / 1e9 : 0,
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
