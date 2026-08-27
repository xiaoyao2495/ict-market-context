'use strict';

var BAR_MS = 300000;
var CURRENT_MAX_LOOKBACK_BARS = 48;
var PROPOSED_STRONG_BEFORE_LEG_BARS = 3;

function sourceDecision(sweep) {
    var metadata = sweep && sweep.narrativeEligibilityV1;
    if (!metadata) return {sourceEligible: null, status: 'CLASSIFICATION_MISSING'};
    return {sourceEligible: metadata.narrativeEligible, status: metadata.status};
}

function expectedSide(direction) {
    if (direction === 'BULLISH') return 'SSL';
    if (direction === 'BEARISH') return 'BSL';
    return null;
}

function relationFromConfirmedAt(sweep, leg) {
    if (!sweep || !leg || typeof sweep.confirmedAt !== 'number' ||
        typeof leg.firstConfirmedAt !== 'number' || typeof leg.lastConfirmedAt !== 'number') return 'UNKNOWN';
    if (sweep.confirmedAt < leg.firstConfirmedAt) return 'BEFORE_LEG';
    if (sweep.confirmedAt <= leg.lastConfirmedAt) return 'INSIDE_LEG';
    return 'AFTER_LEG';
}

function evaluateCandidate(input) {
    var watch = input.watch || {};
    var candidate = input.candidate || {};
    var sweep = input.sweep || null;
    var evaluationTime = input.evaluationTime !== undefined ? input.evaluationTime : watch.updatedAt;
    var leg = watch.displacement || {};
    var source = sourceDecision(sweep);
    var wantSide = expectedSide(watch.direction);
    var directionEligible = !!wantSide && candidate.side === wantSide && (!sweep || sweep.side === wantSide);
    var confirmedKnown = !!sweep && typeof sweep.confirmedAt === 'number';
    var indexKnown = !!sweep && typeof sweep.candleIndex === 'number' &&
        typeof leg.startIndex === 'number' && typeof leg.endIndex === 'number';
    var confirmedByDecision = confirmedKnown && typeof evaluationTime === 'number' && sweep.confirmedAt <= evaluationTime;
    var insideCurrentWindow = indexKnown && sweep.candleIndex >= leg.startIndex - CURRENT_MAX_LOOKBACK_BARS && sweep.candleIndex <= leg.endIndex;
    var temporalEligible = confirmedByDecision && insideCurrentWindow;
    var relation = relationFromConfirmedAt(sweep, leg);
    var barsFromSweepToLegStart = indexKnown ? leg.startIndex - sweep.candleIndex : null;
    var barsFromSweepToDisplacementConfirmation = confirmedKnown && typeof leg.firstConfirmedAt === 'number'
        ? (leg.firstConfirmedAt - sweep.confirmedAt) / BAR_MS : null;
    var barsFromLegStart = indexKnown ? sweep.candleIndex - leg.startIndex : null;
    var adjacentBefore = relation === 'BEFORE_LEG' && barsFromSweepToLegStart >= 1 &&
        barsFromSweepToLegStart <= PROPOSED_STRONG_BEFORE_LEG_BARS;
    var insideLeg = relation === 'INSIDE_LEG' && indexKnown && sweep.candleIndex >= leg.startIndex && sweep.candleIndex <= leg.endIndex;
    var legAssociationEligible = temporalEligible && (adjacentBefore || insideLeg);
    var mssExists = !!(watch.mss && watch.mss.exists);
    var mssDirectionMatched = mssExists && watch.mss.direction === watch.direction;
    var reasons = [];
    if (source.status === 'CLASSIFICATION_MISSING') reasons.push('SOURCE_CLASSIFICATION_MISSING');
    else if (source.status === 'OUT_OF_SCOPE_FROZEN') reasons.push('SOURCE_POLICY_FROZEN');
    else if (source.status === 'UNRESOLVED') reasons.push('SOURCE_UNRESOLVED');
    else if (source.sourceEligible === false) reasons.push('SOURCE_INELIGIBLE');
    if (!directionEligible) reasons.push('DIRECTION_SIDE_MISMATCH');
    if (!confirmedKnown) reasons.push('SWEEP_CONFIRMATION_UNKNOWN');
    else if (!confirmedByDecision) reasons.push('SWEEP_CONFIRMED_AFTER_DECISION');
    if (!indexKnown) reasons.push('LEG_INDEX_RELATION_UNKNOWN');
    else if (!insideCurrentWindow) reasons.push('OUTSIDE_CURRENT_48_BAR_ASSOCIATION_WINDOW');
    else if (!legAssociationEligible) reasons.push('WEAK_OR_STALE_BEFORE_LEG_ASSOCIATION');
    if (!mssExists) reasons.push('MSS_ABSENT_OPTIONAL');
    else if (!mssDirectionMatched) reasons.push('MSS_OPPOSITE_NOT_SUPPORTING');
    else reasons.push('MSS_DIRECTION_MATCHED_SUPPORTING_CONTEXT');

    var narrativeEvidenceEligible = source.sourceEligible === null
        ? null
        : source.sourceEligible === true && directionEligible && temporalEligible && legAssociationEligible;
    return {
        sourceEligible: source.sourceEligible,
        sourceStatus: source.status,
        directionEligible: directionEligible,
        temporalEligible: temporalEligible,
        legAssociationEligible: legAssociationEligible,
        narrativeEvidenceEligible: narrativeEvidenceEligible,
        relation: relation,
        barsFromSweepToLegStart: barsFromSweepToLegStart,
        barsFromSweepToDisplacementConfirmation: barsFromSweepToDisplacementConfirmation,
        barsFromLegStart: barsFromLegStart,
        currentMaxLookbackBars: CURRENT_MAX_LOOKBACK_BARS,
        proposedStrongBeforeLegBars: PROPOSED_STRONG_BEFORE_LEG_BARS,
        mssRequired: false,
        mssExists: mssExists,
        mssDirectionMatched: mssDirectionMatched,
        reasonCodes: reasons
    };
}

function classifyWatchAssociation(evaluations) {
    var eligibleSource = (evaluations || []).filter(function (row) { return row.sourceEligible === true; });
    var strong = eligibleSource.filter(function (row) { return row.narrativeEvidenceEligible === true; });
    var unknown = eligibleSource.filter(function (row) {
        return row.relation === 'UNKNOWN' || row.sourceStatus === 'CLASSIFICATION_MISSING';
    });
    if (unknown.length > 0) return 'ELIGIBLE_SOURCE_ASSOCIATION_AMBIGUOUS';
    if (strong.length > 1) return 'ELIGIBLE_SOURCE_ASSOCIATION_AMBIGUOUS';
    if (strong.length === 1) return 'ELIGIBLE_SOURCE_AND_STRONG_TEMPORAL_ASSOCIATION';
    return 'ELIGIBLE_SOURCE_BUT_WEAK_OR_STALE_ASSOCIATION';
}

function ambiguityBucket(count) {
    if (count === 0) return '0';
    if (count === 1) return '1';
    if (count === 2) return '2';
    return '3_PLUS';
}

function reuseDistribution(reuseBySweep) {
    var counts = Object.keys(reuseBySweep || {}).map(function (id) { return reuseBySweep[id].length; });
    return {
        ONE_WATCH: counts.filter(function (count) { return count === 1; }).length,
        TWO_WATCHES: counts.filter(function (count) { return count === 2; }).length,
        THREE_PLUS_WATCHES: counts.filter(function (count) { return count >= 3; }).length,
        MAX_WATCHES_PER_SWEEP: counts.length ? Math.max.apply(null, counts) : 0
    };
}

module.exports = {
    BAR_MS: BAR_MS,
    CURRENT_MAX_LOOKBACK_BARS: CURRENT_MAX_LOOKBACK_BARS,
    PROPOSED_STRONG_BEFORE_LEG_BARS: PROPOSED_STRONG_BEFORE_LEG_BARS,
    sourceDecision: sourceDecision,
    expectedSide: expectedSide,
    relationFromConfirmedAt: relationFromConfirmedAt,
    evaluateCandidate: evaluateCandidate,
    classifyWatchAssociation: classifyWatchAssociation,
    ambiguityBucket: ambiguityBucket,
    reuseDistribution: reuseDistribution
};
