'use strict';
var assert = require('assert');
var dw = require('../stats/displacementWatch');
var BAR = 300000, passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.stack); } }
function c(i, o, h, l, close) { return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1, open: o, high: h, low: l, close: close, closed: true }; }
function disp(direction, i) { return { id: 'X:5m:DISPLACEMENT:' + direction + ':' + i, direction: direction, candleIndex: i, confirmedAt: (i + 1) * BAR - 1 }; }
function sweep(side, i) { return { id: 'SW:' + side + ':' + i, side: side, candleIndex: i, confirmedAt: (i + 1) * BAR - 1, liquidityId: 'L:' + i, price: 99, timeframe: '5m', source: { liquidityType: side === 'SSL' ? 'SWING_LOW' : 'SWING_HIGH' } }; }
function leg(d) { return { ids: [d.id], direction: d.direction, startIndex: d.candleIndex, lastIndex: d.candleIndex, firstConfirmedAt: d.confirmedAt, lastConfirmedAt: d.confirmedAt, quality: 'STRONG' }; }

test('native FVG belongs to displacement K1/K2/K3 and needs closed K3', function () {
    var d = disp('BULLISH', 2);
    var candles = [c(0, 99, 100, 98, 99), c(1, 99, 101, 98, 100), c(2, 100, 108, 99, 107)];
    assert.strictEqual(dw.nativeFvgForDisplacement(d, candles), null);
    candles.push(c(3, 107, 111, 105, 110));
    var f = dw.nativeFvgForDisplacement(d, candles);
    assert.deepStrictEqual([f.low, f.high, f.k1OpenTime, f.k2OpenTime, f.k3OpenTime], [101, 105, BAR, 2 * BAR, 3 * BAR]);
});

test('matching liquidity creates WATCH without MSS and without native FVG', function () {
    var d = disp('BULLISH', 2), l = leg(d);
    var w = dw.buildWatch({ symbol: 'X', leg: l, evaluationTime: d.confirmedAt,
        sweepEvents: [sweep('SSL', 1)], displacements: [d], mssEvents: [],
        candles: [c(0, 99, 100, 98, 99), c(1, 99, 101, 98, 100), c(2, 100, 108, 99, 107)],
        structuralState: { structuralState: 'UNKNOWN', activeProtected: {} }, dailyBias: { bias: 'OPPOSITE' } });
    assert.ok(w);
    assert.strictEqual(w.state, 'WATCH_NO_FVG');
    assert.strictEqual(w.mss.exists, false);
    assert.strictEqual(w.dailyBias.bias, 'OPPOSITE');
});

test('WATCH MSS enrichment preserves exact leg.mssId lookup', function () {
    var d = disp('BULLISH', 2), l = leg(d);
    l.mssId = 'M-EXACT';
    var w = dw.buildWatch({ symbol: 'X', leg: l, evaluationTime: d.confirmedAt,
        sweepEvents: [sweep('SSL', 1)], displacements: [d],
        mssEvents: [
            { id: 'M-OTHER', direction: 'BULLISH', confirmedAt: d.confirmedAt, referenceLevel: 98 },
            { id: 'M-EXACT', direction: 'BULLISH', confirmedAt: d.confirmedAt, referenceLevel: 99 }
        ],
        candles: [c(0, 99, 100, 98, 99), c(1, 99, 101, 98, 100), c(2, 100, 108, 99, 107)] });
    assert.ok(w);
    assert.strictEqual(w.mss.exists, true);
    assert.strictEqual(w.mss.id, 'M-EXACT');
    assert.strictEqual(w.mss.referencePrice, 99);
});

test('opposite liquidity cannot create watch', function () {
    var d = disp('BULLISH', 2);
    assert.strictEqual(dw.buildWatch({ symbol: 'X', leg: leg(d), evaluationTime: d.confirmedAt,
        sweepEvents: [sweep('BSL', 1)], displacements: [d], candles: [] }), null);
});

test('K3 upgrade uses native geometry, not a global FVG registry', function () {
    var d = disp('BEARISH', 2), l = leg(d);
    var candles = [c(0, 101, 102, 100, 101), c(1, 101, 103, 99, 100), c(2, 100, 101, 92, 93), c(3, 93, 97, 90, 91)];
    var w = dw.buildWatch({ symbol: 'X', leg: l, evaluationTime: candles[3].closeTime,
        sweepEvents: [sweep('BSL', 1)], displacements: [d], mssEvents: [], candles: candles,
        globalFvgRegistry: [{ id: 'MUST_NOT_BE_READ', zoneLow: 1, zoneHigh: 2 }] });
    assert.strictEqual(w.state, 'WATCH_WAIT_FVG');
    assert.deepStrictEqual([w.nativeFvg.low, w.nativeFvg.high], [97, 99]);
});

test('first real-time entry touches once and successful delivery dedupes', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id: 'W', direction: 'BULLISH', state: 'WATCH_WAIT_FVG', updatedAt: 100,
        notificationKey: 'W:F', nativeFvg: { id: 'F', low: 100, high: 105 } });
    assert.strictEqual(store.onPrice(106, 200).length, 0);
    assert.strictEqual(store.onPrice(104, 201).length, 1);
    assert.strictEqual(store.onPrice(103, 202).length, 0);
    store.markNotified('W', 203);
    assert.strictEqual(store.get('W').state, 'NOTIFIED');
    assert.strictEqual(store.onPrice(102, 204).length, 0);
});

test('historical replay cannot self-touch formation candle', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id: 'W', direction: 'BULLISH', state: 'WATCH_WAIT_FVG', updatedAt: 100,
        notificationKey: 'W:F', nativeFvg: { id: 'F', low: 100, high: 105 } });
    assert.strictEqual(store.onCandle({ closeTime: 100, open: 106, high: 107, low: 103, close: 104 }).length, 0);
    assert.strictEqual(store.onCandle({ closeTime: 200, open: 106, high: 107, low: 104, close: 105 }).length, 1);
});

test('terminal formation is frozen against later engine enrichment', function () {
    var store = dw.createWatchStore([], {});
    store.upsert({ id:'W', direction:'BULLISH', state:'WATCH_WAIT_FVG', updatedAt:100,
        notificationKey:'W:F', nativeFvg:{id:'F',low:100,high:105}, liquidityTaken:{primary:{id:'OLD'}} });
    store.onPrice(103, 200);
    store.upsert({ id:'W', direction:'BULLISH', state:'WATCH_WAIT_FVG', updatedAt:300,
        notificationKey:'W:F', nativeFvg:{id:'F',low:100,high:105}, liquidityTaken:{primary:{id:'FUTURE'}} });
    assert.strictEqual(store.get('W').liquidityTaken.primary.id, 'OLD');
    assert.strictEqual(store.get('W').updatedAt, 100);
});

if (failed) { console.error('FAILED ' + failed + '/' + (passed + failed)); process.exit(1); }
console.log('PASSED ' + passed + '/' + passed);
