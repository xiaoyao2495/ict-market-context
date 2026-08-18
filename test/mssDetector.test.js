/**
 * mssDetector 单元测试
 *
 * - close break confirmed swing（wick only 不算）
 * - directional body + bodyRatio threshold
 * - reference confirmedAt <= candle.closeTime（防未来）
 * - 同 swing 不重复（consumed tracking）
 */
var assert = require('assert');
var mssDetector = require('../events/mssDetector');

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

function swing(type, id, price, confirmedAt) {
    return {
        id: id,
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: type,
        side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: price,
        confirmedAt: confirmedAt,
        status: 'ACTIVE',
        metadata: {}
    };
}

function m5(open, high, low, close, openTime) {
    return {
        openTime: openTime,
        open: open,
        high: high,
        low: low,
        close: close,
        closeTime: openTime + 300000 - 1,
        closed: true,
        source: 'futures'
    };
}

var OPTS = { symbol: 'BTCUSDT', timeframe: '5m' };

/* ---------- bullish ---------- */

test('bullish MSS：close 突破已确认 Swing High', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    var candles = [
        m5(62900, 62950, 62800, 62940, 2000000),
        m5(62950, 63050, 62940, 63040, 2000000 + 300000) // close 63040 > 63000
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 1);
    assert.strictEqual(mss[0].direction, 'BULLISH');
    assert.strictEqual(mss[0].type, 'MSS');
    assert.strictEqual(mss[0].confirmedAt, 2000000 + 300000 + 300000 - 1); // break candle closeTime
    assert.strictEqual(mss[0].metadata.bodyRatio >= 0.5, true);
});

test('bearish MSS：close 跌破已确认 Swing Low', function () {
    var swings = [swing('SWING_LOW', 'L1', 62000, 1000)];
    var candles = [
        m5(62100, 62200, 62050, 62100, 2000000),
        m5(62100, 62150, 61900, 61950, 2000000 + 300000) // close 61950 < 62000
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 1);
    assert.strictEqual(mss[0].direction, 'BEARISH');
});

/* ---------- wick only 不算 ---------- */

test('wick only（high 触及但 close 未收上）不产生 bullish MSS', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    var candles = [
        m5(62900, 63050, 62850, 62900, 2000000), // high 63050 > 63000 但 close 62900 < 63000
        m5(62900, 62950, 62800, 62920, 2000000 + 300000)
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 0);
});

/* ---------- quality ---------- */

test('requireDirectionalBody：bearish break candle 不能产生 bullish MSS', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    var candles = [
        m5(63050, 63100, 63020, 63040, 2000000) // close > 63000 但 close < open（bearish candle）
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 0);
});

test('bodyRatio 不足（小实体）不产生 MSS', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    // body 3 / range 100 = 0.03 < 0.5
    var candles = [
        m5(62998, 63098, 62998, 63001, 2000000)
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 0);
});

test('minBreakPct：tick 级突破不算', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    // breakDistance = 63000.01 - 63000 = 0.01 < 63000*0.0001 = 6.3
    var candles = [
        m5(62990, 63000.01, 62990, 63000.005, 2000000)
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 0);
});

/* ---------- 防未来数据 ---------- */

test('reference swing confirmedAt > candle.closeTime → 不参与', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 9999999999999)]; // 未来确认
    var candles = [
        m5(62900, 63100, 62800, 63040, 2000000) // close 63040 > 63000
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 0);
});

/* ---------- 同 swing 不重复 ---------- */

test('同 reference 只产生一次 MSS（连续突破不重复）', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    var candles = [
        m5(62950, 63050, 62940, 63040, 2000000), // 第一次突破
        m5(63040, 63200, 63030, 63150, 2000000 + 300000), // 继续上涨，不重复
        m5(63150, 63300, 63100, 63250, 2000000 + 600000)
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 1);
});

test('最近 reference 优先：突破旧低点不算 MSS，突破最近高点才算', function () {
    var swings = [
        swing('SWING_HIGH', 'H1', 63000, 1000), // 旧高点
        swing('SWING_HIGH', 'H2', 63200, 2000) // 最近高点
    ];
    var candles = [
        m5(62950, 63050, 62940, 63040, 2000000), // close 63040 只破 H1（旧点，不是最近）→ 不算
        m5(63040, 63300, 63030, 63250, 2000000 + 300000) // close 63250 破 H2（最近）→ 算
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    assert.strictEqual(mss.length, 1);
    assert.strictEqual(mss[0].source.referenceSwingId, 'H2');
});

test('MSS 事件字段完整（统一格式）', function () {
    var swings = [swing('SWING_HIGH', 'H1', 63000, 1000)];
    var candles = [
        m5(62950, 63050, 62940, 63040, 2000000)
    ];
    var mss = mssDetector.detectMss(candles, swings, OPTS);
    var ev = mss[0];
    assert.ok(ev.id.indexOf('BTCUSDT:5m:MSS:BULLISH:') === 0);
    assert.strictEqual(ev.symbol, 'BTCUSDT');
    assert.strictEqual(ev.timeframe, '5m');
    assert.strictEqual(ev.occurredAt, 2000000);
    assert.strictEqual(ev.confirmedAt, 2000000 + 300000 - 1);
    assert.strictEqual(ev.price, 63000);
    assert.strictEqual(ev.source.referenceSwingId, 'H1');
    assert.ok(ev.source.breakDistance > 0);
    assert.ok(typeof ev.metadata.bodyRatio === 'number');
    assert.ok(typeof ev.metadata.closeStrength === 'number');
});

console.log('----');
console.log('mssDetector: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
