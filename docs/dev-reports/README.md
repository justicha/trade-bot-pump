# Development reports

Working code reports live here. **These are not trading results** and not proof of profit:
they are notes about what was checked in the code and what came of it.

| File | About |
|---|---|
| `ACT_REPORT.md` | activation and edit report: what changed and why |
| `SHADOW_ACT_REPORT.md` | report on the shadow (paper) run of the graduation sniper |
| `BUGS_VERIFICATION.md` | review of 29 reported problems: a verdict and status per row |
| `AUDIT_SELL.md` | sell audit: why a sale is sometimes impossible, what was checked and what was not |

How to read:

- a **FIXED** row usually names the test that confirms it;
- a **DEFERRED** or **NEEDS VERIFICATION** row means "not updated in the audit log",
  not "the problem is definitely in the current code";
- line numbers in these files refer to the code at audit time and drift over time.

The overall verification status is in [../verification-status.md](../verification-status.md).
