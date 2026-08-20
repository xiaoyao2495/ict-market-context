/**
 * Phase 12.1 — Pivot Population Audit（2-2 LOCAL_PIVOT 群体分布审计）
 *
 * 背景（用户 2026-08-20）：11L 系列停止后回到 Foundation 层职责混淆问题——
 * 2-2 Pivot 一个对象同时承担 Swing / Structure Reference / Liquidity 三种身份。
 * Phase 12.1 先正名（2-2 输出 = LOCAL_PIVOT，只回答"这里是不是确认后的局部转折"），
 * 再跑 Pivot Population Audit：**先不看 HIGH**，先回答：
 *   "这个算法描述出来的市场结构是否合理？"
 * （分布合理 → 才有资格谈 Phase 12.2 从 Local Pivot 抽 Structural Swing）
 *
 * 审计维度（全部为事后描述性分布，不涉及任何 forward/HIGH 决策）：
 *   a. 总量与密度     ：n、平均每小时个数（bars/12 为统计窗口小时数）
 *   b. 相邻同向距离   ：同方向 pivot 相邻两笔的 index 差，桶 1/2/3/4-6/7-12/13+
 *   c. prominence/ATR ：pivot 后 6 bars 反向极值距 pivot 的距离 / ATR(14)
 *                       桶 <0.25 / 0.25-0.5 / 0.5-1 / 1-2 / >=2（ATR）
 *   d. 穿越寿命       ：pivot 价位被后续多少 bars 再次触及（LOW: low<=price，HIGH: high>=price）
 *                       从 pivotIdx+3 起扫（+1/+2 为确认 bar，pivot 定义保证不触及）
 *                       桶 <=3 / 4-6 / 7-12 / 13-24 / >24（含未穿越）
 *   e. nesting        ：±12 bars 窗口内存在同向 pivot 价格更极端 → 被更大结构包含
 *
 * 纯诊断：pivotDetector / swingLiquidity / 所有消费方零改动。
 */
var DEFAULT_RIGHT = 2;
var PROMINENCE_BARS = 6;
var NEST_WINDOW = 12;
var ATR_N = 14;

function cfgOf(input) {
    var c = input || {};
    return {
        right: c.right !== undefined ? c.right : DEFAULT_RIGHT,
        prominenceBars: c.prominenceBars !== undefined ? c.prominenceBars : PROMINENCE_BARS,
        nestWindow: c.nestWindow !== undefined ? c.nestWindow : NEST_WINDOW,
        atrN: c.atrN !== undefined ? c.atrN : ATR_N
    };
}

/** pivot（swing 包装）的极值 K index */
function pivotIdx(p, idxByClose) {
    if (p && p.metadata && typeof p.metadata.index === 'number') return p.metadata.index;
    if (p && typeof p.confirmedAt === 'number' && idxByClose[p.confirmedAt] !== undefined) {
        return idxByClose[p.confirmedAt];
    }
    return null;
}

function trueRange(c, prev) {
    if (!prev) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
}

/** ATR(N)：截止 upTo（含）前 N 根 True Range 均值 */
function atrAt(candles, upTo, n) {
    var sum = 0;
    var cnt = 0;
    for (var j = upTo; j >= 0 && cnt < n; j--) {
        var c = candles[j];
        if (!c) continue;
        sum += trueRange(c, candles[j - 1]);
        cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
}

/** 相邻同向距离桶（bars）：1 / 2 / 3 / 4-6 / 7-12 / 13+ */
function bucketDist(d) {
    if (d <= 3) return String(d);
    if (d <= 6) return '4-6';
    if (d <= 12) return '7-12';
    return '13+';
}

/** prominence/ATR 桶：<0.25 / 0.25-0.5 / 0.5-1 / 1-2 / >=2 */
function bucketProm(ratio) {
    if (ratio < 0.25) return '<0.25';
    if (ratio < 0.5) return '0.25-0.5';
    if (ratio < 1) return '0.5-1';
    if (ratio < 2) return '1-2';
    return '>=2';
}

/** 穿越寿命桶：<=3 / 4-6 / 7-12 / 13-24 / >24（含未穿越） */
function bucketLife(life) {
    if (life <= 3) return '<=3';
    if (life <= 6) return '4-6';
    if (life <= 12) return '7-12';
    if (life <= 24) return '13-24';
    return '>24';
}

/**
 * Pivot Population Audit。
 * @param {Object} input { pivots（= swings 数组，LOCAL_PIVOT 包装）, candles, bars, right/prominenceBars/nestWindow/atrN }
 * @returns {Object} {
 *   n, highCount, lowCount, bars, perHour,
 *   distSameDir, distProminence, distCrossLife,   // { 桶名: n }
 *   nested: { n, nestedCount, ratio },
 *   unresolved                                      // 无法定位 pivot index 的条数
 * }
 */
function auditPivotPopulation(input) {
    var cfg = cfgOf(input);
    var idxByClose = {};
    (input.candles || []).forEach(function (c, i) {
        if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i;
    });
    var pivots = (input.pivots || []).map(function (p) {
        return { p: p, idx: pivotIdx(p, idxByClose) };
    }).filter(function (e) {
        return e.idx !== null && e.idx !== undefined;
    });
    var unresolved = (input.pivots || []).length - pivots.length;

    var n = pivots.length;
    var highCount = 0;
    var lowCount = 0;
    pivots.forEach(function (e) {
        if (e.p.type === 'SWING_HIGH' || e.p.type === 'HIGH') highCount++;
        else lowCount++;
    });
    var bars = input.bars || (input.candles ? input.candles.length : 0);
    var hours = bars / 12; // 5m
    var perHour = hours > 0 ? n / hours : 0;

    // b. 相邻同向距离
    var distSameDir = {};
    function accBucket(map, k) {
        if (!map[k]) map[k] = 0;
        map[k]++;
    }
    ['HIGH', 'LOW'].forEach(function (type) {
        var list = pivots.filter(function (e) {
            return e.p.type === type || (type === 'HIGH' && e.p.type === 'SWING_HIGH') ||
                (type === 'LOW' && e.p.type === 'SWING_LOW');
        }).sort(function (a, b) { return a.idx - b.idx; });
        for (var i = 1; i < list.length; i++) {
            accBucket(distSameDir, bucketDist(list[i].idx - list[i - 1].idx));
        }
    });

    // c. prominence / ATR
    var distProminence = {};
    var promSkip = 0;
    pivots.forEach(function (e) {
        var idx = e.idx;
        var isLow = e.p.type === 'SWING_LOW' || e.p.type === 'LOW';
        var end = Math.min(idx + cfg.prominenceBars, (input.candles || []).length - 1);
        var extreme = null;
        for (var j = idx + 1; j <= end; j++) {
            var c = (input.candles || [])[j];
            if (!c) continue;
            var v = isLow ? c.high : c.low;
            if (extreme === null) extreme = v;
            else if (isLow ? v > extreme : v < extreme) extreme = v;
        }
        if (extreme === null) { promSkip++; return; }
        var atr = atrAt(input.candles || [], idx, cfg.atrN);
        if (!(atr > 0)) { promSkip++; return; }
        var ratio = Math.abs(extreme - e.p.price) / atr;
        accBucket(distProminence, bucketProm(ratio));
    });

    // d. 穿越寿命
    var distCrossLife = {};
    pivots.forEach(function (e) {
        var idx = e.idx;
        var isLow = e.p.type === 'SWING_LOW' || e.p.type === 'LOW';
        var life = null;
        for (var j = idx + 3; j < (input.candles || []).length; j++) {
            var c = (input.candles || [])[j];
            if (!c) continue;
            if (isLow ? c.low <= e.p.price : c.high >= e.p.price) { life = j - idx; break; }
        }
        if (life === null) life = 25; // 未穿越 → 归入 >24
        accBucket(distCrossLife, bucketLife(life));
    });

    // e. nesting：±nestWindow 内同向 pivot 价格更极端
    var nestedCount = 0;
    pivots.forEach(function (e, i) {
        var isLow = e.p.type === 'SWING_LOW' || e.p.type === 'LOW';
        var lo = e.idx - cfg.nestWindow;
        var hi = e.idx + cfg.nestWindow;
        for (var k = 0; k < pivots.length; k++) {
            if (k === i) continue;
            var q = pivots[k];
            if (q.idx < lo || q.idx > hi) continue;
            var qLow = q.p.type === 'SWING_LOW' || q.p.type === 'LOW';
            if (qLow !== isLow) continue;
            if (isLow ? q.p.price <= e.p.price : q.p.price >= e.p.price) { nestedCount++; break; }
        }
    });

    return {
        n: n,
        highCount: highCount,
        lowCount: lowCount,
        bars: bars,
        perHour: perHour,
        distSameDir: distSameDir,
        distProminence: distProminence,
        distCrossLife: distCrossLife,
        nested: { n: n, nestedCount: nestedCount, ratio: n > 0 ? nestedCount / n : 0 },
        promSkip: promSkip,
        unresolved: unresolved
    };
}

module.exports = {
    auditPivotPopulation: auditPivotPopulation,
    bucketDist: bucketDist,
    bucketProm: bucketProm,
    bucketLife: bucketLife,
    pivotIdx: pivotIdx,
    atrAt: atrAt,
    cfgOf: cfgOf
};
