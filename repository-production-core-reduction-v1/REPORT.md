# Repository Production-Core Reduction V1 — REPORT

**Project:** `/Users/yaodebao/Desktop/git/ict03/ict-market-context`
**Date:** 2026-08-27
**Outcome:** `REPOSITORY_PRODUCTION_CORE_REDUCTION_V1 = PASS`

## 1. Method

A real require-graph was built from production/test/tool roots and traversed with BFS:

- **Production root:** `scripts/live.js` (the live runtime) + `package.json` `main` + `entry/*`.
- **Test root:** `test/run.js` glob of `*.test.js` + every `test/*.test.js`.
- **Tool roots:** `package.json` scripts (`test`, `inspect`) + `scripts/testDingTalk.js`, `scripts/inspectLiquidity.js`.

Every `.js` `require(...)` was parsed; BFS produced the **reachable set** (production / active-test / active-tool).
Anything outside that set was a deletion candidate. A **keeper re-validation** then re-scanned every *surviving* file for `require`/`fs` references into a candidate path — if any keeper (production/test/tool) depended on it, the candidate was kept (UNKNOWN safety).

`node_modules`, `.git`, `.workbuddy` and the report dir itself were excluded throughout.

## 2. Before / After

| Metric | Before | After | Reduction |
|---|---:|---:|---:|
| Total files (excl node_modules/.git) | 1187 | 278 | −909 (76.6%) |
| JS files | 375 | 268 | −107 |
| Project size | 570.34 MB | 2.53 MB | **−567.81 MB (99.6%)** |
| Active test files (`*.test.js`) | 96 | 96 | 0 (none deleted) |

`node_modules` (dependency, gitignored) was **not** deleted and is excluded from the size figures.

## 3. Deleted by category

| Category | Size | Notes |
|---|---:|---|
| AUDIT_ONLY (`.audit-*` dirs) | 424.12 MB | 25 historical audit workspaces |
| CACHE (`data-cache/`) | 99.30 MB | 133 replay/cache JSON, read only by research scripts |
| GENERATED_ARTIFACT (`*-v1` dirs) | 30.40 MB | 19 design/shadow/diagnosis/replay artifact dirs |
| OLD_OUTPUT (`outputs/`) | 12.47 MB | 196 generated reports/ledgers |
| ARCHIVED (`archive/`) | 0.64 MB | 55 files — `PRODUCTION_REACHABLE_COUNT = 0` |
| RESEARCH_ONLY (scripts + `draw/`) | 0.88 MB | 48 research/audit scripts + research viz dir |

**Total deleted:** 96 plan entries (48 dirs + 47 files + `draw/`), ~568 MB.

## 4. Largest deletions (top 8)

| Path | Size |
|---|---:|
| `.audit-produced-frontier-extension-rule-v1-shadow` | ~62.8 MB |
| `.audit-opportunity-quality-narrative-refactor-v1` | ~51.8 MB |
| `.audit-structural-swing-refactor-v1-after` | ~36.6 MB |
| `.audit-structural-swing-event-semantics-v1-after` | ~33.4 MB |
| `data-cache/` (aggregate) | 99.30 MB |
| `.audit-opportunity-high-gate-v2` | ~43.8 MB |
| `.audit-opportunity-funnel-v1-btcusdt-dc-20260823` | ~35.8 MB |
| `.audit-mss-signal-coverage-refactor-v1` | ~72.9 MB |

(Full top-50 in `largest-deleted-paths.json`.)

## 5. Production core preserved

Remaining source directories: `ai/` (Bias/DeepSeek pipeline — required by active `test/deepseek4hBiasAudit.test.js`), `amd/`, `audit/` (shadow modules required by active tests), `bias/`, `config/`, `context/`, `data/`, `docs/`, `entry/`, `events/`, `fvg/`, `indicators/`, `liquidity/`, `live/`, `notify/`, `replay/`, `scenario/`, `scripts/`, `stats/`, `structure/`, `test/`, `trade/`, `utils/`.

All WATCH → FVG FIRST_TOUCH → DingTalk chain modules (`scripts/live.js`, `live/*`, `notify/watchNotificationPresentationV1.js`, `notify/sweepContextPresentationV1.js`, `notify/dingTalk.js`, `stats/displacementWatch.js`) are intact and unmodified by this task.

## 6. Verification

| Check | Result |
|---|---|
| Broken production requires (post-delete) | **0** |
| Broken active-test requires | **0** |
| Production JS syntax errors (`node --check`) | **0** (273 files) |
| Keeper→deletable fs/require violations | **0** |
| Broken `package.json` scripts | **0** |
| `npm test` (full suite) | **ALL TESTS PASSED** (96 test files) |
| Golden notification smoke | **PASSED** (formatter → mock DingTalk `errcode:0`) |
| Production DingTalk call sites | **exactly 1** (`deliverWatchTouch → dingTalk.sendText`) |

## 7. Notification path (unchanged)

```
5m close → liveEngine → Structure/MSS/Displacement → displacement leg
→ WATCH → Native FVG → FIRST_TOUCH → handleWatchTouches
→ retryWatchPending → deliverWatchTouch → buildFvgRetracementMessage
→ watchNotificationPresentationV1.build → sweepContextPresentationV1
→ dingTalk.sendText
```
WATCH persistence, FVG watch persistence, notification outbox, delivered dedup, and restart recovery are all preserved. The Legacy HIGH dead chain removed in the prior task is not reintroduced.

## 8. UNKNOWN kept (safety)

24 source files were kept as UNKNOWN (non-reachable, non-research-pattern, source-dir files) rather than risk deleting a future/experimental production module. Full list in `cleanup-unknown.json`. `ai/` and `audit/` are **not** UNKNOWN — they are provably required by active tests and are therefore protected, not accidental survivors.

## 9. Acceptance flags

```
REPOSITORY_PRODUCTION_CORE_REDUCTION_V1 = PASS
PRODUCTION_CORE_PRESERVED              = true
CURRENT_NOTIFICATION_PRESERVED         = true
NARRATIVE_LIQUIDITY_V1_PRESERVED       = true
SWING_STRUCTURAL_PRIMITIVE_PRESERVED   = true
AMD_REQUIRED_RUNTIME_PRESERVED         = true
PERSISTENCE_PRESERVED                  = true
HISTORICAL_RESEARCH_CODE_REMOVED       = true
HISTORICAL_AUDIT_ARTIFACTS_REMOVED     = true
ARCHIVE_REMOVED                        = true
CACHE_REMOVED                         = true
OLD_OUTPUTS_REMOVED                   = true
BROKEN_PRODUCTION_REQUIRE_COUNT        = 0
BROKEN_ACTIVE_TEST_REQUIRE_COUNT       = 0
BROKEN_PACKAGE_SCRIPT_COUNT            = 0
DANGLING_PRODUCTION_REFERENCE_COUNT    = 0
PRODUCTION_SYNTAX_ERRORS               = 0
GOLDEN_NOTIFICATION_SMOKE_PASSED       = true
ALL_TARGETED_TESTS_PASSED              = true
ALL_TESTS_PASSED                      = true
PRODUCTION_BEHAVIOR_CHANGED            = false
UNSAFE_DELETE_COUNT                    = 0
```

## 10. Scope discipline

- No market-semantic change (pivot threshold, 2/2, EQ/PD/PW/PM, MSS, displacement, FVG, Bias, AMD, Scenario, WATCH logic, Narrative Liquidity V1, notification content) — untouched.
- No Liquidity V2 research started.
- No 30D replay / network request / real DingTalk send performed.
- **Not committed / not pushed** (`git status` shows 141 deletion/modification entries, all staged-or-uncommitted; `scripts/live.js` remains modified from the prior Legacy HIGH removal, also uncommitted).

## 11. Report file inventory

`before-metrics.json`, `after-metrics.json`, `production-dependency-graph.json`, `test-dependency-graph.json`, `cleanup-delete-plan.json`, `cleanup-unknown.json`, `deleted-paths.json`, `largest-deleted-paths.json`, `package-script-audit.json`, `notification-path-audit.json`, `golden-path-smoke.json`, `acceptance.json`, `REPORT.md`.
