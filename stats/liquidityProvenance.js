/**
 * Phase 11L.8 — Liquidity Provenance / Notification Explainability
 *
 * 目的：让通知能解释"这条 HIGH 之前扫了什么流动性"（Sweep → MSS → Displacement Leg）。
 * 核心原则：不在发通知时重新扫描历史猜"它可能扫了什么"，而是在事件产生时保存
 * provenance（LIQUIDITY_SWEEP 事件由 sweepEventAdapter 在 lifecycle SWEPT 时生成）。
 *
 * 数据链：
 *   Liquidity (EQL/EQH/SWING_*)
 *     ↓ lifecycle.evaluateLiquidity → SWEPT
 *   SweepEvent { side, liquidityType, liquidityPrice, liquidityId, confirmedAt, candleIndex }
 *     ↓ associateSweeps（本模块，Live/Replay 单一实现）
 *   Opportunity.liquidityContext { primarySweepId, primary, sweeps[] }
 *     ↓ buildMessage
 *   DingTalk "Liquidity Taken:"
 *
 * 关联规则（第一版保守）：
 *   - BULLISH → 只关联 SSL；BEARISH → 只关联 BSL
 *   - sweep.confirmedAt <= opportunity.availableAt（严格无 future leakage）
 *   - 窗口：leg.startIndex - maxLookbackBars → leg.endIndex
 *     * sweep 允许出现在 leg 内（Leg K1 → Sweep → Leg K2/K3）→ INSIDE_LEG
 *       （不强迫 Sweep → MSS → Displacement 三段式）
 *     * maxLookbackBars 默认宽窗口（记录全部候选）；正式窗口由诊断分布决定，不拍脑袋
 *   - primary = 窗口内 confirmedAt 最近的候选；sweeps[] = 全部候选（confirmedAt 升序，
 *     含 relation / barsBeforeLegStart）→ 供诊断报告看真实分布
 *   - 无可靠关联 → 返回 null（通知显示 NONE，不猜测）
 *
 * MSS ↔ Leg relation（诊断字段，不改 tier / mssQuality）：
 *   BEFORE_LEG / INSIDE_LEG / AFTER_LEG / NONE
 *   —— Displacement 描述"价格怎么移动"，MSS 描述"这次移动对结构造成什么结果"，
 *      不强制它们按流水线先后出现；先诊断分布再决定是否需要改判定。
 */
var thresholds = require('../config/thresholds');

var DEFAULT_MAX_LOOKBACK_BARS = 96; // 8h 宽窗口（记录候选，诊断定正式窗口）

function defaultLookback(opts) {
    if (opts && opts.maxLookbackBars !== undefined && opts.maxLookbackBars !== null) {
        return opts.maxLookbackBars;
    }
    var cfg = (thresholds.events && thresholds.events.sweepProvenance) ? thresholds.events.sweepProvenance : null;
    if (cfg && cfg.maxLookbackBars !== undefined) {
        return cfg.maxLookbackBars;
    }
    return DEFAULT_MAX_LOOKBACK_BARS;
}

/**
 * Sweep ↔ Leg 时间关系（用 confirmedAt 与 leg 时间窗比较；index 缺失/不一致时回退 index 比较）
 * @returns {string} 'BEFORE_LEG' | 'INSIDE_LEG' | 'AFTER_LEG'
 */
function classifySweepLegRelation(sweep, leg) {
    var first = leg && leg.firstConfirmedAt;
    var last = leg && leg.lastConfirmedAt;
    var t = sweep && sweep.confirmedAt;
    if (typeof t === 'number' && typeof first === 'number' && typeof last === 'number') {
        if (t < first) return 'BEFORE_LEG';
        if (t <= last) return 'INSIDE_LEG';
        return 'AFTER_LEG';
    }
    // 回退：index 比较（5m 对齐）
    var s = sweep && sweep.candleIndex;
    var st = leg && leg.startIndex;
    var en = leg && (leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex);
    if (typeof s !== 'number') return 'AFTER_LEG';
    if (typeof st === 'number' && s < st) return 'BEFORE_LEG';
    if (typeof en === 'number' && s <= en) return 'INSIDE_LEG';
    return 'AFTER_LEG';
}

/**
 * MSS ↔ Leg relation 诊断（不改 tier / mssQuality）
 * @param {Object} leg leg（含 startIndex/endIndex/firstConfirmedAt/lastConfirmedAt）
 * @param {Object} [mssEvent] MSS 事件；null/缺失 → 'NONE'
 * @returns {string} 'BEFORE_LEG' | 'INSIDE_LEG' | 'AFTER_LEG' | 'NONE'
 */
function classifyMssLegRelation(leg, mssEvent) {
    if (!mssEvent) {
        return 'NONE';
    }
    var first = leg && leg.firstConfirmedAt;
    var last = leg && leg.lastConfirmedAt;
    var t = mssEvent.confirmedAt;
    if (typeof t === 'number' && typeof first === 'number' && typeof last === 'number') {
        if (t < first) return 'BEFORE_LEG';
        if (t <= last) return 'INSIDE_LEG';
        return 'AFTER_LEG';
    }
    var s = mssEvent.candleIndex;
    var st = leg && leg.startIndex;
    var en = leg && (leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex);
    if (typeof s !== 'number') return 'NONE';
    if (typeof st === 'number' && s < st) return 'BEFORE_LEG';
    if (typeof en === 'number' && s <= en) return 'INSIDE_LEG';
    return 'AFTER_LEG';
}

/**
 * 构建单个候选摘要（sweep + leg → provenance 记录）
 */
function buildCandidate(se, leg) {
    var c = {
        id: se.id || null,
        side: se.side,
        // liquidityType 在 SweepEvent.source 子对象（sweepEventAdapter 定义），顶层回退
        sourceType: (se.source && se.source.liquidityType) || se.liquidityType || null,
        sourceTimeframe: se.timeframe || '5m',
        sourcePrice: se.price,
        sourceId: se.liquidityId || null,
        confirmedAt: se.confirmedAt,
        candleIndex: se.candleIndex,
        relation: classifySweepLegRelation(se, leg)
    };
    if (leg && typeof leg.startIndex === 'number' && typeof se.candleIndex === 'number') {
        c.barsBeforeLegStart = leg.startIndex - se.candleIndex;
    } else {
        c.barsBeforeLegStart = null;
    }
    return c;
}

/**
 * Sweep Provenance 关联（Live/Replay 单一实现）。
 *
 * @param {Object} opts
 *   {
 *     direction: 'BULLISH' | 'BEARISH',
 *     leg: { startIndex, endIndex, firstConfirmedAt, lastConfirmedAt },  // leg 本身（anchor 语义）
 *     availableAt: number,        // 通知可用时点（leg 关闭确认）—— leakage 硬边界
 *     sweepEvents: Array,         // LIQUIDITY_SWEEP 事件（confirmedAt 已确认）
 *     maxLookbackBars: number     // 候选窗口（leg.startIndex - N → leg.endIndex）；默认宽窗口
 *   }
 * @returns {Object|null} {
 *   primarySweepId, primary, sweeps[]
 * } | null（无可靠关联 → NONE）
 */
function associateSweeps(opts) {
    if (!opts || !opts.direction) {
        return null;
    }
    var leg = opts.leg || {};
    var availableAt = opts.availableAt;
    var wantSide = opts.direction === 'BULLISH' ? 'SSL' : 'BSL';
    var N = defaultLookback(opts);
    var endIdx = leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex;
    var startBound = (typeof leg.startIndex === 'number' && typeof N === 'number')
        ? leg.startIndex - N
        : -Infinity;

    var candidates = [];
    (opts.sweepEvents || []).forEach(function (se) {
        if (!se || se.side !== wantSide) return;
        // 无 future leakage：confirmedAt 必须 <= 通知可用时点
        if (typeof availableAt === 'number' && typeof se.confirmedAt === 'number') {
            if (se.confirmedAt > availableAt) return;
        } else if (typeof availableAt === 'number') {
            // confirmedAt 缺失（旧构造）：用 candleIndex 所在 5m 时间近似，缺失则拒绝（fail-closed）
            return;
        }
        // 窗口：leg.startIndex - N → leg.endIndex（sweep 可在 leg 内，禁止 leg 后）
        if (typeof se.candleIndex !== 'number') return;
        if (typeof endIdx === 'number' && se.candleIndex > endIdx) return;
        if (se.candleIndex < startBound) return;
        candidates.push(se);
    });

    if (candidates.length === 0) {
        return null;
    }
    candidates.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });
    var primary = candidates[candidates.length - 1];
    var sweeps = candidates.map(function (se) { return buildCandidate(se, leg); });
    return {
        primarySweepId: primary.id || null,
        primary: buildCandidate(primary, leg),
        sweeps: sweeps
    };
}

/**
 * 通知行格式化（Live buildMessage 用）：'SSL · 5M EQL @ 1902.40'
 * 无 primary → null（调用方显示 NONE）
 */
function formatSweepPriceLine(primary) {
    if (!primary) return null;
    var tf = (primary.sourceTimeframe || '5m').toUpperCase();
    var type = primary.sourceType || 'LIQUIDITY';
    var price = primary.sourcePrice;
    if (price === null || price === undefined) {
        return primary.side + ' · ' + tf + ' ' + type;
    }
    var p = typeof price === 'number' ? price.toFixed(price < 1 ? 4 : 2) : String(price);
    return primary.side + ' · ' + tf + ' ' + type + ' @ ' + p;
}

/**
 * 通知时间关系行：'发生于 Leg 前 3 bars' / '发生于 Leg 内' / '发生于 Leg 后'
 */
function formatSweepRelationLine(primary) {
    if (!primary) return null;
    if (primary.relation === 'INSIDE_LEG') return '发生于 Leg 内';
    if (primary.relation === 'AFTER_LEG') return '发生于 Leg 后';
    var n = primary.barsBeforeLegStart;
    if (typeof n === 'number' && n > 0) {
        return '发生于 Leg 前 ' + n + ' bars';
    }
    return '发生于 Leg 前';
}

module.exports = {
    associateSweeps: associateSweeps,
    classifySweepLegRelation: classifySweepLegRelation,
    classifyMssLegRelation: classifyMssLegRelation,
    formatSweepPriceLine: formatSweepPriceLine,
    formatSweepRelationLine: formatSweepRelationLine,
    DEFAULT_MAX_LOOKBACK_BARS: DEFAULT_MAX_LOOKBACK_BARS
};
