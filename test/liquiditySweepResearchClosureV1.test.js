'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var RESEARCH = path.join(ROOT, 'research/liquidity-sweep-confirmation-semantics-v1');
var LABELS_FILE = path.join(RESEARCH, 'human-labels-frozen.json');
var ANALYSIS_FILE = path.join(RESEARCH, 'human-review-analysis.json');
var VERDICT_FILE = path.join(RESEARCH, 'human-review-verdict.txt');
var CLOSURE_FILE = path.join(RESEARCH, 'RESEARCH_CLOSURE.md');
var FROZEN_LABELS_SHA256 = 'e6561276ce35334e7f705760f0c8a81872abadeeb27d1a4de1e0ae7503f66fbd';

var passed = 0;
var failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

var labelsText = read(LABELS_FILE);
var labels = JSON.parse(labelsText);
var analysis = JSON.parse(read(ANALYSIS_FILE));
var verdict = read(VERDICT_FILE);
var closure = read(CLOSURE_FILE);

test('frozen human labels remain byte-identical and pre-unblind', function () {
    assert.strictEqual(sha256(labelsText), FROZEN_LABELS_SHA256);
    assert.strictEqual(labels.humanLabelsFrozen, true);
    assert.strictEqual(labels.answerKeyOpenedBeforeFreeze, false);
    assert.strictEqual(Object.keys(labels.labels).length, 40);
});

test('frozen 2x4 matrix remains exact', function () {
    assert.deepStrictEqual(analysis.comparison.candidateConfirmed,
        { total: 20, GOOD_SWEEP: 9, BORDERLINE: 2, TAKEN_ONLY: 7, NOT_SWEEP: 2 });
    assert.deepStrictEqual(analysis.comparison.candidateNotConfirmed,
        { total: 20, GOOD_SWEEP: 0, BORDERLINE: 0, TAKEN_ONLY: 9, NOT_SWEEP: 11 });
});

test('research verdict cannot be represented as production approval', function () {
    assert.strictEqual(analysis.hypothesisId, 'TAKEN_FAILED_ACCEPTANCE_V1');
    assert.strictEqual(analysis.verdict, 'SWEEP_SEMANTICS_NOT_JUSTIFIED');
    assert.strictEqual(analysis.productionSweepApproved, false);
    assert.strictEqual(analysis.nextSweepHypothesis, 'NONE');
    assert.match(verdict, /SWEEP_SEMANTICS_NOT_JUSTIFIED=true/);
    assert.match(verdict, /PRODUCTION_SWEEP_APPROVED=false/);
});

test('closure records exclusion-only interpretation and hard stop', function () {
    assert.match(closure, /potential exclusion signal/);
    assert.match(closure, /Production LIQUIDITY_TAKEN = SUCCESS/);
    assert.match(closure, /Production binary LIQUIDITY_SWEEP = NOT_JUSTIFIED/);
    assert.match(closure, /NEXT_SWEEP_HYPOTHESIS=NONE/);
    assert.match(closure, /PARAMETER_OPTIMIZATION=false/);
    assert.match(closure, /PRODUCTION_SWEEP_CREATED=false/);
});

console.log('\nLiquidity Sweep Research Closure V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
