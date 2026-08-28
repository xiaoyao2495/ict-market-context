'use strict';

var assert = require('assert');
var audit = require('../scripts/accumulationConflictHumanAuditV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function fixture() {
    var manifest = [], profiles = [], candles = [];
    for (var i = 0; i < 120; i++) candles.push({ openTime: 1000 + i * 300000, closeTime: 1000 + i * 300000 + 299999,
        open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1, close: 100.5 + i * 0.1 });
    audit.REVIEW_IDS.forEach(function (caseId, index) {
        var start = 25 + index * 10, end = start + 5, confirmedAt = candles[end].openTime + 299999;
        manifest.push({ caseId: caseId, row: { symbol: 'BTCUSDT', timeframe: '5m', formationStartAt: candles[start].openTime,
            confirmedAt: confirmedAt, startIndex: start, endIndex: end, rangeHighAtConfirmation: 110 + index,
            rangeLowAtConfirmation: 90 + index, rangeMidAtConfirmation: 100 + index } });
        profiles.push({ caseId: caseId, featureSourceEndIndex: end, featureSourceConfirmedAt: confirmedAt,
            humanLabel: index < 4 ? 'CLEAR_A' : 'NO_A', prototypeDecision: index < 4 ? 'REJECT_CANDIDATE' : 'KEEP' });
    });
    return { manifest: manifest, profiles: profiles, candles: candles };
}

test('deterministic shuffle produces seven unique anonymous positions', function () {
    var a = audit.deterministicOrder(audit.REVIEW_IDS, audit.SEED);
    var b = audit.deterministicOrder(audit.REVIEW_IDS, audit.SEED);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(new Set(a).size, 7);
    assert.notDeepStrictEqual(a, audit.REVIEW_IDS);
});

test('anonymous cases stop at confirmation and include no more than 24 prior bars', function () {
    var f = fixture(), cases = audit.buildCases(f.manifest, f.profiles, f.candles);
    assert.strictEqual(cases.length, 7);
    cases.forEach(function (item, index) {
        assert.strictEqual(item.anonymous.blindId, 'BLIND-' + String(index + 1).padStart(2, '0'));
        assert.ok(item.anonymous.contextBarCount <= 24);
        assert.ok(item.anonymous.bars.every(function (bar) { return bar.closeTime <= item.anonymous.formationConfirmedAt; }));
        assert.strictEqual(item.anonymous.bars[item.anonymous.bars.length - 1].closeTime, item.anonymous.formationConfirmedAt);
    });
});

test('blind page has no frozen metadata, source ids, or separate map dependency', function () {
    var f = fixture(), html = audit.renderHtml(audit.buildCases(f.manifest, f.profiles, f.candles));
    assert.deepStrictEqual(audit.uiLeaks(html), []);
    assert.strictEqual((html.match(/<article class="case"/g) || []).length, 7);
    assert.strictEqual((html.match(/<svg /g) || []).length, 7);
    assert.ok(!/blind-case-map\.json|fetch\s*\(/.test(html));
});

test('review controls start blank and export contains only anonymous review fields', function () {
    var f = fixture(), html = audit.renderHtml(audit.buildCases(f.manifest, f.profiles, f.candles));
    assert.ok(!/<input[^>]+\schecked(?:\s|=|>)/.test(html));
    assert.ok(!/localStorage|sessionStorage/.test(html));
    assert.ok(/disabled>导出复核结果/.test(html));
    assert.ok(/blindId:r\.blindId,formationClass:/.test(html));
    assert.ok(!/originalCaseId|frozenGroundTruth|prototypeDecision/.test(html));
});

test('rendering is byte deterministic', function () {
    var f = fixture(), cases = audit.buildCases(f.manifest, f.profiles, f.candles);
    assert.strictEqual(audit.renderHtml(cases), audit.renderHtml(cases));
});

console.log('\nAccumulation Conflict Human Audit V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
