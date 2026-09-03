'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var audit = require('../audit/watchNarrativeEligibleCandidateShadowComparisonV1');
var classifier = require('../events/sweepNarrativeEligibilityV1');
var amdState = require('../amd/amdState');

function candidate(id, type, options) {
    var opts = options || {};
    return {
        id: id, sourceId: 'LIQ:' + id, sourceType: type,
        side: opts.side || (/LOW$|EQL/.test(type) ? 'SSL' : 'BSL'),
        confirmedAt: opts.confirmedAt === undefined ? 100 : opts.confirmedAt,
        candleIndex: opts.candleIndex === undefined ? 10 : opts.candleIndex,
        barsBeforeLegStart: opts.barsBeforeLegStart === undefined ? 2 : opts.barsBeforeLegStart,
        relation: 'BEFORE_LEG'
    };
}
function sweep(c, options) {
    var opts = options || {};
    var event = {
        id: c.id, source: {liquidityType: c.sourceType}, side: c.side,
        confirmedAt: c.confirmedAt, candleIndex: c.candleIndex
    };
    if (!opts.missing) event.narrativeEligibilityV1 = classifier.classifySourceType(c.sourceType);
    return event;
}
function watch(primary, candidates, options) {
    var opts = options || {};
    return {
        id: opts.id || 'W', direction: opts.direction || 'BEARISH', watchDirection: opts.direction === 'BULLISH' ? 'WATCH_LONG' : 'WATCH_SHORT',
        createdAt: 200, updatedAt: 200,
        liquidityTaken: {primary: primary, allCandidates: candidates}
    };
}
function classify(primary, candidates, sweepOptions) {
    var map = {};
    candidates.concat([primary]).forEach(function (c) { map[c.id] = sweep(c, sweepOptions && sweepOptions[c.id]); });
    return audit.classifyWatch(watch(primary, candidates), map);
}

test('1 primary EQH -> CURRENT_PRIMARY_ELIGIBLE', function () {
    var eqh = candidate('EQH', 'EQH');
    assert.equal(classify(eqh, [eqh]).bucket, audit.BUCKETS.CURRENT_PRIMARY_ELIGIBLE);
});

test('2 primary SWING_HIGH + EQH -> Bucket B', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH');
    assert.equal(classify(swing, [eqh, swing]).bucket, audit.BUCKETS.PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS);
});

test('3 only SWING_LOW -> Bucket C', function () {
    var a = candidate('A', 'SWING_LOW'), b = candidate('B', 'SWING_LOW');
    assert.equal(classify(a, [a, b]).bucket, audit.BUCKETS.ONLY_INELIGIBLE_SWING_CANDIDATES);
});

test('4 Swing + NEW_YORK frozen -> Bucket D', function () {
    var swing = candidate('S', 'SWING_HIGH'), session = candidate('N', 'NEW_YORK_HIGH');
    assert.equal(classify(swing, [swing, session]).bucket, audit.BUCKETS.FROZEN_SOURCE_PRESENT);
});

test('5 eligible primary + frozen still -> Bucket D', function () {
    var eqh = candidate('E', 'EQH'), session = candidate('N', 'NEW_YORK_HIGH');
    assert.equal(classify(eqh, [eqh, session]).bucket, audit.BUCKETS.FROZEN_SOURCE_PRESENT);
});

test('6 unresolved or missing -> Bucket E', function () {
    var swing = candidate('S', 'SWING_HIGH'), unknown = candidate('U', 'UNKNOWN_TYPE');
    assert.equal(classify(swing, [swing, unknown]).bucket, audit.BUCKETS.UNRESOLVED_PRESENT);
    var missing = candidate('M', 'EQH');
    assert.equal(classify(swing, [swing, missing], {M: {missing: true}}).bucket, audit.BUCKETS.UNRESOLVED_PRESENT);
});

test('7 Swing primary + EQH + EQL gives two eligible alternatives', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH'), eql = candidate('L', 'EQL');
    var row = classify(swing, [eqh, swing, eql]);
    assert.equal(row.bucket, audit.BUCKETS.PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS);
    assert.equal(row.eligibleAlternativeCount, 2);
    assert.deepEqual(row.eligibleAlternativeSourceTypes, ['EQH', 'EQL']);
});

test('8 removed calendar type PMH is no longer an eligible alternative', function () {
    var swing = candidate('S', 'SWING_HIGH'), pmh = candidate('M', 'PMH');
    var row = classify(swing, [swing, pmh]);
    assert.equal(row.bucket, audit.BUCKETS.UNRESOLVED_PRESENT);
    assert.deepEqual(row.eligibleAlternativeSourceTypes, []);
});

test('9 current primary identity is immutable', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH'), input = watch(swing, [eqh, swing]);
    var before = JSON.stringify(input.liquidityTaken.primary);
    audit.analyze([input], [sweep(swing), sweep(eqh)]);
    assert.equal(JSON.stringify(input.liquidityTaken.primary), before);
});

test('10 candidate order is immutable', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH'), other = candidate('D', 'SWING_LOW');
    var input = watch(swing, [eqh, swing, other]), before = input.liquidityTaken.allCandidates.map(function (c) { return c.id; });
    var result = audit.analyze([input], [sweep(swing), sweep(eqh), sweep(other)]);
    assert.deepEqual(input.liquidityTaken.allCandidates.map(function (c) { return c.id; }), before);
    assert.deepEqual(result.rows[0].candidateOrder, before);
});

test('11 AMD state and input are untouched by comparison', function () {
    var state = amdState.createAmdState(), before = JSON.stringify(state), swing = candidate('S', 'SWING_HIGH');
    var event = sweep(swing), eventBefore = JSON.stringify(event);
    audit.analyze([watch(swing, [swing])], [event]);
    assert.equal(JSON.stringify(state), before);
    assert.equal(JSON.stringify(event), eventBefore);
});

test('12 future structural/lifecycle fields cannot alter bucket', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH');
    var events = [sweep(swing), sweep(eqh)], a = audit.analyze([watch(swing, [swing, eqh])], events).rows[0].bucket;
    events[0].futureStructuralRole = 'ACTIVE_PROTECTED';
    events[0].source.laterLifecycle = 'BROKEN';
    events[1].futureOutcome = 'WIN';
    var b = audit.analyze([watch(swing, [swing, eqh])], events).rows[0].bucket;
    assert.equal(a, b);
});

test('13 same input is deterministic including nearest audit field', function () {
    var swing = candidate('S', 'SWING_HIGH'), eqh = candidate('E', 'EQH', {barsBeforeLegStart: 4}), other = candidate('D', 'SWING_LOW', {barsBeforeLegStart: 1});
    var input = watch(swing, [eqh, swing, other]), events = [sweep(swing), sweep(eqh), sweep(other)];
    assert.deepEqual(audit.analyze([input], events).rows, audit.analyze([input], events).rows);
    assert.equal(audit.analyze([input], events).rows[0].nearestEligibleAlternative.sweepId, 'E');
});

test('14 every WATCH enters exactly one canonical bucket', function () {
    var cases = [];
    var eqh = candidate('E1', 'EQH'); cases.push(watch(eqh, [eqh], {id: 'A'}));
    var s1 = candidate('S1', 'SWING_HIGH'), e2 = candidate('E2', 'EQH'); cases.push(watch(s1, [s1, e2], {id: 'B'}));
    var s2 = candidate('S2', 'SWING_HIGH'); cases.push(watch(s2, [s2], {id: 'C'}));
    var s3 = candidate('S3', 'SWING_HIGH'), n = candidate('N', 'NEW_YORK_HIGH'); cases.push(watch(s3, [s3, n], {id: 'D'}));
    var s4 = candidate('S4', 'SWING_HIGH'), u = candidate('U', 'UNKNOWN_TYPE'); cases.push(watch(s4, [s4, u], {id: 'E'}));
    var candidates = [eqh, s1, e2, s2, s3, n, s4, u], result = audit.analyze(cases, candidates.map(function (c) { return sweep(c); }));
    assert.equal(result.rows.length, cases.length);
    assert.deepEqual(result.rows.map(function (row) { return row.bucket; }), [
        audit.BUCKETS.CURRENT_PRIMARY_ELIGIBLE,
        audit.BUCKETS.PRIMARY_INELIGIBLE_BUT_ELIGIBLE_ALTERNATIVE_EXISTS,
        audit.BUCKETS.ONLY_INELIGIBLE_SWING_CANDIDATES,
        audit.BUCKETS.FROZEN_SOURCE_PRESENT,
        audit.BUCKETS.UNRESOLVED_PRESENT
    ]);
});
