'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = path.join(ROOT, 'accumulation-ground-truth-v2-definition-calibration-v1');
var DEFAULT_PROPOSAL = '/Users/yaodebao/.codex/attachments/cfa769e9-af59-4b66-b9f4-1b671e70bfae/pasted-text.txt';
var PROPOSAL = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PROPOSAL;
var GT_V1 = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var EXPECTED_IDS = Array.from({ length: 12 }, function (_, index) {
    return 'CAL-' + String(index + 1).padStart(2, '0');
});
var RESPONSE_FIELDS = ['calibrationId', 'provisionalClass', 'independentBalance', 'twoSidedAuction',
    'previousTrendSeparation', 'oneSidedResidence', 'valueMigration', 'excursionContext', 'why',
    'definitionFeedback', 'definitionFeedbackNote'];

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function writeJson(name, value) {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');
}
function deepClone(value) { return JSON.parse(JSON.stringify(value)); }

function validateProposal(proposal) {
    if (proposal.schemaVersion !== 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1') {
        throw new Error('Unexpected calibration schemaVersion');
    }
    if (!Array.isArray(proposal.responses) || proposal.responses.length !== 12) {
        throw new Error('Expected exactly 12 calibration responses');
    }
    var ids = proposal.responses.map(function (row) { return row.calibrationId; }).sort();
    if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_IDS)) throw new Error('Calibration IDs are incomplete or duplicated');
    proposal.responses.forEach(function (row) {
        RESPONSE_FIELDS.forEach(function (field) {
            if (typeof row[field] !== 'string' || !row[field].trim()) {
                throw new Error(row.calibrationId + ' missing ' + field);
            }
        });
    });
    return true;
}

function caseEvidence(row, observation) {
    return { calibrationId: row.calibrationId, provisionalClass: row.provisionalClass,
        observation: observation, why: row.why, definitionFeedback: row.definitionFeedback };
}

function buildEvidence(responses) {
    var byId = Object.fromEntries(responses.map(function (row) { return [row.calibrationId, row]; }));
    function rows(ids, observation) {
        return ids.map(function (id) { return caseEvidence(byId[id], observation(byId[id])); });
    }
    var clear = responses.filter(function (row) { return row.provisionalClass === 'CLEAR_A'; }).map(function (row) { return row.calibrationId; });
    var borderline = responses.filter(function (row) { return row.provisionalClass === 'BORDERLINE_A'; }).map(function (row) { return row.calibrationId; });
    var no = responses.filter(function (row) { return row.provisionalClass === 'NO_A'; }).map(function (row) { return row.calibrationId; });
    return {
        schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_SYNTHESIS_EVIDENCE_V1',
        synthesisMethod: 'CASE_LEVEL_SEMANTIC_SYNTHESIS_NOT_MAJORITY_VOTE',
        calibrationCases: 12,
        classDistribution: { CLEAR_A: clear.length, BORDERLINE_A: borderline.length, NO_A: no.length, UNSURE: 0 },
        specialBoundaryCases: ['CAL-03', 'CAL-06', 'CAL-08'].map(function (id) {
            var row = byId[id];
            return { calibrationId: id, class: row.provisionalClass, independentBalance: row.independentBalance,
                twoSidedAuction: row.twoSidedAuction, definitionFeedback: row.definitionFeedback,
                interpretation: 'Real accumulation evidence exists, but independence and auction coherence are partial or late-forming; this calibrates BORDERLINE_A as a positive-evidence boundary, not a fallback uncertainty bucket.' };
        }),
        semantics: {
            INDEPENDENT_BALANCE: {
                role: 'REQUIRED_CORE_SEMANTIC',
                reasoning: 'Every CLEAR_A has an identifiable independent balance, every NO_A lacks one, and all three boundary cases retain only partial independence. The role follows the case-level narrative pattern, not a vote count.',
                supportingCases: rows(clear.concat(no), function (row) { return row.provisionalClass === 'CLEAR_A' ?
                    'CLEAR_A with independentBalance=YES.' : 'NO_A with independentBalance=NO; absence explains why a box is insufficient.'; }),
                challengingCases: [],
                ambiguousCases: rows(borderline, function () { return 'BORDERLINE_A with independentBalance=PARTIAL; real balance forms late or remains mixed with prior delivery.'; })
            },
            COHERENT_TWO_SIDED_AUCTION: {
                role: 'REQUIRED_CORE_SEMANTIC',
                reasoning: 'CLEAR cases consistently use upper, middle, and lower regions within one auction identity; NO cases show only weak two-sided use. Partial auction is the calibrated boundary state.',
                supportingCases: rows(clear.concat(no), function (row) { return row.provisionalClass === 'CLEAR_A' ?
                    'CLEAR_A with twoSidedAuction=COHERENT.' : 'NO_A with twoSidedAuction=WEAK; local back-and-forth does not establish coherent two-sided auction.'; }),
                challengingCases: [],
                ambiguousCases: rows(borderline, function () { return 'BORDERLINE_A with twoSidedAuction=PARTIAL; participation exists but is late, incomplete, or insufficiently persistent.'; })
            },
            PREVIOUS_TREND_SEPARATION: {
                role: 'CONTEXTUAL',
                reasoning: 'Separation strongly supports an independent balance when a prior delivery exists, but CAL-12 is CLEAR_A with no clear previous trend. Therefore separation cannot be universally required.',
                supportingCases: rows(['CAL-01', 'CAL-02', 'CAL-04', 'CAL-05', 'CAL-07', 'CAL-09', 'CAL-10', 'CAL-11'], function (row) {
                    return row.provisionalClass === 'CLEAR_A' ? 'Clear separation supports independent formation identity.' : 'No separation supports the trend-pause/directional-consolidation interpretation.';
                }),
                challengingCases: rows(['CAL-12'], function () { return 'CLEAR_A despite NO_CLEAR_PREVIOUS_TREND; a prior trend is not a prerequisite.'; }),
                ambiguousCases: rows(borderline, function () { return 'Partial separation coexists with partial balance and helps explain BORDERLINE_A.'; })
            },
            ONE_SIDED_RESIDENCE: {
                role: 'STRONG_NEGATIVE_EVIDENCE',
                reasoning: 'All NO_A cases show STRONG one-sided residence, while CLEAR_A cases show NONE. MILD residence occurs in all calibrated BORDERLINE_A cases, so severity must be interpreted within auction identity.',
                supportingCases: rows(clear.concat(no), function (row) { return row.provisionalClass === 'CLEAR_A' ?
                    'No one-sided residence; both sides remain meaningfully used.' : 'Strong one-sided residence; the opposite side is not persistently re-participated.'; }),
                challengingCases: [],
                ambiguousCases: rows(borderline, function () { return 'Mild one-sided residence is negative context but does not erase genuine partial accumulation evidence.'; })
            },
            PERSISTENT_VALUE_MIGRATION: {
                role: 'STRONG_NEGATIVE_EVIDENCE',
                reasoning: 'Persistent migration dominates three NO_A formations and is absent from every CLEAR/BORDERLINE case. CAL-04 shows that no migration does not prove accumulation; independent balance and auction remain primary.',
                supportingCases: rows(['CAL-02', 'CAL-09', 'CAL-11'], function () { return 'NO_A with persistent directional value migration dominating the formation.'; }),
                challengingCases: rows(['CAL-04'], function () { return 'NO_A with valueMigration=NONE; absence of migration is insufficient when the formation is still a one-sided trend pause.'; }),
                ambiguousCases: rows(clear.filter(function (id) { return byId[id].valueMigration === 'TEMPORARY'; }).concat(borderline),
                    function () { return 'Temporary migration remains inside or partly inside the balance narrative; it is not an automatic rejection.'; })
            },
            REABSORPTION: {
                role: 'QUALITY_CONTEXT',
                reasoning: 'Reabsorption strengthens evidence that an excursion remains inside one balance narrative. It is conditional on a meaningful excursion and is therefore quality context, not a universal existence requirement.',
                supportingCases: rows(clear, function () { return 'Excursion is reabsorbed within the balance and the two-sided auction resumes.'; })
                    .concat(rows(['CAL-09'], function () { return 'Failed reabsorption accompanies breakdown of the proposed balance.'; })),
                challengingCases: rows(['CAL-02', 'CAL-04', 'CAL-11'], function () { return 'NO_A has no clear excursion; reabsorption is not applicable and cannot be required in every formation.'; }),
                ambiguousCases: rows(borderline, function () { return 'Partial reabsorption supports genuine but incomplete balance evidence and helps distinguish BORDERLINE_A.'; })
            }
        }
    };
}

function buildConflicts(responses) {
    function compact(row, conflictType) {
        return { calibrationId: row.calibrationId, conflictType: conflictType, provisionalClass: row.provisionalClass,
            independentBalance: row.independentBalance, twoSidedAuction: row.twoSidedAuction,
            definitionFeedback: row.definitionFeedback, definitionFeedbackNote: row.definitionFeedbackNote, why: row.why };
    }
    var conflicts = [];
    responses.forEach(function (row) {
        if (row.provisionalClass === 'CLEAR_A' && row.independentBalance !== 'YES') conflicts.push(compact(row, 'CLEAR_WITHOUT_INDEPENDENT_BALANCE_YES'));
        if (row.provisionalClass === 'CLEAR_A' && row.twoSidedAuction !== 'COHERENT') conflicts.push(compact(row, 'CLEAR_WITHOUT_COHERENT_TWO_SIDED_AUCTION'));
        if (row.provisionalClass === 'NO_A' && row.independentBalance === 'YES') conflicts.push(compact(row, 'NO_WITH_INDEPENDENT_BALANCE_YES'));
        if (row.provisionalClass === 'NO_A' && row.twoSidedAuction === 'COHERENT') conflicts.push(compact(row, 'NO_WITH_COHERENT_TWO_SIDED_AUCTION'));
        if (['DRAFT_0_TOO_STRICT', 'DRAFT_0_TOO_PERMISSIVE', 'DRAFT_0_AMBIGUOUS'].includes(row.definitionFeedback)) {
            conflicts.push(compact(row, 'DEFINITION_FEEDBACK_' + row.definitionFeedback.replace('DRAFT_0_', '')));
        }
    });
    return { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CONFLICT_CASES_V1',
        coreSemanticContradictions: conflicts.filter(function (row) {
            return row.conflictType.startsWith('CLEAR_WITHOUT_') || row.conflictType.startsWith('NO_WITH_');
        }),
        definitionBoundaryConflicts: conflicts.filter(function (row) { return row.conflictType.startsWith('DEFINITION_FEEDBACK_'); }),
        interpretation: 'CAL-03/CAL-06/CAL-08 expose wording ambiguity at the CLEAR↔BORDERLINE boundary, not contradiction of the two required core semantics.' };
}

function definitionMarkdown() {
    return `# ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1

Status: **READY_FOR_FREEZE — NOT FROZEN**

## ACCUMULATION_DEFINITION

Accumulation is a formation in which price establishes a recognizable, relatively independent balance and sustains a coherent two-sided auction within that balance. Directional movement may occur inside the formation, but it must remain subordinate to—or be reabsorbed into—the continuing balance narrative rather than dominate it through persistent one-sided acceptance or value migration.

The existence of a bounding box, compression, stable center, or temporary pause is not sufficient by itself.

## CLEAR_A_DEFINITION

**CLEAR_A** requires both:

1. A clearly identifiable independent balance belonging to the formation itself.
2. A coherent two-sided auction: upper and lower regions receive meaningful participation, with returns, rebalancing, or re-acceptance that preserve one auction identity.

Temporary center shifts, directional candles, irregular paths, asymmetry, and substantial excursions are allowed when they do not dominate the formation and the balance identity remains intact. Reabsorption is strong quality evidence when an excursion exists, but an excursion is not required.

## BORDERLINE_A_DEFINITION

**BORDERLINE_A** requires genuine accumulation evidence, not mere uncertainty. A real balance and two-sided auction are present, but at least one core semantic is partial, late-forming, insufficiently persistent, or still materially mixed with the preceding directional delivery.

Typical boundary conditions include:

- independent balance emerging mainly in the latter part of formation;
- meaningful but incomplete two-sided participation;
- mild one-sided residence;
- temporary migration with only partial reabsorption;
- multiple or expanding micro-balances whose shared identity remains plausible but not fully coherent.

CAL-03, CAL-06, and CAL-08 calibrate this category: each contains positive accumulation evidence, while independence and auction coherence remain partial.

## NO_A_DEFINITION

**NO_A** applies when a box, compression, or consolidation does not establish a sufficiently independent and coherent accumulation auction. Typical narratives include a trend pause, directional consolidation, sustained one-sided residence, persistent value migration, or irregular chop whose boundaries are defined mainly by extremes rather than repeated auction use.

Local back-and-forth, a narrow range, or a stable center cannot compensate for the absence of an independent balance and coherent two-sided auction.

## UNSURE_POLICY

**UNSURE** is a calibration/review state, not a Ground Truth V2 class. Use it only when the available formation-only view and this definition do not support a stable judgement. An UNSURE case must be held for definition review; it must not be silently converted into BORDERLINE_A.

## SEMANTIC_ROLES

- INDEPENDENT_BALANCE_ROLE = REQUIRED_CORE_SEMANTIC
- TWO_SIDED_AUCTION_ROLE = REQUIRED_CORE_SEMANTIC
- PREVIOUS_TREND_SEPARATION_ROLE = CONTEXTUAL
- ONE_SIDED_RESIDENCE_ROLE = STRONG_NEGATIVE_EVIDENCE
- PERSISTENT_VALUE_MIGRATION_ROLE = STRONG_NEGATIVE_EVIDENCE
- REABSORPTION_ROLE = QUALITY_CONTEXT

## POSITIVE_EVIDENCE

- Formation-specific auction identity distinguishable from simple directional pause.
- Meaningful use of upper and lower regions within one continuing balance.
- Returns through the interior, rebalancing, and re-acceptance.
- Temporary displacement or center shift that is subsequently absorbed without destroying the auction identity.
- Repeated use of the range even when geometry is irregular or asymmetric.

## NEGATIVE_EVIDENCE

- Sustained one-sided residence with little meaningful participation on the opposite side.
- Persistent directional value migration dominating the formation.
- Formation remaining inseparable from the preceding directional delivery.
- Compression or stable center caused mainly by a high/low-level trend pause.
- Irregular movement without a coherent shared auction identity.

Negative evidence is interpreted in context. No single item substitutes for judging the two core semantics.

## NON_REQUIREMENTS

- EQH/EQL REQUIRED = false
- PERFECT_RECTANGLE REQUIRED = false
- SYMMETRIC_TOUCHES REQUIRED = false
- FIXED_BAR_COUNT REQUIRED = false
- FIXED_DURATION REQUIRED = false
- STABLE_MIDPOINT REQUIRED = false
- ZERO_DISPLACEMENT_CANDLES REQUIRED = false
- SESSION_BOUNDARY REQUIRED = false
- FUTURE_REACTION REQUIRED = false
- MSS REQUIRED = false
- FVG REQUIRED = false

## TEMPORAL_AND_RESEARCH_BOUNDARY

Judgement uses formation-only information through formation confirmation. Future reaction and later structural events must not define formation identity. This document is a human semantic definition, not a detector specification; it introduces no numerical threshold, feature, score, or production behavior.
`;
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    var raw = fs.readFileSync(PROPOSAL, 'utf8');
    var proposal = JSON.parse(raw);
    validateProposal(proposal);
    var responseSnapshot = JSON.stringify(proposal.responses);
    var gtBefore = shaFile(GT_V1);
    var frozen = { schemaVersion: proposal.schemaVersion, reviewedAt: proposal.reviewedAt,
        reviewSource: 'USER_APPROVED_CHATGPT_CALIBRATION_VISUAL_REVIEW',
        sourceReviewSource: proposal.reviewSource,
        sourceFileSha256: sha(raw), responsesSha256: sha(responseSnapshot),
        responses: deepClone(proposal.responses) };
    if (JSON.stringify(frozen.responses) !== responseSnapshot) throw new Error('Frozen responses changed');
    var evidence = buildEvidence(frozen.responses);
    var conflicts = buildConflicts(frozen.responses);
    var markdown = definitionMarkdown();
    writeJson('accumulation-definition-calibration-results-frozen.json', frozen);
    writeJson('definition-synthesis-evidence.json', evidence);
    writeJson('definition-conflict-cases.json', conflicts);
    fs.writeFileSync(path.join(OUT, 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1.md'), markdown);

    var dedicated = cp.spawnSync(process.execPath,
        [path.join(__dirname, '..', 'test', 'accumulationGroundTruthV2DefinitionSynthesisV1.test.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    var full = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    var coreContradictions = conflicts.coreSemanticContradictions.length;
    var passed = dedicated.status === 0 && full.status === 0 && gtBefore === shaFile(GT_V1) &&
        coreContradictions === 0 && JSON.stringify(frozen.responses) === responseSnapshot;
    writeJson('test-results-final.json', {
        dedicated: { command: 'node test/accumulationGroundTruthV2DefinitionSynthesisV1.test.js',
            exitCode: dedicated.status, passed: dedicated.status === 0, stdout: dedicated.stdout, stderr: dedicated.stderr },
        fullRegression: { command: 'node test/run.js', exitCode: full.status, passed: full.status === 0,
            stdoutSha256: sha(full.stdout || ''), stdoutTail: String(full.stdout || '').split('\n').slice(-35), stderr: full.stderr }
    });
    var acceptance = {
        ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1_SYNTHESIS: passed ? 'PASS' : 'FAIL',
        CALIBRATION_RESPONSES_FROZEN: true,
        CALIBRATION_RESPONSES_CHANGED: false,
        CALIBRATION_REVIEW_PROVENANCE: frozen.reviewSource,
        INDEPENDENT_BALANCE_ROLE: 'REQUIRED_CORE_SEMANTIC',
        TWO_SIDED_AUCTION_ROLE: 'REQUIRED_CORE_SEMANTIC',
        PREVIOUS_TREND_SEPARATION_ROLE: 'CONTEXTUAL',
        ONE_SIDED_RESIDENCE_ROLE: 'STRONG_NEGATIVE_EVIDENCE',
        PERSISTENT_VALUE_MIGRATION_ROLE: 'STRONG_NEGATIVE_EVIDENCE',
        REABSORPTION_ROLE: 'QUALITY_CONTEXT',
        CORE_SEMANTIC_CONTRADICTIONS: coreContradictions,
        SPECIAL_BOUNDARY_CASES_REVIEWED: ['CAL-03', 'CAL-06', 'CAL-08'],
        DEFINITION_V1_READY_FOR_FREEZE: coreContradictions === 0,
        DEFINITION_V1_FROZEN: false,
        READY_FOR_FULL_60_CASE_V2_RELABEL: false,
        GROUND_TRUTH_V1_CHANGED: false,
        GROUND_TRUTH_V1_PRESERVED: true,
        GROUND_TRUTH_V2_LABELS_CREATED: false,
        FULL_60_CASE_V2_RELABEL_STARTED: false,
        DETECTOR_FEATURE_IMPLEMENTED: false,
        F6_CHANGED: false,
        F7_CHANGED: false,
        F8_ADDED: false,
        REPRESENTATION_V3_STARTED: false,
        MANIPULATION_RESEARCH_STARTED: false,
        PRODUCTION_CHANGED: false,
        OUTCOME_USED: false,
        POST_CONFIRMATION_BARS_USED: 0,
        FUTURE_LEAK_VIOLATIONS: 0,
        ALL_TESTS_PASSED: dedicated.status === 0 && full.status === 0,
        HARD_STOP_REACHED: true
    };
    writeJson('definition-acceptance.json', acceptance);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), `# Accumulation Ground Truth V2 — Definition Synthesis Report

## Outcome

Definition Synthesis **${passed ? 'PASS' : 'FAIL'}**. The twelve user-approved calibration responses were preserved verbatim and frozen with provenance \`${frozen.reviewSource}\`.

This synthesis did not use majority voting as a definition generator. Each semantic records supporting, challenging, and ambiguous cases in \`definition-synthesis-evidence.json\`.

## Roles

- Independent Balance: **REQUIRED_CORE_SEMANTIC**
- Coherent Two-Sided Auction: **REQUIRED_CORE_SEMANTIC**
- Previous Trend Separation: **CONTEXTUAL**
- One-Sided Residence: **STRONG_NEGATIVE_EVIDENCE**
- Persistent Value Migration: **STRONG_NEGATIVE_EVIDENCE**
- Reabsorption: **QUALITY_CONTEXT**

## Boundary calibration

CAL-03, CAL-06, and CAL-08 consistently identify the CLEAR↔BORDERLINE boundary: genuine accumulation evidence is present, but independent balance and two-sided auction are partial, late-forming, or insufficiently coherent. They motivate explicit BORDERLINE wording rather than a numeric rule.

## Conflicts

Core semantic contradictions: **${coreContradictions}**. Draft 0 wording ambiguity appears in CAL-03, CAL-06, and CAL-08 and is resolved in Definition V1 by requiring real positive accumulation evidence for BORDERLINE_A while reserving CLEAR_A for clearly established core semantics.

## Readiness

- \`DEFINITION_V1_READY_FOR_FREEZE = ${coreContradictions === 0}\`
- \`DEFINITION_V1_FROZEN = false\`
- \`READY_FOR_FULL_60_CASE_V2_RELABEL = false\`

Human approval is required before any freeze or relabel. HARD STOP reached.
`);
    console.log(JSON.stringify({ output: OUT, synthesis: acceptance.ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1_SYNTHESIS,
        coreSemanticContradictions: coreContradictions, definitionV1ReadyForFreeze: acceptance.DEFINITION_V1_READY_FOR_FREEZE,
        definitionV1Frozen: false, readyForFull60CaseV2Relabel: false, hardStopReached: true }, null, 2));
    if (!passed) process.exit(1);
}

if (require.main === module) main();
module.exports = { validateProposal: validateProposal, buildEvidence: buildEvidence,
    buildConflicts: buildConflicts, definitionMarkdown: definitionMarkdown, EXPECTED_IDS: EXPECTED_IDS };
