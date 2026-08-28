# ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1

Status: **READY_FOR_FREEZE — NOT FROZEN**

## ACCUMULATION_DEFINITION

Accumulation is a formation in which price establishes a recognizable, relatively independent balance and sustains a coherent two-sided auction within that balance. Directional movement may occur inside the formation, but it must remain subordinate to—or be reabsorbed into—the continuing balance narrative rather than dominate it through persistent one-sided acceptance or value migration.

The existence of a bounding box, compression, stable center, or temporary pause is not sufficient by itself.

## CLEAR_A_DEFINITION

**CLEAR_A** requires both:

1. A clearly identifiable independent balance belonging to the formation itself.
2. A coherent two-sided auction: upper and lower regions receive meaningful participation, with returns, rebalancing, or re-acceptance that preserve one auction identity.

Temporary center shifts, directional candles, irregular paths, asymmetry, and substantial excursions are allowed when they do not dominate the formation and the balance identity remains intact. Reabsorption is strong quality evidence when an excursion exists, but an excursion is not required.

## BORDERLINE_A_DEFINITION

**BORDERLINE_A** requires genuine accumulation evidence, not mere uncertainty. A real balance and two-sided auction are present, but at least one core semantic is partial, late-forming, insufficiently persistent, or still materially mixed with the preceding directional delivery.

Typical boundary conditions include:

- independent balance emerging mainly in the latter part of formation;
- meaningful but incomplete two-sided participation;
- mild one-sided residence;
- temporary migration with only partial reabsorption;
- multiple or expanding micro-balances whose shared identity remains plausible but not fully coherent.

CAL-03, CAL-06, and CAL-08 calibrate this category: each contains positive accumulation evidence, while independence and auction coherence remain partial.

## NO_A_DEFINITION

**NO_A** applies when a box, compression, or consolidation does not establish a sufficiently independent and coherent accumulation auction. Typical narratives include a trend pause, directional consolidation, sustained one-sided residence, persistent value migration, or irregular chop whose boundaries are defined mainly by extremes rather than repeated auction use.

Local back-and-forth, a narrow range, or a stable center cannot compensate for the absence of an independent balance and coherent two-sided auction.

## UNSURE_POLICY

**UNSURE** is a calibration/review state, not a Ground Truth V2 class. Use it only when the available formation-only view and this definition do not support a stable judgement. An UNSURE case must be held for definition review; it must not be silently converted into BORDERLINE_A.

## SEMANTIC_ROLES

- INDEPENDENT_BALANCE_ROLE = REQUIRED_CORE_SEMANTIC
- TWO_SIDED_AUCTION_ROLE = REQUIRED_CORE_SEMANTIC
- PREVIOUS_TREND_SEPARATION_ROLE = CONTEXTUAL
- ONE_SIDED_RESIDENCE_ROLE = STRONG_NEGATIVE_EVIDENCE
- PERSISTENT_VALUE_MIGRATION_ROLE = STRONG_NEGATIVE_EVIDENCE
- REABSORPTION_ROLE = QUALITY_CONTEXT

## POSITIVE_EVIDENCE

- Formation-specific auction identity distinguishable from simple directional pause.
- Meaningful use of upper and lower regions within one continuing balance.
- Returns through the interior, rebalancing, and re-acceptance.
- Temporary displacement or center shift that is subsequently absorbed without destroying the auction identity.
- Repeated use of the range even when geometry is irregular or asymmetric.

## NEGATIVE_EVIDENCE

- Sustained one-sided residence with little meaningful participation on the opposite side.
- Persistent directional value migration dominating the formation.
- Formation remaining inseparable from the preceding directional delivery.
- Compression or stable center caused mainly by a high/low-level trend pause.
- Irregular movement without a coherent shared auction identity.

Negative evidence is interpreted in context. No single item substitutes for judging the two core semantics.

## NON_REQUIREMENTS

- EQH/EQL REQUIRED = false
- PERFECT_RECTANGLE REQUIRED = false
- SYMMETRIC_TOUCHES REQUIRED = false
- FIXED_BAR_COUNT REQUIRED = false
- FIXED_DURATION REQUIRED = false
- STABLE_MIDPOINT REQUIRED = false
- ZERO_DISPLACEMENT_CANDLES REQUIRED = false
- SESSION_BOUNDARY REQUIRED = false
- FUTURE_REACTION REQUIRED = false
- MSS REQUIRED = false
- FVG REQUIRED = false

## TEMPORAL_AND_RESEARCH_BOUNDARY

Judgement uses formation-only information through formation confirmation. Future reaction and later structural events must not define formation identity. This document is a human semantic definition, not a detector specification; it introduces no numerical threshold, feature, score, or production behavior.
