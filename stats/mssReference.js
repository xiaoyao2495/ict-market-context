/**
 * Phase 11D.4 — MSS Reference Quality（第一版启发式，诊断用，不改变 MSS 检测本身）
 *
 * 维度（从 MSS 事件 + registry swing 提取）：
 *   referenceTimeframe      reference swing 的 timeframe（当前全为 5m，HTF 相关用结构极值近似）
 *   referenceType           SWING_HIGH / SWING_LOW
 *   referenceAgeBars        MSS 确认根 - reference 极值根
 *   distanceFromSweep       近似：reference 与 MSS 前最近 sweep 目标的价格距离（无 sweep 时 null）
 *   wasLatestOpposingSwing  reference 是否为 MSS 前最近的一个同型 swing（sweep 前最后 opposing 结构）
 *   didReferenceCreateLastImpulse  reference 后立即反向推进（ageBars 小且无中间反向结构）
 *   breakPct / breakAtr / breakBodyRatio / displacementScore  MSS 突破质量（breakPct/bodyRatio 现有；
 *                           breakAtr/displacementScore 依赖 ATR/同根 displacement，缺失时 null）
 *
 * 四档（核心不是 timeframe，而是"这个 swing 是否代表 sweep 前最后推动价格拿流动性的 opposing structure"）：
 *   MICRO_INTERNAL    近/弱结构，非关键 opposing
 *   INTERNAL          是最近 opposing 或突破较强，但缺一
 *   PROTECTED_SWING   是 sweep 前最后 opposing swing 且突破扎实
 *   HTF_RELEVANT      近期结构极值 + 最后 opposing + 强突破（HTF 相关）
 *   NO_REFERENCE      无 reference（机会无 MSS）
 */
var HTF_WINDOW_BARS = 96; // 8 小时（5m）——"近期关键结构"窗口

/**
 * @param {Object} mssEvent MSS 事件（source.referenceSwingId / breakPct / metadata.bodyRatio）
 * @param {Array} swings registry swings（含 index / confirmedAt / type / price）
 * @returns {Object} { quality, dims }
 */
function classifyMssReference(mssEvent, swings) {
    if (!mssEvent || !mssEvent.source || !mssEvent.source.referenceSwingId) {
        return { quality: 'NO_REFERENCE', dims: {} };
    }
    var refId = mssEvent.source.referenceSwingId;
    var ref = null;
    (swings || []).forEach(function (s) {
        if (!ref && s.id === refId) ref = s;
    });
    if (!ref) {
        return { quality: 'NO_REFERENCE', dims: {} };
    }
    var mssIndex = mssEvent.candleIndex !== undefined ? mssEvent.candleIndex : 0;
    // registry swing 的极值 K index 存在 metadata.index（swingLiquidity 输出），顶层 index 可能缺失
    var refIndex = ref.index !== undefined && ref.index !== null
        ? ref.index
        : (ref.metadata && ref.metadata.index !== undefined && ref.metadata.index !== null
            ? ref.metadata.index : null);
    var dims = {
        referenceTimeframe: ref.timeframe || '5m',
        referenceType: ref.type || null,
        referenceAgeBars: refIndex !== null ? mssIndex - refIndex : null,
        breakPct: mssEvent.source.breakPct !== undefined ? mssEvent.source.breakPct : null,
        breakDistance: mssEvent.source.breakDistance !== undefined ? mssEvent.source.breakDistance : null,
        breakBodyRatio: mssEvent.metadata ? mssEvent.metadata.bodyRatio : null,
        breakAtr: null,
        displacementScore: null,
        wasLatestOpposingSwing: false,
        didReferenceCreateLastImpulse: false,
        isRecentExtreme: false
    };
    // wasLatestOpposingSwing：reference 是否 MSS 前 24 根内形成的同型 opposing swing
    // （MSS reference 按"收盘价突破"选择，consumed tracking 会跳过绝对最近的同型 → 用时间窗口
    //   而非绝对 index 最近；24 根 = 2 小时，覆盖 sweep→MSS 的最后一段 delivery）
    var OPPOSING_WINDOW_BARS = 24;
    dims.wasLatestOpposingSwing = refIndex !== null &&
        refIndex >= mssIndex - OPPOSING_WINDOW_BARS &&
        refIndex < mssIndex;

    // didReferenceCreateLastImpulse：reference 后立即反向推进（ageBars 小 = 反向 impulse 连续）
    dims.didReferenceCreateLastImpulse = dims.referenceAgeBars <= 6;

    // HTF 相关：reference 是否近期窗口（HTF_WINDOW_BARS）内的同型极值
    var isRecentExtreme = false;
    var windowLo = mssIndex - HTF_WINDOW_BARS;
    var extremePrice = null;
    (swings || []).forEach(function (s) {
        if (s.type !== ref.type) return;
        var idx = s.index !== undefined ? s.index : -1;
        if (idx < windowLo || idx >= mssIndex) return;
        if (extremePrice === null ||
            (ref.type === 'SWING_HIGH' ? s.price > extremePrice : s.price < extremePrice)) {
            extremePrice = s.price;
        }
    });
    if (extremePrice !== null) {
        isRecentExtreme = ref.type === 'SWING_HIGH'
            ? ref.price >= extremePrice - 1e-9
            : ref.price <= extremePrice + 1e-9;
    }
    dims.isRecentExtreme = isRecentExtreme;

    var strong = (dims.breakPct !== null && dims.breakPct >= 0.0008) &&
        (dims.breakBodyRatio !== null && dims.breakBodyRatio >= 0.5);

    var quality;
    if (dims.wasLatestOpposingSwing && isRecentExtreme && strong) {
        quality = 'HTF_RELEVANT';
    } else if (dims.wasLatestOpposingSwing && strong) {
        quality = 'PROTECTED_SWING';
    } else if (dims.wasLatestOpposingSwing || strong) {
        quality = 'INTERNAL';
    } else {
        quality = 'MICRO_INTERNAL';
    }
    return { quality: quality, dims: dims };
}

/**
 * MSS Reference 检测审计（Phase 11D.6 — 纯诊断）
 * 统计全部 MSS 事件的 reference 判定分布，回答"为什么没有 PROTECTED/HTF 档"：
 *   - reference 可找到率 / 类型分布
 *   - wasLatestOpposingSwing / isRecentExtreme / strong 三条件各自命中率
 *   - 四档分布 / NO_REFERENCE 比例
 *   - referenceAgeBars 分布
 * @param {Array} mssEvents
 * @param {Array} swings
 */
function auditMssReferences(mssEvents, swings) {
    var out = {
        total: 0,
        noRef: 0,
        refTypes: {},
        qualityDist: { NO_REFERENCE: 0, MICRO_INTERNAL: 0, INTERNAL: 0, PROTECTED_SWING: 0, HTF_RELEVANT: 0 },
        condHits: { wasLatestOpposingSwing: 0, isRecentExtreme: 0, strong: 0, allThree: 0 },
        ageBars: { le6: 0, le24: 0, gt24: 0 }
    };
    (mssEvents || []).forEach(function (m) {
        if (!m || !m.source || !m.source.referenceSwingId) {
            out.total++;
            out.noRef++;
            out.qualityDist.NO_REFERENCE++;
            return;
        }
        var refId = m.source.referenceSwingId;
        var ref = null;
        (swings || []).forEach(function (s) { if (!ref && s.id === refId) ref = s; });
        if (!ref) {
            out.total++;
            out.noRef++;
            out.qualityDist.NO_REFERENCE++;
            return;
        }
        out.total++;
        out.refTypes[ref.type || 'UNKNOWN'] = (out.refTypes[ref.type || 'UNKNOWN'] || 0) + 1;
        var cls = classifyMssReference(m, swings);
        out.qualityDist[cls.quality] = (out.qualityDist[cls.quality] || 0) + 1;
        var d = cls.dims;
        if (d.wasLatestOpposingSwing) out.condHits.wasLatestOpposingSwing++;
        if (d.isRecentExtreme !== undefined && d.isRecentExtreme) out.condHits.isRecentExtreme++;
        if (d.breakPct !== null && d.breakPct >= 0.0008 && d.breakBodyRatio !== null && d.breakBodyRatio >= 0.5) {
            out.condHits.strong++;
        }
        // 三条件组合（在 classify 内部重新算 isRecentExtreme——为审计暴露，简化用 quality 判断）
        if (cls.quality === 'HTF_RELEVANT' || cls.quality === 'PROTECTED_SWING') {
            out.condHits.allThree++;
        }
        // ageBars 分布
        var age = d.referenceAgeBars;
        if (age <= 6) out.ageBars.le6++;
        else if (age <= 24) out.ageBars.le24++;
        else out.ageBars.gt24++;
    });
    return out;
}

module.exports = {
    classifyMssReference: classifyMssReference,
    auditMssReferences: auditMssReferences,
    HTF_WINDOW_BARS: HTF_WINDOW_BARS
};
