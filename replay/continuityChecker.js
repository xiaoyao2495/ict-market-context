/**
 * Continuity Checker（Phase 11R）
 *
 * 对回放数据做独立性检查：正式统计前必须证明数据连续。
 * 检查项：
 *   - gap：相邻 K 的 openTime 间隔 != intervalMs（缺 K）
 *   - missing：与预期数量不符
 *   - duplicate：openTime 重复
 *   - out-of-order：openTime 非严格递增
 *
 * @param {Array} candles 标准化 candle（时间升序）
 * @param {string} interval 周期（'5m' / '1d' ...）
 * @returns {Object} {
 *   valid, total, expected, intervalMs,
 *   gaps, duplicates, outOfOrder, firstTime, lastTime
 * }
 */
var INTERVAL_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
    '6h': 21600000, '8h': 28800000, '12h': 43200000,
    '1d': 86400000, '3d': 259200000, '1w': 604800000, '1M': 2592000000
};

function checkContinuity(candles, interval) {
    var intervalMs = INTERVAL_MS[interval] || 300000;
    var result = {
        valid: true,
        total: (candles || []).length,
        expected: null,
        intervalMs: intervalMs,
        gaps: [],
        duplicates: [],
        outOfOrder: [],
        firstTime: null,
        lastTime: null
    };
    var list = candles || [];
    if (list.length === 0) {
        result.valid = false;
        return result;
    }

    result.firstTime = list[0].openTime;
    result.lastTime = list[list.length - 1].openTime;
    result.expected = Math.floor((result.lastTime - result.firstTime) / intervalMs) + 1;

    var seen = {};
    var prevTime = null;
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        var t = c.openTime;
        if (seen[t]) {
            result.duplicates.push({ index: i, openTime: t });
            result.valid = false;
        }
        seen[t] = true;

        if (prevTime !== null) {
            if (t <= prevTime) {
                result.outOfOrder.push({ index: i, openTime: t, prevTime: prevTime });
                result.valid = false;
            } else if (t - prevTime !== intervalMs) {
                result.gaps.push({
                    index: i,
                    openTime: t,
                    prevTime: prevTime,
                    gapBars: Math.round((t - prevTime) / intervalMs) - 1
                });
                result.valid = false;
            }
        }
        prevTime = t;
    }

    if (list.length !== result.expected) {
        // 缺口数量与 expected 不符（如周末停盘等异常）
        result.valid = false;
    }
    return result;
}

module.exports = {
    checkContinuity: checkContinuity
};
