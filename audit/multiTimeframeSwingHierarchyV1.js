'use strict';

var crypto = require('crypto');
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).sort().forEach(function (key) { out[key] = stable(value[key]); });
    return out;
}
function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
function canonicalCandles(candles) {
    var byOpen = {};
    (candles || []).forEach(function (candle) {
        if (!candle || candle.closed === false || !Number.isFinite(candle.openTime)) return;
        byOpen[candle.openTime] = candle;
    });
    return Object.keys(byOpen).map(function (key) { return byOpen[key]; })
        .sort(function (a, b) { return a.openTime - b.openTime; });
}
function aggregate(candles, intervalMs, timeframe) {
    var rows = canonicalCandles(candles), buckets = {};
    rows.forEach(function (candle) {
        var openTime = Math.floor(candle.openTime / intervalMs) * intervalMs;
        (buckets[openTime] || (buckets[openTime] = [])).push(candle);
    });
    var expected = intervalMs / 300000;
    return Object.keys(buckets).map(Number).sort(function (a, b) { return a - b; }).map(function (openTime) {
        var group = buckets[openTime].sort(function (a, b) { return a.openTime - b.openTime; });
        var complete = group.length === expected && group[0].openTime === openTime &&
            group[group.length - 1].closeTime === openTime + intervalMs - 1 && group.every(function (candle, index) {
                return candle.openTime === openTime + index * 300000;
            });
        if (!complete) return null;
        return {
            openTime: openTime,
            closeTime: openTime + intervalMs - 1,
            open: group[0].open,
            high: Math.max.apply(Math, group.map(function (c) { return c.high; })),
            low: Math.min.apply(Math, group.map(function (c) { return c.low; })),
            close: group[group.length - 1].close,
            volume: group.reduce(function (sum, c) { return sum + Number(c.volume || 0); }, 0),
            closed: true,
            source: 'aggregate-5m',
            timeframe: timeframe,
            source5mCount: group.length
        };
    }).filter(Boolean);
}
function detect(symbol, timeframe, candles) {
    var rows = canonicalCandles(candles);
    var pivots = pivotDetector.detectPivots(rows, { left: 2, right: 2 });
    return swingLiquidity.buildSwingLiquidity(symbol, timeframe, pivots, rows, 2);
}
function sideOf(swing) { return swing.type === 'SWING_HIGH' ? 'HIGH' : 'LOW'; }
function mapHtfTo5m(htfSwings, fiveMinuteSwings, htfCandles, intervalMs) {
    var candleByOpen = {};
    canonicalCandles(htfCandles).forEach(function (candle) { candleByOpen[candle.openTime] = candle; });
    var ordered5m = (fiveMinuteSwings || []).slice().sort(function (a, b) {
        return a.sourceOpenTime - b.sourceOpenTime || a.id.localeCompare(b.id);
    });
    return (htfSwings || []).slice().sort(function (a, b) {
        return a.sourceOpenTime - b.sourceOpenTime || a.id.localeCompare(b.id);
    }).map(function (htf) {
        var source = candleByOpen[htf.sourceOpenTime];
        var candidates = ordered5m.filter(function (swing) {
            return sideOf(swing) === sideOf(htf) && swing.price === htf.price &&
                swing.sourceOpenTime >= htf.sourceOpenTime &&
                swing.sourceOpenTime < htf.sourceOpenTime + intervalMs;
        });
        var status = candidates.length === 1 ? 'RESOLVED' : (candidates.length > 1 ? 'AMBIGUOUS' : 'UNRESOLVED');
        return {
            htfSwingId: htf.id,
            timeframe: htf.timeframe,
            side: sideOf(htf),
            price: htf.price,
            occurredAt: htf.sourceOpenTime,
            confirmedAt: htf.confirmedAt,
            htfSourceCandleOpenTime: source ? source.openTime : null,
            htfSourceCandleCloseTime: source ? source.closeTime : null,
            mappingStatus: status,
            canonical5mSwingId: status === 'RESOLVED' ? candidates[0].id : null,
            candidate5mSwingIds: candidates.map(function (candidate) { return candidate.id; }),
            provenance: {
                method: 'SIDE_AND_EXACT_EXTREMUM_PRICE_WITHIN_HTF_SOURCE_CANDLE_COVERAGE',
                priceOnly: false,
                nearestMatch: false,
                deterministicTieBreakApplied: false
            }
        };
    });
}
function projectMembership(fiveMinuteSwings, mappingsByTimeframe, evaluationTime) {
    var byId = {};
    (fiveMinuteSwings || []).slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (swing) {
        byId[swing.id] = {
            canonicalSwingId: swing.id,
            side: sideOf(swing),
            price: swing.price,
            occurredAt: swing.sourceOpenTime,
            confirmedAt: swing.confirmedAt,
            timeframeMembership: {
                '5m': { member: swing.confirmedAt <= evaluationTime, htfSwingId: swing.id, occurredAt: swing.sourceOpenTime, confirmedAt: swing.confirmedAt },
                '15m': { member: false },
                '1h': { member: false },
                '4h': { member: false }
            }
        };
    });
    ['15m', '1h', '4h'].forEach(function (timeframe) {
        (mappingsByTimeframe[timeframe] || []).forEach(function (mapping) {
            if (mapping.mappingStatus !== 'RESOLVED' || mapping.confirmedAt > evaluationTime) return;
            var row = byId[mapping.canonical5mSwingId];
            if (!row || row.confirmedAt > evaluationTime) return;
            row.timeframeMembership[timeframe] = {
                member: true,
                htfSwingId: mapping.htfSwingId,
                occurredAt: mapping.occurredAt,
                confirmedAt: mapping.confirmedAt,
                mappingProvenance: mapping.provenance
            };
        });
    });
    return Object.keys(byId).sort().map(function (id) { return byId[id]; });
}
function combination(row) {
    return ['5m', '15m', '1h', '4h'].filter(function (timeframe) {
        return row.timeframeMembership[timeframe].member;
    }).join('+');
}
function validateTemporal(fiveMinuteSwings, mappingsByTimeframe, endTime) {
    var violations = [], immutabilityViolations = [];
    ['15m', '1h', '4h'].forEach(function (timeframe) {
        (mappingsByTimeframe[timeframe] || []).filter(function (mapping) { return mapping.mappingStatus === 'RESOLVED'; }).forEach(function (mapping) {
            var justBefore = mapping.confirmedAt - 1;
            var before = projectMembership(fiveMinuteSwings, mappingsByTimeframe, justBefore).filter(function (row) {
                return row.canonicalSwingId === mapping.canonical5mSwingId;
            })[0];
            var after = projectMembership(fiveMinuteSwings, mappingsByTimeframe, mapping.confirmedAt).filter(function (row) {
                return row.canonicalSwingId === mapping.canonical5mSwingId;
            })[0];
            if (before && before.timeframeMembership[timeframe].member) violations.push({ timeframe: timeframe, htfSwingId: mapping.htfSwingId, reason: 'FUTURE_HTF_CONFIRMATION_VISIBLE_EARLY' });
            if (!after || !after.timeframeMembership[timeframe].member) violations.push({ timeframe: timeframe, htfSwingId: mapping.htfSwingId, reason: 'MEMBERSHIP_NOT_VISIBLE_AT_CONFIRMATION' });
            var snapshotHash = hash(projectMembership(fiveMinuteSwings, mappingsByTimeframe, justBefore));
            projectMembership(fiveMinuteSwings, mappingsByTimeframe, Math.min(endTime, mapping.confirmedAt + 1));
            var secondHash = hash(projectMembership(fiveMinuteSwings, mappingsByTimeframe, justBefore));
            if (snapshotHash !== secondHash) immutabilityViolations.push({ timeframe: timeframe, htfSwingId: mapping.htfSwingId });
        });
    });
    return { futureLeakViolations: violations, pastStateImmutabilityViolations: immutabilityViolations };
}

module.exports = {
    stable: stable,
    hash: hash,
    canonicalCandles: canonicalCandles,
    aggregate: aggregate,
    detect: detect,
    mapHtfTo5m: mapHtfTo5m,
    projectMembership: projectMembership,
    combination: combination,
    validateTemporal: validateTemporal
};
