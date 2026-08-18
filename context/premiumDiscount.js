/**
 * Premium / Discount 定位器
 *
 * 基于 dealing range 判断价格位置：
 *   ratio = (price - range.low) / (range.high - range.low)
 *   0 = range low，1 = range high
 *
 * 分区（阈值在 thresholds.bias.rangeThresholds）：
 *   ratio >= extremePremium → PREMIUM / EXTREME
 *   ratio >= premium        → PREMIUM / MODERATE
 *   ratio >  discount       → EQUILIBRIUM
 *   ratio >  extremeDiscount → DISCOUNT / MODERATE
 *   else                    → DISCOUNT / EXTREME
 *
 * 注意：Premium 不直接 = bearish，Discount 不直接 = bullish。
 * 它只描述价格在 range 内的位置，方向解读交给 locationBias（结合 drawDirection）。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {number} price
 * @param {Object} range { high, low }（可含 mid/width）
 * @param {Object} [options] { thresholds }
 * @returns {Object} { zone, ratio, intensity, reason }；无 range → UNKNOWN
 */
function classifyLocation(price, range, options) {
    if (!range || typeof range.high !== 'number' || typeof range.low !== 'number') {
        return {
            zone: 'UNKNOWN',
            ratio: null,
            intensity: null,
            reason: 'no dealing range'
        };
    }
    var cfg = (options && options.thresholds) || thresholds;
    var t = cfg.bias.rangeThresholds;
    if (range.high === range.low) {
        return {
            zone: 'EQUILIBRIUM',
            ratio: 0.5,
            intensity: 'MODERATE',
            reason: 'flat range (high == low)'
        };
    }

    var ratio = (price - range.low) / (range.high - range.low);
    var zone;
    var intensity;

    if (ratio >= t.extremePremium) {
        zone = 'PREMIUM';
        intensity = 'EXTREME';
    } else if (ratio >= t.premium) {
        zone = 'PREMIUM';
        intensity = 'MODERATE';
    } else if (ratio > t.discount) {
        zone = 'EQUILIBRIUM';
        intensity = 'MODERATE';
    } else if (ratio > t.extremeDiscount) {
        zone = 'DISCOUNT';
        intensity = 'MODERATE';
    } else {
        zone = 'DISCOUNT';
        intensity = 'EXTREME';
    }

    return {
        zone: zone,
        ratio: ratio,
        intensity: intensity,
        reason: 'price at ' + Math.round(ratio * 100) + '% of range'
    };
}

module.exports = {
    classifyLocation: classifyLocation
};
