'use strict';

var gtAudit = require('./accumulationGroundTruthV1');

var STATES = ['L', 'M', 'U'];
var SCALARS = [
    'durationBars', 'compressedSequenceLength', 'sideAlternationCount', 'sideAlternationRate',
    'alternationsPer10Bars', 'longestLowerResidenceBars', 'longestUpperResidenceBars',
    'longestSideResidenceBars', 'medianOppositeSideReturnBars', 'maxOppositeSideReturnBars',
    'uncompletedOppositeSideReturns', 'rebalanceCount', 'upperExcursionRebalancedCount',
    'lowerExcursionRebalancedCount', 'upperExcursionTotal', 'lowerExcursionTotal',
    'rebalanceCompletionRatio', 'completeAuctionCycleCount', 'fullAuctionSegments',
    'excursionToMidReturnCount', 'excursionToOppositeSideCount', 'failedReabsorptionCount',
    'earlyCenter', 'middleCenter', 'lateCenter', 'centerMigrationMagnitude', 'centerNetMigration'
];

function quantileSummary(values) { return gtAudit.distribution(values.filter(Number.isFinite)); }
function median(values) {
    var a = values.filter(Number.isFinite).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function round(value, digits) {
    if (!Number.isFinite(value)) return null;
    var power = Math.pow(10, digits === undefined ? 6 : digits);
    return Math.round(value * power) / power;
}

function stateForPosition(position) {
    if (position <= 1 / 3) return 'L';
    if (position < 2 / 3) return 'M';
    return 'U';
}

function compress(sequence) {
    return sequence.filter(function (state, index) { return index === 0 || state !== sequence[index - 1]; });
}

function sideAlternations(sequence) {
    var previousSide = null, count = 0;
    sequence.forEach(function (state) {
        if (state === 'M') return;
        if (previousSide && state !== previousSide) count++;
        previousSide = state;
    });
    return count;
}

function longestResidence(sequence, side) {
    var current = 0, longest = 0;
    sequence.forEach(function (state) {
        current = state === side ? current + 1 : 0;
        longest = Math.max(longest, current);
    });
    return longest;
}

function sideEntries(sequence) {
    var entries = [];
    sequence.forEach(function (state, index) {
        if ((state === 'L' || state === 'U') && (index === 0 || sequence[index - 1] !== state)) {
            entries.push({ state: state, index: index });
        }
    });
    return entries;
}

function oppositeReturnProfile(sequence) {
    var completed = [], uncompleted = 0;
    sideEntries(sequence).forEach(function (entry) {
        var opposite = entry.state === 'L' ? 'U' : 'L', found = -1;
        for (var i = entry.index + 1; i < sequence.length; i++) {
            if (sequence[i] === opposite) { found = i; break; }
        }
        if (found === -1) uncompleted++;
        else completed.push(found - entry.index);
    });
    return { times: completed, median: median(completed), max: completed.length ? Math.max.apply(null, completed) : null,
        uncompleted: uncompleted };
}

function rebalanceProfile(sequence) {
    var entries = sideEntries(sequence), upperTotal = 0, lowerTotal = 0, upperDone = 0, lowerDone = 0;
    entries.forEach(function (entry) {
        if (entry.state === 'U') upperTotal++; else lowerTotal++;
        var nextDifferent = null;
        for (var i = entry.index + 1; i < sequence.length; i++) {
            if (sequence[i] !== entry.state) { nextDifferent = sequence[i]; break; }
        }
        if (nextDifferent === 'M') {
            if (entry.state === 'U') upperDone++; else lowerDone++;
        }
    });
    var total = upperTotal + lowerTotal, done = upperDone + lowerDone;
    return { count: done, upperDone: upperDone, lowerDone: lowerDone, upperTotal: upperTotal,
        lowerTotal: lowerTotal, ratio: total ? done / total : null };
}

function cycleCount(compressed) {
    var visits = [], midSeen = false;
    compressed.forEach(function (state) {
        if (state === 'M') { midSeen = true; return; }
        visits.push({ side: state, midSincePreviousSide: visits.length ? midSeen : false });
        midSeen = false;
    });
    var count = 0;
    for (var i = 2; i < visits.length; i++) {
        var a = visits[i - 2], b = visits[i - 1], c = visits[i];
        if (a.side === c.side && a.side !== b.side && b.midSincePreviousSide && c.midSincePreviousSide) count++;
    }
    return count;
}

function reabsorptionProfile(sequence) {
    var toMid = 0, toOpposite = 0, failed = 0;
    sideEntries(sequence).forEach(function (entry) {
        var midAt = -1, opposite = entry.state === 'L' ? 'U' : 'L', oppositeAt = -1;
        for (var i = entry.index + 1; i < sequence.length; i++) {
            if (midAt === -1 && sequence[i] === 'M') midAt = i;
            if (midAt !== -1 && sequence[i] === opposite) { oppositeAt = i; break; }
        }
        if (midAt !== -1) toMid++; else failed++;
        if (oppositeAt !== -1) toOpposite++;
    });
    return { toMid: toMid, toOpposite: toOpposite, failed: failed };
}

function segmentProfile(sequence, positions, segmentIndex) {
    var n = sequence.length;
    var indexes = [];
    for (var i = 0; i < n; i++) if (Math.min(2, Math.floor(i * 3 / n)) === segmentIndex) indexes.push(i);
    var states = indexes.map(function (index) { return sequence[index]; });
    var segmentPositions = indexes.map(function (index) { return positions[index]; });
    var visited = { L: states.indexOf('L') !== -1, M: states.indexOf('M') !== -1, U: states.indexOf('U') !== -1 };
    var midRebalances = 0;
    for (var j = 1; j < states.length; j++) {
        if (states[j] === 'M' && (states[j - 1] === 'L' || states[j - 1] === 'U')) midRebalances++;
    }
    return { barCount: states.length, visitedLower: visited.L, visitedMid: visited.M, visitedUpper: visited.U,
        stateCoverage: STATES.filter(function (state) { return visited[state]; }).join('/'),
        sideAlternations: sideAlternations(states), midRebalances: midRebalances,
        fullAuctionSegment: visited.L && visited.M && visited.U, medianNormalizedPosition: median(segmentPositions) };
}

/**
 * Label-blind, formation-only feature generator.
 * Input intentionally contains only candles, immutable formation bounds and indices.
 */
function generate(input) {
    if (!input || !Array.isArray(input.candles)) throw new Error('candles required');
    if (input.startIndex < 0 || input.endIndex >= input.candles.length || input.startIndex > input.endIndex) {
        throw new Error('invalid formation indices');
    }
    var bars = input.candles.slice(input.startIndex, input.endIndex + 1);
    var width = input.rangeHigh - input.rangeLow;
    if (!(width > 0)) throw new Error('positive immutable range width required');
    var rawPositions = bars.map(function (bar) { return (bar.close - input.rangeLow) / width; });
    var clampedPositions = rawPositions.map(function (position) { return Math.max(0, Math.min(1, position)); });
    var sequence = rawPositions.map(stateForPosition), compressed = compress(sequence);
    var alternations = sideAlternations(sequence), returns = oppositeReturnProfile(sequence);
    var rebalance = rebalanceProfile(sequence), reabsorption = reabsorptionProfile(sequence);
    var early = segmentProfile(sequence, rawPositions, 0), middle = segmentProfile(sequence, rawPositions, 1),
        late = segmentProfile(sequence, rawPositions, 2);
    var centers = [early.medianNormalizedPosition, middle.medianNormalizedPosition, late.medianNormalizedPosition];
    return {
        featureSchema: 'ACCUMULATION_AUCTION_REPRESENTATION_V1',
        featureSourceStartIndex: input.startIndex,
        featureSourceEndIndex: input.endIndex,
        featureSourceConfirmedAt: input.candles[input.endIndex].closeTime,
        durationBars: bars.length,
        normalizedPositionsRaw: rawPositions.map(function (x) { return round(x, 6); }),
        normalizedPositionsClamped: clampedPositions.map(function (x) { return round(x, 6); }),
        auctionStateSequence: sequence,
        auctionStateSequenceText: sequence.join(''),
        compressedAuctionSequence: compressed,
        compressedAuctionSequenceText: compressed.join('-'),
        compressedSequenceLength: compressed.length,
        sideAlternationCount: alternations,
        sideAlternationRate: alternations / Math.max(1, bars.length - 1),
        alternationsPer10Bars: alternations * 10 / bars.length,
        longestLowerResidenceBars: longestResidence(sequence, 'L'),
        longestUpperResidenceBars: longestResidence(sequence, 'U'),
        longestSideResidenceBars: Math.max(longestResidence(sequence, 'L'), longestResidence(sequence, 'U')),
        oppositeSideReturnTimes: returns.times,
        medianOppositeSideReturnBars: returns.median,
        maxOppositeSideReturnBars: returns.max,
        uncompletedOppositeSideReturns: returns.uncompleted,
        rebalanceCount: rebalance.count,
        upperExcursionRebalancedCount: rebalance.upperDone,
        lowerExcursionRebalancedCount: rebalance.lowerDone,
        upperExcursionTotal: rebalance.upperTotal,
        lowerExcursionTotal: rebalance.lowerTotal,
        rebalanceCompletionRatio: rebalance.ratio,
        completeAuctionCycleCount: cycleCount(compressed),
        earlyAuctionCoverage: early,
        middleAuctionCoverage: middle,
        lateAuctionCoverage: late,
        auctionPersistenceProfile: { EARLY: early.stateCoverage, MIDDLE: middle.stateCoverage, LATE: late.stateCoverage },
        fullAuctionSegments: [early, middle, late].filter(function (segment) { return segment.fullAuctionSegment; }).length,
        excursionToMidReturnCount: reabsorption.toMid,
        excursionToOppositeSideCount: reabsorption.toOpposite,
        failedReabsorptionCount: reabsorption.failed,
        earlyCenter: early.medianNormalizedPosition,
        middleCenter: middle.medianNormalizedPosition,
        lateCenter: late.medianNormalizedPosition,
        centerPath: centers.map(function (x) { return round(x, 4); }),
        centerMigrationMagnitude: Math.max.apply(null, centers) - Math.min.apply(null, centers),
        centerNetMigration: late.medianNormalizedPosition - early.medianNormalizedPosition,
        directionalEpisodeRepresentation: 'DEFERRED_ARBITRARY_THRESHOLD_AVOIDED'
    };
}

function groupComparison(joinedRows) {
    var out = {};
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (label) {
        var rows = joinedRows.filter(function (row) { return row.humanLabel === label; });
        var scalars = {};
        SCALARS.forEach(function (field) { scalars[field] = quantileSummary(rows.map(function (row) { return row.features[field]; })); });
        var persistencePatterns = {}, compressedPatterns = {};
        rows.forEach(function (row) {
            var p = row.features.auctionPersistenceProfile;
            var pKey = p.EARLY + ' | ' + p.MIDDLE + ' | ' + p.LATE;
            persistencePatterns[pKey] = (persistencePatterns[pKey] || 0) + 1;
            var cKey = row.features.compressedAuctionSequenceText;
            compressedPatterns[cKey] = (compressedPatterns[cKey] || 0) + 1;
        });
        out[label] = { n: rows.length, scalars: scalars,
            fullAuctionSegmentFrequency: [0, 1, 2, 3].reduce(function (o, count) {
                o[count] = rows.filter(function (row) { return row.features.fullAuctionSegments === count; }).length; return o;
            }, {}),
            persistencePatterns: persistencePatterns,
            topCompressedPatterns: Object.keys(compressedPatterns).sort(function (a, b) {
                return compressedPatterns[b] - compressedPatterns[a] || a.localeCompare(b);
            }).slice(0, 10).map(function (pattern) { return { pattern: pattern, count: compressedPatterns[pattern] }; }) };
    });
    return out;
}

function conflictCases(rows) {
    var clearWeak = rows.filter(function (row) {
        return row.humanLabel === 'CLEAR_A' && (row.features.sideAlternationCount === 0 ||
            row.features.rebalanceCount === 0 || row.features.fullAuctionSegments === 0);
    }).map(function (row) { return { type: 'TYPE_A_CLEAR_WEAK_REPRESENTATION', caseId: row.caseId,
        humanLabel: row.humanLabel, reasons: [row.features.sideAlternationCount === 0 ? 'ZERO_SIDE_ALTERNATION' : null,
            row.features.rebalanceCount === 0 ? 'ZERO_REBALANCE' : null,
            row.features.fullAuctionSegments === 0 ? 'ZERO_FULL_AUCTION_SEGMENTS' : null].filter(Boolean), features: row.features }; });
    var noStrong = rows.filter(function (row) {
        return row.humanLabel === 'NO_A' && row.features.completeAuctionCycleCount > 0 && row.features.fullAuctionSegments === 3;
    }).map(function (row) { return { type: 'TYPE_B_NO_STRONG_REPRESENTATION', caseId: row.caseId,
        humanLabel: row.humanLabel, reasons: ['COMPLETE_CYCLE_PRESENT', 'ALL_THREE_SEGMENTS_FULL'], features: row.features }; });
    return { definition: 'Semantic extremes only; no composite score, learned cutoff, or accuracy optimization.',
        TYPE_A_CLEAR_WEAK_REPRESENTATION: clearWeak, TYPE_B_NO_STRONG_REPRESENTATION: noStrong,
        total: clearWeak.length + noStrong.length };
}

function representativeCases(rows, conflicts) {
    function five(label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; })
            .slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.caseId.localeCompare(b.caseId); });
        return [0.1, 0.3, 0.5, 0.7, 0.9].map(function (q) {
            return cohort[Math.min(cohort.length - 1, Math.floor(q * cohort.length))].caseId;
        }).filter(function (id, index, all) { return all.indexOf(id) === index; });
    }
    return { selectionMethod: 'Deterministic chronological quantiles; never selected for classification performance.',
        CLEAR_A: five('CLEAR_A'), BORDERLINE_A: five('BORDERLINE_A'), NO_A: five('NO_A'),
        REPRESENTATION_CONFLICTS: conflicts.TYPE_A_CLEAR_WEAK_REPRESENTATION.concat(conflicts.TYPE_B_NO_STRONG_REPRESENTATION)
            .map(function (row) { return row.caseId; }) };
}

module.exports = { STATES: STATES, SCALARS: SCALARS, stateForPosition: stateForPosition,
    compress: compress, sideAlternations: sideAlternations, cycleCount: cycleCount,
    generate: generate, groupComparison: groupComparison, conflictCases: conflictCases,
    representativeCases: representativeCases };
