/**
 * Pivot High / Pivot Low 检测器
 *
 * 核心原则：
 * - 默认 left = 2, right = 2
 * - Pivot 必须等右侧 right 根 K 线出现后才确认（不允许偷看未来）
 * - 检测只使用已收盘 K 线
 */

/**
 * 判断某根 K 线是否为 Pivot High
 * 条件：当前 high 严格大于左侧 left 根和右侧 right 根的 high
 */
function detectPivotHigh(candles, index, left, right) {
    var high;
    var i;
    if (index < left) {
        return false;
    }
    if (index + right >= candles.length) {
        return false;
    }
    high = candles[index].high;
    for (i = 1; i <= left; i++) {
        if (high <= candles[index - i].high) {
            return false;
        }
    }
    for (i = 1; i <= right; i++) {
        if (high < candles[index + i].high) {
            return false;
        }
    }
    return true;
}

/**
 * 判断某根 K 线是否为 Pivot Low
 * 条件：当前 low 严格小于左侧 left 根和右侧 right 根的 low
 */
function detectPivotLow(candles, index, left, right) {
    var low;
    var i;
    if (index < left) {
        return false;
    }
    if (index + right >= candles.length) {
        return false;
    }
    low = candles[index].low;
    for (i = 1; i <= left; i++) {
        if (low >= candles[index - i].low) {
            return false;
        }
    }
    for (i = 1; i <= right; i++) {
        if (low > candles[index + i].low) {
            return false;
        }
    }
    return true;
}

/**
 * 扫描整段 K 线，找出所有 Pivot
 * @param {Array} candles 标准化 candle 数组（时间升序）
 * @param {Object} options { left, right }
 * @returns {Array} [{
 *   type: 'HIGH'|'LOW',
 *   index,
 *   price,
 *   occurredAt: pivot candle openTime,
 *   confirmedAt: candles[index + right].closeTime（右侧确认 K 收盘后才成立）,
 *   time: occurredAt（向后兼容）
 * }]
 */
function detectPivots(candles, options) {
    var left = (options && options.left) || 2;
    var right = (options && options.right) || 2;
    var result = [];
    var i;
    for (i = left; i < candles.length - right; i++) {
        if (detectPivotHigh(candles, i, left, right)) {
            result.push({
                type: 'HIGH',
                index: i,
                price: candles[i].high,
                occurredAt: candles[i].openTime,
                confirmedAt: candles[i + right].closeTime,
                time: candles[i].openTime
            });
        }
        if (detectPivotLow(candles, i, left, right)) {
            result.push({
                type: 'LOW',
                index: i,
                price: candles[i].low,
                occurredAt: candles[i].openTime,
                confirmedAt: candles[i + right].closeTime,
                time: candles[i].openTime
            });
        }
    }
    return result;
}

module.exports = {
    detectPivotHigh: detectPivotHigh,
    detectPivotLow: detectPivotLow,
    detectPivots: detectPivots
};
