/**
 * Delivery Bias —— 最近市场正在往哪边重新定价
 *
 * 只消费【已确认】的事件（confirmedAt <= evaluationTime，不是 K 线 openTime）：
 *   - Liquidity Sweep（SSL sweep = BULLISH / BSL sweep = BEARISH）
 *   - MSS（direction: BULLISH / BEARISH）
 *   - Displacement（direction: BULLISH / BEARISH）
 *
 * 事件链（顺序严格、方向必须匹配、窗口内）：
 *   Bullish: SSL Sweep → Bullish MSS → Bullish Displacement  (+8 / +15 / +25)
 *   Bearish: BSL Sweep → Bearish MSS → Bearish Displacement  (-8 / -15 / -25)
 *   窗口：Sweep→MSS <= sweepToMssBars；MSS→Displacement <= mssToDisplacementBars
 *
 * Freshness（5m 基准）：0-6 bars ×1.0 / 7-12 ×0.75 / 13-24 ×0.5 / >24 ×0.25
 * 多链：只选最相关一条（completedAt 最近 → 完整度高 → |score| 高 → id 字典序），
 *       绝不把多条 delivery 相加。
 */
var thresholds = require('../config/thresholds');

var INTERVAL_MS = {
    '1m': 60000,
    '3m': 180000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '2h': 7200000,
    '4h': 14400000,
    '1d': 86400000
};

function barMsOf(timeframe) {
    return INTERVAL_MS[timeframe] || 300000;
}

/**
 * freshness multiplier by ageBars
 */
function freshnessMultiplier(ageBars, cfg) {
    var bands = cfg.freshnessBands || [];
    var i;
    for (i = 0; i < bands.length; i++) {
        if (ageBars <= bands[i].maxBars) {
            return bands[i].multiplier;
        }
    }
    return cfg.freshnessFallback !== undefined ? cfg.freshnessFallback : 0.25;
}

/**
 * 按 confirmedAt 升序过滤 + 排序
 */
function confirmedEvents(events, evaluationTime) {
    return (events || [])
        .filter(function (e) {
            return e && e.confirmedAt !== undefined && e.confirmedAt <= evaluationTime;
        })
        .sort(function (a, b) {
            return a.confirmedAt - b.confirmedAt;
        });
}

/**
 * 由事件序列构建一条链
 */
function makeChain(sweep, mssEvent, dispEvent, cfg) {
    var bullish = sweep.direction === 'BULLISH';
    var rawScore = cfg.sweepPoints;
    if (mssEvent) {
        rawScore += cfg.mssPoints;
    }
    if (dispEvent) {
        rawScore += cfg.displacementPoints;
    }
    var completedAt = dispEvent
        ? dispEvent.confirmedAt
        : mssEvent
            ? mssEvent.confirmedAt
            : sweep.confirmedAt;

    var reasons = [];
    reasons.push((bullish ? 'SSL' : 'BSL') + ' swept');
    if (mssEvent) {
        reasons.push((bullish ? 'bullish' : 'bearish') + ' MSS');
    }
    if (dispEvent) {
        reasons.push((bullish ? 'bullish' : 'bearish') + ' displacement');
    }

    return {
        direction: sweep.direction,
        rawScore: bullish ? rawScore : -rawScore,
        sweep: sweep,
        mss: mssEvent || null,
        displacement: dispEvent || null,
        completedAt: completedAt,
        reasons: reasons
    };
}

/**
 * 为每个 sweep 构建事件链（窗口内找第一个匹配的 MSS / Displacement）
 */
function buildChains(sweeps, mss, displacements, cfg, barMs) {
    var chains = [];
    sweeps.forEach(function (sweep) {
        var dir = sweep.direction;
        var mssCandidates = mss.filter(function (m) {
            return (
                m.direction === dir &&
                m.confirmedAt >= sweep.confirmedAt &&
                m.confirmedAt - sweep.confirmedAt <= cfg.sweepToMssBars * barMs
            );
        });
        if (mssCandidates.length === 0) {
            chains.push(makeChain(sweep, null, null, cfg));
            return;
        }
        var mssEvent = mssCandidates[0]; // 已按时间升序
        var dispCandidates = displacements.filter(function (d) {
            return (
                d.direction === dir &&
                d.confirmedAt >= mssEvent.confirmedAt &&
                d.confirmedAt - mssEvent.confirmedAt <= cfg.mssToDisplacementBars * barMs
            );
        });
        if (dispCandidates.length === 0) {
            chains.push(makeChain(sweep, mssEvent, null, cfg));
        } else {
            chains.push(makeChain(sweep, mssEvent, dispCandidates[0], cfg));
        }
    });
    return chains;
}

/**
 * 多链排序：completedAt 最近 → 完整度高 → |rawScore| 高 → deterministic id
 */
function chainLevel(c) {
    return c.displacement ? 3 : c.mss ? 2 : 1;
}

function chainId(c) {
    return ((c.sweep && c.sweep.id) || '') + ':' + ((c.mss && c.mss.id) || '') + ':' + ((c.displacement && c.displacement.id) || '');
}

function compareChains(a, b) {
    if (a.completedAt !== b.completedAt) {
        return b.completedAt - a.completedAt; // 最近优先
    }
    var la = chainLevel(a);
    var lb = chainLevel(b);
    if (la !== lb) {
        return lb - la; // 完整度高优先
    }
    var sa = Math.abs(a.rawScore);
    var sb = Math.abs(b.rawScore);
    if (sa !== sb) {
        return sb - sa; // 分高优先
    }
    var ida = chainId(a);
    var idb = chainId(b);
    return ida < idb ? -1 : ida > idb ? 1 : 0;
}

/**
 * 计算 Delivery Bias
 * @param {Object} input { evaluationTime, timeframe, events? , eventRegistry? , symbol? }
 *   events: { sweeps, mss, displacements }（数组接口，向后兼容）
 *   eventRegistry: 统一 Market Event registry（Phase 7.1 起，优先使用）
 *     → 内部按 getByType('LIQUIDITY_SWEEP' / 'STRUCTURAL_MSS' / 'DISPLACEMENT') 取事件
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   available, direction, rawScore, freshnessMultiplier, score,
 *   sweep, mss, displacement, completedAt, ageBars, reasons
 * }
 */
function scoreDeliveryBias(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).bias.delivery;
    var evaluationTime = input.evaluationTime;
    var timeframe = input.timeframe || '5m';
    var barMs = barMsOf(timeframe);

    var sweeps;
    var mss;
    var displacements;
    if (input.eventRegistry) {
        var symbol = input.symbol || 'UNKNOWN';
        sweeps = input.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP');
        mss = input.eventRegistry.getByType(symbol, 'STRUCTURAL_MSS');
        displacements = input.eventRegistry.getByType(symbol, 'DISPLACEMENT');
    } else {
        var ev = input.events || {};
        sweeps = ev.sweeps;
        mss = ev.mss;
        displacements = ev.displacements;
    }

    sweeps = confirmedEvents(sweeps, evaluationTime);
    mss = confirmedEvents(mss, evaluationTime);
    displacements = confirmedEvents(displacements, evaluationTime);

    // Phase 11R.2：结构上有限记忆——事件先裁切到 [evaluationTime - maxLookbackBars, evaluationTime]，
    // 再构造 chain。旧行为只靠 freshness 乘数压低老链（数学上可能仍参与），
    // 现在老事件在结构上就不进入候选池（更易证明收敛）。
    var lookbackMs = (cfg.maxLookbackBars || 48) * barMs;
    var lookbackCut = evaluationTime - lookbackMs;
    sweeps = sweeps.filter(function (e) { return e.confirmedAt >= lookbackCut; });
    mss = mss.filter(function (e) { return e.confirmedAt >= lookbackCut; });
    displacements = displacements.filter(function (e) { return e.confirmedAt >= lookbackCut; });

    if (sweeps.length === 0 && mss.length === 0 && displacements.length === 0) {
        return {
            available: false,
            direction: null,
            rawScore: 0,
            freshnessMultiplier: 0,
            score: 0,
            sweep: null,
            mss: null,
            displacement: null,
            completedAt: null,
            ageBars: null,
            reasons: ['no delivery events']
        };
    }

    var chains = buildChains(sweeps, mss, displacements, cfg, barMs);
    if (chains.length === 0) {
        return {
            available: true,
            direction: null,
            rawScore: 0,
            freshnessMultiplier: 0,
            score: 0,
            sweep: null,
            mss: null,
            displacement: null,
            completedAt: null,
            ageBars: null,
            reasons: ['events present but no valid delivery chain (direction / window mismatch)']
        };
    }

    chains.sort(compareChains);
    var best = chains[0];

    var ageBars = Math.floor((evaluationTime - best.completedAt) / barMs);
    var multiplier = freshnessMultiplier(ageBars, cfg);
    var score = Math.round(best.rawScore * multiplier);

    return {
        available: true,
        direction: best.direction,
        rawScore: best.rawScore,
        freshnessMultiplier: multiplier,
        score: score,
        sweep: best.sweep,
        mss: best.mss,
        displacement: best.displacement,
        completedAt: best.completedAt,
        ageBars: ageBars,
        reasons: best.reasons
    };
}

module.exports = {
    scoreDeliveryBias: scoreDeliveryBias,
    freshnessMultiplier: freshnessMultiplier,
    buildChains: buildChains,
    compareChains: compareChains
};
