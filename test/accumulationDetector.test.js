/**
 * accumulationDetector 单元测试
 *
 * - 横盘窗口（低效率 + 压缩 + 多次 mid cross）→ ACCUMULATION_CONFIRMED
 * - 12 bars 下限 / trending 拒绝 / 宽 range 拒绝
 * - EQH/EQL 加分
 * - future candle 排除
 * - deterministic
 */
var assert = require('assert');
var accumulationDetector = require('../amd/accumulationDetector');
var liquidityRegistry = require('../liquidity/liquidityRegistry');

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

var BAR = 300000;

function m5(open, high, low, close, openTime) {
    return {
        openTime: openTime, open: open, high: high, low: low, close: close,
        closeTime: openTime + BAR - 1, closed: true, source: 'futures'
    };
}

/**
 * 横盘 candles：close 围绕 100 振荡，range 窄（约 96-106）
 */
function chopCandles(n) {
    var closes = [100, 98, 102, 99, 103, 97, 101, 99, 103, 98, 102, 100, 104, 97, 101, 99, 102, 98, 100, 101, 99, 103, 100, 102];
    var out = [];
    var i;
    for (i = 0; i < n; i++) {
        var c = closes[i % closes.length];
        out.push(m5(c - 1, c + 1.5, c - 1.5, c, 1000000 + i * BAR));
    }
    return out;
}

function detect(candles, opts) {
    var o = opts || {};
    return accumulationDetector.detectAccumulation({
        candles: candles,
        evaluationTime: o.evaluationTime !== undefined ? o.evaluationTime : 9999999999999,
        timeframe: '5m',
        symbol: 'BTCUSDT',
        liquidityRegistry: o.registry || null
    }, {});
}

/* ---------- 基础 ---------- */

test('横盘 24 bars → ACCUMULATION_CONFIRMED（score >= 60）', function () {
    var candles = chopCandles(24);
    var r = detect(candles);
    assert.ok(r);
    assert.strictEqual(r.state, 'ACCUMULATION_CONFIRMED');
    assert.ok(r.score >= 60);
    assert.strictEqual(r.conditionsMet, true);
    assert.ok(r.normalizedRange <= 3.0);
    assert.ok(r.efficiency <= 0.35);
    assert.ok(r.midCrossCount >= 3);
    assert.strictEqual(r.confirmedAt, candles[23].closeTime);
});

test('12 bars 下限：10 bars → null（不足）', function () {
    var candles = chopCandles(10);
    assert.strictEqual(detect(candles), null);
});

test('trending candles（单调上涨）→ 拒绝', function () {
    var candles = [];
    var i;
    for (i = 0; i < 24; i++) {
        candles.push(m5(80 + i, 84 + i, 79 + i, 82 + i, 1000000 + i * BAR));
    }
    assert.strictEqual(detect(candles), null);
});

test('宽 range（高波动）→ 拒绝（normalizedRange > 3）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 24; i++) {
        candles.push(m5(80 + i * 5, 100 + i * 5, 80 + i * 5, 95 + i * 5, 1000000 + i * BAR));
    }
    assert.strictEqual(detect(candles), null);
});

/* ---------- EQH/EQL 加分 ---------- */

test('窗口内 EQH 加分（score 更高）', function () {
    var candles = chopCandles(24);
    var reg = liquidityRegistry.createRegistry();
    reg.add({
        id: 'EQ1', symbol: 'BTCUSDT', timeframe: '5m', type: 'EQH', side: 'BSL',
        price: 101, status: 'ACTIVE', confirmedAt: 1000,
        touchedAt: null, sweptAt: null, brokenAt: null, metadata: {}
    });
    var withEq = detect(candles, { registry: reg });
    var withoutEq = detect(candles);
    assert.ok(withEq.score > withoutEq.score);
    assert.ok(withEq.liquidityInside.length >= 1);
});

/* ---------- 防未来数据 ---------- */

test('endIndex candle closeTime > evaluationTime → null（防未来）', function () {
    var candles = chopCandles(24);
    // evaluationTime 早于最后一根 closeTime
    var early = candles[23].openTime + 1000;
    assert.strictEqual(detect(candles, { evaluationTime: early }), null);
});

/* ---------- deterministic ---------- */

test('deterministic：两次调用结果一致', function () {
    var candles = chopCandles(24);
    var r1 = detect(candles);
    var r2 = detect(candles);
    assert.strictEqual(r1.startIndex, r2.startIndex);
    assert.strictEqual(r1.score, r2.score);
    assert.strictEqual(r1.state, r2.state);
});

console.log('----');
console.log('accumulationDetector: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
