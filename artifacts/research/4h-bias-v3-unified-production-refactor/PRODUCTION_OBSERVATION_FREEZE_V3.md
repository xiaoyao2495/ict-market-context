# Final Architecture

`4H_BIAS_V3` is the authoritative per-symbol 4H Bias runtime for Production observation. It remains context-only and cannot gate EQ, FVG, WATCH, notification eligibility, entry, trade, or position sizing.

The runtime consumes native Binance USD-M Futures 4H candles, selects the latest fully closed candle, builds the deterministic V3 fact set, performs one semantic compression, and publishes one immutable authoritative snapshot. A new build is triggered only by a new fully closed native 4H candle.

# Frozen Fact Set

The semantic input contains only `symbol`, `timeframe`, `closedAt`, and these six facts:

- `normalizedDirectionalSpread`
- `adx14`
- `signedMoveAtr24`
- `signedEfficiency24`
- `theilSenSlope48`
- `structureDirection`

Raw OHLC, recent candle arrays, Delivery6, Delivery12, Kalman, Persistence, Transition, EQ, FVG, WATCH, and future outcomes are excluded.

# Frozen Semantic Contract

- Model: `deepseek-v4-flash`
- Prompt hash: `3a3bd5dcf6454c39ba4f363d9ee7e433cb1827598dba5d241fb94cd959e94c57`
- Direction: `BULLISH | BEARISH | NO_PRIORITY`
- Strength: `STRONG | MODERATE | WEAK`
- Confidence: `HIGH | MEDIUM | LOW`
- Summary: enabled
- Conflicts: enabled
- Temperature: `0`

The prompt, enums, fact set, model, temperature, parser, and semantic rules are frozen for Production observation. They must not be tuned from isolated observations.

# Refresh Lifecycle

`NEW_FULLY_CLOSED_NATIVE_4H` is the sole semantic refresh identity. Per symbol, a new 4H close permits one deterministic build and at most one LLM call. Repeated 5m steps and notification rendering reuse the same immutable snapshot. Same-key in-flight work is deduplicated.

On every newly published snapshot, Production emits one `4H_BIAS_CREATED` structured log record containing:

- `symbol`, `closedAt`, `generatedAt`, `status`
- `direction`, `strength`, `confidence`, `summary`, `conflicts`
- the frozen six-field `facts` object
- `promptHash`, `buildDurationMs`, `llmDurationMs`

No raw candles are logged, and the same snapshot is not logged on every 5m step.

# Notification Integration

The two active Production DingTalk emitters are:

- `scripts/live.js::sendEqFvgNotification`
- `scripts/live.js::sendRangeConfirmation`

Both attach `current4hBias.getCurrent()` at notification time. WATCH-open frozen Bias is not used.

# Failure Semantics

An LLM or network failure produces `PARTIAL`, retains deterministic facts, and does not block notification eligibility. A deterministic data/fact failure produces `UNAVAILABLE` and also does not block notification eligibility. Synchronous client failures are contained inside the asynchronous service boundary.

# Production Role

- Direction: supported and productionized
- Strength: supported, fresh-replicated, and productionized as semantic context
- Persistence: parked
- Transition: parked
- Kalman: excluded
- Bias role: context-only

# Known Limitations

`summary` and `conflicts` may currently be English. This is a presentation observation, not a Production blocker. Language should be reconsidered only if repeated live observation establishes a material need.

# Observation Rules

- No infinite optimization.
- Do not reopen research for a single bad call.
- Do not tune the prompt from anecdotal output.
- Do not chase 100% human agreement.
- Reopen research only for a repeated, interpretable failure mode.
- Do not manufacture Production alerts for observation.

# Test Results

- V3 directed tests: 41/41 passed.
- Production regression: 117/117 test files passed.
- Parked Persistence research audits were not run; sealed Persistence artifacts were not opened.

# Commit

Authorized commit message: `feat: unify 4h bias v3 production context`.

Only V3 productionization code, tests, secret-ignore protection, and this freeze report belong to the commit. No push is authorized.

# Startup Command

From the repository root, after exporting required secrets into the process environment:

```sh
node scripts/live.js
```

PM2 convention:

```sh
pm2 start scripts/live.js --name ict-radar
```

Required environment: `DEEPSEEK_API_KEY`; `DINGTALK_WEBHOOK` unless supplied through the existing ignored `config/live.local.json`. `DINGTALK_SECRET` is required only for signed DingTalk mode. Binance market-data access requires no API credential. Proxy variables are optional and environment-dependent.
