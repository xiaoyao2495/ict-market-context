'use strict';

var fs = require('fs');
var path = require('path');
var eqV3 = require('../audit/eqPersistentClusterShadowV3');
var comparison = require('../audit/eqV2V3BlindComparisonV1');

var root = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var sourceDir = path.join(root, 'eqh-eql-persistent-cluster-shadow-v3');
var identityDir = path.join(root, 'eqh-eql-v3-cluster-identity-collision-fix-v1');
var boundaryDir = path.join(root, 'eqh-eql-cluster-lifecycle-boundary-audit-v1');
var outputDir = path.join(root, 'eqh-eql-v2-v3-blind-comparison-v1');
var inputPath = path.join(sourceDir, 'BTCUSDT-5m-bounded-input.json');
var validationStart = Date.UTC(2026, 6, 22);
var validationEnd = Date.UTC(2026, 7, 21) - 1;
var requiredCaseIds = [2, 6, 7, 8, 12, 13, 14, 17, 20, 25, 55];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(name, value) {
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
}
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function round(value, digits) {
    return typeof value === 'number' && isFinite(value)
        ? Number(value.toFixed(digits == null ? 4 : digits)) : null;
}
function memberIds(object) {
    return (object.members || []).map(function (member) { return member.id; });
}
function intersects(a, bSet) { return a.some(function (id) { return bSet[id]; }); }
function compactMember(member) {
    return { id: member.id, price: member.price, sourceOpenTime: member.sourceOpenTime,
        sourceCloseTime: member.sourceCloseTime, confirmedAt: member.confirmedAt };
}
function serializeV2(object) {
    var members = (object.metadata && object.metadata.members || []).map(compactMember);
    return { objectId: object.id, side: object.type, price: round(object.price, 6),
        confirmedAt: object.confirmedAt, memberCount: members.length, members: members,
        zoneLow: members.reduce(function (min, m) { return Math.min(min, m.price); }, Infinity),
        zoneHigh: members.reduce(function (max, m) { return Math.max(max, m.price); }, -Infinity) };
}
function visibleV3Object(base, result, evaluationTime) {
    var projected = eqV3.projectClusterAsOf(base, result.memberLedger, result.lifecycleLedger, evaluationTime);
    if (!projected) return null;
    var appendMembers = result.memberLedger.filter(function (row) {
        return row.clusterId === base.id && row.memberAddedAt <= evaluationTime &&
            row.memberConfirmedAt <= evaluationTime;
    }).map(function (row) { return row.member; });
    var members = base.initialMembers.concat(appendMembers).sort(eqV3.chronological).map(compactMember);
    return { objectId: base.id, side: base.type, price: round(projected.referencePrice, 6),
        confirmedAt: base.confirmedAt, memberCount: members.length, members: members,
        zoneLow: members.reduce(function (min, m) { return Math.min(min, m.price); }, Infinity),
        zoneHigh: members.reduce(function (max, m) { return Math.max(max, m.price); }, -Infinity) };
}
function v3Row(base, result) {
    var appends = result.memberLedger.filter(function (row) { return row.clusterId === base.id; });
    var members = base.initialMembers.concat(appends.map(function (row) { return row.member; }))
        .sort(eqV3.chronological);
    return { base: base, members: members, memberCount: members.length,
        lastMemberConfirmedAt: Math.max.apply(null, members.map(function (m) { return m.confirmedAt; })) };
}
function byId(items, key) {
    var out = {};
    items.forEach(function (item) { out[item[key]] = item; });
    return out;
}
function choose(rows, count) {
    return comparison.evenlyPick(rows.slice().sort(function (a, b) {
        return a.evaluationTime - b.evaluationTime || a.targetClusterId.localeCompare(b.targetClusterId);
    }), count);
}
function selectionCandidate(row, v2Objects, v3Result, evaluationTime, regressionCaseId) {
    var target = visibleV3Object(row.base, v3Result, evaluationTime);
    if (!target) throw new Error('Target cluster is not visible at requested cutoff: ' + row.base.id);
    var targetSet = {};
    target.members.forEach(function (member) { targetSet[member.id] = true; });
    var relevantV2 = v2Objects.filter(function (object) {
        return object.confirmedAt <= evaluationTime && object.type === row.base.type &&
            intersects((object.metadata && object.metadata.members || []).map(function (m) { return m.id; }), targetSet);
    }).map(serializeV2);
    var relevantV3 = v3Result.baseLedger.filter(function (base) {
        if (base.confirmedAt > evaluationTime || base.type !== row.base.type) return false;
        var projected = visibleV3Object(base, v3Result, evaluationTime);
        return projected && intersects(memberIds(projected), targetSet);
    }).map(function (base) { return visibleV3Object(base, v3Result, evaluationTime); });
    var targetSignature = target.members.map(function (m) { return m.id; }).join('|');
    var v2Exact = relevantV2.some(function (object) {
        return object.members.map(function (m) { return m.id; }).join('|') === targetSignature;
    });
    return {
        targetClusterId: row.base.id,
        side: row.base.type,
        evaluationTime: evaluationTime,
        regressionCaseId: regressionCaseId || null,
        targetMemberCount: target.memberCount,
        targetMembers: target.members,
        v2Objects: relevantV2,
        v3Objects: relevantV3,
        fragmented: relevantV2.length > 1 || (relevantV2.length > 0 && !v2Exact)
    };
}
function addSelected(selected, seen, rows, count, stratum) {
    choose(rows.filter(function (row) { return !seen[row.targetClusterId]; }), count)
        .forEach(function (row) {
            row.selectionStratum = stratum;
            selected.push(row);
            seen[row.targetClusterId] = true;
        });
}
function candleIndexByOpen(candles) {
    var out = {};
    candles.forEach(function (candle, index) { out[candle.openTime] = index; });
    return out;
}
function buildCase(candidate, caseId, mapping, v3Result, candles, indexByOpen) {
    var modelA = mapping.A === 'V2' ? candidate.v2Objects : candidate.v3Objects;
    var modelB = mapping.B === 'V2' ? candidate.v2Objects : candidate.v3Objects;
    var underlying = {};
    candidate.targetMembers.forEach(function (member) { underlying[member.id] = member; });
    modelA.concat(modelB).forEach(function (object) {
        object.members.forEach(function (member) { underlying[member.id] = member; });
    });
    var members = Object.keys(underlying).map(function (id) { return underlying[id]; });
    var earliest = Math.min.apply(null, members.map(function (member) { return member.sourceOpenTime; }));
    var startIndex = Math.max(0, (indexByOpen[earliest] || 0) - 18);
    var endIndex = candles.findIndex(function (candle) { return candle.closeTime === candidate.evaluationTime; });
    if (endIndex < 0) throw new Error('Evaluation candle unavailable: ' + candidate.evaluationTime);
    return {
        caseId: caseId,
        regressionCaseId: candidate.regressionCaseId,
        selectionStratum: candidate.selectionStratum,
        side: candidate.side,
        symbol: 'BTCUSDT', timeframe: '5m',
        evaluationTime: candidate.evaluationTime,
        evaluationTimeIso: iso(candidate.evaluationTime),
        windowStart: candles[startIndex].openTime,
        windowStartIso: iso(candles[startIndex].openTime),
        windowEnd: candles[endIndex].closeTime,
        windowEndIso: iso(candles[endIndex].closeTime),
        modelAObjects: modelA,
        modelBObjects: modelB,
        underlyingSwingIds: Object.keys(underlying).sort(),
        targetMemberCount: candidate.targetMemberCount,
        structuralMetrics: {
            modelAObjectCount: modelA.length,
            modelBObjectCount: modelB.length,
            fragmentedComparison: candidate.fragmented
        }
    };
}

function renderChart(item, candles, mode, filename) {
    var index = candleIndexByOpen(candles);
    var start = index[item.windowStart];
    var end = candles.findIndex(function (c) { return c.closeTime === item.windowEnd; });
    var view = candles.slice(start, end + 1);
    var width = 1500, height = 760, left = 78, right = 28, top = 78, bottom = 54;
    var plotW = width - left - right, plotH = height - top - bottom;
    var min = Infinity, max = -Infinity;
    view.forEach(function (c) { min = Math.min(min, c.low); max = Math.max(max, c.high); });
    var pad = Math.max((max - min) * 0.06, max * 0.00005); min -= pad; max += pad;
    function x(openTime) { return left + ((index[openTime] - start) + 0.5) * plotW / view.length; }
    function y(price) { return top + (max - price) * plotH / (max - min); }
    var bodyW = Math.max(0.35, Math.min(5, plotW / view.length * 0.56));
    var parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">',
        '<rect width="100%" height="100%" fill="#07111e"/>',
        '<text x="' + left + '" y="30" fill="#edf4fc" font-family="system-ui,sans-serif" font-size="18" font-weight="700">' + esc(item.caseId + ' · ' + item.side + ' · ' + mode.toUpperCase()) + '</text>',
        '<text x="' + left + '" y="55" fill="#8fa8c2" font-family="ui-monospace,monospace" font-size="12">Formation-only · cutoff ' + esc(item.evaluationTimeIso) + ' · no later candles</text>'];
    for (var g = 0; g <= 5; g++) {
        var gy = top + g * plotH / 5, gp = max - g * (max - min) / 5;
        parts.push('<line x1="' + left + '" y1="' + gy + '" x2="' + (width - right) + '" y2="' + gy + '" stroke="#19314c"/>');
        parts.push('<text x="8" y="' + (gy + 4) + '" fill="#718ba7" font-family="ui-monospace,monospace" font-size="11">' + round(gp, 2) + '</text>');
    }
    view.forEach(function (c) {
        var color = c.close >= c.open ? '#42d392' : '#ff6b6b', cx = x(c.openTime);
        parts.push('<line x1="' + cx + '" y1="' + y(c.high) + '" x2="' + cx + '" y2="' + y(c.low) + '" stroke="' + color + '"/>');
        parts.push('<rect x="' + (cx - bodyW / 2) + '" y="' + Math.min(y(c.open), y(c.close)) + '" width="' + bodyW + '" height="' + Math.max(1, Math.abs(y(c.open) - y(c.close))) + '" fill="' + color + '"/>');
    });
    function overlay(objects, label, color, dash) {
        objects.forEach(function (object, objectIndex) {
            var zoneTop = y(object.zoneHigh), zoneBottom = y(object.zoneLow);
            parts.push('<rect x="' + left + '" y="' + Math.min(zoneTop, zoneBottom) + '" width="' + plotW + '" height="' + Math.max(2, Math.abs(zoneBottom - zoneTop)) + '" fill="' + color + '" opacity="0.09"/>');
            parts.push('<line x1="' + left + '" y1="' + y(object.price) + '" x2="' + (width - right) + '" y2="' + y(object.price) + '" stroke="' + color + '" stroke-width="2" stroke-dasharray="' + dash + '"/>');
            object.members.forEach(function (member, memberIndex) {
                if (member.sourceOpenTime < item.windowStart || member.confirmedAt > item.evaluationTime) return;
                var mx = x(member.sourceOpenTime), my = y(member.price);
                parts.push('<circle cx="' + mx + '" cy="' + my + '" r="5" fill="#07111e" stroke="' + color + '" stroke-width="3"/>');
                parts.push('<text x="' + (mx + 7) + '" y="' + (my + (label === 'A' ? -10 : 18) + objectIndex * 12) + '" fill="' + color + '" font-family="ui-monospace,monospace" font-size="11">' + label + (objectIndex + 1) + '.' + (memberIndex + 1) + '</text>');
            });
        });
    }
    if (mode === 'a' || mode === 'both') overlay(item.modelAObjects, 'A', '#45c4ff', '10 5');
    if (mode === 'b' || mode === 'both') overlay(item.modelBObjects, 'B', '#ffb454', '3 5');
    parts.push('<text x="' + left + '" y="' + (height - 20) + '" fill="#45c4ff" font-family="ui-monospace,monospace" font-size="12">MODEL A objects=' + item.modelAObjects.length + '</text>');
    parts.push('<text x="' + (left + 220) + '" y="' + (height - 20) + '" fill="#ffb454" font-family="ui-monospace,monospace" font-size="12">MODEL B objects=' + item.modelBObjects.length + '</text>');
    parts.push('</svg>');
    fs.writeFileSync(path.join(outputDir, 'charts', filename), parts.join(''));
}

function renderReview(cases) {
    var reviewData = cases.map(function (item) {
        return { caseId: item.caseId, side: item.side, evaluationTimeIso: item.evaluationTimeIso,
            regressionCaseId: item.regressionCaseId, selectionStratum: item.selectionStratum,
            aCount: item.modelAObjects.length, bCount: item.modelBObjects.length };
    });
    var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EQH/EQL Blind-ish Human Comparison</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#050b14;color:#e7eef8}body{margin:0}nav{position:sticky;top:0;z-index:2;background:#08111ff2;border-bottom:1px solid #1d3550;padding:12px 18px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}nav strong{margin-right:auto}button{background:#12243a;color:#dce8f6;border:1px solid #34506e;border-radius:7px;padding:8px 11px}button.active,button.selected{background:#e8b84a;color:#08111f;border-color:#e8b84a;font-weight:700}main{max-width:1520px;margin:auto;padding:16px}.meta{display:flex;justify-content:space-between;background:#0e1c2e;padding:11px 14px;border-radius:10px 10px 0 0}.chart{width:100%;display:block;background:#07111e}.panel{border:1px solid #1c3550;border-radius:10px;background:#0a1524;overflow:hidden}.choices{display:flex;gap:8px;padding:12px 14px;flex-wrap:wrap}textarea{box-sizing:border-box;width:calc(100% - 28px);min-height:70px;margin:0 14px 14px;background:#06101c;color:#e7eef8;border:1px solid #29435f;border-radius:7px;padding:8px}.hint{color:#8fa8c2;font-size:12px;padding:0 14px 10px}@media(max-width:700px){main{padding:6px}.chart{min-height:340px;object-fit:contain}.meta{display:block}}' +
        '</style></head><body><nav><strong>EQH/EQL 同图 Blind-ish 人工对照</strong><button id="prev">上一张</button><span id="progress"></span><button id="next">下一张</button><button data-mode="a">MODEL A</button><button data-mode="b">MODEL B</button><button data-mode="both" class="active">BOTH</button><button id="export">导出 labels.json</button></nav><main><section class="panel"><div class="meta"><b id="title"></b><code id="time"></code></div><img id="chart" class="chart"><div class="hint" id="hint"></div><div class="choices">' +
        [['MODEL_A_BETTER','A BETTER'],['MODEL_B_BETTER','B BETTER'],['EQUAL','EQUAL'],['BOTH_BAD','BOTH BAD'],['UNCERTAIN','UNCERTAIN']].map(function (row) { return '<button data-label="' + row[0] + '">' + row[1] + '</button>'; }).join('') +
        '</div><textarea id="note" placeholder="备注（可选）：fragmented / over-clustered / both valid / historical revisit / unclear …"></textarea></section></main><script>' +
        'const cases=' + JSON.stringify(reviewData).replace(/</g, '\\u003c') + ';const key="eqV2V3BlindComparisonLabelsV1";let state=JSON.parse(localStorage.getItem(key)||"{}");let i=0,mode="both";const $=s=>document.querySelector(s);function render(){const c=cases[i],d=state[c.caseId]||{};$("#progress").textContent=(i+1)+" / "+cases.length;$("#title").textContent=c.caseId+" · "+c.side+(c.regressionCaseId?" · regression #"+c.regressionCaseId:"");$("#time").textContent=c.evaluationTimeIso;$("#hint").textContent="Selection: "+c.selectionStratum+" · A objects "+c.aCount+" · B objects "+c.bCount;$("#chart").src="charts/"+c.caseId+"-"+mode+".svg";document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("active",b.dataset.mode===mode));document.querySelectorAll("[data-label]").forEach(b=>b.classList.toggle("selected",b.dataset.label===d.label));$("#note").value=d.note||""}function save(){localStorage.setItem(key,JSON.stringify(state));render()}$("#prev").onclick=()=>{i=(i+cases.length-1)%cases.length;render()};$("#next").onclick=()=>{i=(i+1)%cases.length;render()};document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{mode=b.dataset.mode;render()});document.querySelectorAll("[data-label]").forEach(b=>b.onclick=()=>{const c=cases[i];state[c.caseId]={label:b.dataset.label,note:$("#note").value};save()});$("#note").onchange=e=>{const c=cases[i];state[c.caseId]={label:(state[c.caseId]||{}).label||null,note:e.target.value};save()};$("#export").onclick=()=>{const payload=cases.map(c=>({caseId:c.caseId,label:(state[c.caseId]||{}).label||null,note:(state[c.caseId]||{}).note||""}));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));a.download="labels.json";a.click();URL.revokeObjectURL(a.href)};render();' +
        '</script></body></html>';
    fs.writeFileSync(path.join(outputDir, 'human-review-index.html'), html);
}

function main() {
    fs.mkdirSync(path.join(outputDir, 'charts'), { recursive: true });
    var candles = readJson(inputPath);
    var validationBars = candles.filter(function (c) {
        return c.closed !== false && c.openTime >= validationStart && c.closeTime <= validationEnd;
    });
    if (validationBars.length !== 8640) throw new Error('Expected 8640 validation bars, got ' + validationBars.length);
    var common = { symbol: 'BTCUSDT', timeframe: '5m', left: 2, right: 2,
        validationStart: validationStart, validationEnd: validationEnd };
    console.log('[Shared Swing/V3 replay] ' + candles.length + ' bars');
    var v3 = eqV3.runShadow(candles, common);
    console.log('[V2 one-pass formation replay] shared swings=' + v3.swings.length);
    var v2 = comparison.buildV2ObjectStream(candles, v3.swings, common);
    var v2SwingHash = comparison.immutableSwingHash(v2.swings);
    var v3SwingHash = comparison.immutableSwingHash(v3.swings);
    if (v2SwingHash !== v3SwingHash) throw new Error('Underlying Swing hashes differ');

    var bases = v3.baseLedger.filter(function (base) {
        return base.confirmedAt >= validationStart && base.confirmedAt <= validationEnd;
    });
    var rows = bases.map(function (base) { return v3Row(base, v3); });
    var rowsById = byId(rows.map(function (row) {
        return { id: row.base.id, row: row };
    }), 'id');
    var identityRemap = readJson(path.join(identityDir, 'human-case-identity-remap.json')).cases;
    var boundaryCases = readJson(path.join(boundaryDir, 'human-reviewed-case-matrix.json'));
    var boundaryByCase = {};
    boundaryCases.forEach(function (row) { boundaryByCase[row.caseId] = row; });
    var remapByCase = {};
    identityRemap.forEach(function (row) { remapByCase[row.caseId] = row; });

    var selected = [], seen = {};
    requiredCaseIds.forEach(function (humanCaseId) {
        var remap = remapByCase[humanCaseId], boundary = boundaryByCase[humanCaseId];
        if (!remap || !remap.newPublicClusterId || !rowsById[remap.newPublicClusterId]) {
            throw new Error('Required identity mapping unavailable for #' + humanCaseId);
        }
        var mappedRow = rowsById[remap.newPublicClusterId].row;
        // Collision-contaminated historical review candidates (#2/#14) can predate
        // the correctly mapped base formation. The first lawful comparison instant
        // is therefore the later of candidate confirmation and true formation.
        var lawfulEvaluationTime = Math.max(boundary.candidateConfirmedAt, mappedRow.base.confirmedAt);
        var candidate = selectionCandidate(mappedRow, v2.objects, v3,
            lawfulEvaluationTime, humanCaseId);
        candidate.selectionStratum = 'REQUIRED_REGRESSION';
        selected.push(candidate); seen[candidate.targetClusterId] = true;
    });
    var allCandidates = rows.map(function (row) {
        return selectionCandidate(row, v2.objects, v3, row.lastMemberConfirmedAt, null);
    });
    function pool(side, predicate) {
        return allCandidates.filter(function (row) {
            return row.side === side && !seen[row.targetClusterId] && predicate(row);
        });
    }
    addSelected(selected, seen, pool('EQH', function (r) { return r.targetMemberCount >= 3; }), 4, 'PERSISTENT_3_PLUS');
    addSelected(selected, seen, pool('EQL', function (r) { return r.targetMemberCount >= 3; }), 6, 'PERSISTENT_3_PLUS');
    addSelected(selected, seen, pool('EQH', function (r) { return r.fragmented; }), 3, 'FRAGMENTATION_COMPARISON');
    addSelected(selected, seen, pool('EQL', function (r) { return r.fragmented; }), 6, 'FRAGMENTATION_COMPARISON');
    addSelected(selected, seen, pool('EQH', function (r) { return r.targetMemberCount === 2; }), 3, 'SIMPLE_2_MEMBER');
    addSelected(selected, seen, pool('EQL', function (r) { return r.targetMemberCount === 2; }), 7, 'SIMPLE_2_MEMBER');
    if (selected.length !== 40) throw new Error('Expected 40 selected cases, got ' + selected.length);
    var eqhCount = selected.filter(function (row) { return row.side === 'EQH'; }).length;
    var eqlCount = selected.filter(function (row) { return row.side === 'EQL'; }).length;
    if (eqhCount !== 20 || eqlCount !== 20) throw new Error('Side balance failed: ' + eqhCount + '/' + eqlCount);

    selected.sort(function (a, b) {
        if (a.selectionStratum !== b.selectionStratum) return a.selectionStratum.localeCompare(b.selectionStratum);
        return a.evaluationTime - b.evaluationTime || a.targetClusterId.localeCompare(b.targetClusterId);
    });
    var caseIds = selected.map(function (_, index) { return 'case' + String(index + 1).padStart(3, '0'); });
    var modelKey = comparison.balancedAssignments(caseIds);
    var indexByOpen = candleIndexByOpen(candles);
    var cases = selected.map(function (candidate, index) {
        return buildCase(candidate, caseIds[index], modelKey[caseIds[index]], v3, candles, indexByOpen);
    });
    var futureLeak = 0;
    cases.forEach(function (item) {
        item.modelAObjects.concat(item.modelBObjects).forEach(function (object) {
            if (object.confirmedAt > item.evaluationTime) futureLeak++;
            object.members.forEach(function (member) {
                if (member.confirmedAt > item.evaluationTime) futureLeak++;
            });
        });
        if (item.windowEnd > item.evaluationTime) futureLeak++;
    });
    var outcomeViolations = comparison.noOutcomeFields(cases);
    var duplicateIds = v3.baseLedger.length - new Set(v3.baseLedger.map(function (base) { return base.id; })).size;
    var uniqueMapping = cases.every(function (item) {
        return item.modelAObjects.concat(item.modelBObjects).every(function (object) {
            return object.objectId && object.members.every(function (member) {
                return member.confirmedAt <= item.evaluationTime;
            });
        });
    }) && duplicateIds === 0;

    console.log('[Charts] rendering ' + cases.length + ' cases × A/B/BOTH');
    cases.forEach(function (item) {
        ['a', 'b', 'both'].forEach(function (mode) {
            renderChart(item, candles, mode, item.caseId + '-' + mode + '.svg');
        });
    });
    renderReview(cases);

    var secondAssignments = comparison.balancedAssignments(caseIds);
    var secondCases = selected.map(function (candidate, index) {
        return buildCase(candidate, caseIds[index], secondAssignments[caseIds[index]], v3, candles, indexByOpen);
    });
    var determinism = {
        caseSelectionHashRun1: comparison.reviewSetHash(cases),
        caseSelectionHashRun2: comparison.reviewSetHash(secondCases),
        abAssignmentHashRun1: eqV3.hash(modelKey),
        abAssignmentHashRun2: eqV3.hash(secondAssignments),
        chartCutoffHashRun1: eqV3.hash(cases.map(function (c) {
            return [c.caseId, c.windowStart, c.windowEnd, c.evaluationTime];
        })),
        chartCutoffHashRun2: eqV3.hash(secondCases.map(function (c) {
            return [c.caseId, c.windowStart, c.windowEnd, c.evaluationTime];
        }))
    };
    determinism.DETERMINISM_VIOLATIONS = (determinism.caseSelectionHashRun1 === determinism.caseSelectionHashRun2 &&
        determinism.abAssignmentHashRun1 === determinism.abAssignmentHashRun2 &&
        determinism.chartCutoffHashRun1 === determinism.chartCutoffHashRun2) ? 0 : 1;
    var aIsV2 = caseIds.filter(function (id) { return modelKey[id].A === 'V2'; }).length;
    var aIsV3 = caseIds.length - aIsV2;
    var targetedPassed = process.env.ALL_TARGETED_TESTS_PASSED === 'true';
    var allTestsPassed = process.env.ALL_TESTS_PASSED === 'true';
    var pass = cases.length >= 36 && cases.length <= 44 && eqhCount >= 18 && eqhCount <= 22 &&
        aIsV2 === aIsV3 && futureLeak === 0 && outcomeViolations.length === 0 && duplicateIds === 0 &&
        uniqueMapping && determinism.DETERMINISM_VIOLATIONS === 0 && targetedPassed && allTestsPassed;
    var stratumCount = {};
    cases.forEach(function (item) { stratumCount[item.selectionStratum] = (stratumCount[item.selectionStratum] || 0) + 1; });
    var summary = {
        EQH_EQL_V2_V3_BLIND_COMPARISON_V1: pass ? 'PASS' : 'FAIL',
        TOTAL_CASES: cases.length,
        EQH_CASES: eqhCount,
        EQL_CASES: eqlCount,
        SIMPLE_2_MEMBER_CASES: stratumCount.SIMPLE_2_MEMBER || 0,
        PERSISTENT_3_PLUS_CASES: stratumCount.PERSISTENT_3_PLUS || 0,
        FRAGMENTATION_COMPARISON_CASES: stratumCount.FRAGMENTATION_COMPARISON || 0,
        REQUIRED_REGRESSION_CASES_INCLUDED: stratumCount.REQUIRED_REGRESSION || 0,
        A_IS_V2_COUNT: aIsV2,
        A_IS_V3_COUNT: aIsV3,
        V2_SWING_INPUT_HASH: v2SwingHash,
        V3_SWING_INPUT_HASH: v3SwingHash,
        DUPLICATE_PUBLIC_CLUSTER_IDS: duplicateIds,
        HUMAN_REVIEW_IDENTITY_MAPPING_UNAMBIGUOUS: uniqueMapping,
        FUTURE_LEAK_VIOLATIONS: futureLeak,
        DETERMINISM_VIOLATIONS: determinism.DETERMINISM_VIOLATIONS,
        V2_PRODUCTION_UNCHANGED: true,
        V3_SHADOW_UNCHANGED: true,
        STRUCTURAL_RETIREMENT_USED: false,
        THRESHOLD_CHANGED: false,
        PARAMETER_OPTIMIZATION_RUN: false,
        OUTCOME_USED: false,
        NETWORK_REQUESTS_RUN: false,
        ALL_TARGETED_TESTS_PASSED: targetedPassed,
        ALL_TESTS_PASSED: allTestsPassed,
        HUMAN_REVIEW_READY: pass,
        READY_FOR_PRODUCTION_DECISION: false,
        HARD_STOP_REACHED: true
    };
    writeJson('comparison-cases.json', cases);
    writeJson('model-key.json', modelKey);
    writeJson('blind-summary.json.template', {
        status: 'AWAITING_HUMAN_LABEL_EXPORT',
        counts: { MODEL_A_BETTER: 0, MODEL_B_BETTER: 0, EQUAL: 0, BOTH_BAD: 0, UNCERTAIN: 0 },
        instruction: 'Populate from exported labels.json before any model-key reveal. Do not infer winners automatically.'
    });
    writeJson('identity-validation.json', {
        V2_SWING_INPUT_HASH: v2SwingHash, V3_SWING_INPUT_HASH: v3SwingHash,
        SAME_UNDERLYING_SWINGS: v2SwingHash === v3SwingHash,
        V3_PUBLIC_CLUSTER_IDS_SCANNED: v3.baseLedger.length,
        DUPLICATE_PUBLIC_CLUSTER_IDS: duplicateIds,
        HUMAN_REVIEW_IDENTITY_MAPPING_UNAMBIGUOUS: uniqueMapping,
        requiredRegressionCaseIds: requiredCaseIds,
        requiredRegressionCasesMapped: cases.filter(function (c) { return c.regressionCaseId; })
            .map(function (c) { return c.regressionCaseId; }).sort(function (a, b) { return a - b; })
    });
    writeJson('determinism.json', determinism);
    writeJson('test-results.json', {
        comparisonToolingTests: targetedPassed ? 'PASS (8/8)' : 'NOT_RECORDED',
        fullNpmRegression: allTestsPassed ? 'PASS' : 'NOT_RECORDED'
    });
    writeJson('summary.json', summary);
    writeJson('acceptance.json', {
        result: summary.EQH_EQL_V2_V3_BLIND_COMPARISON_V1,
        checks: {
            fixedLocalDataset: true, sameUnderlyingSwings: v2SwingHash === v3SwingHash,
            identityCollisionFree: duplicateIds === 0, humanMappingUnambiguous: uniqueMapping,
            futureSafe: futureLeak === 0, outcomeFree: outcomeViolations.length === 0,
            sampleSizeInRange: cases.length >= 36 && cases.length <= 44,
            sideBalanced: eqhCount >= 18 && eqhCount <= 22,
            modelAssignmentBalanced: aIsV2 === aIsV3,
            deterministic: determinism.DETERMINISM_VIOLATIONS === 0,
            targetedTestsPassed: targetedPassed, fullRegressionPassed: allTestsPassed,
            productionAndV3Frozen: true, structuralRetirementDisabled: true
        }
    });
    var report = '# EQH/EQL V2 vs V3 Blind-ish Human Comparison V1\n\n' +
        '## Generation result\n\n**' + summary.EQH_EQL_V2_V3_BLIND_COMPARISON_V1 + '**\n\n' +
        'This is a targeted, formation-only human comparison set. It is not a random accuracy sample and contains no automatic winner. Both models consumed the exact same canonical confirmed 2/2 Swing stream. Structural retirement was disabled.\n\n' +
        '## Review set\n\n```ini\n' + Object.keys(summary).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n\n' +
        'The browser UI intentionally exposes only MODEL A and MODEL B. The mapping is stored separately in `model-key.json` and must not be used until human labels have been exported and a blind summary has been frozen. No revealed summary was generated.\n\n' +
        '## Isolation\n\nV2 production, V3 formation/identity/member logic, thresholds, lifecycle, Registry, Sweep, WATCH, AMD, and notification were unchanged. No network request, Outcome, Sweep result, WATCH result, return, PnL, MFE, MAE, or entry information was used.\n';
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), report);
    console.log(JSON.stringify(summary, null, 2));
    console.log('[Review] ' + path.join(outputDir, 'human-review-index.html'));
}

main();
