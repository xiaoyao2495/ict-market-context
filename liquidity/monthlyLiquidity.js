/**
 * Monthly Liquidity：PMH / PML
 *
 * PMH = 上一个完整 UTC 自然月的最高价（Buy-Side Liquidity，BSL）
 * PML = 上一个完整 UTC 自然月的最低价（Sell-Side Liquidity，SSL）
 *
 * 月边界（独立实现，不依赖 30 天近似）：
 *   UTC 自然月 = 每月 1 号 00:00:00.000 UTC → 次月 1 号 00:00:00.000 UTC
 *   （与 Binance 1M K 线 openTime 对齐）
 *
 * 【禁止未来数据】核心规则：
 * - 一切基于 evaluationTime（回放时刻）
 * - 只使用“上一完整自然月”的已收盘 1M K 线
 * - 上一完整月 = 当前月 1 号往前推一个月（1 月时自动跨到上一年 12 月）
 * - 绝不使用当前未结束月份的最终 High/Low
 * - 数据侧兜底：closeTime > evaluationTime 的 K 线一律丢弃
 *
 * 语义：confirmedAt = 该月 K 线 closeTime（月末 23:59:59.999 UTC），
 *       即 liquidity.confirmedAt <= replayTime 时该流动性才可用。
 */
var utcTime = require('../utils/utcTime');
var binanceRest = require('../data/binanceRest');

/**
 * 纯函数：上一完整 UTC 自然月的 1 号 00:00:00.000
 */
function previousCompleteMonthStart(evaluationTime) {
    return utcTime.previousCompleteMonthStart(evaluationTime);
}

/**
 * 纯函数：由一根【已收盘】的 1M K 线构建 PMH / PML
 * @returns {Array} [PMH, PML]，candle 无效时返回 []
 */
function buildMonthlyLiquidity(symbol, candle) {
    if (!candle) {
        return [];
    }
    var monthLabel = utcTime.formatMonthUTC(candle.openTime);
    var source = candle.source || 'futures';
    var base = {
        symbol: symbol,
        timeframe: '1M',
        sourceOpenTime: candle.openTime,
        sourceCloseTime: candle.closeTime,
        createdAt: candle.closeTime,
        confirmedAt: candle.closeTime,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null
    };
    return [
        {
            id: symbol + ':PMH:' + monthLabel,
            type: 'PMH',
            side: 'BSL',
            price: candle.high,
            metadata: { source: source, sourcePeriod: monthLabel }
        },
        {
            id: symbol + ':PML:' + monthLabel,
            type: 'PML',
            side: 'SSL',
            price: candle.low,
            metadata: { source: source, sourcePeriod: monthLabel }
        }
    ].map(function (item) {
        // 合并公共字段
        var merged = {};
        Object.keys(base).forEach(function (k) {
            merged[k] = base[k];
        });
        Object.keys(item).forEach(function (k) {
            merged[k] = item[k];
        });
        return merged;
    });
}

/**
 * 获取上一完整 UTC 自然月的 PMH / PML（支持历史回放）
 * @param {string} symbol
 * @param {number} evaluationTime 回放时刻（毫秒）
 * @param {Object} [options] { fetcher } 可注入数据源（测试用）
 * @returns {Promise<Array>} [PMH, PML] 或 []
 */
function getMonthlyLiquidity(symbol, evaluationTime, options) {
    var fetcher =
        (options && options.fetcher) || binanceRest.getKlines;
    var prevStart = utcTime.previousCompleteMonthStart(evaluationTime);
    var curStart = utcTime.startOfMonthUTC(evaluationTime);
    return fetcher(symbol, '1M', 3, prevStart, curStart).then(function (candles) {
        // 兜底防线：只允许 closeTime <= evaluationTime 的已收盘 K 线
        var closed = candles.filter(function (c) {
            return c.closed && c.closeTime <= evaluationTime;
        });
        if (closed.length === 0) {
            return [];
        }
        // 升序数组中取最后一根 = 目标自然月
        return buildMonthlyLiquidity(symbol, closed[closed.length - 1]);
    });
}

module.exports = {
    previousCompleteMonthStart: previousCompleteMonthStart,
    buildMonthlyLiquidity: buildMonthlyLiquidity,
    getMonthlyLiquidity: getMonthlyLiquidity
};
