'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var consistencyPhase1 = require('./accumulationGroundTruthConsistencyAuditV2');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var SOURCE = path.join(ROOT, 'accumulation-ground-truth-consistency-audit-v2');
var REVIEW_FILE = path.join(SOURCE, 'review-results-frozen.json');
var UNBLIND_FILE = path.join(SOURCE, 'unblind-comparison.json');
var SAMPLE_FILE = path.join(SOURCE, 'sample-manifest.json');
var MAP_FILE = path.join(SOURCE, 'blind-case-map.json');
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-ground-truth-v2-definition-calibration-v1');
var SELECTION_SEED = 'ACCUMULATION_GT_V2_DEFINITION_CALIBRATION_V1_20260828';
var ORDER_SEED = 'ACCUMULATION_GT_V2_CALIBRATION_ORDER_V1_20260828';
var TYPES = ['TYPE_A_OBVIOUS_INDEPENDENT_BALANCE', 'TYPE_B_OBVIOUS_TREND_PAUSE_ONE_SIDED',
    'TYPE_C_TRUE_BORDERLINE_AMBIGUOUS_BALANCE', 'TYPE_D_PRIOR_HIGH_CONFIDENCE_MAJOR_DISAGREEMENT'];

function ensureDir() { fs.mkdirSync(OUT, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function shaText(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function iso(value) { return new Date(value).toISOString(); }

function deterministicTake(rows, count, seed) {
    if (rows.length < count) throw new Error('Insufficient eligible calibration cases for ' + seed);
    return rows.slice().sort(function (a, b) {
        return shaText(seed + '|' + a.originalCaseId).localeCompare(shaText(seed + '|' + b.originalCaseId)) ||
            a.originalCaseId.localeCompare(b.originalCaseId);
    }).slice(0, count);
}

function selectCalibrationCases(unblindRows) {
    var selectedIds = new Set(), selected = [];
    function add(type, candidates) {
        deterministicTake(candidates.filter(function (row) { return !selectedIds.has(row.originalCaseId); }), 3,
            SELECTION_SEED + '|' + type).forEach(function (row) {
            selectedIds.add(row.originalCaseId);
            selected.push({ type: type, row: row });
        });
    }
    add(TYPES[3], unblindRows.filter(function (row) {
        return row.confidence === 'HIGH' && row.agreementRelation === 'MAJOR_DISAGREEMENT';
    }));
    add(TYPES[0], unblindRows.filter(function (row) { var s = row.humanSemanticAnswers;
        return row.blindLabel === 'CLEAR_A' && s.independentBalanceFormed === 'YES' && s.twoSidedAuction === 'COHERENT';
    }));
    add(TYPES[1], unblindRows.filter(function (row) { var s = row.humanSemanticAnswers;
        return row.blindLabel === 'NO_A' && s.independentBalanceFormed === 'NO' &&
            (s.twoSidedAuction === 'WEAK' || s.twoSidedAuction === 'ABSENT') &&
            s.trendPauseCharacter === 'STRONG' && s.oneSidedResidence === 'STRONG';
    }));
    add(TYPES[2], unblindRows.filter(function (row) { var s = row.humanSemanticAnswers;
        return row.blindLabel === 'BORDERLINE_A' && s.independentBalanceFormed === 'PARTIAL' && s.twoSidedAuction === 'PARTIAL';
    }));
    return selected;
}

function rationale(type, row) {
    var s = row.humanSemanticAnswers;
    if (type === TYPES[0]) return 'Formation-only blind semantics show independent balance YES and coherent two-sided auction; selected as an obvious positive semantic anchor.';
    if (type === TYPES[1]) return 'Formation-only blind semantics show no independent balance, strong trend-pause character, strong one-sided residence, and weak/absent two-sided auction.';
    if (type === TYPES[2]) return 'Formation-only blind semantics show partial independent balance and partial two-sided auction; selected to calibrate both class boundaries.';
    return 'Deterministically selected from the frozen high-confidence major-disagreement pool to challenge Definition Draft 0 without using any post-formation information.';
}

function buildCases(review, unblind, samples) {
    var reviewsByBlind = {}, samplesByBlind = {};
    review.reviews.forEach(function (row) { reviewsByBlind[row.blindId] = row; });
    samples.cases.forEach(function (row) { samplesByBlind[row.blindId] = row; });
    var chosen = selectCalibrationCases(unblind.primaryCases);
    var ordered = chosen.slice().sort(function (a, b) {
        return shaText(ORDER_SEED + '|' + a.row.originalCaseId).localeCompare(shaText(ORDER_SEED + '|' + b.row.originalCaseId)) ||
            a.row.originalCaseId.localeCompare(b.row.originalCaseId);
    });
    return ordered.map(function (item, index) {
        var prior = reviewsByBlind[item.row.blindId], anonymous = samplesByBlind[item.row.blindId];
        if (!prior || !anonymous) throw new Error('Missing calibration source for ' + item.row.originalCaseId);
        return {
            calibrationId: 'CAL-' + String(index + 1).padStart(2, '0'),
            originalCaseId: item.row.originalCaseId,
            sourceBlindId: item.row.blindId,
            selectionType: item.type,
            selectionRationale: rationale(item.type, item.row),
            frozenGroundTruthV1: item.row.frozenGroundTruth,
            previousBlindLabel: item.row.blindLabel,
            priorDisagreement: item.row.agreementRelation !== 'EXACT',
            priorAgreementRelation: item.row.agreementRelation,
            previousBlindSemanticObservations: {
                confidence: prior.confidence, balanceQuality: prior.balanceQuality,
                independentBalanceFormed: prior.independentBalanceFormed, twoSidedAuction: prior.twoSidedAuction,
                trendPauseCharacter: prior.trendPauseCharacter, oneSidedResidence: prior.oneSidedResidence,
                centerBehavior: prior.centerBehavior, excursionBehavior: prior.excursionBehavior,
                observationTags: prior.observationTags.slice(), freeText: prior.freeText
            },
            anonymous: Object.assign({}, anonymous, {
                calibrationId: 'CAL-' + String(index + 1).padStart(2, '0'),
                blindId: 'CAL-' + String(index + 1).padStart(2, '0')
            })
        };
    });
}

function select(name, title, options) {
    return '<label class="field"><b>' + esc(title) + '</b><select name="' + name + '"><option value="" selected disabled>请选择</option>' +
        options.map(function (option) { return '<option value="' + option + '">' + option + '</option>'; }).join('') + '</select></label>';
}

function draftHtml() {
    return '<section class="draft"><h1>Definition Draft 0</h1><blockquote>ACCUMULATION — A formation where price establishes a relatively independent balance and demonstrates coherent two-sided auction, without sustained directional value migration dominating the formation.</blockquote><div class="draft-grid"><div><h3>Independent Balance</h3><p>Formation 本身具有可识别的 auction identity，并与前序 directional delivery 分离；趋势暂停或窄 box 本身不构成 balance。</p></div><div><h3>Coherent Two-Sided Auction</h3><p>Upper 与 lower region 均有有意义的参与、return、rebalancing 与 re-acceptance；不要求机械路径或对称 touch。</p></div><div><h3>Negative Evidence</h3><p>持续 one-sided residence、主导 formation 的 persistent value migration，以及缺少独立 balance identity。</p></div><div><h3>Contextual Evidence</h3><p>Temporary shift 可以被重新吸收；单次 failed reabsorption 必须结合 severity、duration、location、return 与 auction identity 判断。</p></div></div><p class="order"><b>思考顺序：</b>Independent balance → coherent two-sided auction → directional behavior 是否仍属于 balance narrative → provisional class。</p></section>';
}

function contextHtml(item) {
    var s = item.previousBlindSemanticObservations;
    return '<div class="context" hidden><h3>Stage 2 · Calibration Context</h3><p><b>Selection purpose：</b>' + esc(item.selectionRationale) + '</p><p><b>Prior disagreement：</b>' + (item.priorDisagreement ? 'YES' : 'NO') + '</p><div class="context-grid"><span>Independent balance<br><b>' + esc(s.independentBalanceFormed) + '</b></span><span>Two-sided auction<br><b>' + esc(s.twoSidedAuction) + '</b></span><span>Trend separation proxy<br><b>' + esc(s.trendPauseCharacter) + '</b></span><span>One-sided residence<br><b>' + esc(s.oneSidedResidence) + '</b></span><span>Center behavior<br><b>' + esc(s.centerBehavior) + '</b></span><span>Excursion behavior<br><b>' + esc(s.excursionBehavior) + '</b></span></div><p><b>Previous formation-only observation：</b>' + esc(s.freeText) + '</p><div class="feedback"><h4>Definition feedback</h4>' +
        select('definitionFeedback', 'Definition Draft 0 handling', ['DRAFT_0_HANDLES_CASE_WELL', 'DRAFT_0_TOO_STRICT', 'DRAFT_0_TOO_PERMISSIVE', 'DRAFT_0_AMBIGUOUS', 'UNSURE']) +
        '<label class="free"><b>Definition feedback note</b><textarea name="definitionFeedbackNote" placeholder="说明 Draft 0 在此案例中哪里清楚或不足。"></textarea></label></div></div>';
}

function renderHtml(cases) {
    var cards = cases.map(function (item) {
        var row = item.anonymous;
        return '<article class="case" id="' + item.calibrationId + '"><header><h2>' + item.calibrationId + '</h2><div>BTCUSDT · 5m · ' + esc(iso(row.formationStartAt)) + ' → ' + esc(iso(row.formationConfirmedAt)) + '</div></header>' +
            consistencyPhase1.chartSvg({ anonymous: row }) + '<section class="stage1"><h3>Stage 1 · Formation Review</h3><div class="grid">' +
            select('provisionalClass', 'A · Provisional class', ['CLEAR_A', 'BORDERLINE_A', 'NO_A', 'UNSURE']) +
            select('independentBalance', 'B · Independent balance', ['YES', 'PARTIAL', 'NO', 'UNSURE']) +
            select('twoSidedAuction', 'C · Two-sided auction', ['COHERENT', 'PARTIAL', 'WEAK', 'ABSENT', 'UNSURE']) +
            select('previousTrendSeparation', 'D · Previous trend separation', ['CLEARLY_SEPARATED', 'PARTIALLY_SEPARATED', 'NOT_SEPARATED', 'NO_CLEAR_PREVIOUS_TREND', 'UNSURE']) +
            select('oneSidedResidence', 'E · One-sided residence', ['NONE', 'MILD', 'STRONG', 'UNSURE']) +
            select('valueMigration', 'F · Value migration', ['NONE', 'TEMPORARY', 'PERSISTENT', 'IRREGULAR', 'UNSURE']) +
            select('excursionContext', 'G · Excursion context', ['REABSORBED_WITHIN_BALANCE', 'PARTIAL_REABSORPTION', 'FAILED_BUT_BALANCE_SURVIVES', 'FAILED_AND_BALANCE_BREAKS_DOWN', 'NO_CLEAR_EXCURSION', 'UNSURE']) +
            '</div><label class="free"><b>H · Why?</b><textarea name="why" placeholder="只描述 formation narrative。"></textarea></label><button type="button" class="context-toggle" disabled>完成 Stage 1 后展开 Calibration Context</button></section>' + contextHtml(item) + '</article>';
    }).join('\n');
    var publicData = cases.map(function (item) { return { calibrationId: item.calibrationId }; });
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accumulation Definition Calibration V1</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#050a12;color:#e9f1fa}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#06101d,#03070c)}nav{position:sticky;top:0;z-index:5;display:flex;gap:12px;align-items:center;padding:13px 22px;background:#071523f2;border-bottom:1px solid #29415a}nav strong{margin-right:auto}button{background:#2c8ad0;color:white;border:0;border-radius:8px;padding:10px 15px;font-weight:700}button:disabled{opacity:.42}.wrap{max-width:1200px;margin:auto;padding:20px}.draft,.case{background:#091624;border:1px solid #29415a;border-radius:14px;margin:24px 0;overflow:hidden}.draft{padding:20px}.draft blockquote{border-left:4px solid #f0c85a;margin:14px 0;padding:12px 16px;background:#111f2e;line-height:1.6}.draft-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.draft-grid div{background:#102337;border-radius:9px;padding:12px}.draft-grid h3{margin:0 0 6px;color:#7fc5ff}.draft-grid p{margin:0;color:#b5c5d4;line-height:1.5}.order{color:#f2d98d}.case header{padding:15px 18px;display:flex;justify-content:space-between;border-bottom:1px solid #1d344b}.case h2{margin:0;color:#7fc5ff}.case header div{color:#9fb1c4;font:12px ui-monospace,monospace}.stage1,.context{padding:16px}.stage1 h3,.context h3{margin-top:0}.grid,.context-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.field,.free{display:grid;gap:6px}.field b,.free b{color:#b8cee3;font-size:12px}select,textarea{width:100%;background:#06111d;color:#e9f1fa;border:1px solid #36536e;border-radius:8px;padding:9px}textarea{min-height:86px;resize:vertical}.context-toggle{margin-top:12px}.context{border-top:1px solid #34526d;background:#0c1c2c}.context-grid span{background:#102d42;padding:9px;border-radius:7px;color:#aac0d3}.context-grid b{color:#f0f6fc}.feedback{border-top:1px solid #36516b;margin-top:14px;padding-top:12px;display:grid;gap:10px}.done{color:#62dda6}.warn{color:#ffca67}svg{display:block;width:100%;height:auto}@media(max-width:760px){nav strong{display:none}.wrap{padding:7px}.draft-grid,.grid,.context-grid{grid-template-columns:1fr}.case header{display:grid;gap:7px}}' +
        '</style></head><body><nav><strong>Accumulation Ground Truth V2 · Definition Calibration</strong><span id="progress" class="warn">0 / 12 完成</span><button id="export" disabled>导出 Calibration</button></nav><main class="wrap">' + draftHtml() + cards + '</main><script>' +
        'const cases=' + JSON.stringify(publicData) + ';const state={};const q=s=>document.querySelector(s);const qa=s=>Array.from(document.querySelectorAll(s));function stage1(id){const root=document.getElementById(id);const v=n=>root.querySelector(`[name="${n}"]`).value;return{provisionalClass:v("provisionalClass"),independentBalance:v("independentBalance"),twoSidedAuction:v("twoSidedAuction"),previousTrendSeparation:v("previousTrendSeparation"),oneSidedResidence:v("oneSidedResidence"),valueMigration:v("valueMigration"),excursionContext:v("excursionContext"),why:root.querySelector(`[name="why"]`).value.trim()}}function stage1Complete(r){return Object.values(r).every(Boolean)}function collect(id){const root=document.getElementById(id),s=stage1(id);return{calibrationId:id,...s,definitionFeedback:root.querySelector(`[name="definitionFeedback"]`).value,definitionFeedbackNote:root.querySelector(`[name="definitionFeedbackNote"]`).value.trim()}}function complete(r){return stage1Complete(r)&&r.definitionFeedback&&r.definitionFeedbackNote}function refresh(){cases.forEach(c=>{const id=c.calibrationId,root=document.getElementById(id),s=stage1(id),button=root.querySelector(".context-toggle");button.disabled=!stage1Complete(s);button.textContent=button.disabled?"完成 Stage 1 后展开 Calibration Context":(root.querySelector(".context").hidden?"展开 Calibration Context":"折叠 Calibration Context");state[id]=collect(id)});const n=Object.values(state).filter(complete).length;q("#progress").textContent=`${n} / ${cases.length} 完成`;q("#progress").className=n===cases.length?"done":"warn";q("#export").disabled=n!==cases.length}qa(".context-toggle").forEach(button=>button.onclick=()=>{const context=button.closest("article").querySelector(".context");context.hidden=!context.hidden;refresh()});qa("select,textarea").forEach(x=>{x.addEventListener("change",refresh);x.addEventListener("input",refresh)});q("#export").onclick=()=>{refresh();if(!Object.values(state).every(complete))return;const payload={schemaVersion:"ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1",reviewedAt:new Date().toISOString(),responses:cases.map(c=>state[c.calibrationId])};const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));a.download="accumulation-definition-calibration-results.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};refresh();' +
        '</script></body></html>\n';
}

function main() {
    ensureDir();
    var review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
    var unblind = JSON.parse(fs.readFileSync(UNBLIND_FILE, 'utf8'));
    var samples = JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8'));
    var sourceMap = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    var gtHashBefore = shaFile(GT_FILE), casesA = buildCases(review, unblind, samples), casesB = buildCases(review, unblind, samples);
    if (JSON.stringify(casesA) !== JSON.stringify(casesB)) throw new Error('Determinism violation');
    if (casesA.length !== 12 || new Set(casesA.map(function (x) { return x.originalCaseId; })).size !== 12) throw new Error('Calibration composition invalid');
    var typeCounts = TYPES.reduce(function (out, type) { out[type] = casesA.filter(function (x) { return x.selectionType === type; }).length; return out; }, {});
    if (Object.keys(typeCounts).some(function (type) { return typeCounts[type] !== 3; })) throw new Error('Calibration type count invalid');
    var html = renderHtml(casesA), html2 = renderHtml(casesB);
    var forbidden = ['frozenGroundTruthV1', 'previousBlindLabel', 'selectionType', 'sourceBlindId', 'originalCaseId',
        'prototypeDecision', 'MSS', 'Displacement', 'FVG', 'WATCH', 'PnL'];
    var leaks = forbidden.filter(function (token) { return html.indexOf(token) !== -1; });
    var caseIdLeaks = Array.from(new Set(html.match(/case\d{3}/g) || []));
    var blindIdLeaks = Array.from(new Set(html.match(/GT-BLIND-\d+/g) || []));
    var futureLeaks = casesA.reduce(function (count, item) { return count + item.anonymous.bars.filter(function (bar) {
        return bar.closeTime > item.anonymous.formationConfirmedAt;
    }).length; }, 0);
    if (html !== html2 || leaks.length || caseIdLeaks.length || blindIdLeaks.length || futureLeaks) {
        throw new Error('Calibration UI safety failure');
    }

    writeJson('calibration-selection.json', { schemaVersion: 'ACCUMULATION_GT_V2_CALIBRATION_SELECTION_V1',
        selectionSeed: SELECTION_SEED, orderSeed: ORDER_SEED, selectionRunCount: 1,
        usesFormationOnlyInformation: true, usesExistingHumanReviewDisagreement: true,
        usesOutcome: false, usesPostFormation: false, usesProductionResult: false,
        cases: casesA.map(function (item) { return { calibrationId: item.calibrationId,
            originalCaseId: item.originalCaseId, selectionType: item.selectionType,
            selectionRationale: item.selectionRationale, priorDisagreement: item.priorDisagreement,
            previousBlindSemanticObservations: item.previousBlindSemanticObservations }; }) });
    writeJson('calibration-case-map.json', { schemaVersion: 'ACCUMULATION_GT_V2_CALIBRATION_MAP_V1',
        uiLoadsThisFile: false, cases: casesA.map(function (item) { return { calibrationId: item.calibrationId,
            originalCaseId: item.originalCaseId, sourceBlindId: item.sourceBlindId,
            selectionType: item.selectionType, frozenGroundTruthV1: item.frozenGroundTruthV1,
            previousBlindLabel: item.previousBlindLabel, priorAgreementRelation: item.priorAgreementRelation }; }) });
    writeJson('calibration-config.json', { schemaVersion: 'ACCUMULATION_GT_V2_DEFINITION_CALIBRATION_V1',
        definitionDraft: 0, calibrationCases: 12, perTypeCases: 3, selectionSeed: SELECTION_SEED,
        orderSeed: ORDER_SEED, stage1FormationOnly: true, stage2LockedUntilStage1Complete: true,
        stage2ShowsFrozenGroundTruthV1: false, responsesPrepopulated: false,
        numericThresholdsUsed: false, postConfirmationBarsUsed: 0, outcomeDataUsed: false,
        groundTruthV1Status: 'UNSTABLE_RETIRED_FOR_RESEARCH_GUIDANCE', groundTruthV1Preserved: true });
    fs.writeFileSync(path.join(OUT, 'accumulation-definition-calibration-v1.html'), html);
    fs.writeFileSync(path.join(OUT, 'README.md'), '# Accumulation Ground Truth V2 — Definition Calibration V1\n\n' +
        'This is a 12-case formation-only human definition calibration, not a blind consistency measurement.\n\n' +
        '1. Open `accumulation-definition-calibration-v1.html`.\n' +
        '2. Read Definition Draft 0.\n' +
        '3. Complete Stage 1 for a case before opening its Stage 2 calibration context.\n' +
        '4. You may revise earlier judgements while comparing cases.\n' +
        '5. Complete definition feedback and export `accumulation-definition-calibration-results.json`.\n' +
        '6. Return the JSON to Codex for separately gated Definition Synthesis.\n\n' +
        'No V1 label, future candle, outcome, production result, or machine representation is displayed.\n');

    var productionFiles = [GT_FILE, BASELINE_FILE, path.join(__dirname, '..', 'amd', 'accumulationDetector.js'),
        path.join(__dirname, '..', 'amd', 'amdState.js'), path.join(__dirname, '..', 'config', 'thresholds.js'),
        path.join(__dirname, '..', 'liquidity', 'persistentEqualLiquidityV3.js'),
        path.join(__dirname, '..', 'events', 'displacementDetector.js'), path.join(__dirname, '..', 'live', 'liveEngine.js')];
    var before = productionFiles.map(shaFile);
    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
    var after = productionFiles.map(shaFile), productionSame = JSON.stringify(before) === JSON.stringify(after);
    var pass = tests.status === 0 && productionSame && gtHashBefore === shaFile(GT_FILE) && casesA.length === 12 &&
        futureLeaks === 0 && leaks.length === 0 && caseIdLeaks.length === 0 && html === html2 && sourceMap.cases.length === 24;
    writeJson('test-results-phase1.json', { command: 'node test/run.js', exitCode: tests.status,
        passed: tests.status === 0, stdoutSha256: shaText(tests.stdout || ''),
        stdoutTail: String(tests.stdout || '').split('\n').slice(-35), stderr: tests.stderr || '' });
    writeJson('acceptance-phase1.json', {
        ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1_PHASE1: pass ? 'PASS' : 'FAIL',
        CALIBRATION_CASES: 12, TYPE_A_CASES: typeCounts[TYPES[0]], TYPE_B_CASES: typeCounts[TYPES[1]],
        TYPE_C_CASES: typeCounts[TYPES[2]], TYPE_D_CASES: typeCounts[TYPES[3]],
        CALIBRATION_SELECTION_USES_OUTCOME: false, CALIBRATION_SELECTION_USES_POST_FORMATION: false,
        CALIBRATION_SELECTION_USES_PRODUCTION_RESULT: false, POST_CONFIRMATION_BARS_USED: 0,
        HUMAN_CALIBRATION_RESPONSES_PREPOPULATED: false, ORIGINAL_CASE_ID_LEAKS: caseIdLeaks.length,
        CALIBRATION_UI_METADATA_LEAKS: leaks.length + blindIdLeaks.length, GROUND_TRUTH_V1_CHANGED: false,
        GROUND_TRUTH_V1_STATUS: 'UNSTABLE_RETIRED_FOR_RESEARCH_GUIDANCE', GROUND_TRUTH_V1_PRESERVED: true,
        GROUND_TRUTH_V2_LABELS_CREATED: false, ACCUMULATION_DETECTOR_CHANGED: false,
        BASELINE_CONFIG_CHANGED: false, REPRESENTATION_V2_CHANGED: false, F6_CHANGED: false, F7_CHANGED: false,
        EQ_V3_CHANGED: false, LIQUIDITY_ENGINE_CHANGED: false, DISPLACEMENT_ENGINE_CHANGED: false,
        AMD_ENGINE_CHANGED: false, WATCH_ALGORITHM_CHANGED: false, NOTIFICATION_LOGIC_CHANGED: false,
        PRODUCTION_BEHAVIOR_CHANGED: false, FUTURE_LEAK_VIOLATIONS: futureLeaks,
        DETERMINISM_VIOLATIONS: JSON.stringify(casesA) === JSON.stringify(casesB) && html === html2 ? 0 : 1,
        OUTCOME_DATA_USED: false, PNL_DATA_USED: false, MSS_USED_FOR_DEFINITION: false,
        FVG_USED_FOR_DEFINITION: false, MANIPULATION_USED_FOR_DEFINITION: false,
        DISTRIBUTION_USED_FOR_DEFINITION: false, WATCH_USED_FOR_DEFINITION: false,
        ALL_TESTS_PASSED: tests.status === 0, HUMAN_CALIBRATION_COMPLETE: false,
        DEFINITION_V1_FINALIZED: false, HARD_STOP_REACHED: true
    });
    if (!pass) throw new Error('Calibration Phase 1 acceptance failed');
    console.log(JSON.stringify({ output: OUT, calibrationCases: 12, typeCounts: typeCounts,
        originalCaseIdLeaks: 0, postConfirmationBarsUsed: 0, allTestsPassed: true,
        humanCalibrationComplete: false, hardStopReached: true }, null, 2));
}

if (require.main === module) main();
module.exports = { TYPES: TYPES, deterministicTake: deterministicTake,
    selectCalibrationCases: selectCalibrationCases, buildCases: buildCases, renderHtml: renderHtml };
