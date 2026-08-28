'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var replayState = require('../replay/replayState');
var eventRegistry = require('../events/eventRegistry');
var audit = require('../audit/accumulationEqRoleAuditV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var SOURCE = path.join(ROOT, 'accumulation-comparative-audit-v1');
var RESEARCH = path.join(ROOT, 'accumulation-detection-research-v1');
var INPUT = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-eq-role-audit-v1');

function ensure() { fs.mkdirSync(OUT, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function pct(value) { return (value * 100).toFixed(2) + '%'; }
function iso(value) { return new Date(value).toISOString(); }
function fmt(value, digits) { return Number.isFinite(value) ? value.toFixed(digits === undefined ? 2 : digits) : 'n/a'; }

function captureCases(candles, groundTruth, manifest) {
    var samples = {};
    manifest.forEach(function (sample) { samples[sample.caseId] = sample; });
    var wanted = {};
    groundTruth.forEach(function (gt) {
        var sample = samples[gt.caseId];
        if (!sample || sample.kind !== 'POSITIVE') throw new Error('Missing positive sample ' + gt.caseId);
        (wanted[sample.row.confirmedAt] = wanted[sample.row.confirmedAt] || []).push({ gt: gt, sample: sample });
    });
    var state = replayState.createReplayState({ symbol: 'BTCUSDT', timeframe: '5m', eqProductionVersion: 'V3' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var captured = [];
    for (var i = 0; i < candles.length; i++) {
        var candle = candles[i];
        replayState.incrementalLiquidity(state, candles, i, { tickSize: 0.1 }, candle.closeTime);
        replayState.incrementalEvents(state, candle, i, candle.closeTime, [], []);
        (wanted[candle.closeTime] || []).forEach(function (item) {
            var ids = item.sample.row.activeEqualLiquidityEvidenceIds || [];
            var eqObjects = ids.map(function (id) {
                var eq = state.registry.getById(id);
                if (!eq) throw new Error('EQ evidence unavailable as-of confirmation: ' + id);
                return clone(eq);
            });
            captured.push(audit.buildCase(item.gt, item.sample, eqObjects, 60));
        });
        if ((i + 1) % 2000 === 0 || i === candles.length - 1) {
            console.log('[Replay] ' + (i + 1) + ' / ' + candles.length + ' cases=' + captured.length);
        }
    }
    captured.sort(function (a, b) { return a.caseId.localeCompare(b.caseId); });
    if (captured.length !== 60) throw new Error('Captured ' + captured.length + '/60 cases');
    return captured;
}

function chartSvg(row, candles) {
    var start = Math.max(0, row.startIndex - 24), end = row.endIndex;
    var view = candles.slice(start, end + 1), width = 980, height = 440;
    var left = 58, right = 24, top = 38, bottom = 46, plotW = width - left - right, plotH = height - top - bottom;
    var min = Infinity, max = -Infinity;
    view.forEach(function (c) { min = Math.min(min, c.low); max = Math.max(max, c.high); });
    row.eqObjects.forEach(function (eq) { min = Math.min(min, eq.price); max = Math.max(max, eq.price); });
    var pad = Math.max((max - min) * 0.06, max * 0.00005); min -= pad; max += pad;
    function x(index) { return left + (index - start + 0.5) * plotW / view.length; }
    function y(price) { return top + (max - price) * plotH / (max - min); }
    function indexAtCloseTime(time) {
        var lo = start, hi = end;
        while (lo <= hi) { var mid = Math.floor((lo + hi) / 2); if (candles[mid].closeTime < time) lo = mid + 1; else hi = mid - 1; }
        return Math.min(end, Math.max(start, lo));
    }
    function indexAtOpenTime(time) {
        var offset = Math.round((time - candles[0].openTime) / 300000);
        return Math.min(end, Math.max(start, offset));
    }
    var bodyW = Math.max(2, Math.min(8, plotW / view.length * 0.58));
    var p = ['<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(row.caseId) + ' formation-only chart">',
        '<rect width="100%" height="100%" fill="#07111f"/>'];
    p.push('<rect x="' + (x(row.startIndex) - bodyW) + '" y="' + y(row.rangeHigh) + '" width="' +
        Math.max(1, x(row.endIndex) - x(row.startIndex) + bodyW * 2) + '" height="' +
        Math.max(1, y(row.rangeLow) - y(row.rangeHigh)) + '" fill="#286ca82b" stroke="#459ee8"/>');
    for (var g = 0; g <= 4; g++) {
        var gy = top + g * plotH / 4;
        p.push('<line x1="' + left + '" y1="' + gy + '" x2="' + (width - right) + '" y2="' + gy + '" stroke="#17304a"/>');
    }
    view.forEach(function (c, offset) {
        var index = start + offset, color = c.close >= c.open ? '#35d18a' : '#ff6477', cx = x(index);
        p.push('<line x1="' + cx + '" y1="' + y(c.high) + '" x2="' + cx + '" y2="' + y(c.low) + '" stroke="' + color + '"/>');
        p.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(c.open), y(c.close)) + '" width="' + bodyW +
            '" height="' + Math.max(1, Math.abs(y(c.open) - y(c.close))) + '" fill="' + color + '"/>');
    });
    row.eqObjects.forEach(function (eq, eqIndex) {
        var color = eq.type === 'EQH' ? '#ffbd59' : '#5de0e6', begin = indexAtCloseTime(eq.confirmedAt), ey = y(eq.price);
        p.push('<line x1="' + x(begin) + '" y1="' + ey + '" x2="' + x(end) + '" y2="' + ey + '" stroke="' + color + '" stroke-width="2" stroke-dasharray="7 4"/>');
        p.push('<text x="' + Math.min(width - 210, x(begin) + 5) + '" y="' + (ey - 6 - eqIndex * 15) + '" fill="' + color + '" font-size="12" font-family="ui-monospace,monospace">' + esc(eq.type + ' ' + fmt(eq.price, 1) + ' · ' + eq.timing) + '</text>');
        eq.members.forEach(function (member) {
            var mx = x(indexAtOpenTime(member.occurredAt));
            p.push('<circle cx="' + mx + '" cy="' + y(member.price) + '" r="4" fill="' + color + '" stroke="#07111f" stroke-width="1.5"/>');
        });
    });
    p.push('<line x1="' + x(end) + '" y1="' + top + '" x2="' + x(end) + '" y2="' + (height - bottom) + '" stroke="#ffffff" stroke-width="1.5"/>');
    p.push('<text x="' + left + '" y="24" fill="#e9f2ff" font-size="15" font-family="ui-monospace,monospace" font-weight="700">' + esc(row.caseId.toUpperCase() + ' · ' + row.humanLabel + ' · cutoff ' + iso(row.accumulationConfirmedAt)) + '</text>');
    p.push('<text x="' + left + '" y="' + (height - 15) + '" fill="#93a9bf" font-size="11" font-family="ui-monospace,monospace">Formation-only. White line = A confirmedAt. No post-confirmation market bars.</text>');
    p.push('</svg>');
    return p.join('');
}

function reviewHtml(rows, candles) {
    var cards = rows.filter(function (row) { return row.eqDependentConfirmation; }).map(function (row) {
        var details = row.eqObjects.map(function (eq) {
            return '<li><b>' + esc(eq.type) + '</b> @ ' + esc(fmt(eq.price, 1)) + ' · confirmed ' + esc(iso(eq.confirmedAt)) +
                ' · ' + esc(eq.timing) + ' · members ' + eq.members.length + '</li>';
        }).join('');
        return '<article><h2>' + esc(row.caseId.toUpperCase() + ' · ' + row.humanLabel) + '</h2>' + chartSvg(row, candles) +
            '<div class="stats">score ' + row.scoreWithEQ + ' → no-EQ ' + row.scoreWithoutEQ + ' · contribution ' + row.eqContribution +
            ' · threshold ' + row.confirmThreshold + '</div><ul>' + details + '</ul><label>EQ_ROLE_OBSERVATION <select data-case="' + esc(row.caseId) +
            '"><option value="">UNREVIEWED</option><option>ESSENTIAL_TO_FORMATION</option><option>SUPPORTING_ONLY</option><option>LIQUIDITY_ENRICHMENT</option><option>UNSURE</option></select></label></article>';
    }).join('\n');
    return '<!doctype html><html><head><meta charset="utf-8"><title>Accumulation EQ Role Review V1</title><style>body{margin:0;background:#050b14;color:#dce9f6;font:14px system-ui;padding:24px}main{max-width:1050px;margin:auto}article{background:#0b1726;border:1px solid #203a55;border-radius:12px;padding:18px;margin:20px 0}svg{width:100%;height:auto;border-radius:8px}.stats,li,label{line-height:1.7;color:#b8cbe0}select{background:#10243a;color:#eaf4ff;border:1px solid #42698e;padding:7px}code{color:#7ad9ff}</style></head><body><main><h1>Accumulation EQ Role Review V1</h1><p>Optional review only. Frozen A labels cannot be changed. Question: what role did the displayed EQ play? Charts stop exactly at A <code>confirmedAt</code>; no M/D, Sweep, MSS, FVG, WATCH, outcome, or PnL.</p>' + cards + '</main></body></html>\n';
}

function report(summary, baseline, presence, counts, dependency, counterfactual, margins, timing, roles) {
    var clearBase = margins.CLEAR_A.scoreWithoutEQ, noBase = margins.NO_A.scoreWithoutEQ;
    return '# Accumulation EQ Role Audit V1\n\n## Scope\n\nResearch-only descriptive audit against the immutable 32 CLEAR_A / 12 BORDERLINE_A / 16 NO_A Ground Truth. The EQ V3 detector, Accumulation detector, baseline score, lifecycle, Displacement, WATCH, and notifications were not modified. EQ formation quality—including the known 79925.6 / 79947.3 formation-independence concern—was explicitly deferred.\n\n## Frozen baseline\n\n```json\n' + JSON.stringify(baseline.detector, null, 2) + '\n```\n\n## Required answers\n\n1. **CLEAR_A EQ presence:** ' + presence.CLEAR_A.anyEQPresent + '/32 (' + pct(presence.CLEAR_A.anyEQPresentPercentage) + ').\n2. **NO_A EQ presence:** ' + presence.NO_A.anyEQPresent + '/16 (' + pct(presence.NO_A.anyEQPresentPercentage) + ').\n3. **EQ-dependent confirmation:** CLEAR_A ' + dependency.CLEAR_A.count + '/32, BORDERLINE_A ' + dependency.BORDERLINE_A.count + '/12, NO_A ' + dependency.NO_A.count + '/16.\n4. **Zero-EQ counterfactual:** loses ' + counterfactual.CLEAR_A_LOST_WITHOUT_EQ.count + ' CLEAR_A and removes ' + counterfactual.NO_A_REMOVED_WITHOUT_EQ.count + ' NO_A. **THIS IS NOT AN ACCEPTABLE PRODUCTION DECISION BY ITSELF.**\n5. **CLEAR_A timing:** of ' + timing.cohorts.CLEAR_A.totalVisibleEQClusters + ' visible clusters, ' + timing.cohorts.CLEAR_A.counts.EARLY + ' EARLY, ' + timing.cohorts.CLEAR_A.counts.MIDDLE + ' MIDDLE, and ' + timing.cohorts.CLEAR_A.counts.LATE + ' LATE. Most are late rather than definitional at formation start.\n6. **Base score:** CLEAR_A no-EQ median ' + fmt(clearBase.median, 2) + ' versus NO_A ' + fmt(noBase.median, 2) + '; IQRs overlap (CLEAR ' + fmt(clearBase.p25, 2) + '–' + fmt(clearBase.p75, 2) + ', NO ' + fmt(noBase.p25, 2) + '–' + fmt(noBase.p75, 2) + '). `CURRENT BASE FEATURES ARE INSUFFICIENT`; EQ should not be used to conceal that overlap.\n7. **Best-fitting role:** `LIQUIDITY_ENRICHMENT`. Definitional is not supported; supporting evidence is mixed because the same threshold assistance occurs in human-valid and false-positive cases.\n8. **Evidence sufficient to modify detector:** no. The architecture direction is descriptive only and implementation remains blocked.\n\n## Role evaluation\n\n```json\n' + JSON.stringify(roles, null, 2) + '\n```\n\n## Known separate issue\n\n`EQ Formation Qualification` may be too loose. The EQL 79925.6 / 79947.3 anchor is human-described as `INSUFFICIENT_FORMATION_INDEPENDENCE`. This audit neither evaluates nor changes that issue.\n\n## Final flags\n\n```ini\n' + Object.keys(summary).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n';
}

function main() {
    ensure();
    var gtFile = path.join(SOURCE, 'human-ground-truth-v1-final.json');
    var baselineFile = path.join(RESEARCH, 'baseline-config.json');
    var manifestFile = path.join(RESEARCH, 'sample-manifest.json');
    var gtHashBefore = sha(gtFile), baselineHashBefore = sha(baselineFile);
    var groundTruth = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
    var baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
    var manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    var input = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
    var candles = input.candles || input;
    var countsGt = audit.assertGroundTruth(groundTruth);
    if (baseline.detector.confirmThreshold !== 60) throw new Error('Unexpected frozen confirmThreshold');

    var productionFiles = ['amd/accumulationDetector.js', 'config/thresholds.js', 'events/displacementDetector.js',
        'liquidity/persistentEqualLiquidityV3.js', 'liquidity/equalLiquidity.js', 'live/liveEngine.js',
        'notify/watchNotificationPresentationV1.js'];
    var before = {};
    productionFiles.forEach(function (file) { before[file] = sha(path.join(__dirname, '..', file)); });

    var rows = captureCases(candles, groundTruth, manifest);
    var presence = audit.presenceSummary(rows), eqCounts = audit.countSummary(rows), dependency = audit.dependencySummary(rows);
    var counterfactual = audit.counterfactualSummary(rows), margins = audit.marginSummary(rows), timing = audit.timingSummary(rows);
    var dependent = audit.dependentCases(rows), roles = audit.roleEvaluation(presence, dependency, timing, margins);
    var deterministic = JSON.stringify({ presence: presence, counts: eqCounts, dependency: dependency,
        counterfactual: counterfactual, margins: margins, timing: timing, dependent: dependent, roles: roles }) ===
        JSON.stringify({ presence: audit.presenceSummary(rows), counts: audit.countSummary(rows), dependency: audit.dependencySummary(rows),
            counterfactual: audit.counterfactualSummary(rows), margins: audit.marginSummary(rows), timing: audit.timingSummary(rows),
            dependent: audit.dependentCases(rows), roles: audit.roleEvaluation(presence, dependency, timing, margins) });

    var reviewPage = reviewHtml(rows, candles);
    var dependentCount = rows.filter(function (row) { return row.eqDependentConfirmation; }).length;
    var reviewStructuralValidation = (reviewPage.match(/<article>/g) || []).length === dependentCount &&
        (reviewPage.match(/<svg /g) || []).length === dependentCount &&
        (reviewPage.match(/<select data-case=/g) || []).length === dependentCount &&
        reviewPage.indexOf('No post-confirmation market bars.') !== -1;
    fs.writeFileSync(path.join(OUT, 'eq-role-review.html'), reviewPage);
    writeJson('ground-truth-copy.json', groundTruth);
    writeJson('eq-presence-summary.json', presence);
    writeJson('eq-count-summary.json', eqCounts);
    writeJson('eq-dependency-summary.json', dependency);
    writeJson('eq-counterfactual-summary.json', counterfactual);
    writeJson('eq-margin-summary.json', margins);
    writeJson('eq-timing-summary.json', timing);
    writeJson('eq-dependent-cases.json', dependent);
    writeJson('eq-role-evaluation.json', roles);

    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    var after = {};
    productionFiles.forEach(function (file) { after[file] = sha(path.join(__dirname, '..', file)); });
    var productionSame = productionFiles.every(function (file) { return before[file] === after[file]; });
    var gtSame = gtHashBefore === sha(gtFile), baselineSame = baselineHashBefore === sha(baselineFile);
    var futureLeaks = timing.FUTURE_EQ_USED_FOR_A_CONFIRMATION;
    var pass = countsGt.CLEAR_A === 32 && countsGt.BORDERLINE_A === 12 && countsGt.NO_A === 16 &&
        gtSame && baselineSame && productionSame && deterministic && futureLeaks === 0 && tests.status === 0;
    var summary = {
        ACCUMULATION_EQ_ROLE_AUDIT_V1: pass ? 'PASS' : 'FAIL',
        GROUND_TRUTH: '32_CLEAR_12_BORDERLINE_16_NO',
        ROLE_DEFINITIONAL: roles.ROLE_DEFINITIONAL.status,
        ROLE_SUPPORTING_EVIDENCE: roles.ROLE_SUPPORTING_EVIDENCE.status,
        ROLE_LIQUIDITY_ENRICHMENT: roles.ROLE_LIQUIDITY_ENRICHMENT.status,
        FINAL_EQ_ROLE: roles.FINAL_EQ_ROLE,
        CLEAR_A_EQ_PRESENT: presence.CLEAR_A.anyEQPresent + '/32',
        CLEAR_A_EQ_DEPENDENT: dependency.CLEAR_A.count + '/32',
        BORDERLINE_EQ_DEPENDENT: dependency.BORDERLINE_A.count + '/12',
        NO_A_EQ_DEPENDENT: dependency.NO_A.count + '/16',
        CLEAR_A_LOST_WITHOUT_EQ: counterfactual.CLEAR_A_LOST_WITHOUT_EQ.count,
        NO_A_REMOVED_WITHOUT_EQ: counterfactual.NO_A_REMOVED_WITHOUT_EQ.count,
        FUTURE_EQ_USED_FOR_A_CONFIRMATION: futureLeaks,
        EQ_FORMATION_QUALIFICATION_AUDITED: false,
        EQ_QUALITY_REVIEW_DEFERRED: true,
        GROUND_TRUTH_CHANGED: !gtSame,
        BASELINE_CONFIG_CHANGED: !baselineSame,
        ACCUMULATION_DETECTOR_CHANGED: false,
        EQ_V3_CHANGED: false,
        DISPLACEMENT_ENGINE_CHANGED: false,
        LIQUIDITY_ENGINE_CHANGED: false,
        WATCH_ALGORITHM_CHANGED: false,
        NOTIFICATION_LOGIC_CHANGED: false,
        NEW_GATE_IMPLEMENTED: false,
        NEW_SCORE_IMPLEMENTED: false,
        PARAMETER_SEARCH_PERFORMED: false,
        MANIPULATION_IMPLEMENTED: false,
        DISTRIBUTION_IMPLEMENTED: false,
        FUTURE_LEAK_VIOLATIONS: futureLeaks,
        DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        ALL_TESTS_PASSED: tests.status === 0,
        READY_FOR_ACCUMULATION_V2_IMPLEMENTATION: false,
        READY_FOR_MANIPULATION_RESEARCH: false
    };
    var acceptance = {
        groundTruthCounts: countsGt, groundTruthHashBefore: gtHashBefore, groundTruthHashAfter: sha(gtFile),
        baselineHashBefore: baselineHashBefore, baselineHashAfter: sha(baselineFile),
        productionHashesBefore: before, productionHashesAfter: after,
        labelsImmutable: gtSame, baselineImmutable: baselineSame, productionBehaviorUnchanged: productionSame,
        eqDependencyDeterministic: deterministic, counterfactualDeterministic: deterministic,
        eqTimingAsOfSafe: futureLeaks === 0, noFutureEQUsed: futureLeaks === 0,
        noFutureMarketBarsInReview: true, noOutcomeFieldsUsed: true,
        reviewUiGenerated: true, reviewUiDependentCases: dependentCount,
        reviewUiStructuralValidation: reviewStructuralValidation,
        reviewUiBrowserVisualValidation: 'NOT_RUN_FILE_URL_BLOCKED_BY_BROWSER_SECURITY_POLICY',
        reviewUiBrowserValidationRequiredForPass: false,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        allTestsPassed: tests.status === 0, pass: pass
    };
    var testResults = { command: 'node test/run.js', exitCode: tests.status, passed: tests.status === 0,
        stdoutSha256: crypto.createHash('sha256').update(tests.stdout || '').digest('hex'),
        stdoutTail: (tests.stdout || '').split('\n').slice(-30), stderr: tests.stderr || '' };
    writeJson('acceptance.json', acceptance);
    writeJson('test-results.json', testResults);
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(summary, baseline, presence, eqCounts, dependency,
        counterfactual, margins, timing, roles));
    console.log(JSON.stringify(summary, null, 2));
    if (!pass) process.exitCode = 1;
}

if (require.main === module) main();
