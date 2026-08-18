/**
 * Phase 11N — Narrative Direction Validation
 *
 * 把交易层全部拿掉，只验证最纯粹的一件事：
 *   HTF Narrative → Scenario WATCH → 有效 FVG → 价格真实回踩后，
 *   未来 30m / 1h / 4h 价格是否更倾向朝识别的 Narrative 方向运行。
 *
 * 锚点 = FVG 第一次真实回踩完成（wick 触及 zone，distanceToZone <= 0），
 * 不是 ENTRY_READY / 确认 K / 成交 —— 验证的是"方向判断对不对"，不是"执行对不对"。
 *
 * 每事件冻结：direction / alignmentAtWatch / biasAtWatch / fvgScoreAtWatch / draw（primary target）
 * 窗口（5m K）：30m = 6 根 · 1h = 12 根 · 4h = 48 根
 * 指标（BULLISH 对称 BEARISH）：
 *   net          = 窗口净涨跌（%）
 *   mfe          = 最多顺向（%）
 *   mae          = 最多反向（%）
 *   dirCorrect   = net > 0
 *   drawHit      = 窗口内触达 primary liquidity target
 *
 * 基准：A. MATCH（我们识别的方向）/ B. OPPOSITE（反向 alignment）/ C. 全部（不分方向）
 */
var retraceTracker = require('../replay/retraceTracker');

var WINDOWS = [
    { key: '30m', bars: 6 },
    { key: '1h', bars: 12 },
    { key: '4h', bars: 48 }
];

/**
 * 对单个 retrace 找 first touch 并统计未来窗口
 * @param {Object} r retrace
 * @param {Array} candles
 * @param {Object} [ctx] { fvgToMssQuality }  // Phase 11D.4：MSS quality 映射（fvgId → quality）
 * @returns {Object|null} { direction, alignment, biasAtWatch, fvgScore, anchorPrice, touchIndex, mssQuality, w30m/w1h/w4h }
 */
function analyzeRetrace(r, candles, ctx) {
    if (!r || !r.zoneLow || r.zoneHigh === undefined || r.zoneHigh === null) {
        return null;
    }
    var c2 = ctx || {};
    var start = (r.watchIndex !== undefined ? r.watchIndex : 0) + 1;
    var end = r.closeIndex !== undefined && r.closeIndex !== null ? r.closeIndex : candles.length - 1;
    var touchIdx = null;
    var i;
    for (i = start; i <= end && i < candles.length; i++) {
        var c = candles[i];
        if (!c) break;
        if (retraceTracker.distanceToZone(r.direction, c, r.zoneLow, r.zoneHigh) <= 1e-12) {
            touchIdx = i;
            break;
        }
    }
    if (touchIdx === null) {
        return null; // 无真实回踩
    }
    var anchorPrice = candles[touchIdx].close;
    if (!anchorPrice) {
        return null;
    }
    var dir = r.direction; // 'BULLISH' | 'BEARISH'
    var bullish = dir === 'BULLISH';
    // Phase 11D.2：macro target（原 primary）+ near target（近端可达，fallback 到 primary）
    var target = null;
    var nearTarget = null;
    if (r.draw) {
        var primary = bullish
            ? (r.draw.bsl && r.draw.bsl.primary)
            : (r.draw.ssl && r.draw.ssl.primary);
        var near = bullish
            ? (r.draw.bsl && (r.draw.bsl.near || r.draw.bsl.primary))
            : (r.draw.ssl && (r.draw.ssl.near || r.draw.ssl.primary));
        if (primary && primary.targetPrice !== undefined) {
            target = primary.targetPrice;
        }
        if (near && near.targetPrice !== undefined) {
            nearTarget = near.targetPrice;
        }
    }
    var out = {
        direction: dir,
        alignment: r.alignmentAtWatch || null,
        biasAtWatch: r.biasAtWatch || null,
        fvgScore: r.fvgScoreAtWatch !== undefined ? r.fvgScoreAtWatch : null,
        // Phase 11D.4：MSS quality（fvgId → quality 映射，无则 NO_MSS）
        mssQuality: (c2.fvgToMssQuality && r.fvgId) ? (c2.fvgToMssQuality[r.fvgId] || 'NO_MSS') : 'NO_MSS',
        // Phase 11D.5：DisplacementLeg quality（fvgId → legQuality 映射，无则 NO_LEG）
        legQuality: (c2.fvgToLegQuality && r.fvgId) ? (c2.fvgToLegQuality[r.fvgId] || 'NO_LEG') : 'NO_LEG',
        anchorPrice: anchorPrice,
        touchIndex: touchIdx,
        symbol: r.symbol,
        w30m: null, w1h: null, w4h: null
    };
    WINDOWS.forEach(function (w) {
        var mfe = 0;
        var mae = 0;
        var drawHit = false;
        var nearDrawHit = false;
        var j;
        var lastJ = Math.min(touchIdx + w.bars, candles.length - 1);
        for (j = touchIdx + 1; j <= lastJ; j++) {
            var c2 = candles[j];
            if (!c2) break;
            if (bullish) {
                if (c2.high - anchorPrice > mfe) mfe = c2.high - anchorPrice;
                if (anchorPrice - c2.low > mae) mae = anchorPrice - c2.low;
                if (target !== null && c2.high >= target) drawHit = true;
                if (nearTarget !== null && c2.high >= nearTarget) nearDrawHit = true;
            } else {
                if (anchorPrice - c2.low > mfe) mfe = anchorPrice - c2.low;
                if (c2.high - anchorPrice > mae) mae = c2.high - anchorPrice;
                if (target !== null && c2.low <= target) drawHit = true;
                if (nearTarget !== null && c2.low <= nearTarget) nearDrawHit = true;
            }
        }
        var endClose = candles[lastJ] ? candles[lastJ].close : anchorPrice;
        var net = bullish ? endClose - anchorPrice : anchorPrice - endClose;
        out['w' + w.key] = {
            mfePct: mfe / anchorPrice * 100,
            maePct: mae / anchorPrice * 100,
            netPct: net / anchorPrice * 100,
            dirCorrect: net > 0,
            drawHit: drawHit,
            nearDrawHit: nearDrawHit,
            hasTarget: target !== null,
            hasNearTarget: nearTarget !== null
        };
    });
    return out;
}

/**
 * 汇总：按 alignment 分组（MATCH / OPPOSITE / UNCONFIRMED / ALL）× 窗口
 * @returns {Object} {
 *   groups: { MATCH: {n, w30m:{hit,mfeAvg,maeAvg,mfeMae,drawHit}, ...}, ... },
 *   byDirection: { BULLISH: {...}, BEARISH: {...} },
 *   bySymbol: { BTCUSDT: {...}, ... }
 * }
 */
function summarizeNarrativeDirection(results) {
    var groups = {};
    var byDirection = {};
    var bySymbol = {};
    var byMssQuality = {}; // Phase 11D.4：MSS quality 分组
    var byLegQuality = {}; // Phase 11D.5：DisplacementLeg quality 分组
    var byMssLegCombo = {}; // Phase 11D.5：MSS × Leg 二维组合
    function accFor(container, key) {
        if (!container[key]) {
            var g = { n: 0, w30m: null, w1h: null, w4h: null };
            WINDOWS.forEach(function (w) {
                g['w' + w.key] = { hit: 0, mfeSum: 0, maeSum: 0, maeCnt: 0, drawHit: 0, targetCnt: 0, nearDrawHit: 0, nearTargetCnt: 0 };
            });
            container[key] = g;
        }
        return container[key];
    }
    results.forEach(function (r) {
        if (!r) return;
        var g = accFor(groups, r.alignment || 'UNCONFIRMED');
        var gd = accFor(byDirection, r.direction);
        var gs = accFor(bySymbol, r.symbol);
        var gm = accFor(byMssQuality, r.mssQuality || 'NO_MSS');
        var gl = accFor(byLegQuality, r.legQuality || 'NO_LEG');
        var comboKey = (r.mssQuality || 'NO_MSS') + '|' + (r.legQuality || 'NO_LEG');
        var gc = accFor(byMssLegCombo, comboKey);
        [g, gd, gs, gm, gl, gc].forEach(function (acc) {
            acc.n++;
            WINDOWS.forEach(function (w) {
                var s = r['w' + w.key];
                if (!s) return;
                var a = acc['w' + w.key];
                a.hit += s.dirCorrect ? 1 : 0;
                a.mfeSum += s.mfePct;
                a.maeSum += s.maePct;
                a.maeCnt += s.maePct > 0 ? 1 : 0;
                a.drawHit += s.drawHit ? 1 : 0;
                a.targetCnt += s.hasTarget ? 1 : 0;
                a.nearDrawHit += s.nearDrawHit ? 1 : 0;
                a.nearTargetCnt += s.hasNearTarget ? 1 : 0;
            });
        });
    });
    // ALL 组（全部事件，不分方向）
    var all = accFor(groups, 'ALL');
    results.forEach(function (r) {
        if (!r) return;
        all.n++;
        WINDOWS.forEach(function (w) {
            var s = r['w' + w.key];
            if (!s) return;
            var a = all['w' + w.key];
            a.hit += s.dirCorrect ? 1 : 0;
            a.mfeSum += s.mfePct;
            a.maeSum += s.maePct;
            a.maeCnt += s.maePct > 0 ? 1 : 0;
            a.drawHit += s.drawHit ? 1 : 0;
            a.targetCnt += s.hasTarget ? 1 : 0;
            a.nearDrawHit += s.nearDrawHit ? 1 : 0;
            a.nearTargetCnt += s.hasNearTarget ? 1 : 0;
        });
    });
    return { groups: groups, byDirection: byDirection, bySymbol: bySymbol, byMssQuality: byMssQuality, byLegQuality: byLegQuality, byMssLegCombo: byMssLegCombo };
}

module.exports = {
    analyzeRetrace: analyzeRetrace,
    summarizeNarrativeDirection: summarizeNarrativeDirection,
    WINDOWS: WINDOWS
};
