/**
 * Retrace Tracker（Phase 11S.1 — Retrace Diagnostics）
 *
 * 目标：回答"WATCH → WAITING_RETRACE 时，价格到底离 FVG zone 有多远"。
 * 只诊断，不改变正式 Entry Gate（ENTRY_READY 判定冻结）。
 *
 * 机制：
 *   1. WATCH + WAITING_RETRACE + primary FVG 出现时，冻结一个 zone（watchId 唯一）
 *   2. 之后每根 K 追踪真实价格与该 zone 的距离（不重新选 FVG，zone 冻结）
 *   3. WATCH 结束 / scenario 失效 / 数据结束时关闭并分类
 *
 * distanceToZone（0 = 真实进入 zone）：
 *   BULLISH: max(0, candle.low - zoneHigh)   （价格在 zone 上方，距上沿）
 *   BEARISH: max(0, zoneLow - candle.high)   （价格在 zone 下方，距下沿）
 *
 * 分类（关闭时）：
 *   TOUCHED_ZONE            真实进入过 zone（low <= zoneHigh / high >= zoneLow）
 *   NEAR_MISS_0_05_ATR      minDistanceAtr <= 0.05
 *   NEAR_MISS_0_10_ATR      minDistanceAtr <= 0.10
 *   NEAR_MISS_0_25_ATR      minDistanceAtr <= 0.25
 *   NEVER_CLOSE             从未接近（minDistanceAtr > 0.25）
 *   INVALIDATED_BEFORE_RETRACE  scenario 失效且从未接近（minDistanceAtr > 0.25）
 */

var CLASS = {
    TOUCHED_ZONE: 'TOUCHED_ZONE',
    NEAR_MISS_0_05_ATR: 'NEAR_MISS_0_05_ATR',
    NEAR_MISS_0_10_ATR: 'NEAR_MISS_0_10_ATR',
    NEAR_MISS_0_25_ATR: 'NEAR_MISS_0_25_ATR',
    NEVER_CLOSE: 'NEVER_CLOSE',
    INVALIDATED_BEFORE_RETRACE: 'INVALIDATED_BEFORE_RETRACE'
};

var CLOSE_REASON = {
    WATCH_END: 'WATCH_END',         // scenario 离开 WATCH（正常转移）
    INVALIDATED: 'INVALIDATED',     // gate/AMD/scenario 失效
    DATA_END: 'DATA_END'            // 回放数据结束强制关闭
};

var narrativeBoundary = require('../stats/narrativeBoundary');

/**
 * 距离定义：0 = 真实进入 zone
 * @returns {number} >= 0
 */
function distanceToZone(direction, candle, zoneLow, zoneHigh) {
    if (!candle) {
        return Infinity;
    }
    if (direction === 'BULLISH') {
        return Math.max(0, candle.low - zoneHigh);
    }
    if (direction === 'BEARISH') {
        return Math.max(0, zoneLow - candle.high);
    }
    return Infinity;
}

/**
 * 创建 retrace 记录（WATCH + WAITING_RETRACE + primary FVG 冻结）
 * @param {Object} meta {
 *   symbol, direction ('BULLISH'|'BEARISH'), fvg, watchIndex, watchAt,
 *   atr, draw (快照), amd (快照), swings, tickSize, candle (创建那根)
 * }
 */
function createRetrace(meta) {
    var f = meta.fvg || {};
    var ret = {
        watchId: meta.symbol + ':WATCH:' + meta.watchIndex,
        symbol: meta.symbol,
        direction: meta.direction,
        fvgId: f.id || null,
        zoneLow: f.zoneLow,
        zoneHigh: f.zoneHigh,
        midpoint: f.midpoint !== undefined ? f.midpoint : (f.zoneLow + f.zoneHigh) / 2,
        watchIndex: meta.watchIndex,
        watchAt: meta.watchAt,
        atrAtWatch: meta.atr || null,

        // 初始距离
        initialDistance: null,
        initialDistanceAtr: null,

        // 逐根追踪
        minDistanceToZone: Infinity,
        minDistanceAtr: Infinity,
        barsToClosestApproach: null,
        barsWatched: 0,
        touchedZone: false,
        touchedMidpoint: false,
        filledZone: false,

        // 未来 12/24 bars 快照（达到时的累计 min 信息）
        future12Bars: null,
        future24Bars: null,

        // 关闭
        closeIndex: null,
        closeAt: null,
        closeReason: null,
        classification: null,

        // 上下文快照（shadow entry 用）
        draw: meta.draw || null,
        amd: meta.amd || null,
        swings: meta.swings || [],
        tickSize: meta.tickSize || 0,

        // ---- Phase 11T.3：Narrative Boundary Integrity（诊断字段） ----
        // WATCH 建立时冻结的 boundary snapshot（Pipeline 是否丢失的对照基准）
        boundaryAtWatch: narrativeBoundary.boundaryFromAmd(meta.amd),
        // WATCH 时 alignment（MATCH/OPPOSITE/UNCONFIRMED）与 bias 方向快照
        alignmentAtWatch: meta.alignment || null,
        biasAtWatch: meta.bias || null,
        // primary FVG 的 score（fvgScorer 输出存于 f._score）
        fvgScoreAtWatch: meta.fvg
            ? (meta.fvg._score !== undefined ? meta.fvg._score
                : meta.fvg.score !== undefined ? meta.fvg.score : null)
            : null,

        // shadow 结果（stats/shadowEntry 填充）
        shadowResults: []
    };

    // 初始距离（创建那根 K）
    if (meta.candle) {
        var d = distanceToZone(meta.direction, meta.candle, ret.zoneLow, ret.zoneHigh);
        ret.initialDistance = Math.round(d * 100) / 100;
        ret.initialDistanceAtr = meta.atr > 0 ? Math.round((d / meta.atr) * 10000) / 10000 : null;
    }

    return ret;
}

/**
 * 每根 K 更新距离追踪（WATCH 期间调用）
 */
function updateRetrace(retrace, candle, index, atr) {
    retrace.barsWatched++;

    var d = distanceToZone(retrace.direction, candle, retrace.zoneLow, retrace.zoneHigh);
    var dAtr = atr > 0 ? d / atr : Infinity;

    if (d < retrace.minDistanceToZone - 1e-12) {
        retrace.minDistanceToZone = Math.round(d * 100) / 100;
        retrace.minDistanceAtr = Math.round(dAtr * 10000) / 10000;
        retrace.barsToClosestApproach = retrace.barsWatched;
    }

    // 进入 zone / 中位 / 填满
    if (retrace.direction === 'BULLISH') {
        if (candle.low <= retrace.zoneHigh) retrace.touchedZone = true;
        if (candle.low <= retrace.midpoint) retrace.touchedMidpoint = true;
        if (candle.low <= retrace.zoneLow) retrace.filledZone = true;
    } else {
        if (candle.high >= retrace.zoneLow) retrace.touchedZone = true;
        if (candle.high >= retrace.midpoint) retrace.touchedMidpoint = true;
        if (candle.high >= retrace.zoneHigh) retrace.filledZone = true;
    }

    // future12 / future24 快照（达到时的累计 min）
    if (retrace.barsWatched === 12) {
        retrace.future12Bars = {
            bars: 12,
            minDistanceToZone: retrace.minDistanceToZone,
            minDistanceAtr: retrace.minDistanceAtr,
            touchedZone: retrace.touchedZone
        };
    }
    if (retrace.barsWatched === 24) {
        retrace.future24Bars = {
            bars: 24,
            minDistanceToZone: retrace.minDistanceToZone,
            minDistanceAtr: retrace.minDistanceAtr,
            touchedZone: retrace.touchedZone
        };
    }
}

/**
 * 关闭 retrace 并分类
 */
function closeRetrace(retrace, index, evaluationTime, closeReason) {
    retrace.closeIndex = index;
    retrace.closeAt = evaluationTime;
    retrace.closeReason = closeReason;
    retrace.classification = classifyRetrace(retrace, closeReason);
    return retrace;
}

/**
 * 分类优先级：
 *   1. 真实进入 zone → TOUCHED_ZONE
 *   2. minDistanceAtr 分桶 → NEAR_MISS_x
 *   3. 从未接近：失效 → INVALIDATED_BEFORE_RETRACE；否则 NEVER_CLOSE
 */
function classifyRetrace(retrace, closeReason) {
    if (retrace.touchedZone || retrace.filledZone) {
        return CLASS.TOUCHED_ZONE;
    }
    var dAtr = retrace.minDistanceAtr;
    if (dAtr <= 0.05 + 1e-12) {
        return CLASS.NEAR_MISS_0_05_ATR;
    }
    if (dAtr <= 0.10 + 1e-12) {
        return CLASS.NEAR_MISS_0_10_ATR;
    }
    if (dAtr <= 0.25 + 1e-12) {
        return CLASS.NEAR_MISS_0_25_ATR;
    }
    if (closeReason === CLOSE_REASON.INVALIDATED) {
        return CLASS.INVALIDATED_BEFORE_RETRACE;
    }
    return CLASS.NEVER_CLOSE;
}

module.exports = {
    CLASS: CLASS,
    CLOSE_REASON: CLOSE_REASON,
    distanceToZone: distanceToZone,
    createRetrace: createRetrace,
    updateRetrace: updateRetrace,
    closeRetrace: closeRetrace,
    classifyRetrace: classifyRetrace
};
