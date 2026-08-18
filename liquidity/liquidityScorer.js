/**
 * Liquidity Strength 评分器
 *
 * 【重要声明】这是项目自定义的量化模型，不是 ICT 官方评分。
 * 所有权重 / bonus 参数均为初始工程参数，供后续 Replay 调整。
 *
 * Strength 只回答：这个 liquidity / cluster 本身有多重要？
 * 不掺入与当前价格的距离（Distance / Draw probability 留给 Draw Engine）。
 *
 * ── Individual ─────────────────────────────────────────
 * score = round((typeWeight + swingTimeframeBonus) * freshness)
 *   - typeWeight 按类型（PMH=90 ... EQH=55 ...）
 *   - swingTimeframeBonus 只对 SWING 生效（5m +0 → 1d +55），
 *     与 swingBaseWeight 合成后 = 表值（5m 20 / 15m 30 / 1h 45 / 4h 60 / 1d 75）
 *   - 非 SWING 不加 timeframeBonus（如 PDH 已含 daily significance，防 double counting）
 *   - freshness 为乘数：ACTIVE 1.0 / TOUCHED 0.8 / SWEPT·BROKEN 0
 *
 * ── Cluster ────────────────────────────────────────────
 * final = min(100, base + confluenceBonus + diversityBonus)
 *   - base = max(有效成员 individual strength)
 *   - confluenceBonus = (有效成员数 - 1) * 每额外成员分，上限 confluenceMax
 *   - diversityBonus  = (有效成员类别数 - 1) * 每额外类别分，上限 diversityMax
 *   - 类别：CALENDAR(PDH/PWH/PMH...) / EQUAL(EQH/EQL) / STRUCTURE(Swing) / SESSION
 *   - 输出 scoring breakdown { base, confluenceBonus, diversityBonus, final } 方便调参
 */
var thresholds = require('../config/thresholds');

var CALENDAR_TYPES = ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'];
var EQUAL_TYPES = ['EQH', 'EQL'];
var SESSION_PREFIX = ['ASIA', 'LONDON', 'NEW_YORK'];

/**
 * liquidity 的类别（用于 diversity bonus）
 */
function categoryOf(liquidity) {
    var t = liquidity.type;
    if (CALENDAR_TYPES.indexOf(t) !== -1) {
        return 'CALENDAR';
    }
    if (EQUAL_TYPES.indexOf(t) !== -1) {
        return 'EQUAL';
    }
    if (t === 'SWING_HIGH' || t === 'SWING_LOW') {
        return 'STRUCTURE';
    }
    for (var i = 0; i < SESSION_PREFIX.length; i++) {
        if (t.indexOf(SESSION_PREFIX[i] + '_') === 0) {
            return 'SESSION';
        }
    }
    return 'OTHER';
}

/**
 * 类型基础权重（SWING 只返回基准值，timeframeBonus 单独由 timeframeBonus() 提供，
 * 避免重复计分）
 */
function baseTypeWeight(liquidity, cfg) {
    var t = liquidity.type;
    if (cfg.typeWeights[t] !== undefined) {
        return cfg.typeWeights[t];
    }
    if (t === 'SWING_HIGH' || t === 'SWING_LOW') {
        return cfg.swingBaseWeight || 20;
    }
    return 0;
}

/**
 * timeframe bonus：只对 SWING 生效（避免 calendar/equal 的 double counting）
 */
function timeframeBonus(liquidity, cfg) {
    if (liquidity.type !== 'SWING_HIGH' && liquidity.type !== 'SWING_LOW') {
        return 0;
    }
    return cfg.swingTimeframeBonus[liquidity.timeframe] || 0;
}

/**
 * freshness 乘数（1.0 / 0.8 / 0）
 */
function freshnessOf(liquidity, cfg) {
    var f = cfg.freshness[liquidity.status];
    return f !== undefined ? f : 0;
}

function clamp(n, min, max) {
    if (n < min) return min;
    if (n > max) return max;
    return n;
}

/**
 * 单个 liquidity 的 strength（0-100）
 */
function scoreIndividual(liquidity, options) {
    var cfg = (options && options.thresholds) || thresholds.strength;
    var raw = (baseTypeWeight(liquidity, cfg) + timeframeBonus(liquidity, cfg)) *
        freshnessOf(liquidity, cfg);
    return clamp(Math.round(raw), 0, 100);
}

/**
 * 有效成员 = ACTIVE / TOUCHED（未消耗）
 */
function isEffective(member) {
    return member.status === 'ACTIVE' || member.status === 'TOUCHED';
}

/**
 * cluster 的 strength 与 breakdown
 * @returns {Object} { base, confluenceBonus, diversityBonus, final }
 */
function scoreCluster(cluster, options) {
    var cfg = (options && options.thresholds) || thresholds.strength;

    var effective = (cluster.members || []).filter(isEffective);

    // base = max(有效成员 strength)
    var base = 0;
    effective.forEach(function (m) {
        var s = scoreIndividual(m, options);
        if (s > base) base = s;
    });

    // confluence：成员互相印证
    var confluence =
        (effective.length - 1) * (cfg.confluencePerAdditionalMember || 0);
    confluence = clamp(confluence, 0, cfg.confluenceMax || 24);

    // diversity：类别多样性
    var catSet = {};
    effective.forEach(function (m) {
        catSet[categoryOf(m)] = true;
    });
    var catCount = 0;
    Object.keys(catSet).forEach(function () {
        catCount++;
    });
    var diversity = (catCount - 1) * (cfg.diversityPerCategory || 0);
    diversity = clamp(diversity, 0, cfg.diversityMax || 15);

    var final = clamp(base + confluence + diversity, 0, 100);

    return {
        base: base,
        confluenceBonus: confluence,
        diversityBonus: diversity,
        final: final
    };
}

module.exports = {
    categoryOf: categoryOf,
    baseTypeWeight: baseTypeWeight,
    timeframeBonus: timeframeBonus,
    freshnessOf: freshnessOf,
    scoreIndividual: scoreIndividual,
    scoreCluster: scoreCluster
};
