# RANGE_OBJECT_V1 production integration audit

## Scope

- Production canary: `BTCUSDT` and `ZECUSDT`, completed `5m` candles only.
- Frozen parameters: `length=24`, `mult=1.0`, `atrLength=500`.
- Lifecycle: terminal strict-close breakout.
- Notification: one successful DingTalk delivery per `RANGE_CONFIRMED`; continuation and breakout do not notify.
- Range remains an independent objective fact and does not feed Bias, AMD, Sweep, WATCH, Entry, or Trade.

## Integration

- `range/rangeDetectorV1.js`: incremental Pine-compatible ATR500, 24-close formation, stable identity, active/terminal lifecycle, compact restorable state.
- `live/rangeAlertService.js`: persistent confirmation outbox and delivered-key dedupe.
- `notify/rangeNotificationV1.js`: Chinese Range message with exchange tick-size price formatting.
- `scripts/live.js`: reuses the existing completed-candle loop, historical bootstrap, per-symbol persistence, structured JSONL event log, UTC+8 formatter, and DingTalk sender.
- `config/live.json`: explicit two-symbol canary and frozen settings.

## Persistence and causality

- Confirmation and breakout use the current completed candle's `closeTime`.
- `visualStartAt` is retrospective and is never used as notification time.
- Detector state is atomically persisted per symbol and restored only when its candle cursor matches the retained candle tail; otherwise retained history deterministically rebuilds it.
- Dedupe key: `RANGE_CONFIRMED:RANGE_OBJECT_V1:{symbol}:5m:{confirmedAt}`.
- Successful delivery is stored in `range-notified.json`; retries remain in `range-outbox.json`.
- Confirmed and broken facts are appended to `range-events.jsonl`. Breakouts are logged but never placed in the notification outbox.

## Verification

- BTC frozen OOS replay: `PASS` for every Range's `confirmedAt`, `upper`, `lower`, `breakoutAt`, and `status`.
- ZEC frozen cross-asset replay: `PASS` for the same fields.
- Production tests cover ATR/RMA parity, containment, wick exclusion, causal timing, retrospective start, strict touches and breakouts, one-shot delivery, continuation silence, terminal/new-range behavior, restart restore/dedupe, symbol isolation, warmup readiness, and deterministic replay.
- Full repository suite: `ALL TESTS PASSED` across 122 test files.
- `git diff --check`: clean.

## Safety

- No parameter tuning was performed.
- No research implementation was changed.
- Existing Liquidity, Taken, Displacement, FVG, WATCH, Bias, AMD, and notification behavior remains unchanged.
- No push was performed.
