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

module.exports = {
    buildDisplacementLegs: buildDisplacementLegs,
    enrichLegWithCandles: enrichLegWithCandles,
    classifyLegQuality: classifyLegQuality,
    MAX_LEG_BARS: MAX_LEG_BARS
};
