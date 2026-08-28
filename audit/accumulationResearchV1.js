'use strict';

var crypto = require('crypto');
var detector = require('../amd/accumulationDetector');
var atrIndicator = require('../indicators/atr');

function round(n, d) {
    if (!Number.isFinite(n)) return null;
    var p = Math.pow(10, d === undefined ? 6 : d);
    return Math.round(n * p) / p;
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function distribution(values) {
    var a = values.filter(Number.isFinite).slice().sort(function (x, y) { return x - y; });
    return { min: quantile(a, 0), p25: quantile(a, 0.25), median: quantile(a, 0.5),
        p75: quantile(a, 0.75), p90: quantile(a, 0.9), max: quantile(a, 1) };
}

function linearSlope(values) {
    if (values.length < 2) return 0;
    var n = values.length, sx = 0, sy = 0, sxy = 0, sxx = 0;
    values.forEach(function (y, x) { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    var den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : 0;
}

function features(candles, start, end, atrValue, options) {
    var opts = options || {};
    var rangeHigh = -Infinity, rangeLow = Infinity, i;
    for (i = start; i <= end; i++) {
        rangeHigh = Math.max(rangeHigh, candles[i].high);
        rangeLow = Math.min(rangeLow, candles[i].low);
    }
    var width = rangeHigh - rangeLow;
    var mid = (rangeHigh + rangeLow) / 2;
    var tolerance = width * (opts.touchToleranceRangeFraction === undefined ? 0.1 : opts.touchToleranceRangeFraction);
    var upper = 0, lower = 0, crosses = 0, above = 0, below = 0, occupied = 0;
    var prevSide = null;
    for (i = start; i <= end; i++) {
        var c = candles[i];
        if (rangeHigh - c.high <= tolerance) upper++;
        if (c.low - rangeLow <= tolerance) lower++;
        var side = c.close >= mid ? 1 : -1;
        if (prevSide !== null && side !== prevSide) crosses++;
        prevSide = side;
        if (c.close >= mid) above++; else below++;
        if (!width || (c.close >= rangeLow + tolerance && c.close <= rangeHigh - tolerance)) occupied++;
    }
    var duration = end - start + 1;
    var drift = candles[end].close - candles[start].close;
    var preBars = opts.preRangeBars || 24;
    var preStart = Math.max(0, start - preBars);
    var preCloses = candles.slice(preStart, start + 1).map(function (c) { return c.close; });
    var preMove = candles[start].close - candles[preStart].close;
    var entryPos = width ? (candles[start].close - rangeLow) / width : 0.5;
    return {
        rangeHigh: rangeHigh, rangeLow: rangeLow, rangeMid: mid, rangeWidth: width,
        atr14: atrValue, rangeWidthATR: atrValue > 0 ? width / atrValue : null,
        durationBars: duration, upperTouchCount: upper, lowerTouchCount: lower,
        midCrossCount: crosses, closeAboveMidCount: above, closeBelowMidCount: below,
        rangeOccupancy: duration ? occupied / duration : null,
        directionalDriftATR: atrValue > 0 ? drift / atrValue : null,
        directionalDriftAbsoluteATR: atrValue > 0 ? Math.abs(drift) / atrValue : null,
        preRangeBarsAvailable: start - preStart,
        preRangeDirectionalMoveATR: atrValue > 0 ? preMove / atrValue : null,
        preRangeSlope: atrValue > 0 ? linearSlope(preCloses) / atrValue : null,
        entrySideIntoRange: entryPos >= 2 / 3 ? 'UPPER' : entryPos <= 1 / 3 ? 'LOWER' : 'MIDDLE',
        preRangeContext: Math.abs(preMove / atrValue) < 1 ? 'NEUTRAL' : preMove > 0 ? 'TREND_UP' : 'TREND_DOWN',
        featureSourceStartIndex: preStart, featureSourceEndIndex: end
    };
}

function detectCandidate(input, config) {
    var result = detector.detectAccumulation({
        candles: input.candles, endIndex: input.index, evaluationTime: input.evaluationTime,
        timeframe: input.timeframe, symbol: input.symbol, liquidityRegistry: input.liquidityRegistry || null
    }, { thresholds: config.thresholds });
    if (!result || result.state !== 'ACCUMULATION_CONFIRMED') return null;
    var f = features(input.candles, result.startIndex, result.endIndex, result.atr, config.research);
    var idSeed = [input.symbol, input.timeframe, result.startIndex, result.endIndex,
        input.candles[result.startIndex].openTime, result.confirmedAt, result.rangeLow, result.rangeHigh].join('|');
    return {
        id: 'A-CANDIDATE:' + crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 20),
        type: 'ACCUMULATION_CANDIDATE', symbol: input.symbol, timeframe: input.timeframe,
        formationStartAt: input.candles[result.startIndex].openTime,
        formationEndAt: input.candles[result.endIndex].closeTime,
        confirmedAt: result.confirmedAt,
        startIndex: result.startIndex, endIndex: result.endIndex,
        rangeHighAtConfirmation: result.rangeHigh,
        rangeLowAtConfirmation: result.rangeLow,
        rangeMidAtConfirmation: result.mid,
        detectorScore: result.score,
        detectorBreakdown: result.breakdown,
        activeEqualLiquidityEvidenceIds: (result.liquidityInside || []).map(function (x) { return x.id; }).sort(),
        features: f
    };
}

function overlapRatio(a, b) {
    var inter = Math.max(0, Math.min(a.endIndex, b.endIndex) - Math.max(a.startIndex, b.startIndex) + 1);
    var union = Math.max(a.endIndex, b.endIndex) - Math.min(a.startIndex, b.startIndex) + 1;
    return union ? inter / union : 0;
}

function priceIou(a, b) {
    var lo = Math.max(a.rangeLowAtConfirmation, b.rangeLowAtConfirmation);
    var hi = Math.min(a.rangeHighAtConfirmation, b.rangeHighAtConfirmation);
    var unionLo = Math.min(a.rangeLowAtConfirmation, b.rangeLowAtConfirmation);
    var unionHi = Math.max(a.rangeHighAtConfirmation, b.rangeHighAtConfirmation);
    return unionHi > unionLo ? Math.max(0, hi - lo) / (unionHi - unionLo) : 1;
}

function dedupe(raw, config) {
    var cfg = config || { timeOverlapMin: 0.75, priceIouMin: 0.8 };
    var groups = [];
    raw.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id); })
        .forEach(function (candidate) {
            var found = groups.filter(function (g) {
                return overlapRatio(g.anchor, candidate) >= cfg.timeOverlapMin && priceIou(g.anchor, candidate) >= cfg.priceIouMin;
            })[0];
            if (!found) groups.push({ anchor: candidate, members: [candidate] });
            else found.members.push(candidate);
        });
    return groups.map(function (group) {
        var representative = group.members.slice().sort(function (a, b) {
            if (a.detectorScore !== b.detectorScore) return b.detectorScore - a.detectorScore;
            if (a.features.durationBars !== b.features.durationBars) return b.features.durationBars - a.features.durationBars;
            return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id);
        })[0];
        var out = JSON.parse(JSON.stringify(representative));
        out.reviewIdentity = 'A-REVIEW:' + crypto.createHash('sha1').update(group.anchor.id).digest('hex').slice(0, 20);
        out.dedupeAnchorCandidateId = group.anchor.id;
        out.rawCandidateIds = group.members.map(function (x) { return x.id; });
        out.rawCandidateCount = group.members.length;
        return out;
    });
}

function bins(rows, field) {
    var vals = rows.map(function (r) { return field(r); }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    return [quantile(vals, 1 / 3), quantile(vals, 2 / 3)];
}
function bucket(value, cuts) { return value <= cuts[0] ? 'LOW' : value <= cuts[1] ? 'MID' : 'HIGH'; }

function deterministicSample(rows, count) {
    if (rows.length <= count) return rows.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    var durationCuts = bins(rows, function (r) { return r.features.durationBars; });
    var widthCuts = bins(rows, function (r) { return r.features.rangeWidthATR; });
    var interactionCuts = bins(rows, function (r) { return r.features.upperTouchCount + r.features.lowerTouchCount + r.features.midCrossCount; });
    var sorted = rows.slice().sort(function (a, b) {
        var ka = [bucket(a.features.durationBars, durationCuts), bucket(a.features.rangeWidthATR, widthCuts),
            bucket(a.features.upperTouchCount + a.features.lowerTouchCount + a.features.midCrossCount, interactionCuts),
            a.features.preRangeContext, a.confirmedAt, a.id].join('|');
        var kb = [bucket(b.features.durationBars, durationCuts), bucket(b.features.rangeWidthATR, widthCuts),
            bucket(b.features.upperTouchCount + b.features.lowerTouchCount + b.features.midCrossCount, interactionCuts),
            b.features.preRangeContext, b.confirmedAt, b.id].join('|');
        return ka.localeCompare(kb);
    });
    var strata = {};
    sorted.forEach(function (r) {
        var key = [bucket(r.features.durationBars, durationCuts), bucket(r.features.rangeWidthATR, widthCuts),
            bucket(r.features.upperTouchCount + r.features.lowerTouchCount + r.features.midCrossCount, interactionCuts),
            r.features.preRangeContext].join('|');
        (strata[key] = strata[key] || []).push(r);
    });
    var keys = Object.keys(strata).sort(), selected = [], used = {};
    // Reserve deterministic chronology anchors so small control samples cannot
    // collapse into the earliest feature strata.
    var chronological = rows.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt || a.id.localeCompare(b.id); });
    var timeBins = Math.min(10, count);
    for (var tb = 0; tb < timeBins; tb++) {
        var ti = Math.min(chronological.length - 1, Math.floor((tb + 0.5) * chronological.length / timeBins));
        var timeRow = chronological[ti];
        if (!used[timeRow.id]) { selected.push(timeRow); used[timeRow.id] = true; }
    }
    while (selected.length < count) {
        var added = false;
        keys.forEach(function (key) {
            if (selected.length >= count || !strata[key].length) return;
            var row = strata[key].shift();
            if (!used[row.id]) { selected.push(row); used[row.id] = true; added = true; }
        });
        if (!added) break;
    }
    if (selected.length < count) {
        rows.slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt; }).forEach(function (r) {
            if (selected.length < count && !used[r.id]) { selected.push(r); used[r.id] = true; }
        });
    }
    return selected.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
}

function buildControlPopulation(candles, raw, validationStartIndex, config) {
    var duration = config.control.durationBars;
    var stride = config.control.strideBars;
    var controls = [];
    for (var end = validationStartIndex + duration - 1; end < candles.length; end += stride) {
        var start = end - duration + 1;
        var overlaps = raw.some(function (r) {
            var inter = Math.max(0, Math.min(end, r.endIndex) - Math.max(start, r.startIndex) + 1);
            return inter / duration >= config.control.maxCandidateOverlap;
        });
        if (overlaps) continue;
        var atrValue = atrIndicator.atr(candles, config.atrPeriod, end);
        if (!(atrValue > 0)) continue;
        var f = features(candles, start, end, atrValue, config.research);
        controls.push({
            id: 'A-CONTROL:' + candles[start].openTime + ':' + candles[end].closeTime,
            type: 'CONTROL', symbol: 'BTCUSDT', timeframe: '5m',
            formationStartAt: candles[start].openTime, formationEndAt: candles[end].closeTime,
            confirmedAt: candles[end].closeTime, startIndex: start, endIndex: end,
            rangeHighAtConfirmation: f.rangeHigh, rangeLowAtConfirmation: f.rangeLow,
            rangeMidAtConfirmation: f.rangeMid, features: f
        });
    }
    return controls;
}

function sampleControls(controls, count) {
    return deterministicSample(controls, count);
}

function chartBounds(row, totalBars, preBars, postBars) {
    return { startIndex: Math.max(0, row.startIndex - preBars),
        cutoffIndex: Math.min(totalBars - 1, row.endIndex + postBars), featureCutoffIndex: row.endIndex };
}

module.exports = {
    round: round, distribution: distribution, features: features,
    detectCandidate: detectCandidate, dedupe: dedupe,
    deterministicSample: deterministicSample,
    buildControlPopulation: buildControlPopulation, sampleControls: sampleControls,
    chartBounds: chartBounds, overlapRatio: overlapRatio, priceIou: priceIou
};
