'use strict';

/**
 * Production causal ATR50 ZigZag state.
 *
 * Reversal threshold at each completed 5m close is 0.50 × the latest causally
 * available completed 4H Wilder ATR(14). Confirmed points are immutable;
 * ACTIVE/VIOLATED is objective survival state, not EQ identity or lifecycle.
 */
var atrIndicator = require('../indicators/atr');

var ATR_PERIOD = 14;
var ATR_MULTIPLIER = 0.5;
var VERSION = 'CAUSAL_ATR50_ZIGZAG_V1';

function createState(options) {
    var opts = options || {};
    return {
        version: VERSION,
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        fourHourCandles: opts.fourHourCandles || [],
        fourHourIndex: -1,
        fourHourAtrSeedSum: 0,
        fourHourAtrValue: null,
        fourHourAtrCandleCloseTime: null,
        lastFiveMinuteIndex: -1,
        initialized: false,
        direction: null,
        high: null,
        low: null,
        activeExtreme: null,
        confirmedPoints: [],
        recentSurvivalPoints: [],
        confirmedPointById: {}
    };
}

function numeric(value) { return Number(value); }

function advanceFourHourAtr(state, evaluationTime) {
    var rows = state.fourHourCandles || [];
    while (state.fourHourIndex + 1 < rows.length) {
        var nextIndex = state.fourHourIndex + 1;
        var candle = rows[nextIndex];
        if (!candle || candle.closed === false || candle.closeTime > evaluationTime) break;
        state.fourHourIndex = nextIndex;
        if (nextIndex > 0) {
            var tr = atrIndicator.trueRange(candle, rows[nextIndex - 1]);
            if (nextIndex <= ATR_PERIOD) state.fourHourAtrSeedSum += tr;
            if (nextIndex === ATR_PERIOD) {
                state.fourHourAtrValue = state.fourHourAtrSeedSum / ATR_PERIOD;
            } else if (nextIndex > ATR_PERIOD && state.fourHourAtrValue !== null) {
                state.fourHourAtrValue = (
                    state.fourHourAtrValue * (ATR_PERIOD - 1) + tr
                ) / ATR_PERIOD;
            }
        }
        if (state.fourHourAtrValue !== null) {
            state.fourHourAtrCandleCloseTime = candle.closeTime;
        }
    }
    return state.fourHourAtrValue;
}

function envelope(candle, index) {
    return { candle: candle, index: index };
}

function violationFor(point, candle) {
    if (!candle || candle.closed === false || candle.openTime <= point.occurredAt) return null;
    if (point.pointSide === 'HIGH' && numeric(candle.high) > point.price) {
        return {
            violatedAt: candle.openTime,
            violationConfirmedAt: candle.closeTime,
            violationPrice: numeric(candle.high),
            violationType: 'TRADED_ABOVE_HISTORICAL_HIGH'
        };
    }
    if (point.pointSide === 'LOW' && numeric(candle.low) < point.price) {
        return {
            violatedAt: candle.openTime,
            violationConfirmedAt: candle.closeTime,
            violationPrice: numeric(candle.low),
            violationType: 'TRADED_BELOW_HISTORICAL_LOW'
        };
    }
    return null;
}

function applyViolation(point, violation) {
    if (!violation || point.status === 'VIOLATED') return false;
    point.status = 'VIOLATED';
    point.violatedAt = violation.violatedAt;
    point.violationConfirmedAt = violation.violationConfirmedAt;
    point.violationPrice = violation.violationPrice;
    point.violationType = violation.violationType;
    return true;
}

function pointId(state, side, extreme) {
    return [
        'ATR50', state.symbol, state.timeframe, side,
        extreme.candle.openTime, numeric(extreme.candle.close)
    ].join(':');
}

function buildPoint(state, side, extreme, confirmationCandle, confirmationIndex, fiveMinuteCandles) {
    var id = pointId(state, side, extreme);
    var point = {
        id: id,
        source: 'CAUSAL_ATR50_ZIGZAG',
        symbol: state.symbol,
        timeframe: state.timeframe,
        pointSide: side,
        type: side === 'HIGH' ? 'ATR50_ZIGZAG_HIGH' : 'ATR50_ZIGZAG_LOW',
        price: numeric(extreme.candle.close),
        occurredAt: extreme.candle.openTime,
        confirmedAt: confirmationCandle.closeTime,
        occurredBarIndex: extreme.index,
        confirmationBarIndex: confirmationIndex,
        atrTimeframe: '4h',
        atrPeriod: ATR_PERIOD,
        atrMethod: 'WILDER_ATR',
        atr4hAtConfirmation: state.fourHourAtrValue,
        atr4hCandleCloseTime: state.fourHourAtrCandleCloseTime,
        atrMultiplier: ATR_MULTIPLIER,
        thresholdPriceAtConfirmation: state.fourHourAtrValue * ATR_MULTIPLIER,
        status: 'ACTIVE',
        violatedAt: null,
        violationConfirmedAt: null,
        violationPrice: null,
        violationType: null
    };
    for (var i = extreme.index + 1; i <= confirmationIndex; i++) {
        var violation = violationFor(point, fiveMinuteCandles[i]);
        if (violation) {
            applyViolation(point, violation);
            break;
        }
    }
    return point;
}

function updateConfirmedPointSurvival(state, candle) {
    state.recentSurvivalPoints.forEach(function (point) {
        if (point.status !== 'ACTIVE') return;
        applyViolation(point, violationFor(point, candle));
    });
}

function registerPoint(state, point) {
    if (state.confirmedPointById[point.id]) return null;
    state.confirmedPointById[point.id] = point;
    state.confirmedPoints.push(point);
    state.recentSurvivalPoints.push(point);
    return point;
}

function pruneSurvivalBeforeBar(state, minimumOccurredBarIndex) {
    state.recentSurvivalPoints = state.recentSurvivalPoints.filter(function (point) {
        return point.occurredBarIndex >= minimumOccurredBarIndex;
    });
}

function step(state, candle, index, fiveMinuteCandles) {
    if (!candle || candle.closed === false) return [];
    if (index !== state.lastFiveMinuteIndex + 1) {
        throw new Error(VERSION + ' requires continuous incremental 5m indexes');
    }
    state.lastFiveMinuteIndex = index;
    advanceFourHourAtr(state, candle.closeTime);
    updateConfirmedPointSurvival(state, candle);

    if (!state.initialized) {
        state.initialized = true;
        state.high = envelope(candle, index);
        state.low = envelope(candle, index);
        state.activeExtreme = envelope(candle, index);
        return [];
    }

    var close = numeric(candle.close);
    if (state.direction === null) {
        if (close > numeric(state.high.candle.close)) state.high = envelope(candle, index);
        if (close < numeric(state.low.candle.close)) state.low = envelope(candle, index);
    }
    if (!(state.fourHourAtrValue > 0)) return [];

    var threshold = state.fourHourAtrValue * ATR_MULTIPLIER;
    var emitted = [];
    if (state.direction === null) {
        if (close - numeric(state.low.candle.close) >= threshold) {
            emitted.push(registerPoint(state, buildPoint(
                state, 'LOW', state.low, candle, index, fiveMinuteCandles
            )));
            state.direction = 'UPTREND';
            state.activeExtreme = envelope(candle, index);
        } else if (numeric(state.high.candle.close) - close >= threshold) {
            emitted.push(registerPoint(state, buildPoint(
                state, 'HIGH', state.high, candle, index, fiveMinuteCandles
            )));
            state.direction = 'DOWNTREND';
            state.activeExtreme = envelope(candle, index);
        }
    } else if (state.direction === 'UPTREND') {
        if (close > numeric(state.activeExtreme.candle.close)) state.activeExtreme = envelope(candle, index);
        if (numeric(state.activeExtreme.candle.close) - close >= threshold) {
            emitted.push(registerPoint(state, buildPoint(
                state, 'HIGH', state.activeExtreme, candle, index, fiveMinuteCandles
            )));
            state.direction = 'DOWNTREND';
            state.activeExtreme = envelope(candle, index);
        }
    } else {
        if (close < numeric(state.activeExtreme.candle.close)) state.activeExtreme = envelope(candle, index);
        if (close - numeric(state.activeExtreme.candle.close) >= threshold) {
            emitted.push(registerPoint(state, buildPoint(
                state, 'LOW', state.activeExtreme, candle, index, fiveMinuteCandles
            )));
            state.direction = 'UPTREND';
            state.activeExtreme = envelope(candle, index);
        }
    }
    return emitted.filter(Boolean);
}

module.exports = {
    VERSION: VERSION,
    ATR_PERIOD: ATR_PERIOD,
    ATR_MULTIPLIER: ATR_MULTIPLIER,
    createState: createState,
    advanceFourHourAtr: advanceFourHourAtr,
    violationFor: violationFor,
    pruneSurvivalBeforeBar: pruneSurvivalBeforeBar,
    step: step
};
