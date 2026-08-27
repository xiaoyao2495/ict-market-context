'use strict';

var fs = require('fs');
var path = require('path');
var rest = require('../data/binanceRest');
var shadow = require('../audit/eqPersistentClusterShadowV3');

var FIVE_MINUTES = 300000;
var validationStart = Date.UTC(2026, 6, 22, 0, 0, 0, 0);
var validationLastOpen = Date.UTC(2026, 7, 20, 23, 55, 0, 0);
var validationEnd = validationLastOpen + FIVE_MINUTES - 1;
var fetchStart = validationStart - 2 * 24 * 60 * 60 * 1000;
var defaultOutput = path.join(
    '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda',
    'eqh-eql-persistent-cluster-shadow-v3'
);
var outputDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultOutput;
var cachePath = path.join(outputDir, 'BTCUSDT-5m-bounded-input.json');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(name, value) {
    fs.writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + '\n');
}
function iso(value) { return value === null || value === undefined ? null : new Date(value).toISOString(); }
function esc(value) {
    return String(value === null || value === undefined ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function round(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return null;
    return Number(value.toFixed(digits === undefined ? 6 : digits));
}
function compactSwing(swing) {
    return {
        id: swing.id,
        type: swing.type,
        side: swing.side,
        price: swing.price,
        sourceOpenTime: swing.sourceOpenTime,
        sourceCloseTime: swing.sourceCloseTime,
        confirmedAt: swing.confirmedAt,
        metadata: swing.metadata
    };
}
function compactFeature(feature) {
    return {
        pairId: feature.pairId,
        anchorSwingId: feature.anchorSwingId,
        candidateSwingId: feature.candidateSwingId,
        absoluteDistance: round(feature.absoluteDistance),
        atrAtCandidateConfirmation: round(feature.atrAtCandidateConfirmation),
        distanceATR: round(feature.distanceATR),
        departureATR: round(feature.departureATR),
        maxConsecutiveBarsOutsideZone_0_5ATR: feature.maxConsecutiveBarsOutsideZone_0_5ATR,
        barsApart: feature.barsApart,
        classification: feature.classification,
        rejectionReason: feature.rejectionReason
    };
}
function serializeBase(base) {
    return {
        id: base.id,
        symbol: base.symbol,
        timeframe: base.timeframe,
        type: base.type,
        side: base.side,
        formationAnchor: compactSwing(base.formationAnchor),
        initialMembers: base.initialMembers.map(compactSwing),
        initialPairFeatures: compactFeature(base.initialPairFeatures),
        createdAt: base.createdAt,
        confirmedAt: base.confirmedAt
    };
}
function serializeAppend(row) {
    return {
        eventType: row.eventType,
        eventId: row.eventId,
        clusterId: row.clusterId,
        canonicalSwingId: row.canonicalSwingId,
        memberConfirmedAt: row.memberConfirmedAt,
        memberAddedAt: row.memberAddedAt,
        price: row.price,
        clusterStatusBeforeAppend: row.clusterStatusBeforeAppend,
        anchorPairFeatures: compactFeature(row.anchorPairFeatures),
        member: compactSwing(row.member)
    };
}
function projectionsAt(result, time) {
    return result.baseLedger.map(function (base) {
        return shadow.projectClusterAsOf(base, result.memberLedger, result.lifecycleLedger, time);
    }).filter(Boolean);
}
function verify(result, second) {
    var futureLeak = 0;
    var stableIdentity = 0;
    var anchorViolations = 0;
    var nonActiveAppend = 0;
    var duplicateEventIds = 0;
    var pastImmutability = 0;
    var activeOverlap = 0;
    var seenEvents = {};
    var baseById = {};
    result.baseLedger.forEach(function (base) {
        baseById[base.id] = base;
        if (base.createdAt !== base.confirmedAt || base.formationAnchor.id !== base.initialMembers[0].id) {
            stableIdentity++;
        }
    });
    result.memberLedger.forEach(function (row) {
        var before = shadow.projectClusterAsOf(
            baseById[row.clusterId], result.memberLedger, result.lifecycleLedger, row.memberAddedAt - 1
        );
        if (before && before.memberIds.indexOf(row.canonicalSwingId) !== -1) futureLeak++;
        if (row.anchorPairFeatures.classification !== 'VALID_EQ' ||
            row.anchorPairFeatures.anchorSwingId !== baseById[row.clusterId].formationAnchor.id) {
            anchorViolations++;
        }
        if (row.clusterStatusBeforeAppend !== 'ACTIVE') nonActiveAppend++;
        if (seenEvents[row.eventId]) duplicateEventIds++;
        seenEvents[row.eventId] = true;
    });
    result.checkpoints.forEach(function (checkpoint) {
        var now = shadow.hash(projectionsAt(result, checkpoint.evaluationTime));
        if (now !== checkpoint.projectionHash) pastImmutability++;
        var owner = {};
        projectionsAt(result, checkpoint.evaluationTime).filter(function (p) {
            return p.status === 'ACTIVE';
        }).forEach(function (p) {
            p.memberIds.forEach(function (memberId) {
                var key = p.type + '|' + memberId;
                if (owner[key] && owner[key] !== p.id) activeOverlap++;
                owner[key] = p.id;
            });
        });
    });
    return {
        FUTURE_LEAK_VIOLATIONS: futureLeak,
        STABLE_IDENTITY_VIOLATIONS: stableIdentity,
        BOUNDED_ANCHOR_VIOLATIONS: anchorViolations,
        NON_ACTIVE_APPEND_VIOLATIONS: nonActiveAppend,
        DUPLICATE_EVENT_ID_VIOLATIONS: duplicateEventIds,
        PAST_STATE_IMMUTABILITY_VIOLATIONS: pastImmutability,
        SIMULTANEOUS_ACTIVE_MEMBER_OVERLAP_VIOLATIONS: activeOverlap,
        DETERMINISTIC_BASE_LEDGER: shadow.hash(result.baseLedger) === shadow.hash(second.baseLedger),
        DETERMINISTIC_MEMBER_LEDGER: shadow.hash(result.memberLedger) === shadow.hash(second.memberLedger),
        DETERMINISTIC_LIFECYCLE_LEDGER: shadow.hash(result.lifecycleLedger) === shadow.hash(second.lifecycleLedger),
        DETERMINISTIC_PROJECTION: shadow.hash(result.finalProjection) === shadow.hash(second.finalProjection)
    };
}

function clusterReviewRow(base, result) {
    var appendRows = result.memberLedger.filter(function (row) { return row.clusterId === base.id; });
    var members = base.initialMembers.concat(appendRows.map(function (row) { return row.member; }));
    var features = [base.initialPairFeatures].concat(appendRows.map(function (row) {
        return row.anchorPairFeatures;
    }));
    return {
        reviewId: 'V3-' + String(base.type) + '-' + String(base.confirmedAt),
        clusterId: base.id,
        side: base.type,
        createdAt: base.createdAt,
        confirmedAt: base.confirmedAt,
        lastMemberConfirmedAt: Math.max.apply(null, members.map(function (m) { return m.confirmedAt; })),
        memberCount: members.length,
        referencePriceAtLastFormation: meanPrices(members),
        formationAnchorId: base.formationAnchor.id,
        members: members.map(compactSwing),
        pairFeatures: features.map(compactFeature)
    };
}
function meanPrices(members) {
    return members.reduce(function (sum, member) { return sum + member.price; }, 0) / members.length;
}
function sampleRows(rows, perSide) {
    var selected = [];
    ['EQH', 'EQL'].forEach(function (side) {
        var sideRows = rows.filter(function (row) { return row.side === side; });
        var persistent = sideRows.filter(function (row) { return row.memberCount >= 3; })
            .sort(function (a, b) {
                if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
                return a.confirmedAt - b.confirmedAt;
            });
        var picked = persistent.slice(0, Math.min(Math.ceil(perSide / 2), persistent.length));
        var pickedIds = {};
        picked.forEach(function (row) { pickedIds[row.clusterId] = true; });
        var remaining = sideRows.filter(function (row) { return !pickedIds[row.clusterId]; })
            .sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
        var need = perSide - picked.length;
        for (var i = 0; i < need && remaining.length; i++) {
            var index = Math.min(remaining.length - 1, Math.floor(i * remaining.length / need));
            picked.push(remaining[index]);
        }
        selected = selected.concat(picked);
    });
    return selected.sort(function (a, b) {
        if (a.side !== b.side) return a.side.localeCompare(b.side);
        return a.confirmedAt - b.confirmedAt;
    }).map(function (row, index) {
        row.reviewNumber = index + 1;
        return row;
    });
}

function renderSvg(row, candles, name) {
    var byOpen = {};
    candles.forEach(function (c, index) { byOpen[c.openTime] = index; });
    var memberIndices = row.members.map(function (member) { return byOpen[member.sourceOpenTime]; });
    var start = Math.max(0, Math.min.apply(null, memberIndices) - 24);
    var endConfirm = Math.max.apply(null, row.members.map(function (member) {
        return byOpen[member.sourceOpenTime] + 2;
    }));
    var end = Math.min(candles.length - 1, endConfirm);
    var view = candles.slice(start, end + 1);
    var width = 1440;
    var height = 720;
    var top = 78;
    var bottom = 36 + row.pairFeatures.length * 16;
    var left = 72;
    var right = 32;
    var plotW = width - left - right;
    var plotH = height - top - bottom;
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    view.forEach(function (c) { minPrice = Math.min(minPrice, c.low); maxPrice = Math.max(maxPrice, c.high); });
    var pad = Math.max((maxPrice - minPrice) * 0.08, maxPrice * 0.0001);
    minPrice -= pad;
    maxPrice += pad;
    function x(index) { return left + ((index - start) + 0.5) * plotW / view.length; }
    function y(price) { return top + (maxPrice - price) * plotH / (maxPrice - minPrice); }
    var bodyW = Math.max(0.7, Math.min(6, plotW / view.length * 0.62));
    var parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">');
    parts.push('<rect width="100%" height="100%" fill="#08111f"/>');
    parts.push('<text x="' + left + '" y="30" fill="#e5edf7" font-family="ui-monospace,monospace" font-size="18" font-weight="700">' + esc(name) + ' · ' + row.side + ' · ' + row.memberCount + ' members</text>');
    parts.push('<text x="' + left + '" y="55" fill="#8ba3bf" font-family="ui-monospace,monospace" font-size="13">Formation-only · cutoff ' + esc(iso(row.lastMemberConfirmedAt)) + ' · no later candles</text>');
    for (var grid = 0; grid <= 5; grid++) {
        var gy = top + grid * plotH / 5;
        var gp = maxPrice - grid * (maxPrice - minPrice) / 5;
        parts.push('<line x1="' + left + '" y1="' + gy + '" x2="' + (width - right) + '" y2="' + gy + '" stroke="#19314d" stroke-width="1"/>');
        parts.push('<text x="8" y="' + (gy + 4) + '" fill="#6f89a6" font-family="ui-monospace,monospace" font-size="11">' + esc(round(gp, 2)) + '</text>');
    }
    view.forEach(function (c, localIndex) {
        var globalIndex = start + localIndex;
        var color = c.close >= c.open ? '#42d392' : '#ff6b6b';
        var cx = x(globalIndex);
        parts.push('<line x1="' + cx + '" y1="' + y(c.high) + '" x2="' + cx + '" y2="' + y(c.low) + '" stroke="' + color + '" stroke-width="1"/>');
        var bodyTop = Math.min(y(c.open), y(c.close));
        var bodyHeight = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        parts.push('<rect x="' + (cx - bodyW / 2) + '" y="' + bodyTop + '" width="' + bodyW + '" height="' + bodyHeight + '" fill="' + color + '"/>');
    });
    var refY = y(row.referencePriceAtLastFormation);
    parts.push('<line x1="' + left + '" y1="' + refY + '" x2="' + (width - right) + '" y2="' + refY + '" stroke="#f7c948" stroke-width="2" stroke-dasharray="8 6"/>');
    row.members.forEach(function (member, memberIndex) {
        var index = byOpen[member.sourceOpenTime];
        var mx = x(index);
        var my = y(member.price);
        var labelY = row.side === 'EQH' ? my - 16 - (memberIndex % 2) * 18 : my + 24 + (memberIndex % 2) * 18;
        parts.push('<circle cx="' + mx + '" cy="' + my + '" r="6" fill="#08111f" stroke="#f7c948" stroke-width="3"/>');
        parts.push('<text x="' + (mx + 8) + '" y="' + labelY + '" fill="#f7c948" font-family="ui-monospace,monospace" font-size="13" font-weight="700">#' + (memberIndex + 1) + ' ' + esc(round(member.price, 2)) + '</text>');
    });
    var featureStartY = height - 20 - (row.pairFeatures.length - 1) * 16;
    row.pairFeatures.forEach(function (feature, index) {
        var line = 'A→#' + (index + 2) + ' dATR=' + round(feature.distanceATR, 3) +
            ' depATR=' + round(feature.departureATR, 3) + ' outside=' +
            feature.maxConsecutiveBarsOutsideZone_0_5ATR + ' bars=' + feature.barsApart;
        parts.push('<text x="' + left + '" y="' + (featureStartY + index * 16) + '" fill="#9fb3c8" font-family="ui-monospace,monospace" font-size="11">' + esc(line) + '</text>');
    });
    parts.push('</svg>');
    fs.writeFileSync(path.join(outputDir, 'charts', name + '.svg'), parts.join(''));
}

function renderReviewIndex(rows) {
    var cards = rows.map(function (row) {
        var filename = String(row.reviewNumber).padStart(3, '0') + '-' + row.side.toLowerCase();
        var featureLines = row.pairFeatures.map(function (feature, i) {
            return 'A→#' + (i + 2) + ': distanceATR ' + round(feature.distanceATR, 3) +
                ' · departureATR ' + round(feature.departureATR, 3) +
                ' · outside ' + feature.maxConsecutiveBarsOutsideZone_0_5ATR +
                ' · barsApart ' + feature.barsApart;
        }).join('<br>');
        return '<article class="card" data-id="' + esc(row.reviewId) + '" data-side="' + row.side + '">' +
            '<header><div><b>#' + row.reviewNumber + ' ' + row.side + '</b> · ' + row.memberCount + ' members</div>' +
            '<code>' + esc(iso(row.confirmedAt)) + '</code></header>' +
            '<img loading="lazy" src="charts/' + filename + '.svg" alt="formation-only ' + esc(row.side) + ' chart">' +
            '<div class="features">' + featureLines + '</div>' +
            '<div class="choices">' + ['YES', 'NO', 'BORDERLINE'].map(function (label) {
                return '<button type="button" data-label="' + label + '">' + label + '</button>';
            }).join('') + '</div>' +
            '<textarea placeholder="人工备注（可选）"></textarea></article>';
    }).join('');
    var html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EQH/EQL Persistent Cluster V3 Human Review</title><style>' +
        ':root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#050b14;color:#e7eef8}body{margin:0}nav{position:sticky;top:0;z-index:2;background:#08111fee;border-bottom:1px solid #1d3550;padding:14px 22px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}nav strong{margin-right:auto}button,select{background:#12243a;color:#dce8f6;border:1px solid #34506e;border-radius:7px;padding:8px 12px}main{max-width:1480px;margin:auto;padding:20px}.card{border:1px solid #1c3550;border-radius:12px;background:#0a1524;margin:0 0 24px;overflow:hidden}.card header{display:flex;justify-content:space-between;padding:12px 16px;background:#0e1c2e}.card img{width:100%;display:block}.features{font:12px ui-monospace,monospace;color:#aac0d7;padding:10px 16px;line-height:1.7}.choices{display:flex;gap:8px;padding:4px 16px 10px}.choices button.selected{background:#e8b84a;color:#08111f;border-color:#e8b84a;font-weight:700}textarea{display:block;box-sizing:border-box;width:calc(100% - 32px);margin:0 16px 16px;min-height:58px;background:#06101c;color:#e7eef8;border:1px solid #29435f;border-radius:7px;padding:8px}.hidden{display:none}@media(max-width:700px){main{padding:8px}.card header{display:block}.card img{min-height:300px;object-fit:contain}.features{font-size:11px}}' +
        '</style></head><body><nav><strong>Persistent EQ Cluster V3 · Formation-only 人工复核</strong><span id="count"></span><select id="filter"><option value="ALL">全部</option><option value="UNLABELED">未标注</option><option value="EQH">EQH</option><option value="EQL">EQL</option></select><button id="export">导出 labels.json</button><button id="clear">清空本页标签</button></nav><main>' + cards + '</main><script>' +
        'const key="eqPersistentClusterV3Labels";let state=JSON.parse(localStorage.getItem(key)||"{}");const cards=[...document.querySelectorAll(".card")];function save(){localStorage.setItem(key,JSON.stringify(state));render()}function render(){const f=document.querySelector("#filter").value;let shown=0;cards.forEach(c=>{const d=state[c.dataset.id]||{};c.querySelectorAll("button[data-label]").forEach(b=>b.classList.toggle("selected",b.dataset.label===d.label));c.querySelector("textarea").value=d.note||"";const visible=f==="ALL"||(f==="UNLABELED"&&!d.label)||c.dataset.side===f;c.classList.toggle("hidden",!visible);if(visible)shown++});document.querySelector("#count").textContent=shown+" / "+cards.length}cards.forEach(c=>{c.querySelectorAll("button[data-label]").forEach(b=>b.onclick=()=>{state[c.dataset.id]={label:b.dataset.label,note:c.querySelector("textarea").value};save()});c.querySelector("textarea").onchange=e=>{state[c.dataset.id]={label:(state[c.dataset.id]||{}).label||null,note:e.target.value};save()}});document.querySelector("#filter").onchange=render;document.querySelector("#export").onclick=()=>{const payload=cards.map(c=>({reviewId:c.dataset.id,side:c.dataset.side,label:(state[c.dataset.id]||{}).label||null,note:(state[c.dataset.id]||{}).note||""}));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}));a.download="eqh-eql-v3-human-labels.json";a.click();URL.revokeObjectURL(a.href)};document.querySelector("#clear").onclick=()=>{if(confirm("清空本页所有人工标签？")){state={};save()}};render();' +
        '</script></body></html>';
    fs.writeFileSync(path.join(outputDir, 'human-review-index.html'), html);
}

function makeReport(summary, validation) {
    return '# EQH/EQL Persistent Cluster Shadow V3 — Bounded BTCUSDT Review\n\n' +
        '## Result\n\n' +
        '**' + (summary.SHADOW_VALIDATION_PASS ? 'PASS' : 'FAIL') +
        ' — audit-only V3 shadow; production Registry, Sweep, and WATCH were not connected.**\n\n' +
        '## Fixed replay\n\n' +
        '- Symbol/timeframe: BTCUSDT 5m\n' +
        '- Validation: `' + summary.VALIDATION_WINDOW_START + '` → `' + summary.VALIDATION_WINDOW_END + '`\n' +
        '- Closed validation candles: ' + summary.VALIDATION_BARS + '\n' +
        '- Warm-up candles: ' + summary.WARMUP_BARS + '\n' +
        '- Pivot: 2L / 2R\n' +
        '- Frozen gates: distanceATR ≤ 0.7; departureATR ≥ 1.75; outside-zone streak ≥ 1\n\n' +
        '## Population\n\n```ini\n' + Object.keys(summary).filter(function (key) {
            return /^[A-Z0-9_]+$/.test(key);
        }).map(function (key) { return key + ' = ' + summary[key]; }).join('\n') + '\n```\n\n' +
        '## Temporal and identity invariants\n\n```json\n' + JSON.stringify(validation, null, 2) + '\n```\n\n' +
        '## Human review\n\n' +
        'The review queue is deterministic and balanced where population permits. It prioritizes 3+ member persistent clusters, then samples two-member formations across time. Every chart stops at the last visible member confirmation; no later candle, Sweep result, WATCH, notification, or Outcome is shown.\n\n' +
        '## Isolation\n\n```ini\nPRODUCTION_CHANGED = false\nREGISTRY_CONNECTED = false\nSWEEP_CONNECTED = false\nWATCH_CONNECTED = false\nNOTIFICATION_CHANGED = false\nTHRESHOLD_CHANGED = false\nGROUPING_CHANGED = false\n```\n';
}

async function loadCandles() {
    ensureDir(outputDir);
    if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    var candles = await rest.loadHistory('BTCUSDT', '5m', fetchStart, validationLastOpen, {
        pageLimit: 1500,
        onProgress: function (count) { console.log('[Fetch] ' + count + ' candles'); }
    });
    candles = candles.filter(function (c) {
        return c.closed !== false && c.openTime >= fetchStart && c.openTime <= validationLastOpen;
    }).sort(function (a, b) { return a.openTime - b.openTime; });
    fs.writeFileSync(cachePath, JSON.stringify(candles));
    return candles;
}

async function main() {
    var started = Date.now();
    var candles = await loadCandles();
    var validationBars = candles.filter(function (c) {
        return c.openTime >= validationStart && c.openTime <= validationLastOpen;
    });
    if (validationBars.length !== 8640) {
        throw new Error('Expected 8640 closed validation candles, got ' + validationBars.length);
    }
    console.log('[Replay A] ' + candles.length + ' candles');
    var result = shadow.runShadow(candles, {
        symbol: 'BTCUSDT', timeframe: '5m', left: 2, right: 2,
        validationStart: validationStart, validationEnd: validationEnd, checkpointEvery: 500
    });
    console.log('[Replay B] deterministic rerun');
    var second = shadow.runShadow(candles, {
        symbol: 'BTCUSDT', timeframe: '5m', left: 2, right: 2,
        validationStart: validationStart, validationEnd: validationEnd, checkpointEvery: 500
    });
    var validation = verify(result, second);
    var validationCreated = result.baseLedger.filter(function (base) {
        return base.confirmedAt >= validationStart && base.confirmedAt <= validationEnd;
    });
    var reviewPopulation = validationCreated.map(function (base) {
        return clusterReviewRow(base, result);
    });
    var reviewRows = sampleRows(reviewPopulation, 30);
    ensureDir(path.join(outputDir, 'charts'));
    reviewRows.forEach(function (row) {
        var filename = String(row.reviewNumber).padStart(3, '0') + '-' + row.side.toLowerCase();
        renderSvg(row, candles, filename);
    });
    renderReviewIndex(reviewRows);

    var pass = Object.keys(validation).every(function (key) {
        return typeof validation[key] === 'boolean' ? validation[key] : validation[key] === 0;
    });
    var summary = {
        SYMBOL: 'BTCUSDT',
        TIMEFRAME: '5m',
        VALIDATION_WINDOW_START: iso(validationStart),
        VALIDATION_WINDOW_END: iso(validationEnd),
        VALIDATION_BARS: validationBars.length,
        WARMUP_BARS: candles.length - validationBars.length,
        CONFIRMED_SWING_HIGH: result.swings.filter(function (s) {
            return s.type === 'SWING_HIGH' && s.confirmedAt >= validationStart && s.confirmedAt <= validationEnd;
        }).length,
        CONFIRMED_SWING_LOW: result.swings.filter(function (s) {
            return s.type === 'SWING_LOW' && s.confirmedAt >= validationStart && s.confirmedAt <= validationEnd;
        }).length,
        V3_EQ_OBJECTS_CREATED: validationCreated.length,
        V3_EQH_CREATED: validationCreated.filter(function (base) { return base.type === 'EQH'; }).length,
        V3_EQL_CREATED: validationCreated.filter(function (base) { return base.type === 'EQL'; }).length,
        V3_MEMBER_APPEND_EVENTS: result.memberLedger.filter(function (row) {
            return row.memberAddedAt >= validationStart && row.memberAddedAt <= validationEnd;
        }).length,
        V3_CLUSTERS_WITH_3_PLUS_MEMBERS: reviewPopulation.filter(function (row) {
            return row.memberCount >= 3;
        }).length,
        V3_MAX_MEMBER_COUNT: reviewPopulation.reduce(function (max, row) {
            return Math.max(max, row.memberCount);
        }, 0),
        AMBIGUOUS_UNASSIGNED: result.decisionLedger.filter(function (row) {
            return row.eventType === 'AMBIGUOUS_UNASSIGNED' &&
                row.candidateConfirmedAt >= validationStart && row.candidateConfirmedAt <= validationEnd;
        }).length,
        HUMAN_REVIEW_SAMPLE_COUNT: reviewRows.length,
        RUNTIME_SECONDS: round((Date.now() - started) / 1000, 3),
        SHADOW_VALIDATION_PASS: pass,
        PRODUCTION_CHANGED: false,
        REGISTRY_CONNECTED: false,
        SWEEP_CONNECTED: false,
        WATCH_CONNECTED: false,
        THRESHOLD_CHANGED: false
    };

    writeJson('input-manifest.json', {
        symbol: 'BTCUSDT', timeframe: '5m', source: candles[0] && candles[0].source,
        fetchStart: fetchStart, validationStart: validationStart, validationEnd: validationEnd,
        totalCandles: candles.length, validationBars: validationBars.length,
        firstOpenTime: candles[0].openTime, lastCloseTime: candles[candles.length - 1].closeTime,
        closedCandlesOnly: candles.every(function (c) { return c.closed !== false; }),
        inputSha256: shadow.hash(candles)
    });
    writeJson('summary.json', summary);
    writeJson('temporal-validation.json', validation);
    writeJson('cluster-base-ledger.json', result.baseLedger.map(serializeBase));
    writeJson('member-append-ledger.json', result.memberLedger.map(serializeAppend));
    writeJson('lifecycle-ledger.json', result.lifecycleLedger);
    writeJson('ambiguity-events.json', result.decisionLedger.filter(function (row) {
        return row.eventType === 'AMBIGUOUS_UNASSIGNED';
    }));
    writeJson('final-projection.json', result.finalProjection);
    writeJson('human-review-samples.json', reviewRows);
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), makeReport(summary, validation));
    console.log(JSON.stringify(summary, null, 2));
    console.log('[Artifacts] ' + outputDir);
}

main().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});
