/**
 * Causal ATR-scaled directional leg state for closed candles.
 * A turning point is confirmed only by a later closed candle whose opposite
 * excursion reaches multiplier * that candle's current Wilder ATR14.
 */

function trueRange(candle, previousClose) {
    var range = candle.high - candle.low;
    if (previousClose === null || previousClose === undefined) return range;
    return Math.max(
        range,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
    );
}

function calculateAtrWilder(candles, period) {
    var p = period || 14;
    var trs = [];
    var atr = new Array((candles || []).length).fill(null);
    (candles || []).forEach(function (c, i) {
        trs.push(trueRange(c, i === 0 ? null : candles[i - 1].close));
    });
    if (trs.length < p) return atr;

    var initial = 0;
    for (var i = 0; i < p; i++) initial += trs[i];
    atr[p - 1] = initial / p;
    for (var k = p; k < trs.length; k++) {
        atr[k] = (atr[k - 1] * (p - 1) + trs[k]) / p;
    }
    return atr;
}

function unavailable() {
    return {
        direction: 'UNAVAILABLE',
        ageBars: null,
        confirmedAt: null,
        lastConfirmedTurningPoint: null
    };
}

function calculateDirectionalLeg(candles, atrSeries, multiplier) {
    var first = -1;
    for (var i = 0; i < (atrSeries || []).length; i++) {
        if (atrSeries[i] !== null && isFinite(atrSeries[i])) {
            first = i;
            break;
        }
    }
    if (first < 0 || first >= candles.length) return unavailable();

    // Initial direction is only a causal search state. It is never emitted
    // until an opposite excursion confirms the first turning point.
    var priorClose = first > 0 ? candles[first - 1].close : candles[first].open;
    var searchDirection = candles[first].close >= priorClose ? 'UP' : 'DOWN';
    var runningHigh = { price: candles[first].high, index: first };
    var runningLow = { price: candles[first].low, index: first };
    var active = null;

    for (var k = first + 1; k < candles.length; k++) {
        var c = candles[k];
        var threshold = multiplier * atrSeries[k];
        if (!isFinite(threshold)) continue;

        if (searchDirection === 'UP') {
            // Test reversal against the previously known extreme. This avoids
            // inventing intrabar high/low ordering from an OHLC candle.
            if (runningHigh.price - c.low >= threshold) {
                active = {
                    direction: 'DOWN',
                    ageBars: candles.length - 1 - k,
                    confirmedAt: new Date(c.closeTime).toISOString(),
                    lastConfirmedTurningPoint: {
                        type: 'HIGH',
                        price: runningHigh.price,
                        occurredAt: new Date(candles[runningHigh.index].openTime).toISOString(),
                        confirmedAt: new Date(c.closeTime).toISOString()
                    },
                    _confirmationIndex: k
                };
                searchDirection = 'DOWN';
                runningLow = { price: c.low, index: k };
                runningHigh = { price: c.high, index: k };
            } else if (c.high > runningHigh.price) {
                runningHigh = { price: c.high, index: k };
            }
        } else {
            if (c.high - runningLow.price >= threshold) {
                active = {
                    direction: 'UP',
                    ageBars: candles.length - 1 - k,
                    confirmedAt: new Date(c.closeTime).toISOString(),
                    lastConfirmedTurningPoint: {
                        type: 'LOW',
                        price: runningLow.price,
                        occurredAt: new Date(candles[runningLow.index].openTime).toISOString(),
                        confirmedAt: new Date(c.closeTime).toISOString()
                    },
                    _confirmationIndex: k
                };
                searchDirection = 'UP';
                runningHigh = { price: c.high, index: k };
                runningLow = { price: c.low, index: k };
            } else if (c.low < runningLow.price) {
                runningLow = { price: c.low, index: k };
            }
        }
    }

    if (!active) return unavailable();
    delete active._confirmationIndex;
    return active;
}

module.exports = {
    trueRange: trueRange,
    calculateAtrWilder: calculateAtrWilder,
    calculateDirectionalLeg: calculateDirectionalLeg
};
