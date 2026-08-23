/**
 * Phase 1 Formation Fix A.4 — Terminal Manipulation Episode（SHADOW，不改 production buildNarratives）
 *
 * 概念（用户冻结，2026-08-21）：Terminal Causal Raid = 在 MSS 前最后一个 manipulation
 * episode 中，从某个 liquidity interaction / extreme 起 price 停止扩展 manipulation，并持续
 * repricing 最终产生 Structural MSS 的那个起点。
 *
 *   Cluster（episode）= 负责组织事件，不决定 causal identity。
 *   price path 本身可否决 liquidity attribution（定义 ⑤）。
 *   episode 内无法客观确定哪个 interaction 启动 repricing → NO_CLEAR_CAUSAL_RAID（定义 ⑥）。
 *
 * 操作化（参数全部可配置，不写死语义；语义 = 以下决策流，不含 nearest/structural/deepest 优先级）：
 *   0. eligible = 同方向 sweeps，prevSameDirMss < bar < MSS。
 *   1. Episode：eligible 按"连续 manipulation 行为"归并（gap ≤ GAP_MAX 归并，同 bar 自动合并）。
 *      取 MSS 前最后一个 episode（ep）。ep.sources[] 持有全部 liquidity identity（不写 structural 硬优先级）。
 *   2. Price-path 否决（定义 ⑤）：扫描 ep 全窗 [ep.firstIdx .. Mi] 的实际反转极值
 *      （BULL=最低 low / BEAR=最高 high）。若该极值比 ep 内任一 *已登记* raid extreme 更深，
 *      且无法对应到已登记 liquidity object → CAUSAL IDENTITY UNKNOWN → NO_CLEAR_CAUSAL_RAID。
 *      （这修复 A.2 的前向盲点：MAT#4 的 73699.2@2721 在 A 之前，本窗能看到。）
 *   3. Repricing-start 检测（定义 ⑥）：在 ep 内找"第一个启动持续 repricing 的 interaction"。
 *      - repricing = 从该 raid 起，price 向 MSS 方向移动 ≥ REP_THRESHOLD·ATR，且中间未被更深的
 *        已登记 raid 重新打开 manipulation。
 *      - 若 ep 内可客观确定唯一启动点（如 MAT#18 B 先启动、A 是 delivery 途中 minor）→ terminal = 该点。
 *      - 若多个 interaction 等价 / candidate pool 未抓到真正 terminal → NO_CLEAR_CAUSAL_RAID（⑥）。
 *   4. Alignment 闸门（兜底，定义 ⑤ 的另一种表述）：ep 选出的 causal.extreme 与 MSS 前窗口实际反转极值
 *      偏差 > ALIGN_ATR·ATR → terminal liquidity 未进 eligible（如 registry 漏标）→ NO_CLEAR_CAUSAL_RAID。
 *   5. 质量闸门（正交，不进定义）：causal 找到但 MSS 无绑定 displacement leg（Disp:-）→ 丢弃
 *      （MAT7/20/21 类独立数据质量问题）。
 *
 * 纪律：复用 replay 输出，无未来泄漏；Detection 冻结；Bias / Outcome / 13A.2 全不动。
 *       本模块是 SHADOW，不接 production、不回写 buildNarratives。
 *
 * 可调参数（经 ctx 传入，默认见下；可配置，不写死语义）：
 *   clusterGapMax    同 episode 归并阈值（根），默认 12
 *   repThresholdAtr  repricing 启动判定阈值（ATR），默认 0.6
 *   alignAtr        MSS 反转位 vs causal 极值 对齐容差（ATR），默认 1.5
 *
 * 诊断：ctx.a4Trace=true 时，每 MSS 的决策 + 落点 + drop 原因写入 ctx.a4Traces[mssId]。
 */
var displacementLeg = require('./displacementLeg');

function extremePriceOf(sw) {
    if (sw.source && sw.source.liquidityPrice != null) return sw.source.liquidityPrice;
    if (sw.price != null) return sw.price;
    return sw.direction === 'BULLISH' ? sw.low : sw.high;
}
// 已登记 raid 的"蜡烛极值"（sweep 那根 bar 的真实 low/high）。
// sweep 事件对象本身不携带 low/high，需从 candles5m[candleIndex] 取。
// 与 actualReverseLevel（也是蜡烛极值）做 apples-to-apples 比较：
// 真实 stop-hunt 的 wick 通常会刺穿 liquidityPrice 几 tick —— 那是合法 sweep 本身，
// 不是"未登记的 terminal extreme"。只有比已登记蜡烛极值明显更深且无对应 raid 才算 unregistered。
function registeredCandleExtreme(sw, candles5m) {
    var c = candles5m[sw.candleIndex];
    if (!c) return sw.direction === 'BULLISH' ? sw.low : sw.high;
    return sw.direction === 'BULLISH' ? c.low : c.high;
}
// BULL 叙事扫 LOW（极端=最低）；BEAR 叙事扫 HIGH（极端=最高）
function moreExtreme(p1, p2, dir) { return dir === 'BULLISH' ? (p1 < p2) : (p1 > p2); }

function drop(ctx, reason) {
    if (ctx && ctx.collectDrops) { (ctx.drops = ctx.drops || []).push(reason); }
}

// 诊断：ctx.a4Trace=true 时记录每个 MSS 的决策轨迹（不改变决策逻辑）
function recordTrace(ctx, tr) {
    if (ctx && ctx.a4Trace) { (ctx.a4Traces = ctx.a4Traces || {})[tr.mssId] = tr; }
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

// [fromIdx, toIdx] 的实际反转极值（BULL=最低 low / BEAR=最高 high），含 fromIdx 之前（向后看）
function actualReverseLevel(candles5m, fromIdx, toIdx, D) {
    if (fromIdx < 0 || toIdx >= candles5m.length) return null;
    var lvl = null;
    for (var i = fromIdx; i <= toIdx; i++) {
        var c = candles5m[i];
        if (!c) continue;
        if (D === 'BULLISH') { if (lvl == null || c.low < lvl) lvl = c.low; }
        else { if (lvl == null || c.high > lvl) lvl = c.high; }
    }
    return lvl;
}

// 从 raidIdx 起，price 向 MSS 方向（D）移动 ≥ thr·ATR（repricing 已启动）。
function startedRepricing(candles5m, raidIdx, Mi, D, thr) {
    if (Mi <= raidIdx) return false;
    var atr = atrWindow(candles5m, raidIdx, 14);
    if (D === 'BULLISH') {
        var lo = candles5m[raidIdx] ? candles5m[raidIdx].low : 0;
        var maxHi = lo;
        for (var k = raidIdx; k <= Mi; k++) {
            var cc = candles5m[k];
            if (cc && cc.high > maxHi) maxHi = cc.high;
        }
        return (maxHi - lo) >= thr * atr;
    } else {
        var hi = candles5m[raidIdx] ? candles5m[raidIdx].high : 0;
        var minLo = hi;
        for (var k2 = raidIdx; k2 <= Mi; k2++) {
            var c2 = candles5m[k2];
            if (c2 && c2.low < minLo) minLo = c2.low;
        }
        return (hi - minLo) >= thr * atr;
    }
}

function buildNarrativesA4(ctx) {
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

        var tr = {
            mssId: m.id, Mi: Mi, D: D, nEligible: elig.length,
            episode: null, episodeFirstIdx: null, episodeLastIdx: null,
            deepestRegisteredExtreme: null, deepestRegisteredIdx: null,
            actualReverseInEpisode: null, pricePathVeto: null,
            repricingStartIdx: null, repricingStartExtreme: null,
            alignResult: null, dispPresent: false,
            certaintyGate: null,
            decision: null, selectedRaidIdx: null
        };
        if (!elig.length) { recordTrace(ctx, tr); return; }

        // ---- 1. Episode：同 episode 归并（组织事件，不决定 causal identity）----
        var episodes = [];
        var cur = null;
        elig.forEach(function (s) {
            if (!cur || (s.candleIndex - cur.lastIdx) > GAP_MAX) {
                cur = { members: [], firstIdx: s.candleIndex, lastIdx: s.candleIndex,
                    sources: [], extreme: extremePriceOf(s), extremeIdx: s.candleIndex };
                episodes.push(cur);
            } else {
                cur.lastIdx = s.candleIndex;
            }
            cur.members.push(s);
            var lt = (s.source && s.source.liquidityType) || '?';
            if (cur.sources.indexOf(lt) < 0) cur.sources.push(lt);
            var e = extremePriceOf(s);
            if (moreExtreme(e, cur.extreme, D)) { cur.extreme = e; cur.extremeIdx = s.candleIndex; }
        });
        var ep = episodes[episodes.length - 1]; // 最后一个 manipulation episode
        tr.episode = { firstIdx: ep.firstIdx, lastIdx: ep.lastIdx,
            extremeIdx: ep.extremeIdx, extreme: ep.extreme, sources: ep.sources.slice() };
        tr.episodeFirstIdx = ep.firstIdx; tr.episodeLastIdx = ep.lastIdx;

        // ---- 2. Price-path 否决（定义 ⑤）：ep 自身 bars [firstIdx .. lastIdx] 的实际反转极值 ----
        // 与"已登记 raid 的蜡烛极值"比较（apples-to-apples）。真实 stop-hunt 的 wick 通常刺穿
        // liquidityPrice 几 tick —— 那是合法 sweep 本身。只有比已登记蜡烛极值**明显更深**
        // （超出 alignAtr·ATR 容差）且无法对应已登记 object → 真正 terminal 未进 eligible → 定义⑤。
        // 窗口只到 ep.lastIdx（不含 MSS 的 rejection 本身），否则 MSS 反转高/低会被误判为"继续 manipulation"。
        var deepestReg = ep.members[0];
        ep.members.forEach(function (s) {
            if (moreExtreme(registeredCandleExtreme(s, candles5m), registeredCandleExtreme(deepestReg, candles5m), D)) deepestReg = s;
        });
        tr.deepestRegisteredExtreme = registeredCandleExtreme(deepestReg, candles5m);
        tr.deepestRegisteredIdx = deepestReg.candleIndex;

        var actualReverse = actualReverseLevel(candles5m, ep.firstIdx, ep.lastIdx, D);
        tr.actualReverseInEpisode = actualReverse;
        var atrVeto = atrWindow(candles5m, ep.lastIdx, 14);
        var deeperThanRegistered = (actualReverse != null) &&
            moreExtreme(actualReverse, tr.deepestRegisteredExtreme, D);
        var gap = (actualReverse != null) ? Math.abs(actualReverse - tr.deepestRegisteredExtreme) : 0;
        // 仅当"明显更深"（超出容差）才视为 unregistered terminal extreme → 否决
        if (deeperThanRegistered && gap > ALIGN_ATR * atrVeto) {
            tr.pricePathVeto = 'UNREGISTERED_DEEPER_EXTREME';
            drop(ctx, 'NO_CLEAR_CAUSAL_RAID'); tr.decision = 'NO_CLEAR_CAUSAL_RAID';
            recordTrace(ctx, tr); return;
        }
        tr.pricePathVeto = 'OK';

        // ---- 3. Repricing-start 检测（定义 ⑥）----
        // 定义 ②：terminal extreme = 价格"停止继续扩展 manipulation"的那个点；即"启动 repricing
        // sequence 的 interaction"。操作化：causal = episode 内**最深**的 member（已登记蜡烛极值最深），
        // 且它确实启动了向 MSS 的 repricing（≥ REP_THRESHOLD·ATR）。
        //   - A_CAUSAL：episode 最晚 raid 即最深且启动 repricing → 选它（terminal = A）。
        //   - B_CAUSAL（MAT#15/#18）：B 比 A 更深（B 启动了 repricing sequence，A 只是 delivery 途中
        //     更浅的 re-tag）→ 选 B（最深且启动 repricing 者），而非更晚但更浅的 A。
        // 若 episode 内无任何 member 启动 repricing → 无法客观确定 → ⑥ NO_CLEAR。
        var startedMembers = ep.members.filter(function (s) {
            return startedRepricing(candles5m, s.candleIndex, Mi, D, REP_THRESHOLD);
        });
        var startCand = null;
        startedMembers.forEach(function (s) {
            if (!startCand ||
                moreExtreme(registeredCandleExtreme(s, candles5m),
                            registeredCandleExtreme(startCand, candles5m), D)) {
                startCand = s;
            }
        });
        if (!startCand) {
            tr.repricingStartIdx = null;
            drop(ctx, 'NO_CLEAR_CAUSAL_RAID'); tr.decision = 'NO_CLEAR_CAUSAL_RAID';
            recordTrace(ctx, tr); return;
        }
        tr.repricingStartIdx = startCand.candleIndex;
        tr.repricingStartExtreme = extremePriceOf(startCand);

        var causal = {
            extremeIdx: startCand.candleIndex,
            extreme: extremePriceOf(startCand),
            sources: ep.sources.slice()
        };

        // ---- 3.5 Conservative Certainty Gate（A.4 收口最后一刀）----
        // 只回答："我现在有没有足够证据宣布这个 raid 是 terminal causal raid？"
        // 任一证据冲突 → NO_CLEAR_CAUSAL_RAID（定义 ⑤/⑥），绝不换另一个 A/B。
        // 目标不是 23/23，而是 Precision > Coverage：宁少勿脏。
        // 不写 case 特判、不调阈值追求 coverage——只检测通用证据冲突。
        var causalReg = registeredCandleExtreme(startCand, candles5m);
        var memberIdxSet = {};
        ep.members.forEach(function (s) { memberIdxSet[s.candleIndex] = true; });

        // G1 (定义 ⑤)：causal 选定后，[causal.extremeIdx, ep.lastIdx] 内存在比
        //   registeredCandleExtreme(causal) 更深（manipulation 方向）且**未登记为 raid**
        //   （candleIndex 不在 ep.members）的 candle extreme → 真正 terminal 可能不在
        //   eligible 集合 → manipulation 在 causal 之后仍扩展 → 不能确定 causal 是 terminal。
        var g1Conflict = false;
        for (var g1 = causal.extremeIdx; g1 <= ep.lastIdx; g1++) {
            var cg1 = candles5m[g1];
            if (!cg1) continue;
            var eg1 = (D === 'BULLISH') ? cg1.low : cg1.high;
            if (!memberIdxSet[g1] && moreExtreme(eg1, causalReg, D)) { g1Conflict = true; break; }
        }
        if (g1Conflict) {
            tr.certaintyGate = 'G1_UNREGISTERED_DEEPER_IN_EPISODE';
            drop(ctx, 'NO_CLEAR_CAUSAL_RAID'); tr.decision = 'NO_CLEAR_CAUSAL_RAID';
            recordTrace(ctx, tr); return;
        }

        // G3 (定义 ⑥ 补充)：最后一个 episode 是单 member（causal 自身），且存在前一个同方向
        //   eligible raid（在 episode 之前，被 GAP_MAX 切断、可能属于同一 manipulation sequence）
        //   比 causal 更深 → 单 member episode 的 causal 可能是 continuation 而非 terminal → 不能确定。
        //   不加此 gate 时，GAP_MAX 把 B/A 拆开后算法只看到最后一个 episode，产生虚假确定性。
        if (ep.members.length === 1) {
            var prevDeeper = null;
            for (var pi = 0; pi < elig.length; pi++) {
                var ps = elig[pi];
                if (ps.candleIndex >= ep.firstIdx) continue; // 只往前看（episode 之前的 eligible）
                if ((ep.firstIdx - ps.candleIndex) > 2 * GAP_MAX) continue; // 太远，非同 sequence
                if (moreExtreme(extremePriceOf(ps), extremePriceOf(startCand), D)) {
                    prevDeeper = ps; break;
                }
            }
            if (prevDeeper) {
                tr.certaintyGate = 'G3_ISOLATED_SINGLE_EPISODE';
                drop(ctx, 'NO_CLEAR_CAUSAL_RAID'); tr.decision = 'NO_CLEAR_CAUSAL_RAID';
                recordTrace(ctx, tr); return;
            }
        }
        tr.certaintyGate = 'PASS';

        // ---- 4. Alignment 闸门（兜底，定义 ⑤ 另一种表述）----
        // 与 step 2 同窗口理念：确认 causal raid 确实是 episode 内的 terminal extreme。
        // 关键修复：窗口 = [causal.extremeIdx, ep.lastIdx]（**不含 MSS rejection 本身**）。
        // 若窗扩到 Mi，MSS 结构突破那一根的 wick 必然比 causal raid 更深（它就是破坏点），
        // 导致 alignReverse 永远更深 → 误杀所有 episode 末端紧接 MSS 的 case（MAT#8/#18 类）。
        // 比较对象用 registeredCandleExtreme（与 step 2 apples-to-apples），不用 liquidityPrice，
        // 避免缓存 liquidity 价 vs 实际 wick 的差异被放大成 >1.5 ATR 误杀。
        var causalRegExtreme = registeredCandleExtreme(startCand, candles5m);
        var atr = atrWindow(candles5m, ep.lastIdx, 14);
        var alignReverse = actualReverseLevel(candles5m, causal.extremeIdx, ep.lastIdx, D);
        if (alignReverse != null && Math.abs(alignReverse - causalRegExtreme) > ALIGN_ATR * atr) {
            tr.alignResult = false;
            drop(ctx, 'NO_CLEAR_CAUSAL_RAID'); tr.decision = 'NO_CLEAR_CAUSAL_RAID';
            recordTrace(ctx, tr); return;
        }
        tr.alignResult = true;

        // ---- 5. 绑定 displacement leg（正交质量闸门）----
        var legs = legByMssId[m.id] || [];
        var hit = null;
        for (var j = 0; j < legs.length; j++) {
            if (legs[j].leg.direction === D) { hit = legs[j]; break; }
        }
        if (!hit) { drop(ctx, 'NO_DISP'); tr.decision = 'NO_DISP'; recordTrace(ctx, tr); return; }
        tr.dispPresent = true;

        var dispIdx = typeof hit.leg.startIndex === 'number' ? hit.leg.startIndex : null;
        tr.decision = 'TERMINAL_MANIPULATION_EPISODE';
        tr.selectedRaidIdx = causal.extremeIdx;
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
            nClusters: episodes.length,
            causalRule: 'TERMINAL_MANIPULATION_EPISODE'
        });
        recordTrace(ctx, tr);
    });
    return out;
}

module.exports = {
    buildNarrativesA4: buildNarrativesA4
};
