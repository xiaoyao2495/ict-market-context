/**
 * Phase 1 Formation Fix A.2 — Terminal Causal Raid Attribution（SHADOW，不改 production buildNarratives）
 *
 * 概念（用户定案，2026-08-21）：不是 nearest raid、也不是 nearest structural raid，
 * 而是寻找"最后一个启动当前 repricing sequence 的 liquidity acquisition"——其后 rejection → MSS → Disp。
 *
 *   Raid Cluster：同方向 eligible sweeps 按连续 manipulation 行为聚成 cluster。
 *                cluster.sources[] 持有全部 liquidity identity（SWING+EQH+SESSION+PD*…），
 *                不把 structural type 写成硬优先级。
 *   1 MSS : 1 Causal Raid Cluster（fan-out 坍缩）。找不到 → NO_CLEAR_CAUSAL_RAID，不生成 GT Narrative。
 *
 * 操作化（cluster + 最后启动 repricing，忠实于 A/B/AMBIGUOUS 三态）：
 *   1. eligible = 同方向 sweeps，prevSameDirMss < bar < MSS。
 *   2. cluster：连续 raid 间 gap ≤ GAP_MAX（默认 12 根=1h，同一次 manipulation episode）归并；同 bar 自动合并。
 *      cluster.extreme = 该方向最极端的扫单价（BULL 取最低 low-level / BEAR 取最高 high-level）；
 *      cluster.extremeIdx；cluster.sources[]（去重）。
 *   3. terminal causal = 最极端的 cluster（cStar）。
 *      - cStar 即最近 cluster（无更近 raid）→ NEAREST_DEEPEST（rule 3：最近=最深=terminal，A 胜）。
 *      - cStar 较早、最近 cluster 较浅（minor event 在 repricing 途中）→
 *        检 cStar→最近 间是否出现 ≥ REP_THRESHOLD·ATR 的同方向 move（repricing 已启动）：
 *        是 → cStar causal（rule 4，B 胜：EARLIER_DEEPEST_REPRICING）；
 *        否（价格未在 cStar 后启动 repricing，最近 raid 才是新 grab）→ 无法客观区分 → NO_CLEAR（rule 5）。
 *   4. alignment 闸门（rule 5 AMBIGUOUS 兜底）：MSS 前窗口的实际反转极值（actualReverseLevel）
 *      与 cStar.extreme 偏差 > ALIGN_ATR·ATR → terminal liquidity 未进 eligible 集合
 *      （如 registry 漏标真实极值，例 MAT14 的 63872 / MAT4 的 73699）→ NO_CLEAR_CAUSAL_RAID。
 *   5. 质量闸门：causal cluster 找到但 MSS 无绑定 displacement leg（Disp:-）→ 丢弃
 *      （独立于归因的另一数据质量问题，例 MAT7/20/21）。
 *
 * 纪律：复用 replay 输出，无未来泄漏；Detection 冻结；Bias / Outcome / 13A.2 全不动。
 *       本模块是 SHADOW，不接 production、不回写 buildNarratives。
 *
 * 可调参数（经 ctx 传入，默认见下）：
 *   clusterGapMax    同 episode 归并阈值（根），默认 12
 *   repThresholdAtr  repricing 判定阈值（ATR），默认 0.6
 *   alignAtr        MSS 反转位 vs causal 极值 对齐容差（ATR），默认 1.5
 *
 * 诊断（本步新增，不改变任何决策逻辑）：ctx.a2Trace=true 时，
 *   每 MSS 的决策 + 落点 + drop 原因写入 ctx.a2Traces[mssId]（供 23 条 sanity set 对照用）。
 */
var displacementLeg = require('./displacementLeg');

function isStructural(t) {
    if (!t) return false;
    if (t.indexOf('SWING') >= 0) return true;
    return ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'].indexOf(t) >= 0;
}
function extremePriceOf(sw) {
    if (sw.source && sw.source.liquidityPrice != null) return sw.source.liquidityPrice;
    if (sw.price != null) return sw.price;
    return sw.direction === 'BULLISH' ? sw.low : sw.high;
}
// BULL 叙事扫 LOW（极端=最低）；BEAR 叙事扫 HIGH（极端=最高）
function moreExtreme(p1, p2, dir) { return dir === 'BULLISH' ? (p1 < p2) : (p1 > p2); }

function drop(ctx, reason) {
    if (ctx && ctx.collectDrops) { (ctx.drops = ctx.drops || []).push(reason); }
}

// 诊断：ctx.a2Trace=true 时记录每个 MSS 的决策轨迹（不改变决策逻辑）
function recordTrace(ctx, tr) {
    if (ctx && ctx.a2Trace) { (ctx.a2Traces = ctx.a2Traces || {})[tr.mssId] = tr; }
}

function atrWindow(candles5m, idx, n) {
    var sum = 0, cnt = 0;
    for (var i = Math.max(0, idx - n + 1); i <= idx; i++) {
        var c = candles5m[i];
        if (!c) continue;
        sum += (c.high - c.low); cnt++;
    }
    return cnt ? sum / cnt : (candles5m[idx] ? (candles5m[idx].high - candles5m[idx].low) : 1);
}

// cStar.extremeIdx → toIdx 之间，价格是否出现 ≥ thr·ATR 的同方向 move（repricing 已启动）
function repricingFromTo(candles5m, fromIdx, toIdx, D, thr) {
    if (toIdx <= fromIdx) return false;
    var atr = atrWindow(candles5m, fromIdx, 14);
    var move = 0;
    if (D === 'BULLISH') {
        var lo = candles5m[fromIdx] ? candles5m[fromIdx].low : 0;
        var maxHi = lo;
        for (var k = fromIdx; k <= toIdx; k++) {
            var cc = candles5m[k];
            if (cc && cc.high > maxHi) maxHi = cc.high;
        }
        move = maxHi - lo;
    } else {
        var hi = candles5m[fromIdx] ? candles5m[fromIdx].high : 0;
        var minLo = hi;
        for (var k2 = fromIdx; k2 <= toIdx; k2++) {
            var c2 = candles5m[k2];
            if (c2 && c2.low < minLo) minLo = c2.low;
        }
        move = hi - minLo;
    }
    return move >= thr * atr;
}

// MSS 前窗口 [fromIdx, Mi] 的实际反转极值（BULL=最低 low / BEAR=最高 high）
function actualReverseLevel(candles5m, fromIdx, Mi, D) {
    if (fromIdx < 0 || Mi >= candles5m.length) return null;
    var lvl = null;
    for (var i = fromIdx; i <= Mi; i++) {
        var c = candles5m[i];
        if (!c) continue;
        if (D === 'BULLISH') { if (lvl == null || c.low < lvl) lvl = c.low; }
        else { if (lvl == null || c.high > lvl) lvl = c.high; }
    }
    return lvl;
}

function buildNarrativesA2(ctx) {
    var candles5m = ctx.candles5m || ctx.candles || [];
    var sweeps = (ctx.sweeps || []).filter(function (s) {
        return (s.direction === 'BULLISH' || s.direction === 'BEARISH') && typeof s.candleIndex === 'number';
    }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });
    var mssEvents = (ctx.mssEvents || []).filter(function (m) {
        return m && (m.direction === 'BULLISH' || m.direction === 'BEARISH') && typeof m.candleIndex === 'number';
    }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

    var legByDispId = ctx.legByDispId || displacementLeg.buildWindowedLegIndex(
        ctx.displacementEvents || [], candles5m, mssEvents, ctx.swings || []);
    var legByMssId = {};
    Object.keys(legByDispId).forEach(function (did) {
        var leg = legByDispId[did];
        if (!leg || !leg.mssId || !leg.direction) return;
        if (!legByMssId[leg.mssId]) legByMssId[leg.mssId] = [];
        legByMssId[leg.mssId].push({ dispId: did, leg: leg });
    });

    var GAP_MAX = ctx.clusterGapMax != null ? ctx.clusterGapMax : 12;
    var REP_THRESHOLD = ctx.repThresholdAtr != null ? ctx.repThresholdAtr : 0.6;
    var ALIGN_ATR = ctx.alignAtr != null ? ctx.alignAtr : 1.5;

    var out = [];
    mssEvents.forEach(function (m) {
        var Mi = m.candleIndex, D = m.direction;
        // prev same-dir MSS
        var prevIdx = -Infinity;
        for (var p = 0; p < mssEvents.length; p++) {
            if (mssEvents[p].candleIndex >= Mi) break;
            if (mssEvents[p].direction === D) prevIdx = mssEvents[p].candleIndex;
        }
        var elig = sweeps.filter(function (s) {
            return s.direction === D && s.candleIndex > prevIdx && s.candleIndex < Mi;
        });

        // 决策轨迹（诊断，不改变逻辑）
        var tr = {
            mssId: m.id, Mi: Mi, D: D, nEligible: elig.length,
            clusters: [], cStarIdx: null, cStarExtreme: null,
            nearestIdx: null, nearestExtreme: null,
            repricingResult: null, alignResult: null, dispPresent: false,
            decision: null, selectedRaidIdx: null
        };
        if (!elig.length) { recordTrace(ctx, tr); return; }

        // ---- cluster（同 episode 归并）----
        var clusters = [];
        var cur = null;
        elig.forEach(function (s) {
            if (!cur || (s.candleIndex - cur.lastIdx) > GAP_MAX) {
                cur = { members: [], firstIdx: s.candleIndex, lastIdx: s.candleIndex,
                    sources: [], extreme: extremePriceOf(s), extremeIdx: s.candleIndex };
                clusters.push(cur);
            } else {
                cur.lastIdx = s.candleIndex;
            }
            cur.members.push(s);
            var lt = (s.source && s.source.liquidityType) || '?';
            if (cur.sources.indexOf(lt) < 0) cur.sources.push(lt);
            var e = extremePriceOf(s);
            if (moreExtreme(e, cur.extreme, D)) { cur.extreme = e; cur.extremeIdx = s.candleIndex; }
        });
        tr.clusters = clusters.map(function (c) {
            return { firstIdx: c.firstIdx, lastIdx: c.lastIdx, extremeIdx: c.extremeIdx,
                extreme: c.extreme, sources: c.sources.slice() };
        });

        // ---- terminal causal = 最深层 cluster（cStar）----
        var cStar = clusters[0];
        clusters.forEach(function (c) { if (moreExtreme(c.extreme, cStar.extreme, D)) cStar = c; });
        var nearest = clusters[clusters.length - 1];
        tr.cStarIdx = cStar.extremeIdx; tr.cStarExtreme = cStar.extreme;
        tr.nearestIdx = nearest.extremeIdx; tr.nearestExtreme = nearest.extreme;

        var causal = null, rule = null;
        if (cStar === nearest) {
            causal = cStar; rule = 'NEAREST_DEEPEST';
            tr.decision = 'NEAREST_DEEPEST'; tr.selectedRaidIdx = cStar.extremeIdx;
            recordTrace(ctx, tr);
        } else {
            // cStar 较早、nearest 较浅 → rule 4：cStar 是否启动了 repricing？
            var rep = repricingFromTo(candles5m, cStar.extremeIdx, nearest.extremeIdx, D, REP_THRESHOLD);
            tr.repricingResult = rep;
            if (rep) {
                causal = cStar; rule = 'EARLIER_DEEPEST_REPRICING';
                tr.decision = 'EARLIER_DEEPEST_REPRICING'; tr.selectedRaidIdx = cStar.extremeIdx;
                recordTrace(ctx, tr);
            } else {
                drop(ctx, 'NO_CLEAR_REP'); tr.decision = 'NO_CLEAR_REP'; recordTrace(ctx, tr); return;
            }
        }
        if (!causal) return;

        // ---- alignment 闸门（rule 5 兜底：terminal liquidity 未在 eligible 内）----
        var atr = atrWindow(candles5m, Mi, 14);
        var actualReverse = actualReverseLevel(candles5m, causal.extremeIdx, Mi, D);
        if (actualReverse != null && Math.abs(actualReverse - causal.extreme) > ALIGN_ATR * atr) {
            tr.alignResult = false; drop(ctx, 'NO_CLEAR_ALIGN'); tr.decision = 'NO_CLEAR_ALIGN'; recordTrace(ctx, tr); return;
        }
        tr.alignResult = true;

        // ---- 绑定 displacement leg（质量闸门）----
        var legs = legByMssId[m.id] || [];
        var hit = null;
        for (var j = 0; j < legs.length; j++) {
            if (legs[j].leg.direction === D) { hit = legs[j]; break; }
        }
        if (!hit) { drop(ctx, 'NO_DISP'); tr.decision = 'NO_DISP'; recordTrace(ctx, tr); return; }
        tr.dispPresent = true;

        var dispIdx = typeof hit.leg.startIndex === 'number' ? hit.leg.startIndex : null;
        out.push({
            raidSide: D === 'BULLISH' ? 'SSL' : 'BSL',
            raidIndex: causal.extremeIdx,
            raidTime: null,
            mssId: m.id,
            mssIndex: Mi,
            mssTime: m.confirmedAt || null,
            dispId: hit.dispId,
            dispIndex: dispIdx,
            raidToMssBars: Mi - causal.extremeIdx,
            mssToDispBars: dispIdx !== null ? dispIdx - Mi : null,
            clusterSources: causal.sources.slice(),
            nClusters: clusters.length,
            causalRule: rule
        });
        recordTrace(ctx, tr);
    });
    return out;
}

module.exports = {
    isStructural: isStructural,
    buildNarrativesA2: buildNarrativesA2
};
