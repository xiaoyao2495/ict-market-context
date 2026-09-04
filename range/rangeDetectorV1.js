/**
 * RANGE_OBJECT_V1 — frozen LuxAlgo-style 5m Range detector.
 *
 * Independent objective fact. It consumes completed OHLC candles only and has
 * no dependency on Bias, AMD, Sweep, WATCH, Entry, or Trade state.
 */
var VERSION = 'RANGE_OBJECT_V1';
var TIMEFRAME = '5m';
var LENGTH = 24;
var MULT = 1.0;
var ATR_LENGTH = 500;

function round(value, places) {
    var scale = Math.pow(10, places);
    return Math.round((value + Number.EPSILON) * scale) / scale;
}

function stableRangeId(symbol, confirmedAt, upper, lower) {
    return [VERSION, symbol, TIMEFRAME, confirmedAt, round(upper, 8), round(lower, 8)].join(':');
}

function clone(value) {
    return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRangeDetectorV1(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    if (!symbol) throw new Error('rangeDetectorV1: symbol is required');

    var freshState = {
        symbol: symbol,
        timeframe: TIMEFRAME,
        version: VERSION,
        barIndex: -1,
        lastOpenTime: null,
        previousClose: null,
        closes: [],
        recentOpenTimes: [],
        atrSeedTrueRanges: [],
        atr: null,
        previousCount: null,
        previousDefined: false,
        activeRange: null,
        ranges: []
    };
    var state = opts.state ? clone(opts.state) : freshState;
    if (state.symbol !== symbol || state.timeframe !== TIMEFRAME || state.version !== VERSION) {
        throw new Error('rangeDetectorV1: incompatible restored state');
    }

    function publicRange(range) {
        if (!range) return null;
        var out = clone(range);
        delete out.lastBarIndex;
        delete out.lastBarTime;
        delete out.initialUpper;
        delete out.initialLower;
        out.upper = round(out.upper, 8);
        out.lower = round(out.lower, 8);
        out.midpoint = round(out.midpoint, 8);
        out.width = round(out.upper - out.lower, 8);
        out.widthPct = round(out.width / out.midpoint * 100, 6);
        return out;
    }

    function makeConfirmedEvent(range) {
        var r = publicRange(range);
        return {
            type: 'RANGE_CONFIRMED',
            symbol: symbol,
            timeframe: TIMEFRAME,
            rangeId: r.id,
            visualStartAt: r.visualStartAt,
            confirmedAt: r.confirmedAt,
            upper: r.upper,
            lower: r.lower,
            midpoint: r.midpoint,
            width: r.width,
            widthPct: r.widthPct,
            parameters: { length: LENGTH, mult: MULT, atrLength: ATR_LENGTH },
            version: VERSION
        };
    }

    function makeBrokenEvent(range) {
        return {
            type: 'RANGE_BROKEN',
            symbol: symbol,
            timeframe: TIMEFRAME,
            rangeId: range.id,
            occurredAt: range.breakoutAt,
            confirmedAt: range.breakoutAt,
            direction: range.breakoutDirection,
            version: VERSION
        };
    }

    function newRange(candle, index, ma, atr) {
        var upper = ma + atr * MULT;
        var lower = ma - atr * MULT;
        var range = {
            id: stableRangeId(symbol, candle.closeTime, upper, lower),
            symbol: symbol,
            timeframe: TIMEFRAME,
            visualStartAt: state.recentOpenTimes[0],
            confirmedAt: candle.closeTime,
            upper: upper,
            lower: lower,
            midpoint: ma,
            width: upper - lower,
            widthPct: (upper - lower) / ma * 100,
            status: 'ACTIVE',
            breakoutAt: null,
            breakoutDirection: null,
            version: VERSION,
            visualStartBarIndex: index - LENGTH,
            confirmedBarIndex: index,
            breakoutBarIndex: null,
            mergedDetectionCount: 1,
            lastBarIndex: index,
            lastBarTime: candle.openTime,
            initialUpper: upper,
            initialLower: lower
        };
        state.ranges.push(range);
        state.activeRange = range;
        return range;
    }

    function onCandle(candle) {
        if (!candle || candle.closed !== true || candle.closeTime === undefined || candle.closeTime === null) {
            throw new Error('rangeDetectorV1: completed candle with closeTime is required');
        }
        if (state.lastOpenTime !== null) {
            if (candle.openTime === state.lastOpenTime) {
                return { status: state.atr === null ? 'NOT_READY' : 'READY', duplicate: true, events: [], activeRange: publicRange(state.activeRange) };
            }
            if (candle.openTime !== state.lastOpenTime + 300000) {
                throw new Error('rangeDetectorV1: non-contiguous 5m candle');
            }
        }

        var index = state.barIndex + 1;
        var close = Number(candle.close);
        var high = Number(candle.high);
        var low = Number(candle.low);
        var tr = state.previousClose === null
            ? high - low
            : Math.max(high - low, Math.abs(high - state.previousClose), Math.abs(low - state.previousClose));
        state.recentOpenTimes.push(candle.openTime);
        if (state.recentOpenTimes.length > LENGTH + 1) state.recentOpenTimes.shift();
        if (index < ATR_LENGTH) state.atrSeedTrueRanges.push(tr);
        state.closes.push(close);
        if (state.closes.length > LENGTH) state.closes.shift();

        if (index === ATR_LENGTH - 1) {
            var seed = 0;
            for (var s = 0; s < ATR_LENGTH; s++) seed += state.atrSeedTrueRanges[s];
            state.atr = seed / ATR_LENGTH;
            state.atrSeedTrueRanges = [];
        } else if (index >= ATR_LENGTH) {
            state.atr = (state.atr * (ATR_LENGTH - 1) + tr) / ATR_LENGTH;
        }

        var defined = state.atr !== null && state.closes.length === LENGTH;
        var ma = null;
        var count = 0;
        if (defined) {
            var total = 0;
            for (var i = 0; i < LENGTH; i++) total += state.closes[i];
            ma = total / LENGTH;
            for (var j = 0; j < LENGTH; j++) {
                if (Math.abs(state.closes[j] - ma) > state.atr * MULT) count++;
            }
        }
        var qualifying = defined && count === 0;
        var transition = defined && count === 0 && state.previousDefined && state.previousCount >= 1;
        var events = [];

        if (state.activeRange) {
            if (transition) {
                if (index - LENGTH <= state.activeRange.lastBarIndex) {
                    state.activeRange.upper = Math.max(state.activeRange.upper, ma + state.atr * MULT);
                    state.activeRange.lower = Math.min(state.activeRange.lower, ma - state.atr * MULT);
                    state.activeRange.width = state.activeRange.upper - state.activeRange.lower;
                    state.activeRange.widthPct = state.activeRange.width / state.activeRange.midpoint * 100;
                    state.activeRange.lastBarIndex = index;
                    state.activeRange.lastBarTime = candle.openTime;
                    state.activeRange.mergedDetectionCount++;
                } else {
                    state.activeRange.status = 'UNBROKEN';
                    var replacement = newRange(candle, index, ma, state.atr);
                    events.push(makeConfirmedEvent(replacement));
                }
            } else if (qualifying) {
                state.activeRange.lastBarIndex = index;
                state.activeRange.lastBarTime = candle.openTime;
            }
        } else if (transition) {
            var created = newRange(candle, index, ma, state.atr);
            events.push(makeConfirmedEvent(created));
        }

        if (state.activeRange && state.activeRange.status === 'ACTIVE') {
            var direction = null;
            if (close > state.activeRange.upper) direction = 'UP';
            else if (close < state.activeRange.lower) direction = 'DOWN';
            if (direction) {
                state.activeRange.status = direction === 'UP' ? 'BROKEN_UP' : 'BROKEN_DOWN';
                state.activeRange.breakoutAt = candle.closeTime;
                state.activeRange.breakoutDirection = direction;
                state.activeRange.breakoutBarIndex = index;
                events.push(makeBrokenEvent(state.activeRange));
                state.activeRange = null;
            }
        }

        state.previousCount = count;
        state.previousDefined = defined;
        state.previousClose = close;
        state.barIndex = index;
        state.lastOpenTime = candle.openTime;
        return {
            status: defined ? 'READY' : 'NOT_READY',
            duplicate: false,
            qualifying: qualifying,
            transition: transition,
            atr: state.atr,
            events: events,
            activeRange: publicRange(state.activeRange)
        };
    }

    return {
        onCandle: onCandle,
        getActiveRange: function () { return publicRange(state.activeRange); },
        getRanges: function () { return state.ranges.map(publicRange); },
        getReadiness: function () { return state.atr === null ? 'NOT_READY' : 'READY'; },
        getState: function () { return clone(state); }
    };
}

module.exports = {
    VERSION: VERSION,
    TIMEFRAME: TIMEFRAME,
    PARAMETERS: { length: LENGTH, mult: MULT, atrLength: ATR_LENGTH },
    createRangeDetectorV1: createRangeDetectorV1,
    stableRangeId: stableRangeId
};
