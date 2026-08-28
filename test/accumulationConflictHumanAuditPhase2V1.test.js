'use strict';

var assert = require('assert');
var phase2 = require('../scripts/accumulationConflictHumanAuditPhase2V1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function input() {
    var reviews = [];
    for (var i = 1; i <= 7; i++) reviews.push({ blindId: 'BLIND-0' + i,
        formationClass: i === 1 ? 'CLEAR_A' : 'BORDERLINE_A', balanceQuality: 'MODERATE',
        centerBehavior: 'STABLE', excursionBehavior: 'REABSORBED', auctionCharacter: 'MIXED',
        observationTags: [], freeText: 'formation-only human observation ' + i });
    return { schemaVersion: 'ACCUMULATION_CONFLICT_HUMAN_AUDIT_V1',
        blindOrderSeed: 'ACCUMULATION_CONFLICT_HUMAN_AUDIT_V1_20260828',
        reviewSource: 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW', reviews: reviews };
}

test('approved seven-case review validates and preserves proposal content', function () {
    var approved = input(), proposal = JSON.parse(JSON.stringify(approved));
    proposal.reviewSource = 'CHATGPT_BLIND_VISUAL_REVIEW_PROPOSAL';
    assert.deepStrictEqual(phase2.validateReview(approved, proposal), []);
    assert.strictEqual(phase2.reviewContentHash(approved), phase2.reviewContentHash(proposal));
});

test('incomplete or wrong-source input blocks unblind', function () {
    var approved = input(); approved.reviewSource = 'UNAPPROVED'; approved.reviews[0].freeText = '';
    var errors = phase2.validateReview(approved, null);
    assert.ok(errors.includes('reviewSource'));
    assert.ok(errors.some(function (x) { return /incomplete/.test(x); }));
});

test('unblind joins only by anonymous id and carries required comparison fields', function () {
    var approved = input(), map = { cases: [] }, profiles = [];
    approved.reviews.forEach(function (row, index) {
        var caseId = 'source' + index;
        map.cases.push({ blindId: row.blindId, originalCaseId: caseId, frozenGroundTruth: 'NO_A',
            prototypeDecision: 'KEEP', conflictType: 'TEST' });
        profiles.push({ caseId: caseId, centerProfile: { centerPath: [0.2, 0.4, 0.3], centerMigrationMagnitude: 0.2 },
            centerPathType: 'REVERSING', reabsorptionProfile: { excursionCount: 2, midReturns: 2,
                oppositeSideReturns: 1, failedReabsorptions: 0 }, REABSORPTION_STATE: 'HEALTHY',
            prototypeDecision: 'KEEP', decisionReason: 'TEST_REASON' });
    });
    var rows = phase2.unblind(approved, map, profiles);
    assert.strictEqual(rows.length, 7);
    assert.strictEqual(rows[0].blindReviewSource, 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW');
    assert.deepStrictEqual(rows[0].centerPath, [0.2, 0.4, 0.3]);
    assert.ok('F7Profile' in rows[0]);
});

test('semantic result is partial evidence and candidate list is capped at three', function () {
    var semantics = phase2.semanticAnalysis([
        { originalCaseId: 'case026', blindId: 'BLIND-01', blindFormationClass: 'NO_A', frozenGroundTruth: 'CLEAR_A', prototypeDecision: 'REJECT_CANDIDATE' },
        { originalCaseId: 'case023', blindId: 'BLIND-02', blindFormationClass: 'BORDERLINE_A', frozenGroundTruth: 'NO_A', prototypeDecision: 'KEEP' }
    ]);
    assert.strictEqual(semantics.criticalSemanticAnswer, 'ONLY_PARTIAL_EVIDENCE');
    assert.strictEqual(semantics.F6F7AreSufficient, false);
    var candidates = phase2.missingCandidates();
    assert.strictEqual(candidates.candidateCount, 3);
    assert.strictEqual(candidates.F8Implemented, false);
    assert.ok(candidates.candidates.every(function (row) { return row.notAFeatureSpec; }));
});

console.log('\nAccumulation Conflict Human Audit Phase 2 V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
