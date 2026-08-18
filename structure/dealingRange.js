/**
 * Dealing Range 构建器
 *
 * 第一版实现：
 * - 取时间上【最近的两个已确认 pivot】构成的摆动区间作为 range
 *   （无论 HIGH/LOW 顺序，range = [min(price), max(price)]）
 * - 只允许 time <= evaluationTime 的 pivot（防未来数据）
 * - 少于 2 个 pivot → null
 *
 * 后续可扩展为“显式 dealing range”（如大周期区间，含 consolidation 判断）。
 */
/**
 * 构建 dealing range
 * @param {Array} pivots 已确认 pivot [{ type, index, price, time }]
 * @param {Object} [options] { evaluationTime }
 * @returns {Object|null} {
 *   high, low, mid, width, highTime, lowTime, rangeFrom: 'swing'
 * }；数据不足返回 null
 */
function buildDealingRange(pivots, options) {
    var opts = options || {};
    var evaluationTime = opts.evaluationTime;

    // 防未来数据：只允许已确认（confirmedAt <= evaluationTime）的 pivot。
    // 与 swingClassifier 一致，使用 confirmedAt（右侧确认 K closeTime）而非 pivot openTime。
    var confirmed = (pivots || []).filter(function (p) {
        var pTime =
            p && p.confirmedAt !== undefined
                ? p.confirmedAt
                : p && p.time !== undefined
                ? p.time
                : 0;
        return evaluationTime === undefined || pTime <= evaluationTime;
    });
    if (confirmed.length < 2) {
        return null;
    }

    var confirmedAtOf = function (p) {
        return p && p.confirmedAt !== undefined ? p.confirmedAt : p.time;
    };
    var sorted = confirmed.slice().sort(function (a, b) {
        return confirmedAtOf(a) - confirmedAtOf(b);
    });
    var a = sorted[sorted.length - 2];
    var b = sorted[sorted.length - 1];

    var high = Math.max(a.price, b.price);
    var low = Math.min(a.price, b.price);

    return {
        high: high,
        low: low,
        mid: (high + low) / 2,
        width: high - low,
        highTime: a.price > b.price ? confirmedAtOf(a) : confirmedAtOf(b),
        lowTime: a.price < b.price ? confirmedAtOf(a) : confirmedAtOf(b),
        rangeFrom: 'swing'
    };
}

module.exports = {
    buildDealingRange: buildDealingRange
};
