/**
 * Session Liquidity：ASIA / LONDON / NEW_YORK High / Low
 *
 * 规则：
 * - Session 定义集中放在 config/sessions.js（全部 UTC，未来 DST / Kill Zone 只改配置）
 * - ASIA_HIGH / LONDON_HIGH / NEW_YORK_HIGH → BSL
 * - ASIA_LOW / LONDON_LOW / NEW_YORK_LOW → SSL
 * - 只有 Session【完整结束】后才允许生成（与 PDH 的未来数据问题完全一致）
 * - evaluationTime 位于 Session 中间 → 使用上一个完整结束的 Session 日期
 * - confirmedAt = 该 Session 时段内【最后一根已收盘 K 线】的 closeTime
 * - 未来 candle 混入一律被 closeTime <= evaluationTime 过滤
 * - 支持跨 UTC 日边界的 Session 定义（end <= start 时自动顺延一天）
 */
var utcTime = require('../utils/utcTime');
var sessions = require('../config/sessions');
var binanceRest = require('../data/binanceRest');

var TYPE_MAP = {
    ASIA: { high: 'ASIA_HIGH', low: 'ASIA_LOW' },
    LONDON: { high: 'LONDON_HIGH', low: 'LONDON_LOW' },
    NEW_YORK: { high: 'NEW_YORK_HIGH', low: 'NEW_YORK_LOW' }
};

/**
 * Session 起始时间（给定 UTC 日 00:00）
 */
function sessionStartMs(session, dateStartMs) {
    return (
        dateStartMs +
        (session.startHourUtc * 3600 + session.startMinuteUtc * 60) * 1000
    );
}

/**
 * Session 结束时间；end <= start 视为跨 UTC 日边界，自动顺延一天
 */
function sessionEndMs(session, dateStartMs) {
    var start = sessionStartMs(session, dateStartMs);
    var end =
        dateStartMs +
        (session.endHourUtc * 3600 + session.endMinuteUtc * 60) * 1000;
    if (end <= start) {
        end += utcTime.DAY_MS;
    }
    return end;
}

/**
 * 最近一个【已完整结束】的 Session 所在 UTC 日的 00:00
 * 今天 session 未结束 → 用昨天（绝不提前知道当天最终 H/L）
 */
function findPreviousSessionDateStart(session, evaluationTime) {
    var today = utcTime.startOfDayUTC(evaluationTime);
    if (sessionEndMs(session, today) <= evaluationTime) {
        return today;
    }
    return today - utcTime.DAY_MS;
}

/**
 * 纯函数：由属于该 Session 时段的已收盘 K 线构建 [SESSION_HIGH, SESSION_LOW]
 * @returns {Array} [HIGH, LOW]；数据缺失 / session 未结束 / 无未来数据时不生成
 */
function buildSessionLiquidity(symbol, sessionName, session, dateStartMs, candles, evaluationTime) {
    var start = sessionStartMs(session, dateStartMs);
    var end = sessionEndMs(session, dateStartMs);

    // session 必须完整结束
    if (end > evaluationTime) {
        return [];
    }

    // 未来数据防线：只取 session 时段内、已收盘、closeTime <= evaluationTime 的 K 线
    var sessionCandles = (candles || []).filter(function (c) {
        return (
            c.closed &&
            c.openTime >= start &&
            c.openTime < end &&
            c.closeTime <= evaluationTime
        );
    });
    if (sessionCandles.length === 0) {
        return []; // 数据缺失 → 无法确认
    }

    var high = -Infinity;
    var low = Infinity;
    var confirmedAt = 0;
    sessionCandles.forEach(function (c) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
        if (c.closeTime > confirmedAt) confirmedAt = c.closeTime; // 最后一根已收盘 K 线
    });

    var dateLabel = utcTime.formatDateUTC(dateStartMs);
    var types = TYPE_MAP[sessionName] || { high: sessionName + '_HIGH', low: sessionName + '_LOW' };
    var source = sessionCandles[0].source || 'futures';

    return [
        {
            id: symbol + ':' + types.high + ':' + dateLabel,
            symbol: symbol,
            timeframe: '5m',
            type: types.high,
            side: 'BSL',
            price: high,
            sourceOpenTime: start,
            sourceCloseTime: end,
            createdAt: confirmedAt,
            confirmedAt: confirmedAt,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: {
                session: sessionName,
                sessionDate: dateLabel,
                sessionStart: start,
                sessionEnd: end,
                source: source
            }
        },
        {
            id: symbol + ':' + types.low + ':' + dateLabel,
            symbol: symbol,
            timeframe: '5m',
            type: types.low,
            side: 'SSL',
            price: low,
            sourceOpenTime: start,
            sourceCloseTime: end,
            createdAt: confirmedAt,
            confirmedAt: confirmedAt,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: {
                session: sessionName,
                sessionDate: dateLabel,
                sessionStart: start,
                sessionEnd: end,
                source: source
            }
        }
    ];
}

/**
 * 获取某 session 最近的完整 High / Low（支持历史回放）
 * @param {string} symbol
 * @param {string} sessionName 'ASIA' | 'LONDON' | 'NEW_YORK'
 * @param {number} evaluationTime
 * @param {Object} [options] { candles } 已获取的 5m 已收盘 K 线（复用，避免重复请求）
 * @returns {Promise<Array>} [HIGH, LOW] 或 []
 */
function getSessionLiquidity(symbol, sessionName, evaluationTime, options) {
    var candlesPromise =
        options && options.candles
            ? Promise.resolve(options.candles)
            : binanceRest.getKlines(symbol, '5m', 500);
    return candlesPromise.then(function (candles) {
        var session = sessions[sessionName];
        if (!session) {
            return [];
        }
        var dateStart = findPreviousSessionDateStart(session, evaluationTime);
        return buildSessionLiquidity(
            symbol,
            sessionName,
            session,
            dateStart,
            candles,
            evaluationTime
        );
    });
}

module.exports = {
    sessionStartMs: sessionStartMs,
    sessionEndMs: sessionEndMs,
    findPreviousSessionDateStart: findPreviousSessionDateStart,
    buildSessionLiquidity: buildSessionLiquidity,
    getSessionLiquidity: getSessionLiquidity
};
