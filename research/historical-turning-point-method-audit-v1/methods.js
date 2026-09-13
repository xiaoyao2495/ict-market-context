'use strict';

var productionDynamicD = require('../../liquidity/causalDynamicDHistoricalExtremes');
var pivotDetector = require('../../structure/pivotDetector');

var BAR_MS = 300000;
var METHOD_IDS = {
    A: 'DYNAMIC_D_CLOSE_BASELINE',
    B: 'CLOSE_PROCESS_WICK_LOCALIZATION',
    C: 'WICK_DIRECTIONAL_CHANGE',
    D: 'PIVOT_ZIGZAG_2R_DYNAMIC_DEV',
    E: 'HIERARCHICAL_PIVOT_L2',
    F: 'PIVOT_PROMINENCE_DYNAMIC'
};

function iso(ms) { return new Date(ms).toISOString(); }
function local(ms) {
    return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
}

function event(methodId, side, candle, occurredIndex, confirmedAt, confirmationIndex, theta, metadata) {
    return {
        methodId: methodId,
        side: side,
        openTimeMs: candle.openTime,
        openTimeUtc: iso(candle.openTime),
        openTimeLocal: local(candle.openTime),
        price: side === 'HIGH' ? Number(candle.high) : Number(candle.low),
        confirmedAtMs: confirmedAt,
        confirmedAtUtc: iso(confirmedAt),
        confirmedAtLocal: local(confirmedAt),
        occurredIndex: occurredIndex,
        confirmationIndex: confirmationIndex,
        confirmationLagBars: confirmationIndex - occurredIndex,
        thetaSnapshot: theta === undefined ? null : theta,
        metadata: metadata || {}
    };
}

function thetaSeries(candles) {
    var returns = [], previous = null;
    return candles.map(function (candle) {
        var close = Number(candle.close);
        if (previous !== null) {
            returns.push(productionDynamicD.logReturn(close, previous));
            if (returns.length > productionDynamicD.LOOKBACK) returns = returns.slice(-productionDynamicD.LOOKBACK);
        }
        previous = close;
        if (returns.length < productionDynamicD.LOOKBACK) return null;
        return productionDynamicD.round8(productionDynamicD.thetaFor(productionDynamicD.sampleStd(returns)));
    });
}

function chooseWickExtreme(candles, startIndex, endIndex, side) {
    var localized = productionDynamicD.chooseSameProcessWickExtreme(candles, startIndex, endIndex, side);
    return { index: localized.index, price: localized.price };
}

function runAandB(candles, options) {
    var opts = options || {};
    var state = productionDynamicD.createState({ symbol: opts.symbol || 'UNKNOWN', timeframe: '5m' });
    var methodA = [], methodB = [];
    var processStartIndex = 0;
    for (var i = 0; i < candles.length; i++) {
        var output = productionDynamicD.step(state, candles[i], i, candles);
        output.dynamicDPoints.forEach(function (point) {
            var selectorIndex = point.selectorOccurredBarIndex;
            var a = event(METHOD_IDS.A, point.pointSide, candles[selectorIndex], selectorIndex,
                point.confirmedAt, point.confirmationBarIndex, point.thetaAtExtreme, {
                    selectorOpenTime: candles[selectorIndex].openTime,
                    selectorClose: point.selectorPrice,
                    anchorPrice: point.selectorWickPrice,
                    anchorWick: point.pointSide === 'HIGH' ? 'high' : 'low',
                    processSegmentStartIndex: processStartIndex,
                    processSegmentEndIndex: point.confirmationBarIndex,
                    productionVersion: productionDynamicD.VERSION
                });
            a.price = point.selectorWickPrice;
            methodA.push(a);

            // The production run remains active from the previous confirmation
            // candle (the exact next-run initialization source) through this
            // confirmation candle. B changes only localization inside that trace.
            var localized = chooseWickExtreme(candles, processStartIndex, point.confirmationBarIndex, point.pointSide);
            var b = event(METHOD_IDS.B, point.pointSide, candles[localized.index], localized.index,
                point.confirmedAt, point.confirmationBarIndex, point.thetaAtExtreme, {
                    baselineSelectorOpenTime: candles[selectorIndex].openTime,
                    baselineSelectorClose: point.selectorPrice,
                    baselineAnchorPrice: point.selectorWickPrice,
                    localizedExtremeOpenTime: candles[localized.index].openTime,
                    localizedExtremePrice: localized.price,
                    barsSelectorToLocalizedExtreme: localized.index - selectorIndex,
                    priceDifference: localized.price - point.selectorWickPrice,
                    priceDifferencePct: point.selectorWickPrice === 0 ? null :
                        (localized.price - point.selectorWickPrice) / point.selectorWickPrice,
                    processSegmentStartIndex: processStartIndex,
                    processSegmentEndIndex: point.confirmationBarIndex
                });
            b.price = localized.price;
            methodB.push(b);
            processStartIndex = point.confirmationBarIndex;
        });
    }
    return { A: methodA, B: methodB };
}

function makeWickCandidate(side, candle, index, theta) {
    return { side: side, candle: candle, index: index, theta: theta };
}

function runC(candles) {
    if (!candles.length) return [];
    var theta = thetaSeries(candles), events = [], direction = null, candidate = null;
    var seedClose = Number(candles[0].close), ambiguousInitCount = 0;
    for (var i = 1; i < candles.length; i++) {
        var candle = candles[i];
        if (direction === null) {
            var up = Number(candle.high) > seedClose;
            var down = Number(candle.low) < seedClose;
            if (up && down) ambiguousInitCount++;
            // Ambiguous intrabar order is never guessed. The completed candle's
            // close relative to the prior seed selects direction; an equal close
            // resets the seed and defers initialization.
            if (Number(candle.close) > seedClose) {
                direction = 'UP_RUN';
                candidate = makeWickCandidate('HIGH', candle, i, theta[i]);
            } else if (Number(candle.close) < seedClose) {
                direction = 'DOWN_RUN';
                candidate = makeWickCandidate('LOW', candle, i, theta[i]);
            } else {
                seedClose = Number(candle.close);
            }
            continue;
        }
        if (direction === 'UP_RUN') {
            if (Number(candle.high) > Number(candidate.candle.high)) {
                candidate = makeWickCandidate('HIGH', candle, i, theta[i]);
                continue;
            }
            if (candidate.theta !== null &&
                    (Number(candidate.candle.high) - Number(candle.low)) / Number(candidate.candle.high) >= candidate.theta) {
                events.push(event(METHOD_IDS.C, 'HIGH', candidate.candle, candidate.index,
                    candle.closeTime, i, candidate.theta, {
                        reversalObservationPrice: Number(candle.low),
                        initializationRule: 'AMBIGUOUS_INTRABAR_INIT_RESOLVED_BY_COMPLETED_CLOSE',
                        ambiguousIntrabarInitCount: ambiguousInitCount
                    }));
                direction = 'DOWN_RUN';
                candidate = makeWickCandidate('LOW', candle, i, theta[i]);
            }
        } else {
            if (Number(candle.low) < Number(candidate.candle.low)) {
                candidate = makeWickCandidate('LOW', candle, i, theta[i]);
                continue;
            }
            if (candidate.theta !== null &&
                    (Number(candle.high) - Number(candidate.candle.low)) / Number(candidate.candle.low) >= candidate.theta) {
                events.push(event(METHOD_IDS.C, 'LOW', candidate.candle, candidate.index,
                    candle.closeTime, i, candidate.theta, {
                        reversalObservationPrice: Number(candle.high),
                        initializationRule: 'AMBIGUOUS_INTRABAR_INIT_RESOLVED_BY_COMPLETED_CLOSE',
                        ambiguousIntrabarInitCount: ambiguousInitCount
                    }));
                direction = 'UP_RUN';
                candidate = makeWickCandidate('HIGH', candle, i, theta[i]);
            }
        }
    }
    return events;
}

function causalPivots(candles) {
    return pivotDetector.detectPivots(candles, { left: 2, right: 2 })
        .map(function (pivot) {
            return Object.assign({}, pivot, { confirmationIndex: pivot.index + 2 });
        })
        .sort(function (a, b) {
            return a.confirmedAt - b.confirmedAt || a.index - b.index || (a.type === 'HIGH' ? -1 : 1);
        });
}

function runD(candles) {
    var theta = thetaSeries(candles), pivots = causalPivots(candles), events = [], endpoint = null;
    pivots.forEach(function (pivot) {
        if (!endpoint) {
            endpoint = pivot;
            return;
        }
        if (pivot.type === endpoint.type) {
            var replaces = pivot.type === 'HIGH' ? pivot.price > endpoint.price : pivot.price < endpoint.price;
            if (replaces) endpoint = pivot;
            return;
        }
        var endpointTheta = theta[endpoint.index];
        if (endpointTheta === null) return;
        var move = endpoint.type === 'LOW' ?
            (pivot.price - endpoint.price) / endpoint.price :
            (endpoint.price - pivot.price) / endpoint.price;
        if (move >= endpointTheta) {
            events.push(event(METHOD_IDS.D, endpoint.type, candles[endpoint.index], endpoint.index,
                pivot.confirmedAt, pivot.confirmationIndex, endpointTheta, {
                    endpointPivotConfirmedAt: endpoint.confirmedAt,
                    reversalPivotOpenTime: pivot.occurredAt,
                    reversalPivotPrice: pivot.price,
                    reversalPct: move
                }));
            endpoint = pivot;
        }
    });
    return events;
}

function isL2(sequence, i, side) {
    if (i < 2 || i + 2 >= sequence.length) return false;
    var value = sequence[i].price;
    if (side === 'HIGH') {
        return value > sequence[i - 1].price && value > sequence[i - 2].price &&
            value >= sequence[i + 1].price && value >= sequence[i + 2].price;
    }
    return value < sequence[i - 1].price && value < sequence[i - 2].price &&
        value <= sequence[i + 1].price && value <= sequence[i + 2].price;
}

function runE(candles) {
    var pivots = causalPivots(candles), events = [];
    ['HIGH', 'LOW'].forEach(function (side) {
        var sameSide = pivots.filter(function (pivot) { return pivot.type === side; })
            .sort(function (a, b) { return a.occurredAt - b.occurredAt; });
        for (var i = 2; i < sameSide.length - 2; i++) {
            if (!isL2(sameSide, i, side)) continue;
            var center = sameSide[i], right2 = sameSide[i + 2];
            events.push(event(METHOD_IDS.E, side, candles[center.index], center.index,
                right2.confirmedAt, right2.confirmationIndex, null, {
                    l1PivotConfirmedAt: center.confirmedAt,
                    rightL1PivotOpenTime: right2.occurredAt,
                    sameSideSequenceIndex: i
                }));
        }
    });
    return events.sort(function (a, b) { return a.confirmedAtMs - b.confirmedAtMs || a.occurredIndex - b.occurredIndex; });
}

function priorConfirmedOpposite(pivots, target, side) {
    var opposite = side === 'LOW' ? 'HIGH' : 'LOW';
    return pivots.filter(function (pivot) {
        return pivot.type === opposite && pivot.occurredAt < target.occurredAt && pivot.confirmedAt <= target.occurredAt;
    }).sort(function (a, b) { return b.occurredAt - a.occurredAt; })[0] || null;
}

function nextOpposite(pivots, target, side) {
    var opposite = side === 'LOW' ? 'HIGH' : 'LOW';
    return pivots.filter(function (pivot) {
        return pivot.type === opposite && pivot.occurredAt > target.occurredAt;
    }).sort(function (a, b) { return a.occurredAt - b.occurredAt; })[0] || null;
}

function runF(candles) {
    var theta = thetaSeries(candles), pivots = causalPivots(candles), events = [];
    pivots.forEach(function (pivot) {
        var left = priorConfirmedOpposite(pivots, pivot, pivot.type);
        var right = nextOpposite(pivots, pivot, pivot.type);
        var snapshot = theta[pivot.index];
        if (!left || !right || snapshot === null) return;
        var leftMove, rightMove, prominence;
        if (pivot.type === 'LOW') {
            leftMove = left.price - pivot.price;
            rightMove = right.price - pivot.price;
        } else {
            leftMove = pivot.price - left.price;
            rightMove = pivot.price - right.price;
        }
        prominence = Math.min(leftMove, rightMove);
        var prominencePct = prominence / pivot.price;
        if (prominencePct < snapshot) return;
        var confirmedAt = Math.max(pivot.confirmedAt, right.confirmedAt);
        events.push(event(METHOD_IDS.F, pivot.type, candles[pivot.index], pivot.index,
            confirmedAt, right.confirmationIndex, snapshot, {
                pivotConfirmedAt: pivot.confirmedAt,
                leftOppositeOpenTime: left.occurredAt,
                leftOppositePrice: left.price,
                rightOppositeOpenTime: right.occurredAt,
                rightOppositePrice: right.price,
                prominence: prominence,
                prominencePct: prominencePct
            }));
    });
    return events.sort(function (a, b) { return a.confirmedAtMs - b.confirmedAtMs || a.occurredIndex - b.occurredIndex; });
}

function runAll(candles, options) {
    var ab = runAandB(candles, options);
    return { A: ab.A, B: ab.B, C: runC(candles), D: runD(candles), E: runE(candles), F: runF(candles) };
}

function comparable(events, cutoff) {
    return events.filter(function (item) { return item.confirmedAtMs <= cutoff; }).map(function (item) {
        return {
            methodId: item.methodId, side: item.side, openTimeMs: item.openTimeMs, price: item.price,
            confirmedAtMs: item.confirmedAtMs, occurredIndex: item.occurredIndex,
            confirmationIndex: item.confirmationIndex, confirmationLagBars: item.confirmationLagBars,
            thetaSnapshot: item.thetaSnapshot, metadata: item.metadata
        };
    });
}

function prefixAudit(candles, full, cutoffs, options) {
    var results = {};
    Object.keys(full).forEach(function (method) { results[method] = { pass: true, checkedCutoffs: cutoffs.length, failures: [] }; });
    cutoffs.forEach(function (index) {
        var prefix = runAll(candles.slice(0, index + 1), options);
        var cutoff = candles[index].closeTime;
        Object.keys(full).forEach(function (method) {
            var expected = JSON.stringify(comparable(full[method], cutoff));
            var actual = JSON.stringify(comparable(prefix[method], cutoff));
            if (expected !== actual) {
                results[method].pass = false;
                results[method].failures.push({ cutoffIndex: index, cutoffCloseTime: cutoff });
            }
        });
    });
    return results;
}

module.exports = {
    BAR_MS: BAR_MS,
    METHOD_IDS: METHOD_IDS,
    iso: iso,
    local: local,
    event: event,
    thetaSeries: thetaSeries,
    chooseWickExtreme: chooseWickExtreme,
    runAandB: runAandB,
    runC: runC,
    causalPivots: causalPivots,
    runD: runD,
    isL2: isL2,
    runE: runE,
    priorConfirmedOpposite: priorConfirmedOpposite,
    nextOpposite: nextOpposite,
    runF: runF,
    runAll: runAll,
    comparable: comparable,
    prefixAudit: prefixAudit
};
