/**
 * pivotDetector 单元测试
 * 重点：
 * - Pivot 右侧确认（不允许未来数据）
 * - 边界条件（数组太短 / index 越界）
 * - 相等值不构成 Pivot（严格比较）
 */
var assert = require('assert');
var pivotDetector = require('../structure/pivotDetector');

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

/* 构造工具：candle = { high, low } */
function candle(high, low) {
    return { high: high, low: low };
}

/* ---------- 右侧确认（核心：禁止未来数据） ---------- */

/*
 * HIGH 测试数组：low 单调递减，保证整段序列永远不会形成 Pivot Low，
 * 只允许 index=4 成为唯一的 Pivot High。
 */
function highOnlyCandles(count) {
    var all = [
        candle(100, 99),
        candle(101, 98),
        candle(102, 97),
        candle(101, 96),
        candle(103, 95), // 潜在 HIGH
        candle(101, 94),
        candle(100, 93)
    ];
    return all.slice(0, count);
}

test('完整序列：index=4 的 HIGH 被确认（left=2, right=2）', function () {
    var candles = highOnlyCandles(7);
    assert.strictEqual(pivotDetector.detectPivotHigh(candles, 4, 2, 2), true);
});

test('右侧 K 线未到齐：只有 6 根时 HIGH 不确认，pivot 为 0', function () {
    var candles = highOnlyCandles(6); // index=4 的右侧只出现 1 根
    assert.strictEqual(pivotDetector.detectPivotHigh(candles, 4, 2, 2), false);
    assert.strictEqual(
        pivotDetector.detectPivots(candles, { left: 2, right: 2 }).length,
        0
    );
});

test('第 7 根 K 线到达后 HIGH 被确认', function () {
    var candles = highOnlyCandles(7);
    var pivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
    assert.strictEqual(pivots.length, 1);
    assert.strictEqual(pivots[0].type, 'HIGH');
    assert.strictEqual(pivots[0].index, 4);
    assert.strictEqual(pivots[0].price, 103);
});

/*
 * LOW 测试数组：high 单调递减（且 index=3 与 index=1 相等），
 * 保证整段序列不会形成 Pivot High，只允许 index=4 成为唯一的 Pivot Low。
 */
function lowOnlyCandles(count) {
    var all = [
        candle(106, 104),
        candle(105, 103),
        candle(104, 102),
        candle(105, 101),
        candle(103, 98), // 潜在 LOW
        candle(104, 100),
        candle(105, 102)
    ];
    return all.slice(0, count);
}

test('LOW 同样需要右侧确认：只有 6 根时不识别', function () {
    var candles = lowOnlyCandles(6); // index=4 的右侧只出现 1 根
    assert.strictEqual(pivotDetector.detectPivotLow(candles, 4, 2, 2), false);
    assert.strictEqual(
        pivotDetector.detectPivots(candles, { left: 2, right: 2 }).length,
        0
    );
});

test('第 7 根 K 线到达后 LOW 被确认', function () {
    var candles = lowOnlyCandles(7);
    assert.strictEqual(pivotDetector.detectPivotLow(candles, 4, 2, 2), true);
    var pivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
    assert.strictEqual(pivots.length, 1);
    assert.strictEqual(pivots[0].type, 'LOW');
    assert.strictEqual(pivots[0].index, 4);
    assert.strictEqual(pivots[0].price, 98);
});

/* ---------- 边界条件 ---------- */

test('空数组 → 空结果', function () {
    assert.deepStrictEqual(pivotDetector.detectPivots([], { left: 2, right: 2 }), []);
});

test('数组太短（< left+right+1）→ 空结果', function () {
    var candles = [
        candle(100, 99),
        candle(101, 98),
        candle(102, 97),
        candle(101, 96)
    ];
    assert.deepStrictEqual(pivotDetector.detectPivots(candles, { left: 2, right: 2 }), []);
});

test('index 位于左侧边界内（index < left）→ 不识别', function () {
    var candles = [
        candle(100, 99),
        candle(101, 98),
        candle(102, 97),
        candle(101, 96),
        candle(103, 100),
        candle(101, 99),
        candle(100, 98)
    ];
    assert.strictEqual(pivotDetector.detectPivotHigh(candles, 0, 2, 2), false);
    assert.strictEqual(pivotDetector.detectPivotLow(candles, 1, 2, 2), false);
});

/* ---------- 严格比较：相等不构成 Pivot ---------- */

test('HIGH 相等（<= 左/右侧）不构成 Pivot High', function () {
    var candles = [
        candle(100, 99),
        candle(101, 98),
        candle(102, 97), // 与 index=4 的 high 相等
        candle(101, 96),
        candle(102, 100), // 潜在 HIGH，但与左侧相等
        candle(101, 99),
        candle(100, 98)
    ];
    assert.strictEqual(pivotDetector.detectPivotHigh(candles, 4, 2, 2), false);
});

test('LOW 相等（>= 左/右侧）不构成 Pivot Low', function () {
    var candles = [
        candle(105, 103),
        candle(104, 102),
        candle(103, 101), // 与 index=4 的 low 相等
        candle(104, 102),
        candle(100, 101), // 潜在 LOW，但与左侧相等
        candle(102, 100),
        candle(103, 101)
    ];
    assert.strictEqual(pivotDetector.detectPivotLow(candles, 4, 2, 2), false);
});

/* ---------- 单调序列不产生相反方向 Pivot ---------- */

test('单边下跌序列：只可能出 LOW，不产生 HIGH', function () {
    var candles = [
        candle(110, 108),
        candle(109, 107),
        candle(108, 106),
        candle(107, 105),
        candle(106, 104),
        candle(105, 103),
        candle(104, 102)
    ];
    var pivots = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
    pivots.forEach(function (p) {
        assert.strictEqual(p.type, 'LOW');
    });
});

console.log('----');
console.log('pivotDetector: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
