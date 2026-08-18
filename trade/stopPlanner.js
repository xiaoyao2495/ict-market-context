/**
 * Stop Planner（Phase 10）
 *
 * Stop 优先放在让当前 narrative 失效的位置，而不是机械 FVG 边界。
 *
 * LONG 优先级：
 *   1. AMD manipulation sweep low
 *   2. AMD accumulation rangeLow
 *   2.5（Phase 11T.5）retained TradeContextSnapshot invalidationBoundary
 *   3. nearest relevant confirmed swing low
 *   4. FVG zoneLow fallback
 * SHORT 对称（sweep high / rangeHigh / retained long / swing high / zoneHigh）。
 *
 * Phase 11T.5（正式化）：retainedNarrative 是上一轮 AMD narrative 的不可变快照
 * （TradeContextSnapshot），在 current AMD boundary 缺失时恢复 narrative invalidation。
 * INVALID_REFERENCE 规则（锁死）：boundary 存在但不在 entry 风险方向 → 跳过。
 * LONG 只用 entry 下方的 boundary，SHORT 只用 entry 上方的 boundary；
 * 绝不为了"有 narrative stop"而强行采用。
 *
 * Buffer：
 *   max(tickSize * tickBufferMultiplier, ATR * atrBufferMultiplier)
 * LONG：stop = referenceLow - buffer
 * SHORT：stop = referenceHigh + buffer
 *
 * Stop 必须位于 entry 的风险方向，否则 plan invalid。
 */
var thresholds = require('../config/thresholds');

/**
 * @param {Object} input {
 *   direction,          'LONG' | 'SHORT'
 *   entryPrice,
 *   amd,                amdStateMachine 输出（manipulation.sweepEvent.price / accumulation.rangeLow|rangeHigh）
 *   retainedNarrative,  TradeContextSnapshot（Phase 11T.5，可选）——上一轮 AMD narrative 快照
 *   swings,             confirmed swing liquidity 数组（含 price, confirmedAt）
 *   fvg,                FVG 对象（zoneLow/zoneHigh）
 *   evaluationTime,
 *   tickSize,
 *   atr                 当前 ATR 值（可选）
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} {
 *   status: 'READY' | 'INVALID',
 *   price, source, referencePrice, buffer, reason
 * }
 */
function planStop(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).trade;
    var direction = input.direction;
    var entryPrice = input.entryPrice;
    var amd = input.amd || {};
    var swings = input.swings || [];
    var fvg = input.fvg || {};
    var evaluationTime = input.evaluationTime;

    var reference = null;
    var source = null;

    // 1+2. current AMD narrative boundary（Phase 11T.5S 严格版）
    // Narrative invalidation = 整个 AMD narrative 的外侧边界：
    //   LONG  = min(manipulation sweep extreme, accumulation rangeLow)
    //   SHORT = max(manipulation sweep extreme, accumulation rangeHigh)
    // 缺一个用另一个；两个都不存在 → 继续 retained → swing → fvg。
    // INVALID_REFERENCE：reference 必须在 entry 风险方向（LONG: < entry；SHORT: > entry），否则跳过。
    var sweepPrice = (amd.manipulation && amd.manipulation.sweepEvent) ? amd.manipulation.sweepEvent.price : null;
    var accLow = amd.accumulation ? amd.accumulation.rangeLow : null;
    var accHigh = amd.accumulation ? amd.accumulation.rangeHigh : null;
    if (direction === 'LONG') {
        var lows = [];
        if (sweepPrice !== null && sweepPrice !== undefined) lows.push(sweepPrice);
        if (accLow !== null && accLow !== undefined) lows.push(accLow);
        if (lows.length > 0) {
            var strictLow = Math.min.apply(null, lows);
            if (strictLow < entryPrice) {
                reference = strictLow;
                source = lows.length === 2 ? 'NARRATIVE_BOUNDARY' : (lows[0] === sweepPrice ? 'MANIPULATION_SWEEP' : 'ACCUMULATION_RANGE_LOW');
            }
        }
    } else if (direction === 'SHORT') {
        var highs = [];
        if (sweepPrice !== null && sweepPrice !== undefined) highs.push(sweepPrice);
        if (accHigh !== null && accHigh !== undefined) highs.push(accHigh);
        if (highs.length > 0) {
            var strictHigh = Math.max.apply(null, highs);
            if (strictHigh > entryPrice) {
                reference = strictHigh;
                source = highs.length === 2 ? 'NARRATIVE_BOUNDARY' : (highs[0] === sweepPrice ? 'MANIPULATION_SWEEP' : 'ACCUMULATION_RANGE_HIGH');
            }
        }
    }

    // 2.5 retained TradeContextSnapshot boundary（Phase 11T.5 正式化 / 11T.5R 方向校验）
    // 双保险：
    //   a) INVALID_REFERENCE：LONG 只用 entry 下方的 short 边界，SHORT 只用 entry 上方的 long 边界
    //   b) direction 匹配：LONG 只接受 BULLISH narrative，SHORT 只接受 BEARISH（direction=null 拒绝，
    //      DISTRIBUTION retain 时 direction 必非 null；防御性不接受隐式方向）
    if (!reference && input.retainedNarrative && input.retainedNarrative.invalidationBoundary) {
        var ib = input.retainedNarrative.invalidationBoundary;
        var rnDir = input.retainedNarrative.direction;
        if (direction === 'LONG' && rnDir === 'BULLISH' && ib.short !== null && ib.short !== undefined && ib.short < entryPrice) {
            reference = ib.short;
            source = 'RETAINED_NARRATIVE';
        } else if (direction === 'SHORT' && rnDir === 'BEARISH' && ib.long !== null && ib.long !== undefined && ib.long > entryPrice) {
            reference = ib.long;
            source = 'RETAINED_NARRATIVE';
        }
    }

    // 3. nearest relevant confirmed swing（风险方向）
    if (!reference) {
        var confirmed = (swings || []).filter(function (s) {
            return evaluationTime === undefined || s.confirmedAt <= evaluationTime;
        });
        var relevant = confirmed.filter(function (s) {
            if (direction === 'LONG') {
                return s.price < entryPrice;
            }
            return s.price > entryPrice;
        });
        if (relevant.length > 0) {
            relevant.sort(function (a, b) {
                // LONG 取最近的下方 swing（价格最高者），SHORT 取最近的上方（价格最低者）
                if (direction === 'LONG') {
                    return b.price - a.price;
                }
                return a.price - b.price;
            });
            reference = relevant[0].price;
            source = 'SWING_LOW';
            if (direction === 'SHORT') {
                source = 'SWING_HIGH';
            }
        }
    }

    // 4. FVG fallback
    if (!reference) {
        if (direction === 'LONG' && fvg.zoneLow < entryPrice) {
            reference = fvg.zoneLow;
            source = 'FVG_ZONE_LOW';
        } else if (direction === 'SHORT' && fvg.zoneHigh > entryPrice) {
            reference = fvg.zoneHigh;
            source = 'FVG_ZONE_HIGH';
        }
    }

    if (reference === null) {
        return {
            status: 'INVALID',
            price: null,
            source: null,
            referencePrice: null,
            buffer: null,
            reason: 'No valid stop reference found'
        };
    }

    // Buffer
    var tickBuf = (input.tickSize || 0) * cfg.stop.tickBufferMultiplier;
    var atrBuf = (input.atr || 0) * cfg.stop.atrBufferMultiplier;
    var buffer = Math.max(tickBuf, atrBuf);

    var stopPrice;
    if (direction === 'LONG') {
        stopPrice = reference - buffer;
    } else {
        stopPrice = reference + buffer;
    }

    // Stop 必须位于 entry 的风险方向
    var valid =
        (direction === 'LONG' && stopPrice < entryPrice) ||
        (direction === 'SHORT' && stopPrice > entryPrice);
    if (!valid) {
        return {
            status: 'INVALID',
            price: null,
            source: source,
            referencePrice: reference,
            buffer: round4(buffer),
            reason: 'Stop not on risk side of entry'
        };
    }

    return {
        status: 'READY',
        price: round2(stopPrice),
        source: source,
        referencePrice: round2(reference),
        buffer: round4(buffer),
        reason: null
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function round4(n) {
    return Math.round(n * 10000) / 10000;
}

/**
 * Stop Candidates（Phase 11S — Stop Placement Diagnostics）
 *
 * 旁路诊断：生成 MANIPULATION / ACCUMULATION / SWING / FVG 全部候选，
 * 各记录 distance / distanceAtr / resultingRR / valid / isBaseline。
 *
 * 关键约束：
 * - 不改变 planStop 的正式行为（baseline 冻结，仍按优先级链选择）
 * - 不参与 Stop 选择 —— 只记录，供 90 天样本分析 stop 放置是否系统性异常
 * - minRR 不参与 Stop 选择：RR 由 Entry + Stop + 真实 Draw Target 自然得到，
 *   RR 不足 → REJECT，绝不收紧 stop 凑 1.5R
 *
 * @param {Object} input 与 planStop 相同输入（含 entryPrice, targetPrice, atr, direction）
 * @param {Object} [options] { thresholds }
 * @returns {Array} [
 *   {
 *     source, structureRole, referencePrice, price, buffer,
 *     distance, distancePct, distanceAtr, risk, reward, rr, valid, isBaseline
 *   }, ...
 * ]
 */
function buildStopCandidates(input, options) {
    var opts = options || {};
    var cfg = (opts.thresholds || thresholds).trade;
    var direction = input.direction;
    var entryPrice = input.entryPrice;
    var targetPrice = input.targetPrice;
    var amd = input.amd || {};
    var swings = input.swings || [];
    var fvg = input.fvg || {};
    var evaluationTime = input.evaluationTime;
    var atrValue = input.atr || 0;

    // buffer 与正式规则一致：max(tickSize*mult, ATR*mult)
    var tickBuf = (input.tickSize || 0) * cfg.stop.tickBufferMultiplier;
    var atrBuf = atrValue * cfg.stop.atrBufferMultiplier;
    var buffer = Math.max(tickBuf, atrBuf);

    var out = [];

    // Phase 11T：narrative invalidation 参考（候选判定用，不改正式规则）
    var manipExtreme = null;
    if (amd.manipulation && amd.manipulation.sweepEvent) {
        manipExtreme = amd.manipulation.sweepEvent.price;
    }
    var accBoundary = null;
    if (amd.accumulation) {
        accBoundary = direction === 'LONG' ? amd.accumulation.rangeLow : amd.accumulation.rangeHigh;
    }

    function push(source, structureRole, reference, isBaseline) {
        if (reference === null || reference === undefined) {
            return;
        }
        var price = direction === 'LONG' ? reference - buffer : reference + buffer;
        var valid =
            (direction === 'LONG' && price < entryPrice) ||
            (direction === 'SHORT' && price > entryPrice);
        var distance = Math.abs(entryPrice - price);
        var distancePct = entryPrice > 0 ? distance / entryPrice : 0;
        var distanceAtr = atrValue > 0 ? distance / atrValue : null;
        var risk = direction === 'LONG' ? entryPrice - price : price - entryPrice;
        var reward = direction === 'LONG' ? targetPrice - entryPrice : entryPrice - targetPrice;
        var rr = risk > 0 && reward > 0 ? reward / risk : null;
        // Phase 11T：narrative invalidation 判定（该 stop 是否站在让 narrative 失效的位置之外）
        var isBeyondManipExtreme = manipExtreme !== null
            ? (direction === 'LONG' ? price < manipExtreme : price > manipExtreme)
            : null;
        var isBeyondAccRange = accBoundary !== null
            ? (direction === 'LONG' ? price < accBoundary : price > accBoundary)
            : null;
        out.push({
            source: source,
            structureRole: structureRole,
            referencePrice: round2(reference),
            price: valid ? round2(price) : null,
            buffer: round4(buffer),
            distance: valid ? round2(distance) : null,
            distancePct: valid ? round4(distancePct) : null,
            distanceAtr: valid && distanceAtr !== null ? round4(distanceAtr) : null,
            risk: valid ? round2(risk) : null,
            reward: valid ? round2(reward) : null,
            rr: valid && rr !== null ? round2(rr) : null,
            valid: valid,
            isBaseline: !!isBaseline,
            // Phase 11T 诊断字段
            isBeyondManipulationExtreme: isBeyondManipExtreme,
            isBeyondAccumulationRange: isBeyondAccRange,
            narrativeInvalidation: isBeyondManipExtreme === true || isBeyondAccRange === true
        });
    }

    // 1. MANIPULATION sweep（局部 wick 参考）
    if (amd.manipulation && amd.manipulation.sweepEvent) {
        var sweepPrice = amd.manipulation.sweepEvent.price;
        push('MANIPULATION_SWEEP', 'manipulation sweep ' + (direction === 'LONG' ? 'low' : 'high'), sweepPrice, false);
    }

    // 2. ACCUMULATION range edge
    if (amd.accumulation) {
        if (direction === 'LONG') {
            push('ACCUMULATION_RANGE', 'accumulation rangeLow', amd.accumulation.rangeLow, false);
        } else {
            push('ACCUMULATION_RANGE', 'accumulation rangeHigh', amd.accumulation.rangeHigh, false);
        }
    }

    // 2.5 Phase 11T.5S：严格 Narrative Boundary（整个 narrative 的外侧）
    // LONG = min(sweepExtreme, rangeLow)；SHORT = max(sweepExtreme, rangeHigh)；缺一用另一
    {
        var sPrice = (amd.manipulation && amd.manipulation.sweepEvent) ? amd.manipulation.sweepEvent.price : null;
        var aLow = amd.accumulation ? amd.accumulation.rangeLow : null;
        var aHigh = amd.accumulation ? amd.accumulation.rangeHigh : null;
        if (direction === 'LONG') {
            var cLow = [];
            if (sPrice !== null && sPrice !== undefined) cLow.push(sPrice);
            if (aLow !== null && aLow !== undefined) cLow.push(aLow);
            if (cLow.length > 0) {
                push('NARRATIVE_BOUNDARY', 'strict narrative low (min sweep/rangeLow)', Math.min.apply(null, cLow), false);
            }
        } else if (direction === 'SHORT') {
            var cHigh = [];
            if (sPrice !== null && sPrice !== undefined) cHigh.push(sPrice);
            if (aHigh !== null && aHigh !== undefined) cHigh.push(aHigh);
            if (cHigh.length > 0) {
                push('NARRATIVE_BOUNDARY', 'strict narrative high (max sweep/rangeHigh)', Math.max.apply(null, cHigh), false);
            }
        }
    }

    // 2.5 Phase 11T.5/11T.5R：retained TradeContextSnapshot boundary
    // （INVALID_REFERENCE：push 内 valid 校验保证 stop 在 entry 风险方向；direction 匹配：LONG 只接受 BULLISH）
    if (input.retainedNarrative && input.retainedNarrative.invalidationBoundary) {
        var ib2 = input.retainedNarrative.invalidationBoundary;
        if (direction === 'LONG' && input.retainedNarrative.direction === 'BULLISH' && ib2.short !== null && ib2.short !== undefined) {
            push('RETAINED_NARRATIVE', 'retained narrative short boundary', ib2.short, false);
        } else if (direction === 'SHORT' && input.retainedNarrative.direction === 'BEARISH' && ib2.long !== null && ib2.long !== undefined) {
            push('RETAINED_NARRATIVE', 'retained narrative long boundary', ib2.long, false);
        }
    }

    // 3. nearest relevant swing
    var confirmed = (swings || []).filter(function (s) {
        return evaluationTime === undefined || s.confirmedAt <= evaluationTime;
    });
    var relevant = confirmed.filter(function (s) {
        if (direction === 'LONG') {
            return s.price < entryPrice;
        }
        return s.price > entryPrice;
    });
    if (relevant.length > 0) {
        relevant.sort(function (a, b) {
            if (direction === 'LONG') {
                return b.price - a.price; // 最近下方
            }
            return a.price - b.price;
        });
        push('SWING', direction === 'LONG' ? 'nearest swing low' : 'nearest swing high', relevant[0].price, false);
    }

    // 4. FVG zone edge
    if (direction === 'LONG' && fvg.zoneLow !== undefined) {
        push('FVG_FALLBACK', 'FVG zoneLow', fvg.zoneLow, false);
    } else if (direction === 'SHORT' && fvg.zoneHigh !== undefined) {
        push('FVG_FALLBACK', 'FVG zoneHigh', fvg.zoneHigh, false);
    }

    // Phase 11T：5. ATR structural buffer 档位（0.25/0.50/0.75/1.00/1.50/2.00 ATR）
    // 诊断用途：STOP SURVIVAL CURVE 的候选输入。reference = entry ∓ atr*multiplier，
    // 再叠加与正式规则一致的 buffer（保语义一致）。
    var atrTiers = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
    if (atrValue > 0) {
        atrTiers.forEach(function (mult) {
            var ref = direction === 'LONG'
                ? entryPrice - atrValue * mult
                : entryPrice + atrValue * mult;
            push('ATR_BASED', mult + ' ATR structural buffer', ref, false);
        });
    }

    // baseline（正式规则当前选择）：标记
    var baseline = planStop(input, opts);
    if (baseline.status === 'READY') {
        out.forEach(function (c) {
            if (c.source === baseline.source && Math.abs(c.price - baseline.price) < 0.01) {
                c.isBaseline = true;
            }
        });
        // 若 baseline 的 reference 不在候选中（如候选无效但 baseline 有效），补一条
        var matched = out.some(function (c) {
            return c.isBaseline;
        });
        if (!matched) {
            push(baseline.source, 'baseline selection', baseline.referencePrice, true);
        }
    }

    return out;
}

module.exports = {
    planStop: planStop,
    buildStopCandidates: buildStopCandidates
};
