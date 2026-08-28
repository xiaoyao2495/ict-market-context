'use strict';

var assert = require('assert');
var fs = require('fs');
var synthesis = require('../scripts/accumulationGroundTruthV2DefinitionSynthesisV1');

var proposal = JSON.parse(fs.readFileSync('/Users/yaodebao/.codex/attachments/cfa769e9-af59-4b66-b9f4-1b671e70bfae/pasted-text.txt', 'utf8'));
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

test('approved proposal contains exactly 12 complete calibration responses', function () {
    assert.strictEqual(synthesis.validateProposal(proposal), true);
    assert.deepStrictEqual(proposal.responses.map(function (row) { return row.calibrationId; }).sort(), synthesis.EXPECTED_IDS);
});

test('case-level synthesis establishes roles without majority-vote shortcut', function () {
    var evidence = synthesis.buildEvidence(proposal.responses);
    assert.strictEqual(evidence.synthesisMethod, 'CASE_LEVEL_SEMANTIC_SYNTHESIS_NOT_MAJORITY_VOTE');
    assert.strictEqual(evidence.semantics.INDEPENDENT_BALANCE.role, 'REQUIRED_CORE_SEMANTIC');
    assert.strictEqual(evidence.semantics.COHERENT_TWO_SIDED_AUCTION.role, 'REQUIRED_CORE_SEMANTIC');
    assert.strictEqual(evidence.semantics.PREVIOUS_TREND_SEPARATION.role, 'CONTEXTUAL');
    assert.strictEqual(evidence.semantics.ONE_SIDED_RESIDENCE.role, 'STRONG_NEGATIVE_EVIDENCE');
    assert.strictEqual(evidence.semantics.PERSISTENT_VALUE_MIGRATION.role, 'STRONG_NEGATIVE_EVIDENCE');
    assert.strictEqual(evidence.semantics.REABSORPTION.role, 'QUALITY_CONTEXT');
    Object.values(evidence.semantics).forEach(function (semantic) {
        assert.ok(Array.isArray(semantic.supportingCases));
        assert.ok(Array.isArray(semantic.challengingCases));
        assert.ok(Array.isArray(semantic.ambiguousCases));
    });
});

test('CAL-03 CAL-06 CAL-08 remain explicit BORDERLINE boundary cases', function () {
    var evidence = synthesis.buildEvidence(proposal.responses);
    assert.deepStrictEqual(evidence.specialBoundaryCases.map(function (row) { return row.calibrationId; }), ['CAL-03', 'CAL-06', 'CAL-08']);
    evidence.specialBoundaryCases.forEach(function (row) {
        assert.strictEqual(row.class, 'BORDERLINE_A');
        assert.strictEqual(row.independentBalance, 'PARTIAL');
        assert.strictEqual(row.twoSidedAuction, 'PARTIAL');
    });
});

test('definition conflicts distinguish core contradiction from wording ambiguity', function () {
    var conflicts = synthesis.buildConflicts(proposal.responses);
    assert.strictEqual(conflicts.coreSemanticContradictions.length, 0);
    assert.deepStrictEqual(conflicts.definitionBoundaryConflicts.map(function (row) { return row.calibrationId; }), ['CAL-03', 'CAL-06', 'CAL-08']);
});

test('Definition V1 contains required classes, roles, and non-requirements', function () {
    var md = synthesis.definitionMarkdown();
    ['ACCUMULATION_DEFINITION', 'CLEAR_A_DEFINITION', 'BORDERLINE_A_DEFINITION', 'NO_A_DEFINITION',
        'UNSURE_POLICY', 'POSITIVE_EVIDENCE', 'NEGATIVE_EVIDENCE', 'NON_REQUIREMENTS'].forEach(function (token) {
        assert.ok(md.includes(token));
    });
    ['EQH/EQL', 'PERFECT_RECTANGLE', 'SYMMETRIC_TOUCHES', 'FIXED_BAR_COUNT', 'FIXED_DURATION',
        'STABLE_MIDPOINT', 'ZERO_DISPLACEMENT_CANDLES', 'SESSION_BOUNDARY', 'FUTURE_REACTION', 'MSS', 'FVG']
        .forEach(function (token) { assert.ok(md.includes(token + ' REQUIRED = false')); });
    assert.ok(md.includes('READY_FOR_FREEZE — NOT FROZEN'));
});

console.log('\nAccumulation Ground Truth V2 Definition Synthesis V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
