/**
 * Phase 11L.8 — Liquidity Provenance / Notification Explainability
 *
 * 目的：让通知能解释"这条 HIGH 形成前后，近期获取过哪些流动性"。
 * 核心原则：
 *   - 不在发通知时重新扫描历史猜"它可能扫了什么"，而是消费事件产生时已保存的
 *     provenance（LIQUIDITY_SWEEP 事件由 sweepEventAdapter 在 lifecycle SWEPT 时生成）。
 *   - **只做解释，不做因果声明**：没有证据证明"最近的 sweep"就是整个 Narrative 的
 *     causal liquidity event。因此 immediateSweep 只是"近期获取的流动性"，
 *     严禁在注释/变量/文案中称其为 causal / Narrative / "导致本次机会的流动性"。
 *
 * 数据链：
 *   Liquidity (EQL, EQH, SWING_HIGH, SWING_LOW, Session 等) → SweepEvent → Opportunity.liquidityContext → DingTalk
 *
 * 关联规则（第一版保守，不扩范围）：
 *   - BULLISH → 只关联 SSL；BEARISH → 只关联 BSL
 *   - sweep.confirmedAt <= opportunity.availableAt（严格无 future leakage，缺失 fail-closed）
 *   - 窗口：leg.startIndex - maxLookbackBars → leg.endIndex
 *     * maxLookbackBars = 48（production explainability 窗口；90d 数据 N=48 关联 ~90%，
 *       避免为了 99% 把过旧 sweep 强行挂到当前 Opportunity）
 *     * sweep 允许出现在 leg 内（Leg K1 → Sweep → Leg K2/K3）→ INSIDE_LEG
 *   - 无可靠关联 → 返回 null（通知显示 NONE，不猜测；HIGH 正常发送，不因 NONE 降级）
 *
 * 数据结构（用户定稿，最终态）：
 *   liquidityContext: {
 *     allCandidates: [],   // 窗口内全部方向匹配且 confirmedAt <= availableAt 的 sweep
 *     immediateSweep: null // 距离 leg.startIndex 最近的有效 sweep（距离相同取 confirmedAt 更新）
 *   }
 *   （曾有过 primarySweep 兼容字段，已删除 —— 它不是 Narrative ranking；
 *     将来若研究出真正的 Narrative Liquidity ranking，再正式增加 narrativeSweep）
 *
 */
var thresholds = require('../config/thresholds');
var narrativeLiquidityV1 = require('../events/sweepNarrativeEligibilityV1');

var DEFAULT_MAX_LOOKBACK_BARS = 48; // 11L.8 定稿：production explainability 窗口

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
function classifySweepDisplacementRelation(sweep, displacement) {
    var first = displacement && displacement.startAt;
    var last = displacement && displacement.endAt;
    var t = sweep && sweep.confirmedAt;
    if (typeof t === 'number' && typeof first === 'number' && typeof last === 'number') {
        if (t < first) return 'BEFORE_LEG';
        if (t <= last) return 'INSIDE_LEG';
        return 'AFTER_LEG';
    }
    // 回退：index 比较（5m 对齐）
    var s = sweep && sweep.candleIndex;
    var st = displacement && displacement.startIndex;
    var en = displacement && displacement.endIndex;
    if (typeof s !== 'number') return 'AFTER_LEG';
    if (typeof st === 'number' && s < st) return 'BEFORE_LEG';
    if (typeof en === 'number' && s <= en) return 'INSIDE_LEG';
    return 'AFTER_LEG';
}

/**
 * 构建单个候选摘要（sweep + leg → provenance 记录）
 * sourceType 忠实展示真实 liquidity 类型（SWING_LOW/EQL/...），缺失显示 UNKNOWN，不做人工过滤。
 */
function buildCandidate(se, displacement) {
    var sourceType = (se.source && se.source.liquidityType) || se.liquidityType || 'UNKNOWN';
    var c = {
        id: se.id || null,
        side: se.side,
        sourceType: sourceType,
        sourceTimeframe: se.timeframe || 'UNKNOWN',
        sourcePrice: se.price,
        sourceId: se.liquidityId || null,
        confirmedAt: se.confirmedAt,
        candleIndex: se.candleIndex,
        relation: classifySweepDisplacementRelation(se, displacement)
    };
    if (se.source && se.source.eqPartnerProvenance) {
        c.eqPartnerProvenance = JSON.parse(JSON.stringify(se.source.eqPartnerProvenance));
    }
    if (displacement && typeof displacement.startIndex === 'number' && typeof se.candleIndex === 'number') {
        c.barsBeforeLegStart = displacement.startIndex - se.candleIndex;
    } else {
        c.barsBeforeLegStart = null;
    }
    return c;
}

/**
 * immediateSweep 选择：距离 leg.startIndex 最近的有效 sweep；距离相同取 confirmedAt 更新的。
 * 距离 = |leg.startIndex - sweep.candleIndex|（leg 前与 leg 内统一按绝对距离）。
 * @returns {Object|null} 候选摘要
 */
function pickImmediate(displacement, candidates) {
    var best = null;
    var bestDist = Infinity;
    var bestConfirmed = -Infinity;
    candidates.forEach(function (se) {
        var dist = Infinity;
        if (typeof displacement.startIndex === 'number' && typeof se.candleIndex === 'number') {
            dist = Math.abs(displacement.startIndex - se.candleIndex);
        }
        var confirmed = typeof se.confirmedAt === 'number' ? se.confirmedAt : -Infinity;
        if (dist < bestDist || (dist === bestDist && confirmed > bestConfirmed)) {
            best = se;
            bestDist = dist;
            bestConfirmed = confirmed;
        }
    });
    return best ? buildCandidate(best, displacement) : null;
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
 *     maxLookbackBars: number     // 候选窗口（leg.startIndex - N → leg.endIndex）；默认 48
 *     excludeStructuralPrimitives: boolean // WATCH Narrative V1：排除 SWING_HIGH/SWING_LOW
 *   }
 * @returns {Object|null} {
 *   allCandidates: [...], immediateSweep
 * } | null（无可靠关联 → NONE）
 */
function associateSweeps(opts) {
    if (!opts || !opts.direction) {
        return null;
    }
    var displacement = opts.displacement || {};
    var availableAt = opts.availableAt;
    var wantSide = opts.direction === 'BULLISH' ? 'SSL' : 'BSL';
    var N = defaultLookback(opts);
    var endIdx = displacement.endIndex;
    var startBound = (typeof displacement.startIndex === 'number' && typeof N === 'number')
        ? displacement.startIndex - N
        : -Infinity;

    var candidates = [];
    (opts.sweepEvents || []).forEach(function (se) {
        if (!se || se.side !== wantSide) return;
        // 无 future leakage：confirmedAt 必须 <= 通知可用时点（缺失则 fail-closed，不猜测）
        if (typeof availableAt === 'number') {
            if (typeof se.confirmedAt !== 'number' || se.confirmedAt > availableAt) return;
        }
        if (typeof displacement.endAt === 'number' && se.confirmedAt > displacement.endAt) return;
        // Narrative Liquidity V1 consumer gate. Raw Sweep events remain intact for
        // AMD/structure; only the requesting WATCH candidate projection excludes
        // structural primitives.
        if (opts.excludeStructuralPrimitives) {
            var st = (se.source && se.source.liquidityType) || se.liquidityType || '';
            if (narrativeLiquidityV1.isStructuralPrimitive(st)) return;
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
    return {
        allCandidates: candidates.map(function (se) { return buildCandidate(se, displacement); }),
        // 通知展示用：距离 leg.startIndex 最近的 sweep（不是 Narrative ranking，仅"近期获取流动性"）
        immediateSweep: pickImmediate(displacement, candidates)
    };
}

/**
 * sweep 时间（UTC+8，MM-DD HH:MM —— 用户示例 "08-19 20:05"）
 * @param {number} ms confirmedAt（sweep 确认时点 = 触发 K closeTime）
 * @returns {string|null} 如 '08-19 20:05'
 */
function fmtSweepTime(ms) {
    if (typeof ms !== 'number') return null;
    var d = new Date(ms + 8 * 3600000); // UTC+8
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' +
        p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
}

/**
 * 通知价格行（Live buildMessage 用）：'SSL · 5M SWING_LOW @ 66000.00 · 08-19 20:05'
 * 无 immediateSweep → null（调用方显示 NONE）；timeframe/sourceType 缺失显示 UNKNOWN，不猜测。
 * 时间 = sweep confirmedAt（UTC+8 MM-DD HH:MM），缺失不显示。
 */
function formatSweepPriceLine(sweep) {
    if (!sweep) return null;
    var tf = (sweep.sourceTimeframe || 'UNKNOWN').toUpperCase();
    var type = sweep.sourceType || 'UNKNOWN';
    var price = sweep.sourcePrice;
    var base;
    if (price === null || price === undefined) {
        base = sweep.side + ' · ' + tf + ' ' + type;
    } else {
        var p = typeof price === 'number' ? price.toFixed(price < 1 ? 4 : 2) : String(price);
        base = sweep.side + ' · ' + tf + ' ' + type + ' @ ' + p;
    }
    var t = fmtSweepTime(sweep.confirmedAt);
    return t ? (base + ' · ' + t) : base;
}

/**
 * 通知时间关系行：'BEFORE_LEG · 12 bars' / 'INSIDE_LEG · 1 bar' / 'AFTER_LEG'
 * 措辞统一为"近期获取流动性"（relation 描述时间关系，不做因果声明）。
 * bars 直接用候选的 barsBeforeLegStart（= leg.startIndex - sweep.candleIndex）换算：
 *   BEFORE_LEG → leg 前 N 根；INSIDE_LEG → 腿内第 K 根（K1 → 1 bar）。
 */
function formatSweepRelationLine(sweep) {
    if (!sweep) return null;
    var rel = sweep.relation || 'BEFORE_LEG';
    var b = typeof sweep.barsBeforeLegStart === 'number' ? sweep.barsBeforeLegStart : null;
    var n = null;
    if (rel === 'BEFORE_LEG' && b !== null) {
        n = b;                     // startIndex - candleIndex（>0）
    } else if (rel === 'INSIDE_LEG' && b !== null) {
        n = -b + 1;                // candleIndex - startIndex + 1（K1 → 1）
    }
    if (n === null || n === undefined || n < 0) {
        return rel;
    }
    return rel + ' · ' + n + (n === 1 ? ' bar' : ' bars');
}

module.exports = {
    associateSweeps: associateSweeps,
    classifySweepDisplacementRelation: classifySweepDisplacementRelation,
    fmtSweepTime: fmtSweepTime,
    formatSweepPriceLine: formatSweepPriceLine,
    formatSweepRelationLine: formatSweepRelationLine,
    DEFAULT_MAX_LOOKBACK_BARS: DEFAULT_MAX_LOOKBACK_BARS
};
