'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var cp = require('child_process');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var GT_FILE = path.join(ROOT, 'accumulation-comparative-audit-v1', 'human-ground-truth-v1-final.json');
var BASELINE_FILE = path.join(ROOT, 'accumulation-detection-research-v1', 'baseline-config.json');
var SOURCE_MANIFEST = path.join(ROOT, 'accumulation-detection-research-v1', 'sample-manifest.json');
var CANDLES_FILE = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-ground-truth-consistency-audit-v2');
var SELECTION_SEED = 'ACCUMULATION_GT_CONSISTENCY_V2_COVERAGE_20260828';
var ORDER_SEED = 'ACCUMULATION_GT_CONSISTENCY_V2_BLIND_ORDER_20260828';
var LABELS = ['CLEAR_A', 'BORDERLINE_A', 'NO_A'];
var DIVERSITY_FIELDS = ['durationBars', 'rangeWidthATR', 'midCrossCount', 'upperTouchCount', 'lowerTouchCount'];
var PRIOR_CONFLICTS = new Set(['case026', 'case034', 'case040', 'case049', 'case023', 'case042', 'case043']);
var FORBIDDEN_UI_METADATA = ['frozenGroundTruth', 'originalCaseId', 'prototypeDecision', 'conflictType',
    'priorConflict', 'primaryOrAnchor', 'humanLabel', 'detectorLabel', 'sourceCandidateId'];

function ensureDir() { fs.mkdirSync(OUT, { recursive: true }); }
function writeJson(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function shaText(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function shaFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function esc(value) { return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function iso(value) { return new Date(value).toISOString(); }

function normalizedVectors(rows, fields) {
    var bounds = {};
    fields.forEach(function (field) {
        var values = rows.map(function (row) { return Number(row.features[field]); });
        bounds[field] = { min: Math.min.apply(null, values), max: Math.max.apply(null, values) };
    });
    var result = {};
    rows.forEach(function (row) {
        result[row.caseId] = fields.map(function (field) {
            var b = bounds[field], value = Number(row.features[field]);
            return b.max === b.min ? 0 : (value - b.min) / (b.max - b.min);
        });
    });
    return result;
}

function distance(a, b) {
    return Math.sqrt(a.reduce(function (sum, value, index) { return sum + Math.pow(value - b[index], 2); }, 0));
}

function coverageSample(rows, count, seed, fields) {
    if (rows.length < count) throw new Error('Insufficient cohort rows');
    var vectors = normalizedVectors(rows, fields), remaining = rows.slice();
    remaining.sort(function (a, b) { return shaText(seed + '|start|' + a.caseId).localeCompare(shaText(seed + '|start|' + b.caseId)); });
    var selected = [remaining.shift()];
    while (selected.length < count) {
        remaining.sort(function (a, b) {
            function nearest(row) { return Math.min.apply(null, selected.map(function (chosen) {
                return distance(vectors[row.caseId], vectors[chosen.caseId]);
            })); }
            var delta = nearest(b) - nearest(a);
            if (Math.abs(delta) > 1e-12) return delta;
            return shaText(seed + '|tie|' + a.caseId).localeCompare(shaText(seed + '|tie|' + b.caseId));
        });
        selected.push(remaining.shift());
    }
    return selected;
}

function selectPrimary(groundTruth, sourceManifest) {
    var sourceById = {};
    sourceManifest.forEach(function (item) { sourceById[item.caseId] = item; });
    var selected = [];
    LABELS.forEach(function (label) {
        var cohort = groundTruth.filter(function (row) { return row.humanLabel === label; }).map(function (gt) {
            var source = sourceById[gt.caseId];
            if (!source) throw new Error('Missing formation source for ' + gt.caseId);
            return { caseId: gt.caseId, frozenGroundTruth: label, source: source,
                features: {
                    durationBars: source.row.features.durationBars,
                    rangeWidthATR: source.row.features.rangeWidthATR,
                    midCrossCount: source.row.features.midCrossCount,
                    upperTouchCount: source.row.features.upperTouchCount,
                    lowerTouchCount: source.row.features.lowerTouchCount
                } };
        });
        selected = selected.concat(coverageSample(cohort, 8, SELECTION_SEED + '|' + label, DIVERSITY_FIELDS));
    });
    return selected;
}

function blindOrder(selected) {
    return selected.slice().sort(function (a, b) {
        return shaText(ORDER_SEED + '|' + a.caseId).localeCompare(shaText(ORDER_SEED + '|' + b.caseId)) ||
            a.caseId.localeCompare(b.caseId);
    });
}

function buildCases(groundTruth, sourceManifest, candles) {
    var selected = selectPrimary(groundTruth, sourceManifest), ordered = blindOrder(selected);
    return ordered.map(function (selectedRow, index) {
        var row = selectedRow.source.row, contextStart = Math.max(0, row.startIndex - 24);
        return {
            originalCaseId: selectedRow.caseId,
            frozenGroundTruth: selectedRow.frozenGroundTruth,
            primaryOrAnchor: 'PRIMARY',
            samplingDescriptors: selectedRow.features,
            anonymous: {
                blindId: 'GT-BLIND-' + String(index + 1).padStart(2, '0'),
                symbol: row.symbol,
                timeframe: row.timeframe,
                formationStartAt: row.formationStartAt,
                formationConfirmedAt: row.confirmedAt,
                rangeHigh: row.rangeHighAtConfirmation,
                rangeLow: row.rangeLowAtConfirmation,
                rangeMid: row.rangeMidAtConfirmation,
                contextBarCount: row.startIndex - contextStart,
                formationBarCount: row.endIndex - row.startIndex + 1,
                bars: candles.slice(contextStart, row.endIndex + 1).map(function (bar, localIndex) {
                    return { time: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high,
                        low: bar.low, close: bar.close, formation: localIndex >= row.startIndex - contextStart };
                })
            }
        };
    });
}

function chartSvg(item) {
    var row = item.anonymous, bars = row.bars, width = 1080, height = 390;
    var left = 68, right = 25, top = 28, bottom = 54, plotW = width - left - right, plotH = height - top - bottom;
    var prices = [row.rangeHigh, row.rangeLow];
    bars.forEach(function (bar) { prices.push(bar.high, bar.low); });
    var min = Math.min.apply(null, prices), max = Math.max.apply(null, prices), rawSpan = max - min;
    var pad = rawSpan > 0 ? rawSpan * 0.08 : Math.max(1, max * 0.001), yMin = min - pad, yMax = max + pad;
    function x(index) { return left + (index + 0.5) * plotW / bars.length; }
    function boundary(index) { return left + index * plotW / bars.length; }
    function y(price) { return top + (yMax - price) * plotH / (yMax - yMin); }
    var bodyW = Math.max(2, Math.min(13, plotW / bars.length * 0.58)), formationStart = row.contextBarCount, p = [];
    p.push('<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(row.blindId) + ' formation chart">');
    p.push('<rect width="100%" height="100%" fill="#07111f"/>');
    if (formationStart) p.push('<rect x="' + left + '" y="' + top + '" width="' + (formationStart * plotW / bars.length) + '" height="' + plotH + '" fill="#8b99aa" opacity="0.13"/>');
    p.push('<rect x="' + boundary(formationStart) + '" y="' + top + '" width="' + ((bars.length - formationStart) * plotW / bars.length) + '" height="' + plotH + '" fill="#2a7bc4" opacity="0.08"/>');
    [row.rangeHigh, row.rangeMid, row.rangeLow].forEach(function (price, index) {
        p.push('<line x1="' + left + '" y1="' + y(price) + '" x2="' + (width - right) + '" y2="' + y(price) + '" stroke="' + (index === 1 ? '#8ca2b8' : '#52a8ef') + '" stroke-width="1.4" stroke-dasharray="7 5"/>');
        p.push('<text x="' + (width - right - 4) + '" y="' + (y(price) - 5) + '" text-anchor="end" fill="' + (index === 1 ? '#a9b9c9' : '#69b9fa') + '" font-size="11">' + Number(price).toFixed(1) + '</text>');
    });
    p.push('<line x1="' + boundary(formationStart) + '" y1="' + top + '" x2="' + boundary(formationStart) + '" y2="' + (top + plotH) + '" stroke="#b6c0cc" stroke-width="2"/>');
    p.push('<text x="' + (boundary(formationStart) - 7) + '" y="' + (top + 15) + '" text-anchor="end" fill="#9eabb8" font-size="11">PRE-CONTEXT</text>');
    p.push('<text x="' + (boundary(formationStart) + 7) + '" y="' + (top + 15) + '" fill="#7fc5ff" font-size="11">FORMATION START</text>');
    bars.forEach(function (bar, index) {
        var color = bar.close >= bar.open ? '#3ad69a' : '#ff6a7d', cx = x(index);
        p.push('<line x1="' + cx + '" y1="' + y(bar.high) + '" x2="' + cx + '" y2="' + y(bar.low) + '" stroke="' + color + '" stroke-width="1.2"/>');
        p.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(bar.open), y(bar.close)) + '" width="' + bodyW + '" height="' + Math.max(1.3, Math.abs(y(bar.open) - y(bar.close))) + '" fill="' + color + '"/>');
    });
    p.push('<line x1="' + boundary(bars.length) + '" y1="' + top + '" x2="' + boundary(bars.length) + '" y2="' + (top + plotH) + '" stroke="#f3c85b" stroke-width="3"/>');
    p.push('<text x="' + (width - right) + '" y="' + (top + plotH + 22) + '" text-anchor="end" fill="#f3c85b" font-size="11">FORMATION CONFIRMED · ' + esc(iso(row.formationConfirmedAt)) + '</text>');
    p.push('<text x="' + left + '" y="' + (height - 10) + '" fill="#8da3b8" font-size="11">灰色：确认前上下文（最多 24 根） · 蓝色：形成窗口 · 右侧金线：严格截止</text></svg>');
    return p.join('');
}

function select(name, title, options) {
    return '<label class="field"><b>' + esc(title) + '</b><select name="' + name + '"><option value="" selected disabled>请选择</option>' +
        options.map(function (option) { return '<option value="' + option + '">' + option + '</option>'; }).join('') + '</select></label>';
}

function renderHtml(cases) {
    var tags = ['STABLE_BOUNDARIES', 'INDEPENDENT_BALANCE', 'PARTIAL_BALANCE', 'TREND_PAUSE',
        'DIRECTIONAL_CONSOLIDATION', 'COHERENT_TWO_SIDED_AUCTION', 'WEAK_TWO_SIDED_AUCTION',
        'ONE_SIDED_RESIDENCE', 'CENTER_SHIFT_WITH_RETURN', 'CENTER_SHIFT_WITHOUT_RETURN', 'IRREGULAR_CHOP',
        'MULTIPLE_MICRO_BALANCES', 'LATE_BOUNDARY_EXPANSION', 'INSUFFICIENT_BALANCE_IDENTITY', 'OTHER'];
    var cards = cases.map(function (item) {
        var row = item.anonymous;
        return '<article class="case" id="' + row.blindId + '"><header><h2>' + row.blindId + '</h2><div><span>BTCUSDT · 5m</span><span>' + esc(iso(row.formationStartAt)) + ' → ' + esc(iso(row.formationConfirmedAt)) + '</span></div></header>' + chartSvg(item) +
            '<section class="review"><div class="grid">' +
            select('formationClass', 'Formation class', ['CLEAR_A', 'BORDERLINE_A', 'NO_A', 'UNSURE']) +
            select('confidence', 'Confidence', ['HIGH', 'MEDIUM', 'LOW']) +
            select('balanceQuality', 'Balance quality', ['STRONG', 'MODERATE', 'WEAK', 'NONE', 'UNSURE']) +
            select('independentBalanceFormed', 'Independent balance formed', ['YES', 'PARTIAL', 'NO', 'UNSURE']) +
            select('twoSidedAuction', 'Two-sided auction', ['COHERENT', 'PARTIAL', 'WEAK', 'ABSENT', 'UNSURE']) +
            select('trendPauseCharacter', 'Trend pause character', ['NONE', 'WEAK', 'MODERATE', 'STRONG', 'UNSURE']) +
            select('oneSidedResidence', 'One-sided residence', ['NONE', 'MILD', 'STRONG', 'UNSURE']) +
            select('centerBehavior', 'Center behavior', ['STABLE', 'TEMPORARY_SHIFT_THEN_RETURN', 'PERSISTENT_MIGRATION', 'IRREGULAR', 'UNSURE']) +
            select('excursionBehavior', 'Excursion behavior', ['REABSORBED', 'PARTIALLY_REABSORBED', 'FAILED_REABSORPTION', 'NO_CLEAR_EXCURSION', 'UNSURE']) +
            '</div><fieldset><legend>Human observation tags（可多选，可留空）</legend><div class="tags">' + tags.map(function (tag) {
                return '<label><input type="checkbox" name="observationTags" value="' + tag + '"><span>' + tag + '</span></label>';
            }).join('') + '</div></fieldset><label class="free"><b>Why or why not accumulation?（1–3 句）</b><textarea name="freeText" placeholder="只描述 formation narrative，不预测后续行情。"></textarea></label></section></article>';
    }).join('\n');
    var publicData = cases.map(function (item) { return { blindId: item.anonymous.blindId }; });
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accumulation Ground Truth Consistency Blind Review</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#050a12;color:#e9f1fa}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#06101d,#03070c)}nav{position:sticky;top:0;z-index:5;display:flex;gap:12px;align-items:center;padding:13px 22px;background:#071523f2;border-bottom:1px solid #29415a}nav strong{margin-right:auto}button{background:#2c8ad0;color:white;border:0;border-radius:8px;padding:10px 15px;font-weight:700}button:disabled{opacity:.45}.wrap{max-width:1200px;margin:auto;padding:20px}.intro{color:#a9bbcd}.case{background:#091624;border:1px solid #243c54;border-radius:14px;overflow:hidden;margin:28px 0;box-shadow:0 12px 40px #0005}.case header{padding:15px 18px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1d344b}.case h2{margin:0;color:#7fc5ff}.case header div{display:flex;gap:16px;color:#9fb1c4;font:12px ui-monospace,monospace}svg{display:block;width:100%;height:auto}.review{padding:16px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.field{display:grid;gap:6px}.field b,.free b{color:#b8cee3;font-size:12px}select,textarea{width:100%;background:#06111d;color:#e9f1fa;border:1px solid #36536e;border-radius:8px;padding:9px}.tags{display:flex;gap:7px;flex-wrap:wrap}.tags label{cursor:pointer}.tags input{position:absolute;opacity:0}.tags span{display:block;border:1px solid #36536e;background:#102337;border-radius:7px;padding:8px 10px;font-size:12px}.tags input:checked+span{border-color:#f0c85a;background:#57481f;color:#fff4bf}fieldset{border:1px solid #29435d;border-radius:10px;padding:12px}legend{color:#b8cee3;padding:0 6px;font-weight:700}textarea{min-height:90px;resize:vertical}.free{display:grid;gap:7px}.incomplete{outline:2px solid #ff6a7d}.done{color:#62dda6}.warn{color:#ffca67}@media(max-width:760px){nav strong{display:none}.wrap{padding:7px}.grid{grid-template-columns:1fr}.case header div{display:grid;gap:3px}}' +
        '</style></head><body><nav><strong>Accumulation Ground Truth Consistency · Blind Review</strong><span id="progress" class="warn">0 / 24 完成</span><button id="export" disabled>导出复核结果</button></nav><main class="wrap"><h1>24 个 Formation 样本</h1><p class="intro">请只根据 formation 判断。灰色区域是最多 24 根确认前上下文；图表在形成确认时严格截止。所有字段均须回答，观察标签可留空。</p>' + cards + '</main><script>' +
        'const cases=' + JSON.stringify(publicData) + ';const state={};const q=s=>document.querySelector(s);const qa=s=>Array.from(document.querySelectorAll(s));function collect(id){const root=document.getElementById(id);const v=n=>root.querySelector(`[name="${n}"]`).value;return{blindId:id,formationClass:v("formationClass"),confidence:v("confidence"),balanceQuality:v("balanceQuality"),independentBalanceFormed:v("independentBalanceFormed"),twoSidedAuction:v("twoSidedAuction"),trendPauseCharacter:v("trendPauseCharacter"),oneSidedResidence:v("oneSidedResidence"),centerBehavior:v("centerBehavior"),excursionBehavior:v("excursionBehavior"),observationTags:Array.from(root.querySelectorAll(`[name="observationTags"]:checked`)).map(x=>x.value),freeText:root.querySelector(`[name="freeText"]`).value.trim()}}function complete(r){return r.formationClass&&r.confidence&&r.balanceQuality&&r.independentBalanceFormed&&r.twoSidedAuction&&r.trendPauseCharacter&&r.oneSidedResidence&&r.centerBehavior&&r.excursionBehavior&&r.freeText}function refresh(){cases.forEach(c=>state[c.blindId]=collect(c.blindId));const n=Object.values(state).filter(complete).length;q("#progress").textContent=`${n} / ${cases.length} 完成`;q("#progress").className=n===cases.length?"done":"warn";q("#export").disabled=n!==cases.length}qa("input,select,textarea").forEach(x=>{x.addEventListener("change",refresh);x.addEventListener("input",refresh)});q("#export").onclick=()=>{refresh();const missing=cases.filter(c=>!complete(state[c.blindId])).map(c=>c.blindId);if(missing.length){missing.forEach(id=>document.getElementById(id).classList.add("incomplete"));return}const payload={schemaVersion:"ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2",reviewedAt:new Date().toISOString(),selectionSeed:' + JSON.stringify(SELECTION_SEED) + ',blindOrderSeed:' + JSON.stringify(ORDER_SEED) + ',reviews:cases.map(c=>state[c.blindId])};const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));a.download="ground-truth-consistency-review-results.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};refresh();' +
        '</script></body></html>\n';
}

function uiLeakAudit(html) {
    return { metadataTokens: FORBIDDEN_UI_METADATA.filter(function (token) { return html.indexOf(token) !== -1; }),
        originalCaseIds: Array.from(new Set(html.match(/case\d{3}/g) || [])) };
}

function main() {
    ensureDir();
    var gtHashBefore = shaFile(GT_FILE), gt = JSON.parse(fs.readFileSync(GT_FILE, 'utf8'));
    var sourceManifest = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf8'));
    var candles = JSON.parse(fs.readFileSync(CANDLES_FILE, 'utf8'));
    var counts = LABELS.reduce(function (out, label) { out[label] = gt.filter(function (row) { return row.humanLabel === label; }).length; return out; }, {});
    if (gt.length !== 60 || counts.CLEAR_A !== 32 || counts.BORDERLINE_A !== 12 || counts.NO_A !== 16) throw new Error('Frozen Ground Truth count mismatch');
    var casesA = buildCases(gt, sourceManifest, candles), casesB = buildCases(gt, sourceManifest, candles);
    if (JSON.stringify(casesA) !== JSON.stringify(casesB)) throw new Error('Determinism violation');
    var html = renderHtml(casesA), html2 = renderHtml(casesB), leaks = uiLeakAudit(html);
    if (html !== html2 || leaks.metadataTokens.length || leaks.originalCaseIds.length) throw new Error('Blind UI validation failed');
    var selectedCounts = LABELS.reduce(function (out, label) { out[label] = casesA.filter(function (row) { return row.frozenGroundTruth === label; }).length; return out; }, {});
    if (selectedCounts.CLEAR_A !== 8 || selectedCounts.BORDERLINE_A !== 8 || selectedCounts.NO_A !== 8) throw new Error('Stratification failed');
    var futureLeaks = casesA.reduce(function (count, item) { return count + item.anonymous.bars.filter(function (bar) {
        return bar.closeTime > item.anonymous.formationConfirmedAt;
    }).length; }, 0);
    if (futureLeaks) throw new Error('Future bars found');
    var priorSelected = casesA.filter(function (item) { return PRIOR_CONFLICTS.has(item.originalCaseId); }).map(function (item) { return item.originalCaseId; }).sort();
    var config = {
        schemaVersion: 'ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2', phase: 'PHASE_1_BLIND_REVIEW',
        primarySample: 24, hiddenRepeatAnchors: 0, totalUiCases: 24,
        sampleStratifiedBy: 'FROZEN_GROUND_TRUTH_ONLY', perCohortCount: 8,
        selectionSeed: SELECTION_SEED, blindOrderSeed: ORDER_SEED,
        selectionProcedureFrozenBeforeReview: true,
        selectionProcedure: 'Within each frozen cohort, min-max normalize the five allowed formation-only descriptors; choose a deterministic hash-seeded first case, then greedily maximize minimum Euclidean distance to selected cases with hash tie-breaks.',
        diversityFields: DIVERSITY_FIELDS,
        forbiddenSelectionInputs: ['prototypeDecision', 'F6/F7 conflict', 'outcome', 'future behavior', 'prior conflict membership'],
        sampleReselectedAfterReview: false,
        stabilityRules: { STABLE: 'exact agreement >= 0.75', MODERATELY_STABLE: '0.50 <= exact agreement < 0.75', UNSTABLE: 'exact agreement < 0.50' },
        groundTruthV2Trigger: { recommendationYesIfAny: ['overall consistency UNSTABLE', 'CLEAR cohort UNSTABLE', 'NO cohort UNSTABLE', 'HIGH confidence major disagreements >= 3'],
            otherwise: 'NO or BORDERLINE_ONLY_REVIEW when the issue is primarily BORDERLINE' },
        postConfirmationBarsUsed: 0, outcomeDataUsed: false
    };
    var map = { schemaVersion: 'ACCUMULATION_GT_CONSISTENCY_BLIND_MAP_V2', selectionSeed: SELECTION_SEED,
        blindOrderSeed: ORDER_SEED, uiLoadsThisFile: false, cases: casesA.map(function (item) {
            return { blindId: item.anonymous.blindId, originalCaseId: item.originalCaseId,
                primaryOrAnchor: item.primaryOrAnchor, frozenGroundTruth: item.frozenGroundTruth };
        }) };
    var publicManifest = { schemaVersion: 'ACCUMULATION_GT_CONSISTENCY_SAMPLE_MANIFEST_V2',
        primarySample: 24, hiddenRepeatAnchors: 0, cases: casesA.map(function (item) { return item.anonymous; }) };
    writeJson('sampling-config.json', config);
    writeJson('sample-manifest.json', publicManifest);
    writeJson('blind-case-map.json', map);
    fs.writeFileSync(path.join(OUT, 'ground-truth-consistency-blind-review.html'), html);
    fs.writeFileSync(path.join(OUT, 'README.md'), '# Accumulation Ground Truth Consistency Audit V2\n\n' +
        'Phase 1 contains 24 deterministic, stratified, formation-only blind reviews. No hidden repeat anchors are used.\n\n' +
        '1. Open `ground-truth-consistency-blind-review.html`.\n' +
        '2. Review all 24 anonymous formations in order.\n' +
        '3. Complete every required field and write 1–3 formation-only sentences.\n' +
        '4. Export `ground-truth-consistency-review-results.json`.\n' +
        '5. Return the exported JSON to Codex for the separately gated consistency analysis.\n\n' +
        'The form starts empty. The page does not load `blind-case-map.json`, contains no original case identifiers, and includes zero post-confirmation bars.\n');

    var productionFiles = [GT_FILE, BASELINE_FILE, path.join(__dirname, '..', 'amd', 'accumulationDetector.js'),
        path.join(__dirname, '..', 'amd', 'amdState.js'), path.join(__dirname, '..', 'config', 'thresholds.js'),
        path.join(__dirname, '..', 'events', 'displacementDetector.js'),
        path.join(__dirname, '..', 'liquidity', 'persistentEqualLiquidityV3.js'),
        path.join(__dirname, '..', 'live', 'liveEngine.js')];
    var before = productionFiles.map(shaFile);
    console.log('[Tests] full repository regression suite');
    var tests = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
    var after = productionFiles.map(shaFile), productionSame = JSON.stringify(before) === JSON.stringify(after);
    var pass = tests.status === 0 && productionSame && gtHashBefore === shaFile(GT_FILE) && casesA.length === 24 &&
        futureLeaks === 0 && leaks.metadataTokens.length === 0 && leaks.originalCaseIds.length === 0 && html === html2;
    writeJson('test-results-phase1.json', { command: 'node test/run.js', exitCode: tests.status,
        passed: tests.status === 0, stdoutSha256: shaText(tests.stdout || ''),
        stdoutTail: String(tests.stdout || '').split('\n').slice(-35), stderr: tests.stderr || '' });
    writeJson('acceptance-phase1.json', {
        ACCUMULATION_GROUND_TRUTH_CONSISTENCY_AUDIT_V2_PHASE1: pass ? 'PASS' : 'FAIL',
        PRIMARY_SAMPLE: 24, FROZEN_CLEAR_SAMPLE: 8, FROZEN_BORDERLINE_SAMPLE: 8, FROZEN_NO_SAMPLE: 8,
        HIDDEN_REPEAT_ANCHORS: 0, TOTAL_UI_CASES: 24,
        SAMPLE_STRATIFIED_BY: 'FROZEN_GROUND_TRUTH_ONLY', SAMPLE_RESELECTED_AFTER_REVIEW: false,
        PRIOR_CONFLICT_CASES_NATURALLY_SELECTED: priorSelected.length, PRIOR_CONFLICT_CASE_IDS: priorSelected,
        HUMAN_RESPONSES_PREPOPULATED: false, ORIGINAL_CASE_ID_LEAKS: leaks.originalCaseIds.length,
        BLIND_UI_METADATA_LEAKS: leaks.metadataTokens.length, POST_CONFIRMATION_BARS_USED: 0,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, DETERMINISM_VIOLATIONS: JSON.stringify(casesA) === JSON.stringify(casesB) && html === html2 ? 0 : 1,
        OUTCOME_DATA_USED: false, MANIPULATION_DATA_USED: false, DISTRIBUTION_DATA_USED: false,
        WATCH_DATA_USED: false, PNL_DATA_USED: false,
        GROUND_TRUTH_V1_CHANGED: false, BASELINE_CONFIG_CHANGED: false, ACCUMULATION_DETECTOR_CHANGED: false,
        REPRESENTATION_V2_CHANGED: false, EQ_V3_CHANGED: false, DISPLACEMENT_ENGINE_CHANGED: false,
        LIQUIDITY_ENGINE_CHANGED: false, AMD_ENGINE_CHANGED: false, WATCH_ALGORITHM_CHANGED: false,
        NOTIFICATION_LOGIC_CHANGED: false, PRODUCTION_BEHAVIOR_CHANGED: false,
        ALL_TESTS_PASSED: tests.status === 0, HUMAN_REVIEWS_COMPLETE: false,
        PHASE_2_CONSISTENCY_ANALYSIS: 'BLOCKED_PENDING_HUMAN_REVIEW', HARD_STOP_REACHED: true
    });
    if (!pass) throw new Error('Phase 1 acceptance failed');
    console.log(JSON.stringify({ output: OUT, primarySample: 24, hiddenAnchors: 0,
        selectedCounts: selectedCounts, priorConflictCasesNaturallySelected: priorSelected,
        originalCaseIdLeaks: 0, postConfirmationBarsUsed: 0, allTestsPassed: true,
        phase2: 'BLOCKED_PENDING_HUMAN_REVIEW' }, null, 2));
}

if (require.main === module) main();
module.exports = { DIVERSITY_FIELDS: DIVERSITY_FIELDS, normalizedVectors: normalizedVectors,
    coverageSample: coverageSample, selectPrimary: selectPrimary, blindOrder: blindOrder,
    buildCases: buildCases, chartSvg: chartSvg, renderHtml: renderHtml, uiLeakAudit: uiLeakAudit };
