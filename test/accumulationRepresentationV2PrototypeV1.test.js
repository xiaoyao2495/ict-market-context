'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var prototype = require('../audit/accumulationRepresentationV2PrototypeV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function center(path) { return { earlyCenter: path[0], middleCenter: path[1], lateCenter: path[2],
    centerPath: path, centerMigrationMagnitude: Math.max.apply(null, path) - Math.min.apply(null, path) }; }
function reabsorb(failed) { return { excursionCount: 3, midReturns: 3 - failed, oppositeSideReturns: 2,
    failedReabsorptions: failed }; }

test('center path type is order-only and deterministic', function () {
    assert.strictEqual(prototype.centerPathType([0.2, 0.5, 0.8]), 'MONOTONIC_UP');
    assert.strictEqual(prototype.centerPathType([0.8, 0.5, 0.2]), 'MONOTONIC_DOWN');
    assert.strictEqual(prototype.centerPathType([0.2, 0.8, 0.3]), 'REVERSING');
    assert.strictEqual(prototype.centerPathType([0.4, 0.4, 0.5]), 'STABLE_OR_MIXED');
});

test('combined monotonic migration and failed reabsorption rejects', function () {
    assert.strictEqual(prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(1)).prototypeDecision, 'REJECT_CANDIDATE');
});

test('single concern weakens without rejection', function () {
    assert.strictEqual(prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(0)).prototypeDecision, 'WEAKEN');
    assert.strictEqual(prototype.decide(center([0.2, 0.8, 0.3]), reabsorb(1)).prototypeDecision, 'WEAKEN');
});

test('reversing and reabsorbed profile keeps', function () {
    var result = prototype.decide(center([0.2, 0.8, 0.3]), reabsorb(0));
    assert.strictEqual(result.prototypeDecision, 'KEEP');
    assert.strictEqual(result.CENTER_STATE, 'STABLE');
    assert.strictEqual(result.REABSORPTION_STATE, 'HEALTHY');
});

test('decision function excludes label, EQ, Displacement, baseline and F5', function () {
    var source = prototype.decide.toString();
    assert.ok(!/humanLabel|CLEAR_A|NO_A|EQH|EQL|Displacement|baseline|returnBars|secondaryReturn|F5/.test(source));
    assert.strictEqual(prototype.decide.length, 2);
});

test('no optimized cutoff, score, or feature family in prototype module', function () {
    var source = fs.readFileSync(path.join(__dirname, '..', 'audit', 'accumulationRepresentationV2PrototypeV1.js'), 'utf8');
    assert.ok(!/grid.?search|random.?search|weight.?sweep|threshold.?sweep|\bROC\b|\bAUC\b|decision tree|machine learning/i.test(source));
    assert.ok(!/migrationScore|balanceScoreV2|reabsorptionScore|F6F7Score|weightedScore|\bF8\b|\bF9\b|\bF10\b/.test(source));
});

test('F5 changes cannot change a prototype decision', function () {
    var a = prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(1));
    var b = prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(1));
    assert.deepStrictEqual(a, b);
});

test('conflicts expose every CLEAR and critical CLEAR rejection', function () {
    var rows = [Object.assign({ caseId: 'case001', humanLabel: 'CLEAR_A' }, prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(1)), { centerProfile: center([0.2, 0.5, 0.8]), reabsorptionProfile: reabsorb(1) }),
        Object.assign({ caseId: 'case045', humanLabel: 'NO_A' }, prototype.decide(center([0.2, 0.8, 0.3]), reabsorb(0)), { centerProfile: center([0.2, 0.8, 0.3]), reabsorptionProfile: reabsorb(0) })];
    var conflicts = prototype.conflictAudit(rows, ['case001']);
    assert.deepStrictEqual(conflicts.C1_CLEAR_TO_REJECT_CANDIDATE, ['case001']);
    assert.deepStrictEqual(conflicts.C2_CRITICAL_CLEAR_TO_REJECT_CANDIDATE, ['case001']);
    assert.deepStrictEqual(conflicts.C3_NO_A_TO_KEEP_F6_F7_UNEXPLAINED, ['case045']);
});

test('prototype processing does not mutate production sources', function () {
    var root = path.join(__dirname, '..');
    var files = ['amd/accumulationDetector.js', 'amd/amdState.js', 'config/thresholds.js',
        'events/displacementDetector.js', 'live/liveEngine.js'];
    function hashes() { return files.map(function (file) { return crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(root, file))).digest('hex'); }); }
    var before = hashes(); prototype.decide(center([0.2, 0.5, 0.8]), reabsorb(1)); assert.deepStrictEqual(hashes(), before);
});

test('deterministic profiles and decisions', function () {
    var a = prototype.decide(center([0.1, 0.7, 0.5]), reabsorb(0));
    var b = prototype.decide(center([0.1, 0.7, 0.5]), reabsorb(0));
    assert.deepStrictEqual(a, b);
});

console.log('\nAccumulation Representation V2 Prototype V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
