/**
 * Narrative Stats（Phase 11D — Narrative Diagnostics）
 *
 * 目标：先完全不看交易盈亏，研究 Narrative 本身有没有方向价值。
 *
 * 三张核心表：
 * 1. BIAS × AMD DIRECTION：各组合出现频率（occupancy）
 *    - Bullish Bias + Bullish AMD / Bearish AMD
 *    - Bearish Bias + Bearish AMD / Bullish AMD
 *    - NEUTRAL Bias（对照）
 * 2. ALIGNMENT 后续结果：MATCH / OPPOSITE / UNCONFIRMED 分别统计
 *    未来 12/24/48 根的 MFE / MAE（按 AMD direction 方向）/ Primary Draw hit rate
 * 3. AMD ROLE：CONTINUATION / RETRACEMENT / REVERSAL_CANDIDATE / COUNTER_TREND / UNCLASSIFIED
 *    - 静态分类（基于 bias direction + confidence + alignment）
 *
 * 关键验证假设：
 *   HTF Bias bullish + 5m bearish AMD 到底是"坏的 OPPOSITE"，
 *   还是经常只是 HTF 方向里的正常 retracement？
 *   → 若 OPPOSITE 的后续 MFE（按 bias 方向）显著为正，说明是 retracement 而非反转。
 *
 * 所有统计 evaluationTime 驱动，只使用已收盘 candle。非 probability。
 */
var thresholds = require('../config/thresholds');

var LOOKAHEADS = [12, 24, 48];

var AMD_ROLE = {
    CONTINUATION: 'CONTINUATION',
    RETRACEMENT: 'RETRACEMENT',
    REVERSAL_CANDIDATE: 'REVERSAL_CANDIDATE',
    COUNTER_TREND: 'COUNTER_TREND',
    UNCLASSIFIED: 'UNCLASSIFIED'
};

/**
 * 1. Bias × AMD Direction 组合 occupancy
 * @param {Array} steps replay steps（含 biasDirection / amdState / amdDirection）
 * @returns {Object} { rows: [{bias, amd, count, pct}], total }
 */
function biasAmdTable(steps) {
    var combos = {};
    var total = 0;
    (steps || []).forEach(function (s) {
        var bias = s.biasDirection || 'NEUTRAL';
        // AMD direction 只在 manipulation/distribution 明确时统计
        var amdDir = null;
        if (s.amdState === 'MANIPULATION_CONFIRMED' || s.amdState === 'DISTRIBUTION_CONFIRMED') {
            amdDir = s.amdDirection || null;
        }
        var key = bias + '|' + (amdDir || 'NONE');
        combos[key] = (combos[key] || 0) + 1;
        total++;
    });
    var rows = Object.keys(combos).sort().map(function (k) {
        var parts = k.split('|');
        return {
            bias: parts[0],
            amd: parts[1],
            count: combos[k],
            pct: total > 0 ? combos[k] / total * 100 : 0
        };
    });
    return { rows: rows, total: total };
}

/**
 * 2. Alignment 后续结果：未来 lookahead 根的 MFE / MAE / Primary Draw hit rate
 *
 * 对每个"AMD direction 明确"的 step：
 *   - 方向参考：amdDirection（bullish 用 high 计 MFE，bearish 对称）
 *   - MFE / MAE 按该方向（% of entry price）
 *   - Primary Draw hit：direction 对应的 draw primary target 在未来 N 根内被触及
 *
 * @param {Array} steps
 * @param {Array} candles 完整 5m（用于索引到未来）
 * @param {Object} [opts] { lookaheads }
 * @returns {Object} {
 *   byAlignment: { MATCH: { n, lookaheads: { 12: {mfee, maee, hitRate}, ... } }, ... }
 * }
 */
function alignmentForwardStats(steps, candles, opts) {
    var o = opts || {};
    var lookaheads = o.lookaheads || LOOKAHEADS;
    var byAlignment = {};
    var candlesByIndex = {};
    (candles || []).forEach(function (c, i) { candlesByIndex[c.openTime] = i; });

    // 快速索引：openTime → array index（steps 的 evaluationTime = candle closeTime，
    // 用 openTime 关联更稳：evaluationTime - barMs + 1）
    var BAR_MS = 300000;
    var indexByClose = {};
    (candles || []).forEach(function (c, i) { indexByClose[c.closeTime] = i; });

    function record(alignment, amdDir, stepIdx, step) {
        if (!byAlignment[alignment]) {
            byAlignment[alignment] = {
                n: 0,
                lookaheads: {}
            };
            lookaheads.forEach(function (lb) {
                byAlignment[alignment].lookaheads[lb] = {
                    mfePct: 0, maePct: 0, hitRate: 0, hitN: 0
                };
            });
        }
        var row = byAlignment[alignment];
        row.n++;
        var price = step.price;
        var entryIdx = indexByClose[step.evaluationTime];
        if (entryIdx === undefined) {
            return;
        }
        // Primary draw target（按 amdDir）
        var target = amdDir === 'BULLISH' ? step.drawPrimaryBsl
            : amdDir === 'BEARISH' ? step.drawPrimarySsl : null;

        lookaheads.forEach(function (lb) {
            var stat = row.lookaheads[lb];
            var maxMfe = 0;
            var maxMae = 0;
            var hit = false;
            var k;
            var to = Math.min(entryIdx + lb, candles.length - 1);
            for (k = entryIdx + 1; k <= to; k++) {
                var c = candles[k];
                if (!c || c.closed === false) continue;
                if (amdDir === 'BULLISH') {
                    maxMfe = Math.max(maxMfe, c.high - price);
                    maxMae = Math.max(maxMae, price - c.low);
                    if (target !== null && c.high >= target) hit = true;
                } else if (amdDir === 'BEARISH') {
                    maxMfe = Math.max(maxMfe, price - c.low);
                    maxMae = Math.max(maxMae, c.high - price);
                    if (target !== null && c.low <= target) hit = true;
                }
            }
            var mfePct = price > 0 ? maxMfe / price * 100 : 0;
            var maePct = price > 0 ? maxMae / price * 100 : 0;
            stat.mfePct += mfePct;
            stat.maePct += maePct;
            if (hit) stat.hitN++;
        });
    }

    (steps || []).forEach(function (s, idx) {
        var amdDir = null;
        if (s.amdState === 'MANIPULATION_CONFIRMED' || s.amdState === 'DISTRIBUTION_CONFIRMED') {
            amdDir = s.amdDirection || null;
        }
        if (!amdDir) return;
        record(s.alignment || 'UNCONFIRMED', amdDir, idx, s);
    });

    // 平均化
    Object.keys(byAlignment).forEach(function (a) {
        var row = byAlignment[a];
        Object.keys(row.lookaheads).forEach(function (lb) {
            var stat = row.lookaheads[lb];
            stat.mfePct = row.n > 0 ? stat.mfePct / row.n : 0;
            stat.maePct = row.n > 0 ? stat.maePct / row.n : 0;
            stat.hitRate = row.n > 0 ? stat.hitN / row.n : 0;
        });
    });

    return byAlignment;
}

/**
 * 3. AMD Role 静态分类
 * @param {Object} step { biasDirection, biasConfidence, amdState, amdDirection, alignment }
 * @returns {string} AMD_ROLE 之一
 */
function amdRoleClassify(step) {
    var bias = step.biasDirection || 'NEUTRAL';
    var amdDir = step.amdDirection || null;
    var alignment = step.alignment || 'UNCONFIRMED';
    var confidence = step.biasConfidence || 'LOW';

    if (!amdDir) {
        return AMD_ROLE.UNCLASSIFIED;
    }
    if (bias === 'NEUTRAL') {
        return AMD_ROLE.UNCLASSIFIED;
    }
    var biasBullish = (bias === 'BULLISH' || bias === 'LEAN_BULLISH');
    var biasBearish = (bias === 'BEARISH' || bias === 'LEAN_BEARISH');
    var sameDir = (biasBullish && amdDir === 'BULLISH') || (biasBearish && amdDir === 'BEARISH');
    var oppDir = (biasBullish && amdDir === 'BEARISH') || (biasBearish && amdDir === 'BULLISH');

    if (alignment === 'MATCH' && sameDir) {
        return AMD_ROLE.CONTINUATION;
    }
    if (alignment === 'OPPOSITE' && oppDir) {
        if (confidence === 'HIGH' || confidence === 'MEDIUM') {
            // HTF 方向内的回调：可能只是 retracement
            return AMD_ROLE.RETRACEMENT;
        }
        // LOW confidence + opposite → 反转候选（HTF bias 本身弱）
        return AMD_ROLE.REVERSAL_CANDIDATE;
    }
    if (oppDir) {
        // alignment 未确认但方向相反（bias NEUTRAL 已在上面排除）
        return AMD_ROLE.COUNTER_TREND;
    }
    return AMD_ROLE.UNCLASSIFIED;
}

/**
 * AMD Role occupancy（Phase 11D 表 3）
 */
function amdRoleTable(steps) {
    var roles = {};
    var total = 0;
    (steps || []).forEach(function (s) {
        var r = amdRoleClassify(s);
        roles[r] = (roles[r] || 0) + 1;
        total++;
    });
    return { roles: roles, total: total };
}

module.exports = {
    biasAmdTable: biasAmdTable,
    alignmentForwardStats: alignmentForwardStats,
    amdRoleClassify: amdRoleClassify,
    amdRoleTable: amdRoleTable,
    AMD_ROLE: AMD_ROLE,
    LOOKAHEADS: LOOKAHEADS
};
