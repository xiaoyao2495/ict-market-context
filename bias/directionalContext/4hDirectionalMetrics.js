'use strict';

var leg = require('./4hDirectionalLegV1');

function finite(value) {
    return typeof value === 'number' && isFinite(value);
}

/** Existing Production delivery formula, shared by V2 provenance and V3. */
function priceDelivery(candles, atr, bars) {
    var t = candles.length - 1;
    if (t - bars < 0 || !finite(atr[t])) {
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

/** Frozen Wilder DMI14/ADX14 semantics transferred from the mature benchmark. */
function dmiAdx(candles, period, adxPeriod) {
    var p = period || 14;
    var ap = adxPeriod || 14;
    var n = (candles || []).length;
    var tr = new Array(n).fill(null);
    var plusDm = new Array(n).fill(0);
    var minusDm = new Array(n).fill(0);
    var plusDi = new Array(n).fill(null);
    var minusDi = new Array(n).fill(null);
    var dx = new Array(n).fill(null);
    var adx = new Array(n).fill(null);
    for (var i = 1; i < n; i++) {
        tr[i] = leg.trueRange(candles[i], candles[i - 1].close);
        var up = candles[i].high - candles[i - 1].high;
        var down = candles[i - 1].low - candles[i].low;
        plusDm[i] = up > down && up > 0 ? up : 0;
        minusDm[i] = down > up && down > 0 ? down : 0;
    }
    if (n <= p) return { plusDI: plusDi, minusDI: minusDi, adx: adx };
    var smTr = 0;
    var smPlus = 0;
    var smMinus = 0;
    for (i = 1; i <= p; i++) {
        smTr += tr[i];
        smPlus += plusDm[i];
        smMinus += minusDm[i];
    }
    function setDi(index) {
        plusDi[index] = smTr === 0 ? 0 : 100 * smPlus / smTr;
        minusDi[index] = smTr === 0 ? 0 : 100 * smMinus / smTr;
        var denominator = plusDi[index] + minusDi[index];
        dx[index] = denominator === 0 ? 0 : 100 * Math.abs(plusDi[index] - minusDi[index]) / denominator;
    }
    setDi(p);
    for (i = p + 1; i < n; i++) {
        smTr = smTr - smTr / p + tr[i];
        smPlus = smPlus - smPlus / p + plusDm[i];
        smMinus = smMinus - smMinus / p + minusDm[i];
        setDi(i);
    }
    var firstAdx = p + ap - 1;
    if (firstAdx < n) {
        var sum = 0;
        for (i = p; i <= firstAdx; i++) sum += dx[i];
        adx[firstAdx] = sum / ap;
        for (i = firstAdx + 1; i < n; i++) {
            adx[i] = (adx[i - 1] * (ap - 1) + dx[i]) / ap;
        }
    }
    return { plusDI: plusDi, minusDI: minusDi, adx: adx };
}

function normalizedDirectionalSpread(plusDi, minusDi) {
    if (!finite(plusDi) || !finite(minusDi)) throw new Error('DMI14_WARMUP_NOT_READY');
    var denominator = plusDi + minusDi;
    return denominator === 0 ? 0 : (plusDi - minusDi) / denominator;
}

module.exports = {
    priceDelivery: priceDelivery,
    dmiAdx: dmiAdx,
    normalizedDirectionalSpread: normalizedDirectionalSpread
};
