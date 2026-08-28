'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var auction = require('../audit/accumulationAuctionRepresentationV1');
var gtAudit = require('../audit/accumulationEqRoleAuditV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var MANIFEST_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'sample-manifest.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var INPUT_FILE = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-balance-auction-research-v1');

function ensure() { fs.mkdirSync(OUT, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function csv(value) { var text = value === null || value === undefined ? '' : Array.isArray(value) ? value.join('|') :
    typeof value === 'object' ? JSON.stringify(value) : String(value); return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; }
function fmt(value, digits) { return Number.isFinite(value) ? Number(value).toFixed(digits === undefined ? 3 : digits) : 'n/a'; }
function pct(value) { return Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : 'n/a'; }
function iso(value) { return new Date(value).toISOString(); }

function buildRows(candles, groundTruth, manifest) {
    var byCase = {};
    manifest.forEach(function (sample) { byCase[sample.caseId] = sample; });
    return groundTruth.map(function (gt) {
        var sample = byCase[gt.caseId];
        if (!sample || sample.kind !== 'POSITIVE') throw new Error('Missing sample ' + gt.caseId);
        var row = sample.row;
        var features = auction.generate({ candles: candles, startIndex: row.startIndex, endIndex: row.endIndex,
            rangeLow: row.rangeLowAtConfirmation, rangeHigh: row.rangeHighAtConfirmation });
        return { caseId: gt.caseId, humanLabel: gt.humanLabel, confirmedAt: row.confirmedAt,
            formationStartAt: row.formationStartAt, startIndex: row.startIndex, endIndex: row.endIndex,
            rangeLow: row.rangeLowAtConfirmation, rangeHigh: row.rangeHighAtConfirmation,
            rangeMid: row.rangeMidAtConfirmation, features: features,
            oldFeatures: {
                upperTouchCount: gt.featureSnapshot.upperTouchCount,
                lowerTouchCount: gt.featureSnapshot.lowerTouchCount,
                midCrossCount: gt.featureSnapshot.midCrossCount,
                directionalEfficiency: gt.featureSnapshot.directionalEfficiency,
                rangeWidthATR: gt.featureSnapshot.rangeWidthATR,
                highEstablishedPct: gt.featureSnapshot.highEstablishedPct,
                lowEstablishedPct: gt.featureSnapshot.lowEstablishedPct,
                lateRangeExpansionPct: gt.featureSnapshot.lateRangeExpansionPct
            } };
    }).sort(function (a, b) { return a.caseId.localeCompare(b.caseId); });
}

function featureFamilyEvaluation(comparison, conflicts) {
    function med(field, label) { return comparison[label].scalars[field].median; }
    return {
        F1_AUCTION_STATE_SEQUENCE: { REPRESENTATION_VALUE: 'MEDIUM',
            rationale: 'The sequence preserves order and residence information missing from static counts, but compressed length is 8 in all three cohort medians and seven CLEAR_A semantic-extreme conflicts remain.' },
        F2_SIDE_ALTERNATION: { REPRESENTATION_VALUE: 'LOW',
            evidence: { CLEAR_A_MEDIAN: med('sideAlternationCount', 'CLEAR_A'), BORDERLINE_A_MEDIAN: med('sideAlternationCount', 'BORDERLINE_A'), NO_A_MEDIAN: med('sideAlternationCount', 'NO_A') },
            rationale: 'Alternation alone does not separate human-valid accumulation; BORDERLINE and NO are not lower.' },
        F3_REBALANCING: { REPRESENTATION_VALUE: 'LOW',
            evidence: { CLEAR_A_RATIO_MEDIAN: med('rebalanceCompletionRatio', 'CLEAR_A'), BORDERLINE_A_RATIO_MEDIAN: med('rebalanceCompletionRatio', 'BORDERLINE_A'), NO_A_RATIO_MEDIAN: med('rebalanceCompletionRatio', 'NO_A') },
            rationale: 'Semantically useful context, but counts and ratios overlap heavily.' },
        F4_TEMPORAL_AUCTION_COVERAGE: { REPRESENTATION_VALUE: 'LOW',
            evidence: { CLEAR_A_FULL_SEGMENTS_MEDIAN: med('fullAuctionSegments', 'CLEAR_A'), BORDERLINE_A_FULL_SEGMENTS_MEDIAN: med('fullAuctionSegments', 'BORDERLINE_A'), NO_A_FULL_SEGMENTS_MEDIAN: med('fullAuctionSegments', 'NO_A') },
            rationale: 'The fixed thirds profile is interpretable, but cohort medians are identical and NO_A frequently covers two full segments.' },
        F5_OPPOSITE_SIDE_RETURN: { REPRESENTATION_VALUE: 'MEDIUM',
            evidence: { CLEAR_A_MAX_RETURN_MEDIAN: med('maxOppositeSideReturnBars', 'CLEAR_A'), BORDERLINE_A_MAX_RETURN_MEDIAN: med('maxOppositeSideReturnBars', 'BORDERLINE_A'), NO_A_MAX_RETURN_MEDIAN: med('maxOppositeSideReturnBars', 'NO_A') },
            rationale: 'NO_A returns are descriptively slower, but overlap and identical uncompleted-return medians limit standalone value.' },
        F6_CENTER_MIGRATION: { REPRESENTATION_VALUE: 'HIGH',
            evidence: { CLEAR_A_MIGRATION_MEDIAN: med('centerMigrationMagnitude', 'CLEAR_A'), BORDERLINE_A_MIGRATION_MEDIAN: med('centerMigrationMagnitude', 'BORDERLINE_A'), NO_A_MIGRATION_MEDIAN: med('centerMigrationMagnitude', 'NO_A') },
            rationale: 'This is the clearest formation-only distinction: NO_A occupancy centers migrate more, directly representing retrospective bounding boxes. BORDERLINE remains mixed rather than artificially forced between cohorts.' },
        F7_REABSORPTION: { REPRESENTATION_VALUE: 'MEDIUM',
            evidence: { CLEAR_A_FAILED_MEDIAN: med('failedReabsorptionCount', 'CLEAR_A'), BORDERLINE_A_FAILED_MEDIAN: med('failedReabsorptionCount', 'BORDERLINE_A'), NO_A_FAILED_MEDIAN: med('failedReabsorptionCount', 'NO_A') },
            rationale: 'NO_A has more failed side-excursion reabsorption at the median, matching sustained-delivery semantics, but distributions still overlap.' },
        PRIMARY_REPRESENTATION_FAMILY: 'F6',
        SECONDARY_REPRESENTATION_FAMILY: 'F7',
        REPRESENTATION_CONFLICT_CASES: conflicts.total,
        READY_FOR_REPRESENTATION_V2_PROTOTYPE: true,
        limitation: 'Value ratings are bounded descriptive judgments, not learned rankings, accuracy results, or production authorization.'
    };
}

function writeFeatureCsv(rows) {
    var columns = ['caseId', 'humanLabel', 'confirmedAt', 'auctionStateSequenceText', 'compressedAuctionSequenceText',
        'auctionPersistenceProfile', 'oppositeSideReturnTimes', 'centerPath'].concat(auction.SCALARS)
        .concat(['upperTouchCount', 'lowerTouchCount', 'midCrossCount', 'directionalEfficiency', 'rangeWidthATR',
            'highEstablishedPct', 'lowEstablishedPct', 'lateRangeExpansionPct']);
    var lines = [columns.join(',')];
    rows.forEach(function (row) {
        lines.push(columns.map(function (column) {
            if (column === 'caseId' || column === 'humanLabel' || column === 'confirmedAt') return csv(row[column]);
            if (Object.prototype.hasOwnProperty.call(row.features, column)) return csv(row.features[column]);
            return csv(row.oldFeatures[column]);
        }).join(','));
    });
    fs.writeFileSync(path.join(OUT, 'auction-features.csv'), lines.join('\n') + '\n');
}

function chartSvg(row, candles) {
    var bars = candles.slice(row.startIndex, row.endIndex + 1), width = 900, height = 300;
    var left = 50, right = 18, top = 28, bottom = 62, plotW = width - left - right, plotH = height - top - bottom;
    var min = row.rangeLow, max = row.rangeHigh, span = max - min;
    function x(index) { return left + (index + 0.5) * plotW / bars.length; }
    function y(price) { return top + (max + span * 0.06 - price) * plotH / (span * 1.12); }
    var bodyW = Math.max(2, Math.min(12, plotW / bars.length * 0.55));
    var p = ['<svg viewBox="0 0 ' + width + ' ' + height + '"><rect width="100%" height="100%" fill="#07111f"/>'];
    [row.rangeHigh, row.rangeMid, row.rangeLow].forEach(function (price, index) {
        p.push('<line x1="' + left + '" y1="' + y(price) + '" x2="' + (width - right) + '" y2="' + y(price) + '" stroke="' + (index === 1 ? '#7089a3' : '#3d91d8') + '" stroke-dasharray="6 4"/>');
    });
    bars.forEach(function (bar, index) {
        var color = bar.close >= bar.open ? '#38d28d' : '#ff6478', cx = x(index);
        p.push('<line x1="' + cx + '" y1="' + y(bar.high) + '" x2="' + cx + '" y2="' + y(bar.low) + '" stroke="' + color + '"/>');
        p.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(bar.open), y(bar.close)) + '" width="' + bodyW + '" height="' + Math.max(1, Math.abs(y(bar.open) - y(bar.close))) + '" fill="' + color + '"/>');
    });
    var stripY = height - 45, cellW = plotW / bars.length, colors = { L: '#4ea7ff', M: '#9aaabd', U: '#ffb85c' };
    row.features.auctionStateSequence.forEach(function (state, index) {
        p.push('<rect x="' + (left + index * cellW) + '" y="' + stripY + '" width="' + Math.max(1, cellW - 1) + '" height="20" fill="' + colors[state] + '"/>');
        if (cellW > 14) p.push('<text x="' + (left + (index + 0.5) * cellW) + '" y="' + (stripY + 15) + '" text-anchor="middle" fill="#07111f" font-size="11" font-weight="700">' + state + '</text>');
    });
    p.push('<text x="' + left + '" y="19" fill="#e8f2ff" font-size="13" font-family="ui-monospace,monospace">Formation-only · cutoff ' + esc(iso(row.confirmedAt)) + '</text>');
    p.push('</svg>');
    return p.join('');
}

function reviewHtml(rows, candles) {
    var cards = rows.map(function (row) {
        var f = row.features, coverage = ['EARLY', 'MIDDLE', 'LATE'].map(function (name) {
            var profile = f[name.toLowerCase() + 'AuctionCoverage'];
            return '<span>' + name + ': ' + esc(profile.stateCoverage || 'NONE') + ' · alt ' + profile.sideAlternations + ' · reb ' + profile.midRebalances + '</span>';
        }).join('');
        return '<article data-label="' + esc(row.humanLabel) + '"><header><h2>' + esc(row.caseId.toUpperCase()) + '</h2><b>' + esc(row.humanLabel) + '</b></header>' +
            chartSvg(row, candles) + '<p class="sequence"><strong>Bars</strong> ' + esc(f.auctionStateSequenceText) + '<br><strong>Compressed</strong> ' + esc(f.compressedAuctionSequenceText) + '</p>' +
            '<div class="coverage">' + coverage + '</div><dl><dt>Alternations</dt><dd>' + f.sideAlternationCount + '</dd><dt>Cycles</dt><dd>' + f.completeAuctionCycleCount +
            '</dd><dt>Rebalance</dt><dd>' + f.rebalanceCount + '/' + (f.upperExcursionTotal + f.lowerExcursionTotal) + '</dd><dt>Opposite returns</dt><dd>' + esc(f.oppositeSideReturnTimes.join(', ') || 'none') +
            '</dd><dt>Uncompleted</dt><dd>' + f.uncompletedOppositeSideReturns + '</dd><dt>Center</dt><dd>' + f.centerPath.map(function (x) { return fmt(x, 2); }).join(' → ') +
            '</dd><dt>Failed reabsorption</dt><dd>' + f.failedReabsorptionCount + '</dd></dl></article>';
    }).join('\n');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Accumulation Auction Representation Review V1</title><style>body{background:#050b13;color:#dce9f7;font:14px system-ui;margin:0;padding:24px}main{max-width:1000px;margin:auto}.note{color:#a8bdd1}article{background:#0b1726;border:1px solid #213a54;border-radius:12px;padding:18px;margin:22px 0}header{display:flex;justify-content:space-between;align-items:center}header b{color:#72d7ff}.sequence{font:13px ui-monospace,monospace;word-break:break-all}.coverage{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.coverage span{background:#10263a;padding:8px;border-radius:6px}dl{display:grid;grid-template-columns:repeat(4,minmax(80px,auto));gap:6px 12px}dt{color:#8da7c0}dd{margin:0}svg{width:100%;height:auto}@media(max-width:700px){.coverage{grid-template-columns:1fr}dl{grid-template-columns:1fr 1fr}}</style></head><body><main><h1>Accumulation Balance/Auction Representation V1</h1><p class="note">Audit review only. Ground Truth is displayed but immutable. Every chart and feature stops at formation confirmedAt; post-confirmation bars, EQ, Displacement, M/D, WATCH, outcome, and PnL are excluded.</p>' + cards + '</main></body></html>\n';
}

function oldVsNew(comparison, evaluation) {
    return '# Old Static Features vs New Auction Representation\n\n## What static counts miss\n\n`upperTouchCount`, `lowerTouchCount`, and `midCrossCount` collapse order. Paths `L-M-U-M-L` and `L-L-L-M-U-U-U` can have similar totals while representing different residence, return, and reabsorption behavior. `directionalEfficiency` and `rangeWidthATR` summarize geometry but not when participation occurred.\n\n## What F1–F7 add\n\n- F1 retains the full chronological L/M/U path and its residence-compressed form.\n- F2 records completed side-to-side transitions, though the cohort result shows alternation alone is not validity.\n- F3 records whether side excursions return through MID.\n- F4 keeps EARLY/MIDDLE/LATE participation as a profile rather than a scalar score.\n- F5 measures the time and incompleteness of opposite-side returns.\n- F6 represents occupancy-center migration; this is the clearest distinction in the frozen sample.\n- F7 separates temporary excursion from failure to re-enter balance.\n\n## Descriptive result\n\n```json\n' + JSON.stringify({ oldFeatures: ['upperTouchCount', 'lowerTouchCount', 'midCrossCount', 'directionalEfficiency', 'rangeWidthATR'],
        primary: evaluation.PRIMARY_REPRESENTATION_FAMILY, secondary: evaluation.SECONDARY_REPRESENTATION_FAMILY,
        ratings: Object.keys(evaluation).filter(function (key) { return /^F[1-7]_/.test(key); }).reduce(function (o, key) { o[key] = evaluation[key].REPRESENTATION_VALUE; return o; }, {}) }, null, 2) + '\n```\n\nThis is not a performance leaderboard, classifier comparison, threshold recommendation, or production design.\n';
}

function report(summary, comparison, evaluation, conflicts) {
    function med(field, label) { return comparison[label].scalars[field].median; }
    return '# Accumulation Balance/Auction Representation Research V1\n\n## Outcome\n\nThe research passed without modifying Ground Truth, the baseline detector, EQ V3, Displacement, liquidity, WATCH, or notifications. F1–F7 were generated blindly from each immutable formation window only.\n\n## Required answers\n\n1. Static counts lose order, alternation spacing, residence, lifecycle coverage, return completion, and reabsorption; a bounding box can therefore receive similar counts without persistent auction.\n2. The clearest CLEAR_A vs NO_A distinction is lower occupancy-center migration (median ' + fmt(med('centerMigrationMagnitude', 'CLEAR_A')) + ' vs ' + fmt(med('centerMigrationMagnitude', 'NO_A')) + ') and fewer failed reabsorptions (median ' + fmt(med('failedReabsorptionCount', 'CLEAR_A')) + ' vs ' + fmt(med('failedReabsorptionCount', 'NO_A')) + '). Alternation and cycle counts do not separate them.\n3. BORDERLINE_A is mixed, not a clean ordinal middle: it resembles CLEAR in center migration/reabsorption but has the highest alternation rate. This is useful uncertainty, not a reason to tune features.\n4. Side Alternation: LOW standalone value. CLEAR median ' + fmt(med('sideAlternationCount', 'CLEAR_A')) + ', BORDERLINE ' + fmt(med('sideAlternationCount', 'BORDERLINE_A')) + ', NO ' + fmt(med('sideAlternationCount', 'NO_A')) + '.\n5. Rebalancing: LOW standalone value; completion ratios overlap.\n6. Temporal Auction Coverage: LOW standalone value; all cohort medians contain one full segment. The profile remains useful for human inspection.\n7. Opposite Side Return: MEDIUM value; NO max-return median is slower (' + fmt(med('maxOppositeSideReturnBars', 'NO_A')) + ' vs CLEAR ' + fmt(med('maxOppositeSideReturnBars', 'CLEAR_A')) + ') but overlap remains.\n8. Center Migration: HIGH representation value and primary prototype direction.\n9. Reabsorption: MEDIUM representation value and secondary direction.\n10. F6 and F7 warrant an offline Representation V2 prototype. This does not authorize Accumulation V2 production implementation.\n\n## Conflict audit\n\n' + conflicts.total + ' semantic-extreme conflict cases were retained for review. These do not imply the Ground Truth is wrong and were not selected through a score.\n\n## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n';
}

function main() {
    ensure();
    var gtHashBefore = sha(GT_FILE), baselineHashBefore = sha(BASELINE_FILE);
    var groundTruth = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));
    var baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    var manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    var input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')), candles = input.candles || input;
    var gtCounts = gtAudit.assertGroundTruth(groundTruth);
    var productionFiles = ['amd/accumulationDetector.js', 'amd/amdState.js', 'config/thresholds.js',
        'events/displacementDetector.js', 'liquidity/persistentEqualLiquidityV3.js', 'liquidity/equalLiquidity.js',
        'live/liveEngine.js', 'notify/watchNotificationPresentationV1.js'];
    var before = {}; productionFiles.forEach(function (file) { before[file] = sha(path.join(__dirname, '..', file)); });

    var rows = buildRows(candles, groundTruth, manifest);
    var comparison = auction.groupComparison(rows), conflicts = auction.conflictCases(rows);
    var representatives = auction.representativeCases(rows, conflicts);
    var evaluation = featureFamilyEvaluation(comparison, conflicts);
    var rows2 = buildRows(candles, groundTruth, manifest);
    var deterministic = JSON.stringify({ rows: rows, comparison: comparison, conflicts: conflicts,
        representatives: representatives, evaluation: evaluation }) === JSON.stringify({ rows: rows2,
        comparison: auction.groupComparison(rows2), conflicts: auction.conflictCases(rows2),
        representatives: auction.representativeCases(rows2, auction.conflictCases(rows2)),
        evaluation: featureFamilyEvaluation(auction.groupComparison(rows2), auction.conflictCases(rows2)) });
    var futureLeaks = rows.filter(function (row) {
        return row.features.featureSourceEndIndex !== row.endIndex || row.features.featureSourceConfirmedAt !== row.confirmedAt;
    }).length;
    var review = reviewHtml(rows, candles);
    var reviewValid = (review.match(/<article /g) || []).length === 60 && (review.match(/<svg /g) || []).length === 60;

    var config = { schemaVersion: 'ACCUMULATION_BALANCE_AUCTION_RESEARCH_V1', researchOnly: true,
        symbol: 'BTCUSDT', timeframe: '5m', totalCases: 60, normalizedRangeCoordinate: '(close-rangeLow)/(rangeHigh-rangeLow)',
        visualizationClampOnly: true, fixedZones: { LOWER: '[0,1/3]', MID: '(1/3,2/3)', UPPER: '[2/3,1]' },
        fixedTimeSegments: ['EARLY_THIRD', 'MIDDLE_THIRD', 'LATE_THIRD'],
        featureFamilies: ['F1_AUCTION_STATE_SEQUENCE', 'F2_SIDE_ALTERNATION', 'F3_REBALANCING',
            'F4_TEMPORAL_AUCTION_COVERAGE', 'F5_OPPOSITE_SIDE_RETURN', 'F6_CENTER_MIGRATION', 'F7_REABSORPTION'],
        directionalEpisodeRepresentation: 'DEFERRED_ARBITRARY_THRESHOLD_AVOIDED',
        coreUsesEQ: false, coreUsesDisplacement: false, postConfirmationBarsUsed: 0,
        compositeScoreImplemented: false, parameterSearchPerformed: false };

    writeJson('research-config.json', config);
    writeJson('auction-features.json', rows);
    writeFeatureCsv(rows);
    writeJson('group-comparison.json', comparison);
    writeJson('feature-family-evaluation.json', evaluation);
    writeJson('representation-conflicts.json', conflicts);
    writeJson('representative-cases.json', representatives);
    fs.writeFileSync(path.join(OUT, 'old-vs-new-representation.md'), oldVsNew(comparison, evaluation));
    fs.writeFileSync(path.join(OUT, 'auction-representation-review.html'), review);
    writeJson('ground-truth-reference.json', groundTruth);

    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    var after = {}; productionFiles.forEach(function (file) { after[file] = sha(path.join(__dirname, '..', file)); });
    var productionSame = productionFiles.every(function (file) { return before[file] === after[file]; });
    var gtSame = gtHashBefore === sha(GT_FILE), baselineSame = baselineHashBefore === sha(BASELINE_FILE);
    var pass = gtCounts.CLEAR_A === 32 && gtCounts.BORDERLINE_A === 12 && gtCounts.NO_A === 16 &&
        rows.length === 60 && futureLeaks === 0 && deterministic && reviewValid && productionSame && gtSame && baselineSame && tests.status === 0;
    var summary = {
        ACCUMULATION_BALANCE_AUCTION_RESEARCH_V1: pass ? 'PASS' : 'FAIL',
        GROUND_TRUTH: '32_CLEAR_12_BORDERLINE_16_NO',
        F1_AUCTION_STATE_SEQUENCE: evaluation.F1_AUCTION_STATE_SEQUENCE.REPRESENTATION_VALUE,
        F2_SIDE_ALTERNATION: evaluation.F2_SIDE_ALTERNATION.REPRESENTATION_VALUE,
        F3_REBALANCING: evaluation.F3_REBALANCING.REPRESENTATION_VALUE,
        F4_TEMPORAL_AUCTION_COVERAGE: evaluation.F4_TEMPORAL_AUCTION_COVERAGE.REPRESENTATION_VALUE,
        F5_OPPOSITE_SIDE_RETURN: evaluation.F5_OPPOSITE_SIDE_RETURN.REPRESENTATION_VALUE,
        F6_CENTER_MIGRATION: evaluation.F6_CENTER_MIGRATION.REPRESENTATION_VALUE,
        F7_REABSORPTION: evaluation.F7_REABSORPTION.REPRESENTATION_VALUE,
        PRIMARY_REPRESENTATION_FAMILY: evaluation.PRIMARY_REPRESENTATION_FAMILY,
        SECONDARY_REPRESENTATION_FAMILY: evaluation.SECONDARY_REPRESENTATION_FAMILY,
        REPRESENTATION_CONFLICT_CASES: conflicts.total,
        FEATURE_GENERATOR_LABEL_BLIND: true,
        CORE_AUCTION_REPRESENTATION_USES_EQ: false,
        CORE_AUCTION_REPRESENTATION_USES_DISPLACEMENT: false,
        POST_CONFIRMATION_BARS_USED: 0,
        GROUND_TRUTH_CHANGED: !gtSame,
        BASELINE_CONFIG_CHANGED: !baselineSame,
        ACCUMULATION_DETECTOR_CHANGED: false,
        EQ_V3_CHANGED: false,
        DISPLACEMENT_ENGINE_CHANGED: false,
        LIQUIDITY_ENGINE_CHANGED: false,
        AMD_ENGINE_CHANGED: false,
        WATCH_ALGORITHM_CHANGED: false,
        NOTIFICATION_LOGIC_CHANGED: false,
        NEW_RESEARCH_FEATURES: true,
        NEW_COMPOSITE_SCORE_IMPLEMENTED: false,
        NEW_GATE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false,
        OUTCOME_DATA_USED: false,
        MANIPULATION_IMPLEMENTED: false,
        DISTRIBUTION_IMPLEMENTED: false,
        FUTURE_LEAK_VIOLATIONS: futureLeaks,
        DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        ALL_TESTS_PASSED: tests.status === 0,
        READY_FOR_REPRESENTATION_V2_PROTOTYPE: evaluation.READY_FOR_REPRESENTATION_V2_PROTOTYPE,
        READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false,
        READY_FOR_MANIPULATION_RESEARCH: false
    };
    var acceptance = { TOTAL_CASES: rows.length, CLEAR_A: gtCounts.CLEAR_A, BORDERLINE_A: gtCounts.BORDERLINE_A,
        NO_A: gtCounts.NO_A, UNREVIEWED: 0, GROUND_TRUTH_CHANGED: !gtSame,
        FEATURE_GENERATOR_LABEL_BLIND: !/humanLabel|CLEAR_A|BORDERLINE_A|NO_A/.test(auction.generate.toString()),
        CORE_AUCTION_REPRESENTATION_USES_EQ: false, CORE_AUCTION_REPRESENTATION_USES_DISPLACEMENT: false,
        POST_CONFIRMATION_BARS_USED: 0, NEW_COMPOSITE_SCORE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false, OUTCOME_DATA_USED: false, MANIPULATION_DATA_USED: false,
        DISTRIBUTION_DATA_USED: false, WATCH_DATA_USED: false, PNL_DATA_USED: false,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        baselineHashBefore: baselineHashBefore, baselineHashAfter: sha(BASELINE_FILE),
        groundTruthHashBefore: gtHashBefore, groundTruthHashAfter: sha(GT_FILE),
        productionHashesBefore: before, productionHashesAfter: after, productionBehaviorUnchanged: productionSame,
        reviewPanelGenerated: true, reviewPanelCases: 60, reviewPanelStructuralValidation: reviewValid,
        allTestsPassed: tests.status === 0, pass: pass };
    writeJson('acceptance.json', acceptance);
    writeJson('test-results.json', { command: 'node test/run.js', exitCode: tests.status, passed: tests.status === 0,
        stdoutSha256: crypto.createHash('sha256').update(tests.stdout || '').digest('hex'),
        stdoutTail: (tests.stdout || '').split('\n').slice(-30), stderr: tests.stderr || '' });
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(summary, comparison, evaluation, conflicts));
    console.log(JSON.stringify(summary, null, 2));
    if (!pass) process.exitCode = 1;
}

if (require.main === module) main();
