'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');
var chartSource = require('./accumulationGroundTruthConsistencyAuditV2');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-ground-truth-v2-full-relabel-v1');
var GT_V1 = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var MANIFEST = path.join(ROOT, 'accumulation-detection-research-v1', 'sample-manifest.json');
var CANDLES = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var DEFINITION = path.join(ROOT, 'accumulation-ground-truth-v2-definition-calibration-v1', 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1.md');
var DEFINITION_ACCEPTANCE = path.join(ROOT, 'accumulation-ground-truth-v2-definition-calibration-v1', 'definition-acceptance.json');
var ORDER_SEED = 'ACCUMULATION_GROUND_TRUTH_V2_FULL_RELABEL_V1_ORDER_20260828';
var SOURCE_COMMIT = '438a26f9f43294eb960662e1fd0f1cca04a301f9';
var REVIEW_FIELDS = ['blindId', 'formationClass', 'confidence', 'independentBalance', 'twoSidedAuction',
    'previousTrendSeparation', 'oneSidedResidence', 'valueMigration', 'excursionContext', 'definitionEdgeCase', 'why'];

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return sha(fs.readFileSync(file)); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }

function validateUniverse(groundTruth, manifest) {
    var v1Ids = groundTruth.map(function (row) { return row.caseId; });
    var sourceIds = new Set(manifest.map(function (row) { return row.caseId; }));
    var duplicates = v1Ids.filter(function (id, index) { return v1Ids.indexOf(id) !== index; });
    var missing = v1Ids.filter(function (id) { return !sourceIds.has(id); });
    var expected = new Set(v1Ids);
    var selectedSourceIds = manifest.filter(function (row) { return expected.has(row.caseId); }).map(function (row) { return row.caseId; });
    var extra = selectedSourceIds.filter(function (id) { return !expected.has(id); });
    if (groundTruth.length !== 60 || new Set(v1Ids).size !== 60 || missing.length || extra.length) {
        throw new Error('V1/V2 relabel case universe mismatch');
    }
    return { caseUniverseSizeV1: v1Ids.length, caseUniverseSizeV2Relabel: selectedSourceIds.length,
        missingCases: missing, extraCases: extra, duplicateCases: Array.from(new Set(duplicates)),
        v1UniverseSha256: sha(JSON.stringify(v1Ids.slice().sort())),
        v2RelabelUniverseSha256: sha(JSON.stringify(selectedSourceIds.slice().sort())) };
}

function deterministicOrder(groundTruth) {
    return groundTruth.map(function (row) { return row.caseId; }).sort(function (a, b) {
        return sha(ORDER_SEED + '|' + a).localeCompare(sha(ORDER_SEED + '|' + b)) || a.localeCompare(b);
    });
}

function buildCases(groundTruth, manifest, candles) {
    validateUniverse(groundTruth, manifest);
    var sourceById = Object.fromEntries(manifest.map(function (row) { return [row.caseId, row]; }));
    var gtById = Object.fromEntries(groundTruth.map(function (row) { return [row.caseId, row]; }));
    return deterministicOrder(groundTruth).map(function (originalCaseId, index) {
        var source = sourceById[originalCaseId], row = source.row;
        var contextStart = Math.max(0, row.startIndex - 24);
        var blindId = 'A2-BLIND-' + String(index + 1).padStart(3, '0');
        var anonymous = { blindId: blindId, symbol: row.symbol, timeframe: row.timeframe,
            formationStartAt: row.formationStartAt, formationConfirmedAt: row.confirmedAt,
            rangeHigh: row.rangeHighAtConfirmation, rangeLow: row.rangeLowAtConfirmation,
            rangeMid: row.rangeMidAtConfirmation, contextBarCount: row.startIndex - contextStart,
            formationBarCount: row.endIndex - row.startIndex + 1,
            bars: candles.slice(contextStart, row.endIndex + 1).map(function (bar, localIndex) {
                return { time: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high,
                    low: bar.low, close: bar.close, formation: localIndex >= row.startIndex - contextStart };
            }) };
        return { blindId: blindId, originalCaseId: originalCaseId,
            frozenGroundTruthV1: gtById[originalCaseId].humanLabel, anonymous: anonymous };
    });
}

function select(name, title, options) {
    return '<label class="field"><b>' + esc(title) + '</b><select name="' + name + '"><option value="" selected disabled>请选择</option>' +
        options.map(function (value) { return '<option value="' + value + '">' + value + '</option>'; }).join('') + '</select></label>';
}

function frozenDefinitionHtml() {
    return '<section class="definition"><h1>FROZEN DEFINITION V1</h1><blockquote>Accumulation is a formation where price establishes a relatively independent balance and demonstrates coherent two-sided auction, without sustained directional value migration dominating the formation.</blockquote>' +
        '<div class="roles"><div><h3>Required Core</h3><p>Independent Balance + Coherent Two-Sided Auction</p></div><div><h3>Contextual</h3><p>Previous Trend Separation</p></div><div><h3>Strong Negative Evidence</h3><p>One-Sided Residence + Persistent Value Migration</p></div><div><h3>Quality Context</h3><p>Reabsorption</p></div></div>' +
        '<h2>Frozen classes</h2><p><b>CLEAR_A：</b>两个核心语义均明确成立。允许 temporary migration、excursion、irregular path 与 asymmetric touches，只要没有破坏整体 balance identity。</p>' +
        '<p><b>BORDERLINE_A：</b>必须有真实 accumulation evidence，但至少一个核心语义为 PARTIAL、形成较晚或连贯性不足。不是“不知道放哪里”。</p>' +
        '<p><b>NO_A：</b>没有形成足够独立、连贯的 accumulation auction。Bounding box、compression 或 center stability 本身都不等于 accumulation。</p>' +
        '<p><b>UNSURE：</b>定义无法稳定处理时保留，并标记 Definition Edge Case；不得自动转为 BORDERLINE_A。</p>' +
        '<p class="order"><b>判断顺序：</b>1. Independent Balance　2. Coherent Two-Sided Auction　3. Negative / Quality Context　4. Final Formation Class</p></section>';
}

function renderHtml(cases) {
    var cards = cases.map(function (item) {
        return '<article class="case" id="' + item.blindId + '"><header><h2>' + item.blindId + '</h2><span>BTCUSDT · 5m · formation-only</span></header>' +
            chartSource.chartSvg({ anonymous: item.anonymous }) + '<section class="review"><div class="grid">' +
            select('formationClass', 'A · Formation Class', ['CLEAR_A', 'BORDERLINE_A', 'NO_A', 'UNSURE']) +
            select('confidence', 'B · Confidence', ['HIGH', 'MEDIUM', 'LOW']) +
            select('independentBalance', 'C · Independent Balance', ['YES', 'PARTIAL', 'NO', 'UNSURE']) +
            select('twoSidedAuction', 'D · Two-Sided Auction', ['COHERENT', 'PARTIAL', 'WEAK', 'ABSENT', 'UNSURE']) +
            select('previousTrendSeparation', 'E · Previous Trend Separation', ['CLEARLY_SEPARATED', 'PARTIALLY_SEPARATED', 'NOT_SEPARATED', 'NO_CLEAR_PREVIOUS_TREND', 'UNSURE']) +
            select('oneSidedResidence', 'F · One-Sided Residence', ['NONE', 'MILD', 'STRONG', 'UNSURE']) +
            select('valueMigration', 'G · Value Migration', ['NONE', 'TEMPORARY', 'PERSISTENT', 'IRREGULAR', 'UNSURE']) +
            select('excursionContext', 'H · Excursion Context', ['REABSORBED_WITHIN_BALANCE', 'PARTIAL_REABSORPTION', 'FAILED_BUT_BALANCE_SURVIVES', 'FAILED_AND_BALANCE_BREAKS_DOWN', 'NO_CLEAR_EXCURSION', 'UNSURE']) +
            select('definitionEdgeCase', 'I · Definition Edge Case', ['YES', 'NO']) +
            '</div><label class="why"><b>J · Why（1–3 sentences, formation-only）</b><textarea name="why" placeholder="描述 formation 的 balance / auction narrative。"></textarea></label>' +
            '<p class="semantic-warning" hidden></p></section></article>';
    }).join('\n');
    var publicCases = cases.map(function (item) { return { blindId: item.blindId }; });
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accumulation Ground Truth V2 Full Relabel</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#040913;color:#eaf2fa}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#071321,#03070d)}nav{position:sticky;top:0;z-index:8;display:flex;gap:12px;align-items:center;padding:13px 20px;background:#071523f5;border-bottom:1px solid #29445e}nav strong{margin-right:auto}button{border:0;border-radius:8px;padding:10px 15px;background:#2785ca;color:#fff;font-weight:750}button:disabled{opacity:.4}.wrap{max-width:1200px;margin:auto;padding:18px}.definition,.case{background:#0a1827;border:1px solid #2b455f;border-radius:14px;margin:22px 0;overflow:hidden}.definition{padding:20px}.definition blockquote{margin:12px 0;padding:13px 16px;border-left:4px solid #e8c35f;background:#102235;line-height:1.6}.roles{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.roles div{padding:11px;background:#10283a;border-radius:9px}.roles h3{margin:0 0 5px;color:#80c8ff}.roles p{margin:0}.order{color:#f2d987}.case header{display:flex;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #263e56}.case h2{margin:0;color:#78c3ff}.case header span{color:#9cb0c3}.review{padding:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.field,.why{display:grid;gap:6px}.field b,.why b{font-size:12px;color:#bad0e3}select,textarea{width:100%;padding:9px;background:#06111d;color:#edf5fc;border:1px solid #365670;border-radius:8px}textarea{min-height:78px;resize:vertical}.semantic-warning{color:#ffcb6b;background:#33240d;border-radius:7px;padding:9px}.done{color:#62dfa8}.pending{color:#ffd06f}svg{display:block;width:100%;height:auto}@media(max-width:760px){nav strong{display:none}.wrap{padding:7px}.grid,.roles{grid-template-columns:1fr}.case header{display:grid;gap:6px}}</style></head><body><nav><strong>Accumulation Ground Truth V2 · Full 60-Case Blind Relabel</strong><span id="progress" class="pending">0 / 60 complete</span><button id="export" disabled>导出 Blind Review JSON</button></nav><main class="wrap">' + frozenDefinitionHtml() + cards + '</main><script>' +
        'const cases=' + JSON.stringify(publicCases) + ';const state={};const fields=' + JSON.stringify(REVIEW_FIELDS.slice(1)) + ';const root=id=>document.getElementById(id);function collect(id){const el=root(id),v=n=>el.querySelector(`[name="${n}"]`).value;return{blindId:id,formationClass:v("formationClass"),confidence:v("confidence"),independentBalance:v("independentBalance"),twoSidedAuction:v("twoSidedAuction"),previousTrendSeparation:v("previousTrendSeparation"),oneSidedResidence:v("oneSidedResidence"),valueMigration:v("valueMigration"),excursionContext:v("excursionContext"),definitionEdgeCase:v("definitionEdgeCase"),why:el.querySelector(`[name="why"]`).value.trim()}}function complete(x){return fields.every(k=>Boolean(x[k]))}function contradiction(x){const out=[];if(x.formationClass==="CLEAR_A"&&(x.independentBalance!=="YES"||x.twoSidedAuction!=="COHERENT"))out.push("CORE_SEMANTIC_CONTRADICTION：CLEAR_A 通常需要 YES + COHERENT；答案仍会原样保存。");if(x.formationClass==="NO_A"&&x.independentBalance==="YES"&&x.twoSidedAuction==="COHERENT")out.push("CORE_SEMANTIC_CONTRADICTION：NO_A 与完整核心语义并存；答案仍会原样保存。");if(x.formationClass==="BORDERLINE_A"&&x.independentBalance==="NO"&&["WEAK","ABSENT"].includes(x.twoSidedAuction))out.push("BORDERLINE_WITHOUT_ACCUMULATION_EVIDENCE：请复核，但答案不会自动修改。");return out}function refresh(){cases.forEach(c=>{const x=collect(c.blindId),box=root(c.blindId).querySelector(".semantic-warning"),messages=contradiction(x);state[c.blindId]=x;box.textContent=messages.join(" ");box.hidden=!messages.length});const n=Object.values(state).filter(complete).length,progress=document.querySelector("#progress");progress.textContent=`${n} / ${cases.length} complete`;progress.className=n===cases.length?"done":"pending";document.querySelector("#export").disabled=n!==cases.length}document.querySelectorAll("select,textarea").forEach(el=>{el.addEventListener("change",refresh);el.addEventListener("input",refresh)});document.querySelector("#export").onclick=()=>{refresh();if(!Object.values(state).every(complete))return;const payload={schemaVersion:"ACCUMULATION_GROUND_TRUTH_V2_BLIND_REVIEW_V1",definitionVersion:"ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1",reviewedAt:new Date().toISOString(),responses:cases.map(c=>state[c.blindId])};const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));a.download="accumulation-ground-truth-v2-blind-review-results.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};refresh();</script></body></html>\n';
}

function uiLeakAudit(html, originalIds) {
    var metadataTokens = ['frozenGroundTruthV1', 'humanLabel', 'previousBlindLabel', 'prototypeDecision',
        'detectorScore', 'featureSnapshot', 'sourceCandidateId', 'selectionType', 'CAL-01',
        'EQH', 'EQL', 'Sweep', 'MSS', 'Displacement', 'FVG', 'WATCH', 'PnL', 'future reaction'];
    var shortFeatureLeaks = ['F6', 'F7'].filter(function (token) {
        return new RegExp('(^|[^A-Z0-9])' + token + '([^A-Z0-9]|$)', 'i').test(html);
    });
    return { originalCaseIds: originalIds.filter(function (id) { return html.includes(id); }),
        metadataTokens: metadataTokens.filter(function (token) { return html.toLowerCase().includes(token.toLowerCase()); })
            .concat(shortFeatureLeaks) };
}

function main() {
    fs.mkdirSync(OUT, { recursive: true });
    var gtHashBefore = shaFile(GT_V1);
    var definitionAcceptance = JSON.parse(fs.readFileSync(DEFINITION_ACCEPTANCE, 'utf8'));
    if (definitionAcceptance.ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_CALIBRATION_V1_SYNTHESIS !== 'PASS' ||
        definitionAcceptance.DEFINITION_V1_READY_FOR_FREEZE !== true || definitionAcceptance.DEFINITION_V1_FROZEN !== false) {
        throw new Error('Definition V1 is not ready for explicit freeze');
    }
    var groundTruth = JSON.parse(fs.readFileSync(GT_V1, 'utf8'));
    var manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    var candles = JSON.parse(fs.readFileSync(CANDLES, 'utf8'));
    var universe = validateUniverse(groundTruth, manifest);
    var casesA = buildCases(groundTruth, manifest, candles), casesB = buildCases(groundTruth, manifest, candles);
    var htmlA = renderHtml(casesA), htmlB = renderHtml(casesB);
    var deterministic = JSON.stringify(casesA) === JSON.stringify(casesB) && htmlA === htmlB;
    var leaks = uiLeakAudit(htmlA, groundTruth.map(function (row) { return row.caseId; }));
    var futureLeaks = casesA.reduce(function (count, item) { return count + item.anonymous.bars.filter(function (bar) {
        return bar.closeTime > item.anonymous.formationConfirmedAt;
    }).length; }, 0);
    var blindIds = casesA.map(function (item) { return item.blindId; });
    if (!deterministic || casesA.length !== 60 || new Set(blindIds).size !== 60 || leaks.originalCaseIds.length ||
        leaks.metadataTokens.length || futureLeaks) throw new Error('Blind relabel safety validation failed');

    fs.writeFileSync(path.join(OUT, 'definition-v1-frozen.md'), fs.readFileSync(DEFINITION));
    writeJson('relabel-config.json', { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_FULL_RELABEL_V1',
        definitionVersion: 'ACCUMULATION_GROUND_TRUTH_V2_DEFINITION_V1', definitionV1Frozen: true,
        definitionSha256: shaFile(DEFINITION), sourceCommit: SOURCE_COMMIT, orderSeed: ORDER_SEED,
        population: 'V1_60_MACHINE_POSITIVE_REVIEWED_CASES', timeframe: '5m', symbol: 'BTCUSDT',
        maximumPreFormationBars: 24, postConfirmationBarsUsed: 0, reviewOrderFrozen: true,
        reviewOrderReselected: false, responsesPrepopulated: false, outcomeUsed: false });
    writeJson('case-universe-validation.json', { schemaVersion: 'ACCUMULATION_GT_V2_RELABEL_CASE_UNIVERSE_V1',
        CASE_UNIVERSE_SIZE_V1: universe.caseUniverseSizeV1,
        CASE_UNIVERSE_SIZE_V2_RELABEL: universe.caseUniverseSizeV2Relabel,
        MISSING_CASES: universe.missingCases.length, MISSING_CASE_IDS: universe.missingCases,
        EXTRA_CASES: universe.extraCases.length, EXTRA_CASE_IDS: universe.extraCases,
        DUPLICATE_CASES: universe.duplicateCases.length, DUPLICATE_CASE_IDS: universe.duplicateCases,
        V1_UNIVERSE_SHA256: universe.v1UniverseSha256, V2_RELABEL_UNIVERSE_SHA256: universe.v2RelabelUniverseSha256,
        UNIVERSE_IDENTICAL: universe.v1UniverseSha256 === universe.v2RelabelUniverseSha256 });
    writeJson('blind-case-map.json', { schemaVersion: 'ACCUMULATION_GT_V2_FULL_RELABEL_BLIND_MAP_V1',
        uiLoadsThisFile: false, orderSeed: ORDER_SEED,
        cases: casesA.map(function (item) { return { blindId: item.blindId,
            originalCaseId: item.originalCaseId, frozenGroundTruthV1: item.frozenGroundTruthV1 }; }) });
    writeJson('blind-review-order.json', { schemaVersion: 'ACCUMULATION_GT_V2_FULL_RELABEL_ORDER_V1',
        orderSeed: ORDER_SEED, reviewOrderFrozen: true, reviewOrderReselected: false,
        blindIds: blindIds, orderSha256: sha(JSON.stringify(blindIds)) });
    fs.writeFileSync(path.join(OUT, 'accumulation-ground-truth-v2-full-relabel.html'), htmlA);
    writeJson('review-export-schema.json', { schemaVersion: 'ACCUMULATION_GROUND_TRUTH_V2_BLIND_REVIEW_EXPORT_SCHEMA_V1',
        outputFilename: 'accumulation-ground-truth-v2-blind-review-results.json', requiredCases: 60,
        requiredFields: REVIEW_FIELDS, additionalProperties: false,
        forbiddenFields: ['originalCaseId', 'frozenGroundTruthV1', 'previousBlindLabel', 'machineFeatures', 'outcome'] });
    writeJson('blindness-validation.json', { schemaVersion: 'ACCUMULATION_GT_V2_FULL_RELABEL_BLINDNESS_V1',
        htmlSha256: sha(htmlA), blindReviewCases: casesA.length,
        originalCaseIdLeaks: leaks.originalCaseIds, metadataLeaks: leaks.metadataTokens,
        oldLabelLeaks: 0, machineFeatureLeaks: 0, outcomeLeaks: 0,
        postConfirmationBarsUsed: 0, futureLeakViolations: futureLeaks,
        humanResponsesPrepopulated: false, uiLoadsBlindCaseMap: false,
        htmlDeterministic: htmlA === htmlB, mappingDeterministic: JSON.stringify(casesA) === JSON.stringify(casesB) });
    fs.writeFileSync(path.join(OUT, 'README.md'), '# Accumulation Ground Truth V2 — Full 60-Case Relabel V1\n\n' +
        'Phase 1 contains a true-blind, formation-only UI for all 60 frozen V1-universe cases.\n\n' +
        '1. Open `accumulation-ground-truth-v2-full-relabel.html`.\n' +
        '2. Apply the frozen Definition V1 in the displayed decision order.\n' +
        '3. Complete all fields for all 60 blind cases.\n' +
        '4. Export `accumulation-ground-truth-v2-blind-review-results.json`.\n' +
        '5. Return the JSON for the separately gated Phase 2 unblind.\n\n' +
        'No old label, machine feature, outcome, or post-confirmation candle is displayed.\n');

    var dedicated = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'accumulationGroundTruthV2FullRelabelV1.test.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    var full = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')],
        { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    var pass = dedicated.status === 0 && full.status === 0 && gtHashBefore === shaFile(GT_V1) && deterministic &&
        universe.caseUniverseSizeV1 === 60 && universe.caseUniverseSizeV2Relabel === 60 &&
        leaks.originalCaseIds.length === 0 && leaks.metadataTokens.length === 0 && futureLeaks === 0;
    writeJson('test-results-phase1.json', {
        dedicated: { command: 'node test/accumulationGroundTruthV2FullRelabelV1.test.js', exitCode: dedicated.status,
            passed: dedicated.status === 0, stdout: dedicated.stdout, stderr: dedicated.stderr },
        fullRegression: { command: 'node test/run.js', exitCode: full.status, passed: full.status === 0,
            stdoutSha256: sha(full.stdout || ''), stdoutTail: String(full.stdout || '').split('\n').slice(-35), stderr: full.stderr }
    });
    writeJson('acceptance-phase1.json', {
        ACCUMULATION_GROUND_TRUTH_V2_FULL_RELABEL_V1_PHASE1: pass ? 'PASS' : 'FAIL',
        DEFINITION_V1_FROZEN: true,
        CASE_UNIVERSE_SIZE_V1: 60, CASE_UNIVERSE_SIZE_V2_RELABEL: 60,
        MISSING_CASES: universe.missingCases.length, EXTRA_CASES: universe.extraCases.length,
        DUPLICATE_CASES: universe.duplicateCases.length, BLIND_REVIEW_CASES: 60,
        ORIGINAL_CASE_ID_LEAKS: leaks.originalCaseIds.length, OLD_LABEL_LEAKS: 0,
        MACHINE_FEATURE_LEAKS: 0, OUTCOME_LEAKS: 0, POST_CONFIRMATION_BARS_USED: 0,
        HUMAN_RESPONSES_PREPOPULATED: false, REVIEW_ORDER_FROZEN: true,
        REVIEW_ORDER_RESELECTED: false, DETERMINISM_VIOLATIONS: deterministic ? 0 : 1,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, GROUND_TRUTH_V1_CHANGED: false,
        GROUND_TRUTH_V2_CREATED: false, PRODUCTION_BEHAVIOR_CHANGED: false,
        ALL_TESTS_PASSED: dedicated.status === 0 && full.status === 0,
        HUMAN_REVIEW_COMPLETE: false, PHASE_2_UNBLIND: 'BLOCKED_PENDING_HUMAN_REVIEW',
        HARD_STOP_REACHED: true
    });
    if (!pass) throw new Error('Full relabel Phase 1 acceptance failed');
    console.log(JSON.stringify({ output: OUT, blindCases: 60, universeIdentical: true,
        definitionV1Frozen: true, originalCaseIdLeaks: 0, postConfirmationBarsUsed: 0,
        allTestsPassed: true, humanReviewComplete: false,
        phase2Unblind: 'BLOCKED_PENDING_HUMAN_REVIEW', hardStopReached: true }, null, 2));
}

if (require.main === module) main();
module.exports = { validateUniverse: validateUniverse, deterministicOrder: deterministicOrder,
    buildCases: buildCases, renderHtml: renderHtml, uiLeakAudit: uiLeakAudit,
    ORDER_SEED: ORDER_SEED, REVIEW_FIELDS: REVIEW_FIELDS };
