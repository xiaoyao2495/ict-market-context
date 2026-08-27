'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var audit = require('../audit/multiTimeframeSwingHierarchyV1');

function swing(id, type, price, occurredAt, confirmedAt, timeframe) {
    return { id: id, symbol: 'BTCUSDT', timeframe: timeframe || '5m', type: type, price: price, sourceOpenTime: occurredAt, confirmedAt: confirmedAt };
}
var five = [
    swing('5-only', 'SWING_HIGH', 110, 0, 10),
    swing('15-member', 'SWING_HIGH', 120, 300000, 20),
    swing('1h-member', 'SWING_LOW', 80, 600000, 30),
    swing('4h-member', 'SWING_HIGH', 130, 900000, 40)
];
var maps = {
    '15m': [{ htfSwingId: '15', mappingStatus: 'RESOLVED', canonical5mSwingId: '15-member', occurredAt: 0, confirmedAt: 100, provenance: {} }],
    '1h': [{ htfSwingId: '1h', mappingStatus: 'RESOLVED', canonical5mSwingId: '1h-member', occurredAt: 0, confirmedAt: 200, provenance: {} }],
    '4h': [{ htfSwingId: '4h', mappingStatus: 'RESOLVED', canonical5mSwingId: '4h-member', occurredAt: 0, confirmedAt: 300, provenance: {} }]
};

test('acceptance: 5m-only, 15m, 1h and 4h memberships', function () {
    var rows = audit.projectMembership(five, maps, 300), byId = Object.fromEntries(rows.map(function (r) { return [r.canonicalSwingId, r]; }));
    assert.equal(audit.combination(byId['5-only']), '5m');
    assert.equal(byId['15-member'].timeframeMembership['15m'].member, true);
    assert.equal(byId['1h-member'].timeframeMembership['1h'].member, true);
    assert.equal(byId['4h-member'].timeframeMembership['4h'].member, true);
});

test('acceptance: HTF membership is invisible before confirmedAt and appears at confirmedAt', function () {
    assert.equal(audit.projectMembership(five, maps, 99).find(function (r) { return r.canonicalSwingId === '15-member'; }).timeframeMembership['15m'].member, false);
    assert.equal(audit.projectMembership(five, maps, 100).find(function (r) { return r.canonicalSwingId === '15-member'; }).timeframeMembership['15m'].member, true);
});

test('acceptance: HIGH and LOW map by side, exact price and source-candle coverage', function () {
    var htfCandles = [{ openTime: 0, closeTime: 899999, high: 120, low: 80, closed: true }];
    var high = swing('H', 'SWING_HIGH', 120, 0, 100, '15m');
    var low = swing('L', 'SWING_LOW', 80, 0, 100, '15m');
    var result = audit.mapHtfTo5m([high, low], five, htfCandles, 900000);
    assert.equal(result[0].mappingStatus, 'RESOLVED');
    assert.equal(result[1].mappingStatus, 'RESOLVED');
});

test('acceptance: ambiguity fails safe without nearest or arbitrary tie-break', function () {
    var candidates = [swing('a', 'SWING_HIGH', 120, 300000, 20), swing('b', 'SWING_HIGH', 120, 600000, 30)];
    var mapped = audit.mapHtfTo5m([swing('H', 'SWING_HIGH', 120, 0, 100, '15m')], candidates, [{ openTime: 0, closeTime: 899999, high: 120, low: 80, closed: true }], 900000)[0];
    assert.equal(mapped.mappingStatus, 'AMBIGUOUS');
    assert.equal(mapped.canonical5mSwingId, null);
    assert.deepEqual(mapped.candidate5mSwingIds, ['a', 'b']);
});

test('acceptance: past snapshots remain immutable and projection is deterministic', function () {
    var before = audit.projectMembership(five, maps, 99), frozen = audit.hash(before);
    audit.projectMembership(five, maps, 300);
    assert.equal(audit.hash(before), frozen);
    assert.equal(audit.hash(audit.projectMembership(five.slice().reverse(), { '15m': maps['15m'].slice().reverse(), '1h': maps['1h'], '4h': maps['4h'] }, 300)), audit.hash(audit.projectMembership(five, maps, 300)));
});

test('acceptance: aggregation is aligned and canonical under reversed input', function () {
    var candles = [];
    for (var i = 0; i < 3; i += 1) candles.push({ openTime: i * 300000, closeTime: (i + 1) * 300000 - 1, open: i + 1, high: i + 3, low: i, close: i + 2, volume: 10, closed: true });
    var a = audit.aggregate(candles, 900000, '15m'), b = audit.aggregate(candles.slice().reverse(), 900000, '15m');
    assert.deepEqual(a, b);
    assert.equal(a[0].open, 1); assert.equal(a[0].high, 5); assert.equal(a[0].low, 0); assert.equal(a[0].close, 4); assert.equal(a[0].volume, 30);
});
