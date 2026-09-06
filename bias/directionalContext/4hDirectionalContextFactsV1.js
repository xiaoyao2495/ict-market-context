/** Frozen local-only 4H_DIRECTIONAL_CONTEXT_V1 deterministic fact builder. */
var dailyBiasContext = require('../../ai/dailyBiasContext');
var leg = require('./4hDirectionalLegV1');

var SCHEMA_VERSION = 'LLM_INPUT_FACT_SET_V1';
var TIMEFRAME = '4h';
var RAW_COUNT = 32;
var MIN_WARMUP = 300;
var FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function iso(value) {
    return new Date(value).toISOString();
}

function closedPrefix(candles, evaluationTime) {
    var cutoff = typeof evaluationTime === 'number' ? evaluationTime : Date.parse(evaluationTime);
    return (candles || []).filter(function (c) {
        return c.closed === true && c.closeTime < cutoff;
    }).slice().sort(function (a, b) { return a.openTime - b.openTime; });
}

function assertNativeFourHourSequence(candles) {
    (candles || []).forEach(function (c, i) {
        if (c.source !== 'futures') throw new Error('NON_FUTURES_4H_DATA');
        if (c.closeTime !== c.openTime + FOUR_HOURS_MS - 1) {
            throw new Error('NON_NATIVE_4H_CANDLE index=' + i);
        }
        if (i > 0 && c.openTime !== candles[i - 1].openTime + FOUR_HOURS_MS) {
            throw new Error('FOUR_HOUR_DATA_GAP index=' + i);
        }
    });
    return true;
}

function priceDelivery(candles, atr, bars) {
    var t = candles.length - 1;
    if (t - bars < 0 || !isFinite(atr[t])) {
        throw new Error('PRICE_DELIVERY_WARMUP_NOT_READY_' + bars);
    }
    var net = candles[t].close - candles[t - bars].close;
    var travelled = 0;
    for (var i = t - bars + 1; i <= t; i++) {
        travelled += Math.abs(candles[i].close - candles[i - 1].close);
    }
    return {
        signedMoveAtr: net / atr[t],
        signedEfficiency: travelled === 0 ? 0 : net / travelled
    };
}

function mapDirection(value) {
    if (value === 'BULLISH') return 'UP';
    if (value === 'BEARISH') return 'DOWN';
    return 'NEUTRAL';
}

function ageFromConfirmation(candles, confirmedAt) {
    if (!confirmedAt) return null;
    var time = Date.parse(confirmedAt);
    var index = -1;
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].closeTime >= time) {
            index = i;
            break;
        }
    }
    return index < 0 ? null : candles.length - 1 - index;
}

function mapStructuralState(candles, marketFacts) {
    var events = (marketFacts.structuralEvents || []).filter(function (e) {
        return e.stateChanged === true && e.confirmedAt != null;
    }).slice().sort(function (a, b) {
        var d = Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt);
        if (d !== 0) return d;
        return Date.parse(a.eventTime) - Date.parse(b.eventTime);
    });
    var last = events[events.length - 1] || null;
    var current = mapDirection(marketFacts.structuralState);
    if (!last) {
        return {
            direction: current,
            ageBars: null,
            confirmedAt: null,
            lastTransition: null
        };
    }
    return {
        direction: current,
        ageBars: ageFromConfirmation(candles, last.confirmedAt),
        confirmedAt: iso(last.confirmedAt),
        lastTransition: {
            from: mapDirection(last.structuralStateBefore),
            to: mapDirection(last.structuralStateAfter),
            confirmedAt: iso(last.confirmedAt)
        }
    };
}

function rawCandle(c) {
    return {
        openTime: iso(c.openTime),
        closeTime: iso(c.closeTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
    };
}

function assertCausality(input) {
    var cutoff = Date.parse(input.evaluationTime);
    input.rawOhlc32.forEach(function (c) {
        if (Date.parse(c.closeTime) >= cutoff) throw new Error('CAUSALITY_RAW_OHLC');
    });
    ['minor', 'major'].forEach(function (name) {
        var item = input.directionalLegs[name];
        if (item.confirmedAt && Date.parse(item.confirmedAt) > cutoff) {
            throw new Error('CAUSALITY_' + name.toUpperCase());
        }
        var turning = item.lastConfirmedTurningPoint;
        if (turning && Date.parse(turning.confirmedAt) > cutoff) {
            throw new Error('CAUSALITY_' + name.toUpperCase() + '_TURN');
        }
    });
    var structure = input.structuralState;
    if (structure.confirmedAt && Date.parse(structure.confirmedAt) > cutoff) {
        throw new Error('CAUSALITY_STRUCTURE');
    }
    if (structure.lastTransition && Date.parse(structure.lastTransition.confirmedAt) > cutoff) {
        throw new Error('CAUSALITY_STRUCTURE_TRANSITION');
    }
    return true;
}

function buildFacts(candles, evaluationTime, options) {
    var opts = options || {};
    var evaluationMs = typeof evaluationTime === 'number'
        ? evaluationTime : Date.parse(evaluationTime);
    var minimum = opts.minimumWarmup == null ? MIN_WARMUP : opts.minimumWarmup;
    var visible = closedPrefix(candles, evaluationMs);
    if (visible.length < minimum) {
        throw new Error('WARMUP_NOT_READY expected>=' + minimum + ' actual=' + visible.length);
    }
    assertNativeFourHourSequence(visible);
    var latest = visible[visible.length - 1];
    var atrSeries = leg.calculateAtrWilder(visible, 14);
    var atr14 = atrSeries[atrSeries.length - 1];
    if (!isFinite(atr14)) throw new Error('ATR14_WARMUP_NOT_READY');

    var productionContext = dailyBiasContext.buildDailyBiasContext(
        visible, evaluationMs
    );
    var input = {
        schemaVersion: SCHEMA_VERSION,
        symbol: opts.symbol || 'BTCUSDT',
        timeframe: TIMEFRAME,
        evaluationTime: iso(evaluationMs),
        latestClosedCandleTime: iso(latest.closeTime),
        latestClosedCandleOpenTime: iso(latest.openTime),
        latestClosedCandleCloseTime: iso(latest.closeTime),
        closedCandleCountLoaded: visible.length,
        rawOhlcCount: RAW_COUNT,
        rawOhlc32: visible.slice(-RAW_COUNT).map(rawCandle),
        priceDelivery: {
            bars6: priceDelivery(visible, atrSeries, 6),
            bars12: priceDelivery(visible, atrSeries, 12),
            bars24: priceDelivery(visible, atrSeries, 24)
        },
        directionalLegs: {
            minor: leg.calculateDirectionalLeg(visible, atrSeries, 1.5),
            major: leg.calculateDirectionalLeg(visible, atrSeries, 3.0)
        },
        structuralState: mapStructuralState(visible, productionContext.marketFacts),
        volatility: {
            atr14: atr14,
            atr14Pct: atr14 / latest.close
        },
        dataQuality: {
            allCandlesClosed: true,
            causalInputsOnly: true,
            warmupReady: true
        }
    };
    assertCausality(input);
    return input;
}

module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    RAW_COUNT: RAW_COUNT,
    MIN_WARMUP: MIN_WARMUP,
    closedPrefix: closedPrefix,
    assertNativeFourHourSequence: assertNativeFourHourSequence,
    priceDelivery: priceDelivery,
    mapDirection: mapDirection,
    mapStructuralState: mapStructuralState,
    buildFacts: buildFacts,
    assertCausality: assertCausality
};
