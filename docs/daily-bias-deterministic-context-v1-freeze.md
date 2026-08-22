# AI Daily Bias Baseline V1 — Feature Freeze

Status: **FROZEN**
Freeze date: 2026-08-22

The deterministic 4H context supplied to the Daily Bias audit is frozen at:

- confirmed 2L/2R pivots;
- sweep lifecycle with `INTACT` / `TAKEN` status;
- time-local break facts;
- close-confirmed BOS provenance;
- persisted `ACTIVE_PROTECTED` swings, structural state, and provenance ancestry;
- Structural Provenance V1.1 `STRUCTURAL_MSS` / `STRUCTURAL_CONTINUATION` events;
- hard Draw validation: a non-`NONE` target must resolve to matching `INTACT` liquidity.

Acceptance evidence:

- BTCUSDT 4H 180-day bar-by-bar population audit passes;
- future-leak violations: 0;
- structural-state violations: 0;
- active protected window-drop cases after persistence: 0;
- the eight V1 repeated same-direction MSS events are deterministic structural continuations.

Frozen exclusions—these require a V2 proposal and must not be added during final V1 validation:

- displacement gate for structural provenance;
- protected-swing strength scoring;
- additional swing hierarchy;
- population-driven threshold tuning;
- allowing the model to choose or replace deterministic MSS references.

After this freeze, DeepSeek is an interpretation layer for narrative, current delivery,
dealing range, draw, conflicts, bias, and confidence. Deterministic structural facts remain
code-owned.

Final AI audit protocol is also frozen at:

- `allowedDrawTargets` is derived only from time-local `INTACT` liquidity;
- non-`NONE` Draw targets must exactly match that supplied allow-list;
- the response validator remains authoritative and is never relaxed for model output;
- audit completion limit is 4096 tokens;
- `finish_reason=length` is recorded as `OUTPUT_TRUNCATED` rather than an ICT reasoning failure;
- every Case makes exactly one API request with no automatic retry;
- model, temperature, deterministic facts, and ICT reasoning prompt remain fixed within an audit run.

Human review acceptance:

- all reviewed baseline Cases passed on narrative semantics, not future price outcome;
- bearish structure after its downside draw has been fulfilled may correctly resolve to `UNCLEAR`;
- an SSL raid creates reversal conditions but is not bullish confirmation without Structural MSS,
  displacement, and follow-through;
- the baseline answers which ICT narrative should be awaited, not the direction of the next candle.

Status: **AI_DAILY_BIAS_BASELINE_V1 ACCEPTED AND FROZEN**. Notification/opportunity integration
is delivery work and must not tune this baseline from downstream outcome statistics.
