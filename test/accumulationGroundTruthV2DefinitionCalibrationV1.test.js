'use strict';

var assert = require('assert');
var calibration = require('../scripts/accumulationGroundTruthV2DefinitionCalibrationV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

function row(id, label, options) {
    options = options || {};
    return { originalCaseId: id, blindId: 'GT-' + id, blindLabel: label,
        confidence: options.confidence || 'HIGH', agreementRelation: options.relation || 'EXACT',
        frozenGroundTruth: options.frozen || label, humanSemanticAnswers: {
            independentBalanceFormed: options.independent || (label === 'CLEAR_A' ? 'YES' : label === 'NO_A' ? 'NO' : 'PARTIAL'),
            twoSidedAuction: options.twoSided || (label === 'CLEAR_A' ? 'COHERENT' : label === 'NO_A' ? 'WEAK' : 'PARTIAL'),
            trendPauseCharacter: options.trend || (label === 'NO_A' ? 'STRONG' : 'NONE'),
            oneSidedResidence: options.residence || (label === 'NO_A' ? 'STRONG' : 'NONE') } };
}

function population() {
    var rows = [];
    for (var i = 1; i <= 6; i++) rows.push(row('a' + i, 'CLEAR_A'));
    for (var j = 1; j <= 6; j++) rows.push(row('b' + j, 'NO_A'));
    for (var k = 1; k <= 6; k++) rows.push(row('c' + k, 'BORDERLINE_A'));
    for (var d = 1; d <= 6; d++) rows.push(row('d' + d, d % 2 ? 'CLEAR_A' : 'NO_A', {
        relation: 'MAJOR_DISAGREEMENT', frozen: d % 2 ? 'NO_A' : 'CLEAR_A' }));
    return rows;
}

test('selection is deterministic, unique, and exactly three per type', function () {
    var a = calibration.selectCalibrationCases(population()), b = calibration.selectCalibrationCases(population());
    assert.deepStrictEqual(a.map(function (x) { return x.row.originalCaseId; }), b.map(function (x) { return x.row.originalCaseId; }));
    assert.strictEqual(a.length, 12);
    assert.strictEqual(new Set(a.map(function (x) { return x.row.originalCaseId; })).size, 12);
    calibration.TYPES.forEach(function (type) { assert.strictEqual(a.filter(function (x) { return x.type === type; }).length, 3); });
});

test('high-confidence major disagreement pool is selected without outcome fields', function () {
    var source = calibration.selectCalibrationCases.toString();
    assert.ok(/HIGH/.test(source) && /MAJOR_DISAGREEMENT/.test(source));
    assert.ok(!/outcome|MSS|Displacement|FVG|WATCH|PnL/i.test(source));
});

test('calibration HTML contains Draft 0 and locked two-stage workflow', function () {
    var cases = [];
    for (var i = 1; i <= 12; i++) cases.push({ calibrationId: 'CAL-' + String(i).padStart(2, '0'),
        selectionRationale: 'formation-only calibration purpose', priorDisagreement: false,
        previousBlindSemanticObservations: { independentBalanceFormed: 'PARTIAL', twoSidedAuction: 'PARTIAL',
            trendPauseCharacter: 'WEAK', oneSidedResidence: 'MILD', centerBehavior: 'STABLE',
            excursionBehavior: 'REABSORBED', freeText: 'formation-only observation' },
        anonymous: { calibrationId: 'CAL-' + String(i).padStart(2, '0'), formationStartAt: 1000,
            formationConfirmedAt: 2000, rangeHigh: 110, rangeLow: 90, rangeMid: 100, contextBarCount: 1,
            bars: [{ time: 1000, closeTime: 2000, open: 99, high: 101, low: 98, close: 100 }] } });
    var html = calibration.renderHtml(cases);
    assert.ok(html.includes('Definition Draft 0'));
    assert.strictEqual((html.match(/<article class="case"/g) || []).length, 12);
    assert.strictEqual((html.match(/class="context-toggle" disabled/g) || []).length, 12);
    assert.strictEqual((html.match(/class="context" hidden/g) || []).length, 12);
});

test('calibration responses are blank and export contains no V1 label', function () {
    var cases = [];
    for (var i = 1; i <= 12; i++) cases.push({ calibrationId: 'CAL-' + String(i).padStart(2, '0'),
        selectionRationale: 'formation-only calibration purpose', priorDisagreement: false,
        previousBlindSemanticObservations: { independentBalanceFormed: 'PARTIAL', twoSidedAuction: 'PARTIAL',
            trendPauseCharacter: 'WEAK', oneSidedResidence: 'MILD', centerBehavior: 'STABLE',
            excursionBehavior: 'REABSORBED', freeText: 'formation-only observation' },
        anonymous: { calibrationId: 'CAL-' + String(i).padStart(2, '0'), formationStartAt: 1000,
            formationConfirmedAt: 2000, rangeHigh: 110, rangeLow: 90, rangeMid: 100, contextBarCount: 1,
            bars: [{ time: 1000, closeTime: 2000, open: 99, high: 101, low: 98, close: 100 }] } });
    var html = calibration.renderHtml(cases);
    assert.strictEqual((html.match(/<option value="" selected disabled>/g) || []).length, 12 * 8);
    assert.ok(!/localStorage|sessionStorage|frozenGroundTruthV1|previousBlindLabel|originalCaseId|GT-BLIND-\d+/.test(html));
});

console.log('\nAccumulation Ground Truth V2 Definition Calibration V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
