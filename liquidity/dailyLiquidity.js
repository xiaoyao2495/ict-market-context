/**
 * Daily Liquidity：PDH / PDL
 *
 * PDH = 上一完整 UTC 自然日的最高价（Buy-Side Liquidity，BSL）
 * PDL = 上一完整 UTC 自然日的最低价（Sell-Side Liquidity，SSL）
 *
 * 【禁止未来数据】核心规则：
 * - 一切基于 evaluationTime（回放时刻）
 * - 只使用“上一完整 UTC 自然日”的已收盘 1d K 线
 * - 上一完整日 = evaluationTime 所在日的前一天 00:00 UTC ~ 23:59:59.999 UTC
 * - 绝不使用 evaluationTime 当天（未结束）的最终 High/Low
 * - 数据侧再做一层兜底：closeTime > evaluationTime 的 K 线一律丢弃
 *
 * 语义：confirmedAt = 该日 K 线 closeTime，
 *       即 liquidity.confirmedAt <= replayTime 时该流动性才可用。
 */
var utcTime = require('../utils/utcTime');
var binanceRest = require('../data/binanceRest');

/**
 * 纯函数：上一完整 UTC 自然日的 00:00:00.000
 */
function previousCompleteDayStart(evaluationTime) {
    return utcTime.startOfDayUTC(evaluationTime) - utcTime.DAY_MS;
}

/**
 * 纯函数：由一根【已收盘】的 1d K 线构建 PDH / PDL
 * @returns {Array} [PDH, PDL]，candle 无效时返回 []
 */
function buildDailyLiquidity(symbol, candle) {
    if (!candle) {
        return [];
    }
    var dayLabel = utcTime.formatDateUTC(candle.openTime);
    var source = candle.source || 'futures';
    return [
        {
            id: symbol + ':PDH:' + dayLabel,
            symbol: symbol,
            timeframe: '1d',
            type: 'PDH',
            side: 'BSL',
            price: candle.high,
            sourceOpenTime: candle.openTime,
            sourceCloseTime: candle.closeTime,
            createdAt: candle.closeTime,
            confirmedAt: candle.closeTime,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: { source: source }
        },
        {
            id: symbol + ':PDL:' + dayLabel,
            symbol: symbol,
            timeframe: '1d',
            type: 'PDL',
            side: 'SSL',
            price: candle.low,
            sourceOpenTime: candle.openTime,
            sourceCloseTime: candle.closeTime,
            createdAt: candle.closeTime,
            confirmedAt: candle.closeTime,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: { source: source }
        }
    ];
}

/**
 * 获取上一完整 UTC 自然日的 PDH / PDL（支持历史回放）
 * @param {string} symbol
 * @param {number} evaluationTime 回放时刻（毫秒）
 * @param {Object} [options] { fetcher } 可注入数据源（测试用）
 * @returns {Promise<Array>} [PDH, PDL] 或 []
 */
function getDailyLiquidity(symbol, evaluationTime, options) {
    var fetcher =
        (options && options.fetcher) || binanceRest.getKlines;
    var dayStart = previousCompleteDayStart(evaluationTime);
    return fetcher(
        symbol,
        '1d',
        5,
        dayStart,
        dayStart + utcTime.DAY_MS
    ).then(function (candles) {
        // 兜底防线：只允许 closeTime <= evaluationTime 的已收盘 K 线
        var closed = candles.filter(function (c) {
            return c.closed && c.closeTime <= evaluationTime;
        });
        if (closed.length === 0) {
            return [];
        }
        // 升序数组中取最后一根 = 目标自然日
        return buildDailyLiquidity(symbol, closed[closed.length - 1]);
    });
}

module.exports = {
    previousCompleteDayStart: previousCompleteDayStart,
    buildDailyLiquidity: buildDailyLiquidity,
    getDailyLiquidity: getDailyLiquidity
};
