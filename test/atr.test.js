/**
 * ATR(14) 单元测试
 *
 * - True Range 标准公式（含 gap）
 * - Wilder smoothing
 * - 不足数据返回 null
 * - replay safe（endIndex 只读历史）
 */
var assert = require('assert');
var atrIndicator = require('../indicators/atr');

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

function c(open, high, low, close) {
    return { openTime: 0, open: open, high: high, low: low, close: close, closed: true };
}

/* ---------- True Range ---------- */

test('TR：普通 candle（high-low 最大）', function () {
    var prev = c(90, 95, 85, 92);
    var cur = c(92, 100, 90, 98);
    assert.strictEqual(atrIndicator.trueRange(cur, prev), 10); // high-low
});

test('TR：gap up（high-prevClose 最大）', function () {
    var prev = c(90, 95, 85, 92);
    var cur = c(95, 110, 95, 108); // low 95 > prevClose 92 → gap
    assert.strictEqual(atrIndicator.trueRange(cur, prev), 18); // 110-92
});

test('TR：gap down（prevClose-low 最大）', function () {
    var prev = c(90, 95, 85, 92);
    var cur = c(85, 88, 80, 82); // high 88 < prevClose 92 → gap down
    assert.strictEqual(atrIndicator.trueRange(cur, prev), 12); // 92-80
});

test('TR：首根无 prev → high - low', function () {
    assert.strictEqual(atrIndicator.trueRange(c(90, 100, 80, 95), null), 20);
});

/* ---------- ATR Wilder ---------- */

test('ATR：平稳序列 TR 恒 10 → ATR 10', function () {
    var candles = [];
    var i;
    for (i = 0; i < 20; i++) {
        candles.push(c(90 + i, 100 + i, 90 + i, 95 + i));
    }
    assert.strictEqual(atrIndicator.atr(candles, 14), 10);
});

test('ATR：Wilder smoothing 数值验证（period 3）', function () {
    // TR: 20, 30, 40, 50（TR 从 index 1 起）
    var candles = [
        c(5, 10, 0, 5),
        c(5, 20, 0, 15), // TR = 20
        c(15, 30, 0, 25), // TR = 30
        c(25, 40, 0, 35), // TR = 40
        c(35, 50, 0, 45) // TR = 50
    ];
    // 第一个 ATR（endIndex 3）= SMA(20,30,40) = 30
    assert.strictEqual(atrIndicator.atr(candles, 3, 3), 30);
    // Wilder：ATR(4) = (30*2 + 50)/3 = 36.6667
    assert.ok(Math.abs(atrIndicator.atr(candles, 3, 4) - 36.6667) < 1e-4);
});

/* ---------- 边界 ---------- */

test('不足 period+1 根 → null', function () {
    var candles = [c(90, 100, 80, 95), c(90, 100, 80, 95)];
    assert.strictEqual(atrIndicator.atr(candles, 14), null);
});

test('空数组 → null', function () {
    assert.strictEqual(atrIndicator.atr([], 14), null);
});

test('endIndex 数据不足 → null', function () {
    var candles = [];
    var i;
    for (i = 0; i < 20; i++) {
        candles.push(c(90 + i, 100 + i, 90 + i, 95 + i));
    }
    assert.strictEqual(atrIndicator.atr(candles, 14, 5), null); // endIndex 5 < 14
});

test('replay safe：endIndex 之前的 ATR 不受后续 K 线影响', function () {
    var candles = [];
    var i;
    for (i = 0; i < 20; i++) {
        candles.push(c(90 + i, 100 + i, 90 + i, 95 + i));
    }
    var atrAt15 = atrIndicator.atr(candles, 14, 15);
    // 在末尾加一根波动极大的 K 线，不影响 index 15 的 ATR
    candles.push(c(100, 500, 0, 400));
    assert.strictEqual(atrIndicator.atr(candles, 14, 15), atrAt15);
});

console.log('----');
console.log('atr: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
