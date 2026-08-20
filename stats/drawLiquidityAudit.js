/**
 * Phase 13 — Draw on Liquidity Quantification（V1 shadow，纯诊断）
 *
 * 用户定案（2026-08-20）：不直接造 BiasScore。量化的不是"涨跌"，而是
 * "价格下一阶段更可能向哪个 Liquidity Object 交付"。
 *
 * 结构（三层）：
 *   ① Liquidity Map：上方 BSL / 下方 SSL 候选池（ACTIVE 未 take）。
 *      候选来源（全部 categorical，不编码权重）：
 *        PDH/PDL/PWH/PWL、Session H/L、EQH/EQL（registry）、
 *        SWING_HIGH/LOW（registry 的 legacy swing）、
 *        DC STRUCTURAL_SWING（buildDcSwings 包装，仅作 candidate，不假定 significant）
 *   ② 每候选特征向量（原始字段，无总分）：
 *        type / side / distanceATR（ATR 归一）/ ageBars / touchCount / closeCrossCount /
 *        rangePosition+zone（dealing range）/ htfStructure（h1/h4 趋势）/ deliveryAlignment
 *   ③ Future Label（只进 label 不进 feature）：
 *        从 t 起未来第一个被 raid 的 ACTIVE 候选 → nextDrawSide/type/barsToDraw
 *
 * 纪律（用户）：
 *   - 未来信息只能用于 label；feature 全部截至 t（confirmedAt <= t、htf 截至 t、无前瞻）
 *   - 生命周期：FORMING→CONFIRMED→ACTIVE→RAIDED/TAKEN→RETIRED；
 *     已被 take 的 liquidity 不能继续作为当前 Draw（ETH EQH @ 2267 案例）
 *   - 同时维护 Upper Draw 和 Lower Draw，输出 PRIMARY_UP/PRIMARY_DOWN/BALANCED/UNCLEAR
 *   - V1 不做总分/不设权重：先输出特征向量 + 90d 回放，回答
 *     "能否比随机/最近距离 baseline 更好地预测下一个被拿掉的 liquidity？"
 *   - 与 HIGH detector 完全解耦：Context Engine 判断 delivery 是否符合 narrative，
 *     不反向定义 HIGH。
 *
 * 生产零改动（replay 仅加只读 liquidityObjects 输出字段）。
 */
var dcStructuralSwing = require('../structure/dcStructuralSwing');

var BAR_MS = 300000;
var HORIZON_BARS = 96; // label 窗口：未来 8h（96 × 5m）内找下一个被 raid 的候选

/** 类型分组（categorical；用户明确不写死权重） */
function typeGroup(type) {
    var t = String(type || '').toUpperCase();
    if (t === 'PDH' || t === 'PDL') return 'PD';
    if (t === 'PWH' || t === 'PWL') return 'PW';
    if (t.indexOf('SESSION') === 0 || t.indexOf('ASIA') === 0 || t.indexOf('LONDON') === 0 || t.indexOf('NEW_YORK') === 0) return 'SESSION';
    if (t === 'EQH' || t === 'EQL') return 'EQL';
    if (t === 'SWING_HIGH' || t === 'SWING_LOW') return 'SWING';
    if (t === 'DC_SWING_HIGH' || t === 'DC_SWING_LOW') return 'DC_SWING';
    return 'OTHER';
}

/**
 * 候选标准化：统一 registry liquidity 与 DC swing 为同一结构。
 * registry 对象字段：id/type/side/price/confirmedAt/status/touchedAt/sweptAt/...
 * DC swing（packageForMss）：type=SWING_HIGH/LOW、source=dc、metadata.index
 */
function normalizeCandidates(liquidityObjects, dcSwings, candles) {
    var idxByClose = {};
    candles.forEach(function (c, i) { if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i; });
    var out = [];
    (liquidityObjects || []).forEach(function (l) {
        if (!l || typeof l.confirmedAt !== 'number' || typeof l.price !== 'number') return;
        out.push({
            id: l.id,
            type: l.type,
            side: l.side === 'SSL' ? 'SSL' : 'BSL', // registry 语义侧（高低点）
            price: l.price,
            confirmedAt: l.confirmedAt,
            confirmBar: idxByClose[l.confirmedAt] !== undefined ? idxByClose[l.confirmedAt] : null,
            source: l.metadata && l.metadata.source ? l.metadata.source : 'registry',
            touchedAt: typeof l.touchedAt === 'number' ? l.touchedAt : null,
            sweptAt: typeof l.sweptAt === 'number' ? l.sweptAt : null,
            brokenAt: typeof l.brokenAt === 'number' ? l.brokenAt : null
        });
    });
    (dcSwings || []).forEach(function (s) {
        var cb = s.metadata && typeof s.metadata.index === 'number'
            ? s.metadata.index
            : (idxByClose[s.confirmedAt] !== undefined ? idxByClose[s.confirmedAt] : null);
        if (cb === null || cb === undefined) return;
        out.push({
            id: s.id,
            type: s.type === 'SWING_HIGH' ? 'DC_SWING_HIGH' : 'DC_SWING_LOW',
            side: s.type === 'SWING_HIGH' ? 'BSL' : 'SSL',
            price: s.price,
            confirmedAt: s.confirmedAt,
            confirmBar: cb,
            source: 'dc',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null
        });
    });
    return out;
}

/**
 * 预计算每候选的首次穿越 bar（raidBar）+ 触及/收盘穿越 bar 数组。
 * 穿越（raid）：BSL → high >= price；SSL → low <= price。
 * 触及（touch）：high >= price（BSL）或 low <= price（SSL），但不一定收盘穿越。
 * 收盘穿越（cross）：close >= price（BSL）或 close <= price（SSL）。
 * 扫描区间：confirmBar+1 .. candles 末尾（raidBar 即首次穿越；touch/cross 记录 raid 前全部）。
 */
function buildCandidateIndex(candidates, candles) {
    var byId = {};
    candidates.forEach(function (c) {
        if (c.confirmBar === null || c.confirmBar === undefined) return;
        var isHigh = c.side === 'BSL';
        var raidBar = null;
        var touchBars = [];
        var crossBars = [];
        for (var j = c.confirmBar + 1; j < candles.length; j++) {
            var k = candles[j];
            if (!k) continue;
            var touched = isHigh ? k.high >= c.price : k.low <= c.price;
            var crossed = isHigh ? k.close >= c.price : k.close <= c.price;
            if (touched) touchBars.push(j);
            if (crossed) crossBars.push(j);
            if (touched && raidBar === null) raidBar = j;
        }
        byId[c.id] = { confirmBar: c.confirmBar, raidBar: raidBar, touchBars: touchBars, crossBars: crossBars };
    });
    return byId;
}

/** t 时点是否 ACTIVE（确认过 + 未被 take）——生命周期纪律 */
function isActiveAt(c, idx, tBar, candles) {
    if (c.confirmBar === null || c.confirmBar === undefined) return false;
    if (c.confirmBar > tBar) return false;
    var ix = idx[c.id];
    if (!ix) return false;
    // 已被 take（价格穿越过）→ 不再 ACTIVE（raid = 价格已到达，任何后续 Draw 都不再成立）
    if (ix.raidBar !== null && ix.raidBar <= tBar) return false;
    // registry 显式生命周期时间戳（防御：即使价格未穿越到，swept/broken 标记也淘汰）
    var ct = candles[tBar] && candles[tBar].closeTime;
    if (typeof c.sweptAt === 'number' && ct !== null && ct !== undefined && c.sweptAt <= ct) return false;
    if (typeof c.brokenAt === 'number' && ct !== null && ct !== undefined && c.brokenAt <= ct) return false;
    return true;
}

/**
 * 特征提取（截至 t，无未来）。
 * @param {Object} c 候选
 * @param {Object} ix buildCandidateIndex 的单项
 * @param {Object} ctx { candles, atrAt, htfTrend, rangeHi, rangeLo, lastDispDir }
 * @param {number} tBar 当前 bar
 */
function extractFeatures(c, ix, ctx, tBar) {
    var k = ctx.candles[tBar];
    var price = k ? k.close : null;
    var atr = ctx.atrAt ? ctx.atrAt(tBar) : null;
    var distanceATR = (price && atr > 0) ? Math.abs(c.price - price) / atr : null;
    var ageBars = tBar - ix.confirmBar;
    // touch/cross 计数：ix.touchBars/crossBars 中 < tBar 的个数（含 tBar 前已发生）
    var touchCount = 0, closeCrossCount = 0;
    for (var i = 0; i < ix.touchBars.length && ix.touchBars[i] < tBar; i++) touchCount++;
    for (var j = 0; j < ix.crossBars.length && ix.crossBars[j] < tBar; j++) closeCrossCount++;
    // dealing range location
    var rangePosition = null, zone = null;
    if (ctx.rangeHi > ctx.rangeLo) {
        rangePosition = (price - ctx.rangeLo) / (ctx.rangeHi - ctx.rangeLo);
        zone = rangePosition < 0.45 ? 'DISCOUNT' : rangePosition > 0.55 ? 'PREMIUM' : 'EQ';
    }
    // HTF structure（截至 t）
    var htfStructure = 'NEUTRAL';
    var h = ctx.htfTrend && ctx.htfTrend[tBar];
    if (h) {
        if (h.h1Up === true && h.h4Up === true) htfStructure = 'BULLISH';
        else if (h.h1Up === false && h.h4Up === false) htfStructure = 'BEARISH';
        else if (h.h1Up === true || h.h4Up === true) htfStructure = 'MIXED_UP';
        else if (h.h1Up === false || h.h4Up === false) htfStructure = 'MIXED_DOWN';
    }
    // delivery alignment：最近同向 displacement 是否存在（截至 t）
    var deliveryAlignment = 'NONE';
    if (ctx.lastDispDir && ctx.lastDispDir[tBar]) {
        var d = ctx.lastDispDir[tBar];
        // 候选在上方（BSL）→ 多头交付（BULLISH）匹配；下方（SSL）→ 空头交付匹配
        var needDir = c.side === 'BSL' ? 'BULLISH' : 'BEARISH';
        if (d === needDir) deliveryAlignment = 'MATCH';
        else if (d === 'BEARISH' || d === 'BULLISH') deliveryAlignment = 'OPPOSE';
        else deliveryAlignment = 'NEUTRAL';
    }
    return {
        type: c.type,
        side: c.side,
        distanceATR: distanceATR,
        ageBars: ageBars,
        touchCount: touchCount,
        closeCrossCount: closeCrossCount,
        rangePosition: rangePosition,
        zone: zone,
        htfStructure: htfStructure,
        deliveryAlignment: deliveryAlignment,
        status: 'ACTIVE'
    };
}

/**
 * 未来 label：t 起未来第一个被 raid 的 ACTIVE 候选（只进 label）。
 * @returns {Object|null} { nextSide, nextType, barsToDraw, nextId } | null（horizon 内无）
 */
function futureLabel(actives, idxById, tBar) {
    var best = null;
    actives.forEach(function (c) {
        var ix = idxById[c.id];
        if (!ix || ix.raidBar === null || ix.raidBar <= tBar) return;
        if (ix.raidBar - tBar > HORIZON_BARS) return;
        if (!best || ix.raidBar < best.raidBar) {
            best = { c: c, ix: ix };
        }
    });
    if (!best) return null;
    return {
        nextSide: best.c.side,
        nextType: best.c.type,
        barsToDraw: best.ix.raidBar - tBar,
        nextId: best.c.id
    };
}

/**
 * 90d Draw on Liquidity 审计。
 * @param {Object} ctx {
 *   candles, liquidityObjects, dcSwings, htfTrend, htf1hCandles,
 *   displacementEvents, atrSeries, startIndex
 * }
 * @returns {Object} {
 *   rows, stats: { n, nextSideDist, accuracyVsNearest, accuracyVsRandom,
 *     byTypeDist, primaryDrawDist, featureCohort: {...} }
 * }
 */
function auditDrawLiquidity(ctx) {
    var candles = ctx.candles || [];
    var candidates = normalizeCandidates(ctx.liquidityObjects || [], ctx.dcSwings || [], candles);
    var idxById = buildCandidateIndex(candidates, candles);

    // ATR 序列（as-of t）
    var atrAt = function (tBar) {
        var s = ctx.atrSeries && ctx.atrSeries[tBar];
        return typeof s === 'number' ? s : null;
    };

    // dealing range：最近 24 根 1h（24h 滚动窗口，as-of t，无未来）。
    // 不用全量累积前缀（90d 累积极值会把 range 撑爆 → zone 失真全 DISCOUNT）。
    var h1 = ctx.htf1hCandles || [];
    var RANGE_1H_BARS = 24;
    function rangeAt(tBar) {
        var ct = candles[tBar] && candles[tBar].closeTime;
        if (ct === null || ct === undefined || h1.length === 0) return { hi: null, lo: null };
        var p = 0;
        while (p < h1.length - 1 && h1[p + 1].closeTime <= ct) p++;
        var s = Math.max(0, p - RANGE_1H_BARS + 1);
        var hi = -Infinity, lo = Infinity;
        for (var q = s; q <= p; q++) {
            if (h1[q].high > hi) hi = h1[q].high;
            if (h1[q].low < lo) lo = h1[q].low;
        }
        return { hi: hi === -Infinity ? null : hi, lo: lo === Infinity ? null : lo };
    }

    // delivery 方向（截至 t：最后一个 displacement 的方向）
    var lastDispDir = {};
    (ctx.displacementEvents || []).forEach(function (d) {
        if (typeof d.candleIndex !== 'number') return;
        lastDispDir[d.candleIndex] = d.direction;
    });

    // 闭包注入 candlesCloseTimeAt（已由 isActiveAt 直接传 candles，无需全局缓存）
    var rows = [];
    var start = ctx.startIndex !== undefined ? ctx.startIndex : 0;
    var end = candles.length;
    var n = 0, sideCorrect = 0, nearestCorrect = 0, randomCorrect = 0;
    var sideDist = {};     // 实际 nextSide 分布
    var typeDist = {};     // 实际 nextType 分布
    var primaryDist = {};  // primary draw 判定（最近候选侧）
    var featureCohort = { // 按特征分组预测准确率（feature → nextSide 命中率）
        htfBullish: { n: 0, hit: 0 }, htfBearish: { n: 0, hit: 0 }, htfNeutral: { n: 0, hit: 0 },
        zoneDiscount: { n: 0, hit: 0 }, zonePremium: { n: 0, hit: 0 }, zoneEq: { n: 0, hit: 0 },
        nearestIsUpper: { n: 0, hit: 0 }, nearestIsLower: { n: 0, hit: 0 }
    };

    for (var t = start; t < end; t++) {
        var actives = candidates.filter(function (c) { return isActiveAt(c, idxById, t, candles); });
        if (actives.length === 0) continue;
        var label = futureLabel(actives, idxById, t);
        if (!label) continue; // 只有有 label 的行参与统计（label 缺失不是预测失败，是 horizon 内无 draw）

        // 最近候选（baseline 预测：距离最近的 ACTIVE 候选的 side）
        var k = candles[t];
        var price = k ? k.close : null;
        var nearest = null;
        actives.forEach(function (c) {
            if (price === null || price === undefined) return;
            var d = Math.abs(c.price - price);
            if (!nearest || d < nearest.d) nearest = { c: c, d: d };
        });

        n++;
        sideDist[label.nextSide] = (sideDist[label.nextSide] || 0) + 1;
        typeDist[label.nextType] = (typeDist[label.nextType] || 0) + 1;
        // 最近距离基线预测
        if (nearest) {
            var pred = nearest.c.side;
            primaryDist[pred] = (primaryDist[pred] || 0) + 1;
            if (pred === label.nextSide) nearestCorrect++;
        }
        // 随机基线：按候选 side 比例随机（期望值用占比最大的 side）
        var upper = 0, lower = 0;
        actives.forEach(function (c) { if (c.side === 'BSL') upper++; else lower++; });
        var randPred = upper >= lower ? 'BSL' : 'SSL';
        if (randPred === label.nextSide) randomCorrect++;

        // 特征 cohort（用最近候选的特征做分组）
        var feat = null;
        if (nearest) {
            var rng = rangeAt(t);
            var ix = idxById[nearest.c.id];
            feat = extractFeatures(nearest.c, ix, {
                candles: candles, atrAt: atrAt, htfTrend: ctx.htfTrend,
                rangeHi: rng.hi, rangeLo: rng.lo,
                lastDispDir: lastDispDir
            }, t);
            if (feat.htfStructure === 'BULLISH') { featureCohort.htfBullish.n++; if (label.nextSide === 'BSL') featureCohort.htfBullish.hit++; }
            else if (feat.htfStructure === 'BEARISH') { featureCohort.htfBearish.n++; if (label.nextSide === 'SSL') featureCohort.htfBearish.hit++; }
            else { featureCohort.htfNeutral.n++; }
            if (feat.zone === 'DISCOUNT') { featureCohort.zoneDiscount.n++; if (label.nextSide === 'BSL') featureCohort.zoneDiscount.hit++; }
            else if (feat.zone === 'PREMIUM') { featureCohort.zonePremium.n++; if (label.nextSide === 'SSL') featureCohort.zonePremium.hit++; }
            else if (feat.zone === 'EQ') { featureCohort.zoneEq.n++; }
            if (nearest.c.side === 'BSL') { featureCohort.nearestIsUpper.n++; if (label.nextSide === 'BSL') featureCohort.nearestIsUpper.hit++; }
            else { featureCohort.nearestIsLower.n++; if (label.nextSide === 'SSL') featureCohort.nearestIsLower.hit++; }
        }

        // 抽样行（每 12 bars ≈ 1h 一条，供诊断展示）
        if (t % 12 === 0 && feat) {
            rows.push({
                t: t,
                close: price,
                nextSide: label.nextSide,
                nextType: label.nextType,
                barsToDraw: label.barsToDraw,
                nearest: { type: feat.type, side: feat.side, distanceATR: feat.distanceATR, ageBars: feat.ageBars, zone: feat.zone, htfStructure: feat.htfStructure, deliveryAlignment: feat.deliveryAlignment }
            });
        }
    }

    var randomRate = n > 0 ? randomCorrect / n : null;
    return {
        n: n,
        rows: rows,
        sideDist: sideDist,
        typeDist: typeDist,
        primaryDist: primaryDist,
        accuracyNearest: n > 0 ? nearestCorrect / n : null,
        accuracyRandom: randomRate,
        featureCohort: featureCohort,
        HORIZON_BARS: HORIZON_BARS
    };
}

module.exports = {
    BAR_MS: BAR_MS,
    HORIZON_BARS: HORIZON_BARS,
    typeGroup: typeGroup,
    normalizeCandidates: normalizeCandidates,
    buildCandidateIndex: buildCandidateIndex,
    isActiveAt: isActiveAt,
    extractFeatures: extractFeatures,
    futureLabel: futureLabel,
    auditDrawLiquidity: auditDrawLiquidity
};
