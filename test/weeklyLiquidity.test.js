/**
 * weeklyLiquidity 单元测试
 *
 * 核心验证点：
 * - PWH / PWL 计算正确（周定义：Monday 00:00 UTC → next Monday 00:00 UTC）
 * - UTC 周边界
 * - evaluationTime 位于一周中间时，绝不使用本周最终 High/Low
 * - 历史回放：混入“未来”K 线时被过滤（无未来数据）
 */
var assert = require('assert');
var utcTime = require('../utils/utcTime');
var weeklyLiquidity = require('../liquidity/weeklyLiquidity');

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
 * 构造一根 1w K 线（openTime = 周一 00:00 UTC）
 * y/m/d 为周一日期
 */
function weekCandle(y, m, d, high, low, options) {
    var openTime = Date.UTC(y, m - 1, d); // Monday 00:00 UTC
    var closeTime = openTime + utcTime.WEEK_MS - 1; // Sunday 23:59:59.999
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

/* ---------- buildWeeklyLiquidity 正确性 ---------- */

test('PWH = 周 high（BSL），PWL = 周 low（SSL），id 用周一日期', function () {
    var candle = weekCandle(2026, 8, 10, 64100.0, 62000.0); // 周一 08-10
    var result = weeklyLiquidity.buildWeeklyLiquidity('BTCUSDT', candle);
    assert.strictEqual(result.length, 2);

    var pwh = result[0];
    assert.strictEqual(pwh.type, 'PWH');
    assert.strictEqual(pwh.side, 'BSL');
    assert.strictEqual(pwh.price, 64100.0);
    assert.strictEqual(pwh.timeframe, '1w');
    assert.strictEqual(pwh.id, 'BTCUSDT:PWH:2026-08-10');
    assert.strictEqual(pwh.confirmedAt, candle.closeTime);
    assert.strictEqual(pwh.status, 'ACTIVE');

    var pwl = result[1];
    assert.strictEqual(pwl.type, 'PWL');
    assert.strictEqual(pwl.side, 'SSL');
    assert.strictEqual(pwl.price, 62000.0);
    assert.strictEqual(pwl.id, 'BTCUSDT:PWL:2026-08-10');
});

test('buildWeeklyLiquidity：null candle → []', function () {
    assert.deepStrictEqual(weeklyLiquidity.buildWeeklyLiquidity('BTCUSDT', null), []);
});

/* ---------- 上一完整周边界 ---------- */

test('evaluationTime = 08-17（周一）00:00:00.000 → 上一完整周 = 08-10 起', function () {
    var evalTime = Date.UTC(2026, 7, 17, 0, 0, 0, 0);
    assert.strictEqual(
        weeklyLiquidity.previousCompleteWeekStart(evalTime),
        Date.UTC(2026, 7, 10)
    );
});

test('evaluationTime = 08-16（周日）23:59:59.999 → 上一完整周 = 08-03 起（本周未结束）', function () {
    var evalTime = Date.UTC(2026, 7, 16, 23, 59, 59, 999);
    assert.strictEqual(
        weeklyLiquidity.previousCompleteWeekStart(evalTime),
        Date.UTC(2026, 7, 3)
    );
});

test('evaluationTime = 08-12（周三）正午 → 上一完整周 = 08-03 起（一周中间）', function () {
    var evalTime = Date.UTC(2026, 7, 12, 12, 0, 0);
    assert.strictEqual(
        weeklyLiquidity.previousCompleteWeekStart(evalTime),
        Date.UTC(2026, 7, 3)
    );
});

test('evaluationTime = 08-17（周一）正午 → 上一完整周 = 08-10 起（上周已完整结束）', function () {
    var evalTime = Date.UTC(2026, 7, 17, 12, 0, 0);
    assert.strictEqual(
        weeklyLiquidity.previousCompleteWeekStart(evalTime),
        Date.UTC(2026, 7, 10)
    );
});

/* ---------- 历史回放：无未来数据 ---------- */

test('回放：混入本周（未结束）K 线时被过滤，只用上一完整周', function () {
    var evalTime = Date.UTC(2026, 7, 17, 10, 0, 0); // 周一
    var weekAug10 = weekCandle(2026, 8, 10, 64100.0, 62000.0); // 上一完整周
    var weekAug17 = weekCandle(2026, 8, 17, 70000.0, 59000.0); // 本周最终高低（不可用！）
    var fetcher = fakeFetcher([weekAug10, weekAug17]);

    return weeklyLiquidity
        .getWeeklyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            // 必须来自 08-10 那周，绝不能用本周的 70000/59000
            assert.strictEqual(result[0].type, 'PWH');
            assert.strictEqual(result[0].price, 64100.0);
            assert.strictEqual(result[0].id, 'BTCUSDT:PWH:2026-08-10');
            assert.strictEqual(result[1].type, 'PWL');
            assert.strictEqual(result[1].price, 62000.0);
        });
});

test('回放：evaluationTime = 周三，本周数据一律不可用', function () {
    var evalTime = Date.UTC(2026, 7, 12, 12, 0, 0); // 周三
    var weekAug03 = weekCandle(2026, 8, 3, 61000.0, 59000.0); // 上一完整周
    var weekAug10 = weekCandle(2026, 8, 10, 64100.0, 62000.0); // 本周（未结束）
    var fetcher = fakeFetcher([weekAug03, weekAug10]);

    return weeklyLiquidity
        .getWeeklyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].price, 61000.0);
            assert.strictEqual(result[1].price, 59000.0);
        });
});

test('回放：全部数据都在未来 → 返回空数组', function () {
    var evalTime = Date.UTC(2026, 7, 12, 12, 0, 0);
    var weekAug10 = weekCandle(2026, 8, 10, 64100.0, 62000.0);
    var fetcher = fakeFetcher([weekAug10]);

    return weeklyLiquidity
        .getWeeklyLiquidity('BTCUSDT', evalTime, { fetcher: fetcher })
        .then(function (result) {
            assert.deepStrictEqual(result, []);
        });
});

/* ---------- confirmedAt 语义 ---------- */

test('confirmedAt = 上一完整周 K 线 closeTime（周日 23:59:59.999）', function () {
    var candle = weekCandle(2026, 8, 10, 64100.0, 62000.0);
    var result = weeklyLiquidity.buildWeeklyLiquidity('BTCUSDT', candle);
    assert.strictEqual(result[0].confirmedAt, Date.UTC(2026, 7, 16, 23, 59, 59, 999));
    // confirmedAt 必须早于下一个合法 evaluationTime（08-17 00:00 起）
    assert.ok(result[0].confirmedAt <= Date.UTC(2026, 7, 17, 0, 0, 0, 0));
});

console.log('----');
console.log('weeklyLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
