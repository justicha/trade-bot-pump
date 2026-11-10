// Dedupe unit test: dedupeTrades must drop duplicate trades (same mint across processes and across
// sessions) and report how many were removed per gitSha.
import "./lib/test-env.mjs";
import { dedupeTrades } from "../lib/journal.mjs";

const asrt = (c, m) => {
  if (!c) {
    console.error("FAIL: " + m);
    process.exit(1);
  }
};
const t = (mint, sessionId, buyAt, git = "cda593e") => ({ type: "trade", mint, sessionId, buyAt, gitSha: git, pnlSol: -0.01, buySol: 0.02 });

// cross-process duplicate: same mint, different session, ~1s apart -> dropped (mint-level)
{
  const { records, removedByGit, duplicates } = dedupeTrades([
    t("MINT_A", "s1", "2026-11-08T22:59:31.907Z"),
    t("MINT_A", "s2", "2026-11-08T22:59:31.916Z"),
  ]);
  asrt(records.length === 1, `cross-process duplicate removed (kept ${records.length})`);
  asrt(removedByGit.get("cda593e") === 1, "removed count reported per gitSha");
  asrt(duplicates.length === 1 && duplicates[0].mint === "MINT_A", "glued pair logged");
  asrt(duplicates[0].keptSessionId === "s1" && duplicates[0].dupSessionId === "s2", "both sessionIds logged");
  asrt(duplicates[0].gapMs === 9, `time gap logged (got ${duplicates[0].gapMs}ms)`);
}

// cross-process duplicate with a gap > 3s (mint-level catches it regardless of time)
{
  const { records } = dedupeTrades([
    t("MINT_B", "s1", "2026-11-08T23:09:29.748Z"),
    t("MINT_B", "s2", "2026-11-08T23:09:48.409Z"),
  ]);
  asrt(records.length === 1, `same-mint cross-session duplicate >3s removed (kept ${records.length})`);
}

// legacy rows (no sessionId): dedup by mint + buyAt 3s bucket
{
  const { records } = dedupeTrades([
    t("MINT_C", null, "2026-11-08T10:00:00.000Z", null),
    t("MINT_C", null, "2026-11-08T10:00:01.000Z", null),
    t("MINT_D", null, "2026-11-08T10:00:00.000Z", null),
  ]);
  asrt(records.length === 2, `legacy same-mint same-3s duplicate removed (kept ${records.length})`);
}

// distinct mints / distinct times are kept
{
  const { records } = dedupeTrades([
    t("MINT_E", "s1", "2026-11-08T10:00:00.000Z"),
    t("MINT_F", "s1", "2026-11-08T10:00:00.000Z"),
  ]);
  asrt(records.length === 2, "distinct mints kept");
}

console.log("PASS: dedupeTrades removes cross-process/legacy duplicates and reports per-gitSha counts");
