# Blind review instructions

For each chart, answer one question:

> As of the confirmation candle, is this turning point intrinsically
> significant enough to be preserved as a historical market anchor?

Judge the anchor itself, not the current market and not what happened later.

| field | allowed values |
|---|---|
| reviewer_significance | SIGNIFICANT / VALID / WEAK / UNCLEAR |
| reviewer_confidence | HIGH / MEDIUM / LOW |
| reviewer_primaryReason | INDEPENDENT_DIRECTIONAL_TURN / STRONG_REVERSAL_WITH_STRUCTURAL_CHANGE / EFFICIENT_REVERSAL_FROM_EXTREME / STRUCTURALLY_MEANINGFUL_CONTROL_POINT / VALID_LOCAL_TURN_WITH_CLEAR_REVERSAL / LOCAL_REVERSAL_WITH_LIMITED_SIGNIFICANCE / WEAK_OR_CHOPPY_REVERSAL / INCOMING_PROCESS_NOT_DISTINCT / REVERSAL_NOT_INDEPENDENT_ENOUGH / CONFLICTING_EVIDENCE / INSUFFICIENT_PROVENANCE / OTHER |
| reviewer_notes | free text |

Definitions:

- **SIGNIFICANT** — an independent, meaningful directional turn.
- **VALID** — a genuine turn, real but less consequential.
- **WEAK** — a real excursion with no independent directional meaning.
- **UNCLEAR** — the visible evidence does not settle it.

Only `(SIGNIFICANT|VALID) + HIGH` would qualify an anchor in production.
