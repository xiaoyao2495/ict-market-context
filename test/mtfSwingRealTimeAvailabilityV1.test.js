'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var audit = require('../audit/mtfSwingRealTimeAvailabilityV1');

function row(side) {
    return {
        canonicalSwingId: 's-' + side,
        side: side,
        occurredAt: 0,
        confirmedAt: 10,
        timeframeMembership: {
            '5m': { member: true, occurredAt: 0, confirmedAt: 10 },
            '15m': { member: true, occurredAt: 0, confirmedAt: 100 },
            '1h': { member: true, occurredAt: 0, confirmedAt: 200 },
            '4h': { member: true, occurredAt: 0, confirmedAt: 300 }
        }
    };
}

test('confirmed before/exactly at/after Sweep classify correctly', function () {
    var r = row('HIGH');
    assert.equal(audit.classify(r, 101, '15m'), 'CONFIRMED_AT_SWEEP');
    assert.equal(audit.classify(r, 100, '15m'), 'CONFIRMED_AT_SWEEP');
    assert.equal(audit.classify(r, 99, '15m'), 'UNCONFIRMED_AT_SWEEP');
});

test('future confirmation does not backfill past realtime membership', function () {
    var r = row('HIGH'), before = audit.realtimeMembership(r, 99), frozen = audit.hash(before);
    assert.equal(before['15m'], 'UNCONFIRMED');
    assert.equal(audit.realtimeMembership(r, 100)['15m'], 'CONFIRMED');
    assert.equal(audit.hash(before), frozen);
});

test('5m Swing must already be confirmed at Sweep', function () {
    var r = row('HIGH');
    assert.equal(audit.realtimeMembership(r, 9)['5m'], 'UNCONFIRMED');
    assert.equal(audit.realtimeMembership(r, 10)['5m'], 'CONFIRMED');
});

test('first Sweep is deterministic and later sweeps do not change classification', function () {
    var events = [{ swingId: 'x', confirmedAt: 300 }, { swingId: 'x', confirmedAt: 100 }, { swingId: 'x', confirmedAt: 200 }];
    assert.equal(audit.firstSweepBySwing(events).x.confirmedAt, 100);
    assert.equal(audit.firstSweepBySwing(events.slice().reverse()).x.confirmedAt, 100);
});

test('15m/1h/4h use identical confirmedAt semantics', function () {
    var r = row('LOW');
    assert.equal(audit.classify(r, 99, '15m'), 'UNCONFIRMED_AT_SWEEP');
    assert.equal(audit.classify(r, 199, '1h'), 'UNCONFIRMED_AT_SWEEP');
    assert.equal(audit.classify(r, 299, '4h'), 'UNCONFIRMED_AT_SWEEP');
    assert.equal(audit.classify(r, 300, '4h'), 'CONFIRMED_AT_SWEEP');
});

test('HIGH and LOW have symmetric semantics and past snapshot is immutable', function () {
    var high = audit.realtimeMembership(row('HIGH'), 150), low = audit.realtimeMembership(row('LOW'), 150);
    assert.deepEqual(high, low);
    var frozen = audit.hash(high); audit.realtimeMembership(row('HIGH'), 999); assert.equal(audit.hash(high), frozen);
});
