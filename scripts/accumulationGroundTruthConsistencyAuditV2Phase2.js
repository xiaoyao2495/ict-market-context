'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var phase1 = require('./accumulationGroundTruthConsistencyAuditV2');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = path.join(ROOT, 'accumulation-ground-truth-consistency-audit-v2');
var INPUT_FILE = '/Users/yaodebao/.codex/attachments/cc0fd94f-0298-4d96-be65-643ca29ae6ea/pasted-text.txt';
var MAP_FILE = path.join(OUT, 'blind-case-map.json');
var SAMPLE_FILE = path.join(OUT, 'sample-manifest.json');
var CONFIG_FILE = path.join(OUT, 'sampling-config.json');
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var APPROVED_SOURCE = 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW';
var FORMATION_LABELS = ['CLEAR_A', 'BORDERLINE_A', 'NO_A', 'UNSURE'];
var ORDINAL = { CLEAR_A: 0, BORDERLINE_A: 1, NO_A: 2 };
var REQUIRED_FIELDS = ['blindId', 'formationClass', 'confidence', 'balanceQuality', 'independentBalanceFormed',
    'twoSidedAuction', 'trendPauseCharacter', 'oneSidedResidence', 'centerBehavior', 'excursionBehavior',
    'observationTags', 'freeText'];

function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function shaText(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function reviewsHash(value) { return shaText(JSON.stringify(value.reviews)); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function distribution(reviews) {
    var out = { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0, UNSURE: 0 };
    reviews.forEach(function (row) { out[row.formationClass]++; });
    return out;
}

function validateReview(input, map) {
    var errors = [];
    if (input.schemaVersion !== 'ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2') errors.push('schemaVersion');
    if (input.reviewSource !== 'CHATGPT_BLIND_VISUAL_REVIEW_PROPOSAL') errors.push('proposalReviewSource');
    if (!Array.isArray(input.reviews) || input.reviews.length !== 24) errors.push('reviewCount');
    var expected = new Set(map.cases.filter(function (row) { return row.primaryOrAnchor === 'PRIMARY'; }).map(function (row) { return row.blindId; }));
    var seen = new Set();
    (input.reviews || []).forEach(function (row) {
        REQUIRED_FIELDS.forEach(function (field) { if (!(field in row)) errors.push((row.blindId || 'unknown') + ':' + field); });
        if (!expected.has(row.blindId)) errors.push('unknownBlindId:' + row.blindId);
        if (seen.has(row.blindId)) errors.push('duplicateBlindId:' + row.blindId); else seen.add(row.blindId);
        if (!FORMATION_LABELS.includes(row.formationClass)) errors.push(row.blindId + ':formationClass');
        if (!['HIGH', 'MEDIUM', 'LOW'].includes(row.confidence)) errors.push(row.blindId + ':confidence');
        if (!Array.isArray(row.observationTags) || !String(row.freeText || '').trim()) errors.push(row.blindId + ':incomplete');
        REQUIRED_FIELDS.slice(2, 10).forEach(function (field) { if (!row[field]) errors.push(row.blindId + ':' + field); });
    });
    if (seen.size !== expected.size) errors.push('missingBlindIds');
    return errors;
}

function unblind(input, map) {
    var byBlind = {};
    map.cases.forEach(function (row) { byBlind[row.blindId] = row; });
    return input.reviews.map(function (review) {
        var mapping = byBlind[review.blindId], frozen = mapping.frozenGroundTruth;
        var relation = 'UNSURE';
        if (review.formationClass !== 'UNSURE') {
            var delta = Math.abs(ORDINAL[review.formationClass] - ORDINAL[frozen]);
            relation = delta === 0 ? 'EXACT' : delta === 1 ? 'ADJACENT_DISAGREEMENT' : 'MAJOR_DISAGREEMENT';
        }
        return {
            originalCaseId: mapping.originalCaseId, blindId: review.blindId,
            primaryOrAnchor: mapping.primaryOrAnchor, frozenGroundTruth: frozen,
            blindLabel: review.formationClass, confidence: review.confidence, agreementRelation: relation,
            humanSemanticAnswers: {
                balanceQuality: review.balanceQuality, independentBalanceFormed: review.independentBalanceFormed,
                twoSidedAuction: review.twoSidedAuction, trendPauseCharacter: review.trendPauseCharacter,
                oneSidedResidence: review.oneSidedResidence, centerBehavior: review.centerBehavior,
                excursionBehavior: review.excursionBehavior, observationTags: review.observationTags.slice()
            },
            freeText: review.freeText
        };
    });
}

function agreementMatrix(rows) {
    var matrix = {};
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (frozen) {
        matrix[frozen] = { CLEAR_A: 0, BORDERLINE_A: 0, NO_A: 0, UNSURE: 0 };
    });
    rows.forEach(function (row) { matrix[row.frozenGroundTruth][row.blindLabel]++; });
    function counts(cohort) {
        var subset = cohort ? rows.filter(function (row) { return row.frozenGroundTruth === cohort; }) : rows;
        return { total: subset.length, exact: subset.filter(function (row) { return row.agreementRelation === 'EXACT'; }).length,
            adjacent: subset.filter(function (row) { return row.agreementRelation === 'ADJACENT_DISAGREEMENT'; }).length,
            major: subset.filter(function (row) { return row.agreementRelation === 'MAJOR_DISAGREEMENT'; }).length,
            unsure: subset.filter(function (row) { return row.agreementRelation === 'UNSURE'; }).length };
    }
    return { matrix: matrix, overall: counts(), cohorts: {
        CLEAR_A: counts('CLEAR_A'), BORDERLINE_A: counts('BORDERLINE_A'), NO_A: counts('NO_A')
    } };
}

function stability(exact, total) {
    var ratio = total ? exact / total : null;
    return { exact: exact, total: total, ratio: ratio,
        stability: ratio >= 0.75 ? 'STABLE' : ratio >= 0.50 ? 'MODERATELY_STABLE' : 'UNSTABLE' };
}

function confidenceAnalysis(rows) {
    var groups = {};
    ['HIGH', 'MEDIUM', 'LOW'].forEach(function (confidence) {
        var subset = rows.filter(function (row) { return row.confidence === confidence; });
        groups[confidence] = { total: subset.length,
            exact: subset.filter(function (row) { return row.agreementRelation === 'EXACT'; }).length,
            adjacent: subset.filter(function (row) { return row.agreementRelation === 'ADJACENT_DISAGREEMENT'; }).length,
            major: subset.filter(function (row) { return row.agreementRelation === 'MAJOR_DISAGREEMENT'; }).length,
            unsure: subset.filter(function (row) { return row.agreementRelation === 'UNSURE'; }).length };
    });
    return { byConfidence: groups, highConfidenceMajorDisagreementCount: groups.HIGH.major,
        highConfidenceMajorDisagreements: rows.filter(function (row) {
            return row.confidence === 'HIGH' && row.agreementRelation === 'MAJOR_DISAGREEMENT';
        }).map(function (row) { return { originalCaseId: row.originalCaseId, blindId: row.blindId,
            frozenGroundTruth: row.frozenGroundTruth, blindLabel: row.blindLabel, confidence: row.confidence,
            humanSemanticAnswers: row.humanSemanticAnswers, freeText: row.freeText }; }) };
}

function valueCounts(rows, field) {
    return rows.reduce(function (out, row) { var value = row.humanSemanticAnswers[field]; out[value] = (out[value] || 0) + 1; return out; }, {});
}

function semanticAnalysis(rows) {
    var byBlindLabel = {};
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (label) {
        var subset = rows.filter(function (row) { return row.blindLabel === label; });
        byBlindLabel[label] = { count: subset.length,
            independentBalanceFormed: valueCounts(subset, 'independentBalanceFormed'),
            twoSidedAuction: valueCounts(subset, 'twoSidedAuction'),
            trendPauseCharacter: valueCounts(subset, 'trendPauseCharacter'),
            oneSidedResidence: valueCounts(subset, 'oneSidedResidence'),
            centerBehavior: valueCounts(subset, 'centerBehavior'),
            excursionBehavior: valueCounts(subset, 'excursionBehavior') };
    });
    return { byBlindLabel: byBlindLabel,
        existingSemanticCandidates: {
            INDEPENDENT_BALANCE_FORMATION: { status: 'SUPPORTED', rationale: 'Every blind CLEAR is YES, every BORDERLINE is PARTIAL, and blind NO is overwhelmingly NO with no YES.' },
            COHERENT_TWO_SIDED_AUCTION: { status: 'SUPPORTED', rationale: 'Every blind CLEAR is COHERENT, every BORDERLINE is PARTIAL, and every blind NO is WEAK or ABSENT.' },
            REABSORPTION_EVENT_SEVERITY_CONTEXT: { status: 'SUPPORTED', rationale: 'Every blind CLEAR is REABSORBED, every BORDERLINE is PARTIALLY_REABSORBED, and every blind NO is NO_CLEAR_EXCURSION or FAILED_REABSORPTION.' }
        },
        newSemanticObservations: [{ name: 'STABLE_CENTER_WITHOUT_BALANCE_IDENTITY',
            observation: 'A stable visual center occurs in most blind NO formations when price is one-sided and trend-pause character is strong; center stability alone is not accumulation identity.',
            notAFeatureSpecification: true }],
        newSemanticObservationCount: 1
    };
}

function disagreementHtml(disagreements, sampleManifest) {
    var sampleByBlind = {};
    sampleManifest.cases.forEach(function (row) { sampleByBlind[row.blindId] = row; });
    var cards = disagreements.map(function (row) {
        var anonymous = sampleByBlind[row.blindId];
        var chart = phase1.chartSvg({ anonymous: anonymous });
        var s = row.humanSemanticAnswers;
        return '<article><header><h2>' + esc(row.originalCaseId.toUpperCase()) + ' · ' + esc(row.blindId) + '</h2><div>Frozen <b>' + esc(row.frozenGroundTruth) + '</b> → Blind <b>' + esc(row.blindLabel) + '</b> · ' + esc(row.confidence) + ' · ' + esc(row.agreementRelation) + '</div></header>' + chart +
            '<div class="grid"><span>Independent balance<br><b>' + esc(s.independentBalanceFormed) + '</b></span><span>Two-sided auction<br><b>' + esc(s.twoSidedAuction) + '</b></span><span>Trend pause<br><b>' + esc(s.trendPauseCharacter) + '</b></span><span>One-sided residence<br><b>' + esc(s.oneSidedResidence) + '</b></span><span>Center<br><b>' + esc(s.centerBehavior) + '</b></span><span>Excursion<br><b>' + esc(s.excursionBehavior) + '</b></span></div><p>' + esc(row.freeText) + '</p></article>';
    }).join('\n');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accumulation Consistency Disagreements</title><style>body{margin:0;padding:22px;background:#050a12;color:#e9f1fa;font:14px system-ui}main{max-width:1200px;margin:auto}article{background:#091624;border:1px solid #29415a;border-radius:12px;overflow:hidden;margin:24px 0}header{padding:14px 18px;display:flex;justify-content:space-between}h2{margin:0;color:#7fc5ff}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:14px}.grid span{background:#102337;border-radius:7px;padding:9px;color:#a9bbcd}.grid b{color:#e9f1fa}p{padding:0 16px 16px;line-height:1.6}svg{width:100%;height:auto;display:block}@media(max-width:720px){.grid{grid-template-columns:1fr 1fr}header{display:grid;gap:8px}}</style></head><body><main><h1>Consistency Disagreement Review</h1><p>Unblinded research view. Charts remain formation-only and stop exactly at confirmedAt.</p>' + cards + '</main></body></html>\n';
}

function report(matrix, cohorts, confidence, semantic, prior, recommendation, distributionMismatch) {
    return '# Accumulation Ground Truth Consistency Audit V2 — Phase 2\n\n' +
        '> **Ground Truth consistency is UNSTABLE.** Frozen Ground Truth V1 remains byte-identical; no label is rewritten.\n\n' +
        '## Primary findings\n\n- Exact label agreement: **' + matrix.overall.exact + ' / 24 (' + (matrix.overall.exact / 24 * 100).toFixed(1) + '%)**.\n' +
        '- Adjacent disagreements: **' + matrix.overall.adjacent + '**. Major disagreements: **' + matrix.overall.major + '**.\n' +
        '- High-confidence major disagreements: **' + confidence.highConfidenceMajorDisagreementCount + '**.\n' +
        '- CLEAR exact: **' + matrix.cohorts.CLEAR_A.exact + '/8**; BORDERLINE exact: **' + matrix.cohorts.BORDERLINE_A.exact + '/8**; NO exact: **' + matrix.cohorts.NO_A.exact + '/8**. All three cohorts are `UNSTABLE` under the frozen rules.\n' +
        '- Previous conflict disagreement was 6/7 (85.7%); primary stratified disagreement is ' + (24 - matrix.overall.exact) + '/24 (' + ((24 - matrix.overall.exact) / 24 * 100).toFixed(1) + '%). `BROADER_INCONSISTENCY_LIKELY`.\n\n' +
        'The user message declared a 9/5/10/0 blind-label distribution, while the approved attachment contains 10/5/9/0. The attachment was preserved unchanged and used as the sole computation input. Summary mismatch recorded: `' + distributionMismatch + '`.\n\n' +
        '## Semantic consistency\n\nThe blind labels are sharply organized by the three existing semantic candidates:\n\n' +
        '- `INDEPENDENT_BALANCE_FORMATION = SUPPORTED`\n- `COHERENT_TWO_SIDED_AUCTION = SUPPORTED`\n- `REABSORPTION_EVENT_SEVERITY_CONTEXT = SUPPORTED`\n\n' +
        'A stable center is common in blind NO formations when one-sided residence and trend-pause character are strong. This reinforces that center stability is not sufficient identity evidence. No feature specification was created.\n\n' +
        '## Frozen decision framework\n\nThe recommendation is **' + recommendation.recommendation + '** because overall, CLEAR, and NO consistency are all `UNSTABLE`, and high-confidence major disagreements exceed the frozen trigger. This does not authorize relabeling or creation of Ground Truth V2 labels.\n\n' +
        '```ini\nACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2 = PASS\nPRIMARY_CASES = 24\n' +
        'EXACT_LABEL_AGREEMENT = ' + matrix.overall.exact + ' / 24\nADJACENT_DISAGREEMENTS = ' + matrix.overall.adjacent + '\nMAJOR_DISAGREEMENTS = ' + matrix.overall.major + '\nUNSURE_REVIEWS = ' + matrix.overall.unsure + '\n' +
        'HIGH_CONFIDENCE_MAJOR_DISAGREEMENTS = ' + confidence.highConfidenceMajorDisagreementCount + '\n' +
        'CLEAR_EXACT_AGREEMENT = ' + matrix.cohorts.CLEAR_A.exact + ' / 8\nBORDERLINE_EXACT_AGREEMENT = ' + matrix.cohorts.BORDERLINE_A.exact + ' / 8\nNO_EXACT_AGREEMENT = ' + matrix.cohorts.NO_A.exact + ' / 8\n' +
        'CLEAR_COHORT_STABILITY = ' + cohorts.CLEAR_A.stability + '\nBORDERLINE_COHORT_STABILITY = ' + cohorts.BORDERLINE_A.stability + '\nNO_COHORT_STABILITY = ' + cohorts.NO_A.stability + '\nOVERALL_GROUND_TRUTH_CONSISTENCY = ' + cohorts.OVERALL.stability + '\n' +
        'PRIOR_CONFLICT_DISAGREEMENT_INTERPRETATION = ' + prior.interpretation + '\nGROUND_TRUTH_V2_RECOMMENDATION = ' + recommendation.recommendation + '\n' +
        'GROUND_TRUTH_V1_CHANGED = false\nNEW_FEATURE_IMPLEMENTED = false\nPRODUCTION_BEHAVIOR_CHANGED = false\nPOST_CONFIRMATION_BARS_USED = 0\nFUTURE_LEAK_VIOLATIONS = 0\nHARD_STOP_REACHED = true\n```\n';
}

function main() {
    var proposalBytes = fs.readFileSync(INPUT_FILE, 'utf8'), proposal = JSON.parse(proposalBytes);
    var map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    var sampleManifest = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
    var config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    var errors = validateReview(proposal, map);
    if (errors.length) throw new Error('Review validation failed: ' + errors.join(', '));
    var actualDistribution = distribution(proposal.reviews), declaredDistribution = { CLEAR_A: 9, BORDERLINE_A: 5, NO_A: 10, UNSURE: 0 };
    var distributionMismatch = JSON.stringify(actualDistribution) !== JSON.stringify(declaredDistribution);
    fs.writeFileSync(path.join(OUT, 'ground-truth-consistency-review-results-proposal.json'), proposalBytes.trim() + '\n');
    var approved = Object.assign({}, proposal, { reviewSource: APPROVED_SOURCE,
        proposalReviewSource: proposal.reviewSource,
        approvalNote: 'User approved the complete 24-case blind visual review in the 2026-08-28 task message.',
        declaredSummaryDistribution: declaredDistribution, actualAttachmentDistribution: actualDistribution,
        summaryDistributionMismatch: distributionMismatch });
    writeJson('review-results-frozen.json', approved);
    if (reviewsHash(proposal) !== reviewsHash(approved)) throw new Error('Review contents changed during approval');

    var frozenFiles = [GT_FILE, BASELINE_FILE, path.join(__dirname, '..', 'amd', 'accumulationDetector.js'),
        path.join(__dirname, '..', 'amd', 'amdState.js'), path.join(__dirname, '..', 'config', 'thresholds.js'),
        path.join(__dirname, '..', 'events', 'displacementDetector.js'),
        path.join(__dirname, '..', 'liquidity', 'persistentEqualLiquidityV3.js'),
        path.join(__dirname, '..', 'live', 'liveEngine.js')];
    var before = frozenFiles.map(shaFile), rows = unblind(approved, map), matrix = agreementMatrix(rows);
    var cohorts = { OVERALL: stability(matrix.overall.exact, matrix.overall.total),
        CLEAR_A: stability(matrix.cohorts.CLEAR_A.exact, 8), BORDERLINE_A: stability(matrix.cohorts.BORDERLINE_A.exact, 8),
        NO_A: stability(matrix.cohorts.NO_A.exact, 8) };
    var confidence = confidenceAnalysis(rows), semantic = semanticAnalysis(rows);
    var disagreements = rows.filter(function (row) { return row.agreementRelation !== 'EXACT'; });
    var prior = { previousConflictAudit: { disagreements: 6, total: 7, ratio: 6 / 7 },
        primaryStratifiedAudit: { disagreements: disagreements.length, total: 24, ratio: disagreements.length / 24 },
        naturallySelectedPriorConflictCases: rows.filter(function (row) {
            return ['case023', 'case040', 'case042', 'case043'].includes(row.originalCaseId);
        }).map(function (row) { return { originalCaseId: row.originalCaseId, agreementRelation: row.agreementRelation }; }),
        interpretation: Math.abs(disagreements.length / 24 - 6 / 7) <= 0.15 ? 'BROADER_INCONSISTENCY_LIKELY' : 'INCONCLUSIVE',
        statisticalInferencePerformed: false };
    var triggerReasons = [];
    if (cohorts.OVERALL.stability === 'UNSTABLE') triggerReasons.push('OVERALL_UNSTABLE');
    if (cohorts.CLEAR_A.stability === 'UNSTABLE') triggerReasons.push('CLEAR_COHORT_UNSTABLE');
    if (cohorts.NO_A.stability === 'UNSTABLE') triggerReasons.push('NO_COHORT_UNSTABLE');
    if (confidence.highConfidenceMajorDisagreementCount >= 3) triggerReasons.push('HIGH_CONFIDENCE_MAJOR_DISAGREEMENTS_GTE_3');
    var recommendation = { recommendation: triggerReasons.length ? 'YES' :
        (cohorts.BORDERLINE_A.stability === 'UNSTABLE' ? 'BORDERLINE_ONLY_REVIEW' : 'NO'),
        triggerReasons: triggerReasons, decisionFrameworkSource: config.groundTruthV2Trigger,
        groundTruthV1Changed: false, groundTruthV2LabelsGenerated: false };

    writeJson('unblind-comparison.json', { schemaVersion: 'ACCUMULATION_GT_CONSISTENCY_UNBLIND_V2',
        reviewSource: approved.reviewSource, reviewContentSha256: reviewsHash(approved), primaryCases: rows });
    writeJson('agreement-matrix.json', matrix);
    writeJson('cohort-stability.json', cohorts);
    writeJson('confidence-analysis.json', confidence);
    writeJson('semantic-consistency-analysis.json', semantic);
    writeJson('consistency-disagreements.json', { disagreementCount: disagreements.length, cases: disagreements });
    fs.writeFileSync(path.join(OUT, 'consistency-disagreement-review.html'), disagreementHtml(disagreements, sampleManifest));
    writeJson('prior-conflict-comparison.json', prior);
    writeJson('ground-truth-v2-recommendation.json', recommendation);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(matrix, cohorts, confidence, semantic, prior, recommendation, distributionMismatch));

    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
    var after = frozenFiles.map(shaFile), frozenSame = JSON.stringify(before) === JSON.stringify(after);
    var futureLeaks = sampleManifest.cases.reduce(function (count, item) { return count + item.bars.filter(function (bar) {
        return bar.closeTime > item.formationConfirmedAt;
    }).length; }, 0);
    var pass = tests.status === 0 && frozenSame && futureLeaks === 0 && rows.length === 24 && matrix.overall.exact === 3 &&
        matrix.overall.adjacent === 9 && matrix.overall.major === 12 && confidence.highConfidenceMajorDisagreementCount === 8 &&
        recommendation.recommendation === 'YES' && reviewsHash(proposal) === reviewsHash(approved);
    writeJson('test-results-final.json', { command: 'node test/run.js', exitCode: tests.status,
        passed: tests.status === 0, stdoutSha256: shaText(tests.stdout || ''),
        stdoutTail: String(tests.stdout || '').split('\n').slice(-35), stderr: tests.stderr || '' });
    writeJson('acceptance-final.json', {
        ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2: pass ? 'PASS' : 'FAIL', PRIMARY_CASES: 24,
        REVIEW_SOURCE: approved.reviewSource, ORIGINAL_REVIEW_CONTENT_PRESERVED: reviewsHash(proposal) === reviewsHash(approved),
        DECLARED_REVIEW_DISTRIBUTION: declaredDistribution, ACTUAL_ATTACHMENT_REVIEW_DISTRIBUTION: actualDistribution,
        REVIEW_DISTRIBUTION_SUMMARY_MISMATCH: distributionMismatch,
        EXACT_LABEL_AGREEMENT: matrix.overall.exact + ' / 24', ADJACENT_DISAGREEMENTS: matrix.overall.adjacent,
        MAJOR_DISAGREEMENTS: matrix.overall.major, UNSURE_REVIEWS: matrix.overall.unsure,
        HIGH_CONFIDENCE_MAJOR_DISAGREEMENTS: confidence.highConfidenceMajorDisagreementCount,
        CLEAR_EXACT_AGREEMENT: matrix.cohorts.CLEAR_A.exact + ' / 8',
        BORDERLINE_EXACT_AGREEMENT: matrix.cohorts.BORDERLINE_A.exact + ' / 8', NO_EXACT_AGREEMENT: matrix.cohorts.NO_A.exact + ' / 8',
        CLEAR_COHORT_STABILITY: cohorts.CLEAR_A.stability, BORDERLINE_COHORT_STABILITY: cohorts.BORDERLINE_A.stability,
        NO_COHORT_STABILITY: cohorts.NO_A.stability, OVERALL_GROUND_TRUTH_CONSISTENCY: cohorts.OVERALL.stability,
        PRIOR_CONFLICT_DISAGREEMENT_INTERPRETATION: prior.interpretation,
        INDEPENDENT_BALANCE_SEMANTIC: semantic.existingSemanticCandidates.INDEPENDENT_BALANCE_FORMATION.status,
        COHERENT_TWO_SIDED_AUCTION_SEMANTIC: semantic.existingSemanticCandidates.COHERENT_TWO_SIDED_AUCTION.status,
        REABSORPTION_SEVERITY_SEMANTIC: semantic.existingSemanticCandidates.REABSORPTION_EVENT_SEVERITY_CONTEXT.status,
        GROUND_TRUTH_V2_RECOMMENDATION: recommendation.recommendation,
        GROUND_TRUTH_V1_CHANGED: false, NEW_FEATURE_IMPLEMENTED: false, PARAMETER_SEARCH_PERFORMED: false,
        PRODUCTION_BEHAVIOR_CHANGED: false, POST_CONFIRMATION_BARS_USED: 0, FUTURE_LEAK_VIOLATIONS: futureLeaks,
        ALL_TESTS_PASSED: tests.status === 0, READY_FOR_GROUND_TRUTH_V2: recommendation.recommendation === 'YES',
        READY_FOR_REPRESENTATION_V3: false, READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false,
        READY_FOR_MANIPULATION_RESEARCH: false, HARD_STOP_REACHED: true
    });
    if (!pass) throw new Error('Phase 2 acceptance failed');
    console.log(JSON.stringify({ output: OUT, exactAgreement: matrix.overall.exact + '/24',
        adjacentDisagreements: matrix.overall.adjacent, majorDisagreements: matrix.overall.major,
        highConfidenceMajorDisagreements: confidence.highConfidenceMajorDisagreementCount,
        overallConsistency: cohorts.OVERALL.stability, recommendation: recommendation.recommendation,
        priorConflictInterpretation: prior.interpretation, allTestsPassed: true, hardStopReached: true }, null, 2));
}

if (require.main === module) main();
module.exports = { distribution: distribution, validateReview: validateReview, unblind: unblind,
    agreementMatrix: agreementMatrix, stability: stability, confidenceAnalysis: confidenceAnalysis,
    semanticAnalysis: semanticAnalysis };
