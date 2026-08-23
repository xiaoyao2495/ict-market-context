'use strict';
var assert = require('assert');
var structural = require('../structure/structuralProvenance5m');

var BAR = 300000;
var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + ' -> ' + e.message); }
}
function candle(i, o, h, l, c) {
    return { openTime: i * BAR, closeTime: (i + 1) * BAR - 1,
        open: o, high: h, low: l, close: c, closed: true };
}
function swing(side, idx, price, confirmIdx) {
    return {
        id: 'X:5m:SWING_' + side + ':' + idx * BAR,
        symbol: 'X', timeframe: '5m', type: 'SWING_' + side,
        price: price, sourceOpenTime: idx * BAR,
        confirmedAt: (confirmIdx + 1) * BAR - 1,
        metadata: { index: idx }
    };
}

function seededBullishState() {
    var s = structural.createState({ symbol: 'X', timeframe: '5m' });
    structural.step(s, candle(4, 99, 100, 98, 99), 4, [
        swing('HIGH', 0, 100, 2), swing('LOW', 1, 90, 3)
    ]);
    var r = structural.step(s, candle(5, 99, 103, 98, 102), 5, []);
    assert.strictEqual(r.bos.length, 1);
    assert.strictEqual(s.activeProtected.LOW.price, 90);
    return s;
}

test('confirmed 2L/2R only; BOS provenance activates controlling low', function () {
    var s = seededBullishState();
    var low = s.activeProtected.LOW;
    assert.strictEqual(low.status, 'ACTIVE_PROTECTED');
    assert.strictEqual(low.protectedConfirmedAt, 6 * BAR - 1);
    assert.ok(low.confirmedAt <= low.protectedConfirmedAt);
    assert.strictEqual(s.structuralState, 'BULLISH');
});

test('wick penetration does not create Structural MSS', function () {
    var s = seededBullishState();
    var r = structural.step(s, candle(6, 92, 94, 89, 91), 6, []);
    assert.strictEqual(r.penetrations.length, 1);
    assert.strictEqual(r.mss.length, 0);
    assert.strictEqual(s.activeProtected.LOW.status, 'ACTIVE_PROTECTED');
});

test('opposite close through active protected creates an immediate state-changing MSS', function () {
    var s = seededBullishState();
    // No newly confirmed controlling HIGH is required at the break candle.
    var r = structural.step(s, candle(7, 92, 94, 85, 88), 7, []);
    assert.strictEqual(r.mss.length, 1);
    assert.strictEqual(r.mss[0].type, 'MSS');
    assert.strictEqual(r.mss[0].protectedBreak, true);
    assert.strictEqual(r.mss[0].mssGrade, 'PROTECTED');
    assert.strictEqual(r.mss[0].structuralStateBefore, 'BULLISH');
    assert.strictEqual(r.mss[0].structuralStateAfter, 'BEARISH');
    assert.strictEqual(r.mss[0].referenceLevel, 90);
    assert.strictEqual(r.mss[0].confirmedAt, 8 * BAR - 1);
    assert.strictEqual(r.structuralMss.length, 1);
    assert.strictEqual(r.structuralMss[0].type, 'STRUCTURAL_MSS');
    assert.strictEqual(r.mss[0].metadata.structuralMssEventId, r.structuralMss[0].id);
});

test('new local swing never replaces protected without new provenance', function () {
    var s = seededBullishState();
    structural.step(s, candle(7, 97, 99, 94, 98), 7, [swing('LOW', 5, 95, 7)]);
    assert.strictEqual(s.activeProtected.LOW.price, 90);
    var local = s.swingBySourceId['X:5m:SWING_LOW:' + 5 * BAR];
    assert.strictEqual(local.role, 'INTERNAL');
});

test('new same-direction provenance supersedes, rather than proximity replacing, the old protected swing', function () {
    var s = seededBullishState();
    structural.step(s, candle(8, 102, 108, 100, 106), 8, [swing('HIGH', 6, 109, 8)]);
    structural.step(s, candle(9, 104, 106, 94, 105), 9, [swing('LOW', 7, 95, 9)]);
    var r = structural.step(s, candle(10, 108, 112, 107, 111), 10, []);
    assert.strictEqual(r.bos.length, 0);
    assert.strictEqual(r.continuations.length, 1);
    assert.strictEqual(r.continuations[0].structuralStateBefore, 'BULLISH');
    assert.strictEqual(r.continuations[0].structuralStateAfter, 'BULLISH');
    assert.strictEqual(r.continuations[0].stateChanged, false);
    assert.strictEqual(s.activeProtected.LOW.price, 95);
    var old = s.swingBySourceId['X:5m:SWING_LOW:' + 1 * BAR];
    assert.strictEqual(old.status, 'SUPERSEDED_PROTECTED');
});

test('an opposite local/frontier close emits MSS signal but cannot change structural state', function () {
    var s = seededBullishState();
    var localLow = swing('LOW', 4, 96, 6);
    structural.step(s, candle(6, 100, 102, 97, 99), 6, [localLow]);
    s.frontier.LOW = s.swingBySourceId[localLow.id];
    var r = structural.step(s, candle(7, 98, 99, 94, 95), 7, []);
    assert.strictEqual(r.bos.length, 0);
    assert.strictEqual(r.mss.length, 1);
    assert.strictEqual(r.mss[0].type, 'MSS');
    assert.strictEqual(r.mss[0].protectedBreak, false);
    assert.notStrictEqual(r.mss[0].referenceStructuralRole, 'ACTIVE_PROTECTED');
    assert.strictEqual(r.structuralMss.length, 0);
    assert.strictEqual(s.structuralState, 'BULLISH');
});

test('HR-01: age=25 does not demote a meaningful active protected reference', function () {
    var s = structural.createState({ symbol: 'X', timeframe: '5m' });
    var high = {
        id: 'STRUCT:HR01_HIGH', sourceSwingId: 'HR01_HIGH', symbol: 'X', timeframe: '5m',
        side: 'HIGH', price: 64568.5, occurredAt: 0, confirmedAt: 3 * BAR - 1,
        index: 0, role: 'ACTIVE_PROTECTED', status: 'ACTIVE_PROTECTED',
        protectedConfirmedAt: 4 * BAR - 1, provenance: {}, supersededBy: null,
        brokenAt: null, brokenConfirmedAt: null, producedCandidateFor: [], history: []
    };
    s.swings.push(high); s.swingBySourceId.HR01_HIGH = high; s.activeProtected.HIGH = high;
    s.structuralState = 'BEARISH';
    structural.step(s, candle(24, 64400, 64420, 64350, 64380), 24,
        [swing('LOW', 20, 64320, 22)]);
    var r = structural.step(s, candle(25, 64550, 64813.1, 64537.3, 64785.1), 25, []);
    assert.strictEqual(r.mss.length, 1);
    assert.strictEqual(r.mss[0].referenceLevel, 64568.5);
    assert.strictEqual(r.mss[0].protectedBreak, true);
    assert.strictEqual(structural.qualityForMss(r.mss[0]), 'PROTECTED_SWING');
});

test('HR-02 class: unresolved produced frontier cannot become opposite protected swing', function () {
    var s = structural.createState({ symbol: 'X', timeframe: '5m' });
    var old = {
        id: 'STRUCT:OLD_LOW', sourceSwingId: 'OLD_LOW', symbol: 'X', timeframe: '5m',
        side: 'LOW', price: 63437.8, occurredAt: 0, confirmedAt: BAR - 1,
        index: 0, role: 'ACTIVE_PROTECTED', status: 'ACTIVE_PROTECTED',
        protectedConfirmedAt: BAR - 1, provenance: {}, supersededBy: null,
        brokenAt: null, brokenConfirmedAt: null, producedCandidateFor: [], history: []
    };
    s.swings.push(old); s.swingBySourceId.OLD_LOW = old; s.activeProtected.LOW = old;
    s.structuralState = 'BULLISH';
    s.frontier.HIGH = {
        id: 'STRUCT:H0', sourceSwingId: 'H0', symbol: 'X', timeframe: '5m',
        side: 'HIGH', price: 63784.7, occurredAt: BAR, confirmedAt: 3 * BAR - 1,
        index: 1, role: 'CONTROLLING_SWING', status: 'CANDIDATE',
        protectedConfirmedAt: null, provenance: null, supersededBy: null,
        brokenAt: null, brokenConfirmedAt: null, producedCandidateFor: [], history: []
    };
    s.swings.push(s.frontier.HIGH); s.swingBySourceId.H0 = s.frontier.HIGH;
    s.pendingProduced.LOW = { parentPrice: 63600, breakCandleOpenTime: 2 * BAR, eventId: 'PRIOR_BEARISH_PRODUCED_LOW' };
    structural.step(s, candle(4, 63575.9, 63718.3, 63534, 63718.3), 4,
        [swing('LOW', 2, 63534, 4)]);
    structural.step(s, candle(5, 63779.9, 63820, 63657.9, 63817.4), 5, []);
    var hr02 = s.swingBySourceId['X:5m:SWING_LOW:' + 2 * BAR];
    assert.strictEqual(hr02.role, 'INTERNAL');
    assert.strictEqual(hr02.price, 63534);
    assert.strictEqual(hr02.protectedConfirmedAt, null);
    assert.strictEqual(s.activeProtected.LOW.id, old.id);
});

test('all formation facts are confirmed no later than their event', function () {
    var s = seededBullishState();
    s.events.forEach(function (e) {
        assert.ok(e.confirmedAt >= e.source.referencePrice * 0); // numeric sanity
        assert.ok(e.metadata.protectedConfirmedAt <= e.confirmedAt);
    });
    s.swings.forEach(function (sw) {
        if (sw.protectedConfirmedAt != null) assert.ok(sw.confirmedAt <= sw.protectedConfirmedAt);
    });
});

console.log('\nstructuralProvenance5m: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
