'use strict';

// THREE_BAR_REVERSAL_CONTEXT_AUDIT_V1 - research test suite (network-free).
// Covers both directions of the three-bar structure, the K2 pause variants,
// the canonical extreme, the context payload/alignment and the lookahead ban.

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var L = require('../research/reversalPatternSemanticAuditV1');

var passed = 0;
var failed = 0;
function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('PASS ' + name);
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + name);
        console.log('  ' + (e && e.message));
    }
}

var BAR = 300000;
function bar(i, o, h, l, c) {
    return {
        openTime: i * BAR,
        closeTime: (i + 1) * BAR - 1,
        open: o, high: h, low: l, close: c,
        closed: true,
        source: 'futures'
    };
}

// K1 bear, K2 pause variant, K3 bull  -> bullish / bottom three-bar
function bullishTrio(k2) {
    return [
        bar(0, 100, 101, 95, 96),
        bar(1, k2.open, k2.high, k2.low, k2.close),
        bar(2, 96.5, 101.5, 96, 101)
    ];
}

// K1 bull, K2 pause variant, K3 bear  -> bearish / top three-bar
function bearishTrio(k2) {
    return [
        bar(0, 96, 101, 95, 100),
        bar(1, k2.open, k2.high, k2.low, k2.close),
        bar(2, 100, 101, 95, 96)
    ];
}

function candidatesOf(bars) {
    return L.threeBarCandidates(bars.map(L.candleFacts));
}

// ============================================ structure (both directions)

test('T1 bear -> pause -> bull is a BULLISH three-bar candidate', function () {
    var hits = candidatesOf(bullishTrio({ open: 96, high: 97, low: 95.5, close: 96.5 }));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BULLISH');
    assert.strictEqual(hits[0].pattern, 'THREE_BAR_REVERSAL');
});

test('T2 bull -> pause -> bear is a BEARISH three-bar candidate', function () {
    var hits = candidatesOf(bearishTrio({ open: 100, high: 100.5, low: 99, close: 99.5 }));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BEARISH');
});

test('T3 same outer direction never forms a three-bar candidate', function () {
    var bars = [
        bar(0, 100, 101, 95, 96),
        bar(1, 96, 97, 95.5, 96.5),
        bar(2, 96.5, 101.5, 96, 101)   // bull -> bull, not opposite
    ];
    var bars2 = [bars[0], bars[1], bar(2, 101, 102, 96, 97)];
    assert.strictEqual(candidatesOf(bars2).length, 0);
});

test('T4 a dominant middle bar is rejected by the loose prefilter', function () {
    var bars = bullishTrio({ open: 96, high: 101, low: 95, close: 100.5 });
    assert.strictEqual(candidatesOf(bars).length, 0);
});

test('T5 all three K2 pause forms (small bull, small bear, doji) stay eligible', function () {
    [{ open: 96, high: 97, low: 95.5, close: 96.5 },
        { open: 96.5, high: 97, low: 95.8, close: 96.2 },
        { open: 96, high: 97, low: 95.5, close: 96 }].forEach(function (k2) {
        var hits = candidatesOf(bullishTrio(k2));
        assert.strictEqual(hits.length, 1, 'K2 variant must stay eligible');
        assert.ok(hits[0].derived.middleBodyRatio <= 0.60 || hits[0].derived.middleRelativeRange <= 0.80);
    });
    var bodies = [
        L.pinBodyColor({ open: 96, close: 96.5 }),
        L.pinBodyColor({ open: 96.5, close: 96.2 }),
        L.pinBodyColor({ open: 96, close: 96 })
    ];
    assert.deepStrictEqual(bodies, ['BULL', 'BEAR', 'DOJI']);
});

// ============================================ canonical extreme (§14)

test('T6 bullish canonical extreme picks the lowest low and reports its bar', function () {
    var bars = [bar(0, 100, 101, 95, 96), bar(1, 96, 97, 90, 96.5), bar(2, 96.5, 101.5, 96, 101)];
    var e = L.canonicalExtremeOf(bars, 'BULLISH');
    assert.strictEqual(e.canonicalExtreme, 90);
    assert.strictEqual(e.extremeBar, 'K2');
    assert.strictEqual(e.extremeBarOpenTime, bars[1].openTime);
});

test('T7 bearish canonical extreme picks the highest high and reports its bar', function () {
    var bars = [bar(0, 96, 101, 95, 100), bar(1, 100, 100.5, 99, 99.5), bar(2, 100, 105, 95, 96)];
    var e = L.canonicalExtremeOf(bars, 'BEARISH');
    assert.strictEqual(e.canonicalExtreme, 105);
    assert.strictEqual(e.extremeBar, 'K3');
});

test('T8 the extreme can sit on any of the three bars', function () {
    assert.strictEqual(L.canonicalExtremeOf(
        [bar(0, 100, 101, 90, 96), bar(1, 96, 97, 94, 96.5), bar(2, 96.5, 101, 95, 100)],
        'BULLISH').extremeBar, 'K1');
    assert.strictEqual(L.canonicalExtremeOf(
        [bar(0, 100, 101, 95, 96), bar(1, 96, 97, 94, 96.5), bar(2, 96.5, 101, 90, 100)],
        'BULLISH').extremeBar, 'K3');
});

// ============================================ stage-1 output schema

test('T9 valid three-bar output passes; wrong enums and extra keys are rejected', function () {
    var ok = { pattern: 'THREE_BAR_REVERSAL', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH', reason: 'x' };
    assert.deepStrictEqual(L.validateThreeBarOutput(ok), ok);
    assert.throws(function () { L.validateThreeBarOutput(Object.assign({}, ok, { pattern: 'PIN_BAR' })); },
        /THREE_BAR_PATTERN_INVALID/);
    assert.throws(function () { L.validateThreeBarOutput(Object.assign({}, ok, { direction: 'SIDEWAYS' })); },
        /THREE_BAR_DIRECTION_INVALID/);
    assert.throws(function () { L.validateThreeBarOutput(Object.assign({}, ok, { label: 'MAYBE' })); },
        /THREE_BAR_LABEL_INVALID/);
    assert.throws(function () { L.validateThreeBarOutput(Object.assign({}, ok, { extra: 1 })); },
        /THREE_BAR_OUTPUT_SCHEMA_INVALID/);
});

test('T10 the three-bar prompt keeps K2 colour-neutral and bans other patterns', function () {
    ['does NOT have to be a doji', 'must NOT be the main directional bar',
        'PIN_BAR', 'TWO_BAR_REVERSAL', 'MTR', 'FVG', 'Liquidity', 'preceding trend context']
        .forEach(function (needle) {
            assert.ok(L.THREE_BAR_SYSTEM_PROMPT.indexOf(needle) >= 0, 'prompt missing ' + needle);
        });
});

// ============================================ stage-2 payload + causality

function longSeries(fn, n) { return fn(n); }

function descending(n) {
    var out = [];
    var price = 1000;
    for (var i = 0; i < n; i++) {
        var up = i % 3 === 2;
        var open = price;
        var close = up ? price + 1 : price - 3;
        out.push(bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close));
        price = close;
    }
    return out;
}

var K1_INDEX = 30;
function contextFixture() {
    var candles = descending(40);
    // overwrite K1,K2,K3 with a clean bullish three-bar and add K4/K5
    candles[K1_INDEX] = bar(K1_INDEX, 1000, 1002, 950, 956);
    candles[K1_INDEX + 1] = bar(K1_INDEX + 1, 956, 962, 951, 958);
    candles[K1_INDEX + 2] = bar(K1_INDEX + 2, 958, 1010, 957, 1005);
    return {
        candles: candles,
        k1Index: K1_INDEX,
        preceding: candles.slice(K1_INDEX - 10, K1_INDEX),
        upToK1: candles.slice(0, K1_INDEX + 1),
        k1: candles[K1_INDEX], k2: candles[K1_INDEX + 1], k3: candles[K1_INDEX + 2],
        k4: candles[K1_INDEX + 3], k5: candles[K1_INDEX + 4]
    };
}

test('T11 the three-bar context payload carries P-bars plus K1,K2,K3 only', function () {
    var f = contextFixture();
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    var payload = L.buildThreeBarContextPayload('BTCUSDT', '5m', 'BULLISH',
        f.preceding, f.k1, f.k2, f.k3, facts, f.k3.closeTime);
    L.assertNoFutureData(payload, f.k3.closeTime);
    assert.strictEqual(payload.targetPattern.type, 'THREE_BAR_REVERSAL');
    assert.strictEqual(payload.expectedContextDirection, 'BEARISH');
    assert.strictEqual(payload.precedingBars.length, 10);
    assert.strictEqual(payload.k3.closeTime, f.k3.closeTime);
    var text = JSON.stringify(payload);
    assert.strictEqual(text.indexOf(String(f.k4.closeTime)), -1, 'K4 must not appear');
    assert.strictEqual(text.indexOf(String(f.k5.closeTime)), -1, 'K5 must not appear');
});

test('T12 FUTURE_LEAK: a K4 injected into the three-bar context payload is rejected', function () {
    var f = contextFixture();
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    var payload = L.buildThreeBarContextPayload('BTCUSDT', '5m', 'BULLISH',
        f.preceding, f.k1, f.k2, f.k3, facts, f.k3.closeTime);
    payload.precedingBars.push({ openTime: f.k4.openTime, closeTime: f.k4.closeTime });
    assert.throws(function () { L.assertNoFutureData(payload, f.k3.closeTime); }, /FUTURE_LEAK_TIME/);
});

test('T13 FUTURE_LEAK: the window guard rejects a bar closing after K3', function () {
    var f = contextFixture();
    assert.throws(function () {
        L.assertWindowWithinConfirmation(f.candles.slice(0, f.k1Index + 4), f.k3.closeTime);
    }, /FUTURE_LEAK_WINDOW/);
    assert.doesNotThrow(function () {
        L.assertWindowWithinConfirmation(f.candles.slice(0, f.k1Index + 3), f.k3.closeTime);
    });
});

test('T14 three-bar context alignment mirrors the two-bar rule', function () {
    assert.strictEqual(L.isThreeBarContextAligned('BULLISH', { label: 'CLEAR', detectedDirection: 'BEARISH' }), true);
    assert.strictEqual(L.isThreeBarContextAligned('BEARISH', { label: 'CLEAR', detectedDirection: 'BULLISH' }), true);
    assert.strictEqual(L.isThreeBarContextAligned('BULLISH', { label: 'CLEAR', detectedDirection: 'BULLISH' }), false);
    assert.strictEqual(L.isThreeBarContextAligned('BULLISH', { label: 'NOT_TREND', detectedDirection: 'BEARISH' }), false);
});

// ============================================ review text + K2 stats

function ev(direction, label, confidence, legBars, k2Body, extremeBar) {
    var base = Date.parse('2026-09-17T03:00:00.000Z');
    var preceding = [];
    for (var i = 10; i >= 1; i--) preceding.push({ openTime: base - i * BAR });
    return {
        direction: direction,
        k1: { openTime: base },
        k2: { openTime: base + BAR },
        k3: { openTime: base + 2 * BAR },
        k2Body: k2Body,
        threeBarConfidence: 'HIGH',
        canonicalExtreme: direction === 'BULLISH' ? 950 : 1010,
        extremeBar: extremeBar,
        extremeBarOpenTime: base,
        context: {
            label: label, detectedDirection: L.expectedContextDirection(direction),
            confidence: confidence, estimatedLegBars: legBars, reason: 'sustained leg into K1'
        },
        estimatedLegStartOpenTime: L.estimatedLegStartOpenTime(preceding, legBars)
    };
}

test('T15 review text has the four specified groups in order', function () {
    var events = [
        ev('BULLISH', 'CLEAR', 'HIGH', 6, 'BEAR', 'K2'),
        ev('BEARISH', 'CLEAR', 'HIGH', 5, 'BULL', 'K1'),
        ev('BULLISH', 'BORDERLINE', 'LOW', 3, 'DOJI', 'K3'),
        ev('BULLISH', 'NOT_TREND', 'LOW', 0, 'BULL', 'K1')
    ];
    var text = L.buildThreeBarContextReviewText('BTCUSDT', '5m', events);
    var order = ['BULLISH THREE_BAR\nPRECEDING BEARISH LEG = CLEAR',
        'BEARISH THREE_BAR\nPRECEDING BULLISH LEG = CLEAR',
        'THREE_BAR\nPRECEDING LEG = BORDERLINE',
        'THREE_BAR\nPRECEDING CONTEXT = NOT_TREND'];
    var last = -1;
    order.forEach(function (s) {
        var at = text.indexOf(s);
        assert.ok(at > last, 'group out of order or missing: ' + s);
        last = at;
    });
    assert.ok(text.indexOf('K1 BEAR:') >= 0);
    assert.ok(text.indexOf('K2 PAUSE:') >= 0);
    assert.ok(text.indexOf('K3 BULL:') >= 0);
    assert.ok(text.indexOf('K1 BULL:') >= 0);
    assert.ok(text.indexOf('K3 BEAR:') >= 0);
    assert.ok(text.indexOf('2026-09-17 11:00') >= 0, 'K1 open time in UTC+8');
    assert.ok(text.indexOf('Extreme:') >= 0);
    assert.ok(text.indexOf('Scope: THREE_BAR_REVERSAL only') >= 0);
});

test('T16 the minimal list groups the two aligned directions with all three times', function () {
    var events = [
        ev('BULLISH', 'CLEAR', 'HIGH', 6, 'BEAR', 'K2'),
        ev('BEARISH', 'CLEAR', 'HIGH', 5, 'BULL', 'K1'),
        ev('BULLISH', 'CLEAR', 'HIGH', 5, 'BULL', 'K1')   // same direction context -> not aligned
    ];
    events[2].context.detectedDirection = 'BULLISH';
    var list = L.buildThreeBarCompactList(events);
    assert.ok(list.indexOf('=== BULLISH / BOTTOM THREE_BAR + CLEAR BEARISH LEG ===') >= 0);
    assert.ok(list.indexOf('=== BEARISH / TOP THREE_BAR + CLEAR BULLISH LEG ===') >= 0);
    var rows = list.split('\n').filter(function (l) { return /^\d{4}-\d{2}-\d{2} /.test(l); });
    assert.strictEqual(rows.length, 2);
    assert.match(rows[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \/ \d{2}:\d{2} \/ \d{2}:\d{2}$/);
});

test('T17 K2 body and extreme-bar statistics only count aligned setups', function () {
    var events = [
        ev('BULLISH', 'CLEAR', 'HIGH', 6, 'BEAR', 'K2'),
        ev('BULLISH', 'CLEAR', 'HIGH', 6, 'DOJI', 'K2'),
        ev('BEARISH', 'CLEAR', 'HIGH', 5, 'BULL', 'K1'),
        ev('BULLISH', 'NOT_TREND', 'LOW', 0, 'BULL', 'K1')  // excluded
    ];
    var stats = L.threeBarK2Stats(events);
    assert.strictEqual(stats.alignedTotal, 3);
    assert.strictEqual(stats.bullish.count, 2);
    assert.deepStrictEqual(stats.bullish.k2Body, { BULL: 0, BEAR: 1, DOJI: 1 });
    assert.deepStrictEqual(stats.bullish.extremeBar, { K1: 0, K2: 2, K3: 0 });
    assert.strictEqual(stats.bearish.count, 1);
    assert.deepStrictEqual(stats.bearish.extremeBar, { K1: 1, K2: 0, K3: 0 });
});

// ============================================ runner

process.env.REVERSAL_AUDIT_DRY_RUN = '1';
var RUNNER = path.join(__dirname, '..', 'scripts', 'local', 'threeBarReversalContextAuditV1.local.js');

test('T18 the runner reuses the previous two-bar candle snapshot when it is valid', function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var snapshot = runner.loadReusableSnapshot();
    if (!snapshot) return;                     // no previous round on this machine
    assert.strictEqual(snapshot.candles.length, L.REQUIRED_CANDLES);
    assert.strictEqual(snapshot.continuity.PASS, true);
    assert.ok(snapshot.candles.every(function (c) { return c.closed === true; }));
});

test('T19 the runner keeps only CLEAR three-bars for stage 2', function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var stage1 = [
        { status: 'OK', direction: 'BULLISH', llm: { label: 'CLEAR' } },
        { status: 'OK', direction: 'BEARISH', llm: { label: 'BORDERLINE' } },
        { status: 'OK', direction: 'BULLISH', llm: { label: 'NOT_PATTERN' } },
        { status: 'LLM_ERROR', llm: null }
    ];
    var kept = runner.threeBarClearRecords(stage1);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].direction, 'BULLISH');
});

test('T20 a three-bar too close to the window start gets INSUFFICIENT_CONTEXT without an LLM call', async function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var f = contextFixture();
    var record = {
        candidateId: 'z', direction: 'BULLISH', startIndex: 2,
        k1: f.candles[2], k2: f.candles[3], k3: f.candles[4],
        confirmedAt: f.candles[4].closeTime, llm: { confidence: 'HIGH' }
    };
    var out = await runner.judgeThreeBarContext(record, f.candles, 'unused-key');
    assert.strictEqual(out.status, 'INSUFFICIENT_CONTEXT');
    assert.strictEqual(out.context.source, 'PROGRAM_NO_LLM_CALL');
    assert.strictEqual(out.availablePrecedingBars, 2);
});

test('T21 the runner records the canonical extreme for the judged three-bar', async function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var f = contextFixture();
    var record = {
        candidateId: 'y', direction: 'BULLISH', startIndex: f.k1Index,
        k1: f.k1, k2: f.k2, k3: f.k3, confirmedAt: f.k3.closeTime, llm: { confidence: 'HIGH' }
    };
    var out = await runner.judgeThreeBarContext(record, f.candles, 'unused-key');
    assert.strictEqual(out.status, 'DRY_RUN');
    assert.strictEqual(out.availablePrecedingBars, 10);
    assert.strictEqual(out.canonicalExtreme, Math.min(f.k1.low, f.k2.low, f.k3.low));
    assert.ok(['K1', 'K2', 'K3'].indexOf(out.extremeBar) >= 0);
    assert.ok(Math.max.apply(null, out.precedingOpenTimes) < f.k1.openTime);
});

console.log('FUTURE_LEAK_TEST=' + (failed === 0 ? 'PASS' : 'FAIL'));
console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('THREE_BAR_REVERSAL_CONTEXT_AUDIT_V1_TESTS=' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + ' checks, ' + failed + ' failed)');
if (failed > 0) process.exitCode = 1;
