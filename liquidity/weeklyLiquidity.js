/**
 * Weekly Liquidity：PWH / PWL
 *
 * PWH = 上一完整 UTC 自然周的最高价（Buy-Side Liquidity，BSL）
 * PWL = 上一完整 UTC 自然周的最低价（Sell-Side Liquidity，SSL）
 *
 * 周定义（固定）：
 *   Monday 00:00:00.000 UTC → 下周一 00:00:00.000 UTC
 *   （与 Binance 的 1w K 线 openTime 对齐）
 *
 * 【禁止未来数据】核心规则：
 * - 一切基于 evaluationTime（回放时刻）
 * - 只使用“上一完整自然周”的已收盘 1w K 线
 * - 上一完整周 = 本周周一 00:00 UTC 再往前推 7 天的那一周
 * - 绝不使用 evaluationTime 当周（未结束）的最终 High/Low
 * - 数据侧兜底：closeTime > evaluationTime 的 K 线一律丢弃
 *
 * 语义：confirmedAt = 该周 K 线 closeTime（周日 23:59:59.999 UTC），
 *       即 liquidity.confirmedAt <= replayTime 时该流动性才可用。
 */
var utcTime = require('../utils/utcTime');
var binanceRest = require('../data/binanceRest');

/**
 * 纯函数：上一完整 UTC 自然周的周一 00:00:00.000
 */
function previousCompleteWeekStart(evaluationTime) {
    return utcTime.startOfWeekUTC(evaluationTime) - utcTime.WEEK_MS;
}

/**
 * 纯函数：由一根【已收盘】的 1w K 线构建 PWH / PWL
 * @returns {Array} [PWH, PWL]，candle 无效时返回 []
 */
function buildWeeklyLiquidity(symbol, candle) {
    if (!candle) {
        return [];
    }
    var weekLabel = utcTime.formatDateUTC(candle.openTime); // 周一日期
    var source = candle.source || 'futures';
    return [
        {
            id: symbol + ':PWH:' + weekLabel,
            symbol: symbol,
            timeframe: '1w',
            type: 'PWH',
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
            id: symbol + ':PWL:' + weekLabel,
            symbol: symbol,
            timeframe: '1w',
            type: 'PWL',
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
 * 获取上一完整 UTC 自然周的 PWH / PWL（支持历史回放）
 * @param {string} symbol
 * @param {number} evaluationTime 回放时刻（毫秒）
 * @param {Object} [options] { fetcher } 可注入数据源（测试用）
 * @returns {Promise<Array>} [PWH, PWL] 或 []
 */
function getWeeklyLiquidity(symbol, evaluationTime, options) {
    var fetcher =
        (options && options.fetcher) || binanceRest.getKlines;
    var weekStart = previousCompleteWeekStart(evaluationTime);
    return fetcher(
        symbol,
        '1w',
        3,
        weekStart,
        weekStart + utcTime.WEEK_MS
    ).then(function (candles) {
        // 兜底防线：只允许 closeTime <= evaluationTime 的已收盘 K 线
        var closed = candles.filter(function (c) {
            return c.closed && c.closeTime <= evaluationTime;
        });
        if (closed.length === 0) {
            return [];
        }
        // 升序数组中取最后一根 = 目标自然周
        return buildWeeklyLiquidity(symbol, closed[closed.length - 1]);
    });
}

module.exports = {
    previousCompleteWeekStart: previousCompleteWeekStart,
    buildWeeklyLiquidity: buildWeeklyLiquidity,
    getWeeklyLiquidity: getWeeklyLiquidity
};
