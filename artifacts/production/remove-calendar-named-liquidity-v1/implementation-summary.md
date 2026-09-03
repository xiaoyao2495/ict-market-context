# REMOVE_CALENDAR_NAMED_LIQUIDITY_V1 — Implementation Summary

**Date:** 2026-09-03
**Scope:** Production removal (not disable) of 6 calendar-named liquidity types:
`PDH` (Prev Day High), `PDL` (Prev Day Low), `PWH` (Prev Week High),
`PWL` (Prev Week Low), `PMH` (Prev Month High), `PML` (Prev Month Low).

**Governance (spec §0):** `FROZEN_REMOVAL_SET = {PDH,PDL,PWH,PWL,PMH,PML}`;
`BACKWARD_COMPATIBILITY_REQUIRED=false`; `FEATURE_FLAG=false`;
`DEPRECATION_LAYER=false`; `FALLBACK=false`; `LEGACY_ADAPTER=false`;
`EMPTY_COMPATIBILITY_OUTPUT=false`.

---

## 1. What was removed

- **Generators/detectors (deleted):** `liquidity/dailyLiquidity.js`,
  `liquidity/weeklyLiquidity.js`, `liquidity/monthlyLiquidity.js` and their
  test files `test/{daily,weekly,monthly}Liquidity.test.js`.
- **Type domain:** the 6 types are no longer recognized as liquidity source
  types anywhere in the production runtime.

## 2. Enforcement points (spec §3–§6, §13)

| Layer | File | Change |
|-------|------|--------|
| Registry | `liquidity/liquidityRegistry.js` | `REMOVED_CALENDAR_LIQUIDITY_TYPES` denylist — `add()` returns `false` for the 6 types (active rejection). |
| Narrative eligibility | `events/sweepNarrativeEligibilityV1.js` | Removed from `CONTRACT` → `classifySourceType` returns `UNRESOLVED`. |
| Sweep context class | `stats/sweepContextV1.js` | `sourceClass()` returns `UNRESOLVED` for the 6 types. |
| LIQUIDITY_TAKEN | `events/liquidityTakenEventAdapter.js` | `NARRATIVE_TYPES = {EQH,EQL}` only. |
| WATCH | `stats/liquidityTakenAssociation.js` | `ELIGIBLE_TYPES = {EQH,EQL}` only. |
| Notification labels | `notify/sweepContextPresentationV1.js` | Removed `日线/周线/月线流动性` branches in `nonSwingType`; removed types render generic `原生流动性`. |
| Notification SOURCE_ZH | `notify/watchNotificationPresentationV1.js` | No PDH/PDL entries; unknown types render raw identity. |
| Significance | `stats/liquidityRelevanceAudit.js` | `sourceGroupOf` returns `OTHER` (not `SIGNIFICANT`) for the 6 types. |

## 3. Test cleanup (spec §16)

- 25 existing test files rewritten to the new production contract (UNRESOLVED /
  raw identity / EQH-EQL eligibility). No legacy behavioral contract was
  restored to pass a test.
- 1 new contract test file `test/calendarNamedLiquidityRemovalV1.test.js`
  (40 assertions) proving removal across registry, eligibility, taken, watch,
  presentation, relevance, and provenance.
- 3 generator test files deleted alongside their sources.

## 4. Dead-code audit (spec §19)

- The only deleted code is the 3 generator files. No orphaned production
  function/export references them (production require graph was clean; the
  full suite loaded with no require-time crash).
- The registry denylist is **active enforcement**, not dead code.
- Audit scripts / research harnesses / golden fixtures under
  `scripts/`, `research/`, `repository-production-core-reduction-v1/` retain
  calendar references intentionally (archival / reproducibility). They are
  non-runtime and were recorded, not modified.

## 5. Determinism & causality (spec §24)

- The change is pure deletion of calendar branches + test-fixture rewrites.
  No deterministic logic (timestamps, randomness, ordering) was altered.
- Causal paths for the 6 types are intentionally removed; all other causal
  chains (EQH/EQL narrative, SWING, Session, FVG, Displacement, BIAS, AMD,
  SCENARIO) are byte-identical to the pre-cleanup baseline.
- Full suite: 238/238 passing, 0 `not ok`.

## 6. Gates

| Gate | Result |
|------|--------|
| §16 Test cleanup | PASS (rewritten, no legacy restored) |
| §17 Removal contract (40/40) | PASS |
| §18 Static dependency audit (runtime refs = 0) | PASS |
| §19 Dead-code audit | PASS |
| §21 Targeted tests | PASS |
| §22 Full suite `node test/run.js` EXIT=0 | PASS (238/238) |
| §23 Replay sanity (NETWORK=0, types=0) | PASS |
| §24 Causality / determinism | PASS |
| §25 Artifacts | generated |

## 7. Commit gate (spec §29)

All gates above are PASS. Eligible for:
`git add` (only this cleanup's files) →
`git commit -m "cleanup: remove calendar-named liquidity levels"` →
`git push origin main`.
