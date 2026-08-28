'use strict';

var assert = require('assert');
var fs = require('fs');
var phase2 = require('../scripts/accumulationGroundTruthV2FullRelabelPhase2V1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = ROOT + '/accumulation-ground-truth-v2-full-relabel-v1';
var proposal = JSON.parse(fs.readFileSync('/Users/yaodebao/Downloads/accumulation-ground-truth-v2-blind-review-results-proposal.json', 'utf8'));
var order = JSON.parse(fs.readFileSync(OUT + '/blind-review-order.json', 'utf8')).blindIds;
var map = JSON.parse(fs.readFileSync(OUT + '/blind-case-map.json', 'utf8')).cases;
var v1 = JSON.parse(fs.readFileSync(ROOT + '/accumulation-comparative-audit-v1/human-ground-truth-v1-final.json', 'utf8'));
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

test('normalization changes envelope only and preserves all response values and order', function () {
    var frozen = phase2.normalizeReview(proposal);
    assert.strictEqual(frozen.schemaVersion, 'ACCUMULATION_GROUND_TRUTH_V2_BLIND_REVIEW_V1');
    assert.strictEqual(frozen.reviewProvenance, 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW');
    assert.deepStrictEqual(frozen.responses, proposal.cases);
    assert.strictEqual(frozen.responses.length, 60);
});

test('pre-unblind validation exactly matches approved frozen facts', function () {
    var frozen = phase2.normalizeReview(proposal), result = phase2.validatePreUnblind(frozen, order);
    assert.strictEqual(result.REVIEW_COMPLETE, true);
    assert.strictEqual(result.REVIEWED_CASES, 60);
    assert.strictEqual(result.CLEAR_A, 23);
    assert.strictEqual(result.BORDERLINE_A, 10);
    assert.strictEqual(result.NO_A, 27);
    assert.strictEqual(result.UNSURE, 0);
    assert.strictEqual(result.CORE_SEMANTIC_CONTRADICTIONS, 0);
    assert.strictEqual(result.DEFINITION_EDGE_CASES, 12);
    assert.strictEqual(result.DEFINITION_EDGE_CASE_RATE, 0.20);
    assert.deepStrictEqual(result.EDGE_BLIND_IDS, phase2.EXPECTED_EDGE_IDS);
    assert.strictEqual(result.UNBLIND_BEFORE_REVIEW_COMPLETE, false);
});

test('unblind produces exactly 60 V2 rows with required provenance and no value rewrite', function () {
    var rows = phase2.normalizeReview(proposal).responses;
    var v2 = phase2.buildGroundTruthV2(rows, map);
    assert.strictEqual(v2.length, 60);
    assert.strictEqual(new Set(v2.map(function (row) { return row.originalCaseId; })).size, 60);
    v2.forEach(function (row, index) {
        assert.strictEqual(row.formationClassV2, rows[index].formationClass);
        assert.strictEqual(row.whyV2, rows[index].why);
        assert.strictEqual(row.reviewProvenance, 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW');
        assert.strictEqual(row.definitionVersion, 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1');
    });
});

test('semantic audit has zero contradictions and is not labeled independent validation', function () {
    var result = phase2.coreConsistency(proposal.cases);
    assert.strictEqual(result.allContradictions.length, 0);
    assert.strictEqual(result.highConfidenceCoreContradictions.length, 0);
});

test('V1 V2 historical comparison partitions all 60 cases', function () {
    var v2 = phase2.buildGroundTruthV2(phase2.normalizeReview(proposal).responses, map);
    var comparison = phase2.compareV1V2(v1, v2);
    assert.strictEqual(comparison.exactAgreement + comparison.adjacentDisagreements + comparison.majorDisagreements, 60);
    assert.ok(comparison.interpretationGuard.includes('not a gold standard'));
});

console.log('\nAccumulation Ground Truth V2 Full Relabel Phase 2 V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
