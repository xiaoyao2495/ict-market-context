'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var config = require('../config/sweepNarrativeEligibilityV1');
var classifier = require('../events/sweepNarrativeEligibilityV1');
var adapter = require('../events/sweepEventAdapter');
var takenAdapter = require('../events/liquidityTakenEventAdapter');
var amdState = require('../amd/amdState');
var displacementWatch = require('../stats/displacementWatch');

var FLAG = config.ENV_NAME;
var BAR = 300000;

function liquidity(type, side) {
    return {
        id: 'X:5m:' + type + ':1', symbol: 'X', timeframe: '5m', type: type,
        side: side || (/LOW$|PDL|PWL|PML|EQL/.test(type) ? 'SSL' : 'BSL'),
        price: 100, status: 'SWEPT', sweptAt: BAR - 1, metadata: {}
    };
}
function candle(i, close) {
    return {
        openTime: i * BAR, closeTime: (i + 1) * BAR - 1,
        open: close, high: close + 2, low: close - 2, close: close, closed: true
    };
}
function withFlag(value, fn) {
    var previous = process.env[FLAG];
    if (value === undefined) delete process.env[FLAG]; else process.env[FLAG] = value;
    try { return fn(); } finally {
        if (previous === undefined) delete process.env[FLAG]; else process.env[FLAG] = previous;
    }
}
function built(type, enabled) {
    return withFlag(enabled ? 'true' : undefined, function () {
        return adapter.buildSweepEvent(liquidity(type), candle(0, 100), 0);
    });
}
function takenLiquidity(type) {
    return {
        id: 'X:5m:' + type + ':1', symbol: 'X', timeframe: '5m', type: type,
        side: (/LOW$|PDL|PWL|PML|EQL/.test(type) ? 'SSL' : 'BSL'),
        price: 100, status: 'ACTIVE', confirmedAt: -1, sweptAt: -1, metadata: {}
    };
}
function builtTaken(type, enabled) {
    return withFlag(enabled ? 'true' : undefined, function () {
        return takenAdapter.buildTakenEvent(takenLiquidity(type), candle(0, 100), 0, '5m');
    });
}
function decision(type) { return classifier.classifySourceType(type); }
function behaviorSweep(event) {
    var copy = JSON.parse(JSON.stringify(event));
    delete copy.narrativeEligibilityV1;
    return copy;
}

test('1 feature flag defaults OFF', function () {
    assert.equal(config.DEFAULT_ENABLED, false);
    assert.equal(config.isEnabled({}), false);
});

[
    ['SWING_HIGH', 'PROPOSED_INELIGIBLE', false, 'STRUCTURAL_PRIMITIVE'],
    ['SWING_LOW', 'PROPOSED_INELIGIBLE', false, 'STRUCTURAL_PRIMITIVE'],
    ['EQH', 'PROPOSED_ELIGIBLE', true, 'EQUAL_LIQUIDITY'],
    ['EQL', 'PROPOSED_ELIGIBLE', true, 'EQUAL_LIQUIDITY'],
    ['PDH', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['PDL', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['PWH', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['PWL', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['PMH', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['PML', 'PROPOSED_ELIGIBLE', true, 'CALENDAR_LIQUIDITY'],
    ['ASIA_HIGH', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['ASIA_LOW', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['LONDON_HIGH', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['LONDON_LOW', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['NEW_YORK_HIGH', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['NEW_YORK_LOW', 'OUT_OF_SCOPE_FROZEN', null, 'SESSION_LIQUIDITY'],
    ['UNKNOWN_TYPE', 'UNRESOLVED', null, 'UNRESOLVED']
].forEach(function (row, index) {
    test((index + 2) + ' classify ' + row[0], function () {
        var result = decision(row[0]);
        assert.equal(result.status, row[1]);
        assert.equal(result.narrativeEligible, row[2]);
        assert.equal(result.sourceClass, row[3]);
        assert.equal(result.version, 'v1');
        assert.equal(result.shadowOnly, true);
    });
});

test('19 missing source type is unresolved without inference', function () {
    assert.deepEqual(classifier.classifySweep({source: {}}), {
        version: 'v1', sourceClass: 'UNRESOLVED', status: 'UNRESOLVED',
        narrativeEligible: null, reason: 'SOURCE_TYPE_MISSING', shadowOnly: true
    });
});

test('20 flag OFF preserves exact legacy event shape', function () {
    var event = built('SWING_HIGH', false);
    assert.equal(Object.prototype.hasOwnProperty.call(event, 'narrativeEligibilityV1'), false);
});

test('21 flag ON is additive and preserves Sweep identity/count fields', function () {
    var off = built('SWING_HIGH', false);
    var on = built('SWING_HIGH', true);
    assert.ok(on.narrativeEligibilityV1);
    assert.deepEqual(behaviorSweep(on), off);
    assert.deepEqual(
        [on.id, on.type, on.confirmedAt, on.liquidityId, on.source.liquidityType],
        [off.id, off.type, off.confirmedAt, off.liquidityId, off.source.liquidityType]
    );
});

test('22 deterministic classification ignores input order and unrelated fields', function () {
    var a = classifier.classifySweep({source: {liquidityType: 'EQH'}, futureRole: 'BROKEN'});
    var b = classifier.classifySweep({futureRole: 'ACTIVE_PROTECTED', source: {liquidityType: 'EQH'}});
    assert.deepEqual(a, b);
});

test('23 future structural role cannot rewrite past eligibility', function () {
    var sweep = built('SWING_LOW', true);
    var before = JSON.stringify(sweep.narrativeEligibilityV1);
    sweep.source.structuralRole = 'ACTIVE_PROTECTED';
    sweep.source.laterLifecycle = 'BROKEN';
    assert.equal(JSON.stringify(classifier.classifySweep(sweep)), before);
    assert.equal(JSON.stringify(sweep.narrativeEligibilityV1), before);
});

function amdInput(sweep) {
    var candles = [];
    for (var i = 0; i <= 5; i++) candles.push(candle(i, i === 4 ? 99 : 101));
    return {
        candle: candles[5], candleIndex: 5, candles: candles,
        evaluationTime: candle(5, 101).closeTime, symbol: 'X', timeframe: '5m',
        newSweeps: [sweep], newMss: [], newDisplacements: []
    };
}
function accumulationState() {
    var state = amdState.createAmdState();
    state.phase = 'ACCUMULATION';
    state.lastPhase = 'ACCUMULATION';
    state.accumulation = {
        rangeLow: 100, rangeHigh: 110, atr: 5,
        confirmedAt: candle(1, 105).closeTime
    };
    state.confirmedAt = state.accumulation.confirmedAt;
    return state;
}

test('24 AMD still receives Swing Sweep with unchanged score/phase/transition', function () {
    var off = built('SWING_LOW', false);
    var on = built('SWING_LOW', true);
    off.confirmedAt = on.confirmedAt = candle(4, 99).closeTime;
    off.candleIndex = on.candleIndex = 4;
    off.price = on.price = 99;
    var a = amdState.updateAmdState(accumulationState(), amdInput(off));
    var b = amdState.updateAmdState(accumulationState(), amdInput(on));
    assert.equal(a.phase, b.phase);
    assert.equal(a.lastPhase, b.lastPhase);
    assert.equal(a.manipulation.score, b.manipulation.score);
    assert.equal(a.manipulation.sweepEvent.id, b.manipulation.sweepEvent.id);
    assert.equal(b.manipulation.sweepEvent.narrativeEligibilityV1.narrativeEligible, false);
});

function watchFor(takens) {
    var displacement = {
        id: 'D1', type: 'DISPLACEMENT', symbol: 'X', timeframe: '5m', direction: 'BULLISH',
        startIndex: 3, endIndex: 3, startAt: candle(3, 103).openTime,
        endAt: candle(3, 103).closeTime, confirmedAt: candle(3, 103).closeTime,
        startPrice: 100, endPrice: 103, sourceDetections: []
    };
    return displacementWatch.buildWatch({
        symbol: 'X',
        displacement: displacement,
        evaluationTime: displacement.confirmedAt,
        takenEvents: takens,
        candles: [candle(0, 100), candle(1, 100), candle(2, 100), candle(3, 103)]
    });
}

test('25 WATCH candidates/primary/count/timing/direction ignore shadow metadata', function () {
    var off = builtTaken('EQL', false);
    var on = builtTaken('EQL', true);
    off.confirmedAt = on.confirmedAt = candle(2, 100).closeTime;
    off.candleIndex = on.candleIndex = 2;
    var a = watchFor([off]);
    var b = watchFor([on]);
    assert.deepEqual(b, a);
    assert.equal(b.liquidityTaken.primary.id, off.id);
    assert.equal(b.direction, 'BULLISH');
    assert.equal(b.createdAt, a.createdAt);
});

test('26 SweepContext inputs remain present on raw Swing Sweep', function () {
    var event = built('SWING_HIGH', true);
    assert.equal(event.source.liquidityId, liquidity('SWING_HIGH').id);
    assert.equal(event.source.liquidityType, 'SWING_HIGH');
    assert.equal(event.source.liquidityPrice, 100);
    assert.ok(event.source.candle);
});

test('27 classifier has no consumer decision fields', function () {
    var text = JSON.stringify(decision('EQH'));
    assert.equal(/primary|ranking|score|watch|amd|outcome/i.test(text), false);
});
