'use strict';

// TWO_BAR_REVERSAL_CONTEXT_AUDIT_V1 - research test suite (network-free).
// Covers the preceding-context facts, the context payload and schema, the
// context-alignment rule and the lookahead ban for the second-stage request.

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

function descendingSeries(n) {
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

function ascendingSeries(n) {
    var out = [];
    var price = 1000;
    for (var i = 0; i < n; i++) {
        var down = i % 3 === 2;
        var open = price;
        var close = down ? price - 1 : price + 3;
        out.push(bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close));
        price = close;
    }
    return out;
}

function sidewaysSeries(n) {
    var out = [];
    var price = 1000;
    for (var i = 0; i < n; i++) {
        var up = i % 2 === 0;
        var open = price;
        var close = up ? price + 4 : price - 4;
        out.push(bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close));
        price = close;
    }
    return out;
}

// Wilder ATR14 needs at least 14 bars, so every fixture is comfortably longer
// than the 10-bar preceding window it exercises.
var K1_INDEX = 30;
function fixture(seriesFn) {
    var candles = seriesFn(40);
    return {
        candles: candles,
        k1Index: K1_INDEX,
        preceding: candles.slice(K1_INDEX - 10, K1_INDEX),
        upToK1: candles.slice(0, K1_INDEX + 1),
        k1: candles[K1_INDEX],
        k2: candles[K1_INDEX + 1],
        k3: candles[K1_INDEX + 2],
        k4: candles[K1_INDEX + 3]
    };
}

// ============================================ preceding facts

test('X1 descending preceding context yields a negative net move and bear dominance', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    assert.strictEqual(facts.availableBars, 10);
    assert.ok(facts.netMove < 0, 'netMove should be negative');
    assert.ok(facts.netMoveAtr < 0, 'netMoveAtr should be negative');
    assert.ok(facts.bearBarCount > facts.bullBarCount);
    assert.ok(facts.last5NetMoveAtr < 0, 'recent tail must also be negative');
    assert.ok(facts.lowerLowCount > 0);
    assert.ok(facts.directionalEfficiency > 0.5);
});

test('X2 ascending preceding context is the exact mirror', function () {
    var f = fixture(ascendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    assert.ok(facts.netMove > 0);
    assert.ok(facts.netMoveAtr > 0);
    assert.ok(facts.bullBarCount > facts.bearBarCount);
    assert.ok(facts.higherHighCount > 0);
    assert.ok(facts.last5NetMoveAtr > 0);
});

test('X3 sideways preceding context shows no directional progression', function () {
    var f = fixture(sidewaysSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    assert.ok(Math.abs(facts.netMove) <= 6, 'net move must stay small: ' + facts.netMove);
    assert.ok(facts.directionalEfficiency < 0.2, 'efficiency must be low: ' + facts.directionalEfficiency);
    assert.ok(Math.abs(facts.last3NetMove) <= 2);
});

test('X4 preceding facts expose positions of the extremes', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    // In a decline the high sits at the start of the window and the low at the
    // end; the exact last bar may be the small bullish pause, so assert bands.
    assert.ok(facts.highestHighPosition <= 2, 'high should sit near the start: ' + facts.highestHighPosition);
    assert.ok(facts.lowestLowPosition >= 7, 'low should sit near the end: ' + facts.lowestLowPosition);
    assert.strictEqual(facts.highestHighBarsFromEnd, facts.availableBars - 1 - facts.highestHighPosition);
    assert.strictEqual(facts.lowestLowBarsFromEnd, facts.availableBars - 1 - facts.lowestLowPosition);
    assert.ok(facts.lowestLowBarsFromEnd < facts.highestHighBarsFromEnd);
});

test('X5 the including-K1 view distinguishes a leg that runs into K1', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    assert.strictEqual(facts.includingK1.availableBars, 11);
    assert.ok(facts.includingK1.netMove < facts.netMove, 'including K1 must extend the down move');
});

// ============================================ context direction

test('X6 expected context direction is the opposite of the two-bar direction', function () {
    assert.strictEqual(L.expectedContextDirection('BULLISH'), 'BEARISH');
    assert.strictEqual(L.expectedContextDirection('BEARISH'), 'BULLISH');
});

test('X7 context alignment requires CLEAR and the opposite detected direction', function () {
    assert.strictEqual(L.isContextAligned('BULLISH', { label: 'CLEAR', detectedDirection: 'BEARISH' }), true);
    assert.strictEqual(L.isContextAligned('BEARISH', { label: 'CLEAR', detectedDirection: 'BULLISH' }), true);
    assert.strictEqual(L.isContextAligned('BULLISH', { label: 'CLEAR', detectedDirection: 'BULLISH' }), false);
    assert.strictEqual(L.isContextAligned('BULLISH', { label: 'BORDERLINE', detectedDirection: 'BEARISH' }), false);
    assert.strictEqual(L.isContextAligned('BULLISH', { label: 'NOT_TREND', detectedDirection: 'SIDEWAYS' }), false);
});

test('X8 estimated leg start counts back from K1 inside the available window', function () {
    var preceding = [{ openTime: 100 }, { openTime: 200 }, { openTime: 300 },
        { openTime: 400 }, { openTime: 500 }];
    assert.strictEqual(L.estimatedLegStartOpenTime(preceding, 3), 300);
    assert.strictEqual(L.estimatedLegStartOpenTime(preceding, 5), 100);
    assert.strictEqual(L.estimatedLegStartOpenTime(preceding, 99), 100);
    assert.strictEqual(L.estimatedLegStartOpenTime(preceding, 0), null);
});

// ============================================ payload + causality

test('X9 the context payload carries only preceding bars plus K1 and K2', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        f.preceding, f.k1, f.k2, facts, f.k2.closeTime);
    L.assertNoFutureData(payload, f.k2.closeTime);
    var text = JSON.stringify(payload);
    assert.strictEqual(text.indexOf(String(f.k3.closeTime)), -1, 'K3 must not appear');
    assert.strictEqual(text.indexOf(String(f.k4.closeTime)), -1, 'K4 must not appear');
    assert.strictEqual(payload.precedingBars.length, 10);
    assert.strictEqual(payload.targetPattern.type, 'TWO_BAR_REVERSAL');
    assert.strictEqual(payload.expectedContextDirection, 'BEARISH');
    assert.strictEqual(payload.evaluationTime, f.k2.closeTime);
});

test('X10 FUTURE_LEAK: a K3 smuggled into the context payload is rejected', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        f.preceding, f.k1, f.k2, facts, f.k2.closeTime);
    payload.precedingBars.push({ openTime: f.k3.openTime, closeTime: f.k3.closeTime });
    assert.throws(function () { L.assertNoFutureData(payload, f.k2.closeTime); }, /FUTURE_LEAK_TIME/);
});

test('X11 FUTURE_LEAK: the context window guard rejects a bar closing after K2', function () {
    var f = fixture(descendingSeries);
    assert.throws(function () {
        L.assertWindowWithinConfirmation(f.candles.slice(0, f.k1Index + 3), f.k2.closeTime);
    }, /FUTURE_LEAK_WINDOW/);
    assert.doesNotThrow(function () {
        L.assertWindowWithinConfirmation(f.candles.slice(0, f.k1Index + 2), f.k2.closeTime);
    });
});

test('X12 the context payload carries no outcome-flavoured field', function () {
    var f = fixture(descendingSeries);
    var facts = L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1);
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        f.preceding, f.k1, f.k2, facts, f.k2.closeTime);
    var text = JSON.stringify(payload);
    assert.strictEqual(/(outcome|future price|trigger|profit|pnl|mfe|mae|winrate)/i.test(text), false);
});

/*
 * The three assertions below used to live in X9/X10/X11 before the fixtures were
 * lengthened for ATR14; they are kept here so the intent stays documented.
 */
test('X12b the legacy short-fixture checks are superseded by X9/X10/X11', function () {
    var f = fixture(descendingSeries);
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        f.preceding, f.k1, f.k2, L.buildPrecedingFacts(f.preceding, f.k1, f.upToK1), f.k2.closeTime);
    assert.strictEqual(payload.precedingBars.length, 10);
    assert.strictEqual(payload.k2.closeTime, f.k2.closeTime);
});

// ============================================ context output schema

test('X13 valid context output passes and records the expected-direction match', function () {
    var ok = {
        expectedDirection: 'BEARISH',
        detectedDirection: 'BEARISH',
        label: 'CLEAR',
        confidence: 'HIGH',
        estimatedLegBars: 6,
        reason: 'sustained lower-price progression into K1'
    };
    var out = L.validateContextOutput(ok, 'BEARISH');
    assert.strictEqual(out.expectedDirectionMatched, true);
    assert.strictEqual(out.label, 'CLEAR');
});

test('X14 invalid context enums and shapes are rejected', function () {
    function base(over) {
        return Object.assign({
            expectedDirection: 'BEARISH', detectedDirection: 'BEARISH', label: 'CLEAR',
            confidence: 'HIGH', estimatedLegBars: 5, reason: 'r'
        }, over || {});
    }
    assert.throws(function () { L.validateContextOutput(base({ detectedDirection: 'UP' }), 'BEARISH'); },
        /CONTEXT_DETECTED_DIRECTION_INVALID/);
    assert.throws(function () { L.validateContextOutput(base({ label: 'MAYBE' }), 'BEARISH'); },
        /CONTEXT_LABEL_INVALID/);
    assert.throws(function () { L.validateContextOutput(base({ confidence: 'CERTAIN' }), 'BEARISH'); },
        /CONTEXT_CONFIDENCE_INVALID/);
    assert.throws(function () { L.validateContextOutput(base({ estimatedLegBars: 2.5 }), 'BEARISH'); },
        /CONTEXT_ESTIMATED_LEG_BARS_INVALID/);
    assert.throws(function () { L.validateContextOutput(base({ reason: '  ' }), 'BEARISH'); },
        /CONTEXT_REASON_INVALID/);
    assert.throws(function () { L.validateContextOutput(base({ extra: 1 }), 'BEARISH'); },
        /CONTEXT_OUTPUT_SCHEMA_INVALID/);
});

test('X15 the context prompt forbids re-judging the pattern and foreign concepts', function () {
    ['ALREADY been confirmed', 'Do not re-judge', 'MTR', 'Wedge', 'Engulfing',
        'FVG', 'MSS', 'Displacement', 'Liquidity', 'no information after evaluationTime']
        .forEach(function (needle) {
            assert.ok(L.CONTEXT_SYSTEM_PROMPT.indexOf(needle) >= 0, 'prompt missing ' + needle);
        });
    assert.ok(L.CONTEXT_SYSTEM_PROMPT.indexOf('Do NOT ask "are the previous bars a trend"') >= 0);
});

// ============================================ review text

function event(dir, label, detected, confidence, legBars) {
    var k1Open = Date.parse('2026-09-17T03:20:00.000Z');
    var k2Open = Date.parse('2026-09-17T03:25:00.000Z');
    var preceding = [];
    for (var i = 10; i >= 1; i--) preceding.push({ openTime: k1Open - i * BAR });
    return {
        twoBarDirection: dir,
        k1: { openTime: k1Open },
        k2: { openTime: k2Open },
        context: {
            label: label, detectedDirection: detected, confidence: confidence,
            estimatedLegBars: legBars, reason: 'reason text'
        },
        estimatedLegStartOpenTime: L.estimatedLegStartOpenTime(preceding, legBars)
    };
}

test('X16 review text has the three specified groups and mirrors the headings', function () {
    var events = [
        event('BULLISH', 'CLEAR', 'BEARISH', 'HIGH', 6),
        event('BEARISH', 'CLEAR', 'BULLISH', 'HIGH', 4),
        event('BULLISH', 'BORDERLINE', 'BEARISH', 'LOW', 3),
        event('BULLISH', 'NOT_TREND', 'SIDEWAYS', 'LOW', 0)
    ];
    var text = L.buildTwoBarContextReviewText('BTCUSDT', '5m', events);
    ['=== A. TWO_BAR + PRECEDING TREND CLEAR ===',
        '=== B. TWO_BAR + PRECEDING TREND BORDERLINE ===',
        '=== C. TWO_BAR + NOT_TREND ==='].forEach(function (s) {
        assert.ok(text.indexOf(s) >= 0, 'missing group ' + s);
    });
    assert.ok(text.indexOf('BULLISH TWO_BAR\nPRECEDING BEARISH LEG = CLEAR') >= 0);
    assert.ok(text.indexOf('BEARISH TWO_BAR\nPRECEDING BULLISH LEG = CLEAR') >= 0);
    assert.ok(text.indexOf('K1 BEAR:') >= 0);
    assert.ok(text.indexOf('K2 BULL:') >= 0);
    assert.ok(text.indexOf('Leg approx:') >= 0);
    assert.ok(text.indexOf('Context reason:') >= 0);
    assert.ok(text.indexOf('2026-09-17 11:20') >= 0, 'K1 open time in UTC+8');
    assert.ok(text.indexOf('Scope: TWO_BAR_REVERSAL only') >= 0);
});

test('X17 the minimal list contains only aligned CLEAR setups', function () {
    var events = [
        event('BULLISH', 'CLEAR', 'BEARISH', 'HIGH', 6),
        event('BULLISH', 'CLEAR', 'BULLISH', 'HIGH', 6),
        event('BEARISH', 'CLEAR', 'BULLISH', 'MEDIUM', 5),
        event('BEARISH', 'BORDERLINE', 'BULLISH', 'LOW', 5)
    ];
    var list = L.buildContextCompactList(events);
    assert.ok(list.indexOf('=== BULLISH TWO_BAR + CLEAR BEARISH LEG ===') >= 0);
    assert.ok(list.indexOf('=== BEARISH TWO_BAR + CLEAR BULLISH LEG ===') >= 0);
    var lines = list.split('\n').filter(function (l) { return /\//.test(l); });
    assert.strictEqual(lines.length, 2, 'exactly the two aligned setups');
});

// ============================================ runner integration

process.env.REVERSAL_AUDIT_DRY_RUN = '1';
var RUNNER = path.join(__dirname, '..', 'scripts', 'local', 'twoBarReversalContextAuditV1.local.js');

test('X18 fewer than four preceding bars yields INSUFFICIENT_CONTEXT without any LLM call', async function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var candles = descendingSeries(5);
    var record = {
        candidateId: 'x', direction: 'BULLISH', startIndex: 3, endIndex: 4,
        k1: candles[3], k2: candles[4], confirmedAt: candles[4].closeTime
    };
    var out = await runner.judgeContext(record, candles, 'unused-key');
    assert.strictEqual(out.status, 'INSUFFICIENT_CONTEXT');
    assert.strictEqual(out.context.label, 'INSUFFICIENT_CONTEXT');
    assert.strictEqual(out.context.source, 'PROGRAM_NO_LLM_CALL');
    assert.strictEqual(out.availablePrecedingBars, 3);
});

test('X19 the runner context payload never reaches past K2 (dry run exercises the guards)', async function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var candles = descendingSeries(16);
    var record = {
        candidateId: 'y', direction: 'BULLISH', startIndex: 11, endIndex: 12,
        k1: candles[11], k2: candles[12], confirmedAt: candles[12].closeTime
    };
    var out = await runner.judgeContext(record, candles, 'unused-key');
    assert.strictEqual(out.status, 'DRY_RUN');
    assert.strictEqual(out.availablePrecedingBars, 10);
    assert.strictEqual(out.precedingOpenTimes.length, 10);
    assert.ok(Math.max.apply(null, out.precedingOpenTimes) < candles[13].openTime, 'K3 must be excluded');
});

test('X20 only two-bar CLEAR results advance to the context stage', function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var stage1 = [
        { status: 'OK', direction: 'BULLISH', llm: { matches: [{ pattern: 'TWO_BAR_REVERSAL', label: 'CLEAR' }] } },
        { status: 'OK', direction: 'BEARISH', llm: { matches: [{ pattern: 'TWO_BAR_REVERSAL', label: 'BORDERLINE' }] } },
        { status: 'OK', direction: 'BULLISH', llm: { matches: [] } },
        { status: 'LLM_ERROR', llm: null }
    ];
    var kept = runner.twoBarClearRecords(stage1);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].direction, 'BULLISH');
});

console.log('FUTURE_LEAK_TEST=' + (failed === 0 ? 'PASS' : 'FAIL'));
console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('TWO_BAR_REVERSAL_CONTEXT_AUDIT_V1_TESTS=' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + ' checks, ' + failed + ' failed)');
if (failed > 0) process.exitCode = 1;
