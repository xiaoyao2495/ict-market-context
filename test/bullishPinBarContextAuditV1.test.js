'use strict';

// BULLISH_PIN_BAR_CONTEXT_AUDIT_V1 - research test suite (network-free).
// Covers the bullish-only prefilter, the pin schema, body colour, the
// context-alignment rule, the review text and the lookahead ban.

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

var PIN_INDEX = 30;
function pinFixture() {
    var candles = descendingSeries(40);
    candles[PIN_INDEX] = bar(PIN_INDEX, 1000, 1002, 960, 998);
    return candles;
}

// ============================================ stage-1 prefilter

test('P1 the bullish screen keeps a long lower tail and drops a long upper tail', function () {
    var bullish = L.candleFacts(bar(0, 1000, 1002, 960, 998));
    var bearish = L.candleFacts(bar(0, 1000, 1040, 998, 1002));
    assert.ok(bullish.lowerTailRatio >= 0.35 && bullish.closeLocation >= 0.45);
    assert.ok(bearish.upperTailRatio >= 0.35 && bearish.closeLocation <= 0.55);
    var all = L.pinCandidates([bullish, bearish]);
    assert.strictEqual(all.length, 2, 'the shared prefilter still emits both sides');
});

test('P2 the runner keeps only the BULLISH side of the same prefilter', function () {
    var RUNNER = path.join(__dirname, '..', 'scripts', 'local', 'bullishPinBarContextAuditV1.local.js');
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var facts = [
        L.candleFacts(bar(0, 1000, 1002, 960, 998)),
        L.candleFacts(bar(1, 1000, 1040, 998, 1002)),
        L.candleFacts(bar(2, 1000, 1001, 999, 1000.5))
    ];
    var kept = runner.bullishPinCandidates(facts);
    // bar 0 (long lower tail) and bar 2 (small but lower-tail dominant) qualify bullishly;
    // bar 1 is the bearish-side screen and must not appear here.
    assert.strictEqual(kept.length, 2);
    assert.ok(kept.every(function (c) { return c.direction === 'BULLISH'; }));
    assert.deepStrictEqual(kept.map(function (c) { return c.startIndex; }), [0, 2]);
});

test('P3 a red-body bar with a long lower tail is still a bullish pin candidate', function () {
    var red = L.candleFacts(bar(0, 1002, 1003, 960, 998));
    assert.strictEqual(red.direction, 'BEARISH');
    var hits = L.pinCandidates([red]).filter(function (c) { return c.direction === 'BULLISH'; });
    assert.strictEqual(hits.length, 1);
});

// ============================================ pin payload + schema

test('P4 the pin payload carries the single candle and its facts only', function () {
    var candles = pinFixture();
    var facts = L.candleFacts(candles[PIN_INDEX]);
    var payload = L.buildPinPayload('BTCUSDT', '5m', candles[PIN_INDEX], facts,
        candles[PIN_INDEX].closeTime);
    L.assertWindowWithinConfirmation([candles[PIN_INDEX]], candles[PIN_INDEX].closeTime);
    L.assertNoFutureData(payload, candles[PIN_INDEX].closeTime);
    assert.strictEqual(payload.windowBarCount, 1);
    assert.strictEqual(payload.allowedPattern, 'PIN_BAR');
    assert.strictEqual(payload.evaluationTime, candles[PIN_INDEX].closeTime);
    var text = JSON.stringify(payload);
    assert.strictEqual(text.indexOf(String(candles[PIN_INDEX + 1].closeTime)), -1, 'next bar must not appear');
    assert.ok(text.indexOf('lowerTailRatio') >= 0);
});

test('P5 valid pin output passes; wrong pattern, direction or extra keys are rejected', function () {
    var ok = { pattern: 'PIN_BAR', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH', reason: 'x' };
    assert.deepStrictEqual(L.validatePinOutput(ok), ok);
    assert.strictEqual(L.validatePinOutput(Object.assign({}, ok, { label: 'NOT_PATTERN' })).label, 'NOT_PATTERN');
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { pattern: 'TWO_BAR_REVERSAL' })); },
        /PIN_PATTERN_INVALID/);
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { direction: 'BEARISH' })); },
        /PIN_DIRECTION_INVALID/);
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { label: 'MAYBE' })); },
        /PIN_LABEL_INVALID/);
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { confidence: 'CERTAIN' })); },
        /PIN_CONFIDENCE_INVALID/);
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { reason: ' ' })); },
        /PIN_REASON_INVALID/);
    assert.throws(function () { L.validatePinOutput(Object.assign({}, ok, { matches: [] })); },
        /PIN_OUTPUT_SCHEMA_INVALID/);
});

test('P6 the pin prompt demands a single candle and forbids a green-body requirement', function () {
    assert.ok(L.BULLISH_PIN_SYSTEM_PROMPT.indexOf('does NOT require close > open') >= 0);
    assert.ok(L.BULLISH_PIN_SYSTEM_PROMPT.indexOf('red body is fine') >= 0);
    ['TWO_BAR_REVERSAL', 'THREE_BAR_REVERSAL', 'MTR', 'Engulfing', 'FVG', 'Liquidity']
        .forEach(function (needle) {
            assert.ok(L.BULLISH_PIN_SYSTEM_PROMPT.indexOf(needle) >= 0, 'prompt missing ' + needle);
        });
});

test('P7 pin body colour is derived from open vs close only', function () {
    assert.strictEqual(L.pinBodyColor({ open: 100, close: 101 }), 'BULL');
    assert.strictEqual(L.pinBodyColor({ open: 101, close: 100 }), 'BEAR');
    assert.strictEqual(L.pinBodyColor({ open: 100, close: 100 }), 'DOJI');
});

// ============================================ alignment + causality

test('P8 alignment requires a CLEAR pin and a CLEAR preceding BEARISH leg', function () {
    assert.strictEqual(L.isBullishPinContextAligned('CLEAR', { label: 'CLEAR', detectedDirection: 'BEARISH' }), true);
    assert.strictEqual(L.isBullishPinContextAligned('CLEAR', { label: 'CLEAR', detectedDirection: 'BULLISH' }), false);
    assert.strictEqual(L.isBullishPinContextAligned('CLEAR', { label: 'CLEAR', detectedDirection: 'SIDEWAYS' }), false);
    assert.strictEqual(L.isBullishPinContextAligned('CLEAR', { label: 'BORDERLINE', detectedDirection: 'BEARISH' }), false);
    assert.strictEqual(L.isBullishPinContextAligned('BORDERLINE', { label: 'CLEAR', detectedDirection: 'BEARISH' }), false);
});

test('P9 the pin context payload tags PIN_BAR and never includes the next bar', function () {
    var candles = pinFixture();
    var pin = candles[PIN_INDEX];
    var preceding = candles.slice(PIN_INDEX - 10, PIN_INDEX);
    var facts = L.buildPrecedingFacts(preceding, pin, candles.slice(0, PIN_INDEX + 1));
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        preceding, pin, pin, facts, pin.closeTime, 'PIN_BAR');
    L.assertNoFutureData(payload, pin.closeTime);
    assert.strictEqual(payload.targetPattern.type, 'PIN_BAR');
    assert.strictEqual(payload.expectedContextDirection, 'BEARISH');
    var text = JSON.stringify(payload);
    assert.strictEqual(text.indexOf(String(candles[PIN_INDEX + 1].closeTime)), -1);
    assert.strictEqual(text.indexOf(String(candles[PIN_INDEX + 2].closeTime)), -1);
});

test('P10 FUTURE_LEAK: a post-pin bar injected into the pin context payload is rejected', function () {
    var candles = pinFixture();
    var pin = candles[PIN_INDEX];
    var preceding = candles.slice(PIN_INDEX - 10, PIN_INDEX);
    var facts = L.buildPrecedingFacts(preceding, pin, candles.slice(0, PIN_INDEX + 1));
    var payload = L.buildContextPayload('BTCUSDT', '5m', 'BULLISH', 'CLEAR',
        preceding, pin, pin, facts, pin.closeTime, 'PIN_BAR');
    payload.precedingBars.push({ openTime: candles[PIN_INDEX + 1].openTime, closeTime: candles[PIN_INDEX + 1].closeTime });
    assert.throws(function () { L.assertNoFutureData(payload, pin.closeTime); }, /FUTURE_LEAK_TIME/);
});

test('P11 the pin context prompt forbids re-judging the pattern and other concepts', function () {
    ['ALREADY been confirmed', 'Do not re-judge', 'BEARISH directional leg',
        'TWO_BAR_REVERSAL', 'MTR', 'FVG', 'Liquidity', 'no information after evaluationTime']
        .forEach(function (needle) {
            assert.ok(L.BULLISH_PIN_CONTEXT_SYSTEM_PROMPT.indexOf(needle) >= 0, 'prompt missing ' + needle);
        });
});

// ============================================ review text

function pinEvent(body, label, confidence, legBars) {
    var pinOpen = Date.parse('2026-09-17T03:25:00.000Z');
    var preceding = [];
    for (var i = 10; i >= 1; i--) preceding.push({ openTime: pinOpen - i * BAR });
    return {
        pin: { openTime: pinOpen, open: 1000, high: 1005, low: 960, close: 998 },
        pinBody: body,
        pinLabel: 'CLEAR',
        pinLabelConfidence: 'HIGH',
        context: {
            label: label, detectedDirection: 'BEARISH', confidence: confidence,
            estimatedLegBars: legBars, reason: 'sustained lower-price progression into the pin'
        },
        estimatedLegStartOpenTime: L.estimatedLegStartOpenTime(preceding, legBars)
    };
}

test('P12 review text has the three specified groups in order', function () {
    var events = [
        pinEvent('BULL', 'CLEAR', 'HIGH', 7),
        pinEvent('BEAR', 'BORDERLINE', 'LOW', 3),
        pinEvent('DOJI', 'NOT_TREND', 'LOW', 0)
    ];
    var text = L.buildBullishPinReviewText('BTCUSDT', '5m', events);
    var order = ['=== A. PIN CLEAR + PRECEDING BEARISH LEG CLEAR ===',
        '=== B. PIN CLEAR + PRECEDING BEARISH LEG BORDERLINE ===',
        '=== C. PIN CLEAR + NOT_TREND ==='];
    var last = -1;
    order.forEach(function (s) {
        var at = text.indexOf(s);
        assert.ok(at > last, 'group out of order or missing: ' + s);
        last = at;
    });
    assert.ok(text.indexOf('BULLISH PIN\nPRECEDING BEARISH LEG = CLEAR') >= 0);
    assert.ok(text.indexOf('PIN: 2026-09-17 11:25') >= 0, 'pin open time in UTC+8');
    assert.ok(text.indexOf('Estimated leg:') >= 0);
    assert.ok(text.indexOf('PIN OHLC:') >= 0);
    assert.ok(text.indexOf('O=1000') >= 0);
    assert.ok(text.indexOf('Context reason:') >= 0);
    assert.ok(text.indexOf('Scope: BULLISH PIN BAR only') >= 0);
});

test('P13 the minimal list and body tally cover only aligned setups', function () {
    var events = [
        pinEvent('BULL', 'CLEAR', 'HIGH', 7),
        pinEvent('BEAR', 'CLEAR', 'MEDIUM', 5),
        pinEvent('DOJI', 'BORDERLINE', 'LOW', 3)
    ];
    var list = L.buildBullishPinCompactList(events);
    assert.ok(list.indexOf('=== BULLISH PIN + CLEAR BEARISH LEG ===') >= 0);
    var lines = list.split('\n').filter(function (l) { return /^\d{4}-/.test(l); });
    assert.strictEqual(lines.length, 2);
    var tally = L.pinBodyTally(events);
    assert.deepStrictEqual(tally, { BULL: 1, BEAR: 1, DOJI: 0 });
});

// ============================================ runner integration

process.env.REVERSAL_AUDIT_DRY_RUN = '1';
var RUNNER_PATH = path.join(__dirname, '..', 'scripts', 'local', 'bullishPinBarContextAuditV1.local.js');

test('P14 a pin too close to the window start gets INSUFFICIENT_CONTEXT without an LLM call', async function () {
    if (!fs.existsSync(RUNNER_PATH)) return;
    var runner = require(RUNNER_PATH);
    var candles = pinFixture();
    var record = {
        candidateId: 'z', pinIndex: 2, pin: candles[2], confirmedAt: candles[2].closeTime,
        llm: { confidence: 'HIGH' }
    };
    var out = await runner.judgePinContext(record, candles, 'unused-key');
    assert.strictEqual(out.status, 'INSUFFICIENT_CONTEXT');
    assert.strictEqual(out.context.source, 'PROGRAM_NO_LLM_CALL');
    assert.strictEqual(out.availablePrecedingBars, 2);
});

test('P15 the runner keeps only CLEAR pins for stage 2', function () {
    if (!fs.existsSync(RUNNER_PATH)) return;
    var runner = require(RUNNER_PATH);
    var stage1 = [
        { status: 'OK', llm: { label: 'CLEAR' } },
        { status: 'OK', llm: { label: 'BORDERLINE' } },
        { status: 'OK', llm: { label: 'NOT_PATTERN' } },
        { status: 'LLM_ERROR', llm: null }
    ];
    var kept = runner.pinClearRecords(stage1);
    assert.strictEqual(kept.length, 1);
    assert.strictEqual(kept[0].llm.label, 'CLEAR');
});

test('P16 the runner body tally only counts aligned cases', function () {
    if (!fs.existsSync(RUNNER_PATH)) return;
    var runner = require(RUNNER_PATH);
    var review = [
        { pin: { openTime: 1 }, pinBody: 'BULL', pinLabel: 'CLEAR', pinLabelConfidence: 'HIGH',
            precedingOpenTimes: [], context: { label: 'CLEAR', detectedDirection: 'BEARISH', estimatedLegBars: 0 } },
        { pin: { openTime: 2 }, pinBody: 'BEAR', pinLabel: 'CLEAR', pinLabelConfidence: 'HIGH',
            precedingOpenTimes: [], context: { label: 'CLEAR', detectedDirection: 'BULLISH', estimatedLegBars: 0 } }
    ];
    var t = runner.toPinReviewEvents(review);
    assert.strictEqual(t.length, 2);
    assert.deepStrictEqual(L.pinBodyTally(t), { BULL: 1, BEAR: 0, DOJI: 0 });
});

console.log('FUTURE_LEAK_TEST=' + (failed === 0 ? 'PASS' : 'FAIL'));
console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('BULLISH_PIN_BAR_CONTEXT_AUDIT_V1_TESTS=' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + ' checks, ' + failed + ' failed)');
if (failed > 0) process.exitCode = 1;
