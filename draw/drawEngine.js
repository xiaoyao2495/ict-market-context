/**
 * Draw on Liquidity Engine
 *
 * 回答：当前价格更可能被哪一侧的哪一块流动性吸引？
 * （这是 liquidity draw，不是 Bias）
 *
 * 流水线：
 *   build candidates
 *     → calculate distance
 *     → calculate freshness
 *     → drawScorer
 *     → BSL / SSL 分开
 *     → stable sort（tie break）
 *     → primary / secondary
 *     → imbalance
 *     → direction label
 *
 * 排序 tie break（保证 replay / 测试 deterministic）：
 *   1. Draw Score 高
 *   2. Strength 高
 *   3. Distance 近
 *   4. confirmedAt 早
 *   5. id 字典序
 *
 * 方向 label 表达 Liquidity Draw imbalance（不是 Bias）：
 *   imbalance >= +25            → 'BSL'
 *   +10 <= imbalance < +25      → 'LEAN_BSL'
 *   -10 < imbalance < +10       → 'BALANCED'
 *   -25 < imbalance <= -10      → 'LEAN_SSL'
 *   imbalance <= -25            → 'SSL'
 *
 * 空侧保护：某一侧无 candidate 时 primary = null、score = 0（合法，不抛异常）；
 * 两侧都为空时 explanation 明确说明 “No active liquidity draw candidates”。
 */
var liquidityCluster = require('../liquidity/liquidityCluster');
var drawCandidate = require('./drawCandidate');
var distanceScorer = require('./distanceScorer');
var freshnessScorer = require('./freshnessScorer');
var drawScorer = require('./drawScorer');
var thresholds = require('../config/thresholds');

function round1(n) {
    return Math.round(n * 10) / 10;
}

function epsEqual(a, b) {
    return Math.abs(a - b) < 1e-9;
}

/**
 * 稳定排序比较器（tie break 顺序固定）
 */
function compareCandidates(a, b) {
    if (!epsEqual(a.drawScore, b.drawScore)) {
        return b.drawScore - a.drawScore;
    }
    if (!epsEqual(a.strength, b.strength)) {
        return b.strength - a.strength;
    }
    if (a.distanceAbs !== b.distanceAbs) {
        return a.distanceAbs - b.distanceAbs;
    }
    if (a.confirmedAt !== b.confirmedAt) {
        return a.confirmedAt - b.confirmedAt;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * imbalance → 方向 label（阈值边界：+25 / +10 / -10 / -25）
 * @param {number} imbalance
 * @param {Object} cfg draw 段配置（或完整配置，兼容两种调用）
 */
function directionLabel(imbalance, cfg) {
    var drawCfg = cfg && cfg.draw ? cfg.draw : cfg;
    var t = drawCfg.directionThresholds;
    if (imbalance >= t.strongBsl) {
        return 'BSL';
    }
    if (imbalance >= t.leanBsl) {
        return 'LEAN_BSL';
    }
    if (imbalance > t.leanSsl) {
        return 'BALANCED';
    }
    if (imbalance > t.strongSsl) {
        return 'LEAN_SSL';
    }
    return 'SSL';
}

/**
 * 可解释性 reasons（每个 primary draw 都要能说清为什么）
 */
function buildReasons(candidate) {
    var reasons = [];
    if (candidate.targetType === 'CLUSTER') {
        reasons.push('Strong liquidity cluster');
        if (candidate.sourceTypes.length >= 2) {
            reasons.push(candidate.sourceTypes.join(' + ') + ' confluence');
        }
    } else {
        reasons.push('Standalone liquidity level');
    }
    reasons.push((candidate.distancePct * 100).toFixed(2) + '% from current price');
    if (candidate.freshness >= 100) {
        reasons.push('Fully active / fresh');
    } else if (candidate.freshness >= 75) {
        reasons.push('Partially consumed');
    } else {
        reasons.push('Reduced freshness');
    }
    return reasons;
}

/**
 * 运行 Draw Engine
 * @param {Object} options
 *   { symbol, currentPrice, evaluationTime, registry, clusters, thresholds? }
 * @returns {Object} 完整 draw 结果
 */
function runDrawEngine(options) {
    var symbol = options.symbol;
    var currentPrice = options.currentPrice;
    var evaluationTime = options.evaluationTime;
    var registry = options.registry;
    var clusters = options.clusters || [];
    var cfg = options.thresholds || thresholds;
    var drawCfg = cfg.draw || cfg; // draw 段配置（scorer 统一接收 draw 段）

    if (typeof currentPrice !== 'number' || currentPrice <= 0) {
        throw new Error('runDrawEngine: currentPrice must be a positive number');
    }
    if (!registry) {
        throw new Error('runDrawEngine: registry required');
    }

    // standalone = 未进任何 cluster 的 ACTIVE/TOUCHED liquidity
    var all = registry.getAll(symbol);
    var standalone = liquidityCluster.findStandalone(all, clusters, {
        evaluationTime: evaluationTime
    });

    // 1. build candidates
    var candidates = drawCandidate.buildCandidates({
        symbol: symbol,
        currentPrice: currentPrice,
        evaluationTime: evaluationTime,
        clusters: clusters,
        standalone: standalone
    });

    // 2-4. distance / freshness / draw score
    candidates.forEach(function (c) {
        c.distanceAbs = Math.abs(c.targetPrice - currentPrice);
        c.distancePct = c.distanceAbs / currentPrice;
        c.distanceScore = distanceScorer.scoreDistance(c.distancePct, drawCfg);
        c.freshness = freshnessScorer.scoreFreshness(c, drawCfg);
        var breakdown = drawScorer.scoreDraw(c, { thresholds: cfg });
        c.drawScore = breakdown.final;
        c.breakdown = breakdown;
    });

    // 5. 分侧 + 稳定排序
    var bslCandidates = candidates
        .filter(function (c) {
            return c.side === 'BSL';
        })
        .sort(compareCandidates);
    var sslCandidates = candidates
        .filter(function (c) {
            return c.side === 'SSL';
        })
        .sort(compareCandidates);

    var primaryBsl = bslCandidates[0] || null;
    var secondaryBsl = bslCandidates[1] || null;
    var primarySsl = sslCandidates[0] || null;
    var secondarySsl = sslCandidates[1] || null;

    // Phase 11D.2 — Near / Macro Draw 双层目标（Phase 11N 证据：4h Primary Draw Hit 仅 11-28%，
    // "最强目标"≠"未来 1h 最可能到达的目标"）
    //   near  = 每侧 distanceAbs 最小（近端 1h reachable liquidity，用于 30m/1h 机会验证）
    //   macro = drawScore 最高（原 primary，HTF structural target，保留 narrative 完整性）
    // 若最近的就是最强，near === macro（合法：近端即主目标）。
    function nearestOf(list) {
        if (!list || list.length === 0) return null;
        var best = list[0];
        for (var k = 1; k < list.length; k++) {
            if (list[k].distanceAbs < best.distanceAbs) {
                best = list[k];
            }
        }
        return best;
    }
    var nearBsl = nearestOf(bslCandidates);
    var nearSsl = nearestOf(sslCandidates);

    var bslScore = primaryBsl ? primaryBsl.drawScore : 0;
    var sslScore = primarySsl ? primarySsl.drawScore : 0;
    var imbalance = round1(bslScore - sslScore);
    var direction = directionLabel(imbalance, drawCfg);

    // 10. explanation
    if (primaryBsl) {
        primaryBsl.reasons = buildReasons(primaryBsl);
    }
    if (primarySsl) {
        primarySsl.reasons = buildReasons(primarySsl);
    }
    if (nearBsl && nearBsl !== primaryBsl) {
        nearBsl.reasons = buildReasons(nearBsl);
    }
    if (nearSsl && nearSsl !== primarySsl) {
        nearSsl.reasons = buildReasons(nearSsl);
    }

    return {
        symbol: symbol,
        currentPrice: currentPrice,
        evaluationTime: evaluationTime,
        bsl: {
            candidates: bslCandidates,
            primary: primaryBsl,
            secondary: secondaryBsl,
            // Phase 11D.2：near = 近端可达目标（distanceAbs 最小）
            near: nearBsl,
            // Phase 11D.2：macro = HTF structural target（drawScore 最高，= primary）
            macro: primaryBsl,
            score: bslScore
        },
        ssl: {
            candidates: sslCandidates,
            primary: primarySsl,
            secondary: secondarySsl,
            near: nearSsl,
            macro: primarySsl,
            score: sslScore
        },
        imbalance: imbalance,
        direction: direction,
        explanation: !primaryBsl && !primarySsl
            ? 'No active liquidity draw candidates'
            : null
    };
}

module.exports = {
    runDrawEngine: runDrawEngine,
    compareCandidates: compareCandidates,
    directionLabel: directionLabel
};
