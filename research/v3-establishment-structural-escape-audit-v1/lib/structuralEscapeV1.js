'use strict';

/**
 * V3_ESTABLISHMENT_STRUCTURAL_ESCAPE_AUDIT_V1 -- the ONE new context concept of this
 * audit: the PRECEDING STRUCTURAL ENVELOPE, plus the purely descriptive escape facts
 * derived from it.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It has no threshold, no score, no classifier, no gate, and no verdict. Every number
 * it produces is a signed, ATR-normalized description of where the current candidate
 * structural band sits relative to the last confirmed swing band that preceded it.
 * Nothing here decides whether a Trend was born.
 *
 * PURE. No I/O, no clock, no network, no LLM. Every function takes its inputs as
 * arguments so that a future-poisoned or prefix-truncated call is a pure re-derivation.
 */

/**
 * Identity of a pivot for "is this one of the 4 candidate pivots" comparison. The
 * detector never emits the same (type, occurredAt) twice, so this key is exact; we
 * keep price in it anyway so a corrupt duplicate could never silently match.
 */
function pivotKey(pivot) {
    return pivot.type + '@' + pivot.occurredAt + '@' + pivot.price;
}

/** §6 -- candidate start is a STRUCTURE event, not a time offset. */
function candidateStart(candidatePivots) {
    if (!candidatePivots || candidatePivots.length !== 4) {
        throw new Error('CANDIDATE_PIVOT_COUNT_NOT_4 ' + (candidatePivots ? candidatePivots.length : 'null'));
    }
    var occurredAt = null;
    var confirmedAtMin = null;
    var confirmedAtMax = null;
    candidatePivots.forEach(function (pivot) {
        if (occurredAt === null || pivot.occurredAt < occurredAt) occurredAt = pivot.occurredAt;
        if (confirmedAtMin === null || pivot.confirmedAt < confirmedAtMin) confirmedAtMin = pivot.confirmedAt;
        if (confirmedAtMax === null || pivot.confirmedAt > confirmedAtMax) confirmedAtMax = pivot.confirmedAt;
    });
    return { occurredAt: occurredAt, confirmedAtMin: confirmedAtMin, confirmedAtMax: confirmedAtMax };
}

function latestOfType(pivots, type) {
    var best = null;
    pivots.forEach(function (pivot) {
        if (pivot.type !== type) return;
        if (
            best === null ||
            pivot.occurredAt > best.occurredAt ||
            (pivot.occurredAt === best.occurredAt && pivot.confirmedAt > best.confirmedAt)
        ) {
            best = pivot;
        }
    });
    return best;
}

/**
 * §7 -- the preceding structural envelope.
 *
 * Universe = every causal 2L/2R swing already CONFIRMED at `evaluationTime`
 * (`confirmedAt <= evaluationTime`), minus the 4 candidate pivots. From that
 * universe take the latest-occurring HIGH and the latest-occurring LOW whose
 * occurredAt strictly precedes the candidate start.
 *
 * No fixed lookback. No "the closest swing within 24 bars". If a candidate start sits
 * before the first confirmed swing of one side inside the snapshot, the case is
 * CONTEXT_UNAVAILABLE -- we do not stretch the horizon to rescue it.
 *
 * Note the two clocks: the envelope requires the pivot to have strictly PRECEDED the
 * candidate structurally (occurredAt) AND to have been knowable at the decision
 * (confirmedAt <= evaluationTime). §13 keeps the "was it also confirmed before the
 * candidate started" flag, but only as forensics -- it is NOT a filter.
 */
function precedingEnvelope(allPivots, candidatePivots, startOccurredAt, evaluationTime) {
    var candidateKeys = {};
    candidatePivots.forEach(function (pivot) { candidateKeys[pivotKey(pivot)] = true; });

    var universe = allPivots.filter(function (pivot) {
        return pivot.confirmedAt <= evaluationTime && !candidateKeys[pivotKey(pivot)];
    });
    var eligible = universe.filter(function (pivot) {
        return pivot.occurredAt < startOccurredAt;
    });

    var contextHigh = latestOfType(eligible, 'HIGH');
    var contextLow = latestOfType(eligible, 'LOW');

    var excludedFutureConfirmation = allPivots.filter(function (pivot) {
        return pivot.occurredAt < startOccurredAt && pivot.confirmedAt > evaluationTime;
    }).length;

    return {
        status: contextHigh && contextLow ? 'OK' : 'CONTEXT_UNAVAILABLE',
        universeCount: universe.length,
        eligibleCount: eligible.length,
        excludedFutureConfirmationCount: excludedFutureConfirmation,
        contextHigh: contextHigh,
        contextLow: contextLow
    };
}

function directionSign(direction) {
    if (direction === 'BULLISH') return 1;
    if (direction === 'BEARISH') return -1;
    throw new Error('UNKNOWN_DIRECTION ' + direction);
}

/**
 * §11 / §12 / §13 -- the descriptive escape facts for one establishment case.
 *
 * `caseInput` = {
 *   transitionId, evaluationTime, direction, humanLabel,
 *   atr14, currentClose, previousHigh, currentHigh, previousLow, currentLow,
 *   candidatePivots, allPivots
 * }
 */
function escapeFacts(caseInput) {
    var evaluationTime = caseInput.evaluationTime;
    var direction = caseInput.direction;
    var sign = directionSign(direction);
    var atr14 = caseInput.atr14;

    if (!(atr14 > 0)) throw new Error('ATR14_NOT_POSITIVE ' + caseInput.transitionId);

    caseInput.candidatePivots.forEach(function (pivot) {
        if (pivot.confirmedAt > evaluationTime) {
            throw new Error('FUTURE_CANDIDATE_PIVOT ' + caseInput.transitionId);
        }
    });

    var start = candidateStart(caseInput.candidatePivots);
    var envelope = precedingEnvelope(
        caseInput.allPivots,
        caseInput.candidatePivots,
        start.occurredAt,
        evaluationTime
    );
    if (envelope.status !== 'OK') {
        return {
            transitionId: caseInput.transitionId,
            status: envelope.status,
            candidateStart: start,
            envelope: envelope
        };
    }

    var contextHighPivot = envelope.contextHigh;
    var contextLowPivot = envelope.contextLow;

    // §13 -- recorded, never used to drop the case.
    var highConfirmedBeforeCandidateStart = contextHighPivot.confirmedAt < start.occurredAt;
    var lowConfirmedBeforeCandidateStart = contextLowPivot.confirmedAt < start.occurredAt;

    var contextEnvelopeHigh = contextHighPivot.price;
    var contextEnvelopeLow = contextLowPivot.price;
    if (!(contextEnvelopeHigh > contextEnvelopeLow)) {
        throw new Error('CONTEXT_ENVELOPE_INVERTED ' + caseInput.transitionId);
    }

    // §9 -- the current band is the latest directional two-high / two-low pair, NOT the
    // max/min of all 4 candidate pivots.
    var candidateEnvelopeHigh = caseInput.currentHigh.price;
    var candidateEnvelopeLow = caseInput.currentLow.price;
    if (!(candidateEnvelopeHigh > candidateEnvelopeLow)) {
        throw new Error('CANDIDATE_ENVELOPE_INVERTED ' + caseInput.transitionId);
    }

    var contextRange = contextEnvelopeHigh - contextEnvelopeLow;
    var contextMid = (contextEnvelopeHigh + contextEnvelopeLow) / 2;
    var candidateRange = candidateEnvelopeHigh - candidateEnvelopeLow;
    var candidateMid = (candidateEnvelopeHigh + candidateEnvelopeLow) / 2;

    var signedHighBoundaryShiftAtr = (sign * (candidateEnvelopeHigh - contextEnvelopeHigh)) / atr14;
    var signedLowBoundaryShiftAtr = (sign * (candidateEnvelopeLow - contextEnvelopeLow)) / atr14;
    var signedMidpointShiftAtr = (sign * (candidateMid - contextMid)) / atr14;

    var intersectionLength = Math.max(
        0,
        Math.min(contextEnvelopeHigh, candidateEnvelopeHigh) - Math.max(contextEnvelopeLow, candidateEnvelopeLow)
    );
    var unionLength = Math.max(contextEnvelopeHigh, candidateEnvelopeHigh) -
        Math.min(contextEnvelopeLow, candidateEnvelopeLow);
    if (!(unionLength > 0)) throw new Error('ENVELOPE_UNION_NOT_POSITIVE ' + caseInput.transitionId);
    var envelopeOverlapIoU = intersectionLength / unionLength;

    var closeEscapeAtr = direction === 'BULLISH'
        ? (caseInput.currentClose - contextEnvelopeHigh) / atr14
        : (contextEnvelopeLow - caseInput.currentClose) / atr14;
    var extremeEscapeAtr = direction === 'BULLISH'
        ? (candidateEnvelopeHigh - contextEnvelopeHigh) / atr14
        : (contextEnvelopeLow - candidateEnvelopeLow) / atr14;

    return {
        transitionId: caseInput.transitionId,
        status: 'OK',
        evaluationTime: evaluationTime,
        direction: direction,
        humanLabel: caseInput.humanLabel,
        atr14: atr14,
        currentClose: caseInput.currentClose,
        candidateStart: start,
        contextHigh: contextHighPivot,
        contextLow: contextLowPivot,
        contextHighConfirmedBeforeCandidateStartOccurredAt: highConfirmedBeforeCandidateStart,
        contextLowConfirmedBeforeCandidateStartOccurredAt: lowConfirmedBeforeCandidateStart,
        contextEnvelopeHigh: contextEnvelopeHigh,
        contextEnvelopeLow: contextEnvelopeLow,
        contextRange: contextRange,
        contextMid: contextMid,
        previousHigh: caseInput.previousHigh,
        currentHigh: caseInput.currentHigh,
        previousLow: caseInput.previousLow,
        currentLow: caseInput.currentLow,
        candidateEnvelopeHigh: candidateEnvelopeHigh,
        candidateEnvelopeLow: candidateEnvelopeLow,
        candidateRange: candidateRange,
        candidateMid: candidateMid,
        signedHighBoundaryShiftAtr: signedHighBoundaryShiftAtr,
        signedLowBoundaryShiftAtr: signedLowBoundaryShiftAtr,
        signedMidpointShiftAtr: signedMidpointShiftAtr,
        intersectionLength: intersectionLength,
        unionLength: unionLength,
        envelopeOverlapIoU: envelopeOverlapIoU,
        closeEscapeAtr: closeEscapeAtr,
        extremeEscapeAtr: extremeEscapeAtr,
        candidateHighBeyondContextHigh: candidateEnvelopeHigh > contextEnvelopeHigh,
        candidateLowAboveContextLow: candidateEnvelopeLow > contextEnvelopeLow,
        candidateHighBelowContextHigh: candidateEnvelopeHigh < contextEnvelopeHigh,
        candidateLowBeyondContextLow: candidateEnvelopeLow < contextEnvelopeLow,
        closeBeyondContextBoundary: direction === 'BULLISH'
            ? caseInput.currentClose > contextEnvelopeHigh
            : caseInput.currentClose < contextEnvelopeLow
    };
}

var ESCAPE_METRICS = [
    'signedHighBoundaryShiftAtr',
    'signedLowBoundaryShiftAtr',
    'signedMidpointShiftAtr',
    'envelopeOverlapIoU',
    'closeEscapeAtr',
    'extremeEscapeAtr'
];

/** §19 -- min / median / max only. Deliberately the whole of the "statistics" here. */
function describeBucket(cases, metrics) {
    var out = { n: cases.length };
    (metrics || ESCAPE_METRICS).forEach(function (metric) {
        var values = cases
            .filter(function (c) { return c.status === 'OK'; })
            .map(function (c) { return c[metric]; })
            .sort(function (a, b) { return a - b; });
        if (!values.length) {
            out[metric] = { min: null, median: null, max: null };
            return;
        }
        var mid = Math.floor(values.length / 2);
        var median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
        out[metric] = { min: values[0], median: median, max: values[values.length - 1] };
    });
    return out;
}

module.exports = {
    ESCAPE_METRICS: ESCAPE_METRICS,
    pivotKey: pivotKey,
    candidateStart: candidateStart,
    precedingEnvelope: precedingEnvelope,
    directionSign: directionSign,
    escapeFacts: escapeFacts,
    describeBucket: describeBucket
};
