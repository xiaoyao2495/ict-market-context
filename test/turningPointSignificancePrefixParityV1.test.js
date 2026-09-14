'use strict';

/**
 * TURNING_SIGNIFICANCE_PREFIX_PARITY_TESTS —
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §70 (FUTURE_LEAK hard gate).
 *
 * The semantic layer makes a judgement AS OF candidate.confirmedAt. That claim is
 * only meaningful if the facts it reads can be rebuilt from the prefix ending on
 * the confirming bar and are byte-identical to the facts derived from the whole
 * history. This file is the gate that proves it, on real Binance USDⓈ-M 5m
 * futures candles:
 *
 *   PREFIX_FACT_PARITY = 20/20
 *   FUTURE_LEAK        = false
 *
 * It also proves the inverse: appending arbitrary FUTURE candles to the prefix
 * cannot change a single byte of the facts.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var prefixReplay = require(path.join(ROOT, 'research', 'historical-turning-point-significance-v1', 'lib', 'prefixReplayV1'));
var factsModule = require(path.join(ROOT, 'semantic', 'turningPointSignificanceFactsV1'));
var contract = require(path.join(ROOT, 'semantic', 'turningPointSignificanceSemanticV1'));

var SYMBOL = 'BTCUSDT';
var CACHE = path.join(ROOT, 'data-cache', SYMBOL + '_5m_20636_20697.json');
var SAMPLE_SIZE = 20;

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

assert.ok(fs.existsSync(CACHE), 'real ' + SYMBOL + ' 5m futures cache is required for the parity gate');
var candles = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
candles.forEach(function (candle, index) {
    assert.strictEqual(candle.source, 'futures', 'parity gate requires futures candles only');
    if (index) assert.strictEqual(candle.openTime - candles[index - 1].openTime, 300000, 'candles must be continuous');
});

var full = prefixReplay.runPrefixReplay(candles, { symbol: SYMBOL });

/**
 * Deterministic selection: the SAME 20 candidates from the same input, spread
 * across the whole series (so both the oldest and the newest regions are gated).
 */
function select(candidates) {
    var stride = Math.floor(candidates.length / SAMPLE_SIZE);
    var picks = [];
    for (var i = 0; i < SAMPLE_SIZE; i++) {
        picks.push(candidates[Math.min(candidates.length - 1, i * stride + 3)]);
    }
    return picks;
}
var picks = select(full.dynamicDPoints);
var checkpointTimes = picks.map(function (point) { return point.confirmedAt; });
var prefixRun = prefixReplay.runPrefixReplay(candles, { symbol: SYMBOL, checkpoints: checkpointTimes });

function collectTimestamps(node, out) {
    if (node === null || node === undefined) return out;
    if (typeof node === 'number') {
        if (node > 1e12) out.push(node);
        return out;
    }
    if (typeof node !== 'object') return out;
    Object.keys(node).forEach(function (key) { collectTimestamps(node[key], out); });
    return out;
}

check('the source series is the real futures cache and the population is large enough', function () {
    assert.strictEqual(candles.length, 17580);
    assert.strictEqual(candles[0].source, 'futures');
    assert.ok(full.dynamicDPoints.length >= 100,
        'expected a real Dynamic-D population, got ' + full.dynamicDPoints.length);
    console.log('   bars=' + candles.length + ' candidates=' + full.dynamicDPoints.length +
        ' eq=' + full.equalLiquidity.length + ' swings=' + full.swings.length);
});

check('selection is a pure function of the candidate list and yields 20 distinct anchors', function () {
    assert.strictEqual(picks.length, SAMPLE_SIZE);
    var again = select(full.dynamicDPoints);
    assert.deepStrictEqual(again.map(function (p) { return p.id; }), picks.map(function (p) { return p.id; }));
    assert.strictEqual(new Set(checkpointTimes).size, SAMPLE_SIZE, 'anchors must be distinct');
    var ordered = checkpointTimes.slice().sort(function (a, b) { return a - b; });
    assert.deepStrictEqual(checkpointTimes, ordered, 'anchors must be in confirmation order');
});

check('every checkpoint was captured exactly on its own confirming bar', function () {
    assert.strictEqual(Object.keys(prefixRun.checkpoints).length, SAMPLE_SIZE);
    picks.forEach(function (point) {
        var snapshot = prefixRun.checkpoints[point.confirmedAt];
        assert.ok(snapshot, 'missing checkpoint for ' + point.confirmedAt);
        assert.strictEqual(snapshot.closeTime, point.confirmedAt);
        assert.strictEqual(snapshot.candles.length, point.confirmationBarIndex + 1,
            'prefix must end exactly on the confirming candle');
        assert.strictEqual(snapshot.candles[snapshot.candles.length - 1].closeTime, point.confirmedAt);
    });
});

check('PREFIX_FACT_PARITY: prefix facts are byte-identical to full-history facts for 20/20 anchors', function () {
    var parity = 0;
    picks.forEach(function (point) {
        var snapshot = prefixRun.checkpoints[point.confirmedAt];
        var prefixFacts = factsModule.buildCanonicalFacts({
            candidate: point, candles: snapshot.candles,
            swings: snapshot.swings, displacements: snapshot.displacements
        });
        var fullFacts = factsModule.buildProduction({
            candidate: point, source: { state: full.state, candles: candles }
        });
        assert.strictEqual(contract.stableSerialize(prefixFacts), contract.stableSerialize(fullFacts),
            'prefix/full fact divergence for ' + point.id);
        parity += 1;
    });
    console.log('   PREFIX_FACT_PARITY=' + parity + '/' + SAMPLE_SIZE + ' PASS');
    assert.strictEqual(parity, SAMPLE_SIZE);
});

check('FUTURE_LEAK=false: no timestamp in any fact set exceeds candidate.confirmedAt', function () {
    picks.forEach(function (point) {
        var snapshot = prefixRun.checkpoints[point.confirmedAt];
        var built = factsModule.buildCanonicalFacts({
            candidate: point, candles: snapshot.candles,
            swings: snapshot.swings, displacements: snapshot.displacements
        });
        var offenders = collectTimestamps(built, []).filter(function (ms) { return ms > point.confirmedAt; });
        assert.deepStrictEqual(offenders, [], 'future timestamp leaked into facts for ' + point.id);
    });
    console.log('   FUTURE_LEAK=false PASS (20/20 fact sets clean)');
});

check('NEGATIVE CONTROL: appending 200 future candles cannot change a single byte of the facts', function () {
    var checked = 0;
    picks.forEach(function (point) {
        var snapshot = prefixRun.checkpoints[point.confirmedAt];
        var baseline = factsModule.buildCanonicalFacts({
            candidate: point, candles: snapshot.candles,
            swings: snapshot.swings, displacements: snapshot.displacements
        });
        // 200 bars that never existed as far as the anchor is concerned. If the
        // builder read candles.length instead of the candidate cutoff, or if the
        // displacement store answered on a wall clock rather than confirmedAt,
        // this is where it would show.
        var extended = snapshot.candles.slice();
        var lastBar = extended[extended.length - 1];
        for (var i = 1; i <= 200; i++) {
            var open = lastBar.close;
            extended.push({
                openTime: lastBar.openTime + i * 300000, open: open,
                high: open + 9000, low: open - 9000, close: open + 5000,
                closeTime: lastBar.openTime + i * 300000 + 299999, closed: true, source: 'futures'
            });
        }
        var afterAppend = factsModule.buildCanonicalFacts({
            candidate: point, candles: extended,
            swings: snapshot.swings, displacements: snapshot.displacements
        });
        assert.strictEqual(contract.stableSerialize(afterAppend), contract.stableSerialize(baseline),
            'future candles changed the facts for ' + point.id);
        checked += 1;
    });
    assert.strictEqual(checked, SAMPLE_SIZE);
});

check('detection identity: the same anchor is confirmed at the same bar without later bars', function () {
    picks.forEach(function (point) {
        var snapshot = prefixRun.checkpoints[point.confirmedAt];
        var seen = full.dynamicDPoints.filter(function (candidate) {
            return candidate.id === point.id && candidate.confirmationBarIndex <= snapshot.barIndex;
        });
        assert.strictEqual(seen.length, 1, 'anchor must be confirmed exactly once inside its own prefix');
        assert.strictEqual(seen[0].confirmedAt, point.confirmedAt);
        assert.strictEqual(seen[0].price, point.price, 'localized extreme must not depend on later bars');
        assert.strictEqual(seen[0].localizationMode, 'SAME_PROCESS_WICK_V1');
    });
});

check('the candle-prefix guard is fail-closed rather than silently truncated', function () {
    var point = picks[0];
    var snapshot = prefixRun.checkpoints[point.confirmedAt];
    var tooShort = snapshot.candles.slice(0, snapshot.candles.length - 1);
    assert.throws(function () {
        factsModule.buildProduction({ candidate: point, source: { state: full.state, candles: tooShort } });
    }, function (error) { return error.code === 'TURNING_SIGNIFICANCE_CANDLE_PREFIX_UNAVAILABLE'; });
});

check('the parity gate consumes the SAME production code path as live (no research-only detector)', function () {
    var source = fs.readFileSync(path.join(ROOT, 'research', 'historical-turning-point-significance-v1', 'lib', 'prefixReplayV1.js'), 'utf8');
    assert.ok(source.indexOf("require(path.join(ROOT, 'replay', 'replayState'))") >= 0,
        'prefix replay must drive the production replay state');
    assert.ok(source.indexOf("require(path.join(ROOT, 'events', 'displacementDetector'))") >= 0);
    assert.ok(source.indexOf('causalDynamicDHistoricalExtremes') < 0,
        'prefix replay must not re-implement or re-tune Dynamic-D');
    assert.ok(source.indexOf('theta') < 0, 'prefix replay must not own any threshold');
});

console.log('turningPointSignificancePrefixParityV1: ' + passed + ' checks passed');
