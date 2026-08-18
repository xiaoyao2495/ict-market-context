/**
 * Phase 11D.5 — DisplacementLeg（candle → leg）
 *
 * 单根 displacement candle 升级为 DisplacementLeg = 1~3 根连续同向 repricing K。
 * ICT 语义：一段 aggressive repricing 留下多个 FVG 是同一个 leg，不是多个独立 displacement。
 *
 * 每个 leg 记录：
 *   direction / startIndex / endIndex / rangeAtr / netMoveAtr / bodyEfficiency /
 *   closeExtreme / mssReferenceId / mssQuality / fvgCount / fvgTotalWidthAtr / didBreakMssReference
 *
 * Leg Quality（诊断分级，不过滤机会）：
 *   WEAK / NORMAL / STRONG / EXPLOSIVE（基于 rangeAtr + netMoveAtr + bodyEfficiency）
 */
var mssReference = require('./mssReference');

var MAX_LEG_BARS = 3; // 1~3 根连续同向

/**
 * @param {Array} displacements displacement 事件（含 candleIndex / direction / metadata.atr / metadata.mssEventId）
 * @param {Array} swings registry swings（classifyMssReference 用）
 * @returns {Array} legs
 */
function buildDisplacementLegs(displacements, swings) {
    var sorted = (displacements || []).slice().sort(function (a, b) {
        return a.candleIndex - b.candleIndex;
    });
    var legs = [];
    var cur = null;
    sorted.forEach(function (d) {
        if (cur &&
            cur.direction === d.direction &&
            d.candleIndex === cur.lastIndex + 1 &&
            cur.count < MAX_LEG_BARS) {
            cur.ids.push(d.id);
            cur.lastIndex = d.candleIndex;
            cur.count++;
            cur.lastConfirmedAt = d.confirmedAt;
            if (!cur.mssId && d.metadata && d.metadata.mssEventId) {
                cur.mssId = d.metadata.mssEventId;
            }
            return;
        }
        if (cur) {
            legs.push(finalizeLeg(cur, swings));
        }
        cur = {
            ids: [d.id],
            direction: d.direction,
            startIndex: d.candleIndex,
            lastIndex: d.candleIndex,
            firstConfirmedAt: d.confirmedAt,
            lastConfirmedAt: d.confirmedAt,
            count: 1,
            mssId: d.metadata && d.metadata.mssEventId ? d.metadata.mssEventId : null,
            atr: d.metadata ? d.metadata.atr : null
        };
    });
    if (cur) {
        legs.push(finalizeLeg(cur, swings));
    }
    return legs;
}

function finalizeLeg(leg, swings) {
    // 维度默认（candles 由调用方补充 rangeAtr 等——本函数只算可从 events 得的）
    var out = {
        id: 'LEG:' + leg.ids[0],
        direction: leg.direction,
        startIndex: leg.startIndex,
        endIndex: leg.lastIndex,
        bars: leg.count,
        ids: leg.ids,
        mssId: leg.mssId || null,
        firstConfirmedAt: leg.firstConfirmedAt,
        lastConfirmedAt: leg.lastConfirmedAt,
        atr: leg.atr !== null && leg.atr !== undefined ? leg.atr : null,
        rangeAtr: null,
        netMoveAtr: null,
        bodyEfficiency: null,
        closeExtreme: null,
        didBreakMssReference: null,
        quality: 'WEAK',
        fvgCount: 0,
        fvgTotalWidthAtr: null
    };
    // MSS reference quality
    if (leg.mssId) {
        var mssEvent = null;
        // mssEvent 由调用方注入（leg.mssEvent）
        if (leg.mssEvent) {
            mssEvent = leg.mssEvent;
        }
        if (mssEvent) {
            var cls = mssReference.classifyMssReference(mssEvent, swings || []);
            out.mssQuality = cls.quality;
            out.didBreakMssReference = true;
        } else {
            out.mssQuality = 'NO_MSS';
        }
    } else {
        out.mssQuality = 'NO_MSS';
    }
    return out;
}

/**
 * 用 candles 补全 leg 的价量维度（rangeAtr / netMoveAtr / bodyEfficiency / closeExtreme）
 * 需在 leg 上挂 candles 引用（调用方传 candles 数组）
 */
function enrichLegWithCandles(leg, candles) {
    var start = candles[leg.startIndex];
    var end = candles[leg.endIndex];
    var atr = leg.atr !== null && leg.atr !== undefined ? leg.atr : null;
    if (!start || !end) {
        return leg;
    }
    var bullish = leg.direction === 'BULLISH';
    var high = start.high;
    var low = start.low;
    for (var i = leg.startIndex; i <= leg.endIndex; i++) {
        var c = candles[i];
        if (!c) continue;
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
    }
    var range = high - low;
    var netMove = Math.abs(end.close - start.open);
    leg.rangeAtr = atr && atr > 0 ? range / atr : null;
    leg.netMoveAtr = atr && atr > 0 ? netMove / atr : null;
    var totalBody = 0;
    var totalRange = 0;
    for (var k = leg.startIndex; k <= leg.endIndex; k++) {
        var ck = candles[k];
        if (!ck) continue;
        totalBody += Math.abs(ck.close - ck.open);
        totalRange += (ck.high - ck.low);
    }
    leg.bodyEfficiency = totalRange > 0 ? totalBody / totalRange : 0;
    leg.closeExtreme = bullish
        ? (end.high - end.close) / Math.max(end.high - end.low, 1e-12)
        : (end.close - end.low) / Math.max(end.high - end.low, 1e-12);
    return leg;
}

/**
 * Leg Quality 分级（诊断，启发式阈值）：
 *   EXPLOSIVE  rangeAtr >= 2.5 && netMoveAtr >= 2 && bodyEfficiency >= 0.6
 *   STRONG     rangeAtr >= 1.8 && netMoveAtr >= 1.2
 *   NORMAL     rangeAtr >= 1.0
 *   WEAK       其他
 */
function classifyLegQuality(leg) {
    if (leg.rangeAtr === null || leg.rangeAtr === undefined) {
        leg.quality = 'WEAK';
        return leg.quality;
    }
    var r = leg.rangeAtr;
    var n = leg.netMoveAtr !== null && leg.netMoveAtr !== undefined ? leg.netMoveAtr : 0;
    var be = leg.bodyEfficiency !== null && leg.bodyEfficiency !== undefined ? leg.bodyEfficiency : 0;
    if (r >= 2.5 && n >= 2 && be >= 0.6) {
        leg.quality = 'EXPLOSIVE';
    } else if (r >= 1.8 && n >= 1.2) {
        leg.quality = 'STRONG';
    } else if (r >= 1.0) {
        leg.quality = 'NORMAL';
    } else {
        leg.quality = 'WEAK';
    }
    return leg.quality;
}

/**
 * Phase 11L.1 — 共享增量 Leg Builder（Live/Replay 单一实现）
 * 语义与 buildDisplacementLegs 完全一致（连续同向、candleIndex 相邻、最多 MAX_LEG_BARS 根）：
 *   feed(displacement) → 合并到 openLeg，或关闭旧 leg 并返回 { closed, opened }。
 * 实时引擎与离线批处理调用同一实现 → 消除 Live/Replay leg 边界差异。
 */
function createLegBuilder() {
    var open = null;
    function feed(d) {
        var closed = null;
        if (open &&
            open.direction === d.direction &&
            d.candleIndex === open.lastIndex + 1 &&
            open.count < MAX_LEG_BARS) {
            open.ids.push(d.id);
            open.lastIndex = d.candleIndex;
            open.lastConfirmedAt = d.confirmedAt;
            open.count++;
            if (d.metadata && d.metadata.atr !== undefined) open.atr = d.metadata.atr;
            if (!open.mssId && d.metadata && d.metadata.mssEventId) open.mssId = d.metadata.mssEventId;
            return { closed: null, opened: open, merged: true };
        }
        if (open) {
            closed = open;
            open = null;
        }
        open = {
            ids: [d.id],
            direction: d.direction,
            startIndex: d.candleIndex,
            lastIndex: d.candleIndex,
            firstConfirmedAt: d.confirmedAt,
            lastConfirmedAt: d.confirmedAt,
            count: 1,
            mssId: d.metadata && d.metadata.mssEventId ? d.metadata.mssEventId : null,
            atr: d.metadata && d.metadata.atr !== undefined ? d.metadata.atr : null
        };
        return { closed: closed, opened: open, merged: false };
    }
    function close() {
        var closed = open;
        open = null;
        return closed;
    }
    /**
     * Fix 2（11L.2）：按时间过期关闭 —— 若 open leg 的 lastConfirmedAt 距今 >= mergeMs，
     * 说明"过去一个窗口内没有新的同向 displacement"，leg 已结束，应关闭并评估机会。
     * Live 常驻进程没有"数据结束"，必须每根收盘调用（避免 LATE/永不推送）。
     * 等价于 Replay 批处理中"排序 feed 后 close tail"的窗口语义。
     * @param {number} evaluationTime 当前 5m 收盘时间
     * @returns {Object|null} 关闭的 leg；未到过期时间返回 null
     */
    function closeExpired(evaluationTime) {
        if (!open) return null;
        if (evaluationTime - open.lastConfirmedAt >= MS) {
            var expired = open;
            open = null;
            return expired;
        }
        return null;
    }
    return {
        feed: feed, close: close, closeExpired: closeExpired,
        isOpen: function () { return open !== null; }, getOpen: function () { return open; }
    };
}

/**
 * Phase 11L.1 — 共享 15min 时间窗 Leg Builder（authoritative，与 buildOpportunities 合并语义一致）
 * 合并条件：同向 && confirmedAt 差 <= mergeMs（不限根数，允许 gap）。
 * Replay（机会身份）与 Live（增量）用同一实现 → 消除 Live/Replay leg 边界差异。
 */
function createWindowedLegBuilder(mergeMs) {
    var MS = mergeMs || 900000; // 默认 15 分钟
    var open = null;
    function feed(d) {
        var closed = null;
        if (open && open.direction === d.direction &&
            (d.confirmedAt - open.lastConfirmedAt) <= MS) {
            open.ids.push(d.id);
            open.lastIndex = d.candleIndex;
            open.lastConfirmedAt = d.confirmedAt;
            open.count++;
            if (d.metadata && d.metadata.atr !== undefined) open.atr = d.metadata.atr;
            if (!open.mssId && d.metadata && d.metadata.mssEventId) open.mssId = d.metadata.mssEventId;
            return { closed: null, opened: open, merged: true };
        }
        if (open) { closed = open; open = null; }
        open = {
            ids: [d.id],
            direction: d.direction,
            startIndex: d.candleIndex,
            lastIndex: d.candleIndex,
            firstConfirmedAt: d.confirmedAt,
            lastConfirmedAt: d.confirmedAt,
            count: 1,
            mssId: d.metadata && d.metadata.mssEventId ? d.metadata.mssEventId : null,
            atr: d.metadata && d.metadata.atr !== undefined ? d.metadata.atr : null
        };
        return { closed: closed, opened: open, merged: false };
    }
    function close() {
        var closed = open;
        open = null;
        return closed;
    }
    /**
     * Fix 2（11L.2）：按时间过期关闭 —— 若 open leg 的 lastConfirmedAt 距今 >= mergeMs，
     * 说明"过去一个窗口内没有新的同向 displacement"，leg 已结束，应关闭并评估机会。
     * Live 常驻进程没有"数据结束"，必须每根收盘调用（避免 LATE/永不推送）。
     * 等价于 Replay 批处理中"排序 feed 后 close tail"的窗口语义。
     * @param {number} evaluationTime 当前 5m 收盘时间
     * @returns {Object|null} 关闭的 leg；未到过期时间返回 null
     */
    function closeExpired(evaluationTime) {
        if (!open) return null;
        if (evaluationTime - open.lastConfirmedAt >= MS) {
            var expired = open;
            open = null;
            return expired;
        }
        return null;
    }
    return {
        feed: feed, close: close, closeExpired: closeExpired,
        isOpen: function () { return open !== null; }, getOpen: function () { return open; }
    };
}

/**
 * Phase 11L.1 — 共享 leg 索引（Replay 报告层与 Live 共用的 authoritative 构建）
 * displacementEvents（按 confirmedAt 排序）→ windowed legs → legByDispId
 * （含 enrich 价量维度 + legQuality + mssQuality 重算，与 live 评估完全一致）
 * @returns {Object} dispId → leg
 */
function buildWindowedLegIndex(displacements, candles, mssEvents, swings, mergeMs) {
    var sorted = (displacements || []).slice().sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    var builder = createWindowedLegBuilder(mergeMs);
    var legs = [];
    sorted.forEach(function (d) {
        var r = builder.feed(d);
        if (r.closed) legs.push(r.closed);
    });
    var tail = builder.close();
    if (tail) legs.push(tail);
    var mssById = {};
    (mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    var idx = {};
    legs.forEach(function (l) {
        l.endIndex = l.lastIndex; // enrichLegWithCandles 期望 endIndex
        enrichLegWithCandles(l, candles || []);
        classifyLegQuality(l);
        if (l.mssId && mssById[l.mssId]) {
            l.mssQuality = mssReference.classifyMssReference(mssById[l.mssId], swings || []).quality;
        } else {
            l.mssQuality = 'NO_MSS';
        }
        (l.ids || []).forEach(function (id) { idx[id] = l; });
    });
    return idx;
}

module.exports = {
    buildDisplacementLegs: buildDisplacementLegs,
    enrichLegWithCandles: enrichLegWithCandles,
    classifyLegQuality: classifyLegQuality,
    createLegBuilder: createLegBuilder,
    createWindowedLegBuilder: createWindowedLegBuilder,
    buildWindowedLegIndex: buildWindowedLegIndex,
    MAX_LEG_BARS: MAX_LEG_BARS
};
