/**
 * Liquidity Cluster —— 流动性地图的核心
 *
 * Cluster 是 Registry 的【派生视图】，不写入 Registry：
 * - 只允许 BSL 与 BSL 聚类、SSL 与 SSL 聚类（绝不允许混合）
 * - 聚类只使用有效成员（ACTIVE / TOUCHED），已消耗成员（SWEPT / BROKEN）
 *   不参与形成新 cluster，但会按价格区间回溯归属到已有 cluster，
 *   用于推导 state（ACTIVE / PARTIAL / CONSUMED）
 *
 * 聚类算法（zone 链式扩展，与 EQH 的“与锚点比较”不同）：
 * - 同 side 有效成员按价格升序排序
 * - 组初始 = 第一个成员，zone = [price, price]
 * - 后续成员并入条件：cand.price - zoneHigh <= cand.price * percentageTolerance
 *   （即与当前 zone 上沿比较，允许 63390 → 63401 → 63408 → 63415 的链式合并）
 * - 并入后扩展 zoneHigh；无法并入 → 开启新组（不重复使用已归属成员）
 * - 至少 2 个成员才构成 cluster（单成员视为 standalone liquidity）
 *
 * 防未来数据：member.confirmedAt <= evaluationTime 才参与计算。
 * 不修改单个 Liquidity 的 lifecycle 语义（Lifecycle 继续管理单个 liquidity）。
 */
var thresholds = require('../config/thresholds');

/**
 * 计算 zone 容差 = max(price * percentageTolerance, tickSize * tickMultiplier)
 * tickSize 缺失时退化为纯百分比（不阻塞系统）
 */
function toleranceFor(price, percentageTolerance, tickSize, tickMultiplier) {
    var percent = (percentageTolerance || 0) * price;
    var tick = (tickSize || 0) * (tickMultiplier || 2);
    return Math.max(percent, tick);
}

/**
 * 按 side 聚类有效成员 → 返回 cluster 数组
 * @param {Array} liquidities 全量 liquidity（含历史），每个都须 confirmedAt <= evaluationTime
 * @param {Object} [options] { symbol, evaluationTime, thresholds, percentageTolerance }
 */
function buildClusters(liquidities, options) {
    var opts = options || {};
    var symbol = opts.symbol || (liquidities[0] && liquidities[0].symbol) || 'UNKNOWN';
    var evaluationTime =
        opts.evaluationTime !== undefined ? opts.evaluationTime : Date.now();
    var cfg = opts.thresholds || thresholds.liquidityCluster;
    var percentageTolerance =
        opts.percentageTolerance !== undefined
            ? opts.percentageTolerance
            : cfg.percentageTolerance;
    var tickCfg = (opts.thresholds || thresholds).tickSize || thresholds.tickSize;
    var tickSize = opts.tickSize || 0;
    var tickMultiplier =
        opts.tickMultiplier !== undefined
            ? opts.tickMultiplier
            : tickCfg.clusterMultiplier;

    // 防未来数据：只允许已确认的成员参与
    var confirmed = (liquidities || []).filter(function (l) {
        return l && l.confirmedAt <= evaluationTime;
    });

    var clusters = [];
    var sides = ['BSL', 'SSL'];

    sides.forEach(function (side) {
        // 有效成员（ACTIVE / TOUCHED）参与聚类
        var pool = confirmed
            .filter(function (l) {
                return l.side === side && (l.status === 'ACTIVE' || l.status === 'TOUCHED');
            })
            .sort(function (a, b) {
                return a.price - b.price;
            });

        var i = 0;
        while (i < pool.length) {
            var zoneLow = pool[i].price;
            var zoneHigh = pool[i].price;
            var group = [pool[i]];
            var j = i + 1;
            while (j < pool.length) {
                var price = pool[j].price;
                if (price - zoneHigh > toleranceFor(price, percentageTolerance, tickSize, tickMultiplier)) {
                    break; // 与 zone 上沿脱节，开启新组
                }
                zoneHigh = Math.max(zoneHigh, price);
                group.push(pool[j]);
                j++;
            }
            if (group.length >= 2) {
                clusters.push(
                    buildCluster(group, side, symbol, confirmed, percentageTolerance, tickSize, tickMultiplier)
                );
            }
            i = j; // 跳过已归属区域，避免重复分组
        }
    });

    return clusters;
}

/**
 * 由组内有效成员 + 历史回溯成员构建 cluster
 */
function buildCluster(group, side, symbol, allConfirmed, percentageTolerance, tickSize, tickMultiplier) {
    var prices = [];
    group.forEach(function (m) {
        prices.push(m.price);
    });
    var zoneLow = Math.min.apply(null, prices);
    var zoneHigh = Math.max.apply(null, prices);

    // 历史回溯：同 side、价格落在 [zoneLow, zoneHigh] 的 SWEPT/BROKEN 归入本 cluster
    // （已在组内的成员不重复添加）
    var inGroup = {};
    group.forEach(function (m) {
        inGroup[m.id] = true;
    });
    var members = group.slice();
    allConfirmed.forEach(function (l) {
        if (inGroup[l.id]) {
            return;
        }
        if (l.side !== side) {
            return;
        }
        if (l.status === 'SWEPT' || l.status === 'BROKEN') {
            if (l.price >= zoneLow && l.price <= zoneHigh) {
                members.push(l);
            }
        }
    });
    members.sort(function (a, b) {
        return a.price - b.price;
    });

    var activeMembers = 0;
    var sweptMembers = 0;
    var brokenMembers = 0;
    members.forEach(function (m) {
        if (m.status === 'ACTIVE' || m.status === 'TOUCHED') {
            activeMembers++;
        } else if (m.status === 'SWEPT') {
            sweptMembers++;
        } else if (m.status === 'BROKEN') {
            brokenMembers++;
        }
    });

    var consumed = sweptMembers + brokenMembers;
    var state =
        consumed === 0 ? 'ACTIVE' : activeMembers > 0 ? 'PARTIAL' : 'CONSUMED';

    // confirmedAt = max(member.confirmedAt)：cluster 只有在最后确认的成员出现后才存在
    var confirmedAt = 0;
    members.forEach(function (m) {
        if (m.confirmedAt > confirmedAt) {
            confirmedAt = m.confirmedAt;
        }
    });

    var source = null;
    members.forEach(function (m) {
        if (!source && m.metadata && m.metadata.source) {
            source = m.metadata.source;
        }
    });

    return {
        id: symbol + ':CLUSTER:' + side + ':' + zoneLow,
        symbol: symbol,
        side: side,
        zoneLow: zoneLow,
        zoneHigh: zoneHigh,
        centerPrice: (zoneLow + zoneHigh) / 2,
        members: members,
        activeMembers: activeMembers,
        sweptMembers: sweptMembers,
        brokenMembers: brokenMembers,
        state: state,
        confirmedAt: confirmedAt,
        strength: 0, // 由 liquidityScorer 填充
        metadata: {
            toleranceUsed: toleranceFor(zoneHigh, percentageTolerance, tickSize, tickMultiplier),
            source: source,
            categories: [], // 由 liquidityScorer 填充
            strengthBreakdown: null
        }
    };
}

/**
 * 计算一条 ACTIVE liquidity 是否属于任何 cluster 的成员
 * @returns {Array} standalone（未进任何 cluster）的 ACTIVE liquidity
 */
function findStandalone(liquidities, clusters, options) {
    var opts = options || {};
    var evaluationTime =
        opts.evaluationTime !== undefined ? opts.evaluationTime : Date.now();
    var memberIds = {};
    clusters.forEach(function (c) {
        c.members.forEach(function (m) {
            memberIds[m.id] = true;
        });
    });
    return (liquidities || []).filter(function (l) {
        return (
            l &&
            l.confirmedAt <= evaluationTime &&
            (l.status === 'ACTIVE' || l.status === 'TOUCHED') &&
            !memberIds[l.id]
        );
    });
}

module.exports = {
    toleranceFor: toleranceFor,
    buildCluster: buildCluster,
    buildClusters: buildClusters,
    findStandalone: findStandalone
};
