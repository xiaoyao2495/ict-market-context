/**
 * Pivot High / Pivot Low 检测器
 *
 * 核心原则：
 * - 默认 left = 2, right = 2
 * - Pivot 必须等右侧 right 根 K 线出现后才确认（不允许偷看未来）
 * - 检测只使用已收盘 K 线
 *
 * Phase 12.1（2026-08-20）正名 —— 语义边界：
 * 2-left + 2-right 的输出只回答一个问题：「这里是不是一个确认后的局部转折点」。
 * 它的语义是 LOCAL_PIVOT（LOCAL_PIVOT_HIGH / LOCAL_PIVOT_LOW），**不承诺**：
 *   - 它是不是重要 Swing（结构性意义需要后续 qualification，见 Phase 12.2）
 *   - 它是不是 Liquidity Object（是否注册 liquidity 需要 Liquidity Qualification，见 Phase 12.4）
 *   - 它能不能作为 MSS reference（MSS 消费方应改吃 STRUCTURAL_SWING，见 Phase 12.3）
 * 后续改变 Swing/Liquidity qualification 时，本 detector 不应被牵连修改。
 * 历史兼容：当前消费方（swingLiquidity 包装等）仍把输出当 swing 使用，仅注释正名，逻辑零改动。
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
