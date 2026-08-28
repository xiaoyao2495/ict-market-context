'use strict';

var assert = require('assert');
var fs = require('fs');
var relabel = require('../scripts/accumulationGroundTruthV2FullRelabelV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var gt = JSON.parse(fs.readFileSync(ROOT + '/accumulation-comparative-audit-v1/human-ground-truth-v1-final.json', 'utf8'));
var manifest = JSON.parse(fs.readFileSync(ROOT + '/accumulation-detection-research-v1/sample-manifest.json', 'utf8'));
var candles = JSON.parse(fs.readFileSync(ROOT + '/eqh-eql-persistent-cluster-shadow-v3/BTCUSDT-5m-bounded-input.json', 'utf8'));
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

test('V1 and V2 relabel universes are identical 60-case sets', function () {
    var result = relabel.validateUniverse(gt, manifest);
    assert.strictEqual(result.caseUniverseSizeV1, 60);
    assert.strictEqual(result.caseUniverseSizeV2Relabel, 60);
    assert.deepStrictEqual(result.missingCases, []);
    assert.deepStrictEqual(result.extraCases, []);
    assert.deepStrictEqual(result.duplicateCases, []);
    assert.strictEqual(result.v1UniverseSha256, result.v2RelabelUniverseSha256);
});

test('blind order and mapping are deterministic and complete', function () {
    var a = relabel.buildCases(gt, manifest, candles), b = relabel.buildCases(gt, manifest, candles);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.length, 60);
    assert.strictEqual(new Set(a.map(function (row) { return row.originalCaseId; })).size, 60);
    assert.deepStrictEqual(a.map(function (row) { return row.blindId; }), Array.from({ length: 60 }, function (_, index) {
        return 'A2-BLIND-' + String(index + 1).padStart(3, '0');
    }));
});

test('every chart is formation-only with at most 24 pre-formation bars', function () {
    relabel.buildCases(gt, manifest, candles).forEach(function (item) {
        assert.ok(item.anonymous.contextBarCount <= 24);
        assert.strictEqual(item.anonymous.bars.filter(function (bar) {
            return bar.closeTime > item.anonymous.formationConfirmedAt;
        }).length, 0);
        assert.strictEqual(item.anonymous.bars[item.anonymous.bars.length - 1].closeTime, item.anonymous.formationConfirmedAt);
    });
});

test('UI is true blind, empty, definition-driven, and export-gated', function () {
    var cases = relabel.buildCases(gt, manifest, candles), html = relabel.renderHtml(cases);
    var leaks = relabel.uiLeakAudit(html, gt.map(function (row) { return row.caseId; }));
    assert.deepStrictEqual(leaks.originalCaseIds, []);
    assert.deepStrictEqual(leaks.metadataTokens, []);
    assert.strictEqual((html.match(/<article class="case"/g) || []).length, 60);
    assert.strictEqual((html.match(/<option value="" selected disabled>/g) || []).length, 60 * 9);
    assert.strictEqual((html.match(/<textarea name="why"/g) || []).length, 60);
    assert.ok(html.includes('FROZEN DEFINITION V1'));
    assert.ok(html.includes('id="export" disabled'));
    assert.ok(!/localStorage|sessionStorage/.test(html));
});

test('export payload exposes only the frozen blind review fields', function () {
    assert.deepStrictEqual(relabel.REVIEW_FIELDS, ['blindId', 'formationClass', 'confidence',
        'independentBalance', 'twoSidedAuction', 'previousTrendSeparation', 'oneSidedResidence',
        'valueMigration', 'excursionContext', 'definitionEdgeCase', 'why']);
    var html = relabel.renderHtml(relabel.buildCases(gt, manifest, candles));
    ['originalCaseId', 'frozenGroundTruthV1', 'humanLabel', 'detectorScore', 'featureSnapshot']
        .forEach(function (token) { assert.strictEqual(html.includes(token), false); });
});

console.log('\nAccumulation Ground Truth V2 Full Relabel V1 Phase 1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
