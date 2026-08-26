/**
 * displacementDetector 单元测试
 *
 * 5 项评分（score >= 3 → DISPLACEMENT）：
 *   bodyRatio >= 0.6 / rangeAtr >= 1.2 / bodyAtr >= 0.8 / closeExtreme >= 0.75 / same-candle MSS
 * - doji 排除、未收盘排除
 * - confirmedAt = closeTime
 */
var assert = require('assert');
var displacementDetector = require('../events/displacementDetector');

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

function m5(open, high, low, close, openTime, closed) {
    return {
        openTime: openTime,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: openTime + 300000 - 1,
        closed: closed !== false,
        source: 'futures'
    };
}

/**
 * 构造 ATR 环境：前 20 根平缓（TR 恒 10 → ATR 10），随后是大 candle
 */
function baseCandles() {
    var out = [];
    var i;
    for (i = 0; i < 20; i++) {
        out.push(m5(90 + i, 100 + i, 90 + i, 95 + i, 1000000 + i * 300000));
    }
    return out;
}

var OPTS = { symbol: 'BTCUSDT', timeframe: '5m' };

/* ---------- bullish displacement ---------- */

test('bullish displacement：大幅 bullish candle（4 分）', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000)); // range 42, body 38
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].direction, 'BULLISH');
    assert.strictEqual(d[0].type, 'DISPLACEMENT');
    // bodyRatio 38/42=0.905 / rangeAtr 4.2 / bodyAtr 3.8 / closeExtreme 0.952 → 4 分
    assert.strictEqual(d[0].metadata.score, 4);
    assert.strictEqual(d[0].confirmedAt, 1000000 + 20 * 300000 + 300000 - 1);
});

test('bearish displacement：大幅 bearish candle', function () {
    var candles = baseCandles();
    candles.push(m5(140, 142, 98, 100, 1000000 + 20 * 300000)); // close 100 < open 140
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].direction, 'BEARISH');
    assert.ok(d[0].metadata.score >= 3);
});

/* ---------- score 边界 ---------- */

test('score 2 不生成（普通 candle 各指标不足）', function () {
    var candles = baseCandles();
    // range 20, body 10 → bodyRatio 0.5 < 0.6；rangeAtr 2.0 >= 1.2 ✓；bodyAtr 1.0 >= 0.8 ✓；closeExtreme 0.5 < 0.75
    candles.push(m5(90, 110, 90, 100, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 0); // 2 分 < 3
});

test('恰好 score 3 生成（bodyRatio + rangeAtr + bodyAtr，closeExtreme 不足）', function () {
    var candles = baseCandles();
    // range 13, body 8.8 → bodyRatio 0.677 ✓ / rangeAtr 1.22 ✓ / bodyAtr 0.83 ✓ / closeExtreme 0.70 ✗ → 3 分
    candles.push(m5(95.3, 108, 95, 104.1, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.score, 3);
});

/* ---------- same-candle MSS bonus ---------- */

test('same-candle MSS bonus：2 分 + MSS → 生成', function () {
    var candles = baseCandles();
    // range 13, body 8.2 → bodyRatio 0.631 ✓ / rangeAtr 1.22 ✓ / bodyAtr 0.77 ✗ / closeExtreme 0.64 ✗ → 2 分
    candles.push(m5(95.1, 108, 95, 103.3, 1000000 + 20 * 300000));
    var mssEvents = [
        { id: 'M1', candleIndex: 20, direction: 'BULLISH' }
    ];
    var d = displacementDetector.detectDisplacement(candles, mssEvents, OPTS);
    assert.strictEqual(d.length, 1); // 2 + 1(MSS) = 3
    assert.strictEqual(d[0].metadata.mssEventId, 'M1');
});

test('bearish displacement links same-bar bearish MSS', function () {
    var candles = baseCandles();
    candles.push(m5(140, 142, 98, 100, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MB', candleIndex: 20, direction: 'BEARISH' }
    ], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.mssEventId, 'MB');
});

test('bullish displacement does not link opposite-only bearish MSS', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MB', candleIndex: 20, direction: 'BEARISH' }
    ], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.mssEventId, null);
});

test('bearish displacement does not link opposite-only bullish MSS', function () {
    var candles = baseCandles();
    candles.push(m5(140, 142, 98, 100, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MU', candleIndex: 20, direction: 'BULLISH' }
    ], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.mssEventId, null);
});

test('mixed same-bar MSS selects bullish match even when bearish is first', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MB', candleIndex: 20, direction: 'BEARISH' },
        { id: 'MU', candleIndex: 20, direction: 'BULLISH' }
    ], OPTS);
    assert.strictEqual(d[0].metadata.mssEventId, 'MU');
});

test('mixed same-bar MSS selects bearish match even when bullish is first', function () {
    var candles = baseCandles();
    candles.push(m5(140, 142, 98, 100, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MU', candleIndex: 20, direction: 'BULLISH' },
        { id: 'MB', candleIndex: 20, direction: 'BEARISH' }
    ], OPTS);
    assert.strictEqual(d[0].metadata.mssEventId, 'MB');
});

test('multiple same-direction MSS preserves deterministic input ordering', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MU-FIRST', candleIndex: 20, direction: 'BULLISH' },
        { id: 'MU-SECOND', candleIndex: 20, direction: 'BULLISH' }
    ], OPTS);
    assert.strictEqual(d[0].metadata.mssEventId, 'MU-FIRST');
});

test('opposite-only same-bar MSS preserves displacement detection score', function () {
    var candles = baseCandles();
    candles.push(m5(95.1, 108, 95, 103.3, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MB', candleIndex: 20, direction: 'BEARISH' }
    ], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.score, 3);
    assert.strictEqual(d[0].metadata.mssEventId, null);
});

test('future same-direction MSS is not searched when current bar has only opposite MSS', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [
        { id: 'MB-NOW', candleIndex: 20, direction: 'BEARISH' },
        { id: 'MU-FUTURE', candleIndex: 21, direction: 'BULLISH' }
    ], OPTS);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].metadata.mssEventId, null);
});

test('无 MSS 时同 candle 只有 2 分 → 不生成', function () {
    var candles = baseCandles();
    candles.push(m5(95.1, 108, 95, 103.3, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 0);
});

/* ---------- 排除 ---------- */

test('doji（body = 0）不生成', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 100, 1000000 + 20 * 300000)); // open == close == 100
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 0);
});

test('未收盘 candle 不参与', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000, false));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 0);
});

test('ATR 数据不足（少于 period+1）→ 无 displacement', function () {
    var candles = [];
    var i;
    for (i = 0; i < 5; i++) {
        candles.push(m5(90 + i, 100 + i, 90 + i, 95 + i, 1000000 + i * 300000));
    }
    candles.push(m5(100, 140, 98, 138, 1000000 + 5 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    assert.strictEqual(d.length, 0);
});

/* ---------- 字段 ---------- */

test('事件字段完整（metadata 含所有评分项）', function () {
    var candles = baseCandles();
    candles.push(m5(100, 140, 98, 138, 1000000 + 20 * 300000));
    var d = displacementDetector.detectDisplacement(candles, [], OPTS);
    var ev = d[0];
    assert.ok(ev.id.indexOf('BTCUSDT:5m:DISPLACEMENT:') === 0);
    assert.strictEqual(ev.price, 138);
    assert.ok(typeof ev.metadata.body === 'number');
    assert.ok(typeof ev.metadata.range === 'number');
    assert.ok(typeof ev.metadata.bodyRatio === 'number');
    assert.ok(typeof ev.metadata.atr === 'number');
    assert.ok(typeof ev.metadata.rangeAtr === 'number');
    assert.ok(typeof ev.metadata.bodyAtr === 'number');
    assert.ok(typeof ev.metadata.closeExtremeRatio === 'number');
    assert.strictEqual(ev.metadata.maxScore, 5);
});

console.log('----');
console.log('displacementDetector: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
