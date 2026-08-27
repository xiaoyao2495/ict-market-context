'use strict';

var policy = require('./watchNarrativeLiquidityPolicyDesignV1');

var WATCH_BUCKETS = {
    UNRESOLVED: 'UNRESOLVED',
    FROZEN: 'FROZEN',
    MULTIPLE: 'MULTIPLE_STRONG_EVIDENCE',
    SINGLE: 'SINGLE_STRONG_EVIDENCE',
    WEAK: 'WEAK_ONLY_ELIGIBLE_EVIDENCE',
    NONE: 'NO_ELIGIBLE_NARRATIVE_EVIDENCE'
};

function temporalBand(relation, distanceBars, insideCurrentWindow) {
    if (!insideCurrentWindow) return 'BAND_OUTSIDE_CURRENT_WINDOW';
    if (relation === 'INSIDE_LEG') return 'BAND_INSIDE_LEG';
    if (relation !== 'BEFORE_LEG' || !Number.isInteger(distanceBars)) return 'BAND_OUTSIDE_CURRENT_WINDOW';
    if (distanceBars === 1) return 'BAND_BEFORE_1_BAR';
    if (distanceBars === 2) return 'BAND_BEFORE_2_BARS';
    if (distanceBars === 3) return 'BAND_BEFORE_3_BARS';
    if (distanceBars >= 4 && distanceBars <= 6) return 'BAND_BEFORE_4_TO_6_BARS';
    if (distanceBars >= 7 && distanceBars <= 12) return 'BAND_BEFORE_7_TO_12_BARS';
    if (distanceBars >= 13 && distanceBars <= 24) return 'BAND_BEFORE_13_TO_24_BARS';
    if (distanceBars >= 25 && distanceBars <= 48) return 'BAND_BEFORE_25_TO_48_BARS';
    return 'BAND_OUTSIDE_CURRENT_WINDOW';
}

function evaluateCandidate(input) {
    var base = policy.evaluateCandidate(input);
    var band = temporalBand(base.relation, base.barsFromSweepToLegStart, base.temporalEligible);
    var classification;
    if (base.sourceStatus === 'CLASSIFICATION_MISSING' || base.sourceStatus === 'UNRESOLVED') classification = 'UNRESOLVED';
    else if (base.sourceStatus === 'OUT_OF_SCOPE_FROZEN') classification = 'FROZEN';
    else if (base.sourceEligible === false) classification = 'SOURCE_INELIGIBLE';
    else if (!base.directionEligible) classification = 'DIRECTION_INVALID';
    else if (base.reasonCodes.indexOf('SWEEP_CONFIRMED_AFTER_DECISION') >= 0 || base.reasonCodes.indexOf('SWEEP_CONFIRMATION_UNKNOWN') >= 0) classification = 'CONFIRMATION_INVALID';
    else if (base.sourceEligible === true && base.directionEligible && base.temporalEligible && base.legAssociationEligible) classification = 'STRONG_ASSOCIATION_CANDIDATE';
    else if (base.sourceEligible === true && base.directionEligible && base.temporalEligible && /^BAND_BEFORE_(4_TO_6|7_TO_12|13_TO_24|25_TO_48)_BARS$/.test(band)) classification = 'WEAK_ASSOCIATION_CANDIDATE';
    else classification = 'NO_NARRATIVE_ASSOCIATION';
    return Object.assign({}, base, {temporalBand: band, associationClass: classification});
}

function evaluateWatch(input) {
    var evaluations = (input.candidates || []).map(function (entry) {
        return evaluateCandidate({watch: input.watch, candidate: entry.candidate, sweep: entry.sweep, evaluationTime: input.evaluationTime});
    });
    var strong = evaluations.filter(function (row) { return row.associationClass === 'STRONG_ASSOCIATION_CANDIDATE'; });
    var weak = evaluations.filter(function (row) { return row.associationClass === 'WEAK_ASSOCIATION_CANDIDATE'; });
    var frozen = evaluations.filter(function (row) { return row.associationClass === 'FROZEN'; });
    var unresolved = evaluations.filter(function (row) { return row.associationClass === 'UNRESOLVED'; });
    var bucket = unresolved.length ? WATCH_BUCKETS.UNRESOLVED
        : frozen.length ? WATCH_BUCKETS.FROZEN
            : strong.length >= 2 ? WATCH_BUCKETS.MULTIPLE
                : strong.length === 1 ? WATCH_BUCKETS.SINGLE
                    : weak.length ? WATCH_BUCKETS.WEAK : WATCH_BUCKETS.NONE;
    return {
        associationClass: bucket,
        evidenceCount: strong.length,
        ambiguity: strong.length >= 2,
        evaluations: evaluations,
        evidenceCandidates: strong,
        rejectedCandidates: evaluations.filter(function (row) { return row.associationClass !== 'STRONG_ASSOCIATION_CANDIDATE' && row.associationClass !== 'FROZEN' && row.associationClass !== 'UNRESOLVED'; }),
        frozenCandidates: frozen,
        unresolvedCandidates: unresolved,
        weakCandidates: weak,
        reasonCodes: Array.from(new Set(evaluations.reduce(function (all, row) { return all.concat(row.reasonCodes); }, []))).sort()
    };
}

function reuseClass(rows) {
    var byLeg = {};
    (rows || []).forEach(function (row) { byLeg[row.legId] = (byLeg[row.legId] || 0) + 1; });
    var legs = Object.keys(byLeg);
    if (legs.length <= 1) return 'SAME_LEG_REUSE';
    if (legs.some(function (id) { return byLeg[id] > 1; })) return 'MIXED_REUSE';
    return 'CROSS_LEG_REUSE';
}

module.exports = {
    WATCH_BUCKETS: WATCH_BUCKETS,
    temporalBand: temporalBand,
    evaluateCandidate: evaluateCandidate,
    evaluateWatch: evaluateWatch,
    reuseClass: reuseClass
};
