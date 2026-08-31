/**
 * Swing Structure 分类器（HH / HL / LH / LL）
 *
 * 输入：某周期的 swing pivots（已确认，时间升序）
 * 输出：市场结构状态
 *
 * 规则（ICT 市场结构）：
 *   Bullish structure = HH + HL（更高的高点 + 更高的低点）
 *   Bearish structure = LH + LL
 *   其他组合（HH+LL / LH+HL）→ CONFLICTED
 *   数据不足（少于 2 个 high 或 2 个 low）→ NEUTRAL
 *
 * 第一版只消费已确认的 swing，不混入 displacement。
 */
var STRUCTURE_BULLISH = 'BULLISH';
var STRUCTURE_BEARISH = 'BEARISH';
var STRUCTURE_NEUTRAL = 'NEUTRAL';
var STRUCTURE_CONFLICTED = 'CONFLICTED';

/**
 * pivot 的确认时间：优先 confirmedAt（右侧确认 K 的 closeTime），回退 time
 * （旧数据兼容；detectPivots 现在总是输出 confirmedAt）
 */
function pivotConfirmedAt(p) {
    if (p && p.confirmedAt !== undefined) {
        return p.confirmedAt;
    }
    return p && p.time !== undefined ? p.time : 0;
}

/**
 * 从 pivots 中按 type 取时间上最近的 n 个（升序返回）
 */
function latestPivots(pivots, type, n) {
    var filtered = (pivots || []).filter(function (p) {
        return p.type === type;
    });
    // 按确认时间升序，取末尾 n 个
    filtered.sort(function (a, b) {
        return pivotConfirmedAt(a) - pivotConfirmedAt(b);
    });
    return filtered.slice(-n);
}

/**
 * 分类市场结构
 * @param {Array} pivots [{ type: 'HIGH'|'LOW', index, price, confirmedAt, time }] 已确认 pivot
 * @param {Object} [options] { timeframe, evaluationTime }
 * @returns {Object} {
 *   timeframe, structure, hh, hl, lh, ll,
 *   highs: [prev, recent], lows: [prev, recent],
 *   confirmedAt, reason
 * }
 */
function classifyStructure(pivots, options) {
    var opts = options || {};
    var timeframe = opts.timeframe || 'HTF';
    var evaluationTime = opts.evaluationTime;
    // 防未来数据：只允许已确认（confirmedAt <= evaluationTime）的 pivot。
    // 关键：pivot 必须等右侧确认 K 收盘才算数（confirmedAt = candles[i+right].closeTime），
    // 不能用 pivot candle 的 openTime（time）过滤——否则 Replay 会提前使用尚未确认的 HTF pivot。
    var confirmed = (pivots || []).filter(function (p) {
        return evaluationTime === undefined || pivotConfirmedAt(p) <= evaluationTime;
    });

    var highs = latestPivots(confirmed, 'HIGH', 2);
    var lows = latestPivots(confirmed, 'LOW', 2);

    if (highs.length < 2 || lows.length < 2) {
        return {
            timeframe: timeframe,
            structure: STRUCTURE_NEUTRAL,
            hh: null,
            hl: null,
            lh: null,
            ll: null,
            highs: highs,
            lows: lows,
            confirmedAt: latestTime(confirmed),
            reason: 'insufficient swing pivots (need >=2 highs and >=2 lows)'
        };
    }

    var prevHigh = highs[0];
    var recentHigh = highs[1];
    var prevLow = lows[0];
    var recentLow = lows[1];

    var hh = recentHigh.price > prevHigh.price;
    var hl = recentLow.price > prevLow.price;
    var lh = recentHigh.price < prevHigh.price;
    var ll = recentLow.price < prevLow.price;

    var structure;
    var reason;
    if (hh && hl) {
        structure = STRUCTURE_BULLISH;
        reason = 'HH + HL';
    } else if (lh && ll) {
        structure = STRUCTURE_BEARISH;
        reason = 'LH + LL';
    } else if ((hh && ll) || (lh && hl)) {
        structure = STRUCTURE_CONFLICTED;
        reason = 'mixed swing structure (HH+LL / LH+HL)';
    } else {
        structure = STRUCTURE_NEUTRAL;
        reason = 'flat / equal highs and lows';
    }

    return {
        timeframe: timeframe,
        structure: structure,
        hh: hh,
        hl: hl,
        lh: lh,
        ll: ll,
        highs: highs,
        lows: lows,
        confirmedAt: latestTime(confirmed),
        reason: reason
    };
}

function latestTime(pivots) {
    var t = 0;
    (pivots || []).forEach(function (p) {
        var pt = pivotConfirmedAt(p);
        if (pt > t) t = pt;
    });
    return t;
}

module.exports = {
    classifyStructure: classifyStructure,
    latestPivots: latestPivots,
    pivotConfirmedAt: pivotConfirmedAt,
    BULLISH: STRUCTURE_BULLISH,
    BEARISH: STRUCTURE_BEARISH,
    NEUTRAL: STRUCTURE_NEUTRAL,
    CONFLICTED: STRUCTURE_CONFLICTED
};
