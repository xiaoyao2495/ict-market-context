'use strict';

var pivotDetector = require('../structure/pivotDetector');
var atr = require('../indicators/atr');
var establishment = require('../research/trend-establishment-minimal-escape-v1-1/lib/trendEstablishmentMinimalEscapeV1_1');
var lifecycle = require('../research/trend-lifecycle-protected-structure-v3-1/lib/trendLifecycleProtectedStructureV3_1');

var VERSION = 'MARKET_STATE_MAP_V1';
var ESTABLISHMENT_VERSION = 'TREND_ESTABLISHMENT_MINIMAL_ESCAPE_V1_1';
var LIFECYCLE_VERSION = lifecycle.VERSION;
var BAR_MS = 300000;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function clean(pivot) { return pivot ? { type: pivot.type, price: pivot.price, occurredAt: pivot.occurredAt, confirmedAt: pivot.confirmedAt } : null; }
function progression(list) { return list.length < 2 ? null : list[list.length - 1].price > list[list.length - 2].price ? 'UP' : list[list.length - 1].price < list[list.length - 2].price ? 'DOWN' : 'FLAT'; }
function directionFor(high, low) { return high === 'UP' && low === 'UP' ? 'BULLISH' : high === 'DOWN' && low === 'DOWN' ? 'BEARISH' : null; }
function latestPre(pivots, type, pivot) {
    return pivots.filter(function (x) { return x.type === type && x.confirmedAt <= pivot.confirmedAt && x.occurredAt < pivot.occurredAt; })
        .sort(function (a, b) { return b.occurredAt - a.occurredAt || b.confirmedAt - a.confirmedAt; })[0] || null;
}

function structure(visible, candles, index) {
    var highs = visible.filter(function (x) { return x.type === 'HIGH'; }).slice(-2);
    var lows = visible.filter(function (x) { return x.type === 'LOW'; }).slice(-2);
    var pivots = highs.concat(lows).sort(function (a, b) { return a.occurredAt - b.occurredAt || a.confirmedAt - b.confirmedAt; });
    var atr14 = atr.atr(candles, 14, index), legs = [];
    for (var i = 1; i < pivots.length; i++) {
        var from = pivots[i - 1], to = pivots[i], delta = to.price - from.price;
        legs.push({ fromType: from.type, fromPrice: from.price, fromOccurredAt: from.occurredAt,
            toType: to.type, toPrice: to.price, toOccurredAt: to.occurredAt,
            direction: delta > 0 ? 'UP' : delta < 0 ? 'DOWN' : 'FLAT',
            bars: Math.round((to.occurredAt - from.occurredAt) / BAR_MS),
            priceDelta: delta, priceDeltaAtr: atr14 ? delta / atr14 : null });
    }
    return { atr14: atr14, latestTwoHighs: highs.map(clean), latestTwoLows: lows.map(clean),
        highProgression: progression(highs), lowProgression: progression(lows),
        structurePivots: pivots.map(clean), structureLegs: legs };
}

function packet(candles, index, visible, direction, allPivots) {
    var candle = candles[index], s = structure(visible, candles, index);
    if (!s.atr14 || s.latestTwoHighs.length !== 2 || s.latestTwoLows.length !== 2) return null;
    var high0 = s.latestTwoHighs[0], high1 = s.latestTwoHighs[1], low0 = s.latestTwoLows[0], low1 = s.latestTwoLows[1];
    return establishment.build({ scope: 'PRODUCTION_LIVE', evaluationTime: candle.closeTime,
        candidateDirection: direction, currentClose: candle.close, atr14: s.atr14,
        previousHigh: high0, currentHigh: high1, highDelta: high1.price - high0.price,
        highDeltaAtr: (high1.price - high0.price) / s.atr14, highProgression: s.highProgression,
        previousLow: low0, currentLow: low1, lowDelta: low1.price - low0.price,
        lowDeltaAtr: (low1.price - low0.price) / s.atr14, lowProgression: s.lowProgression,
        structurePivots: s.structurePivots, structureLegs: s.structureLegs }, allPivots);
}

function createEngine(options) {
    var opts = options || {};
    var decide = opts.decide;
    if (typeof decide !== 'function') throw new Error('MARKET_STATE_LLM1_DECISION_PROVIDER_REQUIRED');
    var candles = [], snapshots = [], transitions = [], state = null, lastEvaluationTime = null, lifecycleNumber = 0;

    function snapshot(candle) {
        var trend = state.kind === 'TREND';
        return { version: VERSION, evaluationTime: candle.closeTime,
            state: trend ? (state.direction === 'BULLISH' ? 'BULL_TREND' : 'BEAR_TREND') : 'RANGE',
            stateSince: state.segmentStart, trendEstablishedAt: trend ? state.establishedAt : null,
            activeProtectedType: trend && state.activeProtected ? (state.direction === 'BULLISH' ? 'LOW' : 'HIGH') : null,
            activeProtectedPrice: trend && state.activeProtected ? state.activeProtected.price : null,
            protectedStatus: trend ? state.protectedStatus : null };
    }

    async function onClosedCandle(candle) {
        if (!candle || candle.closeTime !== candle.openTime + BAR_MS - 1 || candle.closed === false) throw new Error('MARKET_STATE_REQUIRES_FULLY_CLOSED_5M');
        if (lastEvaluationTime !== null) {
            if (candle.closeTime === lastEvaluationTime) return { status: 'DUPLICATE', snapshot: clone(snapshots[snapshots.length - 1]) };
            if (candle.closeTime < lastEvaluationTime) return { status: 'OLDER_IGNORED', snapshot: clone(snapshots[snapshots.length - 1]) };
            if (candle.openTime !== candles[candles.length - 1].openTime + BAR_MS) throw new Error('MARKET_STATE_5M_GAP');
        }
        candles.push(clone(candle));
        var index = candles.length - 1, evaluationTime = candle.closeTime;
        if (!state) state = { kind: 'RANGE', segmentStart: candle.openTime };
        var allPivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
        var newly = allPivots.filter(function (x) { return x.confirmedAt > (lastEvaluationTime === null ? -1 : lastEvaluationTime) && x.confirmedAt <= evaluationTime; });
        var visible = allPivots.filter(function (x) { return x.confirmedAt >= state.segmentStart && x.confirmedAt <= evaluationTime; });
        var s = structure(visible, candles, index), consumed = 0, transition = null;
        if (state.kind === 'RANGE') {
            var candidate = directionFor(s.highProgression, s.lowProgression);
            if (newly.length && candidate) {
                var built = packet(candles, index, visible, candidate, allPivots);
                if (built) {
                    var decision = await decide(built, candidate, evaluationTime);
                    if (decision.response.decision === 'ESTABLISHED') {
                        lifecycleNumber++;
                        var point = clean((candidate === 'BULLISH' ? s.latestTwoLows : s.latestTwoHighs).slice(-1)[0]);
                        var extreme = clean((candidate === 'BULLISH' ? s.latestTwoHighs : s.latestTwoLows).slice(-1)[0]);
                        var initialized = lifecycle.initialize(candidate, candle.close, point, extreme, evaluationTime);
                        state = { kind: 'TREND', direction: candidate, establishedAt: evaluationTime,
                            segmentStart: evaluationTime, lifecycleId: 'L' + String(lifecycleNumber).padStart(3, '0'),
                            activeProtected: initialized.activeProtected, protectedStatus: initialized.protectedStatus,
                            protectedActivatedAt: initialized.protectedActivatedAt,
                            confirmingExtreme: initialized.confirmingExtreme,
                            rejectedCandidateIdentity: initialized.rejectedCandidateIdentity,
                            relevantHigh: clean(s.latestTwoHighs.slice(-1)[0]), relevantLow: clean(s.latestTwoLows.slice(-1)[0]), wick: false };
                        consumed = lifecycle.consume(consumed);
                        transition = { evaluationTime: evaluationTime, from: 'RANGE',
                            to: candidate === 'BULLISH' ? 'BULL_TREND' : 'BEAR_TREND', direction: candidate,
                            reason: 'TREND_ESTABLISHED', requestKey: decision.requestKey,
                            packetSHA256: decision.packetSHA256 };
                    }
                }
            }
        } else {
            for (var n = 0; n < newly.length; n++) {
                var pivot = newly[n], protectedCandidate = null;
                if (state.direction === 'BULLISH' && pivot.type === 'HIGH' && pivot.price > state.relevantHigh.price) {
                    protectedCandidate = latestPre(allPivots, 'LOW', pivot); state.relevantHigh = clean(pivot);
                }
                if (state.direction === 'BEARISH' && pivot.type === 'LOW' && pivot.price < state.relevantLow.price) {
                    protectedCandidate = latestPre(allPivots, 'HIGH', pivot); state.relevantLow = clean(pivot);
                }
                if (protectedCandidate) {
                    var updated = lifecycle.activateOrRatchet({ direction: state.direction,
                        activeProtected: state.activeProtected, protectedStatus: state.protectedStatus,
                        protectedActivatedAt: state.protectedActivatedAt,
                        confirmingExtreme: state.confirmingExtreme,
                        rejectedCandidateIdentity: state.rejectedCandidateIdentity },
                    clean(protectedCandidate), clean(pivot), candle.close, evaluationTime);
                    state.activeProtected = updated.state.activeProtected;
                    state.protectedStatus = updated.state.protectedStatus;
                    state.protectedActivatedAt = updated.state.protectedActivatedAt;
                    state.confirmingExtreme = updated.state.confirmingExtreme;
                    state.rejectedCandidateIdentity = updated.state.rejectedCandidateIdentity;
                    if (updated.result === 'UPDATE' || updated.result === 'RECONFIRMED') state.wick = false;
                }
            }
            var death = lifecycle.evaluateInvalidation({ direction: state.direction,
                activeProtected: state.activeProtected }, candle);
            if (death.wickBreak) state.wick = true;
            if (death.invalidated) {
                var oldDirection = state.direction, protectedPrice = state.activeProtected.price;
                consumed = lifecycle.consume(consumed);
                state = { kind: 'RANGE', segmentStart: evaluationTime };
                transition = { evaluationTime: evaluationTime,
                    from: oldDirection === 'BULLISH' ? 'BULL_TREND' : 'BEAR_TREND', to: 'RANGE',
                    direction: oldDirection, reason: 'ACTIVE_PROTECTED_CLOSE_BREAK', protectedPrice: protectedPrice };
            }
        }
        if (consumed > lifecycle.MAX_LIFECYCLE_TRANSITIONS_PER_EVALUATION) throw new Error('MARKET_STATE_TRANSITION_LIMIT');
        lastEvaluationTime = evaluationTime;
        var row = snapshot(candle); snapshots.push(row);
        if (transition) transitions.push(transition);
        return { status: 'PROCESSED', snapshot: clone(row), transition: clone(transition) };
    }

    async function replay(rows) {
        for (var i = 0; i < rows.length; i++) await onClosedCandle(rows[i]);
        return getResult();
    }
    function getResult() { return { snapshots: clone(snapshots), transitions: clone(transitions),
        current: snapshots.length ? clone(snapshots[snapshots.length - 1]) : null,
        latestEvaluationTime: lastEvaluationTime }; }
    return { onClosedCandle: onClosedCandle, replay: replay, getResult: getResult,
        versions: { map: VERSION, establishment: ESTABLISHMENT_VERSION, lifecycle: LIFECYCLE_VERSION } };
}

module.exports = { VERSION: VERSION, ESTABLISHMENT_VERSION: ESTABLISHMENT_VERSION,
    LIFECYCLE_VERSION: LIFECYCLE_VERSION, BAR_MS: BAR_MS, createEngine: createEngine,
    structure: structure, directionFor: directionFor };
