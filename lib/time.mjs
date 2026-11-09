// Moscow time for everything a human reads: log lines, journal file names, report windows.
//
// The machine's own timezone is not trusted: an explicit IANA zone is used, so a laptop on UTC, a
// VPS on UTC and a box in Moscow all write the same, comparable stamps. Machine-readable fields
// (journal `ts`, raw `iso`) stay ISO-8601 UTC so parsers never have to guess a zone; the human
// fields (`tsMsk`, file names) are Moscow.
export const MSK_TZ = "Europe/Moscow";
export const MSK_OFFSET = "+03:00";

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: MSK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function parts(date = new Date()) {
  const out = {};
  for (const p of PARTS.formatToParts(date)) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

// "2026-11-08 08:56:14 MSK"
export function fmtMsk(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} MSK`;
}

// "2026-11-08" (Moscow calendar day — the journal file name)
export function mskDateKey(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

// "2026-11-08-08" (Moscow hour — the raw capture file name)
export function mskHourKey(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}-${p.hour}`;
}

// ISO-8601 with the Moscow offset, for report fields that a human reads: "2026-11-08T08:56:14+03:00"
export function mskIso(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${MSK_OFFSET}`;
}

export const BRUSSELS_TZ = "Europe/Brussels";

function zoneParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== "literal") out[p.type] = p.value;
  return out;
}

// "2026-11-08T08:56:14+01:00" in an arbitrary IANA zone (offset derived from the parts themselves
// would need a second lookup, so the offset is resolved via the short form below).
export function isoInZone(date, tz) {
  const p = zoneParts(date, tz);
  // Resolve the zone's offset at this instant via a separate formatter with timeZoneName:"short".
  const raw = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(date)
    .find((x) => x.type === "timeZoneName")?.value || "";
  // Normalize "GMT+1" -> "+01:00", "GMT-5" -> "-05:00" (ICU renders it as GMT±n here).
  let off = raw;
  const gm = /^GMT([+-])(\d+)$/.exec(raw);
  if (gm) off = `${gm[1]}${gm[2].padStart(2, "0")}:00`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}

// "2026-11-08T08:56:14+01:00" in Brussels.
export function brusselsIso(date = new Date()) {
  return isoInZone(date, BRUSSELS_TZ);
}

// Local hour (0-23) and weekday short name ("Sat") in a given zone.
export function hourInZone(date, tz) {
  return Number(zoneParts(date, tz).hour);
}
export function weekdayInZone(date, tz) {
  return zoneParts(date, tz).weekday;
}
