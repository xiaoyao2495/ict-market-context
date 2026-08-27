'use strict';
var assert = require('assert');
var shadow = require('../audit/eqPersistentClusterShadowV3');

function candle(i, high, low, close) {
    return {
        openTime: i * 300000,
        closeTime: (i + 1) * 300000 - 1,
        open: close,
        high: high,
        low: low,
        close: close,
        closed: true,
        source: 'synthetic'
    };
}

function swing(id, type, price, index) {
    return {
        id: id,
        type: type,
        side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: price,
        sourceOpenTime: index * 300000,
        sourceCloseTime: (index + 1) * 300000 - 1,
        confirmedAt: (index + 3) * 300000 - 1,
        metadata: { index: index, right: 2 }
    };
}

var candles = [];
for (var i = 0; i < 40; i++) candles.push(candle(i, 101, 99, 100));
candles[10] = candle(10, 110, 109, 109.5);
candles[11] = candle(11, 105, 100, 102);
candles[12] = candle(12, 103, 97, 99);
candles[13] = candle(13, 104, 96, 100);
candles[14] = candle(14, 105, 98, 102);
candles[20] = candle(20, 110.2, 109, 109.5);
candles[21] = candle(21, 104, 100, 102);
candles[22] = candle(22, 103, 97, 99);
candles[23] = candle(23, 104, 96, 100);
candles[24] = candle(24, 105, 98, 102);
candles[30] = candle(30, 110.1, 109, 109.5);

var atr = new Array(candles.length).fill(5);
var a = swing('A', 'SWING_HIGH', 110, 10);
var b = swing('B', 'SWING_HIGH', 110.2, 20);
var c = swing('C', 'SWING_HIGH', 110.1, 30);
var ab = shadow.pairFeatures(a, b, 'EQH', candles, atr, {
    priceStrongMaxATR: 0.7,
    priceFailAboveATR: 1.1,
    formationDepartureMinATR: 1.75,
    formationZoneATR: 0.5,
    formationMinConsecutiveOutsideBars: 1
});
assert.strictEqual(ab.classification, 'VALID_EQ');

var base = {
    id: 'BTCUSDT:EQH:1', type: 'EQH', side: 'BSL', createdAt: b.confirmedAt,
    confirmedAt: b.confirmedAt, formationAnchor: a, initialMembers: [a, b]
};
var append = [{
    clusterId: base.id, memberAddedAt: c.confirmedAt, memberConfirmedAt: c.confirmedAt,
    member: c
}];
assert.strictEqual(shadow.projectClusterAsOf(base, append, [], b.confirmedAt).memberCount, 2);
assert.strictEqual(shadow.projectClusterAsOf(base, append, [], c.confirmedAt).memberCount, 3);
assert.strictEqual(shadow.projectClusterAsOf(base, append, [], b.confirmedAt).confirmedAt, b.confirmedAt);
assert.strictEqual(shadow.projectClusterAsOf(base, append, [], b.confirmedAt - 1), null);

console.log('eqPersistentClusterShadowV3 tests passed');
