'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var audit = require('../audit/accumulationAuctionRepresentationV1');

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.stack); }
}
function candles(positions) {
    return positions.map(function (position, index) {
        var close = position * 100;
        return { openTime: index * 300000, closeTime: (index + 1) * 300000 - 1,
            open: close, high: close + 1, low: close - 1, close: close };
    });
}
function features(positions) {
    return audit.generate({ candles: candles(positions), startIndex: 0, endIndex: positions.length - 1,
        rangeLow: 0, rangeHigh: 100 });
}

test('fixed thirds map to L/M/U deterministically', function () {
    assert.deepStrictEqual([0, 1 / 3, 0.5, 2 / 3, 1].map(audit.stateForPosition), ['L', 'L', 'M', 'U', 'U']);
});

test('state compression removes residence noise only', function () {
    assert.deepStrictEqual(audit.compress(['L', 'L', 'M', 'M', 'U', 'U', 'M', 'L']), ['L', 'M', 'U', 'M', 'L']);
});

test('side alternation ignores MID transit', function () {
    assert.strictEqual(audit.sideAlternations(['L', 'M', 'U', 'M', 'L']), 2);
    assert.strictEqual(audit.sideAlternations(['L', 'M', 'L']), 0);
});

test('complete cycle requires MID between both opposite visits', function () {
    assert.strictEqual(audit.cycleCount(['L', 'M', 'U', 'M', 'L']), 1);
    assert.strictEqual(audit.cycleCount(['L', 'U', 'L']), 0);
});

test('F1-F7 representation matches interpretable path', function () {
    var f = features([0.1, 0.2, 0.5, 0.8, 0.75, 0.5, 0.2, 0.5, 0.8]);
    assert.strictEqual(f.auctionStateSequenceText, 'LLMUUMLMU');
    assert.strictEqual(f.compressedAuctionSequenceText, 'L-M-U-M-L-M-U');
    assert.strictEqual(f.sideAlternationCount, 3);
    assert.strictEqual(f.completeAuctionCycleCount, 2);
    assert.ok(f.rebalanceCount > 0);
    assert.ok(f.excursionToMidReturnCount > 0);
    assert.deepStrictEqual(f.centerPath.length, 3);
});

test('feature generator is label blind by signature and source', function () {
    assert.strictEqual(audit.generate.length, 1);
    assert.ok(!/humanLabel|CLEAR_A|BORDERLINE_A|NO_A/.test(audit.generate.toString()));
});

test('feature source ends exactly at confirmed formation bar', function () {
    var cs = candles([0.1, 0.5, 0.9, 0.5, 0.1, 0.9]);
    var f = audit.generate({ candles: cs, startIndex: 1, endIndex: 4, rangeLow: 0, rangeHigh: 100 });
    assert.strictEqual(f.featureSourceStartIndex, 1);
    assert.strictEqual(f.featureSourceEndIndex, 4);
    assert.strictEqual(f.featureSourceConfirmedAt, cs[4].closeTime);
    assert.strictEqual(f.durationBars, 4);
});

test('core generator excludes EQ, Displacement and outcome inputs', function () {
    var source = audit.generate.toString();
    assert.ok(!/EQH|EQL|equalLiquidity|Displacement|WATCH|outcome|PnL|MFE|MAE/.test(source));
});

test('no composite score or parameter search in research module', function () {
    var source = fs.readFileSync(path.join(__dirname, '..', 'audit', 'accumulationAuctionRepresentationV1.js'), 'utf8');
    assert.ok(!/auctionScore|grid.?search|threshold.?search|\bROC\b|\bAUC\b|classifier|regression fitting|decision tree/i.test(source));
});

test('feature generation does not mutate production sources', function () {
    var root = path.join(__dirname, '..');
    var files = ['amd/accumulationDetector.js', 'config/thresholds.js',
        'events/displacementDetector.js', 'live/liveEngine.js'];
    function hashes() { return files.map(function (file) {
        return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    }); }
    var before = hashes(); features([0.1, 0.5, 0.9, 0.5, 0.1]); assert.deepStrictEqual(hashes(), before);
});

test('deterministic output', function () {
    var positions = [0.1, 0.4, 0.8, 0.5, 0.2, 0.7, 0.5];
    assert.deepStrictEqual(features(positions), features(positions));
});

console.log('\nAccumulation Balance/Auction Representation V1: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
