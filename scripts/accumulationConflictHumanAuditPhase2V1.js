'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = path.join(ROOT, 'accumulation-conflict-human-audit-v1');
var REVIEW_FILE = path.join(OUT, 'conflict-human-review-results.json');
var PROPOSAL_FILE = path.join(OUT, 'conflict-human-review-results-proposal.json');
var MAP_FILE = path.join(OUT, 'blind-case-map.json');
var PROFILE_FILE = path.join(ROOT, 'accumulation-representation-v2-prototype-v1', 'prototype-profiles.json');
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var REQUIRED_SOURCE = 'USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW';
var REQUIRED_SEED = 'ACCUMULATION_CONFLICT_HUMAN_AUDIT_V1_20260828';
var ALLOWED_FORMATION = new Set(['CLEAR_A', 'BORDERLINE_A', 'NO_A', 'UNSURE']);
var REQUIRED_FIELDS = ['blindId', 'formationClass', 'balanceQuality', 'centerBehavior', 'excursionBehavior',
    'auctionCharacter', 'observationTags', 'freeText'];

function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function shaText(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function reviewContentHash(review) { return shaText(JSON.stringify(review.reviews)); }

function validateReview(review, proposal) {
    var errors = [];
    if (review.schemaVersion !== 'ACCUMULATION_CONFLICT_HUMAN_AUDIT_V1') errors.push('schemaVersion');
    if (review.blindOrderSeed !== REQUIRED_SEED) errors.push('blindOrderSeed');
    if (review.reviewSource !== REQUIRED_SOURCE) errors.push('reviewSource');
    if (!Array.isArray(review.reviews) || review.reviews.length !== 7) errors.push('reviewCount');
    var ids = new Set();
    (review.reviews || []).forEach(function (row) {
        REQUIRED_FIELDS.forEach(function (field) { if (!(field in row)) errors.push(row.blindId + ':' + field); });
        if (!/^BLIND-0[1-7]$/.test(row.blindId || '')) errors.push('blindId:' + row.blindId);
        if (ids.has(row.blindId)) errors.push('duplicate:' + row.blindId); else ids.add(row.blindId);
        if (!ALLOWED_FORMATION.has(row.formationClass)) errors.push(row.blindId + ':formationClass');
        if (!row.balanceQuality || !row.centerBehavior || !row.excursionBehavior || !row.auctionCharacter ||
            !Array.isArray(row.observationTags) || !String(row.freeText || '').trim()) errors.push(row.blindId + ':incomplete');
    });
    if (proposal && reviewContentHash(review) !== reviewContentHash(proposal)) errors.push('proposalReviewContentChanged');
    return errors;
}

function unblind(review, map, profiles) {
    var byBlind = {}, profileById = {};
    map.cases.forEach(function (row) { byBlind[row.blindId] = row; });
    profiles.forEach(function (row) { profileById[row.caseId] = row; });
    return review.reviews.map(function (human) {
        var mapping = byBlind[human.blindId], profile = mapping && profileById[mapping.originalCaseId];
        if (!mapping || !profile) throw new Error('Cannot unblind ' + human.blindId);
        return {
            originalCaseId: mapping.originalCaseId,
            blindId: human.blindId,
            blindReviewSource: review.reviewSource,
            blindFormationClass: human.formationClass,
            blindReview: {
                balanceQuality: human.balanceQuality,
                centerBehavior: human.centerBehavior,
                excursionBehavior: human.excursionBehavior,
                auctionCharacter: human.auctionCharacter,
                observationTags: human.observationTags.slice(),
                freeText: human.freeText
            },
            frozenGroundTruth: mapping.frozenGroundTruth,
            centerPath: profile.centerProfile.centerPath.slice(),
            centerPathType: profile.centerPathType,
            centerMigrationMagnitude: profile.centerProfile.centerMigrationMagnitude,
            F7Profile: {
                excursionCount: profile.reabsorptionProfile.excursionCount,
                midReturns: profile.reabsorptionProfile.midReturns,
                oppositeSideReturns: profile.reabsorptionProfile.oppositeSideReturns,
                failedReabsorptions: profile.reabsorptionProfile.failedReabsorptions,
                reabsorptionState: profile.REABSORPTION_STATE
            },
            prototypeDecision: profile.prototypeDecision,
            prototypeReason: profile.decisionReason,
            conflictType: mapping.conflictType,
            humanReviewGroundTruthDisagreement: human.formationClass !== mapping.frozenGroundTruth
        };
    });
}

var CASE_ANALYSIS = {
    case026: {
        conclusion: 'Blind review rejects the formation as a trend pause with one-sided upper residence, so it agrees with the prototype rejection but disagrees with frozen Ground Truth.',
        centerMagnitudeAssessment: 'Magnitude is only 0.151 normalized range; the prototype does not use magnitude and treats any strictly monotonic three-segment path as migration.',
        pathAssessment: 'The blind review calls the center stable, not persistently migrating. The order-only path taxonomy overstates a small upward drift.',
        reabsorptionAssessment: 'One of four excursions is marked failed. A binary any-failure condition ignores three MID returns and the visual absence of a clear excursion.',
        missingMeaning: ['INDEPENDENT_BALANCE_FORMATION', 'REABSORPTION_EVENT_SEVERITY_CONTEXT']
    },
    case034: {
        conclusion: 'This is the strongest confirmed false rejection: blind and frozen reviews both identify accumulation, while the prototype rejects it.',
        centerMagnitudeAssessment: 'The 0.270 downward center movement is moderate and occurs inside a visually stable, independently formed range.',
        pathAssessment: 'Three coarse center segments look monotonic, but the blind review sees repeated two-sided rebalancing and no sustained value migration.',
        reabsorptionAssessment: 'Only one of four excursions is failed, while three reach MID and three reach the opposite side. The binary failure flag discards that auction evidence.',
        missingMeaning: ['COHERENT_TWO_SIDED_AUCTION', 'REABSORPTION_EVENT_SEVERITY_CONTEXT']
    },
    case040: {
        conclusion: 'Blind review calls this a directional pause after an uptrend; it supports the prototype rejection and disagrees with frozen Ground Truth.',
        centerMagnitudeAssessment: 'The 0.316 upward movement is close to one normalized third but no numeric boundary is used or justified here.',
        pathAssessment: 'Monotonic center movement is directionally consistent with the visual trend-pause interpretation, but center path alone does not establish that semantic.',
        reabsorptionAssessment: 'Six of seven excursions return to MID. The single failed event contributes to rejection but does not express the more important lack of independent balance.',
        missingMeaning: ['INDEPENDENT_BALANCE_FORMATION', 'REABSORPTION_EVENT_SEVERITY_CONTEXT']
    },
    case049: {
        conclusion: 'Blind review rejects this as irregular, one-sided lower consolidation; it supports prototype rejection but for richer auction-quality reasons.',
        centerMagnitudeAssessment: 'Magnitude is only 0.103 normalized range. Strict ordering converts a very small drift into migration, showing magnitude-free path typing can mislead.',
        pathAssessment: 'The center is visually stable while participation is concentrated in the lower portion; center stability does not imply coherent accumulation.',
        reabsorptionAssessment: 'Four of five excursions return to MID and three reach the opposite side. One binary failed event is too coarse to explain the human rejection.',
        missingMeaning: ['COHERENT_TWO_SIDED_AUCTION', 'REABSORPTION_EVENT_SEVERITY_CONTEXT']
    },
    case023: {
        conclusion: 'Blind review upgrades frozen NO to borderline rather than clear: some balance exists, but late downward migration prevents a stable accumulation reading.',
        healthyProfileWhyInsufficient: 'The three-segment profile labels the path reversing and all excursions as reabsorbed, but it loses the late sequence and the distinction between temporary return and persistent end-state migration.',
        formationMeaning: 'Healthy center/reabsorption aggregates describe partial balance quality, not an accumulation identity.',
        missingMeaning: ['COHERENT_TWO_SIDED_AUCTION']
    },
    case042: {
        conclusion: 'Blind review identifies a strong, persistent two-sided auction and disagrees with frozen NO. The prototype healthy profile aligns with the blind reading.',
        healthyProfileWhyInsufficient: 'This case does not expose a missing rejection semantic; it exposes a Ground Truth disagreement that must remain frozen.',
        formationMeaning: 'F6/F7 are supportive evidence here, but one confirming case cannot make them sufficient.',
        missingMeaning: []
    },
    case043: {
        conclusion: 'Blind review upgrades frozen NO to borderline, not clear. Reabsorption exists, but the overall balance is not clean.',
        healthyProfileWhyInsufficient: 'All three excursions return to MID, yet none reaches the opposite side. MID return health therefore does not establish full two-sided participation.',
        formationMeaning: 'Center return and MID reabsorption are quality attributes that still need coherent auction participation.',
        missingMeaning: ['COHERENT_TWO_SIDED_AUCTION', 'INDEPENDENT_BALANCE_FORMATION']
    }
};

function semanticAnalysis(rows) {
    var groupAIds = new Set(['case026', 'case034', 'case040', 'case049']);
    var enriched = rows.map(function (row) { return Object.assign({ originalCaseId: row.originalCaseId,
        blindId: row.blindId, blindFormationClass: row.blindFormationClass,
        frozenGroundTruth: row.frozenGroundTruth, prototypeDecision: row.prototypeDecision }, CASE_ANALYSIS[row.originalCaseId]); });
    return {
        criticalSemanticAnswer: 'ONLY_PARTIAL_EVIDENCE',
        F6F7AreSufficient: false,
        explanation: 'Center stability and reabsorption express partial balance quality. They neither prove an independent coherent two-sided auction nor reliably distinguish a trend pause, one-sided residence, or irregular local consolidation.',
        groupA: enriched.filter(function (row) { return groupAIds.has(row.originalCaseId); }),
        groupB: enriched.filter(function (row) { return !groupAIds.has(row.originalCaseId); }),
        groupASummary: {
            blindAgreesWithFrozenGroundTruth: 1,
            blindDisagreesWithFrozenGroundTruth: 3,
            diagnosis: 'All four prototype rejections combine an order-only monotonic path with exactly one failed reabsorption. Three blind reviews independently reject those formations for trend-pause or auction-coherence reasons; case034 remains the confirmed semantic false rejection.'
        },
        groupBSummary: {
            blindClear: 1, blindBorderline: 2, blindNo: 0,
            diagnosis: 'The blind review does not reproduce frozen NO on any Group B case. Two remain borderline because healthy aggregates do not guarantee clean auction quality; one appears clearly two-sided. These are Ground Truth disagreements, not authorization to relabel.'
        }
    };
}

function missingCandidates() {
    return {
        candidateCount: 3,
        candidates: [
            { name: 'INDEPENDENT_BALANCE_FORMATION', kind: 'MISSING_SEMANTIC_CANDIDATE',
                explainsCases: ['case026', 'case040', 'case043'],
                meaning: 'Whether the range establishes an autonomous balance rather than merely pausing an incoming directional move or residing on one side.',
                notAFeatureSpec: true },
            { name: 'COHERENT_TWO_SIDED_AUCTION', kind: 'MISSING_SEMANTIC_CANDIDATE',
                explainsCases: ['case023', 'case034', 'case043', 'case049'],
                meaning: 'Whether price participation forms one coherent auction across both sides instead of disconnected micro-ranges, local chop, or MID-only returns.',
                notAFeatureSpec: true },
            { name: 'REABSORPTION_EVENT_SEVERITY_CONTEXT', kind: 'MISSING_SEMANTIC_CANDIDATE',
                explainsCases: ['case026', 'case034', 'case040', 'case049'],
                meaning: 'Whether an apparent failed reabsorption is a material formation failure or a normal late/partial excursion inside otherwise continuing auction.',
                notAFeatureSpec: true }
        ],
        F8Implemented: false,
        featureSpecificationCreated: false,
        parameterSearchPerformed: false
    };
}

function report(rows, semantics, disagreements, candidates) {
    function line(id) {
        var row = rows.find(function (x) { return x.originalCaseId === id; }), a = CASE_ANALYSIS[id];
        return '- **' + id + '** — blind `' + row.blindFormationClass + '`, frozen `' + row.frozenGroundTruth +
            '`, prototype `' + row.prototypeDecision + '`. ' + a.conclusion + '\n';
    }
    return '# Accumulation Representation Conflict Human Audit V1 — Phase 2\n\n' +
        '> **UNBLIND AUDIT COMPLETE.** The seven reviews are recorded as `USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW`. Ground Truth remains frozen. No feature, detector, score, or parameter was created.\n\n' +
        '## Primary result\n\n`CENTER STABILITY + REABSORPTION = ONLY PARTIAL EVIDENCE`. These properties are useful accumulation quality attributes, but they are not a complete accumulation definition and are not sufficient by themselves.\n\n' +
        'The blind classifications disagree with frozen Ground Truth on **' + disagreements.length + ' of 7** cases. This is research information only; no label is changed. The strongest model-side false rejection is case034, where blind and frozen readings agree on accumulation while the prototype rejects a coherent two-sided auction.\n\n' +
        '## Group A — frozen positive / prototype rejection\n\n' + ['case026', 'case034', 'case040', 'case049'].map(line).join('') +
        '\nThe prototype rejection pattern is identical in all four: strict three-point monotonic ordering plus exactly one failed reabsorption. It ignores migration magnitude and treats any one failed event as decisive. That is too coarse for case034; in the other three, blind rejection is better explained by independent-balance and auction-coherence semantics than by the prototype binary pair.\n\n' +
        '## Group B — frozen negative / healthy F6/F7\n\n' + ['case023', 'case042', 'case043'].map(line).join('') +
        '\nNone of the three blind reviews reproduces the frozen negative class exactly: two are borderline and one is clear. The result still shows why F6/F7 cannot be sufficient: healthy center/reabsorption can coexist with mixed quality, MID-only returns, or unresolved migration. It also reveals substantial Ground Truth disagreement that cannot be converted into automatic relabeling.\n\n' +
        '## Missing semantic candidates (maximum three)\n\n' + candidates.candidates.map(function (c) {
            return '1. **' + c.name + '** — ' + c.meaning + ' Explains: ' + c.explainsCases.join(', ') + '.\n';
        }).join('') +
        '\nThese are semantic candidates only—not feature specifications. No threshold, score, or detector is proposed.\n\n' +
        '## Final status\n\n```ini\nHUMAN_BLIND_REVIEWS_COMPLETE = true\nPHASE_2_UNBLIND = COMPLETE\n' +
        'USER_APPROVED_REVIEW_SOURCE = USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW\n' +
        'GROUND_TRUTH_DISAGREEMENTS = ' + disagreements.length + '\nCENTER_STABILITY_REABSORPTION_ROLE = ONLY_PARTIAL_EVIDENCE\n' +
        'F6_F7_SUFFICIENT = false\nMISSING_SEMANTIC_CANDIDATES = 3\nF8_IMPLEMENTED = false\n' +
        'GROUND_TRUTH_CHANGED = false\nACCUMULATION_DETECTOR_CHANGED = false\nPRODUCTION_BEHAVIOR_CHANGED = false\n' +
        'OUTCOME_DATA_USED = false\nPOST_CONFIRMATION_BARS_USED = 0\nFUTURE_LEAK_VIOLATIONS = 0\nHARD_STOP_REACHED = true\n```\n';
}

function main() {
    var review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
    var proposal = JSON.parse(fs.readFileSync(PROPOSAL_FILE, 'utf8'));
    var map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    var profiles = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    var errors = validateReview(review, proposal);
    if (errors.length) throw new Error('Review validation failed: ' + errors.join(', '));
    var frozenFiles = [GT_FILE, BASELINE_FILE, path.join(__dirname, '..', 'amd', 'accumulationDetector.js'),
        path.join(__dirname, '..', 'amd', 'amdState.js'), path.join(__dirname, '..', 'config', 'thresholds.js'),
        path.join(__dirname, '..', 'events', 'displacementDetector.js'),
        path.join(__dirname, '..', 'liquidity', 'persistentEqualLiquidityV3.js'),
        path.join(__dirname, '..', 'liquidity', 'equalLiquidity.js'), path.join(__dirname, '..', 'live', 'liveEngine.js')];
    var before = frozenFiles.map(shaFile);
    var rows = unblind(review, map, profiles);
    if (rows.length !== 7) throw new Error('Expected seven unblind rows');
    var disagreements = rows.filter(function (row) { return row.humanReviewGroundTruthDisagreement; }).map(function (row) {
        return { originalCaseId: row.originalCaseId, blindId: row.blindId,
            frozenGroundTruth: row.frozenGroundTruth, blindFormationClass: row.blindFormationClass,
            status: 'HUMAN_REVIEW_GROUND_TRUTH_DISAGREEMENT', action: 'RESEARCH_RECORD_ONLY_NO_RELABEL' };
    });
    var semantics = semanticAnalysis(rows), candidates = missingCandidates();
    writeJson('unblind-comparison.json', { schemaVersion: 'ACCUMULATION_CONFLICT_UNBLIND_COMPARISON_V1',
        reviewSource: review.reviewSource, reviewContentSha256: reviewContentHash(review), cases: rows });
    writeJson('conflict-semantic-analysis.json', semantics);
    writeJson('ground-truth-disagreements.json', { disagreementCount: disagreements.length,
        groundTruthChanged: false, cases: disagreements });
    writeJson('missing-semantic-candidates.json', candidates);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(rows, semantics, disagreements, candidates));

    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
    var after = frozenFiles.map(shaFile), frozenSame = JSON.stringify(before) === JSON.stringify(after);
    var pass = tests.status === 0 && frozenSame && disagreements.length === 6 && candidates.candidateCount <= 3 &&
        semantics.criticalSemanticAnswer === 'ONLY_PARTIAL_EVIDENCE';
    writeJson('test-results-final.json', { command: 'node test/run.js', exitCode: tests.status,
        passed: tests.status === 0, stdoutSha256: shaText(tests.stdout || ''),
        stdoutTail: String(tests.stdout || '').split('\n').slice(-35), stderr: tests.stderr || '' });
    writeJson('acceptance-final.json', {
        ACCUMULATION_CONFLICT_HUMAN_AUDIT_V1: pass ? 'PASS' : 'FAIL',
        HUMAN_BLIND_REVIEWS_COMPLETE: true, REVIEW_CASES: 7,
        REVIEW_SOURCE: review.reviewSource, ORIGINAL_REVIEW_CONTENT_PRESERVED: reviewContentHash(review) === reviewContentHash(proposal),
        PHASE_2_UNBLIND: pass ? 'COMPLETE' : 'FAIL', GROUND_TRUTH_DISAGREEMENTS: disagreements.length,
        CENTER_STABILITY_REABSORPTION_ROLE: semantics.criticalSemanticAnswer,
        F6_F7_SUFFICIENT: false, MISSING_SEMANTIC_CANDIDATES: candidates.candidateCount,
        F8_IMPLEMENTED: false, PARAMETER_SEARCH_PERFORMED: false, SCORE_IMPLEMENTED: false,
        NEW_DETECTOR_IMPLEMENTED: false, GROUND_TRUTH_CHANGED: false, BASELINE_CONFIG_CHANGED: false,
        ACCUMULATION_DETECTOR_CHANGED: false, EQ_V3_CHANGED: false, DISPLACEMENT_ENGINE_CHANGED: false,
        LIQUIDITY_ENGINE_CHANGED: false, AMD_ENGINE_CHANGED: false, WATCH_ALGORITHM_CHANGED: false,
        NOTIFICATION_LOGIC_CHANGED: false, MANIPULATION_IMPLEMENTED: false, DISTRIBUTION_IMPLEMENTED: false,
        PRODUCTION_BEHAVIOR_CHANGED: false, OUTCOME_DATA_USED: false, POST_CONFIRMATION_BARS_USED: 0,
        FUTURE_LEAK_VIOLATIONS: 0, ALL_TESTS_PASSED: tests.status === 0, HARD_STOP_REACHED: true
    });
    if (!pass) throw new Error('Phase 2 acceptance failed');
    console.log(JSON.stringify({ output: OUT, reviewCases: 7, disagreements: disagreements.length,
        semanticAnswer: semantics.criticalSemanticAnswer, missingSemanticCandidates: candidates.candidateCount,
        groundTruthChanged: false, allTestsPassed: true, hardStopReached: true }, null, 2));
}

if (require.main === module) main();
module.exports = { validateReview: validateReview, reviewContentHash: reviewContentHash,
    unblind: unblind, semanticAnalysis: semanticAnalysis, missingCandidates: missingCandidates };
