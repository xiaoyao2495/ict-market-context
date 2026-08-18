/**
 * Persistent AMD State（Phase 11R — Persistent State Refactor）
 *
 * 真正的增量状态机，替代 Replay 中"每次从头重算快照"的 AMD：
 *
 *   SEARCHING → ACCUMULATION（冻结 range）→ MANIPULATION → DISTRIBUTION
 *   + INVALIDATED（超时 / opposite MSS / range breakout）
 *
 * 关键语义（与快照版 runAmd 的区别）：
 * - accumulation 一旦确认即【冻结】（range/atr/confirmedAt 不再变）
 * - manipulation / distribution 由后续 K 的事件【驱动迁移】，不重新 detect
 * - 只有 INVALIDATED / COMPLETE 后才回到 SEARCHING
 * - 每根 K 调用 updateAmdState 推进
 *
 * accumulation 检测用 endIndex = i - confirmGap（默认 6）：
 * 窗口结束于过去，为冻结后的 sweep → manipulation 留出真实时间窗
 * （这是快照版 amdLookback workaround 的正规化：结构滞后，非未来数据）。
 *
 * 评分对齐 manipulation/detector 权重，confirmThreshold 用 baseline 60
 * （用户审计要求撤回 50 实验值，Phase 11R 冻结策略阈值）。
 */
var thresholds = require('../config/thresholds');
var accumulationDetector = require('./accumulationDetector');

var PHASE_SEARCHING = 'SEARCHING';
var PHASE_ACCUMULATION = 'ACCUMULATION';
var PHASE_MANIPULATION = 'MANIPULATION';
var PHASE_DISTRIBUTION = 'DISTRIBUTION';
var PHASE_INVALIDATED = 'INVALIDATED';

function createAmdState() {
    return {
        phase: PHASE_SEARCHING,
        lastPhase: PHASE_SEARCHING, // 演进后状态（INVALIDATED 可见，供 transition 记录）
        lastDirection: null, // reset 后保留最后方向（供 scenario/alignment 消费）
        direction: null,
        accumulation: null,
        manipulation: null,
        distribution: null,
        confirmedAt: null,
        invalidatedAt: null,
        invalidationReason: null,
        startedAt: null,
        // Phase 11T.4：上一轮 narrative 的 immutable 快照（默认关闭，仅 shadow 诊断用）
        lastNarrative: null
    };
}

function setPhase(state, phase) {
    state.lastPhase = phase;
    state.phase = phase;
}

/**
 * Phase 11T.5S：计算 narrative invalidation boundary（TradeContextSnapshot 用，严格版）
 * Narrative invalidation = 整个 AMD narrative 的外侧边界：
 *   BULLISH（LONG 视角）short 边界 = min(manipulation sweep extreme, accumulation rangeLow)
 *                                    —— 价格跌破两者更外侧者，narrative 才失效
 *   BEARISH（SHORT 视角）long 边界 = max(manipulation sweep extreme, accumulation rangeHigh)
 * 缺一用另一；direction 为 null（accumulation-only）对称使用 range 双沿。
 */
function computeInvalidationBoundary(ln) {
    var acc = ln.accumulation;
    var manip = ln.manipulation;
    var accLow = acc ? acc.rangeLow : null;
    var accHigh = acc ? acc.rangeHigh : null;
    var sweep = manip && manip.sweepPrice !== null && manip.sweepPrice !== undefined ? manip.sweepPrice : null;
    var long = null;
    var short = null;
    if (ln.direction === 'BULLISH') {
        var lows = [];
        if (sweep !== null) lows.push(sweep);
        if (accLow !== null) lows.push(accLow);
        short = lows.length > 0 ? Math.min.apply(null, lows) : null;
        long = accHigh;
    } else if (ln.direction === 'BEARISH') {
        var highs = [];
        if (sweep !== null) highs.push(sweep);
        if (accHigh !== null) highs.push(accHigh);
        long = highs.length > 0 ? Math.max.apply(null, highs) : null;
        short = accLow;
    } else {
        short = accLow;
        long = accHigh;
    }
    return { long: long, short: short };
}

/**
 * Phase 11T.4/11T.5：冻结本轮 narrative 为不可变 TradeContextSnapshot（默认启用）
 * 只拷贝关键标量/嵌套字段，不引用原可变对象（防状态机后续修改污染快照）。
 * 无 narrative 结构（manipulation/accumulation 都无）→ 保留现有 lastNarrative 不覆盖。
 * 注：accumulation-only narrative 的 direction 可能为 null（AMD direction 在 manipulation
 * 确认时才设置）—— invalidationBoundary 用 range 双沿兜底。
 */
function retainLastNarrative(state, candleIndex, cfg) {
    if (!state.manipulation && !state.accumulation) {
        return; // 本轮无 narrative 结构 → 不覆盖已有快照
    }
    var maxAgeBars = cfg && cfg.lastNarrative ? (cfg.lastNarrative.maxAgeBars || 1440) : 1440;
    var snapshot = {
        direction: state.direction,
        accumulation: state.accumulation ? {
            rangeLow: state.accumulation.rangeLow,
            rangeHigh: state.accumulation.rangeHigh,
            confirmedAt: state.accumulation.confirmedAt
        } : null,
        manipulation: state.manipulation ? {
            sweepPrice: state.manipulation.sweepEvent ? state.manipulation.sweepEvent.price : null,
            sweepId: state.manipulation.sweepEvent ? state.manipulation.sweepEvent.id : null,
            sweepConfirmedAt: state.manipulation.sweepEvent ? state.manipulation.sweepEvent.confirmedAt : null,
            confirmedAt: state.manipulation.confirmedAt
        } : null,
        distribution: state.distribution ? {
            mssEventId: state.distribution.mssEvent ? state.distribution.mssEvent.id : null,
            displacementEventId: state.distribution.displacementEvent ? state.distribution.displacementEvent.id : null,
            confirmedAt: state.distribution.confirmedAt
        } : null,
        confirmedAt: state.confirmedAt || (state.manipulation ? state.manipulation.confirmedAt : null),
        expiresAt: candleIndex !== undefined ? candleIndex + maxAgeBars : null,
        invalidationBoundary: { long: null, short: null },
        source: 'AMD_NARRATIVE'
    };
    snapshot.invalidationBoundary = computeInvalidationBoundary(snapshot);
    state.lastNarrative = snapshot;
}

/**
 * INVALIDATED / DISTRIBUTION(COMPLETE) 后重置重新 SEARCHING
 * （保留 lastPhase / lastDirection 供诊断与 scenario 消费）
 * @param {Object} cfg amd 配置段（含 lastNarrative.enabled）
 * @param {number} candleIndex 当前 K 的全局 index（lastNarrative.confirmedIndex 用）
 * @param {boolean} retain 是否冻结本轮 narrative 为 TradeContextSnapshot
 *   Phase 11T.5R：仅 DISTRIBUTION（narrative 完成）retain；
 *   INVALIDATED（narrative 已失败，如 opposite MSS）不 retain —— 失败的 narrative
 *   不得成为未来 Trade Stop 的有效 invalidation boundary
 */
function resetToSearching(state, cfg, candleIndex, retain) {
    if (retain && cfg && cfg.lastNarrative && cfg.lastNarrative.enabled) {
        retainLastNarrative(state, candleIndex, cfg);
    }
    setPhase(state, PHASE_SEARCHING);
    state.lastDirection = state.direction;
    state.accumulation = null;
    state.manipulation = null;
    state.distribution = null;
    state.confirmedAt = null;
    state.startedAt = null;
    state.direction = null;
}

/**
 * 单根 K 推进持久 AMD 状态机
 * @param {Object} state amdState（原地更新，返回新 state）
 * @param {Object} input {
 *   candle, candleIndex, candles（截至当前，升序）, evaluationTime,
 *   newSweeps, newMss, newDisplacements（本根新确认的事件）, registry, draw,
 *   confirmGap（accumulation 检测前移量，默认 6）
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} state（同引用，便于链式）
 */
function updateAmdState(state, input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).amd;
    var accCfg = cfg.accumulation;
    var manipCfg = cfg.manipulation;
    var distCfg = cfg.distribution;
    var confirmGap =
        input.confirmGap !== undefined ? input.confirmGap : 6;
    var candle = input.candle;
    var i = input.candleIndex;
    var evaluationTime = input.evaluationTime;
    var candles = input.candles;
    var symbol = input.symbol;
    var timeframe = input.timeframe || '5m';

    // 终态：DISTRIBUTION（COMPLETE）保持当前根，之后 reset 重新 SEARCHING
    // Phase 11T.5R：DISTRIBUTION 是 narrative 完成 → retain（retain=true）
    if (state.phase === PHASE_DISTRIBUTION) {
        var completedState = state.phase;
        resetToSearching(state, cfg, i, true);
        state.lastPhase = completedState;
        return state;
    }
    // Phase 11T.5R：INVALIDATED 是 narrative 失败 → 不 retain（retain=false），
    // 失败的 narrative 不得成为未来 stop 边界
    if (state.phase === PHASE_INVALIDATED) {
        resetToSearching(state, cfg, i, false);
        return state; // lastPhase 保留 INVALIDATED
    }

    // Phase 11T.4：lastNarrative 生命周期（expiry —— Persistent for trade-context, not permanent memory）
    if (state.lastNarrative && cfg.lastNarrative && cfg.lastNarrative.enabled) {
        var exp = state.lastNarrative.expiresAt;
        if (exp !== null && exp !== undefined && i > exp) {
            state.lastNarrative = null;
        }
    }

    // ================= SEARCHING → ACCUMULATION =================
    if (state.phase === PHASE_SEARCHING) {
        var endIndex = i - confirmGap;
        if (endIndex < accCfg.minBars) {
            return state;
        }
        var acc = accumulationDetector.detectAccumulation({
            candles: candles,
            endIndex: endIndex,
            evaluationTime: evaluationTime,
            timeframe: timeframe,
            symbol: symbol,
            liquidityRegistry: input.registry
        }, opts);
        if (acc && acc.state === 'ACCUMULATION_CONFIRMED') {
            // 冻结 accumulation
            setPhase(state, PHASE_ACCUMULATION);
            state.accumulation = acc;
            state.startedAt = acc.confirmedAt;
            state.confirmedAt = acc.confirmedAt;
        }
        return state;
    }

    // ================= ACCUMULATION → MANIPULATION =================
    if (state.phase === PHASE_ACCUMULATION) {
        var acc2 = state.accumulation;
        var barMs = barMsOf(timeframe);

        // 超时：acc 确认后 manipulationMaxBars 内无匹配 sweep → INVALIDATED
        var barsSinceAcc = Math.floor((evaluationTime - acc2.confirmedAt) / barMs);
        if (barsSinceAcc > manipCfg.maxBars) {
            setPhase(state, PHASE_INVALIDATED);
            state.invalidatedAt = candle.closeTime;
            state.invalidationReason = 'MANIPULATION_TIMEOUT';
            return state;
        }

        // range opposite breakout（条件 D）→ INVALIDATED
        if (
            candle.close < acc2.rangeLow - acc2.atr ||
            candle.close > acc2.rangeHigh + acc2.atr
        ) {
            setPhase(state, PHASE_INVALIDATED);
            state.invalidatedAt = candle.closeTime;
            state.invalidationReason = 'RANGE_OPPOSITE_BREAKOUT';
            return state;
        }

        // 消费新 sweep 事件 → manipulation 候选评估
        var sweeps = input.newSweeps || [];
        for (var si = 0; si < sweeps.length; si++) {
            var ev = sweeps[si];
            if (ev.confirmedAt <= acc2.confirmedAt) {
                continue; // 必须发生在 accumulation 确认之后
            }
            var evBarsAfter = Math.floor((ev.confirmedAt - acc2.confirmedAt) / barMs);
            if (evBarsAfter > manipCfg.maxBars) {
                continue;
            }
            var bullish = ev.side === 'SSL'; // SSL sweep → bullish manipulation
            var boundaryPrice = bullish ? acc2.rangeLow : acc2.rangeHigh;
            var penetration = bullish ? boundaryPrice - ev.price : ev.price - boundaryPrice;
            var tolerance = Math.max(
                acc2.atr * manipCfg.atrTolerance,
                boundaryPrice * manipCfg.percentageTolerance
            );
            var nearBoundary = Math.abs(boundaryPrice - ev.price) <= tolerance;
            if (!nearBoundary && penetration <= 0) {
                continue; // 远离边界且未穿透
            }
            if (penetration > acc2.atr * 2) {
                continue; // 穿透过深 → 更像真突破
            }

            // 评分（对齐原权重）
            var score = evaluateManipulationScore(ev, acc2, penetration, candle, input, cfg);
            if (score >= manipCfg.confirmThreshold) {
                // Phase 11T.4：新一轮 narrative confirmed → lastNarrative 失效（覆盖）
                if (state.lastNarrative) {
                    state.lastNarrative = null;
                }
                setPhase(state, PHASE_MANIPULATION);
                state.direction = bullish ? 'BULLISH' : 'BEARISH';
                state.manipulation = {
                    direction: state.direction,
                    score: score,
                    sweepEvent: ev,
                    penetration: penetration,
                    penetrationAtr: acc2.atr > 0 ? penetration / acc2.atr : 0,
                    confirmedAt: ev.confirmedAt,
                    state: 'MANIPULATION_CONFIRMED'
                };
                state.confirmedAt = ev.confirmedAt;
                return state;
            }
        }

        // opposite MSS（条件 B）：manipulation 前出现反向 MSS → INVALIDATED
        var oppositeMss = (input.newMss || []).filter(function (m) {
            // 尚未有 manipulation 方向，无法判 opposite；这里忽略（快照版才需要）
            return false;
        });
        return state;
    }

    // ================= MANIPULATION → DISTRIBUTION =================
    if (state.phase === PHASE_MANIPULATION) {
        var manip = state.manipulation;
        var barMs2 = barMsOf(timeframe);
        var barsSinceManip = Math.floor((evaluationTime - manip.confirmedAt) / barMs2);
        if (barsSinceManip > distCfg.mssMaxBars) {
            setPhase(state, PHASE_INVALIDATED);
            state.invalidatedAt = candle.closeTime;
            state.invalidationReason = 'DISTRIBUTION_TIMEOUT';
            return state;
        }

        var matchingMss = null;
        var mssList = input.newMss || [];
        for (var mi = 0; mi < mssList.length; mi++) {
            var m = mssList[mi];
            if (m.direction !== state.direction) {
                // opposite MSS → INVALIDATED（条件 B）
                setPhase(state, PHASE_INVALIDATED);
                state.invalidatedAt = candle.closeTime;
                state.invalidationReason = 'OPPOSITE_MSS';
                return state;
            }
            if (m.confirmedAt > manip.confirmedAt) {
                if (!matchingMss || m.confirmedAt < matchingMss.confirmedAt) {
                    matchingMss = m;
                }
            }
        }

        var matchingDisp = null;
        var dispList = input.newDisplacements || [];
        for (var di = 0; di < dispList.length; di++) {
            var d = dispList[di];
            if (d.direction !== state.direction) {
                continue;
            }
            if (matchingMss && d.confirmedAt < matchingMss.confirmedAt) {
                continue; // displacement 必须在 matching MSS 之后
            }
            var dispBarsAfter = Math.floor(
                (d.confirmedAt - (matchingMss ? matchingMss.confirmedAt : manip.confirmedAt)) / barMs2
            );
            if (dispBarsAfter > distCfg.displacementMaxBars) {
                continue;
            }
            if (!matchingDisp || d.confirmedAt < matchingDisp.confirmedAt) {
                matchingDisp = d;
            }
        }

        // distribution 评分：matching MSS 30 + matching displacement 35 = 65 >= 60 → confirmed
        if (matchingMss) {
            var score2 = distCfg.scoreWeights.matchingMss;
            if (matchingDisp) {
                score2 += distCfg.scoreWeights.matchingDisplacement;
                // same-chain bonus（displacement 关联 MSS）
                if (
                    matchingDisp.metadata &&
                    matchingDisp.metadata.mssEventId === matchingMss.id
                ) {
                    score2 += distCfg.scoreWeights.sameDeliveryChain;
                }
            }
            // range escape
            if (
                (state.direction === 'BULLISH' && candle.close > state.accumulation.rangeHigh) ||
                (state.direction === 'BEARISH' && candle.close < state.accumulation.rangeLow)
            ) {
                score2 += distCfg.scoreWeights.rangeEscape;
            }
            if (score2 >= distCfg.confirmThreshold) {
                setPhase(state, PHASE_DISTRIBUTION);
                state.distribution = {
                    direction: state.direction,
                    score: score2,
                    mssEvent: matchingMss,
                    displacementEvent: matchingDisp,
                    rangeEscaped: score2 >= distCfg.scoreWeights.matchingMss + distCfg.scoreWeights.matchingDisplacement,
                    confirmedAt: matchingDisp ? matchingDisp.confirmedAt : matchingMss.confirmedAt,
                    state: 'DISTRIBUTION_CONFIRMED'
                };
                state.confirmedAt = state.distribution.confirmedAt;
                return state;
            }
        }
        return state;
    }

    return state;
}

/**
 * manipulation 评分（对齐 manipulationDetector.evaluateManipulation 权重）
 * 位置已通过前置校验；这里给 reclaim / penetration / liquidity type 加分。
 */
function evaluateManipulationScore(ev, acc, penetration, candle, input, cfg) {
    var w = cfg.manipulation.scoreWeights;
    var score = w.rangeBoundarySweep; // 位置（nearBoundary 或穿透）已满足 → 35

    // liquidity type bonus
    var lt = ev.source && ev.source.liquidityType;
    if (lt === 'EQH' || lt === 'EQL') {
        score += w.equalLiquiditySweep;
    } else if (isCalendarOrSession(lt)) {
        score += w.calendarSessionSweep;
    }

    // reasonable penetration（<= 0.5 ATR 满分）
    var penAtr = acc.atr > 0 ? penetration / acc.atr : 0;
    if (penAtr <= 0.5) {
        score += w.reasonablePenetration;
    } else if (penAtr <= 1.0) {
        score += Math.round(w.reasonablePenetration * 0.5);
    }

    // fast reclaim：sweep 后价格收回 range（用当前 candle 及近几根）
    var reclaimBars = computeReclaimBars(ev, acc, input);
    if (reclaimBars !== null) {
        if (reclaimBars <= 2) {
            score += w.fastReclaim;
        } else if (reclaimBars <= 5) {
            score += Math.round(w.fastReclaim * 0.5);
        }
    }

    return score;
}

function isCalendarOrSession(type) {
    return (
        type === 'PDH' || type === 'PDL' ||
        type === 'PWH' || type === 'PWL' ||
        type === 'PMH' || type === 'PML' ||
        type === 'ASIA_HIGH' || type === 'ASIA_LOW' ||
        type === 'LONDON_HIGH' || type === 'LONDON_LOW' ||
        type === 'NEW_YORK_HIGH' || type === 'NEW_YORK_LOW'
    );
}

/**
 * sweep 后价格收回 accumulation range 所需 bars（基于已知 candles）
 * 简化：扫 sweep candle 之后的已收盘 K，直到 close 回到 [rangeLow, rangeHigh]
 *
 * Phase 11R.2 修复：startIndex 优先用 ev.candleIndex（sweepEventAdapter 已带全局 candleIndex）；
 * 旧实现用 (ev.confirmedAt - candles[0].openTime)/barMs 做时间差除法，
 * 目标窗口内的 ev 距 candles[0] 很远 → startIndex 恒溢出 → reclaim 恒 null，
 * manipulation 的 fastReclaim 加分从未真实生效。
 */
function computeReclaimBars(ev, acc, input) {
    var candles = input.candles || [];
    var startIndex = ev.candleIndex !== undefined ? ev.candleIndex + 1 : null;
    if (startIndex === null) {
        // 兜底：事件无 candleIndex 时按时间差估算
        var barMs = barMsOf(input.timeframe || '5m');
        startIndex = Math.floor((ev.confirmedAt - candles[0].openTime) / barMs) + 1;
    }
    var max = 6;
    for (var k = startIndex; k < Math.min(startIndex + max, candles.length); k++) {
        var c = candles[k];
        if (c.close >= acc.rangeLow && c.close <= acc.rangeHigh) {
            return k - startIndex + 1;
        }
    }
    return null;
}

var BAR_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000
};

function barMsOf(tf) {
    return BAR_MS[tf] || 300000;
}

module.exports = {
    createAmdState: createAmdState,
    updateAmdState: updateAmdState,
    PHASES: {
        SEARCHING: PHASE_SEARCHING,
        ACCUMULATION: PHASE_ACCUMULATION,
        MANIPULATION: PHASE_MANIPULATION,
        DISTRIBUTION: PHASE_DISTRIBUTION,
        INVALIDATED: PHASE_INVALIDATED
    }
};
