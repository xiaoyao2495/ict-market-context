/**
 * Phase 11D.6 — MSS Direction Validation（以 MSS 事件为锚点）
 *
 * 11N 的 FVG-retrace 事件太稀有（90d 仅 14 个），无法判 MSS quality 单调性。
 * 本模块直接以 MSS 事件为锚点（30d 1104 个 / 90d 3189 个）：
 *   MSS 收盘突破 reference → 未来 6/12/48 根是否朝 MSS 方向延续？
 *
 * 指标（BULLISH 对称 BEARISH）：
 *   dirCorrect  窗口结束净涨跌符合 MSS 方向
 *   mfe / mae   顺向/反向最大波动（%）
 *   nearTargetHit  Near Draw 目标（最近 liquidity）兑现
 *
 * 分组：mssQuality × legQuality（二维），回答"Protected Swing 被强 leg 打穿 = 高质量 MSS"
 */
var retraceTracker = require('../replay/retraceTracker'); // 仅复用? 不需要——独立实现

var WINDOWS = [
    { key: '30m', bars: 6 },
    { key: '1h', bars: 12 },
    { key: '4h', bars: 48 }
];

/**
 * @param {Object} mssEvent MSS 事件（direction / candleIndex / price / source.referenceSwingId）
 * @param {Array} candles
 * @param {Object} ctx { mssQuality, legQuality, nearTarget }  // nearTarget = 该时点 Near Draw 目标价
 * @returns {Object|null}
 */
function analyzeMssEvent(mssEvent, candles, ctx) {
    if (!mssEvent || mssEvent.candleIndex === undefined) {
        return null;
    }
    var idx = mssEvent.candleIndex;
    var anchorPrice = mssEvent.price !== undefined && mssEvent.price !== null
        ? mssEvent.price : (candles[idx] ? candles[idx].close : null);
    if (!anchorPrice || idx >= candles.length - 1) {
        return null;
    }
    var bullish = mssEvent.direction === 'BULLISH';
    var nearTarget = ctx && ctx.nearTarget !== undefined ? ctx.nearTarget : null;
    var out = {
        direction: mssEvent.direction,
        mssQuality: (ctx && ctx.mssQuality) || 'NO_MSS',
        legQuality: (ctx && ctx.legQuality) || 'NO_LEG',
        anchorPrice: anchorPrice,
        index: idx,
        w30m: null, w1h: null, w4h: null
    };
    WINDOWS.forEach(function (w) {
        var mfe = 0;
        var mae = 0;
        var nearHit = false;
        var lastJ = Math.min(idx + w.bars, candles.length - 1);
        for (var j = idx + 1; j <= lastJ; j++) {
            var c = candles[j];
            if (!c) break;
            if (bullish) {
                if (c.high - anchorPrice > mfe) mfe = c.high - anchorPrice;
                if (anchorPrice - c.low > mae) mae = anchorPrice - c.low;
                if (nearTarget !== null && c.high >= nearTarget) nearHit = true;
            } else {
                if (anchorPrice - c.low > mfe) mfe = anchorPrice - c.low;
                if (c.high - anchorPrice > mae) mae = c.high - anchorPrice;
                if (nearTarget !== null && c.low <= nearTarget) nearHit = true;
            }
        }
        var endClose = candles[lastJ] ? candles[lastJ].close : anchorPrice;
        var net = bullish ? endClose - anchorPrice : anchorPrice - endClose;
        out['w' + w.key] = {
            mfePct: mfe / anchorPrice * 100,
            maePct: mae / anchorPrice * 100,
            netPct: net / anchorPrice * 100,
            dirCorrect: net > 0,
            nearHit: nearHit,
            hasNear: nearTarget !== null
        };
    });
    return out;
}

/**
 * 汇总：按 mssQuality × legQuality 分组
 * @returns {Object} { byCombo: { 'mss|leg': {n, w30m...} }, byQuality, byLeg }
 */
function summarizeMssDirection(results) {
    var byCombo = {};
    var byQuality = {};
    var byLeg = {};
    function accFor(container, key) {
        if (!container[key]) {
            var g = { n: 0, w30m: null, w1h: null, w4h: null };
            WINDOWS.forEach(function (w) {
                g['w' + w.key] = { hit: 0, mfeSum: 0, maeSum: 0, nearHit: 0, hasNear: 0 };
            });
            container[key] = g;
        }
        return container[key];
    }
    results.forEach(function (r) {
        if (!r) return;
        var comboKey = r.mssQuality + '|' + r.legQuality;
        [accFor(byCombo, comboKey), accFor(byQuality, r.mssQuality), accFor(byLeg, r.legQuality)].forEach(function (acc) {
            acc.n++;
            WINDOWS.forEach(function (w) {
                var s = r['w' + w.key];
                if (!s) return;
                var a = acc['w' + w.key];
                a.hit += s.dirCorrect ? 1 : 0;
                a.mfeSum += s.mfePct;
                a.maeSum += s.maePct;
                a.nearHit += s.nearHit ? 1 : 0;
                a.hasNear += s.hasNear ? 1 : 0;
            });
        });
    });
    return { byCombo: byCombo, byQuality: byQuality, byLeg: byLeg };
}

module.exports = {
    analyzeMssEvent: analyzeMssEvent,
    summarizeMssDirection: summarizeMssDirection,
    WINDOWS: WINDOWS
};
