'use strict';

var assert = require('assert');
var audit = require('../scripts/accumulationGroundTruthConsistencyAuditV2Phase2');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function review(blindId, formationClass, confidence) {
    return { blindId: blindId, formationClass: formationClass, confidence: confidence,
        balanceQuality: 'MODERATE', independentBalanceFormed: 'PARTIAL', twoSidedAuction: 'PARTIAL',
        trendPauseCharacter: 'MODERATE', oneSidedResidence: 'MILD', centerBehavior: 'STABLE',
        excursionBehavior: 'PARTIALLY_REABSORBED', observationTags: [], freeText: 'formation-only review' };
}

test('review distribution is computed from file contents', function () {
    assert.deepStrictEqual(audit.distribution([review('A', 'CLEAR_A', 'HIGH'), review('B', 'NO_A', 'LOW')]),
        { CLEAR_A: 1, BORDERLINE_A: 0, NO_A: 1, UNSURE: 0 });
});

test('24 complete proposal reviews validate', function () {
    var reviews = [], cases = [];
    for (var i = 1; i <= 24; i++) { var id = 'GT-BLIND-' + String(i).padStart(2, '0');
        reviews.push(review(id, i % 2 ? 'CLEAR_A' : 'NO_A', 'HIGH'));
        cases.push({ blindId: id, primaryOrAnchor: 'PRIMARY' }); }
    var input = { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2',
        reviewSource: 'CHATGPT_BLIND_VISUAL_REVIEW_PROPOSAL', reviews: reviews };
    assert.deepStrictEqual(audit.validateReview(input, { cases: cases }), []);
});

test('unblind relation distinguishes exact adjacent major and unsure', function () {
    var input = { reviews: [review('A', 'CLEAR_A', 'HIGH'), review('B', 'BORDERLINE_A', 'MEDIUM'),
        review('C', 'NO_A', 'HIGH'), review('D', 'UNSURE', 'LOW')] };
    var map = { cases: [
        { blindId: 'A', originalCaseId: 'x1', primaryOrAnchor: 'PRIMARY', frozenGroundTruth: 'CLEAR_A' },
        { blindId: 'B', originalCaseId: 'x2', primaryOrAnchor: 'PRIMARY', frozenGroundTruth: 'CLEAR_A' },
        { blindId: 'C', originalCaseId: 'x3', primaryOrAnchor: 'PRIMARY', frozenGroundTruth: 'CLEAR_A' },
        { blindId: 'D', originalCaseId: 'x4', primaryOrAnchor: 'PRIMARY', frozenGroundTruth: 'NO_A' }] };
    assert.deepStrictEqual(audit.unblind(input, map).map(function (x) { return x.agreementRelation; }),
        ['EXACT', 'ADJACENT_DISAGREEMENT', 'MAJOR_DISAGREEMENT', 'UNSURE']);
});

test('agreement matrix and frozen stability boundaries are exact', function () {
    var rows = [
        { frozenGroundTruth: 'CLEAR_A', blindLabel: 'CLEAR_A', agreementRelation: 'EXACT' },
        { frozenGroundTruth: 'CLEAR_A', blindLabel: 'BORDERLINE_A', agreementRelation: 'ADJACENT_DISAGREEMENT' },
        { frozenGroundTruth: 'NO_A', blindLabel: 'CLEAR_A', agreementRelation: 'MAJOR_DISAGREEMENT' }];
    var matrix = audit.agreementMatrix(rows);
    assert.deepStrictEqual(matrix.overall, { total: 3, exact: 1, adjacent: 1, major: 1, unsure: 0 });
    assert.strictEqual(audit.stability(6, 8).stability, 'STABLE');
    assert.strictEqual(audit.stability(4, 8).stability, 'MODERATELY_STABLE');
    assert.strictEqual(audit.stability(3, 8).stability, 'UNSTABLE');
});

test('semantic audit reports only the three existing candidates', function () {
    function row(label, independent, twoSided, excursion) { return { blindLabel: label, humanSemanticAnswers: {
        independentBalanceFormed: independent, twoSidedAuction: twoSided, trendPauseCharacter: 'WEAK',
        oneSidedResidence: 'MILD', centerBehavior: 'STABLE', excursionBehavior: excursion } }; }
    var result = audit.semanticAnalysis([row('CLEAR_A', 'YES', 'COHERENT', 'REABSORBED'),
        row('BORDERLINE_A', 'PARTIAL', 'PARTIAL', 'PARTIALLY_REABSORBED'), row('NO_A', 'NO', 'WEAK', 'NO_CLEAR_EXCURSION')]);
    assert.strictEqual(Object.keys(result.existingSemanticCandidates).length, 3);
    assert.ok(Object.values(result.existingSemanticCandidates).every(function (x) { return x.status === 'SUPPORTED'; }));
    assert.ok(result.newSemanticObservationCount <= 2);
});

console.log('\nAccumulation Ground Truth Consistency Audit V2 Phase 2: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
