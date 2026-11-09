// Status-line maths for long lab runs.
//
// Units are explicit and tested: trades per MINUTE and per HOUR, ETA in HOURS. The synthetic
// reference case is 12 closed trades in 10 minutes with a target of 1000:
//   12 / 10min = 1.2 trades/min = 72 trades/hour, ETA = (1000 - 12) / 72 = 13.7h
export function statusOf({ closed, startedAt, now = Date.now(), target = 1000 } = {}) {
  const elapsedMs = Math.max(0, now - startedAt);
  const minutes = elapsedMs / 60000;
  const hours = minutes / 60;

  const rows = [...closed.entries()].map(([variant, n]) => {
    const perMin = minutes > 0 ? n / minutes : 0;
    const perHour = perMin * 60;
    const remaining = Math.max(0, target - n);
    const etaHours = perHour > 0 ? remaining / perHour : remaining > 0 ? Infinity : 0;
    return { variant, n, perMin, perHour, remaining, etaHours };
  });

  return { minutes, hours, target, rows };
}

const fmtRate = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
const fmtEta = (h) => (Number.isFinite(h) ? `${h.toFixed(1)}h` : "n/a");

export function formatStatus({ closed, startedAt, now = Date.now(), target = 1000 } = {}) {
  const st = statusOf({ closed, startedAt, now, target });
  const parts = st.rows.map(
    (r) => `${r.variant}:${r.n} ${fmtRate(r.perMin)}/min (${fmtRate(r.perHour)}/h, eta ${fmtEta(r.etaHours)})`,
  );
  return `STATUS ${st.minutes.toFixed(1)}min | target ${target} | ${parts.join("  ")}`;
}
