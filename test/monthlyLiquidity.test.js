/**
 * monthlyLiquidity 单元测试
 *
 * 核心验证点：
 * - PMH / PML 正确（UTC 自然月，上一完整月）
 * - 月边界 / 跨年
 * - 月中 evaluationTime 不可读取本月最终 High/Low
 * - 历史回放：未来 K 线混入被过滤
 * - confirmedAt = 月 K 线 closeTime；metadata.sourcePeriod
 */
var assert = require('assert');
var utcTime = require('../utils/utcTime');
var monthlyLiquidity = require('../liquidity/monthlyLiquidity');

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
 * 构造一根 1M K 线（openTime = 当月 1 号 00:00 UTC）
 */
function monthCandle(y, m, high, low, options) {
    var openTime = Date.UTC(y, m - 1, 1);
    // 次月 1 号前 1ms 为月末 closeTime
    var nextMonth = Date.UTC(y, m, 1);
    var closeTime = nextMonth - 1;
    return {
        openTime: openTime,
        open: low,
        high: high,
        low: low,
        close: high,
        volume: 0,
        closeTime:
            options && options.closeTime !== undefined
                ? options.closeTime
                : closeTime,
        closed: options && options.closed !== undefined ? options.closed : true,
        source: options && options.source ? options.source : 'futures'
    };
}

function fakeFetcher(candles) {
    return function (symbol, interval, limit, startTime, endTime) {
        return Promise.resolve(candles);
    };
}

/* ---------- buildMonthlyLiquidity 正确性 ---------- */

test('PMH = 月 high（BSL），PML = 月 low（SSL），字段完整', function () {
    var candle = monthCandle(2026, 7, 68000, 61000); // 2026-07
    var result = monthlyLiquidity.buildMonthlyLiquidity('BTCUSDT', candle);
    assert.strictEqual(result.length, 2);

    var pmh = result[0];
    assert.strictEqual(pmh.type, 'PMH');
    assert.strictEqual(pmh.side, 'BSL');
    assert.strictEqual(pmh.price, 68000);
    assert.strictEqual(pmh.timeframe, '1M');
    assert.strictEqual(pmh.id, 'BTCUSDT:PMH:2026-07');
    assert.strictEqual(pmh.confirmedAt, candle.closeTime);
    assert.strictEqual(pmh.status, 'ACTIVE');
    assert.strictEqual(pmh.metadata.sourcePeriod, '2026-07');
    assert.strictEqual(pmh.metadata.source, 'futures');

    var pml = result[1];
    assert.strictEqual(pml.type, 'PML');
    assert.strictEqual(pml.side, 'SSL');
    assert.strictEqual(pml.price, 61000);
    assert.strictEqual(pml.id, 'BTCUSDT:PML:2026-07');
});

test('buildMonthlyLiquidity：null candle → []', function () {
    assert.deepStrictEqual(monthlyLiquidity.buildMonthlyLiquidity('BTCUSDT', null), []);
});

/* ---------- 月边界 ---------- */

test('evaluationTime = 08-17 → 上一完整月 = 2026-07-01', function () {
    assert.strictEqual(
        monthlyLiquidity.previousCompleteMonthStart(Date.UTC(2026, 7, 17, 10, 0)),
        Date.UTC(2026, 6, 1)
    );
});

test('evaluationTime = 01-15 → 上一完整月跨年 = 2025-12-01', function () {
    assert.strictEqual(
        monthlyLiquidity.previousCompleteMonthStart(Date.UTC(2026, 0, 15, 10, 0)),
        Date.UTC(2025, 11, 1)
    );
});

test('evaluationTime = 08-01 00:00:00.000 → 上一完整月 = 2026-07-01（8 月刚开始时 7 月已完整）', function () {
    assert.strictEqual(
        monthlyLiquidity.previousCompleteMonthStart(Date.UTC(2026, 7, 1, 0, 0, 0, 0)),
        Date.UTC(2026, 6, 1)
    );
});

/* ---------- 历史回放：无未来数据 ---------- */

test('回放：混入当月（未结束）K 线时被过滤，只用上一完整月', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0);
    var jul = monthCandle(2026, 7, 68000, 61000); // 上一完整月
    var aug = monthCandle(2026, 8, 70000, 60000); // 当月最终高低（不可用！）
    var fetcher = fakeFetcher([jul, aug]);

    return monthlyLiquidity
        .getMonthlyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].price, 68000); // 来自 7 月
            assert.strictEqual(result[0].id, 'BTCUSDT:PMH:2026-07');
            assert.strictEqual(result[1].price, 61000);
        });
});

test('回放：月中 evaluationTime 时，当月 K 线 closeTime 未到 → 被过滤', function () {
    var evalTime = Date.UTC(2026, 8, 10, 12, 0, 0); // 9 月 10 日
    var aug = monthCandle(2026, 8, 66000, 62000); // 8 月（完整）
    var sep = monthCandle(2026, 9, 70000, 61000); // 9 月（进行中，closeTime 未到）
    var fetcher = fakeFetcher([aug, sep]);

    return monthlyLiquidity
        .getMonthlyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].price, 66000); // 只用 8 月
            assert.strictEqual(result[1].price, 62000);
        });
});

test('回放：全部数据都在未来 → 返回空数组', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0);
    var aug = monthCandle(2026, 8, 70000, 60000);
    var fetcher = fakeFetcher([aug]);

    return monthlyLiquidity
        .getMonthlyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.deepStrictEqual(result, []);
        });
});

/* ---------- confirmedAt 语义 ---------- */

test('confirmedAt = 上一完整月 K 线 closeTime（月末 23:59:59.999）', function () {
    var candle = monthCandle(2026, 7, 68000, 61000);
    var result = monthlyLiquidity.buildMonthlyLiquidity('BTCUSDT', candle);
    // 7 月末 = 8 月 1 号前 1ms
    assert.strictEqual(result[0].confirmedAt, Date.UTC(2026, 7, 1) - 1);
    assert.ok(result[0].confirmedAt <= Date.UTC(2026, 7, 1, 0, 0, 0, 0));
});

console.log('----');
console.log('monthlyLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
