/**
 * Phase 11L.5 — Near Draw staleness 测试
 *
 * checkNearConsumed：near target 在 anchor+1..availableIndex 之间被价格触及
 * （BULLISH high>=target / BEARISH low<=target）→ 已消费（Live 将 STALE_NEAR_SUPPRESSED）。
 */
var assert = require('assert');
var nearStaleness = require('../stats/nearStaleness');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

function candle(high, low, i) {
    var base = 1700000000000 + i * 300000;
    return { openTime: base, closeTime: base + 299999, high: high, low: low, open: 100, close: 100 };
}

test('BULLISH: 窗口内 high >= nearTarget → consumed', function () {
    var candles = [candle(101, 99, 0), candle(104, 102, 1), candle(103, 101, 2)];
    var r = nearStaleness.checkNearConsumed(103.5, 'BULLISH', candles, 1, 2);
    assert.strictEqual(r.consumed, true, 'index 1 high 104 >= 103.5');
    assert.strictEqual(r.firstTouchIndex, 1);
});

test('BULLISH: 窗口内未触及 → 未消费', function () {
    var candles = [candle(101, 99, 0), candle(103, 101, 1), candle(103.4, 101, 2)];
    var r = nearStaleness.checkNearConsumed(103.5, 'BULLISH', candles, 1, 2);
    assert.strictEqual(r.consumed, false);
    assert.strictEqual(r.firstTouchIndex, null);
});

test('BEARISH: 窗口内 low <= nearTarget → consumed', function () {
    var candles = [candle(101, 99, 0), candle(100, 96, 1), candle(99, 97, 2)];
    var r = nearStaleness.checkNearConsumed(96.5, 'BEARISH', candles, 1, 2);
    assert.strictEqual(r.consumed, true, 'index 1 low 96 <= 96.5');
    assert.strictEqual(r.firstTouchIndex, 1);
});

test('BEARISH: 未触及 → 未消费', function () {
    var candles = [candle(101, 99, 0), candle(100, 97, 1), candle(99, 97.2, 2)];
    var r = nearStaleness.checkNearConsumed(96.5, 'BEARISH', candles, 1, 2);
    assert.strictEqual(r.consumed, false);
});

test('空区间（feed 立即关闭，availableIndex === anchorIndex）→ 不消费', function () {
    var candles = [candle(110, 90, 0)];
    var r = nearStaleness.checkNearConsumed(105, 'BULLISH', candles, 1, 1);
    assert.strictEqual(r.consumed, false, '无中间 K 可触及');
});

test('nearTarget 为 null → 不消费', function () {
    var candles = [candle(110, 90, 0), candle(120, 100, 1)];
    var r = nearStaleness.checkNearConsumed(null, 'BULLISH', candles, 1, 1);
    assert.strictEqual(r.consumed, false);
});

test('第一个触及点被正确捕获（区间内最早触及的 index）', function () {
    var candles = [candle(101, 99, 0), candle(102, 100, 1), candle(103.5, 101, 2), candle(106, 104, 3)];
    var r = nearStaleness.checkNearConsumed(103, 'BULLISH', candles, 1, 3);
    assert.strictEqual(r.consumed, true);
    assert.strictEqual(r.firstTouchIndex, 2, 'index 2 high 103.5 首次触及');
});

console.log('----');
console.log('nearStaleness: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
