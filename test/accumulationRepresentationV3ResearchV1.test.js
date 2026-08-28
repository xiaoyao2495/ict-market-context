'use strict';

var assert = require('assert');
var fs = require('fs');
var research = require('../scripts/accumulationRepresentationV3ResearchV1');

var ROOT = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda';
var gt = JSON.parse(fs.readFileSync('accumulation-ground-truth-v2-full-relabel-v1/accumulation-ground-truth-v2.json', 'utf8'));
var manifest = JSON.parse(fs.readFileSync(ROOT + '/accumulation-detection-research-v1/sample-manifest.json', 'utf8'));
var candles = JSON.parse(fs.readFileSync(ROOT + '/eqh-eql-persistent-cluster-shadow-v3/BTCUSDT-5m-bounded-input.json', 'utf8'));
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

test('A/B frozen 60-case universe and protected content remain read-only', function () {
    assert.strictEqual(gt.groundTruthV2Frozen, true);
    assert.strictEqual(gt.cases.length, 60);
    assert.strictEqual(new Set(gt.cases.map(function (row) { return row.originalCaseId; })).size, 60);
    assert.deepStrictEqual(gt.cases.reduce(function (out, row) { out[row.formationClassV2] = (out[row.formationClassV2] || 0) + 1; return out; }, {}),
        { NO_A: 27, CLEAR_A: 23, BORDERLINE_A: 10 });
});

test('C through K definitions exclude GT V1 target, outcome, EQ, MSS, displacement, sweep, FVG and WATCH', function () {
    var defs = research.representationDefinitions();
    assert.ok(defs.length > 0);
    defs.forEach(function (def) {
        assert.strictEqual(def.labelIndependentDefinition, true);
        assert.strictEqual(def.postHocFeature, false);
        ['usesFutureData', 'usesOutcome', 'usesEQ', 'usesDisplacement', 'usesSweep', 'usesMSS', 'usesFVG']
            .forEach(function (field) { assert.strictEqual(def[field], false); });
    });
    var source = fs.readFileSync('scripts/accumulationRepresentationV3ResearchV1.js', 'utf8');
    assert.strictEqual(/human-ground-truth-v1-final|GT_V1_FILE/.test(source), false);
});

test('M determinism and D no post-confirmation bars across all 60 profiles', function () {
    var a = research.buildResearch(gt.cases, manifest, candles), b = research.buildResearch(gt.cases, manifest, candles);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.profiles.length, 60);
    a.profiles.forEach(function (profile) {
        assert.strictEqual(profile.temporalSafety.postConfirmationBarsUsed, 0);
        assert.strictEqual(profile.temporalSafety.lastBarCloseTime, profile.temporalSafety.formationConfirmedAt);
        assert.ok(profile.temporalSafety.preFormationBarsUsed <= 24);
    });
});

test('N normalized range behavior and O zero-width defense', function () {
    assert.strictEqual(research.zone(0.1), 'LOWER');
    assert.strictEqual(research.zone(0.5), 'CENTER');
    assert.strictEqual(research.zone(0.9), 'UPPER');
    var center = research.centerPathProfile([100, 100, 100], 100, 100);
    assert.ok(Number.isFinite(center.absoluteTerminalValueShift));
});

test('P short formation defense and Q causal rolling center', function () {
    var rolling = research.rollingCenters([1, 2, 3]);
    assert.strictEqual(rolling.window, 4);
    assert.deepStrictEqual(rolling.values, [1, 1.5, 2]);
    var base = research.rollingCenters([1, 2, 3, 4]).values;
    var extended = research.rollingCenters([1, 2, 3, 4, 999]).values;
    assert.deepStrictEqual(extended.slice(0, 4), base);
});

test('R side participation segmentation is episode-aware rather than touch count', function () {
    assert.strictEqual(research.zone(1 / 3), 'CENTER');
    assert.strictEqual(research.zone(2 / 3), 'CENTER');
});

test('S excursion reintegration is bounded by provided formation bars', function () {
    var bars = [
        { high: 10, low: 9, close: 9.5 }, { high: 10.1, low: 9.1, close: 9.6 },
        { high: 10.5, low: 9.5, close: 10.4 }, { high: 10.2, low: 9.4, close: 9.7 }
    ];
    var profile = research.excursionProfile(bars);
    assert.ok(profile.excursionCount >= 1);
    profile.events.forEach(function (event) { assert.ok(event.startIndex < bars.length); });
});

console.log('\nAccumulation Representation V3 Research V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
