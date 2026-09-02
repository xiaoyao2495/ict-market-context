'use strict';

/**
 * ATR50 causal ZigZag HIGH/LOW price semantics (V2) — unit proof.
 *
 * Frozen contract under test (task PROMUSDT_ATR50_ZIGZAG_HIGH_LOW_REPLAY_2026_09_02_1725):
 *   - UPTREND  extreme extension uses candle.high  (never candle.close)
 *   - DOWNTREND extreme extension uses candle.low   (never candle.close)
 *   - HIGH reversal confirmation  = extremeHigh  - candle.low  >= 0.50 * ATR
 *   - LOW  reversal confirmation  = candle.high  - extremeLow  >= 0.50 * ATR
 *   - occurredAt  = real extreme 5m candle.openTime
 *   - confirmedAt = reversal-confirming candle.closeTime (completion convention)
 *   - deterministic on identical input
 *   - a 17:25-capped causal driver never consumes a candle that opens at/after the
 *     evaluation boundary (no-future-data discipline)
 *
 * The module under test is liquidity/atr50CausalZigZag.js (working tree, V2).
 * Four-hour Wilder ATR14 is bypassed here by seeding state.fourHourAtrValue = 10
 * (threshold = 5) so reversal math is fully deterministic; the module's own ATR
 * path is covered by test/atr50CausalZigZag* external real-data replays.
 */

var assert = require('assert');
var zigzag = require('../liquidity/atr50CausalZigZag');

var BAR = 300000; // 5m
var THRESHOLD = 5; // 0.50 * seeded ATR(10)

var passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + error.message); }
}

function bar(i, open, high, low, close) {
    return {
        openTime: i * BAR,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: (i + 1) * BAR - 1,
        closed: true
    };
}

/** Fresh state with ATR seeded so 0.50*ATR === THRESHOLD. */
function freshState() {
    var s = zigzag.createState({ symbol: 'X', timeframe: '5m', fourHourCandles: [] });
    s.fourHourAtrValue = 2 * THRESHOLD; // ATR 10 -> reversal threshold 5
    return s;
}

/**
 * Canonical scenario (threshold = 5). Bars:
 *   bar0 O95 H95 L80 C80            init (envelopes)
 *   bar1 O82 H85 L81 C85            85-80=5  -> confirm LOW @80 (occ bar0)  -> UPTREND
 *   bar2 O100 H103 L99 C101         high 103 > 85 -> extend; 103-99=4 <5 no reversal
 *   bar3 O101 H104 L99.5 C100       high 104 > 103 -> extend (close 100 NOT a new
 *                                   close-extreme: prior extreme close = 101)
 *   bar4 O100 H101 L97 C100.5       104-97=7 >=5 -> confirm HIGH @104 (occ bar3) -> DOWNTREND
 *   bar5 O96 H98.5 L94 C98          low 94 < 97 -> extend (close 98 not the extreme)
 *   bar6 O97 H100.5 L96.5 C97.5     100.5-94=6.5 >=5 -> confirm LOW @94 (occ bar5) -> UPTREND
 * Expected confirmed points (in order): LOW 80, HIGH 104, LOW 94.
 */
function scenarioBars() {
    return [
        bar(0, 95, 95, 80, 80),
        bar(1, 82, 85, 81, 85),
        bar(2, 100, 103, 99, 101),
        bar(3, 101, 104, 99.5, 100),
        bar(4, 100, 101, 97, 100.5),
        bar(5, 96, 98.5, 94, 98),
        bar(6, 97, 100.5, 96.5, 97.5)
    ];
}

function stepAll(state, candles) {
    for (var i = 0; i < candles.length; i++) zigzag.step(state, candles[i], i, candles);
    return state;
}

test('T09-module-header: V2 version and price source are frozen', function () {
    assert.strictEqual(zigzag.VERSION, 'CAUSAL_ATR50_ZIGZAG_V2');
    assert.strictEqual(zigzag.PRICE_SOURCE, 'HIGH_LOW');
    assert.strictEqual(zigzag.ATR_MULTIPLIER, 0.5);
});

test('T05c-extremePrice: HIGH->candle.high, LOW->candle.low, close never used', function () {
    var c = { open: 5, high: 9, low: 3, close: 7 };
    assert.strictEqual(zigzag.extremePrice('HIGH', c), 9);
    assert.strictEqual(zigzag.extremePrice('LOW', c), 3);
});

// ---- Canonical scenario drive ---------------------------------------------

test('T01-T02 scenario baseline: 3 confirmed points LOW80/HIGH104/LOW94', function () {
    var s = stepAll(freshState(), scenarioBars());
    assert.strictEqual(s.direction, 'UPTREND');
    assert.strictEqual(s.confirmedPoints.length, 3);
    var sides = s.confirmedPoints.map(function (p) { return p.pointSide; });
    assert.deepStrictEqual(sides, ['LOW', 'HIGH', 'LOW']);
    assert.deepStrictEqual(s.confirmedPoints.map(function (p) { return p.price; }), [80, 104, 94]);
});

test('T01: UPTREND extreme uses candle.high (104, not close 100)', function () {
    var s = freshState(), candles = scenarioBars();
    zigzag.step(s, candles[0], 0, candles); // init
    zigzag.step(s, candles[1], 1, candles); // LOW@80 -> UPTREND
    zigzag.step(s, candles[2], 2, candles); // extend to high 103
    assert.strictEqual(s.activeExtreme.candle.openTime, 2 * BAR);
    assert.strictEqual(s.activeExtreme.candle.high, 103);
    zigzag.step(s, candles[3], 3, candles); // extend to high 104
    assert.strictEqual(s.activeExtreme.candle.openTime, 3 * BAR);
    assert.strictEqual(zigzag.extremePrice('HIGH', s.activeExtreme.candle), 104);
    assert.strictEqual(s.confirmedPoints.length, 1); // no premature confirmation
});

test('T02: DOWNTREND extreme uses candle.low (94, not close 98)', function () {
    var s = freshState(), candles = scenarioBars();
    for (var i = 0; i <= 4; i++) zigzag.step(s, candles[i], i, candles); // through HIGH@104 -> DOWNTREND
    assert.strictEqual(s.direction, 'DOWNTREND');
    zigzag.step(s, candles[5], 5, candles);
    assert.strictEqual(s.activeExtreme.candle.openTime, 5 * BAR);
    assert.strictEqual(zigzag.extremePrice('LOW', s.activeExtreme.candle), 94);
    assert.strictEqual(s.activeExtreme.candle.close, 98); // close is NOT the extreme
});

test('T05: close no longer decides extreme price (bar3: close 100 < prior extreme close 101, high 104 still extends)', function () {
    var s = freshState(), candles = scenarioBars();
    zigzag.step(s, candles[0], 0, candles);
    zigzag.step(s, candles[1], 1, candles);
    zigzag.step(s, candles[2], 2, candles);
    var priorExtremeClose = s.activeExtreme.candle.close; // bar2 close = 101
    zigzag.step(s, candles[3], 3, candles);
    assert.ok(candles[3].close < priorExtremeClose); // close-based tracker would NOT extend
    assert.strictEqual(s.activeExtreme.candle.openTime, 3 * BAR); // but high/low tracker DID extend
    assert.strictEqual(s.activeExtreme.candle.high, 104);
});

test('T03+T06: HIGH reversal uses extremeHigh - candle.low (close-based distance 3.5 < 5 would not fire)', function () {
    var s = freshState(), candles = scenarioBars();
    for (var i = 0; i <= 3; i++) zigzag.step(s, candles[i], i, candles);
    assert.strictEqual(s.confirmedPoints.length, 1); // LOW@80 only
    assert.ok(candles[4].close >= candles[4].low);
    // close-based reversal measure would be 104 - 100.5 = 3.5 < 5; intrabar is 104 - 97 = 7 >= 5
    zigzag.step(s, candles[4], 4, candles);
    assert.strictEqual(s.confirmedPoints.length, 2);
    var high = s.confirmedPoints[1];
    assert.strictEqual(high.pointSide, 'HIGH');
    assert.strictEqual(high.price, 104);
    assert.strictEqual(s.direction, 'DOWNTREND');
});

test('T06b: reversal cannot confirm on an unclosed candle (closed=false is ignored)', function () {
    var s = freshState(), candles = scenarioBars();
    for (var i = 0; i <= 3; i++) zigzag.step(s, candles[i], i, candles);
    var unclosed = bar(4, 100, 101, 97, 100.5);
    unclosed.closed = false;
    var emitted = zigzag.step(s, unclosed, 4, candles);
    assert.strictEqual(emitted.length, 0);
    assert.strictEqual(s.confirmedPoints.length, 1); // not confirmed while forming
});

test('T04+T06c: LOW reversal uses candle.high - extremeLow (close-based distance 3.5 < 5 would not fire)', function () {
    var s = freshState(), candles = scenarioBars();
    for (var i = 0; i <= 5; i++) zigzag.step(s, candles[i], i, candles);
    assert.strictEqual(s.confirmedPoints.length, 2);
    assert.strictEqual(s.direction, 'DOWNTREND');
    zigzag.step(s, candles[6], 6, candles);
    assert.strictEqual(s.confirmedPoints.length, 3);
    var low = s.confirmedPoints[2];
    assert.strictEqual(low.pointSide, 'LOW');
    assert.strictEqual(low.price, 94);
    assert.strictEqual(s.direction, 'UPTREND');
});

test('T07: occurredAt points at the real extreme candle openTime', function () {
    var s = stepAll(freshState(), scenarioBars());
    var p = s.confirmedPoints;
    assert.strictEqual(p[0].occurredAt, 0 * BAR); // LOW@80 extreme candle is bar0
    assert.strictEqual(p[0].occurredBarIndex, 0);
    assert.strictEqual(p[1].occurredAt, 3 * BAR); // HIGH@104 extreme candle is bar3
    assert.strictEqual(p[1].occurredBarIndex, 3);
    assert.strictEqual(p[2].occurredAt, 5 * BAR); // LOW@94 extreme candle is bar5
    assert.strictEqual(p[2].occurredBarIndex, 5);
});

test('T09: identical input yields identical output (determinism)', function () {
    var a = stepAll(freshState(), scenarioBars());
    var b = stepAll(freshState(), scenarioBars());
    assert.deepStrictEqual(
        a.confirmedPoints.map(function (p) { return { id: p.id, price: p.price, occurredAt: p.occurredAt, confirmedAt: p.confirmedAt, status: p.status }; }),
        b.confirmedPoints.map(function (p) { return { id: p.id, price: p.price, occurredAt: p.occurredAt, confirmedAt: p.confirmedAt, status: p.status }; })
    );
    assert.strictEqual(a.activeExtreme.candle.openTime, b.activeExtreme.candle.openTime);
});

// ---- T08 corrected assertions live below in one explicit pass ------------

test('T08-detail: confirmedAt uses Binance close-completion convention (closeTime)', function () {
    var s = freshState(), candles = scenarioBars();
    for (var i = 0; i < candles.length; i++) zigzag.step(s, candles[i], i, candles);
    // bar1 completes 1st LOW -> closeTime of bar1 = 2*BAR-1
    assert.strictEqual(s.confirmedPoints[0].confirmedAt, 2 * BAR - 1);
    assert.strictEqual(s.confirmedPoints[0].confirmationBarIndex, 1);
    // bar4 completes HIGH -> closeTime of bar4 = 5*BAR-1
    assert.strictEqual(s.confirmedPoints[1].confirmedAt, 5 * BAR - 1);
    assert.strictEqual(s.confirmedPoints[1].confirmationBarIndex, 4);
    // bar6 completes LOW -> closeTime of bar6 = 7*BAR-1
    assert.strictEqual(s.confirmedPoints[2].confirmedAt, 7 * BAR - 1);
    assert.strictEqual(s.confirmedPoints[2].confirmationBarIndex, 6);
    // none of the confirmedAt times fall before their occurredAt candle closed
    s.confirmedPoints.forEach(function (p) {
        assert.ok(p.confirmedAt > p.occurredAt);
    });
});

// ---- T10: causal driver frozen at an evaluation boundary -------------------

test('T10: 17:25-frozen replay does not read the candle that opens at/after the boundary', function () {
    // Evaluation boundary: 17:25 +08:00 -> 2026-09-02 09:25 UTC.
    var EVAL = Date.UTC(2026, 8, 2, 9, 25, 0);
    // Map the canonical scenario so bar5 closes exactly at EVAL-1 ("17:20 bar")
    // and bar6 would open exactly at EVAL ("17:25 bar" -> forbidden).
    var BASE = EVAL - 6 * BAR;
    var candles = scenarioBars().map(function (c, i) {
        var openTime = BASE + i * BAR;
        return {
            openTime: openTime,
            open: c.open, high: c.high, low: c.low, close: c.close,
            closeTime: openTime + BAR - 1,
            closed: true
        };
    });
    assert.strictEqual(candles[5].closeTime, EVAL - 1); // last causal candle
    assert.strictEqual(candles[6].openTime, EVAL); // forbidden candle present in array

    // bar6 would reverse the pending LOW@94 (high 100.5 - 94 = 6.5 >= 5) if it were read.
    function causalDriver(all) {
        var s = freshState();
        var fedMaxClose = null, fedCount = 0;
        for (var i = 0; i < all.length; i++) {
            if (all[i].closeTime > EVAL) continue; // causal gate: never read beyond boundary
            zigzag.step(s, all[i], i, all);
            fedCount++;
            fedMaxClose = all[i].closeTime;
        }
        return { s: s, fedCount: fedCount, fedMaxClose: fedMaxClose };
    }

    var causal = causalDriver(candles);
    assert.strictEqual(causal.fedCount, 6); // bars 0..5 only
    assert.strictEqual(causal.fedMaxClose, EVAL - 1); // no future data consumed
    assert.strictEqual(causal.s.confirmedPoints.length, 2); // LOW80, HIGH104 confirmed
    assert.strictEqual(causal.s.direction, 'DOWNTREND');
    assert.strictEqual(causal.s.activeExtreme.candle.openTime, 5 * BAR + BASE); // pending LOW@94 on bar5
    assert.strictEqual(zigzag.extremePrice('LOW', causal.s.activeExtreme.candle), 94);
    assert.strictEqual(causal.s.lastFiveMinuteIndex, 5); // the 17:25 bar was never stepped

    // Negative control: a driver that DOES step the forbidden 17:25 bar sees it react.
    var lax = freshState();
    for (var j = 0; j <= 5; j++) zigzag.step(lax, candles[j], j, candles);
    assert.strictEqual(lax.confirmedPoints.length, 2);
    zigzag.step(lax, candles[6], 6, candles); // forbidden candle WOULD confirm LOW@94
    assert.strictEqual(lax.confirmedPoints.length, 3);
    assert.strictEqual(lax.confirmedPoints[2].price, 94);
    assert.strictEqual(lax.confirmedPoints[2].confirmedAt, candles[6].closeTime);
});

test('T10b: point IDs embed the high/low extreme price, not close', function () {
    var s = stepAll(freshState(), scenarioBars());
    var p = s.confirmedPoints[1]; // HIGH@104
    assert.ok(p.id.indexOf('104') !== -1);
    assert.ok(p.id.indexOf(':HIGH:') !== -1);
    var q = s.confirmedPoints[2]; // LOW@94
    assert.ok(q.id.indexOf('94') !== -1);
    assert.ok(q.id.indexOf(':LOW:') !== -1);
});

console.log('\nATR50 Causal ZigZag HIGH/LOW V2: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
