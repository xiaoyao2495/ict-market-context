/**
 * BTCUSDT 4H Structural Provenance V1.1 Population Audit（audit-only）。
 *
 * - 逐 4H time-local replay，绝不以最终窗口回写历史。
 * - 不加载 DeepSeek client，不修改 Prompt，不读取 production engine。
 * - 仅统计结构合理性、时间纪律和 pathological cases，不评估盈利。
 */
var fs = require('fs');
var path = require('path');
var auditPivots = require('../ai/auditPivots');
var auditMarketFacts = require('../ai/auditMarketFacts');
var structural = require('../ai/auditStructuralProvenance');

var IV = 14400000;
var DAY = 86400000;
var DAYS = 180;
var REVIEW_SEED = 20260822;
var LONG_GAP_BARS = 30;
var FAN_GAP_BARS = 3;
var KLINES_FILE = path.join('outputs', 'deepseek-4h-bias', 'klines_4h.json');
var OUT_DIR = path.join('outputs', 'structural-provenance-population', 'btc4h_180d_v1_1');
var EXPECTED_V1_1_RECLASSIFIED = [
    ['BEARISH', 66408.1, '2026-02-23'],
    ['BULLISH', 69142.6, '2026-04-06'],
    ['BULLISH', 77873.2, '2026-05-01'],
    ['BEARISH', 80225.1, '2026-05-13'],
    ['BULLISH', 64179.5, '2026-06-13'],
    ['BEARISH', 63650, '2026-06-18'],
    ['BEARISH', 58388, '2026-06-30'],
    ['BEARISH', 63736.1, '2026-07-27']
];

function iso(v) { return new Date(v).toISOString(); }
function ms(v) { return typeof v === 'number' ? v : Date.parse(v); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function monthOf(v) { return iso(v).slice(0, 7); }
function eventKey(e) {
    return [e.type, e.direction, e.referenceLevel, e.eventTime, e.confirmedAt].join('|');
}
function pivotKey(side, p) {
    return [side, p.price, p.occurredAt, p.confirmedAt].join('|');
}
function swingKey(s) {
    return [s.side, s.price, s.occurredAt, s.confirmedAt].join('|');
}
function penetrationKey(p) {
    return [p.side, p.referenceLevel, p.eventTime, p.confirmedAt].join('|');
}

function percentile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    var pos = (sorted.length - 1) * q;
    var lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function distribution(values) {
    var a = values.slice().sort(function (x, y) { return x - y; });
    return {
        n: a.length,
        min: a.length ? a[0] : null,
        p25: percentile(a, 0.25),
        median: percentile(a, 0.5),
        p75: percentile(a, 0.75),
        max: a.length ? a[a.length - 1] : null
    };
}

function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function deterministicSample(rows, count, rng) {
    var a = rows.slice();
    for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(rng() * (i + 1));
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a.slice(0, Math.min(count, a.length));
}

function findCandleIndex(candles, eventTime) {
    var t = ms(eventTime);
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].openTime === t) return i;
    }
    return -1;
}

function compactCandle(c) {
    return {
        openTime: iso(c.openTime),
        open: c.open, high: c.high, low: c.low, close: c.close,
        closeTime: iso(c.closeTime)
    };
}

function latestParentPivot(pivots, swing) {
    var pool = swing.side === 'LOW' ? (pivots.highs || []) : (pivots.lows || []);
    return pool.filter(function (p) {
        return p.price === swing.parentStructuralLevel &&
            p.confirmedAt === swing.parentStructuralConfirmedAt;
    })[0] || null;
}

function activeBefore(result) {
    if (!result) return [];
    return result.protectedSwings.filter(function (s) {
        return s.role.indexOf('ACTIVE_PROTECTED') === 0 && s.status === 'ACTIVE_PROTECTED';
    });
}

function run() {
    var cached = JSON.parse(fs.readFileSync(KLINES_FILE, 'utf8'));
    var candles = (cached.candles || []).filter(function (c) { return c.closed; })
        .sort(function (a, b) { return a.openTime - b.openTime; });
    if (!candles.length) throw new Error('本地 4H candles 为空');

    var endIdx = candles.length - 1;
    var endTime = candles[endIdx].closeTime;
    var startTime = endTime - DAYS * DAY;
    var startIdx = 0;
    while (startIdx < candles.length && candles[startIdx].closeTime < startTime) startIdx++;

    var uniquePivots = {};
    var uniqueBos = {};
    var uniqueMss = {};
    var uniqueContinuation = {};
    var uniqueStructuralContinuation = {};
    var uniquePenetrations = {};
    var swingHistory = {};
    var activeProduced = { LOW: 0, HIGH: 0 };
    var supersededSeen = {};
    var mssRecords = [];
    var continuationRecords = [];
    var snapshotState = [];
    var futureLeakViolations = [];
    var structuralStateViolations = [];
    var pathological = {
        multipleProtectedCrossSameCandle: [],
        outsideBothSidesPenetration: [],
        protectedAndSupersessionSameConfirmation: [],
        bosCandleIsControllingCandidate: [],
        pivotBoundToMultipleBos: [],
        activeBrokenNextBar: [],
        longNoNewProvenance: [],
        highFrequencyMssFan: [],
        activeDroppedFromWindow: []
    };
    var pathologySeen = {
        bosCandleIsControllingCandidate: {},
        protectedAndSupersessionSameConfirmation: {}
    };

    // 用窗口前一根作为 warm-up，只初始化 time-local BEFORE 状态，不计入 180 天统计。
    var previousResult = null;
    if (startIdx > 0) {
        var warmPivots = auditPivots.detectPivots(candles, startIdx - 1, {
            left: 2, right: 2, window: 120
        });
        var warmFacts = auditMarketFacts.computeMarketFacts(candles, startIdx - 1, warmPivots, {
            deliveryHintEnabled: true
        });
        previousResult = structural.computeStructuralProvenance(
            candles, startIdx - 1, warmPivots, { breaks: warmFacts.breaks }
        );
    }
    var previousState = previousResult ? previousResult.structuralState : 'UNCLEAR';
    var previousActiveKeys = {};
    var previousSwingRoles = {};
    if (previousResult) {
        activeBefore(previousResult).forEach(function (s) {
            previousActiveKeys[swingKey(s)] = true;
        });
        previousResult.protectedSwings.forEach(function (s) {
            previousSwingRoles[swingKey(s)] = s.role;
        });
    }

    for (var idx = startIdx; idx <= endIdx; idx++) {
        var candle = candles[idx];
        var pivots = auditPivots.detectPivots(candles, idx, {
            left: 2, right: 2, window: 120
        });
        var facts = auditMarketFacts.computeMarketFacts(candles, idx, pivots, {
            deliveryHintEnabled: true
        });
        var result = structural.computeStructuralProvenance(candles, idx, pivots, {
            breaks: facts.breaks,
            previousSnapshot: previousResult
        });

        if (result.futureLeakViolations.length) {
            futureLeakViolations.push({
                evaluationTime: iso(candle.closeTime),
                violations: clone(result.futureLeakViolations)
            });
        }

        (pivots.highs || []).forEach(function (p) {
            if (ms(p.confirmedAt) >= startTime) uniquePivots[pivotKey('HIGH', p)] = clone(p);
        });
        (pivots.lows || []).forEach(function (p) {
            if (ms(p.confirmedAt) >= startTime) uniquePivots[pivotKey('LOW', p)] = clone(p);
        });

        var newlyProduced = [];
        var newlySuperseded = [];
        var currentSwingRoles = {};
        result.protectedSwings.forEach(function (s) {
            var key = swingKey(s);
            currentSwingRoles[key] = s.role;
            if (!swingHistory[key]) {
                swingHistory[key] = {
                    firstSeenAt: iso(candle.closeTime),
                    first: clone(s),
                    latest: clone(s)
                };
                if (ms(s.protectedConfirmedAt) >= startTime) {
                    activeProduced[s.side]++;
                    newlyProduced.push(key);
                }
            } else {
                swingHistory[key].latest = clone(s);
            }
            var becameSuperseded = s.role.indexOf('SUPERSEDED_PROTECTED') === 0 &&
                previousSwingRoles[key] !== s.role && ms(candle.closeTime) >= startTime;
            if (becameSuperseded && !supersededSeen[key]) {
                supersededSeen[key] = iso(candle.closeTime);
                newlySuperseded.push(key);
            }
            if (s.occurredAt === s.bosCandleTime) {
                var bosControlKey = [key, s.bosCandleTime].join('|');
                if (!pathologySeen.bosCandleIsControllingCandidate[bosControlKey] &&
                    ms(s.protectedConfirmedAt) >= startTime) {
                    pathologySeen.bosCandleIsControllingCandidate[bosControlKey] = true;
                    pathological.bosCandleIsControllingCandidate.push({
                        firstVisibleAt: iso(candle.closeTime), price: s.price,
                        side: s.side, occurredAt: s.occurredAt,
                        bosCandleTime: s.bosCandleTime,
                        protectedConfirmedAt: s.protectedConfirmedAt
                    });
                }
            }
        });

        if (newlyProduced.length && newlySuperseded.length) {
            var sameConfirmKey = [candle.closeTime, newlyProduced.slice().sort().join(','),
                newlySuperseded.slice().sort().join(',')].join('|');
            if (!pathologySeen.protectedAndSupersessionSameConfirmation[sameConfirmKey]) {
                pathologySeen.protectedAndSupersessionSameConfirmation[sameConfirmKey] = true;
                pathological.protectedAndSupersessionSameConfirmation.push({
                    confirmedAt: iso(candle.closeTime),
                    newProtected: newlyProduced,
                    superseded: newlySuperseded
                });
            }
        }
        previousSwingRoles = currentSwingRoles;

        var activeNowKeys = {};
        activeBefore(result).forEach(function (s) { activeNowKeys[swingKey(s)] = true; });
        Object.keys(previousActiveKeys).forEach(function (key) {
            if (!activeNowKeys[key]) {
                var stillPresent = result.protectedSwings.some(function (s) {
                    return swingKey(s) === key;
                });
                if (!stillPresent) {
                    pathological.activeDroppedFromWindow.push({
                        evaluationTime: iso(candle.closeTime), swing: key
                    });
                }
            }
        });
        previousActiveKeys = activeNowKeys;

        var crossed = activeBefore(previousResult).filter(function (s) {
            return s.side === 'LOW' ? candle.low < s.price : candle.high > s.price;
        });
        if (crossed.length > 1) {
            pathological.multipleProtectedCrossSameCandle.push({
                candleTime: iso(candle.openTime),
                crossed: crossed.map(function (s) {
                    return { side: s.side, price: s.price, role: s.role };
                })
            });
        }
        var crossedLow = crossed.some(function (s) { return s.side === 'LOW'; });
        var crossedHigh = crossed.some(function (s) { return s.side === 'HIGH'; });
        if (crossedLow && crossedHigh) {
            pathological.outsideBothSidesPenetration.push({
                candleTime: iso(candle.openTime), high: candle.high, low: candle.low,
                crossed: crossed.map(function (s) { return { side: s.side, price: s.price }; })
            });
        }

        var stateEventsAtClose = [];
        result.structuralEvents.forEach(function (e) {
            if (ms(e.confirmedAt) < startTime) return;
            var key = eventKey(e);
            if (e.type === 'BOS') {
                if (!uniqueBos[key]) uniqueBos[key] = clone(e);
            } else if (e.type === 'STRUCTURAL_MSS' && !uniqueMss[key]) {
                uniqueMss[key] = clone(e);
                stateEventsAtClose.push(e);
                var swing = result.protectedSwings.filter(function (s) {
                    return s.price === e.sourceProtectedSwing.price &&
                        s.occurredAt === e.sourceProtectedSwing.occurredAt &&
                        s.side === e.sourceProtectedSwing.side;
                })[0] || null;
                var parent = swing ? latestParentPivot(pivots, swing) : null;
                var mssIdx = findCandleIndex(candles, e.eventTime);
                var mssCandle = mssIdx >= 0 ? candles[mssIdx] : null;
                var closeBeyondPct = null;
                if (mssCandle) {
                    closeBeyondPct = e.direction === 'BEARISH'
                        ? (e.referenceLevel - mssCandle.close) / e.referenceLevel * 100
                        : (mssCandle.close - e.referenceLevel) / e.referenceLevel * 100;
                }
                var rec = {
                    direction: e.direction,
                    referenceProtectedPrice: e.referenceLevel,
                    protectedOccurredAt: swing ? swing.occurredAt : null,
                    protectedConfirmedAt: swing ? swing.protectedConfirmedAt : null,
                    parentStructuralLevel: swing ? swing.parentStructuralLevel : null,
                    parentStructuralOccurredAt: parent ? parent.occurredAt : null,
                    parentStructuralConfirmedAt: swing ? swing.parentStructuralConfirmedAt : null,
                    bosProvenanceCandle: swing ? swing.bosCandleTime : null,
                    bosClose: swing ? swing.bosClose : null,
                    bosConfirmedAt: swing ? swing.bosConfirmedAt : null,
                    mssCandle: e.eventTime,
                    mssClose: mssCandle ? mssCandle.close : null,
                    mssConfirmedAt: e.confirmedAt,
                    barsFromProtectedConfirmationToMss: swing
                        ? (ms(e.confirmedAt) - ms(swing.protectedConfirmedAt)) / IV : null,
                    closeBeyondDistancePct: closeBeyondPct,
                    previousStructuralState: previousState,
                    nextStructuralState: result.structuralState,
                    structuralStateBefore: e.structuralStateBefore,
                    structuralStateAfter: e.structuralStateAfter,
                    stateChanged: e.stateChanged,
                    referenceRole: e.referenceRole,
                    sourceProtectedSwing: clone(e.sourceProtectedSwing),
                    _mssCandleIdx: mssIdx
                };
                mssRecords.push(rec);

                if (!swing || !mssCandle || ms(swing.protectedConfirmedAt) > mssCandle.openTime) {
                    futureLeakViolations.push({
                        invariant: 'protectedConfirmedAt <= MSS candle openTime', event: rec
                    });
                }
                if (!swing || ms(swing.parentStructuralConfirmedAt) > ms(swing.bosConfirmedAt)) {
                    futureLeakViolations.push({
                        invariant: 'parent confirmedAt <= provenance BOS', event: rec
                    });
                }
                if (!parent || ms(swing.occurredAt) <= ms(parent.occurredAt)) {
                    futureLeakViolations.push({
                        invariant: 'controlling occurred after parent pivot', event: rec
                    });
                }
                if (!swing || ms(swing.occurredAt) >= ms(swing.bosConfirmedAt)) {
                    futureLeakViolations.push({
                        invariant: 'controlling occurred before BOS', event: rec
                    });
                }
                if (e.referenceRole.indexOf('ACTIVE_PROTECTED') !== 0) {
                    structuralStateViolations.push({
                        invariant: 'superseded protected cannot be first MSS reference', event: rec
                    });
                }
                if (e.structuralStateBefore === e.direction || e.stateChanged !== true ||
                    e.structuralStateAfter !== e.direction) {
                    structuralStateViolations.push({
                        invariant: 'STRUCTURAL_MSS must change UNKNOWN/opposite state', event: rec
                    });
                }
                if (!mssCandle || (e.direction === 'BEARISH'
                    ? mssCandle.close >= e.referenceLevel
                    : mssCandle.close <= e.referenceLevel)) {
                    structuralStateViolations.push({
                        invariant: 'wick-only cannot produce MSS', event: rec
                    });
                }
            } else if (e.type === 'STRUCTURAL_CONTINUATION' &&
                !uniqueStructuralContinuation[key]) {
                var continuationSwing = result.protectedSwings.filter(function (s) {
                    return s.price === e.sourceProtectedSwing.price &&
                        s.occurredAt === e.sourceProtectedSwing.occurredAt &&
                        s.side === e.sourceProtectedSwing.side;
                })[0] || null;
                var continuationRecord = clone(e);
                continuationRecord.protectedLifecycle = continuationSwing ? {
                    status: continuationSwing.status,
                    brokenAt: continuationSwing.brokenAt,
                    brokenConfirmedAt: continuationSwing.brokenConfirmedAt,
                    brokenByClose: continuationSwing.brokenByClose,
                    structuralMssReference: continuationSwing.structuralMssReference
                } : null;
                uniqueStructuralContinuation[key] = continuationRecord;
                stateEventsAtClose.push(continuationRecord);
            } else if (e.type === 'CONTINUATION' && !uniqueContinuation[key]) {
                uniqueContinuation[key] = clone(e);
                continuationRecords.push(clone(e));
            }
        });

        result.penetrations.forEach(function (p) {
            if (ms(p.confirmedAt) >= startTime) uniquePenetrations[penetrationKey(p)] = clone(p);
        });

        var hasStateEvent = result.structuralEvents.some(function (e) {
            return (e.type === 'BOS' || e.type === 'STRUCTURAL_MSS') &&
                ms(e.confirmedAt) === candle.closeTime;
        });
        var newContinuationAtClose = result.structuralEvents.some(function (e) {
            return (e.type === 'CONTINUATION' || e.type === 'STRUCTURAL_CONTINUATION') &&
                ms(e.confirmedAt) === candle.closeTime;
        });
        if (newContinuationAtClose && result.structuralState !== previousState && !hasStateEvent) {
            structuralStateViolations.push({
                invariant: 'continuation cannot change structural state',
                candleTime: iso(candle.openTime), previousState: previousState,
                nextState: result.structuralState
            });
        }

        snapshotState.push({
            candleIndex: idx,
            candleTime: iso(candle.openTime),
            evaluationTime: iso(candle.closeTime),
            structuralStateBefore: previousState,
            structuralStateAfter: result.structuralState,
            stateEvents: stateEventsAtClose.map(clone)
        });
        previousState = result.structuralState;
        previousResult = result;
    }

    var bosRows = Object.keys(uniqueBos).map(function (k) { return uniqueBos[k]; });
    var mssRows = mssRecords.slice().sort(function (a, b) {
        return ms(a.mssConfirmedAt) - ms(b.mssConfirmedAt);
    });
    var contRows = Object.keys(uniqueContinuation).map(function (k) { return uniqueContinuation[k]; });
    var structuralContRows = Object.keys(uniqueStructuralContinuation).map(function (k) {
        return uniqueStructuralContinuation[k];
    });
    var actualReclassifiedKeys = structuralContRows.map(function (e) {
        return [e.direction, e.referenceLevel, e.confirmedAt.slice(0, 10)].join('|');
    }).sort();
    var expectedReclassifiedKeys = EXPECTED_V1_1_RECLASSIFIED.map(function (x) {
        return x.join('|');
    }).sort();
    if (JSON.stringify(actualReclassifiedKeys) !== JSON.stringify(expectedReclassifiedKeys)) {
        structuralStateViolations.push({
            invariant: 'V1.1 eight-level population regression',
            expected: expectedReclassifiedKeys,
            actual: actualReclassifiedKeys
        });
    }
    var allContRows = contRows.concat(structuralContRows);
    var penetrationRows = Object.keys(uniquePenetrations).map(function (k) { return uniquePenetrations[k]; });

    var bindings = {};
    bosRows.forEach(function (e) {
        if (!e.sourceProtectedSwing) return;
        var key = [e.sourceProtectedSwing.side, e.sourceProtectedSwing.price,
            e.sourceProtectedSwing.occurredAt].join('|');
        if (!bindings[key]) bindings[key] = [];
        bindings[key].push(e);
    });
    Object.keys(bindings).forEach(function (key) {
        if (bindings[key].length > 1) {
            pathological.pivotBoundToMultipleBos.push({
                controllingSwing: key,
                bosEvents: bindings[key].map(function (e) {
                    return { direction: e.direction, referenceLevel: e.referenceLevel,
                        eventTime: e.eventTime, confirmedAt: e.confirmedAt };
                })
            });
        }
    });

    var allSwings = Object.keys(swingHistory).map(function (k) { return swingHistory[k]; });
    var inRangeSwings = allSwings.filter(function (h) {
        return ms(h.first.protectedConfirmedAt) >= startTime;
    });
    var completedLifetimes = [];
    inRangeSwings.forEach(function (h) {
        var s = h.latest;
        var terminal = s.brokenConfirmedAt || (s.supersededBy != null ? supersededSeen[swingKey(s)] : null);
        if (terminal) {
            var life = (ms(terminal) - ms(s.protectedConfirmedAt)) / IV;
            completedLifetimes.push(life);
            if (s.brokenConfirmedAt && life === 1) {
                pathological.activeBrokenNextBar.push({
                    side: s.side, price: s.price,
                    protectedConfirmedAt: s.protectedConfirmedAt,
                    brokenConfirmedAt: s.brokenConfirmedAt
                });
            }
        }
    });

    var provenanceTimes = inRangeSwings.map(function (h) {
        return ms(h.first.protectedConfirmedAt);
    }).sort(function (a, b) { return a - b; });
    for (var pi = 1; pi < provenanceTimes.length; pi++) {
        var gap = (provenanceTimes[pi] - provenanceTimes[pi - 1]) / IV;
        if (gap >= LONG_GAP_BARS) {
            pathological.longNoNewProvenance.push({
                from: iso(provenanceTimes[pi - 1]), to: iso(provenanceTimes[pi]), bars: gap
            });
        }
    }

    var mssIntervals = [];
    for (var mi = 1; mi < mssRows.length; mi++) {
        var bars = (ms(mssRows[mi].mssConfirmedAt) - ms(mssRows[mi - 1].mssConfirmedAt)) / IV;
        mssIntervals.push(bars);
        if (mssRows[mi].direction !== mssRows[mi - 1].direction && bars <= FAN_GAP_BARS) {
            pathological.highFrequencyMssFan.push({
                from: mssRows[mi - 1].mssConfirmedAt,
                to: mssRows[mi].mssConfirmedAt,
                bars: bars,
                directions: [mssRows[mi - 1].direction, mssRows[mi].direction]
            });
        }
    }

    var monthly = {};
    mssRows.forEach(function (m) {
        var month = monthOf(m.mssConfirmedAt);
        if (!monthly[month]) monthly[month] = { BULLISH: 0, BEARISH: 0, total: 0 };
        monthly[month][m.direction]++;
        monthly[month].total++;
    });

    var rng = mulberry32(REVIEW_SEED);
    var bullishSample = deterministicSample(mssRows.filter(function (m) {
        return m.direction === 'BULLISH';
    }), 10, rng);
    var bearishSample = deterministicSample(mssRows.filter(function (m) {
        return m.direction === 'BEARISH';
    }), 10, rng);
    var reviewDir = path.join(OUT_DIR, 'reviews');
    fs.mkdirSync(reviewDir, { recursive: true });
    var reviewPaths = [];

    bullishSample.concat(bearishSample).forEach(function (m, n) {
        var idx = m._mssCandleIdx;
        var nextMss = mssRows.filter(function (x) {
            return ms(x.mssConfirmedAt) > ms(m.mssConfirmedAt);
        })[0] || null;
        var continuations = allContRows.filter(function (e) {
            return e.direction === m.direction && ms(e.confirmedAt) > ms(m.mssConfirmedAt) &&
                (!nextMss || ms(e.confirmedAt) < ms(nextMss.mssConfirmedAt));
        }).sort(function (a, b) { return ms(a.confirmedAt) - ms(b.confirmedAt); });
        var record = {
            sampleId: (n < bullishSample.length ? 'bullish_' : 'bearish_') +
                String(n < bullishSample.length ? n + 1 : n - bullishSample.length + 1).padStart(2, '0'),
            direction: m.direction,
            parentStructuralLevel: m.parentStructuralLevel,
            controllingSwing: {
                price: m.referenceProtectedPrice,
                occurredAt: m.protectedOccurredAt,
                protectedConfirmedAt: m.protectedConfirmedAt
            },
            bos: {
                candleTime: m.bosProvenanceCandle,
                close: m.bosClose,
                confirmedAt: m.bosConfirmedAt
            },
            mss: clone(m),
            continuationAfterMss: continuations[0] || null,
            candlesBefore20: candles.slice(Math.max(0, idx - 20), idx).map(compactCandle),
            mssCandle: compactCandle(candles[idx]),
            candlesAfter10: candles.slice(idx + 1, Math.min(candles.length, idx + 11)).map(compactCandle)
        };
        delete record.mss._mssCandleIdx;
        var file = path.join(reviewDir, record.sampleId + '_' +
            record.mss.mssCandle.slice(0, 10) + '.json');
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        reviewPaths.push(file);
    });

    var counts = {
        confirmedPivots: Object.keys(uniquePivots).length,
        bullishBosProvenance: bosRows.filter(function (e) { return e.direction === 'BULLISH'; }).length,
        bearishBosProvenance: bosRows.filter(function (e) { return e.direction === 'BEARISH'; }).length,
        activeProtectedLowProduced: activeProduced.LOW,
        activeProtectedHighProduced: activeProduced.HIGH,
        superseded: Object.keys(supersededSeen).length,
        bullishStructuralMss: mssRows.filter(function (e) { return e.direction === 'BULLISH'; }).length,
        bearishStructuralMss: mssRows.filter(function (e) { return e.direction === 'BEARISH'; }).length,
        bullishContinuation: allContRows.filter(function (e) { return e.direction === 'BULLISH'; }).length,
        bearishContinuation: allContRows.filter(function (e) { return e.direction === 'BEARISH'; }).length,
        bullishStructuralContinuation: structuralContRows.filter(function (e) {
            return e.direction === 'BULLISH';
        }).length,
        bearishStructuralContinuation: structuralContRows.filter(function (e) {
            return e.direction === 'BEARISH';
        }).length,
        wickOnlyPenetration: penetrationRows.length
    };

    if (pathological.activeDroppedFromWindow.length) {
        structuralStateViolations.push({
            invariant: 'ACTIVE_PROTECTED must persist beyond 120-bar pivot window',
            cases: clone(pathological.activeDroppedFromWindow)
        });
    }

    var summary = {
        symbol: 'BTCUSDT', timeframe: '4h', days: DAYS,
        source: KLINES_FILE,
        sourceTag: cached.source || null,
        replayMode: 'BAR_BY_BAR_TIME_LOCAL',
        deepSeekApiCalled: false,
        algorithm: 'Structural Provenance V1.1 (state-gated MSS emission)',
        startIndex: startIdx, endIndex: endIdx,
        startEvaluationTime: iso(candles[startIdx].closeTime),
        endEvaluationTime: iso(endTime),
        replayBars: endIdx - startIdx + 1,
        counts: counts,
        distributions: {
            mssIntervalBars: distribution(mssIntervals),
            completedProtectedLifetimeBars: distribution(completedLifetimes),
            completedProtectedLifetimeCount: completedLifetimes.length,
            censoredProtectedCount: inRangeSwings.length - completedLifetimes.length
        },
        monthlyMss: monthly,
        auditThresholdsOnly: {
            longNoNewProvenanceBars: LONG_GAP_BARS,
            highFrequencyMssFanBars: FAN_GAP_BARS
        },
        diagnostics: {
            POPULATION_AUDIT_PASS: futureLeakViolations.length === 0 && structuralStateViolations.length === 0,
            FUTURE_LEAK_VIOLATIONS: futureLeakViolations.length,
            STRUCTURAL_STATE_VIOLATIONS: structuralStateViolations.length,
            PATHOLOGICAL_CASES: Object.keys(pathological).reduce(function (o, k) {
                o[k] = pathological[k].length; return o;
            }, {}),
            BULLISH_MSS_COUNT: counts.bullishStructuralMss,
            BEARISH_MSS_COUNT: counts.bearishStructuralMss,
            V1_1_RECLASSIFIED_COUNT: structuralContRows.length,
            ACTIVE_DROPPED_FROM_WINDOW: pathological.activeDroppedFromWindow.length,
            REVIEW_SAMPLE_PATHS: reviewPaths
        }
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'mss_records.json'), JSON.stringify(mssRows.map(function (m) {
        var x = clone(m); delete x._mssCandleIdx; return x;
    }), null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'continuation_records.json'), JSON.stringify(contRows, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'structural_continuation_records.json'), JSON.stringify(structuralContRows, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'v1_1_regression_comparison.json'), JSON.stringify(
        structuralContRows.map(function (e) {
            return {
                direction: e.direction,
                referenceLevel: e.referenceLevel,
                confirmedAt: e.confirmedAt,
                before: { type: 'STRUCTURAL_MSS', stateChanged: true },
                after: {
                    type: e.type,
                    structuralStateBefore: e.structuralStateBefore,
                    structuralStateAfter: e.structuralStateAfter,
                    stateChanged: e.stateChanged,
                    protectedLifecycle: e.protectedLifecycle
                }
            };
        }), null, 2
    ));
    fs.writeFileSync(path.join(OUT_DIR, 'pathological_cases.json'), JSON.stringify(pathological, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'future_leak_violations.json'), JSON.stringify(futureLeakViolations, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'structural_state_violations.json'), JSON.stringify(structuralStateViolations, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'review_index.json'), JSON.stringify(reviewPaths, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'time_local_snapshots.json'), JSON.stringify(snapshotState, null, 2));

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.diagnostics.POPULATION_AUDIT_PASS) process.exitCode = 1;
    return summary;
}

if (require.main === module) run();

module.exports = { run: run };
