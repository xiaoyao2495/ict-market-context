'use strict';

var assert = require('assert');
var adapter = require('../events/liquidityTakenEventAdapter');
var eventRegistry = require('../events/eventRegistry');
var replayState = require('../replay/replayState');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS ' + name); }
    catch (e) { failed++; console.log('FAIL ' + name + ' -> ' + e.stack); }
}

function candle(i, high, low, close, closed) {
    var openTime = i * 300000;
    return {
        openTime: openTime,
        closeTime: openTime + 299999,
        open: 100,
        high: high,
        low: low,
        close: close,
        closed: closed === undefined ? true : closed
    };
}

function liquidity(id, type, side, price, confirmedAt, status) {
    return {
        id: id,
        symbol: 'X',
        timeframe: type === 'PDH' || type === 'PDL' ? '1d' : '5m',
        type: type,
        side: side,
        price: price,
        confirmedAt: confirmedAt === undefined ? 0 : confirmedAt,
        status: status || 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {}
    };
}

function stateWith(items) {
    var state = replayState.createReplayState({ symbol: 'X', timeframe: '5m' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    state.registry.addMany(items);
    return state;
}

function advance(state, c, index) {
    return replayState.incrementalEvents(state, c, index, c.closeTime, []);
}

test('A BSL strict cross creates Taken with frozen contract', function () {
    var l = liquidity('PDH:A', 'PDH', 'BSL', 100), c = candle(1, 100.01, 99, 100);
    var e = adapter.buildTakenEvent(l, c, 1, '5m');
    assert.ok(e); assert.strictEqual(e.type, 'LIQUIDITY_TAKEN');
    assert.strictEqual(e.id, 'X:5m:TAKEN:PDH:A:300000');
    assert.strictEqual(e.occurredAt, c.openTime); assert.strictEqual(e.confirmedAt, c.closeTime);
    assert.strictEqual(e.price, 100); assert.strictEqual(e.source.interactionExtreme, 100.01);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(e, 'direction'), false);
});

test('B SSL strict cross creates Taken', function () {
    var e = adapter.buildTakenEvent(liquidity('PDL:A', 'PDL', 'SSL', 100), candle(1, 101, 99.99, 100), 1, '5m');
    assert.ok(e); assert.strictEqual(e.side, 'SSL'); assert.strictEqual(e.source.interactionExtreme, 99.99);
});

test('C D exact touches do not create Taken', function () {
    assert.strictEqual(adapter.buildTakenEvent(liquidity('H', 'PDH', 'BSL', 100), candle(1, 100, 99, 99), 1, '5m'), null);
    assert.strictEqual(adapter.buildTakenEvent(liquidity('L', 'PDL', 'SSL', 100), candle(1, 101, 100, 101), 1, '5m'), null);
});

test('E F reclaim and close-beyond both create Taken while Sweep stays selective', function () {
    var reclaim = stateWith([liquidity('H1', 'PDH', 'BSL', 100)]);
    var a = advance(reclaim, candle(1, 101, 99, 99.5), 1);
    assert.strictEqual(a.taken.length, 1); assert.strictEqual(a.sweeps.length, 1);
    assert.deepStrictEqual(reclaim.eventRegistry.getAll('X').map(function (e) { return e.type; }),
        ['LIQUIDITY_TAKEN', 'LIQUIDITY_SWEEP']);
    var beyond = stateWith([liquidity('H2', 'PDH', 'BSL', 100)]);
    var b = advance(beyond, candle(1, 101, 99, 100.5), 1);
    assert.strictEqual(b.taken.length, 1); assert.strictEqual(b.sweeps.length, 0);
    assert.strictEqual(beyond.registry.getById('H2').status, 'BROKEN');
});

test('G H later or absent reclaim cannot change original Taken', function () {
    var s = stateWith([liquidity('H', 'PDH', 'BSL', 100)]);
    var first = advance(s, candle(1, 101, 99, 100), 1).taken[0];
    var before = JSON.stringify(first);
    advance(s, candle(2, 101, 99, 99), 2);
    advance(s, candle(3, 102, 99, 101), 3);
    assert.strictEqual(JSON.stringify(s.eventRegistry.getById(first.id)), before);
    assert.strictEqual(s.eventRegistry.getByType('X', 'LIQUIDITY_TAKEN').length, 1);
});

test('I J future and same-bar-confirmed liquidity cannot backfill', function () {
    var c = candle(2, 101, 99, 100);
    assert.strictEqual(adapter.buildTakenEvent(liquidity('F1', 'EQH', 'BSL', 100, c.openTime + 1), c, 2, '5m'), null);
    assert.strictEqual(adapter.buildTakenEvent(liquidity('F2', 'EQH', 'BSL', 100, c.closeTime), c, 2, '5m'), null);
});

test('K L first Taken only, including TOUCHED close-equality edge', function () {
    var s = stateWith([liquidity('H', 'PDH', 'BSL', 100)]);
    advance(s, candle(1, 101, 99, 100), 1);
    assert.strictEqual(s.registry.getById('H').status, 'TOUCHED');
    advance(s, candle(2, 102, 99, 100), 2);
    assert.strictEqual(s.eventRegistry.getByType('X', 'LIQUIDITY_TAKEN').length, 1);
});

test('M new liquidity identity at same price creates independent Taken', function () {
    var s = stateWith([liquidity('PDL:DAY1', 'PDL', 'SSL', 100)]);
    advance(s, candle(1, 101, 99, 99.5), 1);
    s.registry.add(liquidity('PDL:DAY2', 'PDL', 'SSL', 100, candle(1, 101, 99, 99).closeTime));
    advance(s, candle(2, 101, 99, 99.5), 2);
    assert.deepStrictEqual(s.eventRegistry.getByType('X', 'LIQUIDITY_TAKEN').map(function (e) { return e.liquidityId; }), ['PDL:DAY1', 'PDL:DAY2']);
});

test('N one candle preserves three eligible identities without primary', function () {
    var items = [
        liquidity('EQH:A', 'EQH', 'BSL', 100),
        liquidity('PDH:A', 'PDH', 'BSL', 100.5),
        liquidity('PWH:A', 'PWH', 'BSL', 101)
    ];
    var s = stateWith(items), out = advance(s, candle(1, 102, 99, 100), 1);
    assert.strictEqual(out.taken.length, 3);
    assert.strictEqual(new Set(out.taken.map(function (e) { return e.id; })).size, 3);
    assert.deepStrictEqual(out.taken.map(function (e) { return e.liquidityId; }), ['EQH:A', 'PDH:A', 'PWH:A']);
    out.taken.forEach(function (e) { assert.strictEqual(e.primary, undefined); });
});

test('O P EQ as-of price and ID are immutable after future member append', function () {
    var l = liquidity('EQV3:X', 'EQH', 'BSL', 100.05, 0);
    l.metadata = {
        eqModelVersion: 'V3', formationAnchorId: 'A',
        members: [
            { id:'A', canonicalSwingId:'A', price:100, sourceOpenTime:0, confirmedAt:0, memberAddedAt:0 },
            { id:'B', canonicalSwingId:'B', price:100.1, sourceOpenTime:1, confirmedAt:1, memberAddedAt:1 }
        ]
    };
    var e = adapter.buildTakenEvent(l, candle(1, 101, 99, 99), 1, '5m');
    var id = e.id;
    l.metadata.members.push({ id:'C', canonicalSwingId:'C', price:110, sourceOpenTime:600000, confirmedAt:600000, memberAddedAt:600000 });
    l.price = 103.3666666667;
    assert.strictEqual(e.price, 100.05); assert.strictEqual(e.source.liquidityPrice, 100.05);
    assert.strictEqual(e.id, id); assert.deepStrictEqual(e.source.eqMemberProvenance.members.map(function (m) { return m.id; }), ['A','B']);
});

test('O2 same-bar future EQ member cannot change crossing price or snapshot', function () {
    var c = candle(2, 101, 99, 100);
    var l = liquidity('EQV3:SAME_BAR', 'EQH', 'BSL', 105, 0);
    l.metadata = {
        eqModelVersion: 'V3', formationAnchorId: 'A',
        members: [
            { id:'A', canonicalSwingId:'A', price:100, sourceOpenTime:0, confirmedAt:0, memberAddedAt:0 },
            { id:'B', canonicalSwingId:'B', price:100.1, sourceOpenTime:1, confirmedAt:1, memberAddedAt:1 },
            { id:'FUTURE', canonicalSwingId:'FUTURE', price:114.9, sourceOpenTime:c.openTime, confirmedAt:c.closeTime, memberAddedAt:c.closeTime }
        ]
    };
    var e = adapter.buildTakenEvent(l, c, 2, '5m');
    assert.ok(e, 'pre-bar price 100.05 was strictly crossed even though mutable current mean is 105');
    assert.strictEqual(e.price, 100.05);
    assert.deepStrictEqual(e.source.eqMemberProvenance.members.map(function (m) { return m.id; }), ['A','B']);
});

function replayProjection(bars) {
    var s = stateWith([liquidity('PDH:A', 'PDH', 'BSL', 100)]);
    bars.forEach(function (c, i) { advance(s, c, i + 1); });
    return s.eventRegistry.getByType('X', 'LIQUIDITY_TAKEN');
}

test('Q restart replay produces identical Taken identity', function () {
    var bars = [candle(1, 99, 98, 98.5), candle(2, 101, 99, 100.5), candle(3, 102, 99, 101)];
    assert.deepStrictEqual(replayProjection(bars), replayProjection(bars));
});

test('R future suffix cannot mutate prefix Taken projection', function () {
    var prefix = [candle(1, 101, 99, 100.5)];
    var atT = replayProjection(prefix);
    var longer = replayProjection(prefix.concat([candle(2, 120, 80, 110), candle(3, 130, 70, 90)]));
    assert.deepStrictEqual(longer.filter(function (e) { return e.confirmedAt <= prefix[0].closeTime; }), atT);
});

test('S all Narrative Liquidity V1 types are explicitly eligible with correct sides', function () {
    var rows = [['EQH','BSL'],['EQL','SSL'],['PDH','BSL'],['PDL','SSL'],['PWH','BSL'],['PWL','SSL'],['PMH','BSL'],['PML','SSL']];
    rows.forEach(function (row) {
        var c = row[1] === 'BSL' ? candle(1, 100.01, 99, 100) : candle(1, 101, 99.99, 100);
        assert.ok(adapter.buildTakenEvent(liquidity(row[0], row[0], row[1], 100), c, 1, '5m'), row[0]);
    });
});

test('T U raw Swing types are excluded', function () {
    assert.strictEqual(adapter.buildTakenEvent(liquidity('SH', 'SWING_HIGH', 'BSL', 100), candle(1, 101, 99, 100), 1, '5m'), null);
    assert.strictEqual(adapter.buildTakenEvent(liquidity('SL', 'SWING_LOW', 'SSL', 100), candle(1, 101, 99, 100), 1, '5m'), null);
});

test('V minimum strict increment has no penetration threshold', function () {
    assert.ok(adapter.buildTakenEvent(liquidity('H', 'PMH', 'BSL', 100), candle(1, 100 + Number.EPSILON * 100, 99, 100), 1, '5m'));
    assert.ok(adapter.buildTakenEvent(liquidity('L', 'PML', 'SSL', 100), candle(1, 101, 100 - Number.EPSILON * 100, 100), 1, '5m'));
});

test('W unclosed candle and non-5m interaction are rejected', function () {
    assert.strictEqual(adapter.buildTakenEvent(liquidity('H', 'PDH', 'BSL', 100), candle(1, 101, 99, 100, false), 1, '5m'), null);
    assert.strictEqual(adapter.buildTakenEvent(liquidity('H', 'PDH', 'BSL', 100), candle(1, 101, 99, 100), 1, '1d'), null);
});

test('X Taken is visible from the unified registry only at confirmedAt', function () {
    var s = stateWith([liquidity('H', 'PDH', 'BSL', 100)]), c = candle(1, 101, 99, 100);
    var event = advance(s, c, 1).taken[0];
    assert.strictEqual(s.eventRegistry.getBefore('X', event.confirmedAt - 1).length, 0);
    assert.deepStrictEqual(s.eventRegistry.getBefore('X', event.confirmedAt), [event]);
});

console.log('liquidityTakenEvent: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
