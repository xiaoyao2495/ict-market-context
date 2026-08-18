/**
 * sessionLiquidity 单元测试
 *
 * 核心验证点：
 * - ASIA / LONDON / NEW_YORK High/Low 正确
 * - session 中间 evaluationTime → 使用上一个完整 session，不提前知道当天最终 H/L
 * - session 完整结束才确认
 * - confirmedAt = 最后一根属于 session 的已收盘 K 线 closeTime
 * - 跨 UTC 日边界 session 配置支持
 * - 未来 candle 混入仍被过滤
 */
var assert = require('assert');
var utcTime = require('../utils/utcTime');
var sessionLiquidity = require('../liquidity/sessionLiquidity');
var sessions = require('../config/sessions');

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

function m5(openTime, high, low) {
    return {
        openTime: openTime,
        open: low,
        high: high,
        low: low,
        close: high,
        volume: 0,
        closeTime: openTime + 300000 - 1,
        closed: true,
        source: 'futures'
    };
}

/**
 * 生成 session 时段内逐根 5m K 线（openTime 从 start 到 end-5min）
 */
function sessionCandles(startMs, endMs, high, low) {
    var out = [];
    var t = startMs;
    while (t < endMs) {
        out.push(m5(t, high, low));
        t += 300000;
    }
    return out;
}

var ASIA = sessions.ASIA;
var LONDON = sessions.LONDON;
var NY = sessions.NEW_YORK;

/* ---------- 时间窗口 ---------- */

test('sessionStartMs / sessionEndMs：ASIA = 00:00 - 05:00 UTC', function () {
    var day = Date.UTC(2026, 7, 17);
    assert.strictEqual(sessionLiquidity.sessionStartMs(ASIA, day), day);
    assert.strictEqual(sessionLiquidity.sessionEndMs(ASIA, day), day + 5 * 3600000);
});

test('sessionEndMs：跨 UTC 日边界配置自动顺延一天', function () {
    var day = Date.UTC(2026, 7, 17);
    var overnight = { startHourUtc: 22, startMinuteUtc: 0, endHourUtc: 2, endMinuteUtc: 0 };
    assert.strictEqual(sessionLiquidity.sessionEndMs(overnight, day), day + 26 * 3600000);
});

test('findPreviousSessionDateStart：session 未结束时用昨天', function () {
    // ASIA 00:00-05:00，evaluationTime = 03:00 → ASIA 未结束 → 用昨天
    var evalTime = Date.UTC(2026, 7, 17, 3, 0, 0);
    assert.strictEqual(
        sessionLiquidity.findPreviousSessionDateStart(ASIA, evalTime),
        Date.UTC(2026, 7, 16)
    );
});

test('findPreviousSessionDateStart：session 已完整结束时用今天', function () {
    // ASIA 00:00-05:00，evaluationTime = 06:00 → ASIA 已结束 → 用今天
    var evalTime = Date.UTC(2026, 7, 17, 6, 0, 0);
    assert.strictEqual(
        sessionLiquidity.findPreviousSessionDateStart(ASIA, evalTime),
        Date.UTC(2026, 7, 17)
    );
});

/* ---------- buildSessionLiquidity ---------- */

test('ASIA High/Low 正确（完整结束后）', function () {
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(ASIA, day);
    var end = sessionLiquidity.sessionEndMs(ASIA, day);
    var candles = sessionCandles(start, end, 63400, 62800);
    var evalTime = end + 3600000; // session 结束后 1 小时

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'ASIA', ASIA, day, candles, evalTime
    );
    assert.strictEqual(result.length, 2);
    var high = result[0];
    assert.strictEqual(high.type, 'ASIA_HIGH');
    assert.strictEqual(high.side, 'BSL');
    assert.strictEqual(high.price, 63400);
    assert.strictEqual(high.id, 'BTCUSDT:ASIA_HIGH:2026-08-17');
    assert.strictEqual(high.metadata.session, 'ASIA');
    assert.strictEqual(high.metadata.sessionDate, '2026-08-17');
    assert.strictEqual(high.metadata.sessionStart, start);
    assert.strictEqual(high.metadata.sessionEnd, end);
    // confirmedAt = 最后一根 session K 线的 closeTime
    assert.strictEqual(high.confirmedAt, end - 300000 + 300000 - 1);
    // 等于最后一根（04:55 开盘）的 closeTime = 05:00 - 1ms
    assert.strictEqual(high.confirmedAt, end - 1);

    var low = result[1];
    assert.strictEqual(low.type, 'ASIA_LOW');
    assert.strictEqual(low.side, 'SSL');
    assert.strictEqual(low.price, 62800);
});

test('LONDON High/Low 正确', function () {
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(LONDON, day);
    var end = sessionLiquidity.sessionEndMs(LONDON, day);
    var candles = sessionCandles(start, end, 63600, 63100);
    var evalTime = end + 3600000;

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'LONDON', LONDON, day, candles, evalTime
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].type, 'LONDON_HIGH');
    assert.strictEqual(result[0].price, 63600);
    assert.strictEqual(result[1].type, 'LONDON_LOW');
    assert.strictEqual(result[1].price, 63100);
});

test('NEW_YORK High/Low 正确', function () {
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(NY, day);
    var end = sessionLiquidity.sessionEndMs(NY, day);
    var candles = sessionCandles(start, end, 63700, 63200);
    var evalTime = end + 3600000;

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'NEW_YORK', NY, day, candles, evalTime
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].type, 'NEW_YORK_HIGH');
    assert.strictEqual(result[0].price, 63700);
    assert.strictEqual(result[1].type, 'NEW_YORK_LOW');
    assert.strictEqual(result[1].price, 63200);
});

/* ---------- 未来数据防线 ---------- */

test('session 中间（未结束）→ 不生成，绝不提前知道最终 H/L', function () {
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(ASIA, day);
    var end = sessionLiquidity.sessionEndMs(ASIA, day);
    var candles = sessionCandles(start, end, 63400, 62800);
    var evalTime = start + 3 * 3600000; // 03:00，session 还在进行

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'ASIA', ASIA, day, candles, evalTime
    );
    assert.deepStrictEqual(result, []);
});

test('未来 candle 混入（closeTime > evaluationTime）仍被过滤', function () {
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(ASIA, day);
    var end = sessionLiquidity.sessionEndMs(ASIA, day);
    var candles = sessionCandles(start, end, 63400, 62800);
    // 混入一根“未来”K 线（closeTime 在未来）
    candles.push(m5(end, 99999, 11111));
    var evalTime = end + 3600000;

    return sessionLiquidity
        .getSessionLiquidity('BTCUSDT', 'ASIA', evalTime, { candles: candles })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].price, 63400); // 未来价格 99999 未污染
            assert.strictEqual(result[1].price, 62800);
        });
});

test('session 时段数据缺失 → 不生成（不硬凑）', function () {
    var day = Date.UTC(2026, 7, 17);
    var evalTime = day + 20 * 3600000; // 20:00
    var candles = [m5(day + 18 * 3600000, 63000, 62000)]; // 没有 LONDON 时段的 K 线

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'LONDON', LONDON, day, candles, evalTime
    );
    assert.deepStrictEqual(result, []);
});

/* ---------- getSessionLiquidity 集成 ---------- */

test('getSessionLiquidity：evaluationTime 在 session 中间 → 使用上一完整日期', function () {
    // 2026-08-17 03:00：ASIA 未结束 → 用 08-16 的 ASIA
    var evalTime = Date.UTC(2026, 7, 17, 3, 0, 0);
    var prevDay = Date.UTC(2026, 7, 16);
    var start = sessionLiquidity.sessionStartMs(ASIA, prevDay);
    var end = sessionLiquidity.sessionEndMs(ASIA, prevDay);
    // 08-16 的 ASIA 时段数据
    var candles = sessionCandles(start, end, 63100, 62500);

    return sessionLiquidity
        .getSessionLiquidity('BTCUSDT', 'ASIA', evalTime, { candles: candles })
        .then(function (result) {
            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].id, 'BTCUSDT:ASIA_HIGH:2026-08-16');
            assert.strictEqual(result[0].price, 63100);
            assert.strictEqual(result[0].confirmedAt, end - 1);
            assert.ok(result[0].confirmedAt <= evalTime); // 未来数据防线
        });
});

test('跨 UTC 日边界 session 配置：完整结束后生成', function () {
    var overnight = { startHourUtc: 22, startMinuteUtc: 0, endHourUtc: 2, endMinuteUtc: 0 };
    var day = Date.UTC(2026, 7, 17);
    var start = sessionLiquidity.sessionStartMs(overnight, day); // 22:00
    var end = sessionLiquidity.sessionEndMs(overnight, day); // 次日 02:00
    var candles = sessionCandles(start, end, 63800, 63300);
    var evalTime = end + 3600000; // 03:00，session 已完整结束

    var result = sessionLiquidity.buildSessionLiquidity(
        'BTCUSDT', 'OVERNIGHT', overnight, day, candles, evalTime
    );
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].type, 'OVERNIGHT_HIGH');
    assert.strictEqual(result[0].price, 63800);
    assert.strictEqual(result[0].confirmedAt, end - 1);
});

console.log('----');
console.log('sessionLiquidity: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
