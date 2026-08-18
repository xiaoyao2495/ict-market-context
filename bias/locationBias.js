/**
 * Location Bias —— Premium / Discount 可信度调整
 *
 * 关键原则（避免 "Discount = bullish / Premium = bearish" 的过度简化）：
 * Location 只给【已有方向】加/减可信度，不独立制造方向。
 * 因此必须接收 drawDirection（或未来 bias 参考方向）作为方向参考。
 *
 * 以 bullish 参考（draw 偏 BSL）为例：
 *   EXTREME_DISCOUNT → +15（在 discount 买，符合结构叙事）
 *   DISCOUNT         → +10
 *   EQUILIBRIUM      →   0
 *   PREMIUM          →  -5
 *   EXTREME_PREMIUM  → -10（追高，削弱可信度）
 *
 * bearish 参考（draw 偏 SSL）时对称取反。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} input { drawDirection, location }
 *   drawDirection: drawEngine 输出的 direction（'BSL'|'LEAN_BSL'|'BALANCED'|'LEAN_SSL'|'SSL'）
 *   location: classifyLocation 输出 { zone, ratio, intensity }
 * @param {Object} [options] { thresholds }
 * @returns {Object} { score, reason, drawDirection, zone, intensity }
 */
function scoreLocationBias(input, options) {
    var cfg = (options && options.thresholds) || thresholds;
    var table = cfg.bias.location;
    var drawDirection = input && input.drawDirection ? input.drawDirection : 'BALANCED';
    var location = input && input.location ? input.location : null;

    var bullishRef = drawDirection === 'BSL' || drawDirection === 'LEAN_BSL';
    var bearishRef = drawDirection === 'SSL' || drawDirection === 'LEAN_SSL';

    if (!location || location.zone === 'UNKNOWN') {
        return {
            score: 0,
            reason: 'no dealing range',
            drawDirection: drawDirection,
            zone: 'UNKNOWN',
            intensity: null
        };
    }
    if (!bullishRef && !bearishRef) {
        return {
            score: 0,
            reason: 'draw balanced, location adds no directional confidence',
            drawDirection: drawDirection,
            zone: location.zone,
            intensity: location.intensity
        };
    }

    var zone = location.zone; // PREMIUM | DISCOUNT | EQUILIBRIUM
    var extreme = location.intensity === 'EXTREME';

    var score;
    var scoreKey;

    // 表值本身即 bullish 参考视角（discount 正 / premium 负），
    // 两分支都直接取表值：bearish 参考时把 zone 对称映射到对应表项。
    if (bullishRef) {
        if (zone === 'DISCOUNT') {
            scoreKey = extreme ? 'discountExtreme' : 'discount';
        } else if (zone === 'EQUILIBRIUM') {
            scoreKey = 'equilibrium';
        } else {
            scoreKey = extreme ? 'premiumExtreme' : 'premium';
        }
    } else {
        if (zone === 'PREMIUM') {
            scoreKey = extreme ? 'discountExtreme' : 'discount';
        } else if (zone === 'EQUILIBRIUM') {
            scoreKey = 'equilibrium';
        } else {
            scoreKey = extreme ? 'premiumExtreme' : 'premium';
        }
    }

    score = table[scoreKey] !== undefined ? table[scoreKey] : 0;

    return {
        score: score,
        reason: reasonText(zone, extreme, bearishRef ? 'bearish' : 'bullish'),
        drawDirection: drawDirection,
        zone: zone,
        intensity: location.intensity
    };
}

function reasonText(zone, extreme, ref) {
    var pos = extreme ? 'extreme ' + zone.toLowerCase() : zone.toLowerCase();
    var action = zone === 'EQUILIBRIUM'
        ? 'price at equilibrium'
        : 'price in ' + pos + (zone === 'PREMIUM' ? ' (bearish side of range)' : ' (bullish side of range)');
    return action + ' — ' + ref + ' reference';
}

module.exports = {
    scoreLocationBias: scoreLocationBias
};
