/**
 * dailyLiquidity 单元测试
 *
 * 核心验证点：
 * - PDH / PDL 计算正确
 * - UTC 日边界（00:00:00.000 / 23:59:59.999）
 * - evaluationTime 位于一天中间时，绝不使用当天最终 High/Low
 * - 历史回放：混入“未来”K 线时被过滤（无未来数据）
 */
var assert = require('assert');
var utcTime = require('../utils/utcTime');
var dailyLiquidity = require('../liquidity/dailyLiquidity');

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
 * 构造一根 1d K 线
 * y/m/d 为自然日（m 从 1 开始）
 */
function dayCandle(y, m, d, high, low, options) {
    var openTime = Date.UTC(y, m - 1, d);
    var closeTime = openTime + utcTime.DAY_MS - 1;
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

/**
 * 假 fetcher：忽略参数，返回给定数组
 */
function fakeFetcher(candles) {
    return function (symbol, interval, limit, startTime, endTime) {
        return Promise.resolve(candles);
    };
}

/* ---------- buildDailyLiquidity 正确性 ---------- */

test('PDH = 日 high（BSL），PDL = 日 low（SSL），字段完整', function () {
    var candle = dayCandle(2026, 8, 16, 63359.25, 62716.0);
    var result = dailyLiquidity.buildDailyLiquidity('BTCUSDT', candle);
    assert.strictEqual(result.length, 2);

    var pdh = result[0];
    assert.strictEqual(pdh.type, 'PDH');
    assert.strictEqual(pdh.side, 'BSL');
    assert.strictEqual(pdh.price, 63359.25);
    assert.strictEqual(pdh.timeframe, '1d');
    assert.strictEqual(pdh.id, 'BTCUSDT:PDH:2026-08-16');
    assert.strictEqual(pdh.sourceOpenTime, Date.UTC(2026, 7, 16));
    assert.strictEqual(pdh.confirmedAt, candle.closeTime);
    assert.strictEqual(pdh.status, 'ACTIVE');
    assert.strictEqual(pdh.sweptAt, null);
    assert.strictEqual(pdh.brokenAt, null);
    assert.strictEqual(pdh.metadata.source, 'futures');

    var pdl = result[1];
    assert.strictEqual(pdl.type, 'PDL');
    assert.strictEqual(pdl.side, 'SSL');
    assert.strictEqual(pdl.price, 62716.0);
    assert.strictEqual(pdl.id, 'BTCUSDT:PDL:2026-08-16');
});

test('buildDailyLiquidity：null candle → []', function () {
    assert.deepStrictEqual(dailyLiquidity.buildDailyLiquidity('BTCUSDT', null), []);
});

/* ---------- 上一完整日边界 ---------- */

test('evaluationTime = 08-17 00:00:00.000 → 上一完整日 = 08-16', function () {
    var evalTime = Date.UTC(2026, 7, 17, 0, 0, 0, 0);
    assert.strictEqual(
        dailyLiquidity.previousCompleteDayStart(evalTime),
        Date.UTC(2026, 7, 16)
    );
});

test('evaluationTime = 08-16 23:59:59.999 → 上一完整日 = 08-15（16 日尚未结束）', function () {
    var evalTime = Date.UTC(2026, 7, 16, 23, 59, 59, 999);
    assert.strictEqual(
        dailyLiquidity.previousCompleteDayStart(evalTime),
        Date.UTC(2026, 7, 15)
    );
});

test('evaluationTime = 08-16 00:00:00.000 → 上一完整日 = 08-15', function () {
    var evalTime = Date.UTC(2026, 7, 16, 0, 0, 0, 0);
    assert.strictEqual(
        dailyLiquidity.previousCompleteDayStart(evalTime),
        Date.UTC(2026, 7, 15)
    );
});

test('evaluationTime = 08-17 正午 → 上一完整日 = 08-16（一天中间）', function () {
    var evalTime = Date.UTC(2026, 7, 17, 12, 34, 56, 789);
    assert.strictEqual(
        dailyLiquidity.previousCompleteDayStart(evalTime),
        Date.UTC(2026, 7, 16)
    );
});

/* ---------- 历史回放：无未来数据 ---------- */

test('回放：混入当天（未结束）K 线时被过滤，只用上一完整日', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0);
    var day16 = dayCandle(2026, 8, 16, 63359.25, 62716.0); // 上一完整日
    var day17 = dayCandle(2026, 8, 17, 64000.0, 62000.0); // 当天最终高低（不可用！）
    // 假 fetcher 故意把当天 K 线也塞进来
    var fetcher = fakeFetcher([day16, day17]);

    return dailyLiquidity
        .getDailyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            // 必须来自 08-16，绝不能用 08-17 的 64000/62000
            assert.strictEqual(result[0].type, 'PDH');
            assert.strictEqual(result[0].price, 63359.25);
            assert.strictEqual(result[0].id, 'BTCUSDT:PDH:2026-08-16');
            assert.strictEqual(result[1].type, 'PDL');
            assert.strictEqual(result[1].price, 62716.0);
        });
});

test('回放：混入未来日（08-18）K 线时被过滤', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0);
    var day16 = dayCandle(2026, 8, 16, 63359.25, 62716.0);
    var day18 = dayCandle(2026, 8, 18, 99999, 11111); // 未来数据
    var fetcher = fakeFetcher([day16, day18]);

    return dailyLiquidity
        .getDailyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].price, 63359.25);
            assert.strictEqual(result[1].price, 62716.0);
        });
});

test('回放：全部数据都在未来 → 返回空数组（不硬凑）', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0);
    var day18 = dayCandle(2026, 8, 18, 99999, 11111);
    var fetcher = fakeFetcher([day18]);

    return dailyLiquidity
        .getDailyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.deepStrictEqual(result, []);
        });
});

/* ---------- confirmedAt 语义 ---------- */

test('confirmedAt = 上一完整日 K 线 closeTime（23:59:59.999）', function () {
    var candle = dayCandle(2026, 8, 16, 63359.25, 62716.0);
    var result = dailyLiquidity.buildDailyLiquidity('BTCUSDT', candle);
    assert.strictEqual(result[0].confirmedAt, Date.UTC(2026, 7, 16, 23, 59, 59, 999));
    // confirmedAt 必须早于任何合法的 evaluationTime（08-17 00:00 起）
    assert.ok(result[0].confirmedAt <= Date.UTC(2026, 7, 17, 0, 0, 0, 0));
});

console.log('----');
console.log('dailyLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
