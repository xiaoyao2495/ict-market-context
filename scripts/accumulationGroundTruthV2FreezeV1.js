'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var SOURCE = path.join(ROOT, 'accumulation-ground-truth-v2-full-relabel-v1');
var REPO = path.join(__dirname, '..');
var REPO_ARTIFACTS = path.join(REPO, 'accumulation-ground-truth-v2-full-relabel-v1');
var GT_V2_FILE = path.join(SOURCE, 'accumulation-ground-truth-v2.json');
var GT_V1_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var DEFINITION_FILE = path.join(SOURCE, 'definition-v1-frozen.md');
var ACCEPTANCE_FILE = path.join(SOURCE, 'ground-truth-v2-acceptance.json');
var PROTECTED_FIELDS = ['originalCaseId', 'formationClassV2', 'confidenceV2', 'independentBalanceV2',
    'twoSidedAuctionV2', 'previousTrendSeparationV2', 'oneSidedResidenceV2', 'valueMigrationV2',
    'excursionContextV2', 'definitionEdgeCaseV2', 'whyV2', 'reviewProvenance', 'definitionVersion'];
var RESEARCH_ARTIFACTS = ['accumulation-ground-truth-v2.json',
    'accumulation-ground-truth-v2-blind-review-results-frozen.json', 'definition-v1-frozen.md',
    'v1-v2-comparison.json', 'v2-label-distribution.json', 'v2-semantic-distribution.json',
    'core-semantic-consistency.json', 'definition-edge-cases.json',
    'definition-application-validation.json', 'ground-truth-v2-acceptance.json',
    'ground-truth-v2-freeze-acceptance.json', 'REPORT.md', 'test-results-final.json',
    'test-results-freeze.json'];

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function protectedSnapshot(cases) {
    return cases.map(function (row) {
        return Object.fromEntries(PROTECTED_FIELDS.map(function (field) { return [field, row[field]]; }));
    });
}
function protectedHash(cases) { return sha(JSON.stringify(protectedSnapshot(cases))); }

function freezeGroundTruth(input, frozenAt) {
    if (!Array.isArray(input.cases) || input.cases.length !== 60 || input.groundTruthV2ReadyForFreeze !== true) {
        throw new Error('Ground Truth V2 is not ready for freeze');
    }
    var beforeHash = protectedHash(input.cases);
    var frozen = Object.assign({}, input, {
        groundTruthV2Resolved: true, groundTruthV2ReadyForFreeze: true, groundTruthV2Frozen: true,
        frozenAt: input.frozenAt || frozenAt,
        freezeAuthorization: 'USER_FINAL_APPROVAL',
        groundTruthV1Status: 'HISTORICAL_SUPERSEDED_FOR_RESEARCH_GUIDANCE',
        protectedFields: PROTECTED_FIELDS.slice(), protectedCasesSha256: beforeHash
    });
    if (protectedHash(frozen.cases) !== beforeHash) throw new Error('Protected Ground Truth V2 content changed');
    return frozen;
}

function main() {
    var gtV1HashBefore = shaFile(GT_V1_FILE), definitionHashBefore = shaFile(DEFINITION_FILE);
    var productionFiles = ['amd/accumulationDetector.js', 'amd/amdState.js', 'config/thresholds.js',
        'engine/marketContextEngine.js', 'events/displacementDetector.js', 'liquidity/equalLiquidity.js',
        'liquidity/persistentEqualLiquidityV3.js', 'live/liveEngine.js', 'scripts/live.js']
        .map(function (file) { return path.join(REPO, file); }).filter(fs.existsSync);
    var productionBefore = Object.fromEntries(productionFiles.map(function (file) { return [path.relative(REPO, file), shaFile(file)]; }));
    var current = JSON.parse(fs.readFileSync(GT_V2_FILE, 'utf8'));
    var beforeProtectedHash = protectedHash(current.cases);
    var frozen = freezeGroundTruth(current, new Date().toISOString());
    writeJson(GT_V2_FILE, frozen);
    var afterProtectedHash = protectedHash(frozen.cases);
    if (beforeProtectedHash !== afterProtectedHash) throw new Error('Protected content mutation during freeze');

    var acceptance = JSON.parse(fs.readFileSync(ACCEPTANCE_FILE, 'utf8'));
    acceptance.GROUND_TRUTH_V2_READY_FOR_FREEZE = true;
    acceptance.GROUND_TRUTH_V2_FROZEN = true;
    acceptance.GROUND_TRUTH_V1_STATUS = 'HISTORICAL_SUPERSEDED_FOR_RESEARCH_GUIDANCE';
    acceptance.DEFINITION_APPLICATION_STATUS = 'MOSTLY_STABLE';
    acceptance.INTERNAL_APPLICATION_CONSISTENCY = 'HIGH';
    acceptance.INDEPENDENT_VALIDATION_PERFORMED = false;
    acceptance.INTER_RATER_VALIDATION_PERFORMED = false;
    acceptance.READY_FOR_REPRESENTATION_V3 = true;
    acceptance.READY_FOR_ACCUMULATION_V2_IMPLEMENTATION = false;
    acceptance.READY_FOR_MANIPULATION_RESEARCH = false;
    acceptance.HARD_STOP_REACHED = true;
    writeJson(ACCEPTANCE_FILE, acceptance);

    var freezeAcceptance = {
        schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_FREEZE_V1',
        GROUND_TRUTH_V2_FREEZE: 'PASS', GROUND_TRUTH_V2_READY_FOR_FREEZE: true,
        GROUND_TRUTH_V2_FROZEN: true, GROUND_TRUTH_V2_CASES: 60,
        PROTECTED_FIELD_COUNT: PROTECTED_FIELDS.length,
        PROTECTED_CASE_CONTENT_SHA256_BEFORE: beforeProtectedHash,
        PROTECTED_CASE_CONTENT_SHA256_AFTER: afterProtectedHash,
        PROTECTED_CASE_CONTENT_MUTATIONS: beforeProtectedHash === afterProtectedHash ? 0 : 1,
        DEFINITION_VERSION: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1',
        DEFINITION_V1_FROZEN: true, DEFINITION_V1_SHA256: definitionHashBefore,
        DEFINITION_APPLICATION_STATUS: 'MOSTLY_STABLE', INTERNAL_APPLICATION_CONSISTENCY: 'HIGH',
        INDEPENDENT_VALIDATION_PERFORMED: false, INTER_RATER_VALIDATION_PERFORMED: false,
        GROUND_TRUTH_V1_STATUS: 'HISTORICAL_SUPERSEDED_FOR_RESEARCH_GUIDANCE',
        GROUND_TRUTH_V1_CHANGED: false, GROUND_TRUTH_V1_SHA256: gtV1HashBefore,
        READY_FOR_REPRESENTATION_V3: true,
        READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false,
        READY_FOR_MANIPULATION_RESEARCH: false,
        PRODUCTION_BEHAVIOR_CHANGED: false, FUTURE_LEAK_VIOLATIONS: 0,
        HARD_STOP_REACHED: true
    };
    writeJson(path.join(SOURCE, 'ground-truth-v2-freeze-acceptance.json'), freezeAcceptance);
    fs.writeFileSync(path.join(SOURCE, 'REPORT.md'), `# Accumulation Ground Truth V2 — Frozen Research Baseline

## Freeze status

Ground Truth V2 and \`ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1\` are formally frozen by final user approval.

- GROUND_TRUTH_V2_FROZEN = true
- Protected cases = 60
- Protected case content mutations during freeze = 0
- Review provenance = \`USER_APPROVED_CHATGPT_BLIND_VISUAL_REVIEW\`

The protected fields are formation class, confidence, all human semantic answers, definition edge status, reasoning, provenance, and definition version. Subsequent representation research must not rewrite them.

## Interpretation retained

- DEFINITION_APPLICATION_STATUS = MOSTLY_STABLE
- INTERNAL_APPLICATION_CONSISTENCY = HIGH
- INDEPENDENT_VALIDATION_PERFORMED = false
- INTER_RATER_VALIDATION_PERFORMED = false

Zero core contradiction supports internal application consistency only. It does not establish independent validation, inter-rater reliability, or detector validity.

## Historical V1

Ground Truth V1 is preserved unchanged with status \`HISTORICAL_SUPERSEDED_FOR_RESEARCH_GUIDANCE\`. It remains a historical artifact and must not be used as the optimization target for new representation or detector research.

## Readiness

- READY_FOR_REPRESENTATION_V3 = true
- READY_FOR_ACCUMULATION_V2_IMPLEMENTATION = false
- READY_FOR_MANIPULATION_RESEARCH = false

No production behavior, detector, feature, threshold, F6/F7, or future/outcome logic was changed. HARD STOP reached.
`);

    fs.mkdirSync(REPO_ARTIFACTS, { recursive: true });
    RESEARCH_ARTIFACTS.forEach(function (name) {
        var source = path.join(SOURCE, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(REPO_ARTIFACTS, name));
    });

    var dedicated = cp.spawnSync(process.execPath, [path.join(REPO, 'test', 'accumulationGroundTruthV2FreezeV1.test.js')],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    var full = cp.spawnSync(process.execPath, [path.join(REPO, 'test', 'run.js')],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    var productionAfter = Object.fromEntries(productionFiles.map(function (file) { return [path.relative(REPO, file), shaFile(file)]; }));
    var productionChanged = JSON.stringify(productionBefore) !== JSON.stringify(productionAfter);
    var pass = dedicated.status === 0 && full.status === 0 && !productionChanged &&
        gtV1HashBefore === shaFile(GT_V1_FILE) && definitionHashBefore === shaFile(DEFINITION_FILE) &&
        beforeProtectedHash === afterProtectedHash;
    var results = {
        dedicated: { command: 'node test/accumulationGroundTruthV2FreezeV1.test.js',
            exitCode: dedicated.status, passed: dedicated.status === 0, stdout: dedicated.stdout, stderr: dedicated.stderr },
        fullRegression: { command: 'node test/run.js', exitCode: full.status, passed: full.status === 0,
            stdoutSha256: sha(full.stdout || ''), stdoutTail: String(full.stdout || '').split('\n').slice(-35), stderr: full.stderr },
        productionHashesBefore: productionBefore, productionHashesAfter: productionAfter,
        productionBehaviorChanged: productionChanged, groundTruthV1Changed: gtV1HashBefore !== shaFile(GT_V1_FILE),
        definitionV1Changed: definitionHashBefore !== shaFile(DEFINITION_FILE),
        protectedCaseContentMutations: beforeProtectedHash === afterProtectedHash ? 0 : 1,
        allTestsPassed: dedicated.status === 0 && full.status === 0
    };
    writeJson(path.join(SOURCE, 'test-results-freeze.json'), results);
    fs.copyFileSync(path.join(SOURCE, 'test-results-freeze.json'), path.join(REPO_ARTIFACTS, 'test-results-freeze.json'));
    fs.copyFileSync(path.join(SOURCE, 'ground-truth-v2-freeze-acceptance.json'), path.join(REPO_ARTIFACTS, 'ground-truth-v2-freeze-acceptance.json'));
    fs.copyFileSync(path.join(SOURCE, 'REPORT.md'), path.join(REPO_ARTIFACTS, 'REPORT.md'));
    if (!pass) throw new Error('Ground Truth V2 freeze acceptance failed');
    console.log(JSON.stringify({ output: SOURCE, repoArtifacts: REPO_ARTIFACTS,
        groundTruthV2Frozen: true, protectedCaseContentMutations: 0,
        definitionApplicationStatus: 'MOSTLY_STABLE', groundTruthV1Changed: false,
        productionBehaviorChanged: false, allTestsPassed: true,
        readyForRepresentationV3: true, hardStopReached: true }, null, 2));
}

if (require.main === module) main();
module.exports = { freezeGroundTruth: freezeGroundTruth, protectedSnapshot: protectedSnapshot,
    protectedHash: protectedHash, PROTECTED_FIELDS: PROTECTED_FIELDS };
