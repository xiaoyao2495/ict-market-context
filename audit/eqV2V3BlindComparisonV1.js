'use strict';

var equalLiquidity = require('../liquidity/equalLiquidity');
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var eqV3 = require('./eqPersistentClusterShadowV3');

function immutableSwing(swing) {
    return {
        id: swing.id,
        symbol: swing.symbol,
        timeframe: swing.timeframe,
        type: swing.type,
        side: swing.side,
        price: swing.price,
        sourceOpenTime: swing.sourceOpenTime,
        sourceCloseTime: swing.sourceCloseTime,
        confirmedAt: swing.confirmedAt,
        metadata: { index: swing.metadata && swing.metadata.index,
            right: swing.metadata && swing.metadata.right }
    };
}

function immutableSwingHash(swings) {
    return eqV3.hash((swings || []).map(immutableSwing).sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || a.sourceOpenTime - b.sourceOpenTime ||
            String(a.id).localeCompare(String(b.id));
    }));
}

function cloneSwingForV2(swing) {
    var out = immutableSwing(swing);
    out.createdAt = swing.confirmedAt;
    out.status = 'ACTIVE';
    out.touchedAt = null;
    out.sweptAt = null;
    out.brokenAt = null;
    return out;
}

/** One chronological replay over the exact Swing objects supplied by V3. */
function buildV2ObjectStream(candles, sharedSwings, options) {
    var opts = options || {};
    var symbol = opts.symbol || 'BTCUSDT';
    var timeframe = opts.timeframe || '5m';
    var byConfirmation = {};
    sharedSwings.forEach(function (source) {
        var swing = cloneSwingForV2(source);
        if (!byConfirmation[swing.confirmedAt]) byConfirmation[swing.confirmedAt] = [];
        byConfirmation[swing.confirmedAt].push(swing);
    });
    var swings = [];
    var objects = [];
    var objectById = {};
    candles.forEach(function (candle) {
        if (!candle || candle.closed === false) return;
        var added = (byConfirmation[candle.closeTime] || []).slice().sort(function (a, b) {
            return a.sourceOpenTime - b.sourceOpenTime || String(a.id).localeCompare(String(b.id));
        });
        added.forEach(function (swing) { swings.push(swing); });
        if (added.length) {
            equalLiquidity.detectEqualLiquidity(added.concat(swings), {
                symbol: symbol,
                timeframe: timeframe,
                evaluationTime: candle.closeTime,
                secondSwingIds: added.map(function (swing) { return swing.id; }),
                lifecycleFromCurrentState: true,
                canonicalClosedCandles: true,
                candles: candles
            }).forEach(function (object) {
                if (objectById[object.id]) return;
                objectById[object.id] = object;
                objects.push(object);
            });
        }
        swings.concat(objects).forEach(function (liquidity) {
            if (liquidity.confirmedAt >= candle.closeTime ||
                (liquidity.status !== 'ACTIVE' && liquidity.status !== 'TOUCHED')) return;
            var event = liquidityLifecycle.evaluateLiquidity(liquidity, candle);
            if (!event) return;
            liquidity.status = event.status;
            liquidity.touchedAt = event.touchedAt;
            liquidity.sweptAt = event.sweptAt;
            liquidity.brokenAt = event.brokenAt;
        });
    });
    return { swings: swings, objects: objects };
}

function assignmentForCase(caseId) {
    var digest = eqV3.hash(String(caseId));
    return parseInt(digest.slice(0, 2), 16) % 2 === 0
        ? { A: 'V2', B: 'V3' }
        : { A: 'V3', B: 'V2' };
}

/** Deterministically balance any hash skew while keeping assignment opaque. */
function balancedAssignments(caseIds) {
    var ids = caseIds.slice().sort();
    var targetAIsV2 = Math.floor(ids.length / 2);
    var rows = ids.map(function (caseId) {
        return { caseId: caseId, mapping: assignmentForCase(caseId) };
    });
    var current = rows.filter(function (row) { return row.mapping.A === 'V2'; }).length;
    if (current > targetAIsV2) {
        rows.filter(function (row) { return row.mapping.A === 'V2'; })
            .slice(targetAIsV2).forEach(function (row) { row.mapping = { A: 'V3', B: 'V2' }; });
    } else if (current < targetAIsV2) {
        rows.filter(function (row) { return row.mapping.A === 'V3'; })
            .slice(0, targetAIsV2 - current).forEach(function (row) {
                row.mapping = { A: 'V2', B: 'V3' };
            });
    }
    var out = {};
    rows.forEach(function (row) { out[row.caseId] = row.mapping; });
    return out;
}

function evenlyPick(rows, count) {
    if (count <= 0 || !rows.length) return [];
    if (rows.length <= count) return rows.slice();
    var out = [];
    var used = {};
    for (var i = 0; i < count; i++) {
        var index = count === 1 ? Math.floor(rows.length / 2)
            : Math.round(i * (rows.length - 1) / (count - 1));
        while (used[index] && index + 1 < rows.length) index++;
        used[index] = true;
        out.push(rows[index]);
    }
    return out;
}

function noOutcomeFields(value) {
    var forbidden = /futureOutcome|sweepResult|watchResult|pnl|mfe|mae|entry|futureReturn/i;
    var violations = [];
    function walk(item, prefix) {
        if (!item || typeof item !== 'object') return;
        Object.keys(item).forEach(function (key) {
            var next = prefix ? prefix + '.' + key : key;
            if (forbidden.test(key)) violations.push(next);
            walk(item[key], next);
        });
    }
    walk(value, '');
    return violations;
}

function revealLabels(labels, modelKey) {
    var counts = { V2_BETTER: 0, V3_BETTER: 0, EQUAL: 0, BOTH_BAD: 0, UNCERTAIN: 0 };
    (labels || []).forEach(function (row) {
        if (row.label === 'EQUAL' || row.label === 'BOTH_BAD' || row.label === 'UNCERTAIN') {
            counts[row.label]++;
            return;
        }
        var winner = row.label === 'MODEL_A_BETTER' ? 'A'
            : row.label === 'MODEL_B_BETTER' ? 'B' : null;
        if (!winner || !modelKey[row.caseId]) return;
        counts[modelKey[row.caseId][winner] + '_BETTER']++;
    });
    return counts;
}

function reviewSetHash(cases) {
    return eqV3.hash((cases || []).map(function (item) {
        return { caseId: item.caseId, side: item.side, evaluationTime: item.evaluationTime,
            windowStart: item.windowStart, windowEnd: item.windowEnd,
            modelAObjects: item.modelAObjects, modelBObjects: item.modelBObjects,
            underlyingSwingIds: item.underlyingSwingIds };
    }));
}

module.exports = {
    immutableSwing: immutableSwing,
    immutableSwingHash: immutableSwingHash,
    buildV2ObjectStream: buildV2ObjectStream,
    assignmentForCase: assignmentForCase,
    balancedAssignments: balancedAssignments,
    evenlyPick: evenlyPick,
    noOutcomeFields: noOutcomeFields,
    revealLabels: revealLabels,
    reviewSetHash: reviewSetHash
};
