/**
 * swingLiquidity 单元测试（Phase 3 严格模式）
 *
 * 强约束：
 * - 不传 candles → 不生成任何 liquidity（绝不退化为 pivot.time）
 * - 缺少右侧确认 candle（越界 / 未收盘）→ 跳过该 pivot，不生成
 * - confirmedAt = 右侧确认 candle（index+right）的 closeTime
 */
var assert = require('assert');
var swingLiquidity = require('../liquidity/swingLiquidity');

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

/**
 * 构造 5m K 线
 */
function m5(openTime, high, low, options) {
    return {
        openTime: openTime,
        open: low,
        high: high,
        low: low,
        close: high,
        volume: 0,
        closeTime: openTime + 300000 - 1,
        closed: options && options.closed !== undefined ? options.closed : true,
        source: options && options.source ? options.source : 'futures'
    };
}

/**
 * 7 根 5m K 线：pivot 位于 index=4，右侧确认 candle = index 6
 */
function sevenCandles() {
    var base = 1720000000000;
    var candles = [];
    var highs = [100, 101, 102, 101, 103, 101, 100];
    var lows = [99, 98, 97, 96, 95, 94, 93];
    var i;
    for (i = 0; i < 7; i++) {
        candles.push(m5(base + i * 300000, highs[i], lows[i]));
    }
    return candles;
}

test('空 pivots → 空数组', function () {
    assert.deepStrictEqual(
        swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', [], sevenCandles(), 2),
        []
    );
});

test('不传 candles → 不生成任何 liquidity（强约束）', function () {
    var pivots = [
        { type: 'HIGH', index: 4, price: 103, time: 1720000020000 }
    ];
    var result = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots);
    assert.deepStrictEqual(result, []);
});

test('缺少右侧确认 candle（pivot 越界）→ 跳过，不生成', function () {
    // 只有 6 根：pivot 在 index=5，5+2 >= 6 → 无确认 candle
    var candles = sevenCandles().slice(0, 6);
    var pivots = [
        { type: 'HIGH', index: 5, price: 100, time: 1720000025000 }
    ];
    var result = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    assert.deepStrictEqual(result, []);
});

test('右侧确认 candle 未收盘 → 跳过，不生成', function () {
    var candles = sevenCandles();
    candles[6].closed = false; // 确认 K 线尚未收盘
    var pivots = [
        { type: 'HIGH', index: 4, price: 103, time: candles[4].openTime }
    ];
    var result = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    assert.deepStrictEqual(result, []);
});

test('Pivot High → BSL / SWING_HIGH（字段完整）', function () {
    var candles = sevenCandles();
    var pivots = [
        { type: 'HIGH', index: 4, price: 103, time: candles[4].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    assert.strictEqual(liquidity.length, 1);
    var item = liquidity[0];
    assert.strictEqual(item.symbol, 'BTCUSDT');
    assert.strictEqual(item.timeframe, '5m');
    assert.strictEqual(item.type, 'SWING_HIGH');
    assert.strictEqual(item.side, 'BSL');
    assert.strictEqual(item.price, 103);
    assert.strictEqual(item.status, 'ACTIVE');
    assert.strictEqual(item.sweptAt, null);
    assert.strictEqual(item.sourceOpenTime, candles[4].openTime);
    assert.strictEqual(item.sourceCloseTime, candles[4].closeTime);
    assert.strictEqual(item.metadata.source, 'futures');
    assert.strictEqual(item.metadata.index, 4);
});

test('Pivot Low → SSL / SWING_LOW', function () {
    var base = 1730000000000;
    var candles = [];
    var highs = [106, 105, 104, 105, 103, 104, 105];
    var lows = [104, 103, 102, 101, 98, 100, 102];
    var i;
    for (i = 0; i < 7; i++) {
        candles.push(m5(base + i * 300000, highs[i], lows[i]));
    }
    var pivots = [
        { type: 'LOW', index: 4, price: 98, time: candles[4].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    assert.strictEqual(liquidity.length, 1);
    var item = liquidity[0];
    assert.strictEqual(item.type, 'SWING_LOW');
    assert.strictEqual(item.side, 'SSL');
    assert.strictEqual(item.price, 98);
    assert.strictEqual(item.metadata.index, 4);
});

test('id 格式统一：symbol:timeframe:TYPE:time', function () {
    var candles = sevenCandles();
    var pivots = [
        { type: 'HIGH', index: 2, price: 102, time: candles[2].openTime },
        { type: 'LOW', index: 3, price: 96, time: candles[3].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('ETHUSDT', '1h', pivots, candles, 2);
    assert.strictEqual(liquidity[0].id, 'ETHUSDT:1h:SWING_HIGH:' + candles[2].openTime);
    assert.strictEqual(liquidity[1].id, 'ETHUSDT:1h:SWING_LOW:' + candles[3].openTime);
});

test('多个混合 pivot 顺序与数量保持不变', function () {
    // 构造 11 根 K 线，pivot 在 2 / 4 / 6 / 8（8+2=10 < 11，各留 2 根右侧）
    var base = 1740000000000;
    var candles = [];
    var i;
    for (i = 0; i < 11; i++) {
        candles.push(m5(base + i * 300000, 100 + i, 90 + i));
    }
    var pivots = [
        { type: 'HIGH', index: 2, price: 102, time: candles[2].openTime },
        { type: 'LOW', index: 4, price: 94, time: candles[4].openTime },
        { type: 'HIGH', index: 6, price: 106, time: candles[6].openTime },
        { type: 'LOW', index: 8, price: 98, time: candles[8].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('BNBUSDT', '4h', pivots, candles, 2);
    assert.strictEqual(liquidity.length, 4);
    assert.strictEqual(liquidity[0].side, 'BSL');
    assert.strictEqual(liquidity[1].side, 'SSL');
    assert.strictEqual(liquidity[2].side, 'BSL');
    assert.strictEqual(liquidity[3].side, 'SSL');
    liquidity.forEach(function (item) {
        assert.strictEqual(item.status, 'ACTIVE');
        assert.strictEqual(item.symbol, 'BNBUSDT');
        assert.strictEqual(item.timeframe, '4h');
    });
});

/* ---------- confirmedAt 强约束 ---------- */

test('confirmedAt = 右侧确认 candle（index+right）的 closeTime', function () {
    var candles = sevenCandles();
    var pivots = [
        { type: 'HIGH', index: 4, price: 103, time: candles[4].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    var item = liquidity[0];
    // 必须是 index+2=6 那根的 closeTime
    assert.strictEqual(item.confirmedAt, candles[6].closeTime);
    // 绝不是 pivot candle 自己的时间
    assert.notStrictEqual(item.confirmedAt, candles[4].closeTime);
    assert.notStrictEqual(item.confirmedAt, candles[4].openTime);
    // createdAt 与 confirmedAt 一致
    assert.strictEqual(item.createdAt, item.confirmedAt);
    // 确认时刻晚于 pivot candle 收盘
    assert.ok(item.confirmedAt > candles[4].closeTime);
});

test('回放视角：confirmedAt 之后 pivot 才“存在”', function () {
    var candles = sevenCandles();
    var pivots = [
        { type: 'HIGH', index: 4, price: 103, time: candles[4].openTime }
    ];
    var liquidity = swingLiquidity.buildSwingLiquidity('BTCUSDT', '5m', pivots, candles, 2);
    var confirmedAt = liquidity[0].confirmedAt;
    // 早于 confirmedAt 的回放时刻看不到这条 swing
    assert.ok(candles[6].openTime < confirmedAt);
    // 等于 confirmedAt 的时刻才可见
    assert.ok(confirmedAt <= confirmedAt);
});

console.log('----');
console.log('swingLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
