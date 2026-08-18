/**
 * Equal Liquidity 检测器（EQH / EQL）
 *
 * 输入：已确认的 Swing Liquidity（SWING_HIGH / SWING_LOW）
 * 输出：EQH / EQL 分组（group）
 *
 * 规则：
 * - EQH 只比较 SWING_HIGH（side = BSL）
 * - EQL 只比较 SWING_LOW（side = SSL）
 * - 价格相等判定：abs(priceA - priceB) <= tolerance
 *   tolerance = max(price * percentageTolerance, tickSize * 2)
 * - 成员在原始 K 线中的间隔必须满足：
 *   minBarsApart <= barsApart <= maxBarsApart
 * - 三个及以上成员自动合并为【一个】group，绝不生成 A+B / A+C / B+C 的重复对
 * - price = 成员平均价；metadata 保存 minPrice / maxPrice / memberCount / members
 * - confirmedAt = max(member.confirmedAt)
 * - 只有 confirmedAt <= evaluationTime 的成员才允许参与（历史回放安全）
 *
 * 聚类策略：按价格升序排序后贪心分组（每组只与组内第一个成员比较），
 * 扫描指针跳过已归属成员 → 保证分组不重叠、不产生 pair duplicate。
 */
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000,
    '3m': 180000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '2h': 7200000,
    '4h': 14400000,
    '6h': 21600000,
    '8h': 28800000,
    '12h': 43200000,
    '1d': 86400000,
    '3d': 259200000,
    '1w': 604800000,
    '1M': 2592000000
};

/**
 * tolerance = max(price * percentageTolerance, tickSize * tickMultiplier)
 * tickSize 缺失时退化为纯百分比（不阻塞系统）
 */
function toleranceFor(price, percentageTolerance, tickSize, tickMultiplier) {
    var percent = (percentageTolerance || 0) * price;
    var tick = (tickSize || 0) * (tickMultiplier || 2);
    return Math.max(percent, tick);
}

/**
 * 两个成员在原始 K 线中的间隔（根数）
 * 优先用 metadata.index，缺失时用 sourceOpenTime 差值推算
 */
function barsApart(a, b) {
    var ai = a.metadata && typeof a.metadata.index === 'number' ? a.metadata.index : null;
    var bi = b.metadata && typeof b.metadata.index === 'number' ? b.metadata.index : null;
    if (ai !== null && bi !== null) {
        return Math.abs(ai - bi);
    }
    var ms = INTERVAL_MS[a.timeframe] || 300000;
    var ta = a.sourceOpenTime || 0;
    var tb = b.sourceOpenTime || 0;
    return Math.round(Math.abs(tb - ta) / ms);
}

/**
 * 价格接近 + 间隔合法 → 可配对
 */
function isCompatible(a, b, opts) {
    var apart = barsApart(a, b);
    if (apart < opts.minBarsApart) {
        return false;
    }
    if (apart > opts.maxBarsApart) {
        return false;
    }
    return true;
}

/**
 * 对同一方向的一组 swing 做贪心聚类
 * @returns {Array} group 成员数组的数组
 */
function clusterItems(items, opts) {
    // 按价格升序
    var sorted = items.slice().sort(function (x, y) {
        return x.price - y.price;
    });
    var groups = [];
    var i = 0;
    while (i < sorted.length) {
        var anchor = sorted[i];
        var group = [anchor];
        var tol = toleranceFor(
            anchor.price,
            opts.percentageTolerance,
            opts.tickSize,
            opts.tickMultiplier
        );
        var j = i + 1;
        while (j < sorted.length) {
            var cand = sorted[j];
            // 已按价格排序：与 anchor 的价差超过 tolerance 后，后续只会更远
            if (cand.price - anchor.price > tol) {
                break;
            }
            if (isCompatible(anchor, cand, opts)) {
                group.push(cand);
            }
            j++;
        }
        if (group.length >= opts.minTouches) {
            groups.push(group);
        }
        i = j; // 跳过已考察区域，避免重叠分组 → 不产生 pair duplicate
    }
    return groups;
}

/**
 * 由 group 成员构建统一的 EQH / EQL liquidity 对象
 */
function buildGroup(members, type, side, symbol) {
    // 按时间升序排列成员（stable）
    var sorted = members.slice().sort(function (a, b) {
        return a.sourceOpenTime - b.sourceOpenTime;
    });
    var sum = 0;
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    var maxConfirmed = 0;
    var minOpen = Infinity;
    var maxClose = 0;
    sorted.forEach(function (m) {
        sum += m.price;
        if (m.price < minPrice) minPrice = m.price;
        if (m.price > maxPrice) maxPrice = m.price;
        if (m.confirmedAt > maxConfirmed) maxConfirmed = m.confirmedAt;
        if (m.sourceOpenTime < minOpen) minOpen = m.sourceOpenTime;
        if (m.sourceCloseTime > maxClose) maxClose = m.sourceCloseTime;
    });
    var avgPrice = sum / sorted.length;
    return {
        id: symbol + ':' + type + ':' + minOpen,
        symbol: symbol,
        timeframe: sorted[0].timeframe,
        type: type,
        side: side,
        price: avgPrice,
        sourceOpenTime: minOpen,
        sourceCloseTime: maxClose,
        createdAt: maxConfirmed,
        confirmedAt: maxConfirmed,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {
            minPrice: minPrice,
            maxPrice: maxPrice,
            memberCount: sorted.length,
            members: sorted,
            source: sorted[0].metadata ? sorted[0].metadata.source : null
        }
    };
}

/**
 * 检测 EQH / EQL
 * @param {Array} swings 已确认的 Swing liquidity 数组
 * @param {Object} [options]
 *   symbol, evaluationTime, thresholds(可选覆盖),
 *   percentageTolerance / minBarsApart / maxBarsApart / minTouches / tickSize(可选)
 * @returns {Array} [EQH..., EQL...]
 */
function detectEqualLiquidity(swings, options) {
    var opts = options || {};
    var symbol = opts.symbol || (swings[0] && swings[0].symbol) || 'UNKNOWN';
    var evaluationTime =
        opts.evaluationTime !== undefined ? opts.evaluationTime : Date.now();
    var cfg = opts.thresholds || thresholds.equalLiquidity;
    var tickCfg = (opts.thresholds || thresholds).tickSize || thresholds.tickSize;
    var eOpts = {
        percentageTolerance:
            opts.percentageTolerance !== undefined
                ? opts.percentageTolerance
                : cfg.percentageTolerance,
        minBarsApart:
            opts.minBarsApart !== undefined ? opts.minBarsApart : cfg.minBarsApart,
        maxBarsApart:
            opts.maxBarsApart !== undefined ? opts.maxBarsApart : cfg.maxBarsApart,
        minTouches:
            opts.minTouches !== undefined ? opts.minTouches : cfg.minTouches,
        tickSize: opts.tickSize || 0,
        tickMultiplier:
            opts.tickMultiplier !== undefined
                ? opts.tickMultiplier
                : tickCfg.equalMultiplier
    };

    // 未来数据防线：只允许已确认（confirmedAt <= evaluationTime）的成员参与
    var confirmed = (swings || []).filter(function (s) {
        return s && s.confirmedAt <= evaluationTime;
    });

    var highs = confirmed.filter(function (s) {
        return s.type === 'SWING_HIGH';
    });
    var lows = confirmed.filter(function (s) {
        return s.type === 'SWING_LOW';
    });

    var result = [];
    clusterItems(highs, eOpts).forEach(function (group) {
        result.push(buildGroup(group, 'EQH', 'BSL', symbol));
    });
    clusterItems(lows, eOpts).forEach(function (group) {
        result.push(buildGroup(group, 'EQL', 'SSL', symbol));
    });
    return result;
}

module.exports = {
    toleranceFor: toleranceFor,
    barsApart: barsApart,
    detectEqualLiquidity: detectEqualLiquidity
};
