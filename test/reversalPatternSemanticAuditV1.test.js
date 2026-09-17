'use strict';

/**
 * REVERSAL_PATTERN_SEMANTIC_AUDIT_V1 - research test suite.
 *
 * Network-free. Covers candle facts, the loose 1/2/3-bar prefilters and - most
 * importantly - the lookahead ban: nothing derived from a bar after a
 * candidate's confirmedAt may reach the LLM payload.
 */
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
function mkBar(i, o, h, l, c) {
    return {
        openTime: i * BAR,
        closeTime: (i + 1) * BAR - 1,
        open: o, high: h, low: l, close: c,
        closed: true,
        source: 'futures'
    };
}

// ==================================================== candle facts (§5)

test('C1 range, body and tail decomposition', function () {
    var f = L.candleFacts(mkBar(0, 100, 110, 90, 105));
    assert.strictEqual(f.range, 20);
    assert.strictEqual(f.body, 5);
    assert.strictEqual(f.upperTail, 5);
    assert.strictEqual(f.lowerTail, 10);
});

test('C2 ratios normalise by range', function () {
    var f = L.candleFacts(mkBar(0, 100, 110, 90, 105));
    assert.strictEqual(f.bodyRatio, 0.25);
    assert.strictEqual(f.upperTailRatio, 0.25);
    assert.strictEqual(f.lowerTailRatio, 0.5);
    assert.strictEqual(f.closeLocation, 0.75);
});

test('C3 a long lower tail qualifies as a bullish pin candidate even with a bearish body', function () {
    // open 102 -> close 100.5 is a BEARISH body, yet the long lower rejection and the
    // high close location still make it a bullish PIN_BAR candidate. The prefilter
    // deliberately does NOT require a bullish body.
    var f = L.candleFacts(mkBar(0, 102, 102.5, 80, 100.5));
    assert.strictEqual(f.direction, 'BEARISH');
    assert.ok(f.lowerTailRatio >= 0.35);
    assert.ok(f.closeLocation >= 0.45);
    var hits = L.pinCandidates([f]);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BULLISH');
});

test('C4 direction semantics including doji', function () {
    assert.strictEqual(L.candleFacts(mkBar(0, 100, 105, 95, 104)).direction, 'BULLISH');
    assert.strictEqual(L.candleFacts(mkBar(0, 104, 105, 95, 100)).direction, 'BEARISH');
    assert.strictEqual(L.candleFacts(mkBar(0, 100, 105, 95, 100)).direction, 'DOJI');
});

test('C5 zero-range candle yields null ratios, never 0-filled', function () {
    var f = L.candleFacts(mkBar(0, 100, 100, 100, 100));
    assert.strictEqual(f.range, 0);
    assert.strictEqual(f.bodyRatio, null);
    assert.strictEqual(f.upperTailRatio, null);
    assert.strictEqual(f.lowerTailRatio, null);
    assert.strictEqual(f.closeLocation, null);
});

// ==================================================== continuity (§3)

test('C6 continuity passes on a clean 288-bar window', function () {
    var candles = [];
    for (var i = 0; i < L.REQUIRED_CANDLES; i++) candles.push(mkBar(i, 100, 101, 99, 100));
    var report = L.continuityReport(candles, L.REQUIRED_CANDLES * BAR + 1000);
    assert.strictEqual(report.candleCount, 288);
    assert.strictEqual(report.PASS, true);
});

test('C7 continuity fails on a gap', function () {
    var candles = [];
    for (var i = 0; i < L.REQUIRED_CANDLES; i++) candles.push(mkBar(i, 100, 101, 99, 100));
    candles[100].openTime += BAR;
    var report = L.continuityReport(candles, L.REQUIRED_CANDLES * BAR + 1000);
    assert.strictEqual(report.PASS, false);
    assert.ok(report.problems.some(function (p) { return p.kind === 'GAP_OR_DUPLICATE'; }));
});

test('C8 continuity fails when the last candle is not closed before server time', function () {
    var candles = [];
    for (var i = 0; i < L.REQUIRED_CANDLES; i++) candles.push(mkBar(i, 100, 101, 99, 100));
    var report = L.continuityReport(candles, L.REQUIRED_CANDLES * BAR - 1);
    assert.strictEqual(report.PASS, false);
});

// ==================================================== one-bar prefilter (§6)

test('C9 bullish pin prefilter accepts lower rejection with high close', function () {
    var facts = [L.candleFacts(mkBar(0, 100, 102, 80, 101))];
    var hits = L.pinCandidates(facts);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].pattern, 'PIN_BAR');
    assert.strictEqual(hits[0].direction, 'BULLISH');
});

test('C10 bearish pin prefilter accepts upper rejection with low close', function () {
    var facts = [L.candleFacts(mkBar(0, 100, 120, 98, 99))];
    var hits = L.pinCandidates(facts);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BEARISH');
});

test('C11 the pin prefilter is loose and non-classifying', function () {
    // A long-legged doji satisfies both directional ratio tests, so BOTH views are
    // emitted and the LLM decides. This proves the prefilter does not classify.
    var doji = L.pinCandidates([L.candleFacts(mkBar(0, 100, 105, 95, 100))]);
    assert.strictEqual(doji.length, 2);
    assert.deepStrictEqual(doji.map(function (c) { return c.direction; }).sort(), ['BEARISH', 'BULLISH']);
    // A bar with negligible tails carries no rejection at all and is filtered out.
    var flatBar = L.candleFacts(mkBar(0, 100, 100.7, 99.9, 100.6));
    assert.ok(flatBar.upperTailRatio < 0.35 && flatBar.lowerTailRatio < 0.35);
    var flat = L.pinCandidates([flatBar]);
    assert.strictEqual(flat.length, 0);
});

// ==================================================== two-bar prefilter (§7)

test('C12 bear then bull is a bullish two-bar candidate', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 100, 106)];
    var facts = bars.map(L.candleFacts);
    var hits = L.twoBarCandidates(facts);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BULLISH');
    assert.strictEqual(hits[0].startIndex, 0);
    assert.strictEqual(hits[0].endIndex, 1);
});

test('C13 bull then bear is a bearish two-bar candidate', function () {
    var bars = [mkBar(0, 100, 106, 99, 105), mkBar(1, 105, 106, 99, 100)];
    var facts = bars.map(L.candleFacts);
    var hits = L.twoBarCandidates(facts);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BEARISH');
});

test('C14 same-direction pairs never become two-bar candidates', function () {
    var bars = [mkBar(0, 100, 106, 99, 105), mkBar(1, 105, 111, 104, 110)];
    assert.strictEqual(L.twoBarCandidates(bars.map(L.candleFacts)).length, 0);
});

test('C15 a weak opposite bar is filtered out by the body ratio floor', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 106, 100.5, 101.05)];
    var hits = L.twoBarCandidates(bars.map(L.candleFacts));
    assert.strictEqual(hits.length, 0);
});

test('C16 two-bar derived facts expose recovery, similarities and extreme relation', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 99, 106)];
    var hit = L.twoBarCandidates(bars.map(L.candleFacts))[0];
    assert.ok(hit.derived.rangeSimilarity > 0);
    assert.ok(hit.derived.bodySimilarity > 0);
    assert.ok(typeof hit.derived.recovery === 'number');
    assert.strictEqual(hit.derived.canonicalExtreme, Math.min(100, 99));
    assert.ok(['LOWER_LOW', 'SIMILAR_LOW', 'HIGHER_LOW'].indexOf(hit.derived.extremeRelation) >= 0);
    assert.strictEqual(hit.derived.combinedHigh, 107);
});

// ================================================== three-bar prefilter (§8)

test('C17 bear, small pause, bull is a bullish three-bar candidate', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 102, 100.5, 101.2), mkBar(2, 101.2, 107, 101, 106)];
    var hits = L.threeBarCandidates(bars.map(L.candleFacts));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BULLISH');
    assert.strictEqual(hits[0].endIndex, 2);
});

test('C18 bull, small pause, bear is a bearish three-bar candidate', function () {
    var bars = [mkBar(0, 100, 106, 99, 105), mkBar(1, 105, 105.6, 104.4, 104.8), mkBar(2, 104.8, 105, 98, 99)];
    var hits = L.threeBarCandidates(bars.map(L.candleFacts));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].direction, 'BEARISH');
});

test('C19 three-bar canonical extreme uses all three lows for a bullish reversal', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 102, 97, 101.2), mkBar(2, 101.2, 107, 101, 106)];
    var hit = L.threeBarCandidates(bars.map(L.candleFacts))[0];
    assert.strictEqual(hit.derived.canonicalExtreme, 97);
});

test('C20 an oversized middle bar is rejected by the loose three-bar filter', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 112, 100, 111), mkBar(2, 111, 112, 104, 105)];
    var hits = L.threeBarCandidates(bars.map(L.candleFacts));
    assert.strictEqual(hits.length, 0);
});

// ==================================================== dedupe (§14)

test('C21 identical events collapse while overlapping windows stay', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 99, 106)];
    var raw = L.twoBarCandidates(bars.map(L.candleFacts));
    var dup = raw.concat(raw);
    assert.strictEqual(L.dedupe(dup, bars).length, raw.length);
});

// ==================================================== causality (§4/§13)

test('C22 FUTURE_LEAK: a two-bar candidate payload contains no later candle', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 99, 106),
        mkBar(2, 106, 108, 105, 107), mkBar(3, 107, 109, 106, 108), mkBar(4, 108, 110, 107, 109)];
    var facts = bars.map(L.candleFacts);
    var hit = L.twoBarCandidates(facts)[0];
    var confirmedAt = bars[hit.endIndex].closeTime;
    var payload = L.buildUserPayload('BTCUSDT', '5m',
        bars.slice(hit.startIndex, hit.endIndex + 1),
        facts.slice(hit.startIndex, hit.endIndex + 1),
        confirmedAt);
    L.assertWindowWithinConfirmation(bars.slice(hit.startIndex, hit.endIndex + 1), confirmedAt);
    L.assertNoFutureData(payload, confirmedAt);
    assert.strictEqual(payload.windowBarCount, 2);
    var times = payload.bars.map(function (b) { return b.closeTime; });
    assert.ok(times.every(function (t) { return t <= confirmedAt; }));
    [2, 3, 4].forEach(function (i) {
        assert.ok(times.indexOf(bars[i].closeTime) < 0, 'bar ' + i + ' must not be present');
    });
});

test('C23 FUTURE_LEAK: a three-bar candidate payload contains no later candle', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 102, 100.5, 101.2),
        mkBar(2, 101.2, 107, 101, 106), mkBar(3, 106, 109, 105, 108), mkBar(4, 108, 110, 107, 109)];
    var facts = bars.map(L.candleFacts);
    var hit = L.threeBarCandidates(facts)[0];
    var confirmedAt = bars[hit.endIndex].closeTime;
    var payload = L.buildUserPayload('BTCUSDT', '5m',
        bars.slice(hit.startIndex, hit.endIndex + 1),
        facts.slice(hit.startIndex, hit.endIndex + 1),
        confirmedAt);
    L.assertNoFutureData(payload, confirmedAt);
    assert.strictEqual(payload.windowBarCount, 3);
    assert.strictEqual(payload.evaluationTime, bars[2].closeTime);
    assert.strictEqual(payload.bars[payload.bars.length - 1].closeTime, bars[2].closeTime);
    assert.strictEqual(payload.bars.some(function (b) { return b.closeTime === bars[3].closeTime; }), false);
    assert.strictEqual(payload.bars.some(function (b) { return b.closeTime === bars[4].closeTime; }), false);
});

test('C24 the causality guard actually throws when a future bar leaks in', function () {
    assert.throws(function () {
        L.assertNoFutureData({ bars: [{ closeTime: 1000 }] }, 999);
    }, /FUTURE_LEAK_TIME/);
});

test('C25 the causality guard rejects outcome-flavoured keys', function () {
    ['futureOutcome', 'mfe', 'returnAfter3', 'triggerHit', 'pnl'].forEach(function (key) {
        var payload = {};
        payload[key] = 1;
        assert.throws(function () { L.assertNoFutureData(payload, 10); }, /FUTURE_LEAK_FORBIDDEN_KEY/);
    });
});

test('C26 window guard rejects a bar that closes after confirmation', function () {
    assert.throws(function () {
        L.assertWindowWithinConfirmation([{ openTime: 0, closeTime: 1000 }], 999);
    }, /FUTURE_LEAK_WINDOW/);
});

test('C27 the prompt binds the window length to exactly one allowed pattern', function () {
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 99, 106)];
    var facts = bars.map(L.candleFacts);
    var payload = L.buildUserPayload('BTCUSDT', '5m', bars, facts, bars[1].closeTime);
    var prompt = L.buildUserPrompt(payload);
    // §7: a 2-bar window may only be judged as TWO_BAR_REVERSAL.
    assert.strictEqual(payload.allowedPattern, 'TWO_BAR_REVERSAL');
    assert.strictEqual(payload.windowBarCount, 2);
    assert.ok(prompt.indexOf('may report only TWO_BAR_REVERSAL') >= 0);
    assert.strictEqual(/PIN_BAR|THREE_BAR_REVERSAL/.test(prompt), false);
    // no outcome / future-outcome language may enter the user prompt
    assert.strictEqual(/(outcome|future price|trigger|pnl|profit|win rate)/i.test(prompt), false);
    assert.ok(L.SYSTEM_PROMPT.indexOf('PIN_BAR') >= 0);
    assert.ok(L.SYSTEM_PROMPT.indexOf('TWO_BAR_REVERSAL') >= 0);
    assert.ok(L.SYSTEM_PROMPT.indexOf('THREE_BAR_REVERSAL') >= 0);
});

test('C28 the system prompt forbids future inference and foreign concepts', function () {
    ['You have no information after evaluationTime', 'Do not infer future price action',
        'MTR', 'Wedge', 'Engulfing', 'FVG', 'MSS', 'Displacement', 'Liquidity'].forEach(function (needle) {
        assert.ok(L.SYSTEM_PROMPT.indexOf(needle) >= 0, 'prompt missing ' + needle);
    });
});

// ==================================================== output schema (§12)

test('C29 valid LLM output passes validation', function () {
    var ok = {
        matches: [{
            pattern: 'PIN_BAR', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
            supportingFacts: ['lower rejection'], conflicts: [], reason: 'long lower tail'
        }],
        overall: 'CLEAR_PATTERN'
    };
    assert.deepStrictEqual(L.validateLlmOutput(ok), ok);
});

test('C30 empty matches with overall NONE is allowed', function () {
    assert.deepStrictEqual(L.validateLlmOutput({ matches: [], overall: 'NONE' }), { matches: [], overall: 'NONE' });
});

test('C31 invalid enum values and extra fields are rejected', function () {
    assert.throws(function () {
        L.validateLlmOutput({ matches: [{ pattern: 'WEDGE', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH', supportingFacts: [], conflicts: [], reason: 'x' }], overall: 'NONE' });
    }, /LLM_MATCH_PATTERN_INVALID/);
    assert.throws(function () { L.validateLlmOutput({ matches: [], overall: 'MAYBE' }); }, /LLM_OUTPUT_OVERALL_INVALID/);
    assert.throws(function () { L.validateLlmOutput({ matches: [], overall: 'NONE', extra: 1 }); }, /LLM_OUTPUT_SCHEMA_INVALID/);
});

// ============================================ local runner integration (§19)

// ==================================== UTC+8 time basis and dedupe (§2, §7)

test('C34 UTC+8 formatting uses the candle open time and YYYY-MM-DD HH:mm', function () {
    // 2026-09-17T07:55:00Z == 2026-09-17 15:55 in Asia/Shanghai
    var openMs = Date.parse('2026-09-17T07:55:00.000Z');
    assert.strictEqual(L.formatUtc8(openMs), '2026-09-17 15:55');
    assert.strictEqual(L.formatClockUtc8(openMs), '15:55');
    // a UTC+8 offset never rolls the date backwards across midnight
    assert.strictEqual(L.formatUtc8(Date.parse('2026-09-16T16:10:00.000Z')), '2026-09-17 00:10');
});

test('C35 window length maps to exactly one pattern', function () {
    assert.strictEqual(L.patternForWindow(1), 'PIN_BAR');
    assert.strictEqual(L.patternForWindow(2), 'TWO_BAR_REVERSAL');
    assert.strictEqual(L.patternForWindow(3), 'THREE_BAR_REVERSAL');
    assert.strictEqual(L.patternForWindow(4), null);
});

test('C36 a 2-bar window may not return PIN_BAR or THREE_BAR_REVERSAL', function () {
    ['PIN_BAR', 'THREE_BAR_REVERSAL'].forEach(function (wrong) {
        assert.throws(function () {
            L.validateLlmOutput({
                matches: [{
                    pattern: wrong, direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
                    supportingFacts: [], conflicts: [], reason: 'x'
                }],
                overall: 'CLEAR_PATTERN'
            }, 'TWO_BAR_REVERSAL');
        }, /LLM_MATCH_PATTERN_NOT_ALLOWED_FOR_WINDOW/);
    });
    // the correct pattern still validates
    L.validateLlmOutput({
        matches: [{
            pattern: 'TWO_BAR_REVERSAL', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
            supportingFacts: [], conflicts: [], reason: 'x'
        }],
        overall: 'CLEAR_PATTERN'
    }, 'TWO_BAR_REVERSAL');
});

test('C37 event identity follows the specified window-open-time rule', function () {
    var pin = { pattern: 'PIN_BAR', direction: 'BULLISH', bars: [{ openTime: 1000 }] };
    var two = { pattern: 'TWO_BAR_REVERSAL', direction: 'BULLISH', bars: [{ openTime: 1000 }, { openTime: 2000 }] };
    var three = {
        pattern: 'THREE_BAR_REVERSAL', direction: 'BULLISH',
        bars: [{ openTime: 1000 }, { openTime: 2000 }, { openTime: 3000 }]
    };
    assert.strictEqual(L.eventIdentity('BTCUSDT', pin), 'BTCUSDT|PIN_BAR|BULLISH|1000');
    assert.strictEqual(L.eventIdentity('BTCUSDT', two), 'BTCUSDT|TWO_BAR_REVERSAL|BULLISH|1000|2000');
    assert.strictEqual(L.eventIdentity('BTCUSDT', three),
        'BTCUSDT|THREE_BAR_REVERSAL|BULLISH|1000|2000|3000');
    assert.notStrictEqual(L.eventIdentity('BTCUSDT', pin), L.eventIdentity('BTCUSDT', two));
});

test('C38 dedupe collapses the same window+direction even with different labels', function () {
    var a = {
        pattern: 'PIN_BAR', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
        bars: [{ openTime: 1000 }]
    };
    var b = Object.assign({}, a, { label: 'BORDERLINE' });
    var res = L.dedupeEvents('BTCUSDT', [a, b]);
    assert.strictEqual(res.events.length, 1);
    assert.strictEqual(res.duplicateCount, 1);
});

test('C39 human review text is sectioned in the specified order and lists every bar', function () {
    var events = [
        {
            pattern: 'PIN_BAR', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
            bars: [{ openTime: Date.parse('2026-09-17T07:55:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5 }]
        },
        {
            pattern: 'TWO_BAR_REVERSAL', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
            bars: [
                { openTime: Date.parse('2026-09-17T06:25:00.000Z'), open: 1, high: 2, low: 0.5, close: 0.8 },
                { openTime: Date.parse('2026-09-17T06:30:00.000Z'), open: 0.8, high: 2.5, low: 0.7, close: 2.4 }
            ]
        },
        {
            pattern: 'THREE_BAR_REVERSAL', direction: 'BEARISH', label: 'BORDERLINE', confidence: 'MEDIUM',
            bars: [
                { openTime: Date.parse('2026-09-17T05:20:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.8 },
                { openTime: Date.parse('2026-09-17T05:25:00.000Z'), open: 1.8, high: 1.9, low: 1.6, close: 1.7 },
                { openTime: Date.parse('2026-09-17T05:30:00.000Z'), open: 1.7, high: 1.8, low: 1.0, close: 1.1 }
            ]
        }
    ];
    var text = L.buildHumanReviewText('BTCUSDT', '5m', events);
    assert.ok(text.indexOf('Timezone: UTC+8 / Asia/Shanghai') >= 0);
    assert.ok(text.indexOf('Timestamp meaning: 5m candle OPEN TIME') >= 0);
    var order = ['PIN_BAR | CLEAR', 'PIN_BAR | BORDERLINE', 'TWO_BAR_REVERSAL | CLEAR',
        'TWO_BAR_REVERSAL | BORDERLINE', 'THREE_BAR_REVERSAL | CLEAR', 'THREE_BAR_REVERSAL | BORDERLINE'];
    var last = -1;
    order.forEach(function (title) {
        var at = text.indexOf(title);
        assert.ok(at > last, 'section out of order: ' + title);
        last = at;
    });
    assert.ok(text.indexOf('K1: 2026-09-17 15:55') >= 0);
    assert.ok(text.indexOf('K1: 2026-09-17 14:25') >= 0);
    assert.ok(text.indexOf('K2: 2026-09-17 14:30') >= 0);
    assert.ok(text.indexOf('K1 OHLC: ') >= 0 && text.indexOf('K2 OHLC: ') >= 0);
    assert.ok(text.indexOf('K3: 2026-09-17 13:30') >= 0);
});

test('C40 compact console list prints every bar open time', function () {
    var events = [{
        pattern: 'THREE_BAR_REVERSAL', direction: 'BULLISH', label: 'CLEAR', confidence: 'HIGH',
        bars: [
            { openTime: Date.parse('2026-09-17T05:20:00.000Z') },
            { openTime: Date.parse('2026-09-17T05:25:00.000Z') },
            { openTime: Date.parse('2026-09-17T05:30:00.000Z') }
        ]
    }];
    var list = L.buildCompactTimeList(events);
    assert.ok(list.indexOf('THREE BAR CLEAR') >= 0);
    assert.ok(list.indexOf('13:20 / 13:25 / 13:30 BULLISH') >= 0);
});

var RUNNER = path.join(__dirname, '..', 'scripts', 'local', 'reversalPatternSemanticAuditV1.local.js');
test('C32 local runner candidate builder matches the library (when the local script exists)', function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var candles = [];
    for (var i = 0; i < 6; i++) {
        candles.push(i % 2 === 0 ? mkBar(i, 105, 106, 100, 101) : mkBar(i, 101, 107, 99, 106));
    }
    var built = runner.buildAll(candles);
    assert.strictEqual(built.oneBar.length, L.pinCandidates(candles.map(L.candleFacts)).length);
    assert.ok(built.all.length >= built.twoBar.length);
    var record = runner.candidateRecord(built.all[0]);
    assert.ok(record.candidateId.indexOf(record.pattern) === 0);
    var lastBar = built.all[0].windowBars[built.all[0].windowBars.length - 1];
    assert.strictEqual(record.confirmedAt, lastBar.closeTime);
});

test('C34 runner human-review dedupe checks the final list, not just the collapse count', function () {
    if (!fs.existsSync(RUNNER)) return;
    var runner = require(RUNNER);
    var bars = [mkBar(0, 105, 106, 100, 101), mkBar(1, 101, 107, 99, 106)];
    var built = runner.buildAll(bars);
    var cand = built.all[0];
    function mkResult(dir, label) {
        var rec = runner.candidateRecord(cand);
        rec.status = 'OK';
        rec.llm = {
            matches: [{
                pattern: cand.pattern, direction: dir, label: label, confidence: 'LOW',
                supportingFacts: [], conflicts: [], reason: 'r'
            }],
            overall: 'BORDERLINE_PATTERN'
        };
        return rec;
    }
    // the same window+direction reported twice (the dual-eligibility case)
    var review = runner.humanReviewEvents([mkResult('BULLISH', 'BORDERLINE'), mkResult('BULLISH', 'BORDERLINE')]);
    assert.strictEqual(review.rawMatchRows, 2);
    assert.strictEqual(review.duplicateCount, 1);
    assert.strictEqual(review.events.length, 1);
    assert.strictEqual(review.finalListDuplicateCount, 0);
    assert.strictEqual(review.collapsed.length, 1);
    // two different directions are two different events
    var review2 = runner.humanReviewEvents([mkResult('BULLISH', 'CLEAR'), mkResult('BEARISH', 'CLEAR')]);
    assert.strictEqual(review2.events.length, 2);
    assert.strictEqual(review2.duplicateCount, 0);
});

test('C33 local runner never prints or persists the project API key', function () {
    if (!fs.existsSync(RUNNER)) return;
    var source = fs.readFileSync(RUNNER, 'utf8');
    assert.strictEqual(/sk-[A-Za-z0-9]{8}/.test(source), false);
    assert.ok(source.indexOf('deepSeekApiKey') >= 0);
    assert.strictEqual(/console\.log\([^)]*apiKey/.test(source), false);
    assert.strictEqual(/writeFileSync\([^)]*apiKey/.test(source), false);
});

console.log('FUTURE_LEAK_TEST=' + (failed === 0 ? 'PASS' : 'FAIL'));
console.log('CHECKS PASSED: ' + passed);
console.log('CHECKS FAILED: ' + failed);
console.log('REVERSAL_PATTERN_SEMANTIC_AUDIT_V1_TESTS=' + (failed === 0 ? 'PASS' : 'FAIL')
    + ' (' + passed + ' checks, ' + failed + ' failed)');
if (failed > 0) process.exitCode = 1;
