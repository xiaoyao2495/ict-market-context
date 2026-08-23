'use strict';
var assert = require('assert');
var detector = require('../events/mssSignalDetector');

var BAR = 300000;
var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.message); }
}
function candle(i, o, h, l, c, closed) {
    return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1,
        open: o, high: h, low: l, close: c, closed: closed !== false };
}
function swing(side, i, price, confirmedAt) {
    return { id: 'X:5m:SWING_' + side + ':' + i * BAR, symbol: 'X', timeframe: '5m',
        type: 'SWING_' + side, price: price, sourceOpenTime: i * BAR, confirmedAt: confirmedAt };
}
function structural(raw, role, status, protectedAt) {
    return { id: 'STRUCT:' + raw.id, sourceSwingId: raw.id, symbol: 'X', timeframe: '5m',
        side: raw.type === 'SWING_HIGH' ? 'HIGH' : 'LOW', price: raw.price,
        occurredAt: raw.sourceOpenTime, confirmedAt: raw.confirmedAt,
        role: role, status: status, protectedConfirmedAt: protectedAt,
        provenance: protectedAt == null ? null : { direction: 'BEARISH', parentStructuralLevelId: 'P', bosCandleOpenTime: 0 } };
}

test('confirmed local 2L/2R close-through emits MSS without body/breakPct gate', function () {
    var h = swing('HIGH', 1, 100, 4 * BAR - 1);
    var st = { structuralState: 'BEARISH', swingBySourceId: {}, activeProtected: { HIGH: null, LOW: null } };
    st.swingBySourceId[h.id] = structural(h, 'LOCAL_SWING', 'CANDIDATE', null);
    var out = detector.detect({ candle: candle(4, 100.01, 100.02, 99.99, 100.01), candleIndex: 4,
        swings: [h], structuralState: st, consumedRefs: {} });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, 'MSS');
    assert.strictEqual(out[0].referenceStructuralRole, 'LOCAL');
    assert.strictEqual(out[0].protectedBreak, false);
});

test('wick-only and unclosed candles never emit MSS', function () {
    var h = swing('HIGH', 1, 100, 3 * BAR - 1);
    var st = { structuralState: 'BEARISH', swingBySourceId: {}, activeProtected: { HIGH: null, LOW: null } };
    assert.strictEqual(detector.detect({ candle: candle(4, 99, 101, 98, 99.9), candleIndex: 4,
        swings: [h], structuralState: st, consumedRefs: {} }).length, 0);
    assert.strictEqual(detector.detect({ candle: candle(4, 99, 101, 98, 101, false), candleIndex: 4,
        swings: [h], structuralState: st, consumedRefs: {} }).length, 0);
});

test('future-confirmed swing is unavailable and a reference is consumed once', function () {
    var h = swing('HIGH', 1, 100, 6 * BAR - 1);
    var consumed = {};
    var st = { structuralState: 'BEARISH', swingBySourceId: {}, activeProtected: { HIGH: null, LOW: null } };
    assert.strictEqual(detector.detect({ candle: candle(4, 99, 102, 98, 101), candleIndex: 4,
        swings: [h], structuralState: st, consumedRefs: consumed }).length, 0);
    h.confirmedAt = 5 * BAR - 1;
    assert.strictEqual(detector.detect({ candle: candle(5, 100, 102, 99, 101), candleIndex: 5,
        swings: [h], structuralState: st, consumedRefs: consumed }).length, 1);
    assert.strictEqual(detector.detect({ candle: candle(6, 101, 103, 100, 102), candleIndex: 6,
        swings: [h], structuralState: st, consumedRefs: consumed }).length, 0);
});

test('active protected close break is enriched as PROTECTED', function () {
    var h = swing('HIGH', 1, 100, 3 * BAR - 1);
    var sh = structural(h, 'ACTIVE_PROTECTED', 'ACTIVE_PROTECTED', 4 * BAR - 1);
    var st = { structuralState: 'BEARISH', swingBySourceId: {}, activeProtected: { HIGH: sh, LOW: null } };
    st.swingBySourceId[h.id] = sh;
    var out = detector.detect({ candle: candle(5, 99, 102, 98, 101), candleIndex: 5,
        swings: [h], structuralState: st, consumedRefs: {} });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].protectedBreak, true);
    assert.strictEqual(out[0].mssGrade, 'PROTECTED');
    assert.strictEqual(out[0].referenceStructuralRole, 'ACTIVE_PROTECTED');
});

console.log('\nmssSignalDetector: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
