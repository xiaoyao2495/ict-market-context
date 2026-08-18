/**
 * Narrative Boundary Integrity Audit（Phase 11T.3）
 *
 * 目标：回答 Phase 11T.2 的遗留问题 ——
 *   26%（BTC 43% / ETH 14% / BNB 27%）entry 没有 manipulation/accumulation
 *   narrative reference，到底是市场语义（从一开始就 Missing），
 *   还是上下文在 pipeline 中丢失（WATCH 时有 → TradePlan 时无）？
 *
 * 纯诊断：Bias / Draw / AMD / Scenario / FVG / Stop baseline / ATR buffer / minRR 全部冻结，
 * 只增加快照字段与 shadow 分组。
 *
 * Boundary 定义（第一版，与 Phase 11T.2 V2 一致）：
 *   PRESENT = 至少存在 manipulation extreme（sweepEvent.price）或 accumulation boundary（rangeLow/rangeHigh）
 *   MISSING = 两者都不存在 → stop 只能退化 Swing/FVG
 *
 * 分类（四态）：
 *   PRESENT_THROUGHOUT        WATCH 时有 && trigger/plan 时有
 *   MISSING_FROM_START        WATCH 时无 && trigger/plan 时无
 *   LOST_AFTER_WATCH          WATCH 时有 && trigger/plan 时无（pipeline 丢字段 或 AMD reset）
 *   PRESENT_AT_TRIGGER_ONLY   WATCH 时无 && trigger/plan 时有（WATCH 建立过早 / AMD 后期才确认）
 *   （正式链路：LOST_AFTER_ENTRY_READY = WATCH 有、ENTRY_READY 有、TradePlan 无 ——
 *     代码中 plan 即 ENTRY_READY 跃迁时创建，用 watch vs plan 两态近似并注明）
 *
 * 决策原则（冻结）：确认"从一开始就 Missing"且三币种 MISSING 显著更差，
 *   才考虑把 Narrative Boundary Required 提升为 Entry/Scenario 门槛（仍先 shadow，不加正式规则）。
 */
var stopSemantics = require('./stopSemantics');

/**
 * 从 AMD 快照（amdView 输出）提取 boundary 状态
 * @param {Object} amd amdView(state.amd) 输出（含 manipulation/accumulation/distribution）
 * @returns {Object} {
 *   hasManipulation, manipulationExtreme,
 *   hasAccumulation, accumulationRangeLow, accumulationRangeHigh,
 *   amdState, amdDirection, distributionEventId
 * }
 */
function boundaryFromAmd(amd) {
    var a = amd || {};
    var manip = a.manipulation || null;
    var acc = a.accumulation || null;
    var dist = a.distribution || null;
    return {
        hasManipulation: !!(manip && manip.sweepEvent && manip.sweepEvent.price !== null && manip.sweepEvent.price !== undefined),
        manipulationExtreme: manip && manip.sweepEvent ? manip.sweepEvent.price : null,
        hasAccumulation: !!(acc && acc.rangeLow !== null && acc.rangeLow !== undefined),
        accumulationRangeLow: acc ? acc.rangeLow : null,
        accumulationRangeHigh: acc ? acc.rangeHigh : null,
        amdState: a.state || a.phase || null,
        amdDirection: a.direction || a.lastDirection || null,
        distributionEventId: dist
            ? (dist.displacementEvent ? dist.displacementEvent.id
                : dist.mssEvent ? dist.mssEvent.id : null)
            : null
    };
}

/**
 * 判断 boundary snapshot 是否 PRESENT
 */
function isPresent(b) {
    return !!(b && (b.hasManipulation || b.hasAccumulation));
}

/**
 * Phase 11T.5R：lastNarrative 是否应被清理（scenario direction flip / draw flip）
 * @param {Object} lastNarrative TradeContextSnapshot（或 null）
 * @param {String|null} scenarioState scenario.scenarioState（'BULLISH_WATCH' | 'BEARISH_WATCH' | ...）
 * @param {String|null} drawDirection snapshot.draw.direction（'LEAN_BSL' | 'LEAN_SSL' | ...）
 * @returns {boolean} true = 应清空（旧方向 narrative 与新方向冲突）
 */
function shouldClearLastNarrative(lastNarrative, scenarioState, drawDirection) {
    if (!lastNarrative) return false;
    var lnDir = lastNarrative.direction;
    if (!lnDir) return false; // direction null（accumulation-only）不参与 flip 判定
    var scBull = scenarioState && scenarioState.indexOf('BULLISH') === 0;
    var scBear = scenarioState && scenarioState.indexOf('BEARISH') === 0;
    if ((lnDir === 'BULLISH' && scBear) || (lnDir === 'BEARISH' && scBull)) {
        return true;
    }
    if (drawDirection) {
        var dBull = drawDirection.indexOf('BSL') !== -1;
        var dBear = drawDirection.indexOf('SSL') !== -1;
        if ((lnDir === 'BULLISH' && dBear) || (lnDir === 'BEARISH' && dBull)) {
            return true;
        }
    }
    return false;
}

/**
 * 从 boundary 判定快照反构造 planStop 可读的 amd 视图
 * （planStop 读 amd.manipulation.sweepEvent.price / amd.accumulation.rangeLow|rangeHigh）
 * @param {Object} b boundaryFromAmd 输出
 * @returns {Object} { manipulation?, accumulation? }（可能为空对象）
 */
function amdFromBoundary(b) {
    var amd = {};
    if (b && b.hasManipulation && b.manipulationExtreme !== null && b.manipulationExtreme !== undefined) {
        amd.manipulation = { sweepEvent: { price: b.manipulationExtreme } };
    }
    if (b && b.hasAccumulation && b.accumulationRangeLow !== null && b.accumulationRangeLow !== undefined) {
        amd.accumulation = {
            rangeLow: b.accumulationRangeLow,
            rangeHigh: b.accumulationRangeHigh !== null ? b.accumulationRangeHigh : b.accumulationRangeLow
        };
    }
    return amd;
}

/**
 * 从 lastNarrative 快照构造 planStop 可读的 amd 视图（Phase 11T.4）
 * @param {Object} ln amdState.lastNarrative（immutable 快照）
 * @returns {Object} { manipulation?, accumulation? }
 */
function amdFromLastNarrative(ln) {
    var amd = {};
    if (ln && ln.manipulation && ln.manipulation.sweepPrice !== null && ln.manipulation.sweepPrice !== undefined) {
        amd.manipulation = { sweepEvent: { price: ln.manipulation.sweepPrice } };
    }
    if (ln && ln.accumulation && ln.accumulation.rangeLow !== null && ln.accumulation.rangeLow !== undefined) {
        amd.accumulation = {
            rangeLow: ln.accumulation.rangeLow,
            rangeHigh: ln.accumulation.rangeHigh !== null ? ln.accumulation.rangeHigh : ln.accumulation.rangeLow
        };
    }
    return amd;
}

/**
 * Shadow stop reference 合成（Phase 11T.4）：current AMD boundary 优先，
 * 无 → lastNarrative boundary → 无 → 空 amd（planStop fallback SWING/FVG）
 * @param {Object} amdAtTrigger boundaryFromAmd（trigger 实时）
 * @param {Object} lastNarrative amdState.lastNarrative
 * @returns {Object} amd 视图（供 planStop）
 */
function synthAmdForStop(amdAtTrigger, lastNarrative) {
    var cur = amdFromBoundary(amdAtTrigger);
    if (cur.manipulation || cur.accumulation) {
        return cur;
    }
    var ln = amdFromLastNarrative(lastNarrative);
    if (ln.manipulation || ln.accumulation) {
        return ln;
    }
    return cur;
}

/**
 * 四态分类
 * @param {Object} boundaryAtWatch WATCH 建立时冻结快照
 * @param {Object} boundaryAtAction trigger（shadow）或 plan（正式）时的快照
 * @returns {String} 分类
 */
function classify(boundaryAtWatch, boundaryAtAction) {
    var w = isPresent(boundaryAtWatch);
    var a = isPresent(boundaryAtAction);
    if (w && a) return 'PRESENT_THROUGHOUT';
    if (!w && !a) return 'MISSING_FROM_START';
    if (w && !a) return 'LOST_AFTER_WATCH';
    return 'PRESENT_AT_TRIGGER_ONLY';
}

/**
 * 从 entry 提取统一模拟对象（兼容 shadow entry / 正式 trade）
 * @param {Object} e { direction, entryPrice, targetPrice, stopPrice, entryIndex, diagnostics }
 * @returns {Object|null} { direction, entryPrice, targetPrice, stopPrice, atr, startIdx }
 */
function extractEntry(e) {
    var atr = (e.diagnostics && e.diagnostics.atr) || e.atr || null;
    if (!e.entryPrice || !e.targetPrice || !atr || atr <= 0) return null;
    if (e.entryIndex === null || e.entryIndex === undefined) return null;
    if (e.stopPrice === null || e.stopPrice === undefined) return null;
    return {
        direction: e.direction,
        entryPrice: e.entryPrice,
        targetPrice: e.targetPrice,
        stopPrice: e.stopPrice,
        atr: atr,
        startIdx: e.entryIndex
    };
}

/**
 * 单 entry 结果（四态 + MFE/MAE + 计划 RR/stop 距离）
 * @returns {Object} {
 *   first: 'TARGET'|'STOP'|'AMBIGUOUS'|'NEITHER',
 *   stopOutThenTarget, mfeAtr, maeAtr, mfePct, maePct, rr, stopAtr
 * }
 */
function entryOutcome(ex, candles, opts) {
    var o = opts || {};
    var horizon = o.horizon !== undefined ? o.horizon : 288;
    var endIdx = Math.min(candles.length, ex.startIdx + 1 + horizon);
    var first = 'NEITHER';
    var stopOutThenTarget = false;
    var k;
    for (k = ex.startIdx + 1; k < endIdx; k++) {
        var c = candles[k];
        if (!c || c.closed === false) continue;
        var stopHit, targetHit;
        if (ex.direction === 'LONG') {
            stopHit = c.low <= ex.stopPrice;
            targetHit = c.high >= ex.targetPrice;
        } else {
            stopHit = c.high >= ex.stopPrice;
            targetHit = c.low <= ex.targetPrice;
        }
        if (stopHit && targetHit) { first = 'AMBIGUOUS'; break; }
        if (targetHit) { first = 'TARGET'; break; }
        if (stopHit) { first = 'STOP'; break; }
    }
    if (first === 'STOP') {
        for (; k < endIdx; k++) {
            var c2 = candles[k];
            if (!c2 || c2.closed === false) continue;
            if (ex.direction === 'LONG' && c2.high >= ex.targetPrice) { stopOutThenTarget = true; break; }
            if (ex.direction === 'SHORT' && c2.low <= ex.targetPrice) { stopOutThenTarget = true; break; }
        }
    }

    // MFE/MAE（ATR 单位 + 百分比，复用 Phase 11T 的 simulateStop 口径：扫到数据末尾）
    var sim = stopSemantics.simulateStop(ex, ex.stopPrice, candles, ex.startIdx);
    var mfePct = ex.entryPrice > 0 ? (sim.mfeAtr * ex.atr / ex.entryPrice) * 100 : null;
    var maePct = ex.entryPrice > 0 ? (sim.maeAtr * ex.atr / ex.entryPrice) * 100 : null;

    var risk = Math.abs(ex.entryPrice - ex.stopPrice);
    var reward = ex.direction === 'LONG'
        ? ex.targetPrice - ex.entryPrice
        : ex.entryPrice - ex.targetPrice;
    var rr = risk > 0 && reward > 0 ? reward / risk : null;

    return {
        first: first,
        stopOutThenTarget: stopOutThenTarget,
        mfeAtr: sim.mfeAtr,
        maeAtr: sim.maeAtr,
        mfePct: mfePct,
        maePct: maePct,
        rr: rr,
        stopAtr: Math.abs(ex.entryPrice - ex.stopPrice) / ex.atr
    };
}

function median(arr) {
    if (!arr || arr.length === 0) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
    if (!arr || arr.length === 0) return 0;
    var sum = 0;
    arr.forEach(function (v) { sum += v; });
    return sum / arr.length;
}

/**
 * 表 ①③：Boundary Presence Performance
 * PRESENT vs MISSING 分组统计
 * @param {Array} entries 含 boundaryAtWatch（快照）+ 模拟所需字段
 * @param {Array} candles
 * @returns {Object} { present: row, missing: row }，row = {
 *   n, targetHit, survival, stopOutN, stopOutThenTarget, stopToTargetRate,
 *   avgMfePct, avgMaePct, mfeMae, medRr, medStopAtr,
 *   alignMatch, alignN, amdStates, medFvgScore
 * }
 */
function boundaryPresenceTable(entries, candles, opts) {
    var o = opts || {};
    var groups = { present: null, missing: null };

    function emptyRow() {
        return {
            n: 0, targetHit: 0, survival: 0, stopOutN: 0, stopOutThenTarget: 0,
            mfeSum: 0, maeSum: 0, rrs: [], stopAtrs: [],
            alignMatch: 0, alignN: 0, amdStates: {}, fvgScores: []
        };
    }
    var present = emptyRow();
    var missing = emptyRow();

    (entries || []).forEach(function (e) {
        var ex = extractEntry(e);
        if (!ex) return;
        var bWatch = e.boundaryAtWatch || null;
        var isPres = isPresent(bWatch);
        var row = isPres ? present : missing;
        row.n++;

        var oc = entryOutcome(ex, candles, o);
        if (oc.first === 'TARGET') row.survival++;
        if (oc.first === 'TARGET' || oc.stopOutThenTarget) row.targetHit++;
        if (oc.first === 'STOP') {
            row.stopOutN++;
            if (oc.stopOutThenTarget) row.stopOutThenTarget++;
        }
        if (oc.mfePct !== null) row.mfeSum += oc.mfePct;
        if (oc.maePct !== null) row.maeSum += oc.maePct;
        if (oc.rr !== null) row.rrs.push(oc.rr);
        row.stopAtrs.push(oc.stopAtr);

        // alignment（MATCH rate）：shadow 用 r.alignment 或 bias+amd 推断；正式用 context
        var align = e.alignmentAtWatch || null;
        if (align === null && e.biasAtWatch && bWatch) {
            align = e.biasAtWatch === 'NEUTRAL' || !bWatch.amdDirection
                ? 'UNCONFIRMED'
                : ((e.biasAtWatch.indexOf('BULLISH') !== -1 && bWatch.amdDirection === 'BULLISH') ||
                   (e.biasAtWatch.indexOf('BEARISH') !== -1 && bWatch.amdDirection === 'BEARISH'))
                    ? 'MATCH' : 'OPPOSITE';
        }
        if (align) {
            row.alignN++;
            if (align === 'MATCH') row.alignMatch++;
        }

        var st = bWatch ? (bWatch.amdState || 'UNKNOWN') : 'UNKNOWN';
        row.amdStates[st] = (row.amdStates[st] || 0) + 1;

        var fs = e.fvgScoreAtWatch;
        if (fs !== null && fs !== undefined) row.fvgScores.push(fs);
    });

    function finalize(row) {
        return {
            n: row.n,
            survivalRate: row.n > 0 ? row.survival / row.n : 0,
            targetHitRate: row.n > 0 ? row.targetHit / row.n : 0,
            stopOutN: row.stopOutN,
            stopOutThenTarget: row.stopOutThenTarget,
            stopToTargetRate: row.stopOutN > 0 ? row.stopOutThenTarget / row.stopOutN : null,
            avgMfePct: row.n > 0 ? row.mfeSum / row.n : 0,
            avgMaePct: row.n > 0 ? row.maeSum / row.n : 0,
            mfeMae: row.maeSum > 0 ? row.mfeSum / row.maeSum : null,
            medRr: median(row.rrs),
            medStopAtr: median(row.stopAtrs),
            alignMatchRate: row.alignN > 0 ? row.alignMatch / row.alignN : null,
            alignN: row.alignN,
            amdStates: row.amdStates,
            medFvgScore: median(row.fvgScores)
        };
    }

    return { present: finalize(present), missing: finalize(missing) };
}

/**
 * 表 ②：Boundary Loss Pipeline
 * @param {Array} entries 含 boundaryAtWatch + boundaryAtAction（trigger/plan）
 * @returns {Object} { classification: { n, pct }, total, breakdownByAmdState }
 */
function boundaryLossTable(entries) {
    var cls = {};
    var total = 0;
    (entries || []).forEach(function (e) {
        var bWatch = e.boundaryAtWatch || null;
        var bAction = e.boundaryAtAction || null;
        if (!bWatch && !bAction) return; // 无快照的 entry 不计入 loss 表
        var c = classify(bWatch, bAction);
        cls[c] = (cls[c] || 0) + 1;
        total++;
    });
    var out = {};
    Object.keys(cls).forEach(function (k) {
        out[k] = { n: cls[k], pct: total > 0 ? cls[k] / total : 0 };
    });
    return { classification: out, total: total };
}

module.exports = {
    boundaryFromAmd: boundaryFromAmd,
    isPresent: isPresent,
    amdFromBoundary: amdFromBoundary,
    amdFromLastNarrative: amdFromLastNarrative,
    synthAmdForStop: synthAmdForStop,
    shouldClearLastNarrative: shouldClearLastNarrative,
    classify: classify,
    extractEntry: extractEntry,
    entryOutcome: entryOutcome,
    boundaryPresenceTable: boundaryPresenceTable,
    boundaryLossTable: boundaryLossTable
};
