/**
 * Draw Candidate 构建器
 *
 * 流程（先 Cluster 后 Standalone，天然避免重复）：
 * 1. 只保留 confirmedAt <= evaluationTime 的输入
 * 2. Cluster：ACTIVE / PARTIAL 可用，CONSUMED 排除
 * 3. targetPrice：
 *      BSL Cluster → zoneHigh（真正把上方流动性获取完需要扫到 zone 顶）
 *      SSL Cluster → zoneLow
 *      Standalone  → liquidity.price（zoneLow = zoneHigh = price）
 * 4. 方向过滤：BSL targetPrice 必须 > currentPrice，SSL 必须 < currentPrice
 *    （价格已经越过的 liquidity 不应继续作为 active draw）
 * 5. 收集 cluster member IDs
 * 6. standalone 遍历时，凡 id 已属于某 cluster → 排除
 *    （避免 EQH Cluster 与 EQH 同时进入排名，人为重复计分）
 *
 * Cluster 的 confirmedAt = max(member.confirmedAt)（由 cluster 构造时计算）
 */
var liquidityScorer = require('../liquidity/liquidityScorer');

/**
 * @param {Object} options
 *   symbol, currentPrice, evaluationTime, clusters, standalone
 * @returns {Array} candidate 数组
 */
function buildCandidates(options) {
    var symbol = options.symbol;
    var currentPrice = options.currentPrice;
    var evaluationTime = options.evaluationTime;
    var clusters = options.clusters || [];
    var standalone = options.standalone || [];

    var candidates = [];
    var clusterMemberIds = {};

    // ---- 1. Cluster candidates ----
    clusters.forEach(function (cluster) {
        if (!cluster || cluster.confirmedAt > evaluationTime) {
            return; // 防未来数据
        }
        if (cluster.state === 'CONSUMED') {
            return; // 已消耗，不得作为新 draw target
        }
        if (cluster.state !== 'ACTIVE' && cluster.state !== 'PARTIAL') {
            return;
        }

        var targetPrice = cluster.side === 'BSL' ? cluster.zoneHigh : cluster.zoneLow;

        // 方向过滤：已被价格越过的目标不再参与
        if (cluster.side === 'BSL' && targetPrice <= currentPrice) {
            return;
        }
        if (cluster.side === 'SSL' && targetPrice >= currentPrice) {
            return;
        }

        // 收集成员 id（standalone 阶段排除用）
        (cluster.members || []).forEach(function (m) {
            clusterMemberIds[m.id] = true;
        });

        // sourceTypes 去重
        var sourceTypes = [];
        (cluster.members || []).forEach(function (m) {
            if (sourceTypes.indexOf(m.type) === -1) {
                sourceTypes.push(m.type);
            }
        });

        candidates.push({
            id: 'DRAW:' + cluster.id,
            symbol: symbol,
            side: cluster.side,
            targetType: 'CLUSTER',
            targetPrice: targetPrice,
            zoneLow: cluster.zoneLow,
            zoneHigh: cluster.zoneHigh,
            strength: cluster.strength || 0,
            freshness: 0, // 由 freshnessScorer 填充
            distanceAbs: 0, // 由 drawEngine 填充
            distancePct: 0,
            distanceScore: 0,
            sourceTypes: sourceTypes,
            members: cluster.members || [],
            confirmedAt: cluster.confirmedAt,
            state: cluster.state,
            metadata: {
                clusterId: cluster.id,
                strengthBreakdown: cluster.metadata
                    ? cluster.metadata.strengthBreakdown
                    : null
            }
        });
    });

    // ---- 2. Standalone liquidity ----
    standalone.forEach(function (l) {
        if (!l || l.confirmedAt > evaluationTime) {
            return;
        }
        if (clusterMemberIds[l.id]) {
            return; // 已是 cluster 成员，不重复参与排名
        }

        var targetPrice = l.price;
        if (l.side === 'BSL' && targetPrice <= currentPrice) {
            return;
        }
        if (l.side === 'SSL' && targetPrice >= currentPrice) {
            return;
        }

        candidates.push({
            id: 'DRAW:' + l.id,
            symbol: symbol,
            side: l.side,
            targetType: 'LIQUIDITY',
            targetPrice: targetPrice,
            zoneLow: l.price,
            zoneHigh: l.price,
            strength: liquidityScorer.scoreIndividual(l, {}),
            freshness: 0,
            distanceAbs: 0,
            distancePct: 0,
            distanceScore: 0,
            sourceTypes: [l.type],
            members: [l],
            confirmedAt: l.confirmedAt,
            status: l.status,
            metadata: {}
        });
    });

    return candidates;
}

module.exports = {
    buildCandidates: buildCandidates
};
