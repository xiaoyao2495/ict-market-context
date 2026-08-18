/**
 * ATR(14) —— Wilder smoothing（纯函数）
 *
 * True Range：
 *   TR = max(
 *       high - low,
 *       abs(high - prevClose),
 *       abs(low - prevClose)
 *   )
 *   第一根 K 线无 prevClose，TR = high - low
 *
 * Wilder ATR：
 *   第一个 ATR = 前 period 根 TR 的 SMA
 *   之后：ATR = (prevATR × (period-1) + TR) / period
 *
 * 约束：
 * - 只使用已收盘 K 线（调用方保证传入 closed candles）
 * - historical replay safe：atr(candles, period, endIndex) 只读 [0..endIndex]
 * - 不足 period+1 根 → null
 * - 纯函数，不修改输入
 */
var thresholds = require('../config/thresholds');

/**
 * 单根 K 线的 True Range
 */
function trueRange(candle, prevCandle) {
    if (!prevCandle) {
        return candle.high - candle.low;
    }
    return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevCandle.close),
        Math.abs(candle.low - prevCandle.close)
    );
}

/**
 * 计算到 endIndex 为止的 ATR 值（Wilder）
 * @param {Array} candles 已收盘 K 线（时间升序）
 * @param {number} [period] 默认 14
 * @param {number} [endIndex] 默认最后一根；只读 [0..endIndex]（replay safe）
 * @returns {number|null} ATR 值；数据不足返回 null
 */
function atr(candles, period, endIndex) {
    var p = period || thresholds.events.atr.period;
    if (!candles || candles.length < p + 1) {
        return null;
    }
    var n = candles.length;
    var end = endIndex !== undefined ? Math.min(endIndex, n - 1) : n - 1;
    if (end < p) {
        return null; // 需要 [0..p] 至少 p+1 根
    }

    // 第一个 ATR：前 p 根 TR 的 SMA（TR 从 index 1 起）
    var sum = 0;
    var i;
    for (i = 1; i <= p; i++) {
        sum += trueRange(candles[i], candles[i - 1]);
    }
    var prev = sum / p;

    // Wilder smoothing
    for (i = p + 1; i <= end; i++) {
        prev = (prev * (p - 1) + trueRange(candles[i], candles[i - 1])) / p;
    }
    return prev;
}

module.exports = {
    trueRange: trueRange,
    atr: atr
};
