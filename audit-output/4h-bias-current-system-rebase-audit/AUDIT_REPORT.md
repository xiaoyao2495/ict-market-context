# 4H_BIAS_CURRENT_SYSTEM_REBASE_AUDIT

**Task type:** read-only production architecture and semantics audit.
**Baseline:** `0bb830d1fc0ef4f8614efb554b914287a6ae0d7a` on `main`, clean worktree.
**Scope:** what the 4H Bias *is* inside the current HEAD production path. Not what it should be.
**Non-goals honoured:** no production code, prompt, threshold, fact or model change; no new indicator or benchmark; no outcome/accuracy analysis; no network call; no LLM call; no commit.

---

## 1. Executive Summary

The production 4H Bias is a single, well-bounded system: **`4H_BIAS_V3`**, created in `scripts/live.js` and owned by `live/4hBiasV3.js`. It reads only fully closed native futures 4H candles, compresses exactly six deterministic facts with one frozen prompt through DeepSeek, freezes the resulting triple in an immutable decision store, and then does two very different things with it:

- **hard gate** for entry and real orders (`execution/executionRulesV1.biasGate`), and
- **display block** in the two event-driven DingTalk messages (Range confirmation, EQ/FVG WATCH).

It is **not** a predictor and it never sees raw candles. Its input is six deterministic facts; it has no access to 5m data, FVG, EQ, liquidity, order book, PnL or any trade result. Causality is enforced in three independent places (closed-candle filters, pivot `confirmedAt` gating, and a structural future-leak guard that throws), and the audit found **zero causality violations**.

The architecture is materially better than its reputation inside this repository: the semantic layer is contract-checked, the decision store is genuinely immutable and create-if-absent, the same facts after a restart reuse the frozen decision with zero LLM calls, and the bias never blocks the 5m pipeline. What holds it back from being extracted as a standalone tool is **coupling in the host runtime**, not the bias logic itself: the bias service is wired through the live runner's data closure, and the same HTF fetch that feeds the bias also gates the entire 5m tick.

**Verdict: `READY_WITH_DECOUPLING_REQUIRED`.** The bias semantics, facts, causality, store and prompt are sound and reusable; the extraction needs a data-injection seam and a store path, not a redesign.

---

## 2. Current Baseline

```
HEAD                 0bb830d1fc0ef4f8614efb554b914287a6ae0d7a
BRANCH               main
TRACKED_DIFF_COUNT   0
STAGED_DIFF_COUNT    0
UNTRACKED_COUNT      0 (before this audit directory was created)
```

One pre-existing hygiene defect was exposed by running the suite on this clean baseline: `test/rangeObjectV1.test.js` fails because it requires the untracked artifact `artifacts/research/luxalgo-length24-oos-v1/dataset.json`, which does not exist in a freshly cleaned worktree. This is unrelated to the 4H bias (see §29).

---

## 3. Production Entry Point

`scripts/live.js` is the only live entry point. The 4H bias is initialised at module scope inside the runner factory:

| item | location |
|---|---|
| imports | `scripts/live.js:38-40` |
| service creation | `scripts/live.js:317-331` |
| candle getter | closure over `runnerData.structureCandles['4h']` |
| decision store directory | `CONFIG.dataDir + '/4h-bias-decisions-v1'` |
| refresh call | `scripts/live.js:975-981`, invoked from `doTick` at line 1004 |
| cadence | once per tick; `config/live.json pollMs = 30000` |
| gate consumer | `scripts/live.js:362-363` → `execution/executionRulesV1.js:47-57` |
| notification consumers | `scripts/live.js:566` and `scripts/live.js:612` |
| model banner | `scripts/live.js:1097` logs `4H_BIAS_MODEL=4H_BIAS_V3` |

`refresh` is idempotent per closed candle: `live/4hBiasV3.js:154` returns the existing snapshot when `lastProcessedClosed4hCloseTime === latest.closeTime`.

---

## 4. Complete 4H Bias Call Graph

```
scripts/live.js
  └─ doTick()                                      [983-1013]
       ├─ dataSource.fetchHtfIncrement()           [dataSource.js 294-331]
       │     └─ binanceRest.loadHistory(...'4h'...) → append closed futures 4h rows
       ├─ refresh4hBias()                          [975-981]
       │     └─ live/4hBiasV3.js refresh()          [141-236]
       │          ├─ latestFullyClosed()            [70-76]  closed && closeTime <= evalTime
       │          ├─ factBuilder.build()            [4hBiasFactsV3.js 43-78]
       │          │     ├─ visibleClosed / assertNative
       │          │     ├─ leg.calculateAtrWilder(14)
       │          │     ├─ metrics.priceDelivery(...,24)      → signedMoveAtr24, signedEfficiency24
       │          │     ├─ metrics.dmiAdx(14,14)              → normalizedDirectionalSpread, adx14
       │          │     ├─ theilSen.slope48()                 → theilSenSlope48
       │          │     └─ dailyBiasContext.buildDailyBiasContext()  → structureDirection
       │          ├─ semanticContract.buildInput()  [4hBiasSemanticV3.js 86-93]
       │          ├─ decisionStore.buildIdentity()  [4hBiasDecisionStoreV1.js 70-93]
       │          ├─ decisionStore.lookup()         HIT → publish, zero LLM calls
       │          ├─ requestSemantic()  (MISS only)
       │          │     └─ deepseekClient.chat()    [ai/deepseekClient.js 47-171]
       │          ├─ decisionStore.freeze()         atomic create-if-absent
       │          └─ publish()                      deepFreeze + observe()
       ├─ eqAlerts.flush()
       ├─ if (!htf.ok) return;                      [1008-1011]  ← 5m pipeline pause
       └─ dataSource.pollNew5m() → processCandles()
```

Downstream consumers of the published snapshot are exactly four:

1. `executionContext()` → `executionRulesV1.biasGate` → `buildEntryPlan` → `realOrderExecutionV1` (hard gate).
2. `sendEqFvgNotification` → bias display block.
3. `sendRangeConfirmation` → bias display block.
4. `observe()` structured log record and `semanticExecutionPreview` log line.

---

## 5. 4H Data Contract

- **Source:** Binance USDⓈ-M futures REST, default host `https://fapi.binance.com`, paths `/fapi/v1/klines` and `/fapi/v1/exchangeInfo` (`data/binanceRest.js:102-157`). A spot fallback path (`/api/v3/klines`) exists in the client but production runs with `requireFutures = true` and rejects any non-futures row.
- **Symbol:** dynamic universe (`symbolsMode: "dynamic"`, `topN: 10`, ranked on 4h), plus lifecycle-retained symbols. Each symbol gets its own bias service instance.
- **Interval:** `4h`, native only (`closeTime === openTime + 4h - 1`).
- **Requested history:** `120 required + 2 technical allowance = 122` bars per HTTP call.
- **Initial bootstrap:** `fetchProductionBootstrap` fetches 5m/4h/1h/1d plus exchangeInfo in parallel; the 4h leg is filtered and sliced to 120.
- **Incremental refresh:** boundary-scheduled (`createHtfBoundaryScheduler`), only when `evaluationTime >= last.closeTime + 4h`, with a 60-second retry floor per timeframe.
- **Closed-candle filter:** applied twice (service layer and fact layer) plus once at append time.
- **Continuity:** `assertNative` rejects source mismatch, non-native shape and openTime gaps.
- **Retry/failure:** network errors are recorded as `issues` and never swallowed; degraded sources are recorded and never appended.
- **Cache:** the 4h array is in-memory for the process lifetime; no candle cache is persisted by the bias path.

**Is production strictly using fully closed 4H candles? YES** — three independent filters and a test.

---

## 6. History / Closed-Candle Semantics

| quantity | value | evidence |
|---|---|---|
| `REQUESTED_4H_HISTORY_BARS` | 122 per HTTP request | `live/dataSource.js:137` |
| `ACTUAL_MINIMUM_REQUIRED` | 120 closed bars | `config/productionHistoryRequirementsV1.js` `4h.requiredClosedBars = 120`; readiness gate `available4hBars >= 120`; `4hBiasFactsV3.MIN_WARMUP = 120` |
| `ACTUAL_FACT_LOOKBACK_MAX` | 120 | the structure builder is the binding constraint (`ai/dailyBiasContext.js WINDOW = 120`) |

Per-fact lookbacks differ and are reported separately in `deterministic-facts.json`:

| fact | lookback |
|---|---|
| `normalizedDirectionalSpread` | 15 bars for first DI, whole visible series for the recursion; final value only |
| `adx14` | ADX series begins at index 27; Wilder-smoothed to the latest bar |
| `signedMoveAtr24` | 24 bars (+ ATR14 recursion) |
| `signedEfficiency24` | 24 bars |
| `theilSenSlope48` | 48 bars |
| `structureDirection` | 120 bars |

So the code does **not** fetch "120 because of the indicator": it fetches 120 because the causal 2L/2R structure builder needs 120, and the comment in `4hBiasFactsV3.js:11` says exactly that. Five of six facts would be satisfiable with 48 bars or fewer.

---

## 7. Deterministic Fact Inventory

`FACT_COUNT = 6`. Schema is frozen in `4hBiasSemanticV3.FACT_FIELDS` and asserted by test 10.

| # | fact | source | formula | lookback | range | direction semantics |
|---|---|---|---|---|---|---|
| 1 | normalizedDirectionalSpread | `4hDirectionalMetrics` | `(+DI − −DI) / (+DI + −DI)`, 0 if denominator 0 | 15+ (final value) | [−1, +1] | sign = directional dominance; no threshold |
| 2 | adx14 | `4hDirectionalMetrics` | Wilder DX then Wilder-smoothed ADX | 27+ | [0, 100] | **strength only, no direction** |
| 3 | signedMoveAtr24 | `4hDirectionalMetrics` | `(close[t] − close[t−24]) / atr14[t]` | 24 | unbounded | sign = net delivered direction |
| 4 | signedEfficiency24 | `4hDirectionalMetrics` | `net / Σ|close[i] − close[i−1]|`, 0 if path is flat | 24 | [−1, +1] | sign = net direction, magnitude = one-sidedness |
| 5 | theilSenSlope48 | `theilSen48` | median of 1128 pairwise log-close slopes | 48 | unbounded | sign = robust slow trend |
| 6 | structureDirection | `4hBiasFactsV3.structureDirection` | `structuralState` mapped BULLISH→UP, BEARISH→DOWN, else NEUTRAL | 120 | UP/DOWN/NEUTRAL | causal break-of-structure direction |

All five numeric facts must be finite or the build throws `NON_FINITE_FACT_<name>`.

---

## 8. normalizedDirectionalSpread

It compares **Wilder +DI14 against −DI14 of the newest fully closed 4H bar**, normalised by their sum. Numerator = `+DI14 − −DI14`. Denominator = `+DI14 + −DI14`, and the function returns exactly `0` when the denominator is zero (deterministic guard, not a throw).

Positive means +DI dominance (upward directional movement), negative means −DI dominance, zero means balance or a degenerate/zero-TR bar. There is **no threshold** anywhere: the fact stays continuous, and no bullish/bearish classification is applied in code. The classification decision lives entirely in the prompt-driven semantic layer.

Test 10 in `4hBiasDecisionFreezeV1.test.js` explicitly asserts that a positive spread may coexist with a frozen BEARISH decision — i.e. the code does not smuggle in a rule.

---

## 9. ADX

`dmiAdx(candles, 14, 14)` is a faithful Wilder implementation transferred from the mature benchmark: TR, +DM/−DM with the standard `up > down && up > 0` rules, a simple-sum seed at index 14, then Wilder smoothing (`sm − sm/p + current`), DX from `|+DI − −DI| / (+DI + −DI)`, first ADX as the mean of DX[14..27], then Wilder-smoothed.

- **Period:** 14, ADX period 14.
- **+DI / −DI into the semantic input?** No. Only `adx[index]` enters the fact set. `+DI`/`−DI` are consumed by fact 1 and are not exposed separately.
- **Is ADX expressed as direction?** No. It is an absolute spread, and the prompt states verbatim: *"ADX14 contributes to Strength only. ADX has no bullish or bearish direction."* Test 17 asserts that sentence exists.
- **Milestone gate:** this is the failure mode the audit was asked to check for, and it is **not present**.

---

## 10. Signed Move

`24` is **24 closed 4H bars** (96 hours), not 24 of anything else. The anchor is `t = newest fully closed bar`, reference `close[t − 24]`, and the divisor is `atr14[t]` evaluated at the same newest bar. Because `t` is the latest fully closed bar, an unfinished candle cannot enter. Positive = net upward delivered move over 96 hours, measured in ATR14 units. No threshold.

---

## 11. Signed Efficiency

```
net       = close[t] − close[t−24]
travelled = Σ |close[i] − close[i−1]|  for i in [t−23, t]
fact      = travelled === 0 ? 0 : net / travelled
```

It is strictly close-to-close (no wick, no high/low). The sign comes from `net`. The denominator-zero case is handled by an explicit `0` return, so it can never produce NaN, Infinity, or a silent throw. Range is [−1, +1]: sign = net direction, magnitude = how one-sided the 96-hour path was.

---

## 12. Theil-Sen Slope

Input is the **log close of the last 48 closed 4H bars**. The slope is the median of all pairwise slopes `(logClose[j] − logClose[i]) / (j − i)` for `i < j` — 1128 pairs — with an even-length median taken as the mean of the two central sorted values, matching SciPy/NumPy semantics.

- **Unit:** log-return per 4H bar.
- **Robustness:** median-of-slopes is inherently resistant to magnitude outliers.
- **Validation:** matches the frozen SciPy benchmark value to `1e-15` (test 07); warmup is exactly 48 (test 08).
- **Positive/negative:** rising vs falling robust slow trend. No threshold.

---

## 13. Structure Direction

This is the most entangled fact and the one worth reading carefully.

Chain: `4hBiasFactsV3.structureDirection` → `ai/dailyBiasContext.buildDailyBiasContext` (WINDOW 120, replays every visible bar in time order) → `ai/auditPivots.detectPivots` (left 2 / right 2) → `ai/auditMarketFacts.computeMarketFacts` → `ai/auditStructuralProvenance.computeStructuralProvenance` → `structuralState`.

- **Structure source:** a causal 2L/2R pivot detector, not the production 5m swing classifier and not any ICT structural-swing engine from `structure/`.
- **Mapping:** `structuralState === 'BULLISH' → 'UP'`, `'BEARISH' → 'DOWN'`, everything else (including the initial `'UNKNOWN'`) → `'NEUTRAL'`.
- **`confirmedAt` discipline:** a pivot at index `i` is only admitted when `candles[i + right].closeTime <= evaluationTime`. The future candle is *read* as a confirmation clock but never contributes a value.
- **Structural events:** each carries `confirmedAt` = the confirming candle close. `4hBiasFactsV3` throws `STRUCTURE_FUTURE_CONFIRMATION` if any event's `confirmedAt` exceeds the evaluation time.
- **Independent leak guard:** `auditStructuralProvenance` assembles `futureLeakViolations` (protected swings, BOS events, source protected swings) and throws if the list is non-empty.
- **Future-leak risk:** mitigated in three independent places, and additionally proven by the twenty-cutoff prefix-invariance test (test 14).

---

## 14. Causality / knownAt

`FACT_CAUSALITY_VIOLATION_COUNT = 0`.

The evaluation point is the closeTime of the newest fully closed native 4H candle. Note the precise split inside `refresh`: the *data-selection* evaluation time is the wall clock (`refresh(Date.now())`), while the *fact* evaluation time is `latest.closeTime` (`buildFacts(candles, latest.closeTime, …)`, line 159). Every fact is therefore computed strictly at a candle boundary, never at an arbitrary wall-clock instant.

Checks performed: closed-candle filter at both layers; unfinished-candle exclusion; backward-only window indices; pivot right-side confirmation; structural event confirmation; structural provenance leak guard; HTF refresh boundary; restart/cache identity; prefix invariance. Full detail in `fact-causality-audit.json`.

---

## 15. Canonical Facts Schema

The canonical object is built by `4hBiasDecisionStoreV1.buildCanonicalFacts` (lines 48-68) and is exactly:

```json
{
  "symbol": "<string>",
  "candle": { "openTime": <number>, "closeTime": <number> },
  "factsVersion": "4H_BIAS_FACT_SET_V3",
  "facts": {
    "adx14": <number>,
    "normalizedDirectionalSpread": <number>,
    "signedEfficiency24": <number>,
    "signedMoveAtr24": <number>,
    "structureDirection": "UP" | "DOWN" | "NEUTRAL",
    "theilSenSlope48": <number>
  }
}
```

Properties enforced by `canonicalize` / `stableSerialize`:

- **field order:** irrelevant for hashing — keys are sorted recursively before serialization.
- **rounding:** none; exact finite values are preserved.
- **negative zero:** normalised to `0`.
- **non-finite numbers:** rejected (`CANONICAL_NON_FINITE_NUMBER`).
- **undefined values:** rejected (`CANONICAL_UNDEFINED_VALUE`).
- **serialization:** `JSON.stringify` of the canonicalised object; that string is what gets hashed.
- **hashing:** `factsHash = sha256(stableSerialize(canonicalFacts))`.

The semantic input object is a *different* four-field object (`{symbol, timeframe, closedAt, facts}`) validated with `exactKeys`, so both schemas are pinned independently.

---

## 16. Semantic Layer

| property | value |
|---|---|
| provider | DeepSeek (OpenAI-compatible `/chat/completions`) |
| model requested | `process.env.DEEPSEEK_MODEL` or `deepseek-v4-flash` |
| model identity guard | `getModel() !== semanticContract.MODEL` → `V3_MODEL_CONFIG_MISMATCH` |
| alias normalisation | **none** — no alias table exists |
| prompt source | `bias/4hBiasSemanticV3.js` SYSTEM_PROMPT + USER_PROMPT_PREFIX |
| prompt version / hash | `4H_BIAS_SEMANTIC_V3` / sha256 of the full template |
| temperature | 0 (hard-coded at the call site) |
| max tokens | `getAuditCompletionTokenLimit()` |
| structured output | `response_format: {"type":"json_object"}` and `thinking: {"type":"disabled"}` |
| HTTP timeout | 60 000 ms |
| retries | 0 in the bias path (`maxAttempts: 0`) |

Model identity, prompt hash and prompt version all enter the decision key, so changing any of them invalidates reuse instead of silently mixing eras. The V2 prompt hash is retained as a constant purely so V2 records can never be mistaken for V3.

---

## 17. DeepSeek Role

**Classification: B — the LLM reads deterministic facts and performs semantic synthesis.**

| question | answer |
|---|---|
| Does DeepSeek see raw 4H candles? | **NO** |
| Does it see future outcome, PnL or trade results? | **NO** |
| Does it see 5m setups, liquidity, FVG, EQ or WATCH state? | **NO** |
| Is it a formatter only? | NO — it makes the direction/strength/confidence judgement |
| Is it a predictor? | NO — the prompt forbids future price, next candle, continuation, reversal, outcome and profitability |

The input is exactly `{symbol, timeframe, closedAt, facts}` with the six facts. The prompt additionally forbids hard thresholds, weighted voting, composite scores, inventing evidence, and any trading advice. This is a semantic compressor over a frozen fact vector, and the fact vector is the entire evidence base.

*(Historical note, important to avoid confusion: `ai/ictBiasPrompt.js` — the "方案 Z" prompt that sent 120 raw OHLC candles — still exists in the repo but is reachable only from offline audit scripts. It is not the production architecture.)*

---

## 18. Output Schema

```
direction  : BULLISH | BEARISH | NO_PRIORITY
strength   : STRONG | MODERATE | WEAK
confidence : HIGH | MEDIUM | LOW
summary    : non-empty string
conflicts  : string ("NONE" allowed)
```

Enforced by `validateOutput` with `exactKeys`, so an extra field is a hard failure. The **decision store record deliberately keeps only `{direction, strength, confidence}`** — the prose never enters the frozen identity, and the production notification never displays the model prose (test 11).

---

## 19. Decision Store / Cache

`SEMANTIC_DECISION_STORE_IMMUTABLE = true`. `SAME_FACTS_REUSE_DECISION = true`.

- **Key:** `sha256(stableSerialize({version, symbol, candle, factsHash, factsVersion, promptHash, promptVersion, modelId}))`, one `<decisionKey>.json` file per decision.
- **Value:** the full record including the canonical facts and the frozen decision triple.
- **MISS:** `ENOENT` → one LLM call.
- **HIT:** record re-validated by rebuilding the identity; zero LLM calls; the stored facts are republished.
- **Immutability mechanism:** write temp (`wx`, mode 0600) → fsync → `fs.linkSync` (atomic create-if-absent) → fsync directory. On `EEXIST` the existing official record wins. There is no rename, delete or overwrite path in the store.
- **Corruption:** any schema/hash/enum mismatch raises `BIAS_DECISION_STORE_CORRUPT`; the service publishes UNAVAILABLE, never regenerates and never overwrites.
- **Restart:** facts are recomputed deterministically, the decision key matches, and the frozen decision is reused with zero LLM calls (test 02).

---

## 20. Failure Policy

The bias **fails open for context and fails closed for the gate**, with one important exception that is not about the bias at all.

| failure | bias status | LLM calls | blocks 5m pipeline | blocks entry |
|---|---|---|---|---|
| 4H data fetch failure | UNAVAILABLE | 0 | no | yes |
| no fully closed 4H candle | UNAVAILABLE | 0 | no | yes |
| fact calculation failure | UNAVAILABLE | 0 | no | yes |
| decision identity failure | UNAVAILABLE | 0 | no | yes |
| store read error / corruption | UNAVAILABLE | 0 | no | yes |
| DeepSeek timeout / malformed / schema-invalid | **PARTIAL** (facts retained) | 1 | no | yes |
| DeepSeek synchronous failure (no API key) | **PARTIAL** | 0 | no | yes |
| model config mismatch | PARTIAL | 0 | no | yes |
| store write failure after a good response | UNAVAILABLE | 1 | no | yes |
| `refresh4hBias` rejects unexpectedly | previous snapshot kept, logged | - | no | (whatever the previous snapshot implies) |
| **HTF incremental fetch failure (1h/4h/1d)** | n/a — this is the data pipeline | - | **YES** | n/a |

The `if (!htf.ok) return;` pattern the audit design asked about **does exist**, at `scripts/live.js:1008-1011` inside `doTick`. It pauses the whole 5m tick for that symbol: `pollNew5m` is not called, no candle is processed, no WATCH/EQ/FVG state advances and no notification is emitted. Recovery is automatic on the next tick, after which the gap is detected and backfilled.

Critically, this gate is driven by the **shared HTF data fetch** (1h, 4h and 1d), not by the bias semantic layer. A DeepSeek outage never pauses the 5m pipeline; a 1h fetch outage does.

---

## 21. 5m Pipeline Coupling

`BIAS_IS_5M_PIPELINE_GATE = false` for the semantic bias, and `true` for the shared 4H/HTF data dependency.

The distinction matters: the bias service is *called from* the tick but its result is never used to decide whether the 5m pipeline advances. The pause is caused by `htf.ok`, which is a property of the HTF increment result. Because that same increment is what feeds `runnerData.structureCandles['4h']`, the bias and the 5m pipeline share one failure surface — this is the single most consequential coupling found by this audit (`AC_1`).

---

## 22. WATCH Coupling

`BIAS_IS_WATCH_GATE = false`.

WATCH creation, WATCH state transitions and the WATCH decision output are independent of the bias payload: test 35 runs the WATCH state machine with and without a `current4hBias` and asserts identical control output; test 36 asserts the restored WATCH discards the legacy V2 research context field. The bias appears in the WATCH *message*, never in the WATCH *decision*.

---

## 23. Entry / Real Order Coupling

`BIAS_IS_ENTRY_GATE = true`, `BIAS_IS_REAL_ORDER_GATE = true`.

```
execution/executionRulesV1.js:47-57  biasGate(direction, bias, expectedClosedAt)
  requires  status === 'AVAILABLE'
  requires  bias.closedAt === expected4hClosedAt   (the newest closed 4H closeTime)
  requires  semantic.direction === 'BULLISH' for LONG, 'BEARISH' for SHORT
  requires  semantic.strength === 'STRONG'
  requires  semantic.confidence === 'HIGH'
  else      HTF_UNAVAILABLE | HTF_NOT_ALIGNED | HTF_NOT_STRONG | HTF_NOT_HIGH_CONFIDENCE
```

This gate is evaluated inside `buildEntryPlan` (line 180) and therefore sits upstream of `realOrderExecutionV1` trade admission (line 309). When it fails, the trade is recorded as `NO_TRADE` with the gate reason code and **no exchange client call is made** — including the shadow-order path. So the real order flow is fully bias-gated.

The same function is invoked in a read-only preview (`scripts/live.js:421-423`) which only logs `PASS` / `BLOCK:<reason>`.

---

## 24. Notification Path

Two event-driven DingTalk messages carry the bias block, and nothing else does:

- `sendRangeConfirmation` (`scripts/live.js:565-580`) → `notify/rangeNotificationV1.js:40`
- `sendEqFvgNotification` (`scripts/live.js:610-626`) → `notify/eqFvgCountWatchNotificationV1.js:96`

Execution alerts (`sendExecutionAlert`, line 375-385) do **not** attach the bias.

The rendered block is:

```
📊 4H Bias
Semantic Decision:
方向: 🟢 BULLISH | 🔴 BEARISH | ⚪ NO_PRIORITY
力度: STRONG | MODERATE | WEAK
置信: HIGH | MEDIUM | LOW
Deterministic Facts:
normalizedDirectionalSpread: <signed>
ADX14: <unsigned>
signedMoveAtr24: <signed>
signedEfficiency24: <signed>
theilSenSlope48: <signed>
structureDirection: UP | DOWN | NEUTRAL
```

Degraded states degrade the block, not the message: PARTIAL renders `语义解析暂不可用`, UNAVAILABLE renders `暂不可用`. The model's `summary`/`conflicts` prose is never shown.

---

## 25. Bias Change Detection

`BIAS_CHANGE_NOTIFICATION_ENABLED = false`.

There is **no** change detector and **no** bias-change notification. `observe()` emits a structured log record (`4H_BIAS_CREATED …`) per new closed candle; that is the only per-candle output. Consequently:

- a transition such as NEUTRAL → BEARISH produces a log line, not a DingTalk message;
- the bias cannot spam per 4H candle, because it never sends anything on its own;
- deduplication of bias messages is not applicable.

---

## 26. Time Semantics

| timestamp | meaning | source |
|---|---|---|
| candle `openTime` / `closeTime` | native futures 4H boundaries | Binance |
| data-selection `evaluationTime` | wall clock passed to `refresh(Date.now())` | `scripts/live.js:976` |
| fact evaluation time | `latest.closeTime` of the newest fully closed candle | `live/4hBiasV3.js:159` |
| `bias.closedAt` | that candle's `closeTime` — the causal identity of the decision | `snapshot()` |
| `bias.generatedAt` | wall clock when the snapshot object was created | `now()` |
| `decision.createdAt` | wall clock when the decision was frozen | `freeze()` |
| notification time | when the DingTalk message is built; the bias block reflects `getCurrent()` at that moment | `scripts/live.js:566, 612` |
| pivot/structural `confirmedAt` | closeTime of the confirming candle | `auditPivots`, `auditStructuralProvenance` |
| console rendering | UTC+8 via `fmt()` | `scripts/live.js:105-108` |

The causal time (`closedAt`) and the display time are distinct and both are present on the snapshot. The audit found no place where a notification presents `generatedAt` as if it were the decision time, and the gate compares `closedAt` against the freshly computed `expected4hClosedAt` so a stale bias cannot pass.

---

## 27. Restart / Persistence

| item | behaviour |
|---|---|
| bias recomputed on restart | yes (facts are rebuilt deterministically) |
| DeepSeek recalled on restart | **no** — the durable store returns the frozen record |
| decision store restored | yes, from `<dataDir>/4h-bias-decisions-v1/<decisionKey>.json` |
| last processed closed 4H closeTime | **in-memory only** (`lastProcessedClosed4hCloseTime`), so it is lost on restart |
| duplicate change notification | not applicable (no change notification exists) |
| duplicate log line | possible: a restart before the next 4H close will log `4H_BIAS_CREATED` again for the same candle |
| duplicate event notification | governed by the existing EQ/FVG outbox and Range outbox persistence, not by the bias |

---

## 28. Determinism

- **FACT_DETERMINISM:** byte-identical. Every fact is a pure function of the closed 4H series; there is no randomness, no clock read inside the fact layer, and the semantic input is canonicalised with sorted keys. Test 14 (prefix invariance at twenty cutoffs) is the strongest evidence.
- **SEMANTIC_DECISION_DETERMINISM:** the LLM is non-deterministic in principle, but the architecture removes the variability from the production decision surface: the decision is frozen once per `(facts, prompt, model)` key and thereafter reused, and concurrent same-key refreshes collapse to a single call. Temperature 0 and thinking disabled reduce the variance of the one call that does happen.

The practical result: production decisions are stable and reproducible for a given candle, because the first resolved decision becomes the only decision for that key.

---

## 29. Existing Tests

`TEST_FILE_COUNT = 11` files directly or indirectly relevant to the bias path, 209 test cases in the two primary bias files plus 26 entry-gate cases. Full detail in `test-inventory.json`.

Repository suite on this baseline:

```
FULL_TEST_FILES      143
FULL_TEST_FAILURES   1
FULL_TEST_EXIT_CODE  1
```

The single failure is `test/rangeObjectV1.test.js`, which requires the untracked artifact `artifacts/research/luxalgo-length24-oos-v1/dataset.json` that does not exist in a clean worktree. It is unrelated to the 4H bias and is a repository hygiene defect, not a bias defect.

---

## 30. Legacy / Unused Bias Code

`ACTIVE_BIAS_IMPLEMENTATION_COUNT = 1`, `LEGACY_BIAS_IMPLEMENTATION_COUNT = 9`.

Full classification in `legacy-bias-inventory.json`. The two most important:

1. **`bias/biasEngine.js` (+ scorer/explanation/conflict/delivery/liquidity/location/structure)** — a 5m draw/liquidity/location/delivery bias. It is **still executed** on the live path because `live/liveEngine.js:102` calls `replay/replayEngine.rebuildSnapshot`, which requires it at line 34 and runs it at line 103. Nothing in the 4H bias system reads its result. This is the single largest source of "which bias are we actually using?" confusion.
2. **`ai/ictBiasPrompt.js`** — the raw-OHLC research prompt (BULLISH/BEARISH/UNCLEAR) reachable only from offline audit scripts. It must not be mistaken for the production prompt.

Also noted: the pre-audit worktree cleanup removed several *untracked* V1/V2 directional-context variants. None were reachable from `scripts/live.js`, and the production V3 path is fully tracked at HEAD.

---

## 31. Security / Secret Handling

| item | value |
|---|---|
| DeepSeek secret env var | `DEEPSEEK_API_KEY` |
| read location | `ai/deepseekClient.js` `getApiKey()` (throws `MISSING_API_KEY` if absent) |
| printed anywhere? | no — the client explicitly documents "绝不硬编码 / 打印 / 落盘" |
| `.env` present in checkout | yes, and gitignored |
| `config/live.local.json` present | no (gitignored, used for DingTalk webhook/secret override) |
| DingTalk secret env vars | `DINGTALK_WEBHOOK`, `DINGTALK_SECRET` |
| secrets printed by this audit | none |

---

## 32. LLM Call / Cost Behavior

- A call can occur **at most once per symbol per newly closed 4H candle** (i.e. every 4 hours per symbol), and only on a store MISS.
- On a HIT the call count is **zero**, including after a restart.
- Concurrent same-key refreshes collapse to a single call.
- Each symbol has an independent service, store lookup and in-flight map.
- Current symbol scope: dynamic universe with `topN = 10` plus lifecycle-retained symbols.
- Practical steady-state cost: ~6 calls per symbol per day, and in practice far fewer once the store is warm, because re-evaluating the same closed candle is free.
- This audit made **0** LLM calls and **0** network requests.

---

## 33. Fit to Original User Goal

The original goal was: *before the human makes a subjective judgement, independently output BULLISH / BEARISH / NO_PRIORITY so the user can decide whether to look for a LONG narrative, a SHORT narrative, or nothing in particular.*

**ARCHITECTURAL_FIT = YES.**

Evidence:

- the output vocabulary is exactly `BULLISH | BEARISH | NO_PRIORITY` — no extra translation layer is required;
- the input is deterministic pre-existing 4H context only, so the output is genuinely *independent* of the user's narrative;
- the architecture is explicitly forbidden from predicting price, so it composes with — rather than competes with — a later subjective read;
- `NO_PRIORITY` is a first-class outcome and the prompt forbids manufacturing a direction to avoid it;
- the decision is stable for a given candle (frozen store), so the tool does not flip its answer between two reads of the same candle;
- it already runs unattended on a 4-hour boundary cadence with no manual input.

Two caveats belong to the same answer. First, `strength` and `confidence` are model judgements rather than measured quantities, so they should be read as part of the semantic summary, not as calibrated probabilities. Second, the current gate demands `STRONG + HIGH` before an order can even be planned, which is a much stricter use of the output than "which direction should I look at"; the original goal is comfortably inside what this system already produces.

---

## 34. Accidental Coupling

`ACCIDENTAL_COUPLING_COUNT = 4`. Detail in `consumer-coupling-map.json`.

| id | coupling | severity |
|---|---|---|
| AC_1 | the shared HTF increment gates the whole 5m tick, so a 1h/1d fetch failure pauses bias-irrelevant work | HIGH |
| AC_2 | the bias service reads candles through the live runner's `runnerData` closure | MEDIUM |
| AC_3 | the decision store directory is derived from the live `CONFIG.dataDir` | LOW |
| AC_4 | the legacy `biasEngine` runs inside every live snapshot rebuild although nothing reads it | MEDIUM |

---

## 35. Minimal Standalone 4H Bias V1 Plan

Design only — not implemented. Full plan in `standalone-v1-plan.json`.

Target: `node scripts/4h-bias.js BTCUSDT` printing symbol, asOf, direction, strength, confidence, deterministic evidence, semantic reason, data status and model/store status.

Planned flow: futures 4H klines (limit 122) → closed-candle gate → deterministic facts → canonical facts → decision store lookup → DeepSeek only on MISS → bias snapshot → console (optionally the existing DingTalk block).

Minimum module set: **17 modules**, all already present and frozen. New code required: a thin CLI, a 4h-only fetch helper, and console formatting.

Explicitly not required: liquidity, EQ/FVG, 5m pipeline, entry, execution, `runnerData`, `liveEngine`, scenario/draw stack, dynamic universe, DingTalk.

---

## 36. What Must Not Change Yet

- the six facts and their formulas (including the frozen Wilder DMI/ADX and the Theil-Sen SciPy parity);
- the 120-bar history contract and the closed-candle gates;
- the prompt text, prompt hash, model constant and output schema;
- the decision key composition (facts hash + prompt hash + prompt version + model id + candle);
- the store's create-if-absent immutability and corruption policy;
- the `STRONG + HIGH + aligned` entry gate, until it is deliberately revisited as a product decision;
- the separation between deterministic facts and semantic prose in the notification.

---

## 37. Findings / Risks

| # | severity | finding |
|---|---|---|
| F1 | HIGH | `AC_1`: the shared HTF fetch gates the 5m tick, so a 1h/1d outage pauses the pipeline even though the bias only needs 4h. Bias *semantic* failure is isolated; bias *data* failure is not. |
| F2 | MEDIUM | `AC_4`: the legacy `bias/biasEngine.js` is still executed on the live snapshot cadence with no consumer. This is the main reason the repository's "which bias is production?" question keeps re-appearing. |
| F3 | MEDIUM | `AC_2`: the bias service cannot be reused outside the runner without reproducing or stubbing `runnerData.structureCandles`. |
| F4 | MEDIUM | No bias-change notification exists. A NEUTRAL → BEARISH transition is only visible in logs; whether that is desirable is a product decision, but today the capability is absent rather than disabled. |
| F5 | LOW | `lastProcessedClosed4hCloseTime` is in-memory only, so a restart re-logs `4H_BIAS_CREATED` for the same candle (log noise, no functional impact). |
| F6 | LOW | `config/live.json` ships a placeholder DingTalk webhook; production requires `config/live.local.json` or env overrides. Not a bias issue, but it is the credential path an operator must know. |
| F7 | LOW | Repository hygiene: `test/rangeObjectV1.test.js` depends on an untracked artifact, so the suite is red on a clean worktree. |
| F8 | INFO | The strength/confidence fields are model judgements without a calibration layer; they are semantically useful but not probabilities. |
| F9 | INFO | `strength` must be STRONG *and* `confidence` HIGH for the order gate. That is a much narrower use than the original "which direction should I prioritise" goal, and it means the bias currently gates trades far more than it guides attention. |
| F10 | INFO | The bias consumes 120 bars only because of the structural fact; five of six facts need 48 bars or fewer. Useful when planning a cheaper standalone refresh. |

---

## 38. Final Verdict

**`CURRENT_4H_BIAS_ARCHITECTURE = READY_WITH_DECOUPLING_REQUIRED`**

The production 4H Bias is a coherent, causal, contract-checked semantic compressor over six deterministic 4H facts, with an immutable decision store and a clean failure policy. Its semantics match the original user goal. What it needs before it can become a standalone tool is decoupling from the live runner's data closure and from the shared HTF tick gate — not a redesign of the bias itself.

---

## 39. Recommended Next Step

**`RECOMMENDED_NEXT_STEP = 4H_BIAS_PRODUCTION_DECOUPLING_V1`**

The bias is sound but the host runtime is entangled. The decoupling should: inject the 4H series and evaluation time into the service instead of reading `runnerData`; give the store an explicit path; add a 4h-only fetch helper that does not share `ok` state with the 1h/1d/5m pipeline; and remove the legacy `biasEngine` execution from the live snapshot path (or formally declare it research-only). The standalone CLI then becomes a thin shell over already-frozen modules.

Explicitly **not** recommended here: any liquidity, tape, price-region or auto-trading work, and any change to facts, prompt, thresholds or model.

---

## §48 Required Questions

**Q1. Which 4H Bias implementation does production actually use?**
`4H_BIAS_V3` — `live/4hBiasV3.js` plus `bias/directionalContext/4hBiasFactsV3.js`, `bias/4hBiasSemanticV3.js`, `bias/4hBiasDecisionStoreV1.js`, `notify/4hBiasContext.js`. Created at `scripts/live.js:317-331`.

**Q2. What are the real input facts?**
Exactly six: `normalizedDirectionalSpread`, `adx14`, `signedMoveAtr24`, `signedEfficiency24`, `theilSenSlope48`, `structureDirection`.

**Q3. Formula and lookback of each fact?**
See §7 and `deterministic-facts.json`: 15+/27+/24/24/48/120 bars respectively.

**Q4. Are they all causal?**
Yes. `FACT_CAUSALITY_VIOLATION_COUNT = 0`; see `fact-causality-audit.json`.

**Q5. Does it read an unfinished 4H candle?**
No — three independent closed-candle filters plus a dedicated test.

**Q6. Is the real history 120 bars?**
Yes for the binding structure fact; the HTTP request is 122 (120 + 2 technical allowance) and five of six facts need 48 bars or fewer.

**Q7. Does DeepSeek see raw Klines or deterministic facts?**
Deterministic facts only. `RAW_4H_CANDLES_SENT_TO_LLM = false`.

**Q8. Is DeepSeek a predictor or a semantic synthesizer?**
A semantic synthesizer (classification B). The prompt forbids prediction and forbids inventing evidence.

**Q9. Can the same facts trigger a repeated DeepSeek call?**
No. A frozen decision key plus an immutable store and an in-flight map guarantee one call per `(facts, prompt, model)`.

**Q10. How does the decision store guarantee stability?**
Canonical fact hashing, atomic create-if-absent writes, full identity re-validation on read, and fail-closed corruption handling.

**Q11. What are the real output labels?**
`direction: BULLISH | BEARISH | NO_PRIORITY`; `strength: STRONG | MODERATE | WEAK`; `confidence: HIGH | MEDIUM | LOW`; plus `summary` and `conflicts` prose that never enters the store or the notification.

**Q12. What does the bias semantically mean?**
A current-state directional **trade-priority / narrative-focus** classification derived from current directional-process evidence — not a next-bar prediction, not a probability, and not a regime label.

**Q13. Does a 4H failure block the 5m pipeline?**
The bias semantic failure does **not**. The shared 4H/HTF *data* fetch failure does, via `if (!htf.ok) return;` at `scripts/live.js:1008`.

**Q14. Is the bias reporting, WATCH gate, Entry gate, or several?**
Reporting context for notifications (2 messages), and a hard Entry/real-order gate. It is not a WATCH gate and not a 5m pipeline gate.

**Q15. Are real orders controlled by the bias gate?**
Yes. `realOrderExecutionV1` only plans an order when `buildEntryPlan` passes, and `buildEntryPlan` calls `biasGate` at line 180; a failure produces `NO_TRADE` and no exchange call.

**Q16. What does DingTalk currently show?**
The `📊 4H Bias` block: semantic direction with an icon, strength, confidence, and the six deterministic facts. No model prose, no prices, no action.

**Q17. Will a restart repeat a notification?**
The bias itself never sends a notification, so it cannot repeat one. Event notifications use their own persisted outbox/delivered state.

**Q18. How many legacy bias implementations are in the repo?**
Nine legacy/unreferenced/research variants against one active production implementation; the most consequential is `bias/biasEngine.js`, which still executes on the live snapshot cadence.

**Q19. Does the architecture fit the original goal of countering a default long bias?**
Yes. `ARCHITECTURAL_FIT = YES`; see §33. The output vocabulary, independence from the user's narrative and first-class `NO_PRIORITY` are all already in place.

**Q20. What is the minimum module set for a standalone bias?**
17 modules, all already present and frozen; see `standalone-v1-plan.json`. No new facts, prompt, model or threshold are required.
