/**
 * FVG Scorer（Phase 9.1）
 *
 * 工程评分（0-100），不是 probability，也不是 ICT 官方评分。
 *
 *   Displacement association   40  有匹配 displacement（direction 匹配 + bars <= max）
 *   Gap size / ATR             20  gapAtr 越大分越高（相对 ATR 的缺口更有意义）
 *   Same-chain MSS             15  displacement 同 candle 关联 MSS
 *   AMD direction alignment    15  FVG 方向与 AMD 方向一致
 *   Scenario direction match   10  FVG 方向与 scenario 方向一致
 *
 * Entry Gate 只接受 score >= threshold（默认 60）且 displacementEventId 非空的 FVG。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} fvg FVG 对象
 * @param {Object} [context] {
 *   amdDirection, scenarioDirection, thresholds
 * }
 * @returns {Object} { total, breakdown, passed }
 */
function scoreFvg(fvg, context, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).fvg;
    var w = cfg.scorer.weights;

    var breakdown = {};

    // ---- displacement association (40) ----
    var displacementScore = fvg.displacementEventId ? w.displacementAssociation : 0;
    breakdown.displacement = displacementScore;

    // ---- gap size / ATR (20) ----
    var gapScore = 0;
    if (fvg.gapAtr && fvg.gapAtr > 0) {
        // gapAtr >= 1 → 满分；线性插值
        var raw = Math.min(1, fvg.gapAtr / (cfg.scorer.gapSizeAtrFactor || 1));
        gapScore = Math.round(w.gapSize * raw);
    } else if (fvg.gapPct && fvg.gapPct > 0) {
        // ATR 缺失时用 gapPct fallback：0.001 (~0.1%) → 满分
        gapScore = Math.round(w.gapSize * Math.min(1, fvg.gapPct / 0.001));
    }
    breakdown.gap = gapScore;

    // ---- same-chain MSS (15) ----
    var mssId =
        fvg.metadata && fvg.metadata.displacementMetadata
            ? fvg.metadata.displacementMetadata.mssEventId
            : null;
    var mssScore = mssId ? w.sameChainMss : 0;
    breakdown.mss = mssScore;

    // ---- AMD direction alignment (15) ----
    var amdScore = 0;
    if (context && context.amdDirection) {
        if (context.amdDirection === fvg.direction) {
            amdScore = w.amdAlignment;
        }
    }
    breakdown.amd = amdScore;

    // ---- scenario direction match (10) ----
    var scenarioScore = 0;
    if (context && context.scenarioDirection) {
        if (context.scenarioDirection === fvg.direction) {
            scenarioScore = w.scenarioMatch;
        }
    }
    breakdown.scenario = scenarioScore;

    var total = Math.max(0, Math.min(100,
        displacementScore + gapScore + mssScore + amdScore + scenarioScore
    ));
    var threshold = cfg.scorer.entryThreshold !== undefined ? cfg.scorer.entryThreshold : 60;

    return {
        total: total,
        breakdown: breakdown,
        passed: total >= threshold && !!fvg.displacementEventId
    };
}

module.exports = {
    scoreFvg: scoreFvg
};
