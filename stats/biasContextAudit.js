/**
 * Phase 13A.1 — 当前 Bias 审计（纯诊断，生产零改动）
 *
 * 用户定案（2026-08-21）：当前 biasEngine 是"组件打分 + 加权总分"（bullScore/bearScore
 * 式），正是要审计的对象。13A 路线：
 *   13A.1 当前 Bias 审计（本模块）→ 13A.2 HTF DC Structure → 13A.3 HTF Liquidity Map →
 *   13A.4 HTF Location → 13A.5 Context × Future Draw Audit → 13A.6 Daily Bias V2 Shadow
 *
 * 本模块回答：当前 Bias Engine 作为"next draw 预测器"的 baseline 能力——
 *   bias.direction = BULLISH 时，未来第一个被 raid 的 significant liquidity 是 BSL 的比例？
 *   组件（liquidity/structure/location/delivery）各自与 next draw 的一致性？
 *   分桶（30m/1h/4h/24h）——"30min 内发生"≠"6h 后才发生"（13.1 纪律）。
 *
 * future label 复用 drawLiquidityAudit 的唯一实现（normalize/buildRaidIndex/isActiveAt/
 * futureLabel——不复制算法）。significant-only（排除 legacy 2-2 swing，13.1 口径）。
 */
var dla = require('./drawLiquidityAudit');

/**
 * 审计当前 Bias。
 * @param {Object} ctx { candles, biasTrace, liquidityObjects, dcSwings, atrSeries,
 *   htf1hCandles, displacementEvents, startIndex }
 * @returns {Object} {
 *   n, biasDirDist, biasAcc, biasByBucket, componentDist, componentAcc, conflictDist,
 *   confidenceBands
 * }
 */
function auditCurrentBias(ctx) {
    var candles = ctx.candles || [];
    var candidates = dla.normalizeCandidates(ctx.liquidityObjects || [], ctx.dcSwings || [], candles)
        .filter(function (c) { return c.type !== 'SWING_HIGH' && c.type !== 'SWING_LOW'; }); // significant-only
    var idxById = dla.buildCandidateIndex(candidates, candles);
    var biasTrace = ctx.biasTrace || [];

    var n = 0;
    var biasDirDist = {};
    var biasHit = 0, biasN = 0;               // 有方向时命中 nextDrawSide
    var biasByBucket = {};                    // 分桶 { n, hit, hitN }
    var componentDist = {};                   // 'liquidity' → { BULLISH: n, BEARISH: n, NEUTRAL: n }
    var componentAcc = {};                    // 'liquidity' → { n, hit }
    var conflictDist = {};                    // 'STRUCTURE_VS_DELIVERY|MAJOR' → n
    var confidenceBands = { lo: { n: 0, hit: 0 }, mid: { n: 0, hit: 0 }, hi: { n: 0, hit: 0 } };

    var start = ctx.startIndex !== undefined ? ctx.startIndex : 0;
    for (var t = start; t < candles.length; t++) {
        var actives = candidates.filter(function (c) { return dla.isActiveAt(c, idxById, t, candles); });
        if (actives.length === 0) continue;
        var label = dla.futureLabel(actives, idxById, t);
        if (!label) continue;

        var bt = biasTrace[t];
        if (!bt || !bt.direction) continue;
        var dir = bt.direction;

        n++;
        biasDirDist[dir] = (biasDirDist[dir] || 0) + 1;

        // bias vs nextDrawSide：BULLISH/LEAN_BULLISH → 预测 BSL；BEARISH/LEAN_BEARISH → SSL；
        // NEUTRAL 不计命中（LEAN 也是方向信号，biasEngine 5 档语义）
        var pred = null;
        if (dir === 'BULLISH' || dir === 'LEAN_BULLISH') pred = 'BSL';
        else if (dir === 'BEARISH' || dir === 'LEAN_BEARISH') pred = 'SSL';
        if (pred) {
            biasN++;
            var hit = pred === label.nextSide;
            if (hit) biasHit++;
            // 分桶
            var bk = dla.raidBucketOf(label.barsToRaid);
            var b = biasByBucket[bk] || (biasByBucket[bk] = { n: 0, hit: 0 });
            b.n++;
            if (hit) b.hit++;
        }

        // 组件 direction 与 nextDraw 一致性（组件有方向时）
        var comps = bt.components || {};
        Object.keys(comps).forEach(function (name) {
            var cd = comps[name];
            if (!cd) return;
            var cdDist = componentDist[name] || (componentDist[name] = {});
            cdDist[cd] = (cdDist[cd] || 0) + 1;
            var cPred = cd === 'BULLISH' ? 'BSL' : cd === 'BEARISH' ? 'SSL' : null;
            if (cPred) {
                var acc = componentAcc[name] || (componentAcc[name] = { n: 0, hit: 0 });
                acc.n++;
                if (cPred === label.nextSide) acc.hit++;
            }
        });

        // conflicts 分布
        (bt.conflicts || []).forEach(function (cf) {
            var key = (cf.type || '?') + '|' + (cf.severity || '?');
            conflictDist[key] = (conflictDist[key] || 0) + 1;
        });

        // confidence 分层（biasEngine 返回 'LOW'/'MEDIUM'/'HIGH' 字符串；仅当 bias 有方向时）
        if (pred && bt.confidence) {
            var band = bt.confidence === 'HIGH' ? 'hi' : bt.confidence === 'MEDIUM' ? 'mid' : 'lo';
            confidenceBands[band].n++;
            if (hit) confidenceBands[band].hit++;
        }
    }

    return {
        n: n,
        biasDirDist: biasDirDist,
        biasAcc: biasN > 0 ? biasHit / biasN : null,
        biasN: biasN,
        biasByBucket: biasByBucket,
        componentDist: componentDist,
        componentAcc: componentAcc,
        conflictDist: conflictDist,
        confidenceBands: confidenceBands
    };
}

module.exports = {
    auditCurrentBias: auditCurrentBias
};
