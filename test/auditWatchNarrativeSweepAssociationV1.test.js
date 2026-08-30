'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var liquidityProvenance = require('../stats/liquidityProvenance');

var passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (error) { console.error('FAIL ' + name + ': ' + error.stack); process.exitCode = 1; }
}
function load(symbol) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'research',
        'watch-narrative-sweep-association-audit-v1', symbol + '-forensic-replay.json'), 'utf8'));
}
function at(result, time) {
    return result.touchesOnTargetDate.filter(function (row) { return row.watchTime === time; })[0];
}

var zec = load('ZECUSDT');
var btc = load('BTCUSDT');

test('1 forensic inputs are USD-M Futures', function () {
    assert.strictEqual(zec.dataSource, 'futures'); assert.strictEqual(zec.productionEquivalent, true);
    assert.strictEqual(btc.dataSource, 'futures'); assert.strictEqual(btc.productionEquivalent, true);
});
test('2 ZEC target sequence reproduced', function () {
    ['2026-08-30 08:55', '2026-08-30 09:40', '2026-08-30 10:25'].forEach(function (time) {
        assert.ok(at(zec, time), time); assert.strictEqual(at(zec, time).direction, 'BEARISH');
    });
});
test('3 ZEC uses one exact liquidity and sweep identity', function () {
    var rows = ['2026-08-30 08:55', '2026-08-30 09:40', '2026-08-30 10:25'].map(function (t) { return at(zec, t); });
    assert.strictEqual(new Set(rows.map(function (r) { return r.liquidityId; })).size, 1);
    assert.strictEqual(new Set(rows.map(function (r) { return r.sweepId; })).size, 1);
    assert.strictEqual(new Set(rows.map(function (r) { return r.legId; })).size, 3);
    assert.strictEqual(new Set(rows.map(function (r) { return r.watchId; })).size, 3);
    assert.strictEqual(new Set(rows.map(function (r) { return r.fvgId; })).size, 3);
});
test('4 BTC target sequence reproduced', function () {
    ['2026-08-30 10:00', '2026-08-30 11:35', '2026-08-30 11:55', '2026-08-30 13:05'].forEach(function (time) { assert.ok(at(btc, time), time); });
});
test('5 BTC LONG reuses exact SSL sweep', function () {
    var a = at(btc, '2026-08-30 10:00'), b = at(btc, '2026-08-30 11:55');
    assert.strictEqual(a.liquidityId, b.liquidityId); assert.strictEqual(a.sweepId, b.sweepId);
    assert.strictEqual(a.sweepConfirmedAt, b.sweepConfirmedAt); assert.notStrictEqual(a.watchId, b.watchId);
});
test('6 BTC SHORT reuses exact BSL sweep', function () {
    var a = at(btc, '2026-08-30 11:35'), b = at(btc, '2026-08-30 13:05');
    assert.strictEqual(a.liquidityId, b.liquidityId); assert.strictEqual(a.sweepId, b.sweepId);
    assert.strictEqual(a.sweepConfirmedAt, b.sweepConfirmedAt); assert.notStrictEqual(a.watchId, b.watchId);
});
test('7 association primary is distance then confirmedAt', function () {
    var leg = { startIndex: 100, lastIndex: 102, firstConfirmedAt: 1000, lastConfirmedAt: 1200 };
    var candidates = [
        { id:'far', side:'SSL', confirmedAt:900, candleIndex:90, timeframe:'5m', liquidityId:'L1', source:{liquidityType:'EQL'} },
        { id:'near-old', side:'SSL', confirmedAt:950, candleIndex:99, timeframe:'5m', liquidityId:'L2', source:{liquidityType:'EQL'} },
        { id:'near-new', side:'SSL', confirmedAt:960, candleIndex:101, timeframe:'5m', liquidityId:'L3', source:{liquidityType:'EQL'} }
    ];
    var result = liquidityProvenance.associateSweeps({ direction:'BULLISH', leg:leg,
        availableAt:1200, sweepEvents:candidates, maxLookbackBars:48 });
    assert.strictEqual(result.immediateSweep.id, 'near-new');
});

if (!process.exitCode) console.log('auditWatchNarrativeSweepAssociationV1: ' + passed + ' passed, 0 failed');
