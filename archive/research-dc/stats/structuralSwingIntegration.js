/**
 * Phase 12.4 — Structural Swing Integration Shadow（完整 HIGH 链路 + 四象限审计）
 *
 * 背景（用户 2026-08-20 定案）：DC 1.5 判活。验证 DC Structural Swing 的结构优势进入完整
 * 链路后是否仍存在（不只在 MSS 层漂亮）。两套链完全并行：
 *   PRODUCTION: 2-2 LOCAL_PIVOT → Legacy Swing → Legacy MSS → Displacement → HIGH
 *   SHADOW    : DC 1.5 STRUCTURAL_SWING → DC MSS → Displacement → Shadow HIGH
 * 纪律：只换 MSS reference source（swings+MSS 配套替换），**不碰 Liquidity**
 * （fvgs / drawTrace / sweepEvents / candles 全部同一份）→ 单变量。
 *
 * 核心交付：四象限（BOTH / LEGACY_ONLY / DC_ONLY / NEITHER）分别统计
 *   n / NearHit30m / NearHit1h / MFE1h / MAE1h / hasStrongDispRate /
 *   strongDispPerAlert / breakPctMedian
 * 期望：LEGACY_ONLY forward 明显更差（DC 删除了假结构）+ DC_ONLY 至少不差（发现新结构）。
 *
 * 【disp 指标修正（用户 12.4 要求）】：不再输出 "111.3%" 这种每 MSS 可多次命中的命中率，
 * 拆成 hasStrongDisplacementRate（至少一次的比例）+ strongDisplacementCountPerAlert（平均次数）。
 * StrongLeg 统计统一用 legacy displacement 事件（客观价格强位移，两套一致，不因 structure source 漂移）。
 *
 * 纯诊断：生产 detector / MSS / 通知全部零改动。
 */
var mssDetector = require('../events/mssDetector');
var displacementDetector = require('../events/displacementDetector');
var displacementLeg = require('./displacementLeg');
var opportunity = require('./opportunity');
var alertReplay = require('./alertReplay');
var directionalChangeAudit = require('./directionalChangeAudit');

var DEFAULT_K = 1.5; // 12.4 冻结：DC 1.5 ATR
var MAX_ANCHOR_DELTA = 2; // 四象限对齐容差（bars，10min——MSS 换源后 anchor 可能偏移 1-2）
var W30M = 6;
var W1H = 12;

function medianSorted(arr) {
    if (arr.length === 0) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    if (a.length % 2 === 1) return a[mid];
    return (a[mid - 1] + a[mid]) / 2;
}

/**
 * 构建完整链路 alerts（legacy 或 DC 一套）。
 * @param {Object} ctx { candles, fvgs, drawTrace, sweepEvents, symbol, timeframe }
 * @param {Array} mssEvents
 * @param {Array} swings（与 mssEvents 配套：legacy swings 或 DC swings）
 * @returns {Array} alerts（buildAlerts 输出，含 tier）
 */
function buildChainAlerts(ctx, mssEvents, swings) {
    // displacement 用同一价格检测器，但 same-candle MSS bonus + mssEventId 跟随本套 MSS
    var disp = displacementDetector.detectDisplacement(ctx.candles, mssEvents, {
        symbol: ctx.symbol,
        timeframe: ctx.timeframe
    });
    var legByDispId = displacementLeg.buildWindowedLegIndex(disp, ctx.candles, mssEvents, swings);
    var opps = opportunity.buildOpportunities(ctx.symbol, ctx.fvgs || [], {
        DISPLACEMENT: disp,
        MSS: mssEvents
    });
    return alertReplay.buildAlerts(opps, ctx.fvgs || [], legByDispId, ctx.drawTrace || [],
        ctx.sweepEvents || [], ctx.candles, mssEvents);
}

/**
 * 构建两套完整链路（legacy + DC shadow）。
 * @param {Object} ctx { candles, fvgs, drawTrace, sweepEvents, symbol, timeframe }
 * @param {Array} legacySwings replay result.swings
 * @param {Array} dcRawSwings directionalChangeAudit.buildDcSwings 输出（k=1.5 close）
 * @returns {Object} { legacy: { swings, mss, alerts }, dc: { swings, mss, alerts }, k }
 */
function buildShadowAlerts(ctx, legacySwings, dcRawSwings) {
    var k = ctx.k !== undefined ? ctx.k : DEFAULT_K;
    var dcSwings = packageDcForMss(dcRawSwings, ctx.symbol, ctx.timeframe, ctx.candles);
    var legacyMss = mssDetector.detectMss(ctx.candles, legacySwings || [], {
        symbol: ctx.symbol, timeframe: ctx.timeframe, consumedRefs: {}
    });
    var dcMss = mssDetector.detectMss(ctx.candles, dcSwings, {
        symbol: ctx.symbol, timeframe: ctx.timeframe, consumedRefs: {}
    });
    return {
        legacy: {
            swings: legacySwings || [],
            mss: legacyMss,
            alerts: buildChainAlerts(ctx, legacyMss, legacySwings || [])
        },
        dc: {
            swings: dcSwings,
            mss: dcMss,
            alerts: buildChainAlerts(ctx, dcMss, dcSwings)
        },
        k: k
    };
}

/** DC swings → mssDetector 兼容格式（confirmedAt 转时间戳，future-safety） */
function packageDcForMss(dcRaw, symbol, timeframe, candles) {
    return (dcRaw || []).map(function (s) {
        var type = s.direction === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW';
        var confTs = candles && candles[s.confirmedAt] ? candles[s.confirmedAt].closeTime : s.confirmedAt;
        return {
            id: (symbol || 'X') + ':DC:' + type + ':' + confTs + ':' + s.extremeIndex,
            symbol: symbol || 'X',
            timeframe: timeframe || '5m',
            type: type,
            side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
            price: s.price,
            confirmedAt: confTs,
            metadata: { source: 'dc', dcK: kOrDefault(s), replacements: s.replacements,
                extremeIndex: s.extremeIndex, occurredAt: s.occurredAt, extremeATR: s.extremeATR,
                // classifyMssReference 依赖 metadata.index 算 referenceAgeBars/wasLatestOpposingSwing
                // （缺失 → NO_REFERENCE/INTERNAL 永不到 PROTECTED_SWING → 无 HIGH）——必须带
                index: s.extremeIndex }
        };
    });
}
function kOrDefault(s) {
    return s && s.dcK !== undefined ? s.dcK : DEFAULT_K;
}

/**
 * 四象限划分（只取 tier === 'HIGH_QUALITY'）。
 * 对齐：direction 相同 && |anchorIndex 差| <= MAX_ANCHOR_DELTA → BOTH。
 * @returns {Object} { both: [], legacyOnly: [], dcOnly: [], legacyN, dcN }
 */
function quadrantSplit(legacyAlerts, dcAlerts, maxDelta) {
    var delta = maxDelta !== undefined ? maxDelta : MAX_ANCHOR_DELTA;
    function high(alerts) {
        return (alerts || []).filter(function (a) { return a.tier === 'HIGH_QUALITY'; });
    }
    var lh = high(legacyAlerts);
    var dh = high(dcAlerts);
    var usedDc = {};
    var both = [];
    var legacyOnly = [];
    lh.forEach(function (la) {
        var match = null;
        for (var i = 0; i < dh.length; i++) {
            var da = dh[i];
            if (usedDc[i]) continue;
            if (da.direction !== la.direction) continue;
            if (Math.abs(da.anchorIndex - la.anchorIndex) > delta) continue;
            match = da;
            usedDc[i] = true;
            break;
        }
        if (match) both.push({ legacy: la, dc: match });
        else legacyOnly.push(la);
    });
    var dcOnly = [];
    dh.forEach(function (da, i) {
        if (!usedDc[i]) dcOnly.push(da);
    });
    return { both: both, legacyOnly: legacyOnly, dcOnly: dcOnly, legacyN: lh.length, dcN: dh.length };
}

/**
 * 象限 delivery 评估（从 availableIndex+1 起，notification 快照口径）。
 * @param {Array} alerts 象限内 alert 数组（或 both 里取 legacy/dc 一侧）
 * @param {Array} candles
 * @param {Object} dispByIndex legacy displacement 按 candleIndex（统一 StrongLeg 口径）
 * @param {Object} legByDispIdLegacy legacy leg 质量（统一口径）
 * @returns {Object} { n, nearHit30m, nearHit1h, nearCnt30m, nearCnt1h,
 *   mfe1h, mae1h, hasStrongRate, strongDispPerAlert, breakPctMedian }
 */
function assessQuadrant(alerts, candles, dispByIndex, legByDispIdLegacy) {
    var out = { n: 0, nearHit30m: 0, nearHit1h: 0, nearCnt30m: 0, nearCnt1h: 0,
        mfeSum: 0, maeSum: 0, hasStrong: 0, strongDispTotal: 0, breakPcts: [] };
    (alerts || []).forEach(function (al) {
        if (al.tier !== 'HIGH_QUALITY') return;
        out.n++;
        var availIdx = al.availableIndex !== undefined ? al.availableIndex : al.anchorIndex;
        var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
        if (start === null || start >= candles.length) return; // incomplete（与 assessAlerts 同口径）
        var base = al.notificationPrice !== undefined && al.notificationPrice !== null
            ? al.notificationPrice : al.anchorPrice;
        var target = al.notificationNearTarget !== undefined && al.notificationNearTarget !== null
            ? al.notificationNearTarget : al.nearTarget;
        var bullish = al.direction === 'BULLISH';
        var mfe = 0, mae = 0;
        var hit30 = false, hit1h = false;
        var strongCount = 0;
        var end1h = Math.min(start + W1H - 1, candles.length - 1);
        for (var j = start; j <= end1h; j++) {
            var c = candles[j];
            if (!c) break;
            if (bullish) {
                if (c.high - base > mfe) mfe = c.high - base;
                if (base - c.low > mae) mae = base - c.low;
            } else {
                if (base - c.low > mfe) mfe = base - c.low;
                if (c.high - base > mae) mae = base - c.high;
            }
            if (target !== null && target !== undefined) {
                if (bullish && c.high >= target) hit1h = true;
                if (!bullish && c.low <= target) hit1h = true;
                if (j <= start + W30M - 1) {
                    if (bullish && c.high >= target) hit30 = true;
                    if (!bullish && c.low <= target) hit30 = true;
                }
            }
            var dispList = (dispByIndex && dispByIndex[j]) || [];
            for (var d = 0; d < dispList.length; d++) {
                if (dispList[d].direction !== al.direction) continue;
                var leg = legByDispIdLegacy && legByDispIdLegacy[dispList[d].id];
                if (leg && (leg.quality === 'STRONG' || leg.quality === 'EXPLOSIVE')) strongCount++;
            }
        }
        if (target !== null && target !== undefined) {
            out.nearCnt30m++;
            out.nearCnt1h++;
            if (hit30) out.nearHit30m++;
            if (hit1h) out.nearHit1h++;
        }
        if (base > 0) {
            out.mfeSum += mfe / base * 100;
            out.maeSum += mae / base * 100;
        }
        if (strongCount > 0) out.hasStrong++;
        out.strongDispTotal += strongCount;
        if (typeof al.mssBreakPct === 'number') out.breakPcts.push(al.mssBreakPct);
    });
    return {
        n: out.n,
        nearHit30m: out.nearCnt30m > 0 ? out.nearHit30m / out.nearCnt30m : null,
        nearHit1h: out.nearCnt1h > 0 ? out.nearHit1h / out.nearCnt1h : null,
        mfe1h: out.n > 0 ? out.mfeSum / out.n : null,
        mae1h: out.n > 0 ? out.maeSum / out.n : null,
        hasStrongRate: out.n > 0 ? out.hasStrong / out.n : null,
        strongDispPerAlert: out.n > 0 ? out.strongDispTotal / out.n : null,
        breakPctMedian: medianSorted(out.breakPcts)
    };
}

module.exports = {
    buildShadowAlerts: buildShadowAlerts,
    buildChainAlerts: buildChainAlerts,
    quadrantSplit: quadrantSplit,
    assessQuadrant: assessQuadrant,
    packageDcForMss: packageDcForMss,
    DEFAULT_K: DEFAULT_K,
    MAX_ANCHOR_DELTA: MAX_ANCHOR_DELTA
};
