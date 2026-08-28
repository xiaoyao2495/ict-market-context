'use strict';

var assert = require('assert');
var fs = require('fs');
var freeze = require('../scripts/accumulationGroundTruthV2FreezeV1');

var SOURCE = '/Users/yaodebao/.codex/visualizations/2026/08/24/01a031bc-fea2-7943-9b4f-2a5e77efcdda/accumulation-ground-truth-v2-full-relabel-v1';
var gt = JSON.parse(fs.readFileSync(SOURCE + '/accumulation-ground-truth-v2.json', 'utf8'));
var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}

test('freeze keeps all 60 protected case values unchanged', function () {
    var before = freeze.protectedHash(gt.cases);
    var frozen = freeze.freezeGroundTruth(gt, '2026-08-28T00:00:00.000Z');
    assert.strictEqual(freeze.protectedHash(frozen.cases), before);
    assert.strictEqual(frozen.cases.length, 60);
    assert.strictEqual(frozen.groundTruthV2Frozen, true);
    assert.strictEqual(frozen.groundTruthV2ReadyForFreeze, true);
});

test('freeze records the fixed interpretation and historical V1 status', function () {
    var frozen = freeze.freezeGroundTruth(gt, '2026-08-28T00:00:00.000Z');
    assert.strictEqual(frozen.groundTruthV1Status, 'HISTORICAL_SUPERSEDED_FOR_RESEARCH_GUIDANCE');
    assert.strictEqual(frozen.freezeAuthorization, 'USER_FINAL_APPROVAL');
    assert.strictEqual(frozen.protectedFields.length, 13);
});

test('already frozen rerun preserves frozenAt and protected hash', function () {
    var once = freeze.freezeGroundTruth(gt, '2026-08-28T00:00:00.000Z');
    var twice = freeze.freezeGroundTruth(once, '2099-01-01T00:00:00.000Z');
    assert.strictEqual(twice.frozenAt, once.frozenAt);
    assert.strictEqual(twice.protectedCasesSha256, once.protectedCasesSha256);
    assert.deepStrictEqual(twice.cases, once.cases);
});

console.log('\nAccumulation Ground Truth V2 Freeze V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
