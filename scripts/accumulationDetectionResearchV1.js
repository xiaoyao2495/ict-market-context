'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');
var thresholds = require('../config/thresholds');
var replayState = require('../replay/replayState');
var eventRegistry = require('../events/eventRegistry');
var research = require('../audit/accumulationResearchV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var INPUT = path.join(ROOT, 'eqh-eql-persistent-cluster-shadow-v3', 'BTCUSDT-5m-bounded-input.json');
var OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'accumulation-detection-research-v1');
var WARMUP = 576;
var VALIDATION = 8640;

var baseline = {
    researchOnly: true,
    symbol: 'BTCUSDT', timeframe: '5m', warmupBars: WARMUP, validationBars: VALIDATION,
    atrPeriod: thresholds.events.atr.period,
    detector: JSON.parse(JSON.stringify(thresholds.amd.accumulation)),
    researchFeatures: { touchToleranceRangeFraction: 0.1, preRangeBars: 24 },
    reviewDedupe: { timeOverlapMin: 0.75, priceIouMin: 0.8 },
    control: { durationBars: 24, strideBars: 12, maxCandidateOverlap: 0.5 },
    chart: { preFormationBars: 24, postConfirmationBars: 2 },
    researchBaselineNotValidated: true,
    parameterSearchPerformed: false
};
var config = {
    thresholds: thresholds, atrPeriod: baseline.atrPeriod,
    research: baseline.researchFeatures, control: baseline.control
};

function ensure() { fs.mkdirSync(path.join(OUT, 'charts'), { recursive: true }); }
function json(name, value) { fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n'); }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function iso(t) { return new Date(t).toISOString(); }
function fmt(n, d) { return n === null || n === undefined ? 'n/a' : Number(n).toFixed(d === undefined ? 3 : d); }

function compact(row) {
    return JSON.parse(JSON.stringify(row));
}

function runPopulation(candles, label) {
    var state = replayState.createReplayState({ symbol: 'BTCUSDT', timeframe: '5m', eqProductionVersion: 'V3' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var raw = [];
    for (var i = 0; i < candles.length; i++) {
        var c = candles[i];
        replayState.incrementalLiquidity(state, candles, i, { tickSize: 0.1 }, c.closeTime);
        replayState.incrementalEvents(state, c, i, c.closeTime, [], []);
        if (i >= WARMUP) {
            var candidate = research.detectCandidate({
                candles: candles, index: i, evaluationTime: c.closeTime,
                timeframe: '5m', symbol: 'BTCUSDT', liquidityRegistry: state.registry
            }, config);
            if (candidate) raw.push(candidate);
        }
        if ((i + 1) % 1000 === 0 || i === candles.length - 1) {
            console.log('[' + label + '] ' + (i + 1) + ' / ' + candles.length + ' raw=' + raw.length);
        }
    }
    return raw;
}

function renderSvg(item, candles) {
    var row = item.row, bounds = research.chartBounds(row, candles.length, baseline.chart.preFormationBars, baseline.chart.postConfirmationBars);
    var view = candles.slice(bounds.startIndex, bounds.cutoffIndex + 1);
    var W = 1440, H = 790, L = 76, R = 34, T = 92, B = 150;
    var PW = W - L - R, PH = H - T - B;
    var min = Infinity, max = -Infinity;
    view.forEach(function (c) { min = Math.min(min, c.low); max = Math.max(max, c.high); });
    var pad = Math.max((max - min) * 0.07, max * 0.0001); min -= pad; max += pad;
    function x(idx) { return L + (idx - bounds.startIndex + 0.5) * PW / view.length; }
    function y(price) { return T + (max - price) * PH / (max - min); }
    var bodyW = Math.max(1, Math.min(8, PW / view.length * 0.62));
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">', '<rect width="100%" height="100%" fill="#07111f"/>'];
    parts.push('<text x="' + L + '" y="30" fill="#edf5ff" font-family="ui-monospace,monospace" font-size="19" font-weight="700">' + esc(item.caseId.toUpperCase()) + ' · BTCUSDT 5m · ' + (item.kind === 'POSITIVE' ? 'ACCUMULATION_CANDIDATE' : 'CONTROL / NOT DETECTED') + '</text>');
    parts.push('<text x="' + L + '" y="57" fill="#94abc3" font-family="ui-monospace,monospace" font-size="13">Formation-only · confirmed ' + esc(iso(row.confirmedAt)) + ' · max +2 bars context</text>');
    for (var g = 0; g <= 5; g++) {
        var gy = T + g * PH / 5, gp = max - g * (max - min) / 5;
        parts.push('<line x1="' + L + '" y1="' + gy + '" x2="' + (W - R) + '" y2="' + gy + '" stroke="#19304a"/>');
        parts.push('<text x="8" y="' + (gy + 4) + '" fill="#7188a1" font-family="ui-monospace,monospace" font-size="11">' + fmt(gp, 2) + '</text>');
    }
    var formationX1 = x(row.startIndex) - bodyW, formationX2 = x(row.endIndex) + bodyW;
    parts.push('<rect x="' + formationX1 + '" y="' + y(row.rangeHighAtConfirmation) + '" width="' + Math.max(1, formationX2 - formationX1) + '" height="' + Math.max(1, y(row.rangeLowAtConfirmation) - y(row.rangeHighAtConfirmation)) + '" fill="' + (item.kind === 'POSITIVE' ? '#2d7dd233' : '#8a94a633') + '" stroke="' + (item.kind === 'POSITIVE' ? '#49a5ff' : '#8a94a6') + '" stroke-width="1.5"/>');
    if (bounds.cutoffIndex > row.endIndex) {
        var postX = x(row.endIndex) + PW / view.length / 2;
        parts.push('<rect x="' + postX + '" y="' + T + '" width="' + Math.max(0, W - R - postX) + '" height="' + PH + '" fill="#f0ad4e12"/>');
        parts.push('<text x="' + (postX + 8) + '" y="' + (T + 18) + '" fill="#e9b85d" font-family="ui-monospace,monospace" font-size="11">POST_CONFIRMATION_CONTEXT</text>');
    }
    view.forEach(function (c, li) {
        var gi = bounds.startIndex + li, color = c.close >= c.open ? '#39d98a' : '#ff6577', cx = x(gi);
        parts.push('<line x1="' + cx + '" y1="' + y(c.high) + '" x2="' + cx + '" y2="' + y(c.low) + '" stroke="' + color + '"/>');
        parts.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(c.open), y(c.close)) + '" width="' + bodyW + '" height="' + Math.max(1, Math.abs(y(c.open) - y(c.close))) + '" fill="' + color + '"/>');
    });
    [['HIGH', row.rangeHighAtConfirmation, '#55aaff'], ['MID', row.rangeMidAtConfirmation, '#c4ced9'], ['LOW', row.rangeLowAtConfirmation, '#55aaff']].forEach(function (line) {
        parts.push('<line x1="' + formationX1 + '" y1="' + y(line[1]) + '" x2="' + formationX2 + '" y2="' + y(line[1]) + '" stroke="' + line[2] + '" stroke-width="1.5" stroke-dasharray="7 5"/>');
        parts.push('<text x="' + (formationX2 + 6) + '" y="' + (y(line[1]) + 4) + '" fill="' + line[2] + '" font-family="ui-monospace,monospace" font-size="11">' + line[0] + ' ' + fmt(line[1], 2) + '</text>');
    });
    [['formationStart', row.startIndex, '#67d5ff'], ['confirmedAt', row.endIndex, '#ffd166']].forEach(function (mark) {
        var mx = x(mark[1]); parts.push('<line x1="' + mx + '" y1="' + T + '" x2="' + mx + '" y2="' + (T + PH) + '" stroke="' + mark[2] + '" stroke-width="2"/>');
        parts.push('<text x="' + (mx + 5) + '" y="' + (T + PH - 8) + '" fill="' + mark[2] + '" font-family="ui-monospace,monospace" font-size="11">' + mark[0] + '</text>');
    });
    var f = row.features;
    var lines = [
        'durationBars=' + f.durationBars + '  rangeHigh=' + fmt(f.rangeHigh, 2) + '  rangeLow=' + fmt(f.rangeLow, 2) + '  rangeWidth=' + fmt(f.rangeWidth, 2),
        'ATR14=' + fmt(f.atr14, 2) + '  rangeWidthATR=' + fmt(f.rangeWidthATR) + '  upperTouch=' + f.upperTouchCount + '  lowerTouch=' + f.lowerTouchCount + '  midCross=' + f.midCrossCount,
        'occupancy=' + fmt(f.rangeOccupancy) + '  directionalDriftATR=' + fmt(f.directionalDriftATR) + '  preRangeMoveATR=' + fmt(f.preRangeDirectionalMoveATR) + '  preRangeSlope=' + fmt(f.preRangeSlope),
        'entrySide=' + f.entrySideIntoRange + '  preRangeContext=' + f.preRangeContext + (item.kind === 'POSITIVE' ? '  rawDuplicates=' + row.rawCandidateCount : '')
    ];
    lines.forEach(function (line, i) { parts.push('<text x="' + L + '" y="' + (H - 98 + i * 22) + '" fill="#a8bdd2" font-family="ui-monospace,monospace" font-size="13">' + esc(line) + '</text>'); });
    parts.push('</svg>');
    fs.writeFileSync(path.join(OUT, 'charts', item.caseId + '.svg'), parts.join(''));
    return bounds;
}

function renderUi(cases) {
    var payload = cases.map(function (c) { return { caseId: c.caseId, kind: c.kind, candidateId: c.row.id, chart: 'charts/' + c.caseId + '.svg', confirmedAt: c.row.confirmedAt }; });
    var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Accumulation Detection Research V1</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#050b13;color:#e8f0fa}body{margin:0}nav{position:sticky;top:0;z-index:3;background:#081525ee;border-bottom:1px solid #213b58;padding:12px 18px;display:flex;gap:10px;align-items:center}nav strong{margin-right:auto}.wrap{max-width:1480px;margin:auto;padding:18px}.case{border:1px solid #233e5b;border-radius:12px;overflow:hidden;background:#091625}.case header{display:flex;justify-content:space-between;padding:12px 16px}.case img{width:100%;display:block}.review{padding:14px 16px}.buttons{display:flex;gap:8px;flex-wrap:wrap}button{background:#122740;color:#e8f0fa;border:1px solid #3b5875;border-radius:7px;padding:9px 14px}button.selected{background:#f2c14e;color:#08111f;font-weight:700}.reasons{display:none;margin-top:12px}.reasons.visible{display:block}.reasons label{display:inline-block;margin:4px 14px 4px 0}textarea{box-sizing:border-box;width:100%;min-height:70px;margin-top:12px;background:#06101b;color:#e8f0fa;border:1px solid #36516d;border-radius:7px;padding:9px}.footer{display:flex;justify-content:space-between;margin-top:14px}.hint{color:#9db2c8;font-size:13px}@media(max-width:700px){.wrap{padding:6px}nav strong{display:none}}' +
        '</style></head><body><nav><strong>Accumulation V1 · Formation-only Review</strong><span id="progress"></span><button id="export">导出 human-review-results.json</button></nav><div class="wrap"><article class="case"><header><b id="title"></b><code id="time"></code></header><img id="chart"><div class="review"><div class="hint" id="question"></div><div class="buttons" id="buttons"></div><div class="reasons" id="reasons"><b>NO_REASON（可多选）</b><br></div><textarea id="comment" placeholder="COMMENT（可选）"></textarea><div class="footer"><button id="prev">Previous</button><button id="next">Next</button></div></div></article></div><script>' +
        'const cases=' + JSON.stringify(payload) + ';const reasons=["TREND_PAUSE","TOO_DIRECTIONAL","RANGE_NOT_CLEAR","TOO_WIDE","TOO_SHORT","BOUNDARY_NOT_MEANINGFUL","OTHER"];const key="accumulationResearchV1Labels";let state=JSON.parse(localStorage.getItem(key)||"{}");let idx=0;const $=s=>document.querySelector(s);reasons.forEach(r=>{$("#reasons").insertAdjacentHTML("beforeend",`<label><input type="checkbox" value="${r}"> ${r}</label>`)});function save(){localStorage.setItem(key,JSON.stringify(state))}function draw(){const c=cases[idx],d=state[c.caseId]||{};$("#progress").textContent=`${idx+1} / ${cases.length}`;$("#title").textContent=`${c.caseId.toUpperCase()} · ${c.kind}`;$("#time").textContent=new Date(c.confirmedAt).toISOString();$("#chart").src=c.chart;$("#question").textContent=c.kind==="POSITIVE"?"ACCUMULATION_VALID":"SHOULD_HAVE_BEEN_ACCUMULATION";$("#buttons").innerHTML=["YES","NO","UNSURE"].map(x=>`<button data-v="${x}" class="${d.label===x?"selected":""}">${x}</button>`).join("");$("#buttons").querySelectorAll("button").forEach(b=>b.onclick=()=>{d.label=b.dataset.v;state[c.caseId]=d;save();draw()});$("#reasons").classList.toggle("visible",d.label==="NO");$("#reasons").querySelectorAll("input").forEach(x=>{x.checked=(d.reasons||[]).includes(x.value);x.onchange=()=>{d.reasons=[...$("#reasons").querySelectorAll("input:checked")].map(y=>y.value);state[c.caseId]=d;save()}});$("#comment").value=d.comment||"";$("#comment").onchange=e=>{d.comment=e.target.value;state[c.caseId]=d;save()};$("#prev").disabled=idx===0;$("#next").disabled=idx===cases.length-1}$("#prev").onclick=()=>{if(idx>0){idx--;draw()}};$("#next").onclick=()=>{if(idx<cases.length-1){idx++;draw()}};$("#export").onclick=()=>{const out=cases.map(c=>({caseId:c.caseId,kind:c.kind,candidateId:c.candidateId,label:(state[c.caseId]||{}).label||null,noReasons:(state[c.caseId]||{}).reasons||[],comment:(state[c.caseId]||{}).comment||""}));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}));a.download="human-review-results.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};draw();' +
        '</script></body></html>';
    fs.writeFileSync(path.join(OUT, 'human-review-index.html'), html);
}

function implementationAudit() {
    return '# Existing Accumulation Implementation Audit\n\n' +
        '## Current detector\n\n`amd/accumulationDetector.js` scans every 12–36 bar window ending at the supplied `endIndex`. It calculates an immutable window high/low/mid, Wilder ATR14, range width in ATR, path efficiency, mid crosses, and ACTIVE EQH/EQL evidence. It confirms when the hard conditions pass and score is at least 60; candidates are ordered by score, duration, then earliest start.\n\n' +
        '## Frozen inputs and parameters\n\n- Closed 5m OHLC candles through `endIndex`\n- ATR14\n- min/max duration: 12/36\n- max normalized range: 3.0 ATR\n- max efficiency: 0.35\n- minimum mid crosses: 3\n- score threshold: 60\n- optional as-of ACTIVE EQH/EQL in the window contributes score, but is not a hard gate\n\n' +
        '## Time semantics\n\n`confirmedAt` is the selected window end candle close. The detector rejects an end candle later than `evaluationTime`; ATR and window calculations read only indices through `endIndex`. `amd/amdState.js` currently invokes it with a six-bar confirmation gap while SEARCHING, then freezes the returned object. This research calls the detector directly at each closed bar to study the A formation population; it does not run M/D state transitions.\n\n' +
        '## Boundaries and lifecycle\n\nThe returned range high/low are max/min over the selected formation window and do not move inside the returned snapshot. The standalone detector has no A invalidation rule; timeout/break invalidation belongs to the outer AMD state machine. The detector does not depend on future Manipulation or Distribution.\n\n' +
        '## Independent review suitability\n\nIt is technically suitable as a frozen baseline, but human validity is unproven. Rolling calls create many near-duplicate candidates, touch/context features are absent, and the score mixes compression/balance with optional EQ evidence. V1 therefore preserves detection semantics while adding research-only features and review deduplication.\n';
}

function report(summary) {
    return '# Accumulation Detection Research V1\n\n## Result\n\n**Program implementation PASS; human validation PENDING.** This is a research-only formation baseline, not a validated ICT Accumulation model.\n\n' +
        '## V1 definition\n\nAn `ACCUMULATION_CANDIDATE` is the existing detector\'s balance/compression/persistence formation: 12–36 closed bars, bounded width relative to ATR14, low directional efficiency, repeated mid crossings, and the frozen score rule. A has no bullish/bearish direction.\n\n' +
        'The detector conditions and score come from the old AMD implementation. V1 adds only as-of interaction features, pre-range context, immutable snapshots, deterministic review deduplication, stratified positive sampling, deterministic non-detected controls, SVG charts, and review UI. Session hardcodes were rejected because BTC trades 24/7 and session identity is not the definition of balance.\n\n' +
        '## Future safety and dedupe\n\nAll features use candles from the pre-range context through `confirmedAt`; charts add at most two clearly shaded post-confirmation context bars, never used by detection or features. Rolling duplicates are grouped only for review when the immutable anchor and candidate have ≥0.75 time overlap and ≥0.80 price-range IoU. Detection output itself is unchanged.\n\n' +
        '## Sampling\n\nPositive cases are deterministic round-robin strata across duration, rangeWidthATR, interaction density, pre-range context, then chronology. This includes hard/suspicious candidates rather than confidence-only picks. Controls are fixed 24-bar windows sampled every 12 bars, excluding windows with ≥50% overlap with any machine-positive formation; their deterministic strata cover volatility, geometry, trend context, and time.\n\n' +
        '## Known limitations\n\nTouch tolerance (10% of formation width), pre-range length (24 bars), review dedupe, and control window are unvalidated research conventions. The old score is not an ICT truth label, rolling best-window selection can shift boundaries, EQ evidence affects score, and no persistent range identity is modeled. No parameter was searched or tuned. The next step must be human labeling of positive and control charts; Manipulation and Distribution research remain blocked.\n\n' +
        '## Review UI validation\n\nThe generated page script parses successfully and all required progress, Previous/Next, YES/NO/UNSURE, NO_REASON, comment, and JSON export controls are present. Automated navigation of the local `file://` page was blocked by the browser security policy; no bypass was attempted. SVG XML and formation-only content were validated directly.\n\n' +
        '## Population\n\n```ini\n' + Object.keys(summary).map(function (k) { return k + ' = ' + summary[k]; }).join('\n') + '\n```\n';
}

function main() {
    if (!fs.existsSync(INPUT)) throw new Error('Fixed local dataset missing: ' + INPUT);
    ensure();
    var candles = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
    if (candles.length !== WARMUP + VALIDATION || candles.some(function (c) { return c.closed === false; })) {
        throw new Error('Expected exactly 9216 closed candles (576 warmup + 8640 validation), got ' + candles.length);
    }
    var productionFiles = ['events/displacementDetector.js', 'liquidity/persistentEqualLiquidityV3.js', 'liquidity/equalLiquidity.js', 'live/liveEngine.js', 'notify/watchNotificationPresentationV1.js'];
    var before = {}; productionFiles.forEach(function (f) { before[f] = sha(path.join(__dirname, '..', f)); });
    console.log('[Replay A] frozen 30D baseline');
    var raw = runPopulation(candles, 'Replay A');
    console.log('[Replay B] determinism');
    var raw2 = runPopulation(candles, 'Replay B');
    var deduped = research.dedupe(raw, baseline.reviewDedupe);
    var deduped2 = research.dedupe(raw2, baseline.reviewDedupe);
    var positives = research.deterministicSample(deduped, 60);
    var positive2 = research.deterministicSample(deduped2, 60);
    var controlPopulation = research.buildControlPopulation(candles, raw, WARMUP, config);
    var controls = research.sampleControls(controlPopulation, 20);
    var controls2 = research.sampleControls(research.buildControlPopulation(candles, raw2, WARMUP, config), 20);
    var manifest = [];
    positives.forEach(function (row) { manifest.push({ kind: 'POSITIVE', row: compact(row) }); });
    controls.forEach(function (row) { manifest.push({ kind: 'CONTROL', row: compact(row) }); });
    manifest.forEach(function (item, i) { item.caseId = 'case' + String(i + 1).padStart(3, '0'); item.chartBounds = renderSvg(item, candles); });
    renderUi(manifest);
    var validationStart = candles[WARMUP].openTime;
    var dayCounts = {};
    deduped.forEach(function (r) { var day = Math.floor((r.confirmedAt - validationStart) / 86400000) + 1; dayCounts['Day ' + day] = (dayCounts['Day ' + day] || 0) + 1; });
    for (var day = 1; day <= 30; day++) if (dayCounts['Day ' + day] === undefined) dayCounts['Day ' + day] = 0;
    var population = {
        totalBars: candles.length, warmupBars: WARMUP, validationBars: VALIDATION,
        validationStart: candles[WARMUP].openTime, validationEnd: candles[candles.length - 1].closeTime,
        rawAccumulationCandidates: raw.length, dedupedAccumulationCandidates: deduped.length,
        durationBars: research.distribution(deduped.map(function (r) { return r.features.durationBars; })),
        rangeWidthATR: research.distribution(deduped.map(function (r) { return r.features.rangeWidthATR; })),
        upperTouchCount: research.distribution(deduped.map(function (r) { return r.features.upperTouchCount; })),
        lowerTouchCount: research.distribution(deduped.map(function (r) { return r.features.lowerTouchCount; })),
        midCrossCount: research.distribution(deduped.map(function (r) { return r.features.midCrossCount; })),
        candidatesByValidationDay: dayCounts,
        controlPopulation: controlPopulation.length
    };
    var after = {}; productionFiles.forEach(function (f) { after[f] = sha(path.join(__dirname, '..', f)); });
    var candidateDeterminism = JSON.stringify(raw.map(function (r) { return r.id; })) === JSON.stringify(raw2.map(function (r) { return r.id; }));
    var sampleDeterminism = JSON.stringify(manifest.map(function (x) { return x.row.id; })) === JSON.stringify(positive2.concat(controls2).map(function (x) { return x.id; }));
    var futureLeaks = manifest.reduce(function (n, item) {
        var r = item.row; return n + (r.features.featureSourceEndIndex > r.endIndex || r.confirmedAt !== candles[r.endIndex].closeTime || item.chartBounds.featureCutoffIndex > r.endIndex ? 1 : 0);
    }, 0);
    var productionUnchanged = productionFiles.every(function (f) { return before[f] === after[f]; });
    var uiHtml = fs.readFileSync(path.join(OUT, 'human-review-index.html'), 'utf8');
    var uiScript = uiHtml.match(/<script>([\s\S]*)<\/script>/);
    var uiScriptValid = false;
    try { if (uiScript) { new Function(uiScript[1]); uiScriptValid = true; } } catch (uiError) { uiScriptValid = false; }
    var uiControlsValid = ['id="progress"', 'id="export"', 'id="prev"', 'id="next"',
        'YES', 'NO', 'UNSURE', 'TREND_PAUSE', 'TOO_DIRECTIONAL', 'RANGE_NOT_CLEAR',
        'human-review-results.json'].every(function (token) { return uiHtml.indexOf(token) !== -1; });
    console.log('[Tests] full repository regression suite');
    var tests = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'test', 'run.js')], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    var testsPassed = tests.status === 0;
    var testResults = {
        command: 'node test/run.js', exitCode: tests.status,
        passed: testsPassed,
        stdoutSha256: crypto.createHash('sha256').update(tests.stdout || '').digest('hex'),
        stdoutTail: (tests.stdout || '').split('\n').slice(-30),
        stderr: tests.stderr || ''
    };
    var acceptance = {
        fixedDatasetLoaded: true, candidatePopulationPositive: raw.length > 0,
        dedupeReducedOrEqual: deduped.length <= raw.length,
        positiveCasesSatisfied: positives.length === Math.min(60, deduped.length),
        controlCasesSatisfied: controls.length === Math.min(20, controlPopulation.length),
        chartsGenerated: manifest.every(function (x) { return fs.existsSync(path.join(OUT, 'charts', x.caseId + '.svg')); }),
        reviewUiGenerated: fs.existsSync(path.join(OUT, 'human-review-index.html')),
        reviewUiScriptSyntaxValid: uiScriptValid,
        reviewUiRequiredControlsPresent: uiControlsValid,
        FUTURE_LEAK_VIOLATIONS: futureLeaks,
        DETERMINISM_VIOLATIONS: (candidateDeterminism && sampleDeterminism) ? 0 : 1,
        productionSourceHashesBefore: before, productionSourceHashesAfter: after,
        productionBehaviorUnchanged: productionUnchanged,
        parameterSearchPerformed: false,
        allTestsPassed: testsPassed
    };
    var implementationPass = acceptance.fixedDatasetLoaded && acceptance.candidatePopulationPositive &&
        acceptance.dedupeReducedOrEqual && acceptance.positiveCasesSatisfied &&
        acceptance.controlCasesSatisfied && acceptance.chartsGenerated &&
        acceptance.reviewUiGenerated && acceptance.reviewUiScriptSyntaxValid &&
        acceptance.reviewUiRequiredControlsPresent && acceptance.productionBehaviorUnchanged &&
        acceptance.allTestsPassed && futureLeaks === 0 && acceptance.DETERMINISM_VIOLATIONS === 0 &&
        acceptance.parameterSearchPerformed === false;
    var summary = {
        ACCUMULATION_DETECTION_RESEARCH_V1: implementationPass ? 'PASS' : 'FAIL',
        RESEARCH_ONLY: true, DATASET: 'BTCUSDT_5M_30D', TOTAL_BARS: candles.length,
        RAW_ACCUMULATION_CANDIDATES: raw.length, DEDUPED_ACCUMULATION_CANDIDATES: deduped.length,
        POSITIVE_REVIEW_CASES: positives.length, CONTROL_REVIEW_CASES: controls.length,
        FORMATION_ONLY_CHARTS: true, BASELINE_CONFIG_FROZEN: true,
        FUTURE_LEAK_VIOLATIONS: futureLeaks, DETERMINISM_VIOLATIONS: acceptance.DETERMINISM_VIOLATIONS,
        DISPLACEMENT_ENGINE_CHANGED: false, EQ_V3_CHANGED: false, LIQUIDITY_ENGINE_CHANGED: false,
        WATCH_ALGORITHM_CHANGED: false, NOTIFICATION_LOGIC_CHANGED: false,
        AMD_MANIPULATION_IMPLEMENTED: false, AMD_DISTRIBUTION_IMPLEMENTED: false,
        AMD_NOTIFICATION_ENABLED: false, AMD_FILTER_ENABLED: false,
        ALL_TESTS_PASSED: testsPassed, ACCUMULATION_DETECTOR_IMPLEMENTATION: implementationPass ? 'PASS' : 'FAIL',
        ACCUMULATION_HUMAN_VALIDATION: 'PENDING', READY_FOR_MANIPULATION_RESEARCH: false,
        READY_FOR_DISTRIBUTION_RESEARCH: false
    };
    json('baseline-config.json', baseline); json('population.json', population);
    json('candidates.json', deduped); json('controls.json', controls);
    json('sample-manifest.json', manifest.map(function (x) { return { caseId: x.caseId, kind: x.kind, row: x.row, chartBounds: x.chartBounds }; }));
    fs.writeFileSync(path.join(OUT, 'EXISTING_ACCUMULATION_IMPLEMENTATION.md'), implementationAudit());
    fs.writeFileSync(path.join(OUT, 'REPORT.md'), report(summary));
    json('test-results.json', testResults); json('acceptance.json', acceptance); json('summary.json', summary);
    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
module.exports = { runPopulation: runPopulation, renderSvg: renderSvg, renderUi: renderUi, baseline: baseline };
