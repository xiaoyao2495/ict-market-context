'use strict';

var FP = ['case003','case011','case014','case017','case018','case023','case035','case042','case043','case044','case047','case057','case058'];
var BORDERLINE_POSITIVE = ['case022','case036','case037'];
var BORDERLINE_CONTROL = ['case071'];
var CORRECT_NEGATIVE = ['case074','case076','case078','case080'];

function setOf(values) { var out = {}; values.forEach(function (v) { out[v] = true; }); return out; }
var fpSet = setOf(FP), borderlinePositiveSet = setOf(BORDERLINE_POSITIVE);
var borderlineControlSet = setOf(BORDERLINE_CONTROL), correctNegativeSet = setOf(CORRECT_NEGATIVE);

function round(n, d) {
    if (!Number.isFinite(n)) return null;
    var p = Math.pow(10, d === undefined ? 6 : d);
    return Math.round(n * p) / p;
}
function mean(values) { return values.length ? values.reduce(function (a, b) { return a + b; }, 0) / values.length : null; }
function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function distribution(values) {
    var a = values.filter(Number.isFinite).slice().sort(function (x, y) { return x - y; });
    return { min: quantile(a,0), p25: quantile(a,.25), median: quantile(a,.5), p75: quantile(a,.75), max: quantile(a,1) };
}

function humanLabel(caseId) {
    if (fpSet[caseId] || correctNegativeSet[caseId]) return 'NO_A';
    if (borderlinePositiveSet[caseId] || borderlineControlSet[caseId]) return 'BORDERLINE_A';
    return 'UNREVIEWED';
}

function notes(caseId) {
    if (fpSet[caseId]) return ['Explicit human NO; machine-positive false-positive cohort.'];
    if (borderlinePositiveSet[caseId]) return ['Explicit human borderline/weak Accumulation; preserve separately from CLEAR_A and NO_A.'];
    if (borderlineControlSet[caseId]) return ['Explicit human borderline Accumulation missed by detector.', 'FALSE_NEGATIVE_PROTECTION_CASE', 'Do not use this case alone to change maxRangeWidthATR.'];
    if (correctNegativeSet[caseId]) return ['Explicit human NO; correct-negative control, not a detector false positive.'];
    return [];
}

function longestRun(values) {
    var best = 0, current = 0, previous = null;
    values.forEach(function (v) {
        if (v === previous) current++; else { previous = v; current = 1; }
        if (current > best) best = current;
    });
    return best;
}

function buildDiagnostic(row, candles, displacements, baseline) {
    var start = row.startIndex, end = row.endIndex;
    var formation = candles.slice(start, end + 1), n = formation.length;
    var high = row.rangeHighAtConfirmation, low = row.rangeLowAtConfirmation;
    var width = high - low, mid = (high + low) / 2;
    var tolerance = width * baseline.researchFeatures.touchToleranceRangeFraction;
    var upperFlags = [], lowerFlags = [], sides = [], crossFlags = [], positions = [];
    var path = 0;
    formation.forEach(function (c, i) {
        upperFlags.push(high - c.high <= tolerance);
        lowerFlags.push(c.low - low <= tolerance);
        sides.push(c.close >= mid ? 1 : -1);
        positions.push(width ? (c.close - low) / width : .5);
        if (i > 0) path += Math.abs(c.close - formation[i - 1].close);
        crossFlags.push(i > 0 && sides[i] !== sides[i - 1]);
    });
    var half = Math.ceil(n / 2);
    function count(flags, a, b) { return flags.slice(a, b).filter(Boolean).length; }
    var upperBins = {}, lowerBins = {}, crossBins = {};
    for (var i = 0; i < n; i++) {
        var bin = Math.min(3, Math.floor(i * 4 / n));
        if (upperFlags[i]) upperBins[bin] = true;
        if (lowerFlags[i]) lowerBins[bin] = true;
        if (crossFlags[i]) crossBins[bin] = true;
    }
    var lowerOcc = positions.filter(function (p) { return p < 1/3; }).length / n;
    var midOcc = positions.filter(function (p) { return p >= 1/3 && p < 2/3; }).length / n;
    var upperOcc = positions.filter(function (p) { return p >= 2/3; }).length / n;

    var runningHigh = formation[0].high, runningLow = formation[0].low;
    var expansions = 0, lateExpansions = 0, lateStart = Math.ceil(n * 2 / 3);
    formation.forEach(function (c, i) {
        if (i === 0) return;
        var expanded = false;
        if (c.high > runningHigh) { runningHigh = c.high; expanded = true; }
        if (c.low < runningLow) { runningLow = c.low; expanded = true; }
        if (expanded) { expansions++; if (i >= lateStart) lateExpansions++; }
    });
    var highEstablished = formation.findIndex(function (c) { return c.high === high; }) + 1;
    var lowEstablished = formation.findIndex(function (c) { return c.low === low; }) + 1;
    var third1 = positions.slice(0, Math.ceil(n / 3));
    var third2 = positions.slice(Math.ceil(n / 3), Math.ceil(n * 2 / 3));
    var third3 = positions.slice(Math.ceil(n * 2 / 3));

    var internal = (displacements || []).filter(function (d) {
        return d.candleIndex >= start && d.candleIndex <= end && d.confirmedAt <= row.confirmedAt;
    });
    var bullish = internal.filter(function (d) { return d.direction === 'BULLISH'; });
    var bearish = internal.filter(function (d) { return d.direction === 'BEARISH'; });
    var strong = internal.filter(function (d) { return d.metadata && d.metadata.score >= 4; });
    var largest = internal.reduce(function (m, d) { return Math.max(m, d.metadata && Number.isFinite(d.metadata.rangeAtr) ? d.metadata.rangeAtr : 0); }, 0);
    var breakdown = row.detectorBreakdown || {};
    var scoreWith = Number.isFinite(row.detectorScore) ? row.detectorScore : null;
    var eqContribution = Number.isFinite(breakdown.equalLiquidity) ? breakdown.equalLiquidity : 0;
    var scoreWithout = scoreWith === null ? null : scoreWith - eqContribution;
    var threshold = baseline.detector.confirmThreshold;
    var firstMean = mean(third1), lastMean = mean(third3);

    return Object.assign({}, row.features, {
        directionalEfficiency: path > 0 ? Math.abs(formation[n-1].close - formation[0].close) / path : 0,
        firstHalfUpperTouches: count(upperFlags,0,half), secondHalfUpperTouches: count(upperFlags,half,n),
        firstHalfLowerTouches: count(lowerFlags,0,half), secondHalfLowerTouches: count(lowerFlags,half,n),
        firstHalfMidCrosses: count(crossFlags,0,half), secondHalfMidCrosses: count(crossFlags,half,n),
        touchTemporalCoverage: (Object.keys(upperBins).length + Object.keys(lowerBins).length) / 8,
        midCrossTemporalCoverage: Object.keys(crossBins).length / 4,
        longestOneSideResidenceBars: longestRun(sides),
        longestNoMidCrossBars: longestRun(sides),
        lowerOccupancyPct: lowerOcc, midOccupancyPct: midOcc, upperOccupancyPct: upperOcc,
        highEstablishedBar: highEstablished, lowEstablishedBar: lowEstablished,
        highEstablishedPct: highEstablished / n, lowEstablishedPct: lowEstablished / n,
        rangeExpansionEvents: expansions, lateRangeExpansionPct: expansions ? lateExpansions / expansions : 0,
        lateBoundaryFormation: highEstablished / n > 2/3 || lowEstablished / n > 2/3,
        firstThirdMeanPosition: firstMean, middleThirdMeanPosition: mean(third2), lastThirdMeanPosition: lastMean,
        formationPositionShift: lastMean - firstMean,
        internalMigrationDiagnostic: Math.abs(lastMean - firstMean) > .35,
        internalDisplacementCount: internal.length,
        bullishInternalDisplacementCount: bullish.length,
        bearishInternalDisplacementCount: bearish.length,
        strongInternalDisplacementCount: strong.length,
        largestInternalDisplacementATR: largest,
        eqContribution: eqContribution,
        scoreWithEQ: scoreWith, scoreWithoutEQ: scoreWithout,
        passesThresholdWithEQ: scoreWith === null ? null : scoreWith >= threshold,
        passesThresholdWithoutEQ: scoreWithout === null ? null : scoreWithout >= threshold,
        eqDependentConfirmation: scoreWith !== null && scoreWith >= threshold && scoreWithout < threshold,
        rawScoreComponents: JSON.parse(JSON.stringify(breakdown)), totalScore: scoreWith,
        featureSourceStartIndex: Number.isFinite(row.features.featureSourceStartIndex) ? row.features.featureSourceStartIndex : start,
        temporalDiagnosticSourceStartIndex: start, featureSourceEndIndex: end,
        featureSourceConfirmedAt: row.confirmedAt
    });
}

function diagnose(feature) {
    var out = [];
    if (Math.min(feature.upperTouchCount, feature.lowerTouchCount) <= 1) out.push('LOW_TWO_SIDED_INTERACTION');
    if (Math.min(feature.upperTouchCount, feature.lowerTouchCount) > 0 &&
        Math.max(feature.upperTouchCount, feature.lowerTouchCount) / Math.min(feature.upperTouchCount, feature.lowerTouchCount) >= 2.5) out.push('ASYMMETRIC_BOUNDARY_INTERACTION');
    if (feature.touchTemporalCoverage < .5 || feature.midCrossTemporalCoverage < .5) out.push('LOW_TEMPORAL_INTERACTION_COVERAGE');
    if (feature.lateBoundaryFormation) out.push('LATE_BOUNDARY_FORMATION');
    if (Math.abs(feature.formationPositionShift) > .35) out.push('INTERNAL_DIRECTIONAL_MIGRATION');
    if (feature.longestOneSideResidenceBars / feature.durationBars > .5) out.push('HIGH_ONE_SIDE_RESIDENCE');
    if (feature.strongInternalDisplacementCount > 0) out.push('STRONG_INTERNAL_DISPLACEMENT');
    if (feature.eqDependentConfirmation) out.push('EQ_DEPENDENT_CONFIRMATION');
    return out.length ? out : ['OTHER_DIAGNOSTIC'];
}

function buildGroundTruth(manifest, candles, displacements, baseline) {
    return manifest.map(function (item) {
        return {
            caseId: item.caseId,
            detectorLabel: item.kind === 'POSITIVE' ? 'POSITIVE' : 'CONTROL_NEGATIVE',
            humanLabel: humanLabel(item.caseId), reviewSource: 'HUMAN', notes: notes(item.caseId),
            featureSnapshot: buildDiagnostic(item.row, candles, displacements, baseline),
            sourceCandidateId: item.row.id,
            chartReference: '../accumulation-detection-research-v1/charts/' + item.caseId + '.svg'
        };
    });
}

module.exports = {
    FALSE_POSITIVE_CASES: FP,
    BORDERLINE_POSITIVE_CASES: BORDERLINE_POSITIVE,
    BORDERLINE_CONTROL_CASES: BORDERLINE_CONTROL,
    CORRECT_NEGATIVE_CASES: CORRECT_NEGATIVE,
    humanLabel: humanLabel, buildDiagnostic: buildDiagnostic,
    buildGroundTruth: buildGroundTruth, diagnose: diagnose, distribution: distribution
};
