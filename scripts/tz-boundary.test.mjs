// C1: everything a human reads is Moscow time (lib/time.mjs). The journal file name (mskDateKey)
// and buyHour/buyWeekday must match that zone — near midnight a UTC date would name a different
// file than the one actually written.
import "./lib/test-env.mjs";
import assert from "node:assert/strict";
import { mskDateKey, mskHourKey, hourInZone, weekdayInZone, MSK_TZ } from "../lib/time.mjs";

// 2026-11-09T23:30Z == 2026-11-10 02:30 MSK: UTC-derived names say 11-09, the journal writes 11-10.
const lateNight = new Date("2026-11-09T23:30:00Z");
assert.equal(mskDateKey(lateNight), "2026-11-10", "MSK day rolls over before UTC midnight");
assert.equal(mskHourKey(lateNight), "2026-11-10-02", "MSK hour key");
assert.equal(lateNight.toISOString().slice(0, 10), "2026-11-09", "the UTC name (the bug this fixes) differs");
assert.equal(hourInZone(lateNight, MSK_TZ), 2, "MSK hour at 23:30Z is 02");
assert.equal(weekdayInZone(lateNight, MSK_TZ), "Tue", "MSK weekday");

// 2026-11-09T20:59Z == 23:59 MSK: still the same MSK day.
assert.equal(mskDateKey(new Date("2026-11-09T20:59:00Z")), "2026-11-09", "last minute of the MSK day");
assert.equal(mskDateKey(new Date("2026-11-09T21:00:00Z")), "2026-11-10", "first minute of the next MSK day");

console.log(JSON.stringify({ rollover: "ok" }));
console.log("PASS: MSK day/hour/weekday keys are zone-correct across midnight");
