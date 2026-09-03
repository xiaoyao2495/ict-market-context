'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var policy = require('../audit/watchNarrativeLiquidityPolicyDesignV1');
var classifier = require('../events/sweepNarrativeEligibilityV1');

var BAR = policy.BAR_MS;
function candidate(type, side, index) {
    return {id: 'SWEEP:' + type + ':' + index, sourceId: 'L:' + type, sourceType: type, side: side, candleIndex: index, confirmedAt: (index + 1) * BAR - 1};
}
function sweep(c, options) {
    var opts = options || {};
    return {id: c.id, side: c.side, candleIndex: c.candleIndex,
        confirmedAt: opts.confirmedAt === undefined ? c.confirmedAt : opts.confirmedAt,
        source: {liquidityType: c.sourceType}, narrativeEligibilityV1: classifier.classifySourceType(c.sourceType)};
}
function watch(direction, options) {
    var opts = options || {};
    return {id: 'W', direction: direction, updatedAt: opts.updatedAt || 20 * BAR,
        displacement: {startIndex: 10, endIndex: 12, firstConfirmedAt: 11 * BAR - 1, lastConfirmedAt: 13 * BAR - 1},
        mss: opts.mss || {exists: false, direction: null}};
}
function evaluate(type, side, index, direction, options) {
    var c = candidate(type, side, index), w = watch(direction, options);
    return policy.evaluateCandidate({watch: w, candidate: c, sweep: sweep(c, options), evaluationTime: w.updatedAt});
}

test('1 EQH + BSL + legal BEFORE_LEG is valid', function () {
    var row = evaluate('EQH', 'BSL', 8, 'BEARISH');
    assert.equal(row.narrativeEvidenceEligible, true);
    assert.equal(row.relation, 'BEFORE_LEG');
});
test('2 EQL + SSL + legal BEFORE_LEG is valid', function () {
    assert.equal(evaluate('EQL', 'SSL', 9, 'BULLISH').narrativeEvidenceEligible, true);
});
test('3 EQH cannot support LONG', function () {
    var row = evaluate('EQH', 'BSL', 9, 'BULLISH');
    assert.equal(row.directionEligible, false);
    assert.equal(row.narrativeEvidenceEligible, false);
});
test('4 EQL cannot support SHORT', function () {
    assert.equal(evaluate('EQL', 'SSL', 9, 'BEARISH').narrativeEvidenceEligible, false);
});
test('5 perfect-time SWING_HIGH remains source-ineligible', function () {
    var row = evaluate('SWING_HIGH', 'BSL', 9, 'BEARISH');
    assert.equal(row.sourceEligible, false);
    assert.equal(row.narrativeEvidenceEligible, false);
});
test('6 confirmedAt after evaluationTime is invalid', function () {
    var row = evaluate('EQH', 'BSL', 9, 'BEARISH', {confirmedAt: 30 * BAR, updatedAt: 20 * BAR});
    assert.equal(row.temporalEligible, false);
    assert.ok(row.reasonCodes.indexOf('SWEEP_CONFIRMED_AFTER_DECISION') >= 0);
});
test('7 future-confirmed source cannot backfill the leg', function () {
    var row = evaluate('EQH', 'BSL', 9, 'BEARISH', {confirmedAt: 14 * BAR, updatedAt: 13 * BAR});
    assert.equal(row.narrativeEvidenceEligible, false);
});
test('8 eligible INSIDE_LEG candidate has deterministic valid result', function () {
    var row = evaluate('EQH', 'BSL', 11, 'BEARISH');
    assert.equal(row.relation, 'INSIDE_LEG');
    assert.equal(row.legAssociationEligible, true);
    assert.equal(row.narrativeEvidenceEligible, true);
});
test('9 stale eligible source is not automatically strong', function () {
    var row = evaluate('EQH', 'BSL', -10, 'BEARISH');
    assert.equal(row.sourceEligible, true);
    assert.equal(row.legAssociationEligible, false);
    assert.equal(row.narrativeEvidenceEligible, false);
});
test('10 multiple strong eligible Sweeps preserve ambiguity', function () {
    var a = evaluate('EQH', 'BSL', 8, 'BEARISH'), b = evaluate('EQH', 'BSL', 9, 'BEARISH');
    assert.equal(policy.classifyWatchAssociation([a, b]), 'ELIGIBLE_SOURCE_ASSOCIATION_AMBIGUOUS');
});
test('11 MSS absent remains allowed by proposed policy', function () {
    var row = evaluate('EQH', 'BSL', 9, 'BEARISH');
    assert.equal(row.mssRequired, false);
    assert.equal(row.mssExists, false);
    assert.equal(row.narrativeEvidenceEligible, true);
});
test('12 opposite MSS is not supporting but does not impersonate confirmation', function () {
    var row = evaluate('EQH', 'BSL', 9, 'BEARISH', {mss: {exists: true, direction: 'BULLISH'}});
    assert.equal(row.mssDirectionMatched, false);
    assert.ok(row.reasonCodes.indexOf('MSS_OPPOSITE_NOT_SUPPORTING') >= 0);
});
test('13 Session remains frozen/null', function () {
    var row = evaluate('NEW_YORK_HIGH', 'BSL', 9, 'BEARISH');
    assert.equal(row.sourceEligible, null);
    assert.equal(row.sourceStatus, 'OUT_OF_SCOPE_FROZEN');
    assert.equal(row.narrativeEvidenceEligible, null);
});
test('14 same Sweep reuse is visible in audit distribution', function () {
    assert.deepEqual(policy.reuseDistribution({A: ['W1', 'W2', 'W3'], B: ['W4'], C: ['W5', 'W6']}), {
        ONE_WATCH: 1, TWO_WATCHES: 1, THREE_PLUS_WATCHES: 1, MAX_WATCHES_PER_SWEEP: 3
    });
});
test('15 past state is immutable', function () {
    var c = candidate('EQH', 'BSL', 9), s = sweep(c), w = watch('BEARISH'), before = JSON.stringify({c: c, s: s, w: w});
    policy.evaluateCandidate({watch: w, candidate: c, sweep: s, evaluationTime: w.updatedAt});
    assert.equal(JSON.stringify({c: c, s: s, w: w}), before);
});
test('16 same input is deterministic', function () {
    var c = candidate('EQH', 'BSL', 9), s = sweep(c), w = watch('BEARISH'), input = {watch: w, candidate: c, sweep: s, evaluationTime: w.updatedAt};
    assert.deepEqual(policy.evaluateCandidate(input), policy.evaluateCandidate(input));
});
