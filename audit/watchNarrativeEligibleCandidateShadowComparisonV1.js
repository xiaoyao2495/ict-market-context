'use strict';

var BUCKETS = {
    CURRENT_PRIMARY_ELIGIBLE: 'CURRENT_PRIMARY_ELIGIBLE',
    PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS: 'PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS',
    ONLY_INELIGIBLE_SWING_CANDIDATES: 'ONLY_INELIGIBLE_SWING_CANDIDATES',
    FROZEN_SOURCE_PRESENT: 'FROZEN_SOURCE_PRESENT',
    UNRESOLVED_PRESENT: 'UNRESOLVED_PRESENT'
};

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function classificationForCandidate(candidate, sweepById) {
    var event = candidate && candidate.id ? sweepById[candidate.id] : null;
    var metadata = event && event.narrativeEligibilityV1;
    if (!metadata) {
        return {
            status: 'CLASSIFICATION_MISSING',
            narrativeEligible: null,
            sourceClass: null,
            reason: event ? 'SWEEP_METADATA_MISSING' : 'ASSOCIATED_SWEEP_NOT_FOUND'
        };
    }
    return {
        status: metadata.status,
        narrativeEligible: metadata.narrativeEligible,
        sourceClass: metadata.sourceClass,
        reason: metadata.reason || null
    };
}

function enrichedCandidate(candidate, sweepById) {
    return {
        sweepId: candidate && candidate.id || null,
        sourceId: candidate && candidate.sourceId || null,
        sourceType: candidate && candidate.sourceType || 'UNKNOWN',
        side: candidate && candidate.side || null,
        confirmedAt: candidate && candidate.confirmedAt,
        candleIndex: candidate && candidate.candleIndex,
        relation: candidate && candidate.relation || null,
        barsBeforeLegStart: candidate && candidate.barsBeforeLegStart,
        classification: classificationForCandidate(candidate, sweepById)
    };
}

function nearestByProductionHeuristic(candidates) {
    var best = null;
    var bestDistance = Infinity;
    var bestConfirmedAt = -Infinity;
    candidates.forEach(function (candidate) {
        var distance = typeof candidate.barsBeforeLegStart === 'number'
            ? Math.abs(candidate.barsBeforeLegStart) : Infinity;
        var confirmedAt = typeof candidate.confirmedAt === 'number'
            ? candidate.confirmedAt : -Infinity;
        if (distance < bestDistance || (distance === bestDistance && confirmedAt > bestConfirmedAt)) {
            best = candidate;
            bestDistance = distance;
            bestConfirmedAt = confirmedAt;
        }
    });
    return best;
}

function classifyWatch(watch, sweepById) {
    var rawCandidates = watch && watch.liquidityTaken && watch.liquidityTaken.allCandidates || [];
    var currentPrimary = watch && watch.liquidityTaken && watch.liquidityTaken.primary || null;
    var candidates = rawCandidates.map(function (candidate) { return enrichedCandidate(candidate, sweepById); });
    var primary = enrichedCandidate(currentPrimary, sweepById);
    var primaryInCandidates = !!currentPrimary && rawCandidates.some(function (candidate) {
        return candidate.id === currentPrimary.id;
    });
    var relevant = candidates.slice();
    if (!primaryInCandidates) relevant.push(primary);
    var unresolved = relevant.some(function (candidate) {
        return candidate.classification.status === 'UNRESOLVED' ||
            candidate.classification.status === 'CLASSIFICATION_MISSING';
    });
    var frozen = relevant.some(function (candidate) {
        return candidate.classification.status === 'OUT_OF_SCOPE_FROZEN';
    });
    var eligible = candidates.filter(function (candidate) {
        return candidate.classification.narrativeEligible === true;
    });
    var ineligible = candidates.filter(function (candidate) {
        return candidate.classification.narrativeEligible === false;
    });
    var alternatives = eligible.filter(function (candidate) {
        return !currentPrimary || candidate.sweepId !== currentPrimary.id;
    });
    var bucket;
    if (unresolved) {
        bucket = BUCKETS.UNRESOLVED_PRESENT;
    } else if (frozen) {
        bucket = BUCKETS.FROZEN_SOURCE_PRESENT;
    } else if (primary.classification.narrativeEligible === true) {
        bucket = BUCKETS.CURRENT_PRIMARY_ELIGIBLE;
    } else if (primary.classification.narrativeEligible === false && alternatives.length > 0) {
        bucket = BUCKETS.PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS;
    } else {
        bucket = BUCKETS.ONLY_INELIGIBLE_SWING_CANDIDATES;
    }
    var nearest = nearestByProductionHeuristic(alternatives);
    return {
        watchId: watch && watch.id || null,
        direction: watch && watch.direction || null,
        watchDirection: watch && watch.watchDirection || null,
        createdAt: watch && watch.createdAt,
        updatedAt: watch && watch.updatedAt,
        bucket: bucket,
        currentPrimarySweepId: currentPrimary && currentPrimary.id || null,
        currentPrimarySourceId: currentPrimary && currentPrimary.sourceId || null,
        currentPrimarySourceType: currentPrimary && currentPrimary.sourceType || 'UNKNOWN',
        currentPrimaryClassification: primary.classification,
        candidateOrder: rawCandidates.map(function (candidate) { return candidate.id; }),
        candidateCount: candidates.length,
        candidates: candidates,
        eligibleCandidateCount: eligible.length,
        ineligibleCandidateCount: ineligible.length,
        frozenCandidateCount: candidates.filter(function (candidate) { return candidate.classification.status === 'OUT_OF_SCOPE_FROZEN'; }).length,
        unresolvedCandidateCount: candidates.filter(function (candidate) { return candidate.classification.status === 'UNRESOLVED'; }).length,
        classificationMissingCount: candidates.filter(function (candidate) { return candidate.classification.status === 'CLASSIFICATION_MISSING'; }).length,
        eligibleAlternativeCount: alternatives.length,
        eligibleAlternativeSourceTypes: alternatives.map(function (candidate) { return candidate.sourceType; }),
        eligibleAlternativeSweepIds: alternatives.map(function (candidate) { return candidate.sweepId; }),
        nearestEligibleAlternative: nearest ? {
            auditOnly: true,
            sweepId: nearest.sweepId,
            sourceId: nearest.sourceId,
            sourceType: nearest.sourceType,
            barsBeforeLegStart: nearest.barsBeforeLegStart,
            confirmedAt: nearest.confirmedAt,
            selectionSemantic: 'CURRENT_PRODUCTION_PICK_IMMEDIATE_DISTANCE_THEN_RECENCY'
        } : null
    };
}

function percentile(values, p) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function distribution(values) {
    if (!values.length) return {min: null, p25: null, median: null, p75: null, p90: null, max: null};
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return {
        min: sorted[0],
        p25: percentile(sorted, 0.25),
        median: percentile(sorted, 0.5),
        p75: percentile(sorted, 0.75),
        p90: percentile(sorted, 0.9),
        max: sorted[sorted.length - 1]
    };
}

function countBy(rows, keyFn) {
    var out = {};
    rows.forEach(function (row) {
        var key = String(keyFn(row));
        out[key] = (out[key] || 0) + 1;
    });
    return out;
}

function analyze(watches, sweeps) {
    var sweepById = {};
    (sweeps || []).forEach(function (event) { sweepById[event.id] = event; });
    var before = clone(watches || []);
    var rows = (watches || []).map(function (watch) { return classifyWatch(watch, sweepById); });
    var after = clone(watches || []);
    var bucketCounts = countBy(rows, function (row) { return row.bucket; });
    var allCandidates = [];
    rows.forEach(function (row) { Array.prototype.push.apply(allCandidates, row.candidates); });
    var primaryRows = rows.map(function (row) {
        return {
            watchId: row.watchId,
            sourceType: row.currentPrimarySourceType,
            classification: row.currentPrimaryClassification
        };
    });
    var bucketB = rows.filter(function (row) {
        return row.bucket === BUCKETS.PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS;
    });
    var bucketC = rows.filter(function (row) { return row.bucket === BUCKETS.ONLY_INELIGIBLE_SWING_CANDIDATES; });
    var bucketD = rows.filter(function (row) { return row.bucket === BUCKETS.FROZEN_SOURCE_PRESENT; });
    var directionMatrix = {};
    Object.keys(BUCKETS).forEach(function (key) {
        var name = BUCKETS[key];
        var matching = rows.filter(function (row) { return row.bucket === name; });
        directionMatrix[name] = {
            LONG: matching.filter(function (row) { return row.direction === 'BULLISH'; }).length,
            SHORT: matching.filter(function (row) { return row.direction === 'BEARISH'; }).length
        };
    });
    return {
        rows: rows,
        before: before,
        after: after,
        bucketCounts: bucketCounts,
        allCandidates: allCandidates,
        primaryRows: primaryRows,
        bucketB: bucketB,
        bucketC: bucketC,
        bucketD: bucketD,
        directionMatrix: directionMatrix,
        eligibleAlternativeCountDistribution: distribution(bucketB.map(function (row) { return row.eligibleAlternativeCount; }))
    };
}

module.exports = {
    BUCKETS: BUCKETS,
    classificationForCandidate: classificationForCandidate,
    nearestByProductionHeuristic: nearestByProductionHeuristic,
    classifyWatch: classifyWatch,
    percentile: percentile,
    distribution: distribution,
    analyze: analyze
};
