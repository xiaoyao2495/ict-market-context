'use strict';

var assert = require('assert');
var audit = require('../scripts/accumulationGroundTruthConsistencyAuditV2');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function fixtures() {
    var labels = ['CLEAR_A', 'BORDERLINE_A', 'NO_A'], gt = [], manifest = [], candles = [];
    for (var b = 0; b < 500; b++) candles.push({ openTime: 1000 + b * 300000,
        closeTime: 1000 + b * 300000 + 299999, open: 100 + b * 0.01, high: 101 + b * 0.01,
        low: 99 + b * 0.01, close: 100.4 + b * 0.01 });
    labels.forEach(function (label, cohort) {
        for (var i = 0; i < 10; i++) {
            var id = 'case' + String(cohort * 10 + i + 1).padStart(3, '0'), start = 30 + cohort * 120 + i * 9, end = start + 7 + i % 3;
            gt.push({ caseId: id, humanLabel: label });
            manifest.push({ caseId: id, row: { symbol: 'BTCUSDT', timeframe: '5m', formationStartAt: candles[start].openTime,
                confirmedAt: candles[end].closeTime, startIndex: start, endIndex: end,
                rangeHighAtConfirmation: 110 + cohort, rangeLowAtConfirmation: 90 + cohort, rangeMidAtConfirmation: 100 + cohort,
                features: { durationBars: end - start + 1, rangeWidthATR: 1 + i * 0.1,
                    midCrossCount: 2 + i % 5, upperTouchCount: 1 + i % 4, lowerTouchCount: 1 + (i * 2) % 5 } } });
        }
    });
    return { gt: gt, manifest: manifest, candles: candles };
}

test('coverage sample is deterministic and feature-diverse', function () {
    var rows = [];
    for (var i = 0; i < 12; i++) rows.push({ caseId: 'x' + i, features: { durationBars: i,
        rangeWidthATR: i % 4, midCrossCount: i % 3, upperTouchCount: i % 5, lowerTouchCount: i % 2 } });
    var a = audit.coverageSample(rows, 8, 'fixed', audit.DIVERSITY_FIELDS);
    var b = audit.coverageSample(rows, 8, 'fixed', audit.DIVERSITY_FIELDS);
    assert.deepStrictEqual(a.map(function (x) { return x.caseId; }), b.map(function (x) { return x.caseId; }));
    assert.strictEqual(new Set(a.map(function (x) { return x.caseId; })).size, 8);
});

test('primary sample is exactly 8 per frozen cohort', function () {
    var f = fixtures(), selected = audit.selectPrimary(f.gt, f.manifest);
    assert.strictEqual(selected.length, 24);
    ['CLEAR_A', 'BORDERLINE_A', 'NO_A'].forEach(function (label) {
        assert.strictEqual(selected.filter(function (row) { return row.frozenGroundTruth === label; }).length, 8);
    });
});

test('blind order is deterministic and does not expose cohort blocks', function () {
    var f = fixtures(), selected = audit.selectPrimary(f.gt, f.manifest);
    var a = audit.blindOrder(selected), b = audit.blindOrder(selected);
    assert.deepStrictEqual(a.map(function (x) { return x.caseId; }), b.map(function (x) { return x.caseId; }));
    assert.ok(new Set(a.slice(0, 8).map(function (x) { return x.frozenGroundTruth; })).size > 1);
});

test('formation data stops exactly at confirmedAt with at most 24 prior bars', function () {
    var f = fixtures(), cases = audit.buildCases(f.gt, f.manifest, f.candles);
    cases.forEach(function (item) {
        assert.ok(item.anonymous.contextBarCount <= 24);
        assert.strictEqual(item.anonymous.bars[item.anonymous.bars.length - 1].closeTime, item.anonymous.formationConfirmedAt);
        assert.ok(item.anonymous.bars.every(function (bar) { return bar.closeTime <= item.anonymous.formationConfirmedAt; }));
    });
});

test('blind UI exposes answer labels but no frozen metadata or original ids', function () {
    var f = fixtures(), html = audit.renderHtml(audit.buildCases(f.gt, f.manifest, f.candles)), leaks = audit.uiLeakAudit(html);
    assert.deepStrictEqual(leaks, { metadataTokens: [], originalCaseIds: [] });
    assert.ok(html.includes('<option value="CLEAR_A">CLEAR_A</option>'));
    assert.strictEqual((html.match(/<article class="case"/g) || []).length, 24);
    assert.strictEqual((html.match(/<svg /g) || []).length, 24);
    assert.ok(!/blind-case-map\.json|fetch\s*\(/.test(html));
});

test('human responses start blank and export omits unblind fields', function () {
    var f = fixtures(), html = audit.renderHtml(audit.buildCases(f.gt, f.manifest, f.candles));
    assert.strictEqual((html.match(/<option value="" selected disabled>/g) || []).length, 24 * 9);
    assert.ok(/id="export" disabled/.test(html));
    assert.ok(!/localStorage|sessionStorage/.test(html));
    assert.ok(!/originalCaseId|frozenGroundTruth/.test(html));
});

console.log('\nAccumulation Ground Truth Consistency Audit V2: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
