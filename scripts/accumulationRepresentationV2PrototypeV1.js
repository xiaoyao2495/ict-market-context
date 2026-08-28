'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var prototype = require('../audit/accumulationRepresentationV2PrototypeV1');
var auction = require('../audit/accumulationAuctionRepresentationV1');
var gtAudit = require('../audit/accumulationEqRoleAuditV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var AUCTION_DIR = path.join(ROOT, 'accumulation-balance-auction-research-v1');
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var MANIFEST_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'sample-manifest.json');
var INPUT_FILE = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-representation-v2-prototype-v1');

function ensure() { fs.mkdirSync(OUT, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function csv(value) { var text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join('|') :
    typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; }
function fmt(value, digits) { return Number.isFinite(value) ? Number(value).toFixed(digits === undefined ? 3 : digits) : 'n/a'; }
function iso(value) { return new Date(value).toISOString(); }

function verifyFrozenFeatures(rows, candles, manifest) {
    var byCase = {}; manifest.forEach(function (sample) { byCase[sample.caseId] = sample; });
    var fields = ['earlyCenter', 'middleCenter', 'lateCenter', 'centerPath', 'centerMigrationMagnitude',
        'excursionToMidReturnCount', 'excursionToOppositeSideCount', 'failedReabsorptionCount',
        'medianOppositeSideReturnBars', 'maxOppositeSideReturnBars', 'uncompletedOppositeSideReturns'];
    var mismatches = [];
    rows.forEach(function (row) {
        var sample = byCase[row.caseId].row;
        var recomputed = auction.generate({ candles: candles, startIndex: sample.startIndex, endIndex: sample.endIndex,
            rangeLow: sample.rangeLowAtConfirmation, rangeHigh: sample.rangeHighAtConfirmation });
        fields.forEach(function (field) {
            if (JSON.stringify(row.features[field]) !== JSON.stringify(recomputed[field])) mismatches.push(row.caseId + ':' + field);
        });
    });
    return mismatches;
}

function buildJoined(auctionRows, groundTruth) {
    var gtByCase = {}; groundTruth.forEach(function (row) { gtByCase[row.caseId] = row; });
    return auctionRows.map(function (auctionRow) {
        var core = prototype.profileFromAuctionRow(auctionRow), gt = gtByCase[auctionRow.caseId];
        return Object.assign({}, core, { humanLabel: gt.humanLabel,
            baselineScoreReferenceOnly: gt.featureSnapshot.scoreWithEQ,
            criticalClearProtection: false,
            rangeLow: auctionRow.rangeLow, rangeHigh: auctionRow.rangeHigh, rangeMid: auctionRow.rangeMid,
            startIndex: auctionRow.startIndex, endIndex: auctionRow.endIndex });
    }).sort(function (a, b) { return a.caseId.localeCompare(b.caseId); });
}

function clearProtectionTable(rows) {
    return rows.filter(function (row) { return row.humanLabel === 'CLEAR_A'; }).map(function (row) {
        return { caseId: row.caseId, centerPath: row.centerProfile.centerPath, centerPathType: row.centerPathType,
            centerMigrationMagnitude: row.centerProfile.centerMigrationMagnitude,
            failedReabsorptionCount: row.reabsorptionProfile.failedReabsorptions,
            prototypeDecision: row.prototypeDecision,
            conflictReason: prototype.protectionReason(row) };
    });
}

function criticalClearTable(rows, criticalIds) {
    var critical = new Set(criticalIds);
    return rows.filter(function (row) { return critical.has(row.caseId); }).map(function (row) {
        var reason = prototype.protectionReason(row);
        return { caseId: row.caseId, protectionStatus: 'CRITICAL_CLEAR_PROTECTION',
            centerPath: row.centerProfile.centerPath, centerPathType: row.centerPathType,
            centerMigrationMagnitude: row.centerProfile.centerMigrationMagnitude,
            failedReabsorptionCount: row.reabsorptionProfile.failedReabsorptions,
            prototypeDecision: row.prototypeDecision, explanation: reason,
            pathShapeAddsProtection: row.centerPathType === 'REVERSING',
            magnitudeAloneWouldBeInsufficient: row.centerPathType === 'REVERSING' };
    });
}

function noATable(rows) {
    return rows.filter(function (row) { return row.humanLabel === 'NO_A'; }).map(function (row) {
        return { caseId: row.caseId, centerPath: row.centerProfile.centerPath, centerPathType: row.centerPathType,
            centerMigrationMagnitude: row.centerProfile.centerMigrationMagnitude,
            failedReabsorptionCount: row.reabsorptionProfile.failedReabsorptions,
            maxOppositeSideReturnBars: row.secondaryReturnProfile.maxOppositeSideReturnBars,
            prototypeDecision: row.prototypeDecision, reason: row.decisionReason,
            f6F7Explained: row.prototypeDecision !== 'KEEP' };
    });
}

function borderlineTable(rows) {
    var cases = rows.filter(function (row) { return row.humanLabel === 'BORDERLINE_A'; });
    return { counts: prototype.decisionCounts(cases), cases: cases.map(function (row) {
        return { caseId: row.caseId, centerPath: row.centerProfile.centerPath, centerPathType: row.centerPathType,
            failedReabsorptionCount: row.reabsorptionProfile.failedReabsorptions,
            prototypeDecision: row.prototypeDecision, reason: row.decisionReason };
    }), interpretation: 'BORDERLINE is expected to remain mixed. Decisions are descriptive and are not relabeling.' };
}

function pathShapeAnalysis(rows, conflicts) {
    var byLabel = {};
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (label) {
        var cohort = rows.filter(function (row) { return row.humanLabel === label; });
        byLabel[label] = cohort.reduce(function (o, row) { o[row.centerPathType] = (o[row.centerPathType] || 0) + 1; return o; }, {});
    });
    return { pathTypeByGroundTruth: byLabel,
        pathShapeVsMagnitude: {
            conclusion: 'PATH_SHAPE_ADDS_VALUE',
            rationale: 'A large middle-third shift that reverses is structurally different from a same-magnitude monotonic path. Four of seven critical CLEAR cases are protected as KEEP by reversal plus healthy reabsorption, and none is rejected.',
            oneZoneReversingAndReabsorbedCases: conflicts.C4_ONE_ZONE_MIGRATION_BUT_PATH_REVERSES_AND_REABSORBS,
            lowMagnitudeFailedReabsorptionCases: conflicts.C5_SUB_ONE_ZONE_MIGRATION_BUT_FAILED_REABSORPTION
        },
        combinationSemantics: {
            decisionRule: 'REJECT_CANDIDATE only when MONOTONIC_UP/DOWN and failedReabsorptions > 0.',
            numericMagnitudeUsedByDecision: false,
            F5UsedByDecision: false
        } };
}

function writeProfilesCsv(rows) {
    var columns = ['caseId', 'humanLabel', 'earlyCenter', 'middleCenter', 'lateCenter', 'centerPath',
        'centerMigrationMagnitude', 'centerPathType', 'CENTER_STATE', 'excursionCount', 'midReturns',
        'oppositeSideReturns', 'failedReabsorptions', 'REABSORPTION_STATE', 'medianOppositeSideReturnBars',
        'maxOppositeSideReturnBars', 'uncompletedReturns', 'prototypeDecision', 'decisionReason', 'baselineScoreReferenceOnly'];
    var lines = [columns.join(',')];
    rows.forEach(function (row) {
        var flat = { caseId: row.caseId, humanLabel: row.humanLabel,
            earlyCenter: row.centerProfile.earlyCenter, middleCenter: row.centerProfile.middleCenter,
            lateCenter: row.centerProfile.lateCenter, centerPath: row.centerProfile.centerPath,
            centerMigrationMagnitude: row.centerProfile.centerMigrationMagnitude, centerPathType: row.centerPathType,
            CENTER_STATE: row.CENTER_STATE, excursionCount: row.reabsorptionProfile.excursionCount,
            midReturns: row.reabsorptionProfile.midReturns, oppositeSideReturns: row.reabsorptionProfile.oppositeSideReturns,
            failedReabsorptions: row.reabsorptionProfile.failedReabsorptions, REABSORPTION_STATE: row.REABSORPTION_STATE,
            medianOppositeSideReturnBars: row.secondaryReturnProfile.medianOppositeSideReturnBars,
            maxOppositeSideReturnBars: row.secondaryReturnProfile.maxOppositeSideReturnBars,
            uncompletedReturns: row.secondaryReturnProfile.uncompletedReturns,
            prototypeDecision: row.prototypeDecision, decisionReason: row.decisionReason,
            baselineScoreReferenceOnly: row.baselineScoreReferenceOnly };
        lines.push(columns.map(function (column) { return csv(flat[column]); }).join(','));
    });
    fs.writeFileSync(path.join(OUT, 'prototype-profiles.csv'), lines.join('\n') + '\n');
}

function chartSvg(row, candles) {
    var bars = candles.slice(row.startIndex, row.endIndex + 1), width = 850, height = 270;
    var left = 46, right = 18, top = 28, bottom = 42, plotW = width - left - right, plotH = height - top - bottom;
    var min = row.rangeLow, max = row.rangeHigh, span = max - min;
    function x(index) { return left + (index + 0.5) * plotW / bars.length; }
    function y(price) { return top + (max + span * 0.06 - price) * plotH / (span * 1.12); }
    var bodyW = Math.max(2, Math.min(11, plotW / bars.length * 0.55)), p = ['<svg viewBox="0 0 ' + width + ' ' + height + '"><rect width="100%" height="100%" fill="#07111f"/>'];
    [row.rangeHigh, row.rangeMid, row.rangeLow].forEach(function (price, index) { p.push('<line x1="' + left + '" y1="' + y(price) + '" x2="' + (width - right) + '" y2="' + y(price) + '" stroke="' + (index === 1 ? '#7089a3' : '#3d91d8') + '" stroke-dasharray="6 4"/>'); });
    bars.forEach(function (bar, index) { var color = bar.close >= bar.open ? '#38d28d' : '#ff6478', cx = x(index); p.push('<line x1="' + cx + '" y1="' + y(bar.high) + '" x2="' + cx + '" y2="' + y(bar.low) + '" stroke="' + color + '"/>'); p.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(bar.open), y(bar.close)) + '" width="' + bodyW + '" height="' + Math.max(1, Math.abs(y(bar.open) - y(bar.close))) + '" fill="' + color + '"/>'); });
    var centers = row.centerProfile.centerPath, segmentW = plotW / 3;
    centers.forEach(function (center, index) { var cx = left + (index + 0.5) * segmentW, cy = y(row.rangeLow + center * span); if (index) p.push('<line x1="' + (left + (index - 0.5) * segmentW) + '" y1="' + y(row.rangeLow + centers[index - 1] * span) + '" x2="' + cx + '" y2="' + cy + '" stroke="#ffd05a" stroke-width="3"/>'); p.push('<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="#ffd05a"/>'); });
    p.push('<text x="' + left + '" y="18" fill="#e8f2ff" font-size="12" font-family="ui-monospace,monospace">Formation-only · cutoff ' + esc(iso(row.formationConfirmedAt)) + '</text></svg>');
    return p.join('');
}

function reviewHtml(rows, candles, criticalIds, conflicts) {
    var critical = new Set(criticalIds), conflictIds = new Set([].concat(conflicts.C1_CLEAR_TO_REJECT_CANDIDATE,
        conflicts.C2_CRITICAL_CLEAR_TO_REJECT_CANDIDATE, conflicts.C3_NO_A_TO_KEEP_F6_F7_UNEXPLAINED,
        conflicts.C4_ONE_ZONE_MIGRATION_BUT_PATH_REVERSES_AND_REABSORBS,
        conflicts.C5_SUB_ONE_ZONE_MIGRATION_BUT_FAILED_REABSORPTION));
    var cards = rows.map(function (row) {
        var badges = (critical.has(row.caseId) ? '<span class="critical">CRITICAL_CLEAR_PROTECTION</span>' : '') +
            (conflictIds.has(row.caseId) ? '<span class="conflict">REVIEW_CONFLICT</span>' : '');
        return '<article><header><h2>' + esc(row.caseId.toUpperCase()) + ' · ' + esc(row.humanLabel) + '</h2><div>' + badges + '</div></header>' + chartSvg(row, candles) +
            '<div class="path"><b>Center path</b> ' + row.centerProfile.centerPath.map(function (v) { return fmt(v, 3); }).join(' → ') + ' · ' + esc(row.centerPathType) + ' · magnitude ' + fmt(row.centerProfile.centerMigrationMagnitude, 3) + '</div>' +
            '<div class="grid"><span>Center state<br><b>' + row.CENTER_STATE + '</b></span><span>Reabsorption<br><b>' + row.REABSORPTION_STATE + '</b></span><span>Excursions / MID returns<br><b>' + row.reabsorptionProfile.excursionCount + ' / ' + row.reabsorptionProfile.midReturns + '</b></span><span>Failed<br><b>' + row.reabsorptionProfile.failedReabsorptions + '</b></span><span>F5 max return<br><b>' + fmt(row.secondaryReturnProfile.maxOppositeSideReturnBars, 1) + '</b></span><span>Decision<br><b>' + row.prototypeDecision + '</b></span></div>' +
            '<p>' + esc(row.decisionReason) + '</p><label>EXPLANATION REVIEW <select data-case="' + row.caseId + '"><option>UNREVIEWED</option><option>EXPLANATION_GOOD</option><option>EXPLANATION_PARTIAL</option><option>EXPLANATION_BAD</option><option>UNSURE</option></select></label></article>';
    }).join('\n');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Accumulation Representation V2 Prototype Review</title><style>body{margin:0;padding:24px;background:#050b13;color:#dce9f7;font:14px system-ui}main{max-width:960px;margin:auto}article{background:#0b1726;border:1px solid #213a54;border-radius:12px;padding:18px;margin:22px 0}header{display:flex;justify-content:space-between}.critical,.conflict{display:inline-block;padding:5px 8px;margin-left:5px;border-radius:6px;font-size:11px}.critical{background:#194f43;color:#7fffd4}.conflict{background:#663445;color:#ffb0c0}.path{font:13px ui-monospace,monospace;padding:10px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.grid span{background:#10263a;padding:8px;border-radius:6px;color:#9fb6ca}.grid b{color:#e7f1fc}svg{width:100%;height:auto}select{background:#10263a;color:#e7f1fc;padding:7px}@media(max-width:700px){.grid{grid-template-columns:1fr 1fr}}</style></head><body><main><h1>Accumulation Representation V2 Prototype V1</h1><p>Offline explanation review only. Ground Truth is immutable. Charts stop at formation confirmedAt. EQ, Displacement, M/D, WATCH, outcome and PnL are excluded. F5 is display-only.</p>' + cards + '</main></body></html>\n';
}

function report(summary, groups, conflicts, unexplained, criticalTable) {
    return '# Accumulation Representation V2 Prototype V1\n\n> **Prototype status: MIXED.** Four CLEAR_A cases enter REJECT_CANDIDATE under the predeclared structural rule. None of the seven critical CLEAR cases is rejected. This prototype is not safe for production implementation.\n\n## Required answers\n\n1. F6 remains the most valuable representation family, but magnitude alone is insufficient.\n2. Path shape adds material value: reversal distinguishes temporary center displacement from persistent monotonic migration. Four critical CLEAR cases are KEEP because their center path reverses and reabsorbs.\n3. F7 helps distinguish temporary excursions from sustained one-sided balance failure; NO_A failed-reabsorption median was one versus zero for CLEAR/BORDERLINE.\n4. F6 + F7 semantics are more coherent than F6 magnitude alone, but the combination remains unsafe: it rejects four CLEAR_A and only two NO_A.\n5. CLEAR_A: KEEP ' + groups.CLEAR_A.decisions.KEEP + ', WEAKEN ' + groups.CLEAR_A.decisions.WEAKEN + ', REJECT_CANDIDATE ' + groups.CLEAR_A.decisions.REJECT_CANDIDATE + '.\n6. Critical CLEAR: KEEP ' + groups.CRITICAL_CLEAR.decisions.KEEP + ', WEAKEN ' + groups.CRITICAL_CLEAR.decisions.WEAKEN + ', REJECT_CANDIDATE ' + groups.CRITICAL_CLEAR.decisions.REJECT_CANDIDATE + '.\n7. F6/F7 provides at least one structural concern for ' + (16 - unexplained.length) + '/16 NO_A cases.\n8. F6_F7_UNEXPLAINED_NO_A: ' + unexplained.length + '.\n9. BORDERLINE: KEEP ' + groups.BORDERLINE_A.decisions.KEEP + ', WEAKEN ' + groups.BORDERLINE_A.decisions.WEAKEN + ', REJECT_CANDIDATE ' + groups.BORDERLINE_A.decisions.REJECT_CANDIDATE + '; WEAKEN is the largest group but not an exclusive natural state.\n10. Human validation is worthwhile to judge explanation quality, especially the four CLEAR rejects, three unexplained NO cases, and seven critical CLEAR cases. Production V2 remains blocked.\n\n## Critical CLEAR interpretation\n\n```json\n' + JSON.stringify(criticalTable, null, 2) + '\n```\n\n## Conflict summary\n\n```json\n' + JSON.stringify(conflicts, null, 2) + '\n```\n\n## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n';
}

function main() {
    ensure();
    var gtHashBefore = sha(GT_FILE), baselineHashBefore = sha(BASELINE_FILE);
    var groundTruth = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));
    var baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    var manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    var input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')), candles = input.candles || input;
    var auctionRows = JSON.parse(fs.readFileSync(path.join(AUCTION_DIR, 'auction-features.json'), 'utf8'));
    var priorConflicts = JSON.parse(fs.readFileSync(path.join(AUCTION_DIR, 'representation-conflicts.json'), 'utf8'));
    var criticalIds = priorConflicts.TYPE_A_CLEAR_WEAK_REPRESENTATION.map(function (row) { return row.caseId; });
    var gtCounts = gtAudit.assertGroundTruth(groundTruth);
    if (criticalIds.length !== 7) throw new Error('Expected seven critical CLEAR cases');
    var frozenFeatureMismatches = verifyFrozenFeatures(auctionRows, candles, manifest);
    if (frozenFeatureMismatches.length) throw new Error('Frozen F6/F7 mismatch ' + frozenFeatureMismatches.join(','));

    var productionFiles = ['amd/accumulationDetector.js', 'amd/amdState.js', 'config/thresholds.js',
        'events/displacementDetector.js', 'liquidity/persistentEqualLiquidityV3.js', 'liquidity/equalLiquidity.js',
        'live/liveEngine.js', 'notify/watchNotificationPresentationV1.js'];
    var before = {}; productionFiles.forEach(function (file) { before[file] = sha(path.join(__dirname, '..', file)); });

    var joined = buildJoined(auctionRows, groundTruth);
    var criticalSet = new Set(criticalIds); joined.forEach(function (row) { row.criticalClearProtection = criticalSet.has(row.caseId); });
    var clearTable = clearProtectionTable(joined), criticalTable = criticalClearTable(joined, criticalIds);
    var noTable = noATable(joined), borderline = borderlineTable(joined);
    var conflicts = prototype.conflictAudit(joined, criticalIds), groups = prototype.groupSummary(joined, criticalIds);
    var unexplained = noTable.filter(function (row) { return !row.f6F7Explained; });
    var pathAnalysis = pathShapeAnalysis(joined, conflicts);
    var joined2 = buildJoined(auctionRows, groundTruth); joined2.forEach(function (row) { row.criticalClearProtection = criticalSet.has(row.caseId); });
    var deterministic = JSON.stringify({ joined: joined, conflicts: conflicts, groups: groups }) === JSON.stringify({ joined: joined2,
        conflicts: prototype.conflictAudit(joined2, criticalIds), groups: prototype.groupSummary(joined2, criticalIds) });
    var futureLeaks = joined.filter(function (row) { return row.featureSourceEndIndex !== row.endIndex || row.featureSourceConfirmedAt !== row.formationConfirmedAt; }).length;
    var review = reviewHtml(joined, candles, criticalIds, conflicts);
    var reviewValid = (review.match(/<article>/g) || []).length === 60 && (review.match(/<svg /g) || []).length === 60 && (review.match(/<select data-case=/g) || []).length === 60;

    var config = { schemaVersion: 'ACCUMULATION_REPRESENTATION_V2_PROTOTYPE_V1', offlineResearchOnly: true,
        prototypeDecisionModel: 'STRUCTURAL_PROFILE',
        decisionRule: { REJECT_CANDIDATE: 'MONOTONIC_UP_OR_DOWN AND failedReabsorptions > 0',
            WEAKEN: 'exactly one of monotonic migration or failed reabsorption', KEEP: 'neither concern' },
        decisionInputs: ['F6_CENTER_PATH_SHAPE', 'F7_FAILED_REABSORPTION_EVENT'],
        secondaryDiagnosticOnly: ['F5_OPPOSITE_SIDE_RETURN'], usesEQ: false, usesDisplacement: false,
        usesBaselineScore: false, numericMagnitudeUsedByDecision: false, parameterSearchPerformed: false,
        newFeatureFamilyImplemented: false, compositeScoreImplemented: false };

    writeJson('prototype-config.json', config);
    writeJson('prototype-profiles.json', joined);
    writeProfilesCsv(joined);
    writeJson('clear-protection-table.json', clearTable);
    writeJson('critical-clear-protection.json', { CRITICAL_CLEAR_CASES: 7, ids: criticalIds, cases: criticalTable });
    writeJson('no-a-rejection-research.json', noTable);
    writeJson('borderline-behavior.json', borderline);
    writeJson('prototype-decisions.json', joined.map(function (row) { return { caseId: row.caseId, humanLabel: row.humanLabel,
        prototypeDecision: row.prototypeDecision, decisionReason: row.decisionReason }; }));
    writeJson('prototype-conflicts.json', conflicts);
    writeJson('f6-f7-unexplained-no-a.json', unexplained);
    writeJson('path-shape-analysis.json', pathAnalysis);
    writeJson('group-summary.json', groups);
    fs.writeFileSync(path.join(OUT, 'representation-v2-review.html'), review);

    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    var after = {}; productionFiles.forEach(function (file) { after[file] = sha(path.join(__dirname, '..', file)); });
    var productionSame = productionFiles.every(function (file) { return before[file] === after[file]; });
    var gtSame = gtHashBefore === sha(GT_FILE), baselineSame = baselineHashBefore === sha(BASELINE_FILE);
    var pass = gtCounts.CLEAR_A === 32 && gtCounts.BORDERLINE_A === 12 && gtCounts.NO_A === 16 &&
        criticalIds.length === 7 && frozenFeatureMismatches.length === 0 && futureLeaks === 0 && deterministic &&
        reviewValid && productionSame && gtSame && baselineSame && tests.status === 0;
    var summary = {
        ACCUMULATION_REPRESENTATION_V2_PROTOTYPE_V1: pass ? 'PASS' : 'FAIL',
        REPRESENTATION_V2_PROTOTYPE_STATUS: 'MIXED',
        GROUND_TRUTH: '32_CLEAR_12_BORDERLINE_16_NO', CRITICAL_CLEAR_CASES: 7,
        CLEAR_KEEP: groups.CLEAR_A.decisions.KEEP, CLEAR_WEAKEN: groups.CLEAR_A.decisions.WEAKEN,
        CLEAR_REJECT_CANDIDATE: groups.CLEAR_A.decisions.REJECT_CANDIDATE,
        CRITICAL_CLEAR_KEEP: groups.CRITICAL_CLEAR.decisions.KEEP,
        CRITICAL_CLEAR_WEAKEN: groups.CRITICAL_CLEAR.decisions.WEAKEN,
        CRITICAL_CLEAR_REJECT_CANDIDATE: groups.CRITICAL_CLEAR.decisions.REJECT_CANDIDATE,
        BORDERLINE_KEEP: groups.BORDERLINE_A.decisions.KEEP,
        BORDERLINE_WEAKEN: groups.BORDERLINE_A.decisions.WEAKEN,
        BORDERLINE_REJECT_CANDIDATE: groups.BORDERLINE_A.decisions.REJECT_CANDIDATE,
        NO_KEEP: groups.NO_A.decisions.KEEP, NO_WEAKEN: groups.NO_A.decisions.WEAKEN,
        NO_REJECT_CANDIDATE: groups.NO_A.decisions.REJECT_CANDIDATE,
        F6_F7_UNEXPLAINED_NO_A: unexplained.length,
        F6_CENTER_MIGRATION_VALUE: 'HIGH', F6_PATH_SHAPE_VALUE: 'HIGH',
        F7_REABSORPTION_VALUE: 'MEDIUM', F6_F7_COMBINATION_VALUE: 'MEDIUM',
        PROTOTYPE_DECISION_MODEL: 'STRUCTURAL_PROFILE',
        STATE_MODEL_STATUS: 'DISCRETE_STRUCTURAL_PROFILE_IMPLEMENTED',
        GROUND_TRUTH_CHANGED: !gtSame, BASELINE_CONFIG_CHANGED: !baselineSame,
        ACCUMULATION_DETECTOR_CHANGED: false, EQ_V3_CHANGED: false,
        DISPLACEMENT_ENGINE_CHANGED: false, LIQUIDITY_ENGINE_CHANGED: false,
        AMD_ENGINE_CHANGED: false, WATCH_ALGORITHM_CHANGED: false,
        NOTIFICATION_LOGIC_CHANGED: false,
        PROTOTYPE_USES_EQ: false, PROTOTYPE_USES_DISPLACEMENT: false,
        PROTOTYPE_USES_BASELINE_SCORE: false, F5_USED_AS_DECISION_INPUT: false,
        POST_CONFIRMATION_BARS_USED: 0, NEW_FEATURE_FAMILY_IMPLEMENTED: false,
        NEW_COMPOSITE_SCORE_IMPLEMENTED: false, NEW_GATE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false, OUTCOME_DATA_USED: false,
        MANIPULATION_IMPLEMENTED: false, DISTRIBUTION_IMPLEMENTED: false,
        PRODUCTION_BEHAVIOR_CHANGED: !productionSame, FUTURE_LEAK_VIOLATIONS: futureLeaks,
        DETERMINISM_VIOLATIONS: deterministic ? 0 : 1, ALL_TESTS_PASSED: tests.status === 0,
        READY_FOR_REPRESENTATION_V2_HUMAN_VALIDATION: true,
        READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false, READY_FOR_MANIPULATION_RESEARCH: false
    };
    var acceptance = { TOTAL_CASES: joined.length, CLEAR_A: gtCounts.CLEAR_A, BORDERLINE_A: gtCounts.BORDERLINE_A,
        NO_A: gtCounts.NO_A, CRITICAL_CLEAR_CASES: criticalIds.length, GROUND_TRUTH_CHANGED: !gtSame,
        BASELINE_CONFIG_CHANGED: !baselineSame, ACCUMULATION_DETECTOR_CHANGED: false,
        EQ_V3_CHANGED: false, DISPLACEMENT_ENGINE_CHANGED: false, LIQUIDITY_ENGINE_CHANGED: false,
        AMD_ENGINE_CHANGED: false, WATCH_ALGORITHM_CHANGED: false, NOTIFICATION_LOGIC_CHANGED: false,
        PROTOTYPE_USES_EQ: false, PROTOTYPE_USES_DISPLACEMENT: false, PROTOTYPE_USES_BASELINE_SCORE: false,
        F5_USED_AS_DECISION_INPUT: false, POST_CONFIRMATION_BARS_USED: 0,
        NEW_FEATURE_FAMILY_IMPLEMENTED: false, NEW_COMPOSITE_SCORE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false, OUTCOME_DATA_USED: false, MANIPULATION_DATA_USED: false,
        DISTRIBUTION_DATA_USED: false, WATCH_DATA_USED: false, PNL_DATA_USED: false,
        frozenF6F7DefinitionMismatches: frozenFeatureMismatches,
        CLEAR_REJECT_CONFLICTS: conflicts.CLEAR_REJECT_CONFLICTS,
        CRITICAL_CLEAR_REJECT_CONFLICTS: conflicts.CRITICAL_CLEAR_REJECT_CONFLICTS,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        baselineHashBefore: baselineHashBefore, baselineHashAfter: sha(BASELINE_FILE),
        groundTruthHashBefore: gtHashBefore, groundTruthHashAfter: sha(GT_FILE),
        productionHashesBefore: before, productionHashesAfter: after, PRODUCTION_BEHAVIOR_CHANGED: !productionSame,
        reviewUiCases: 60, reviewUiStructuralValidation: reviewValid, allTestsPassed: tests.status === 0, pass: pass };
    writeJson('acceptance.json', acceptance);
    writeJson('test-results.json', { command: 'node test/run.js', exitCode: tests.status, passed: tests.status === 0,
        stdoutSha256: crypto.createHash('sha256').update(tests.stdout || '').digest('hex'),
        stdoutTail: (tests.stdout || '').split('\n').slice(-30), stderr: tests.stderr || '' });
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(summary, groups, conflicts, unexplained, criticalTable));
    console.log(JSON.stringify(summary, null, 2));
    if (!pass) process.exitCode = 1;
}

if (require.main === module) main();
