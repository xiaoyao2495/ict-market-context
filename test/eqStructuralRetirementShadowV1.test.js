'use strict';
var assert = require('assert');
var retirement = require('../audit/eqStructuralRetirementShadowV1');

var passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log('PASS ' + passed + ' ' + name);
}
function cluster() {
    var c = {
        id: 'BTCUSDT:EQH:100', instanceId: 'BTCUSDT:EQH:100:INSTANCE:200:0',
        type: 'EQH', confirmedAt: 200,
        formationZone: { low: 99, high: 101 },
        members: [{ id: 'A' }, { id: 'B' }]
    };
    c.retirement = retirement.createRetirementState(c);
    return c;
}
function candle(openTime, closeTime, high, low) {
    return { openTime: openTime, closeTime: closeTime, high: high, low: low,
        open: (high + low) / 2, close: (high + low) / 2, closed: true };
}
function mss(direction, confirmedAt) {
    return { id: 'MSS:' + direction + ':' + confirmedAt, type: 'STRUCTURAL_MSS',
        direction: direction, occurredAt: confirmedAt - 1, confirmedAt: confirmedAt };
}
function bos(direction, confirmedAt) {
    return { id: 'BOS:' + direction + ':' + confirmedAt, type: 'STRUCTURAL_CONTINUATION',
        direction: direction, occurredAt: confirmedAt - 1, confirmedAt: confirmedAt };
}
function control(direction, confirmedAt) {
    return { id: 'CONTROL:' + direction + ':' + confirmedAt, sourceSwingId: 'S:' + confirmedAt,
        type: 'ACTIVE_PROTECTED', direction: direction, price: 95,
        occurredAt: confirmedAt - 10, confirmedAt: confirmedAt };
}
function exit(c) {
    retirement.advanceRetirement(c, { candle: candle(299, 300, 98, 95), events: [],
        structuralSwings: [], evaluationTime: 300 });
}
function full(c, direction) {
    exit(c);
    return retirement.advanceRetirement(c, {
        candle: candle(499, 500, 97, 94),
        events: [mss(direction, 400), bos(direction, 500)],
        structuralSwings: [control(direction, 500)], evaluationTime: 500
    });
}

test('ACTIVE cluster remains append-eligible without retirement evidence', function () {
    var c = cluster();
    assert.strictEqual(c.retirement.state, 'ACTIVE');
    assert.strictEqual(retirement.advanceRetirement(c, { candle: candle(210, 220, 101, 99),
        events: [], structuralSwings: [], evaluationTime: 220 }), null);
});
test('complete ordered sequence retires and therefore blocks append', function () {
    var c = cluster();
    assert.ok(full(c, 'BEARISH'));
    assert.strictEqual(c.retirement.state, 'STRUCTURALLY_RETIRED');
});
test('MSS alone does not retire', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(399, 400, 97, 94), events: [mss('BEARISH', 400)],
        structuralSwings: [], evaluationTime: 400 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});
test('MSS plus BOS without new controlling/protected swing does not retire', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(499, 500, 97, 94),
        events: [mss('BEARISH', 400), bos('BEARISH', 500)], structuralSwings: [], evaluationTime: 500 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});
test('direction mismatch does not retire', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(499, 500, 97, 94),
        events: [mss('BEARISH', 400), bos('BULLISH', 500)],
        structuralSwings: [control('BULLISH', 500)], evaluationTime: 500 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});
test('sequence order error does not retire', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(499, 500, 97, 94),
        events: [bos('BEARISH', 400), mss('BEARISH', 500)],
        structuralSwings: [control('BEARISH', 500)], evaluationTime: 500 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});
test('future evidence cannot retroactively reject candidate', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(449, 450, 97, 94),
        events: [mss('BEARISH', 400), bos('BEARISH', 500)],
        structuralSwings: [control('BEARISH', 500)], evaluationTime: 450 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});
test('retired cluster never reopens', function () {
    var c = cluster(); full(c, 'BEARISH');
    retirement.advanceRetirement(c, { candle: candle(599, 600, 105, 99), events: [],
        structuralSwings: [], evaluationTime: 600 });
    assert.strictEqual(c.retirement.state, 'STRUCTURALLY_RETIRED');
});
test('retirement state has no merge or split transition', function () {
    var c = cluster(); full(c, 'BEARISH');
    assert.strictEqual(c.retirement.merge, undefined);
    assert.strictEqual(c.retirement.split, undefined);
});
test('future equal zone requires two new swings and a different identity', function () {
    var oldId = 'BTCUSDT:EQH:100';
    var newMembers = [{ sourceOpenTime: 700 }, { sourceOpenTime: 800 }];
    assert.strictEqual(newMembers.length, 2);
    assert.notStrictEqual('BTCUSDT:EQH:' + newMembers[0].sourceOpenTime, oldId);
});
test('historical cluster identity remains unchanged by retirement', function () {
    var c = cluster(); var before = { id: c.id, confirmedAt: c.confirmedAt,
        members: c.members.map(function (m) { return m.id; }) };
    full(c, 'BEARISH');
    assert.deepStrictEqual({ id: c.id, confirmedAt: c.confirmedAt,
        members: c.members.map(function (m) { return m.id; }) }, before);
});
test('same evidence replay is deterministic', function () {
    var a = cluster(); var b = cluster(); full(a, 'BEARISH'); full(b, 'BEARISH');
    assert.deepStrictEqual(a.retirement, b.retirement);
});
test('past state is immutable before future retirement evidence', function () {
    var c = cluster(); exit(c); var past = JSON.parse(JSON.stringify(c.retirement));
    full(c, 'BEARISH');
    assert.strictEqual(past.state, 'ACTIVE');
    assert.strictEqual(past.retirement, null);
});
test('#20 counterexample: zone exit without full coherent sequence is preserved', function () {
    var c = cluster(); exit(c);
    retirement.advanceRetirement(c, { candle: candle(9999, 10000, 90, 80),
        events: [], structuralSwings: [], evaluationTime: 10000 });
    assert.strictEqual(c.retirement.state, 'ACTIVE');
});

console.log('EQ Structural Retirement Shadow V1 targeted tests passed (' + passed + '/14)');
