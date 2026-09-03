/**
 * Phase 11D.10 — HTF Liquidity Context（纯诊断）
 *
 * 背景：当前 sweep 几乎全是 5m 内部流动性。"扫掉 5m swing high"和"扫掉
 * 1H protected high / 4H swing high"对后续 delivery 的意义不同。
 *
 * 目标：回答唯一问题——"扫的是什么级别的流动性"能否解释为什么有些
 * 强 displacement 可能形成持续 Delivery，也可能只是局部 impulse。
 *
 * 实现（全部只读，不碰交易层 / HIGH 定义 / 参数）：
 *   1. 1H/4H confirmed pivots（11E.0 封板：confirmedAt = 右确认 K closeTime）
 *      → HTF liquidity pool
 *   2. 每个 5m Opportunity（alert）判定此前 sweep 层级：
 *      BULLISH = 下方流动性被穿过（min low <= price）且 anchor 已收回（price < anchor）
 *      BEARISH = 上方流动性被穿过且 anchor 已收回
 *      取被扫到的最高层级：4H_SWING > 1H_SWING > 5M_INTERNAL > NONE
 *
 * 输出标签（后续正式化的方向，本轮只出数据）：
 *   Direction Confidence：ALIGNED / UNCONFIRMED / COUNTERTREND（初步）
 */
var pivotDetector = require('../structure/pivotDetector');

var LEVEL_ORDER = ['4H_SWING', '1H_SWING', '5M_INTERNAL', 'NONE'];
var SWEEP_WINDOW_BARS = 48; // sweep 搜索窗口 = leg 完成前 48 根 5m（4 小时）

/**
 * 构建 HTF liquidity pool（1H/4H confirmed pivots）。
 * @param {Array} data1h 1h candles（已收盘）
 * @param {Array} data4h 4h candles（已收盘）
 * @returns {Array} [{ level: '1H_SWING'|'4H_SWING', price, side: 'BSL'|'SSL', confirmedAt }]
 */
function buildHtfLiquidity(data1h, data4h) {
    var out = [];
    function addPivots(candles, level) {
        if (!candles || candles.length < 5) return;
        var ps = pivotDetector.detectPivots(candles, { left: 2, right: 2 });
        ps.forEach(function (p) {
            out.push({
                level: level,
                price: p.price,
                side: p.type === 'HIGH' ? 'BSL' : 'SSL',
                confirmedAt: p.confirmedAt
            });
        });
    }
    addPivots(data1h, '1H_SWING');
    addPivots(data4h, '4H_SWING');
    return out;
}

/**
 * 判定单个 alert 此前发生的 sweep 层级（取最高被扫层级）。
 * @param {Object} alert buildAlerts 输出（anchorIndex/anchorPrice/anchorTime/direction/sweep）
 * @param {Array} candles 5m candles
 * @param {Array} htfPool buildHtfLiquidity 输出
 * @returns {Object} { level, price, distPct }
 */
function sweepLevelOf(alert, candles, htfPool) {
    var anchorIdx = alert.anchorIndex;
    var anchorPrice = alert.anchorPrice;
    var anchorTime = alert.anchorTime;
    var bullish = alert.direction === 'BULLISH';
    var from = Math.max(0, anchorIdx - SWEEP_WINDOW_BARS);
    var minLow = Infinity;
    var maxHigh = -Infinity;
    for (var j = from; j <= anchorIdx; j++) {
        var c = candles[j];
        if (!c) break;
        if (c.low < minLow) minLow = c.low;
        if (c.high > maxHigh) maxHigh = c.high;
    }
    var best = null;
    function consider(level, price) {
        if (price === null || price === undefined || !isFinite(price)) return;
        var swept = bullish
            ? (price >= minLow && anchorPrice > price)   // 下方流动性被穿 + 已收回
            : (price <= maxHigh && anchorPrice < price); // 上方流动性被穿 + 已收回
        if (!swept) return;
        var order = LEVEL_ORDER.indexOf(level);
        if (!best || order < LEVEL_ORDER.indexOf(best.level)) {
            best = { level: level, price: price, distPct: Math.abs(anchorPrice - price) / anchorPrice * 100 };
        }
    }
    (htfPool || []).forEach(function (lq) {
        if (lq.confirmedAt > anchorTime) return; // future-safety：未确认的 HTF liquidity 不可见
        consider(lq.level, lq.price);
    });
    // 5M_INTERNAL：现有 5m sweep 事件（buildAlerts 已关联最近同向）
    if (!best && alert.sweep) {
        best = { level: '5M_INTERNAL', price: alert.sweep.price, distPct: Math.abs(anchorPrice - alert.sweep.price) / anchorPrice * 100 };
    }
    if (!best) {
        best = { level: 'NONE', price: null, distPct: null };
    }
    return best;
}

/**
 * 汇总：By Sweep Level 的 1h 方向表现。
 * @param {Array} rows [{ sweepLevel, deliveryClass, htfScore, htfCount, dirHit1h, nearHit1h, mfe1h, deliveryQuality }]
 * @returns {Object} { byLevel: {...}, byLevelCombo: {...} }
 */
function assessSweepLevels(rows) {
    var byLevel = {};
    var byLevelCombo = {};
    function acc(container, key) {
        if (!container[key]) {
            container[key] = { n: 0, dirHit: 0, nearHit: 0, nearCnt: 0, mfeSum: 0 };
        }
        return container[key];
    }
    (rows || []).forEach(function (r) {
        if (!r) return;
        var lv = r.sweepLevel || 'NONE';
        var a = acc(byLevel, lv);
        a.n++; if (r.dirHit1h) a.dirHit++; if (r.nearHit1h) a.nearHit++; a.nearCnt++; a.mfeSum += r.mfe1h;
        var deliveryKey = (r.deliveryQuality === 'STRONG' || r.deliveryQuality === 'EXPLOSIVE') ? 'STRONG+' : 'NORMAL-';
        var comboKey = lv + '|' + deliveryKey;
        var c = acc(byLevelCombo, comboKey);
        c.n++; if (r.dirHit1h) c.dirHit++;
    });
    return { byLevel: byLevel, byLevelCombo: byLevelCombo };
}

module.exports = {
    buildHtfLiquidity: buildHtfLiquidity,
    sweepLevelOf: sweepLevelOf,
    assessSweepLevels: assessSweepLevels,
    LEVEL_ORDER: LEVEL_ORDER,
    SWEEP_WINDOW_BARS: SWEEP_WINDOW_BARS
};
