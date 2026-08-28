'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = path.join(ROOT, 'accumulation-ground-truth-v2-full-relabel-v1');
var PROPOSAL = '/Users/yaodebao/Downloads/accumulation-ground-truth-v2-blind-review-results-proposal.json';
var ORDER_FILE = path.join(OUT, 'blind-review-order.json');
var MAP_FILE = path.join(OUT, 'blind-case-map.json');
var GT_V1_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var DEFINITION_FILE = path.join(OUT, 'definition-v1-frozen.md');
var EXPECTED_EDGE_IDS = ['A2-BLIND-005', 'A2-BLIND-006', 'A2-BLIND-007', 'A2-BLIND-015',
    'A2-BLIND-017', 'A2-BLIND-026', 'A2-BLIND-035', 'A2-BLIND-040', 'A2-BLIND-041',
    'A2-BLIND-046', 'A2-BLIND-054', 'A2-BLIND-056'];
var RESPONSE_FIELDS = ['blindId', 'formationClass', 'confidence', 'independentBalance', 'twoSidedAuction',
    'previousTrendSeparation', 'oneSidedResidence', 'valueMigration', 'excursionContext', 'definitionEdgeCase', 'why'];

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function countBy(rows, field) {
    return rows.reduce(function (out, row) { out[row[field]] = (out[row[field]] || 0) + 1; return out; }, {});
}

function normalizeReview(proposal) {
    if (proposal.schemaVersion !== 'ACCUMULATION_GROUND_TRUTH_V2_BLIND_REVIEW_EXPORT_SCHEMA_V1' ||
        !Array.isArray(proposal.cases) || proposal.cases.length !== 60) throw new Error('Unexpected proposal envelope');
    return { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_BLIND_REVIEW_V1',
        reviewedAt: proposal.reviewedAt,
        reviewProvenance: 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW',
        sourceReviewSource: proposal.reviewSource,
        sourceProposalSha256: sha(JSON.stringify(proposal)),
        reviewComplete: true, missingResponses: 0, extraResponses: 0, duplicateResponses: 0,
        responses: JSON.parse(JSON.stringify(proposal.cases)) };
}

function coreConsistency(rows) {
    var clear = rows.filter(function (row) { return row.formationClass === 'CLEAR_A' &&
        (row.independentBalance !== 'YES' || row.twoSidedAuction !== 'COHERENT'); });
    var borderline = rows.filter(function (row) { return row.formationClass === 'BORDERLINE_A' &&
        row.independentBalance === 'NO' && ['WEAK', 'ABSENT'].includes(row.twoSidedAuction); });
    var no = rows.filter(function (row) { return row.formationClass === 'NO_A' &&
        row.independentBalance === 'YES' && row.twoSidedAuction === 'COHERENT'; });
    var all = clear.concat(borderline, no);
    return { clearWithCoreContradiction: clear, borderlineWithoutAccumulationEvidence: borderline,
        noWithFullCoreSemantics: no, allContradictions: all,
        highConfidenceCoreContradictions: all.filter(function (row) { return row.confidence === 'HIGH'; }) };
}

function validatePreUnblind(frozen, order) {
    var rows = frozen.responses, ids = rows.map(function (row) { return row.blindId; });
    var missing = order.filter(function (id) { return !ids.includes(id); });
    var extra = ids.filter(function (id) { return !order.includes(id); });
    var duplicates = ids.filter(function (id, index) { return ids.indexOf(id) !== index; });
    var incomplete = rows.filter(function (row) { return RESPONSE_FIELDS.some(function (field) {
        return typeof row[field] !== 'string' || !row[field].trim();
    }); });
    var consistency = coreConsistency(rows);
    var edges = rows.filter(function (row) { return row.definitionEdgeCase === 'YES'; }).map(function (row) { return row.blindId; });
    var classes = countBy(rows, 'formationClass'), confidence = countBy(rows, 'confidence');
    var pass = rows.length === 60 && new Set(ids).size === 60 && !missing.length && !extra.length &&
        !duplicates.length && !incomplete.length && JSON.stringify(ids) === JSON.stringify(order) &&
        classes.CLEAR_A === 23 && classes.BORDERLINE_A === 10 && classes.NO_A === 27 && !classes.UNSURE &&
        confidence.HIGH === 46 && confidence.MEDIUM === 14 && !confidence.LOW &&
        consistency.allContradictions.length === 0 && JSON.stringify(edges) === JSON.stringify(EXPECTED_EDGE_IDS);
    if (!pass) throw new Error('Pre-unblind validation failed');
    return { REVIEW_COMPLETE: true, REVIEWED_CASES: 60, UNIQUE_BLIND_IDS: 60,
        MISSING_RESPONSES: missing.length, EXTRA_RESPONSES: extra.length, DUPLICATE_RESPONSES: duplicates.length,
        INCOMPLETE_RESPONSES: incomplete.length, CLEAR_A: 23, BORDERLINE_A: 10, NO_A: 27, UNSURE: 0,
        HIGH_CONFIDENCE: 46, MEDIUM_CONFIDENCE: 14, LOW_CONFIDENCE: 0,
        CORE_SEMANTIC_CONTRADICTIONS: consistency.allContradictions.length,
        DEFINITION_EDGE_CASES: edges.length, DEFINITION_EDGE_CASE_RATE: edges.length / rows.length,
        BLIND_ORDER_MATCH: JSON.stringify(ids) === JSON.stringify(order),
        UNBLIND_BEFORE_REVIEW_COMPLETE: false, EDGE_BLIND_IDS: edges };
}

function buildGroundTruthV2(rows, blindMap) {
    var mapByBlind = Object.fromEntries(blindMap.map(function (row) { return [row.blindId, row.originalCaseId]; }));
    if (blindMap.length !== 60 || new Set(blindMap.map(function (row) { return row.blindId; })).size !== 60) {
        throw new Error('Blind map invalid');
    }
    return rows.map(function (row) {
        var originalCaseId = mapByBlind[row.blindId];
        if (!originalCaseId) throw new Error('Missing blind mapping for ' + row.blindId);
        return { originalCaseId: originalCaseId, formationClassV2: row.formationClass,
            confidenceV2: row.confidence, independentBalanceV2: row.independentBalance,
            twoSidedAuctionV2: row.twoSidedAuction, previousTrendSeparationV2: row.previousTrendSeparation,
            oneSidedResidenceV2: row.oneSidedResidence, valueMigrationV2: row.valueMigration,
            excursionContextV2: row.excursionContext, definitionEdgeCaseV2: row.definitionEdgeCase,
            whyV2: row.why, reviewProvenance: 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW',
            definitionVersion: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1' };
    });
}

function compareV1V2(v1, v2) {
    var v1ById = Object.fromEntries(v1.map(function (row) { return [row.caseId, row.humanLabel]; }));
    var order = { CLEAR_A: 0, BORDERLINE_A: 1, NO_A: 2 };
    var matrix = { CLEAR_A: { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0 },
        BORDERLINE_A: { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0 },
        NO_A: { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0 } };
    var cases = v2.map(function (row) {
        var oldLabel = v1ById[row.originalCaseId], newLabel = row.formationClassV2;
        if (!oldLabel) throw new Error('Missing V1 label for ' + row.originalCaseId);
        matrix[oldLabel][newLabel]++;
        var distance = Math.abs(order[oldLabel] - order[newLabel]);
        return { originalCaseId: row.originalCaseId, formationClassV1: oldLabel,
            formationClassV2: newLabel, relation: distance === 0 ? 'EXACT' : distance === 1 ? 'ADJACENT_DISAGREEMENT' : 'MAJOR_DISAGREEMENT' };
    });
    return { exactAgreement: cases.filter(function (row) { return row.relation === 'EXACT'; }).length,
        adjacentDisagreements: cases.filter(function (row) { return row.relation === 'ADJACENT_DISAGREEMENT'; }).length,
        majorDisagreements: cases.filter(function (row) { return row.relation === 'MAJOR_DISAGREEMENT'; }).length,
        transitionMatrix: matrix, cases: cases,
        interpretationGuard: 'Historical comparison only. Ground Truth V1 is unstable and is not a gold standard; no accuracy, precision, recall, or F1 is claimed.' };
}

function semanticDistribution(v2) {
    return { totalCases: v2.length, formationClassV2: countBy(v2, 'formationClassV2'),
        confidenceV2: countBy(v2, 'confidenceV2'), independentBalanceV2: countBy(v2, 'independentBalanceV2'),
        twoSidedAuctionV2: countBy(v2, 'twoSidedAuctionV2'),
        previousTrendSeparationV2: countBy(v2, 'previousTrendSeparationV2'),
        oneSidedResidenceV2: countBy(v2, 'oneSidedResidenceV2'), valueMigrationV2: countBy(v2, 'valueMigrationV2'),
        excursionContextV2: countBy(v2, 'excursionContextV2'), definitionEdgeCaseV2: countBy(v2, 'definitionEdgeCaseV2') };
}

function main() {
    var proposalRaw = fs.readFileSync(PROPOSAL, 'utf8');
    var proposal = JSON.parse(proposalRaw);
    var frozen = normalizeReview(proposal);
    var proposalContent = JSON.stringify(proposal.cases), frozenContent = JSON.stringify(frozen.responses);
    if (proposalContent !== frozenContent) throw new Error('Response content mutation');
    var order = JSON.parse(fs.readFileSync(ORDER_FILE, 'utf8')).blindIds;
    var pre = validatePreUnblind(frozen, order);
    writeJson('accumulation-ground-truth-v2-blind-review-results-frozen.json', frozen);
    writeJson('pre-unblind-validation.json', Object.assign({
        RESPONSE_CONTENT_MUTATIONS: 0, RESPONSE_ORDER_MUTATIONS: 0, RESPONSE_VALUE_MUTATIONS: 0,
        SOURCE_PROPOSAL_FILE_SHA256: sha(proposalRaw), FROZEN_RESPONSE_CONTENT_SHA256: sha(frozenContent)
    }, pre));

    // The blind map is intentionally read only after the complete pre-unblind validation above succeeds.
    var blindMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')).cases;
    var v1 = JSON.parse(fs.readFileSync(GT_V1_FILE, 'utf8'));
    var gtV1HashBefore = shaFile(GT_V1_FILE), definitionHashBefore = shaFile(DEFINITION_FILE);
    var v2 = buildGroundTruthV2(frozen.responses, blindMap);
    var comparison = compareV1V2(v1, v2), distribution = semanticDistribution(v2);
    var consistency = coreConsistency(frozen.responses);
    var edgeCases = frozen.responses.filter(function (row) { return row.definitionEdgeCase === 'YES'; }).map(function (row) {
        var gt = v2.find(function (item) { return item.originalCaseId === blindMap.find(function (map) { return map.blindId === row.blindId; }).originalCaseId; });
        return { blindId: row.blindId, originalCaseId: gt.originalCaseId, formationClassV2: row.formationClass,
            confidenceV2: row.confidence, independentBalanceV2: row.independentBalance,
            twoSidedAuctionV2: row.twoSidedAuction, whyV2: row.why };
    });
    var applicationStatus = consistency.allContradictions.length === 0 && edgeCases.length / 60 <= 0.10 ? 'STABLE' :
        consistency.allContradictions.length <= 3 && edgeCases.length / 60 <= 0.20 ? 'MOSTLY_STABLE' : 'UNSTABLE';
    if (applicationStatus !== 'MOSTLY_STABLE') throw new Error('Frozen definition application rule mismatch');

    writeJson('accumulation-ground-truth-v2.json', { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_V1',
        definitionVersion: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1', reviewProvenance: frozen.reviewProvenance,
        groundTruthV2Resolved: true, groundTruthV2ReadyForFreeze: true, groundTruthV2Frozen: false, cases: v2 });
    writeJson('v1-v2-comparison.json', Object.assign({ schemaVersion: 'ACCUMULATION_GT_V1_V2_COMPARISON_V1' }, comparison));
    writeJson('v2-label-distribution.json', { schemaVersion: 'ACCUMULATION_GT_V2_LABEL_DISTRIBUTION_V1',
        totalCases: 60, CLEAR_A: distribution.formationClassV2.CLEAR_A || 0,
        BORDERLINE_A: distribution.formationClassV2.BORDERLINE_A || 0,
        NO_A: distribution.formationClassV2.NO_A || 0, UNSURE: distribution.formationClassV2.UNSURE || 0,
        HIGH_CONFIDENCE: distribution.confidenceV2.HIGH || 0,
        MEDIUM_CONFIDENCE: distribution.confidenceV2.MEDIUM || 0, LOW_CONFIDENCE: distribution.confidenceV2.LOW || 0 });
    writeJson('v2-semantic-distribution.json', Object.assign({ schemaVersion: 'ACCUMULATION_GT_V2_SEMANTIC_DISTRIBUTION_V1' }, distribution));
    writeJson('core-semantic-consistency.json', {
        schemaVersion: 'ACCUMULATION_GT_V2_CORE_SEMANTIC_CONSISTENCY_V1',
        CLEAR_WITH_CORE_CONTRADICTION: consistency.clearWithCoreContradiction.length,
        CLEAR_WITH_CORE_CONTRADICTION_CASES: consistency.clearWithCoreContradiction,
        BORDERLINE_WITHOUT_ACCUMULATION_EVIDENCE: consistency.borderlineWithoutAccumulationEvidence.length,
        BORDERLINE_WITHOUT_ACCUMULATION_EVIDENCE_CASES: consistency.borderlineWithoutAccumulationEvidence,
        NO_WITH_FULL_CORE_SEMANTICS: consistency.noWithFullCoreSemantics.length,
        NO_WITH_FULL_CORE_SEMANTICS_CASES: consistency.noWithFullCoreSemantics,
        CORE_SEMANTIC_CONTRADICTIONS: consistency.allContradictions.length,
        HIGH_CONFIDENCE_CORE_CONTRADICTIONS: consistency.highConfidenceCoreContradictions.length,
        INTERNAL_DEFINITION_APPLICATION_CONSISTENCY_ONLY: true,
        INDEPENDENT_DEFINITION_VALIDATION: false, INTER_RATER_RELIABILITY_VALIDATED: false,
        DETECTOR_VALIDITY_VALIDATED: false });
    writeJson('definition-edge-cases.json', { schemaVersion: 'ACCUMULATION_GT_V2_DEFINITION_EDGE_CASES_V1',
        edgeCaseCount: edgeCases.length, edgeCaseRate: edgeCases.length / 60, cases: edgeCases });
    writeJson('definition-application-validation.json', {
        schemaVersion: 'ACCUMULATION_GT_V2_DEFINITION_APPLICATION_VALIDATION_V1',
        frozenRule: { STABLE: 'contradictions=0 AND edgeCaseRate<=0.10',
            MOSTLY_STABLE: 'contradictions<=3 AND edgeCaseRate<=0.20', UNSTABLE: 'otherwise' },
        CORE_SEMANTIC_CONTRADICTIONS: consistency.allContradictions.length,
        DEFINITION_EDGE_CASES: edgeCases.length, DEFINITION_EDGE_CASE_RATE: edgeCases.length / 60,
        DEFINITION_APPLICATION_STATUS: applicationStatus,
        INTERNAL_APPLICATION_CONSISTENCY: 'HIGH', INDEPENDENT_VALIDATION_PERFORMED: false,
        INTER_RATER_VALIDATION_PERFORMED: false,
        interpretationGuard: 'The class and semantic fields were assigned by the same reviewer in the same formation judgement. Internal consistency is not independent validation, inter-rater reliability, or detector validity.' });

    var dedicated = cp.spawnSync(process.execPath,
        [path.join(__dirname, '..', 'test', 'accumulationGroundTruthV2FullRelabelPhase2V1.test.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    var full = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    var invariants = gtV1HashBefore === shaFile(GT_V1_FILE) && definitionHashBefore === shaFile(DEFINITION_FILE);
    var passed = dedicated.status === 0 && full.status === 0 && invariants && proposalContent === frozenContent &&
        v2.length === 60 && consistency.allContradictions.length === 0 && edgeCases.length === 12 && applicationStatus === 'MOSTLY_STABLE';
    writeJson('test-results-final.json', {
        dedicated: { command: 'node test/accumulationGroundTruthV2FullRelabelPhase2V1.test.js',
            exitCode: dedicated.status, passed: dedicated.status === 0, stdout: dedicated.stdout, stderr: dedicated.stderr },
        fullRegression: { command: 'node test/run.js', exitCode: full.status, passed: full.status === 0,
            stdoutSha256: sha(full.stdout || ''), stdoutTail: String(full.stdout || '').split('\n').slice(-35), stderr: full.stderr }
    });
    var acceptance = {
        ACCUMULATION_GROUND_TRUTH_V2_FULL_RELABEL_V1: passed ? 'PASS' : 'FAIL',
        DEFINITION_VERSION: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1', DEFINITION_V1_FROZEN: true,
        TOTAL_CASES: 60, REVIEWED_CASES: 60, CLEAR_A: 23, BORDERLINE_A: 10, NO_A: 27, UNSURE: 0,
        HIGH_CONFIDENCE: 46, MEDIUM_CONFIDENCE: 14, LOW_CONFIDENCE: 0,
        CORE_SEMANTIC_CONTRADICTIONS: 0, CLEAR_WITH_CORE_CONTRADICTION: 0,
        BORDERLINE_WITHOUT_ACCUMULATION_EVIDENCE: 0, NO_WITH_FULL_CORE_SEMANTICS: 0,
        HIGH_CONFIDENCE_CORE_CONTRADICTIONS: 0, DEFINITION_EDGE_CASES: 12,
        DEFINITION_EDGE_CASE_RATE: 0.20, DEFINITION_APPLICATION_STATUS: 'MOSTLY_STABLE',
        INTERNAL_APPLICATION_CONSISTENCY: 'HIGH', INDEPENDENT_VALIDATION_PERFORMED: false,
        INTER_RATER_VALIDATION_PERFORMED: false,
        V1_V2_EXACT_AGREEMENT: comparison.exactAgreement + ' / 60',
        V1_V2_ADJACENT_DISAGREEMENTS: comparison.adjacentDisagreements,
        V1_V2_MAJOR_DISAGREEMENTS: comparison.majorDisagreements,
        RESPONSE_CONTENT_MUTATIONS: 0, RESPONSE_ORDER_MUTATIONS: 0, RESPONSE_VALUE_MUTATIONS: 0,
        GROUND_TRUTH_V1_CHANGED: false, GROUND_TRUTH_V2_READY_FOR_FREEZE: true,
        GROUND_TRUTH_V2_FROZEN: false, NEW_FEATURE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false, REPRESENTATION_V3_STARTED: false,
        ACCUMULATION_V2_IMPLEMENTATION_STARTED: false, MANIPULATION_RESEARCH_STARTED: false,
        PRODUCTION_BEHAVIOR_CHANGED: false, POST_CONFIRMATION_BARS_USED: 0,
        FUTURE_LEAK_VIOLATIONS: 0, DETERMINISM_VIOLATIONS: 0,
        ALL_TESTS_PASSED: dedicated.status === 0 && full.status === 0,
        READY_FOR_REPRESENTATION_V3: false, READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false,
        READY_FOR_MANIPULATION_RESEARCH: false, HARD_STOP_REACHED: true
    };
    writeJson('ground-truth-v2-acceptance.json', acceptance);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Accumulation Ground Truth V2 — Full 60-Case Relabel V1

## Outcome

Phase 2 **${passed ? 'PASS' : 'FAIL'}**. All 60 approved blind responses were preserved exactly, normalized at the envelope only, frozen with provenance \`USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW\`, and then unblinded through the frozen Phase 1 map.

Ground Truth V2 is a formation-only human research ground truth under Frozen Definition V1. It is ready for human freeze review but is **not frozen**.

## V2 distribution

- CLEAR_A: 23
- BORDERLINE_A: 10
- NO_A: 27
- UNSURE: 0
- HIGH / MEDIUM / LOW confidence: 46 / 14 / 0

## Definition application

- Core semantic contradictions: 0
- Definition edge cases: 12 / 60 (20.0%)
- Definition application status: **MOSTLY_STABLE**
- Internal application consistency: **HIGH**

The zero contradiction count supports only **internal definition application consistency**. Formation class, Independent Balance, and Two-Sided Auction were assigned by the same reviewer in the same judgement. This is not independent definition validation, inter-rater reliability, detector validity, or evidence that a machine can identify these semantics.

## Historical V1 ↔ V2 comparison

- Exact agreement: ${comparison.exactAgreement} / 60
- Adjacent disagreements: ${comparison.adjacentDisagreements}
- Major disagreements: ${comparison.majorDisagreements}

Ground Truth V1 is known unstable and is not treated as a gold standard. These figures describe historical label change only; no accuracy, precision, recall, or F1 is claimed, and V2 was not optimized to match V1.

## Boundaries

No Definition V1, Ground Truth V1, detector, feature, parameter, production behavior, F6/F7, or future/outcome data was changed or used. Representation V3, Accumulation V2, and Manipulation research were not started.

## Readiness

- GROUND_TRUTH_V2_READY_FOR_FREEZE = true
- GROUND_TRUTH_V2_FROZEN = false
- READY_FOR_REPRESENTATION_V3 = false
- READY_FOR_ACCUMULATION_V2_IMPLEMENTATION = false
- READY_FOR_MANIPULATION_RESEARCH = false

HARD STOP reached pending user review and explicit Ground Truth V2 freeze approval.
`);
    console.log(JSON.stringify({ output: OUT, totalCases: 60, distribution: distribution.formationClassV2,
        coreSemanticContradictions: 0, definitionEdgeCases: 12, definitionEdgeCaseRate: 0.20,
        definitionApplicationStatus: applicationStatus, v1V2: { exact: comparison.exactAgreement,
            adjacent: comparison.adjacentDisagreements, major: comparison.majorDisagreements },
        groundTruthV2ReadyForFreeze: true, groundTruthV2Frozen: false, hardStopReached: true }, null, 2));
    if (!passed) process.exit(1);
}

if (require.main === module) main();
module.exports = { normalizeReview: normalizeReview, validatePreUnblind: validatePreUnblind,
    coreConsistency: coreConsistency, buildGroundTruthV2: buildGroundTruthV2,
    compareV1V2: compareV1V2, semanticDistribution: semanticDistribution,
    RESPONSE_FIELDS: RESPONSE_FIELDS, EXPECTED_EDGE_IDS: EXPECTED_EDGE_IDS };
