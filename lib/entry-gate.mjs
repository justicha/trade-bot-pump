// Entry gate for the bots that buy off the trade stream (graduation): a pure predicate so the
// duplicate-entry guard can be unit-tested (H3). A mint is entered only when it is not already held,
// not already being opened, there is a free slot, and it was not already attempted this session.
export function canEnterMint({ positions, opening, attempted, mint, maxPositions }) {
  if (positions.has(mint)) return { ok: false, reason: "position" };
  if (opening.has(mint)) return { ok: false, reason: "in-flight" };
  if (positions.size + opening.size >= maxPositions) return { ok: false, reason: "full" };
  if (attempted.has(mint)) return { ok: false, reason: "attempted" };
  return { ok: true, reason: null };
}
