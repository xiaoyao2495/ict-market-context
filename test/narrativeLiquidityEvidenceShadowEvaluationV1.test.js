'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var audit = require('../audit/narrativeLiquidityEvidenceShadowEvaluationV1');

function fixture(overrides) {
    overrides = overrides || {};
    var direction = overrides.direction || 'BEARISH';
    var sourceType = overrides.sourceType || 'EQH';
    var status = overrides.status || 'PROPOSED_ELIGIBLE';
    var eligible = overrides.eligible !== undefined ? overrides.eligible : true;
    var legStart = 100;
    var distance = overrides.distance !== undefined ? overrides.distance : 1;
    var inside = overrides.inside === true;
    var candleIndex = inside ? 100 : legStart - distance;
    var firstConfirmedAt = 1000000;
    var confirmedAt = inside ? firstConfirmedAt : firstConfirmedAt - distance * 300000;
    if (overrides.future) confirmedAt = 2000000;
    var watch = {id: overrides.watchId || 'W1', direction: direction, updatedAt: 1500000,
        displacement: {id: overrides.legId || 'L1', startIndex: legStart, endIndex: 102, firstConfirmedAt: firstConfirmedAt, lastConfirmedAt: 1600000},
        mss: overrides.mss || {exists: false}};
    var side = overrides.side || (direction === 'BULLISH' ? 'SSL' : 'BSL');
    var sweep = {id: overrides.sweepId || 'S1', side: side, candleIndex: candleIndex, confirmedAt: confirmedAt,
        narrativeEligibilityV1: {status: status, narrativeEligible: eligible}, liquiditySource: {type: sourceType}};
    return {watch: watch, candidate: {id: sweep.id, side: side}, sweep: sweep, evaluationTime: watch.updatedAt};
}
function cls(overrides) { return audit.evaluateCandidate(fixture(overrides)).associationClass; }

test('1 EQH SHORT inside is strong', function () { assert.equal(cls({inside: true}), 'STRONG_ASSOCIATION_CANDIDATE'); });
test('2 EQL LONG before 1 is strong', function () { assert.equal(cls({sourceType: 'EQL', direction: 'BULLISH', distance: 1}), 'STRONG_ASSOCIATION_CANDIDATE'); });
test('3 EQH SHORT before 2 is strong', function () { assert.equal(cls({sourceType: 'EQH', distance: 2}), 'STRONG_ASSOCIATION_CANDIDATE'); });
test('4 EQL LONG before 3 is strong', function () { assert.equal(cls({sourceType: 'EQL', direction: 'BULLISH', distance: 3}), 'STRONG_ASSOCIATION_CANDIDATE'); });
test('5 before 4 is weak', function () { assert.equal(cls({distance: 4}), 'WEAK_ASSOCIATION_CANDIDATE'); });
test('6 before 48 is weak', function () { assert.equal(cls({distance: 48}), 'WEAK_ASSOCIATION_CANDIDATE'); });
test('7 before 49 is outside', function () { assert.equal(cls({distance: 49}), 'NO_NARRATIVE_ASSOCIATION'); });
test('8 Swing remains source ineligible', function () { assert.equal(cls({sourceType: 'SWING_HIGH', status: 'PROPOSED_INELIGIBLE', eligible: false, inside: true}), 'SOURCE_INELIGIBLE'); });
test('9 wrong side is direction invalid', function () { assert.equal(cls({sourceType: 'EQL', side: 'SSL', direction: 'BEARISH', inside: true}), 'DIRECTION_INVALID'); });
test('10 future confirmation invalid', function () { assert.equal(cls({future: true}), 'CONFIRMATION_INVALID'); });
test('11 Session frozen', function () { assert.equal(cls({sourceType: 'NEW_YORK_HIGH', status: 'OUT_OF_SCOPE_FROZEN', eligible: null}), 'FROZEN'); });
test('12 unknown unresolved', function () { assert.equal(cls({status: 'UNRESOLVED', eligible: null}), 'UNRESOLVED'); });
test('13 two strong is multiple without winner', function () {
    var a = fixture({sweepId: 'A'}), b = fixture({sweepId: 'B', distance: 2});
    var out = audit.evaluateWatch({watch: a.watch, evaluationTime: a.evaluationTime, candidates: [{candidate: a.candidate, sweep: a.sweep}, {candidate: b.candidate, sweep: b.sweep}]});
    assert.equal(out.associationClass, 'MULTIPLE_STRONG_EVIDENCE'); assert.equal(out.evidenceCount, 2); assert.equal(out.ambiguity, true);
});
test('14 exactly one strong', function () { var a = fixture({}); assert.equal(audit.evaluateWatch({watch: a.watch, evaluationTime: a.evaluationTime, candidates: [{candidate: a.candidate, sweep: a.sweep}]}).associationClass, 'SINGLE_STRONG_EVIDENCE'); });
test('15 only 7-12 weak', function () { var a = fixture({distance: 8}); assert.equal(audit.evaluateWatch({watch: a.watch, evaluationTime: a.evaluationTime, candidates: [{candidate: a.candidate, sweep: a.sweep}]}).associationClass, 'WEAK_ONLY_ELIGIBLE_EVIDENCE'); });
test('16 only Swing has no evidence', function () { var a = fixture({status: 'PROPOSED_INELIGIBLE', eligible: false}); assert.equal(audit.evaluateWatch({watch: a.watch, evaluationTime: a.evaluationTime, candidates: [{candidate: a.candidate, sweep: a.sweep}]}).associationClass, 'NO_ELIGIBLE_NARRATIVE_EVIDENCE'); });
test('17 same-leg reuse detected', function () { assert.equal(audit.reuseClass([{legId: 'L1'}, {legId: 'L1'}]), 'SAME_LEG_REUSE'); });
test('18 cross-leg reuse detected', function () { assert.equal(audit.reuseClass([{legId: 'L1'}, {legId: 'L2'}]), 'CROSS_LEG_REUSE'); });
test('19 MSS absent does not block strong', function () { assert.equal(cls({mss: {exists: false}}), 'STRONG_ASSOCIATION_CANDIDATE'); });
test('20 matching MSS is supporting only', function () { var out = audit.evaluateCandidate(fixture({mss: {exists: true, direction: 'BEARISH'}})); assert.equal(out.associationClass, 'STRONG_ASSOCIATION_CANDIDATE'); assert.equal(out.mssDirectionMatched, true); });
test('21 candidate order does not change evidence identities', function () {
    var a = fixture({sweepId: 'A'}), b = fixture({sweepId: 'B', distance: 2}), list = [{candidate: a.candidate, sweep: a.sweep}, {candidate: b.candidate, sweep: b.sweep}];
    function ids(rows) { return audit.evaluateWatch({watch: a.watch, evaluationTime: a.evaluationTime, candidates: rows}).evidenceCandidates.map(function (x) { return x.barsFromSweepToLegStart; }).sort(); }
    assert.deepEqual(ids(list), ids(list.slice().reverse()));
});
test('22 future fields cannot rewrite past classification', function () { var a = fixture({}), before = audit.evaluateCandidate(a); a.sweep.futureRole = 'CONTROLLING'; a.sweep.futureOutcome = 100; assert.deepEqual(audit.evaluateCandidate(a), before); });
