/**
 * auditMarketFacts.js —— Daily Bias deterministic context 审计事实
 *
 * ⚠️ 定位（与 auditPivots.js 同）：
 * - 这是给 DeepSeek 提供"已由代码确定的市场事实"的确定性工具：
 *     · Sweep lifecycle：每个已确认 pivot 是否被触及（INTACT / TAKEN）
 *     · Break classification：每个被刺破的 pivot 是 CONTINUATION（顺向延续）
 *       还是 MSS（逆当前 delivery 的方向性 shift），无法判定则 UNCLASSIFIED。
 * - 绝不修改 / 读取任何 production engine（Opportunity / Alert / engine / stats）。
 * - 纯函数、可复现、无外部依赖。
 * - 所有时间严格满足 confirmedAt <= evaluationTime（防未来泄漏），
 *   刺破点一律取"发生刺破的那根 candle"，不引用该 candle 之后的任何收盘。
 *
 * 设计哲学（用户明确）：
 * - 第一版 MSS 分类不做复杂 ICT heuristic。
 * - 如果不能非常确定是 shift → CONTINUATION / UNCLASSIFIED。
 * - 宁可漏掉 MSS，也不要制造假的 MSS。
 */

var auditPivots = require('./auditPivots');

var DIR_VALUES = ['BULLISH', 'BEARISH', 'UNCLEAR'];

/**
 * 计算所有已确认 pivot 的 Sweep lifecycle。
 *
 * @param {Array} candles  全量已收盘 4H 蜡烛（升序，含 openTime/open/high/low/close/closeTime）
 * @param {number} evalIdx evaluationTime 对应蜡烛索引（candles[evalIdx].closeTime = evaluationTime）
 * @param {Object} pivots  detectPivots 产出 { highs:[...], lows:[...] }
 *                      每项含 { price, occurredAt, confirmedAt, _idx }
 * @param {Object} [opts]
 *      wickSlack   {number} 刺破容差（相对 pivot.price 的比例，默认 0，即必须真实越过 price）
 * @returns {Object} { sweeps:[...], evaluationTime }
 *   每个 sweep：
 *     refSide:      'HIGH' | 'LOW'
 *     pivotPrice:   number
 *     occurredAt:   ISO
 *     confirmedAt:  ISO
 *     status:       'INTACT' | 'TAKEN'
 *     takenAt:      ISO | null         （发生刺破的那根 candle 的 openTime）
 *     takenByWick:  boolean | null      （该 candle 影线刺破但收盘未站上/下 → true；收盘越过 → false）
 *     closedBeyond: boolean | null      （该 candle 收盘越过了 pivot.price）
 *     _idx:         pivot 蜡烛索引（内部用）
 */
function computeSweepLifecycle(candles, evalIdx, pivots, opts) {
    var o = opts || {};
    var wickSlack = (o.wickSlack != null) ? o.wickSlack : 0;

    if (evalIdx == null || evalIdx < 0 || evalIdx >= candles.length) {
        throw new Error('computeSweepLifecycle: evalIdx 越界 ' + evalIdx);
    }
    var evaluationTime = candles[evalIdx].closeTime;

    var all = [];
    (pivots.highs || []).forEach(function (p) {
        all.push({ side: 'HIGH', pivot: p });
    });
    (pivots.lows || []).forEach(function (p) {
        all.push({ side: 'LOW', pivot: p });
    });

    var sweeps = all.map(function (item) {
        var side = item.side;        // 该 pivot 是 HIGH 还是 LOW
        var p = item.pivot;
        var price = p.price;
        var confirmedAt = Date.parse(p.confirmedAt);

        // 未来泄漏防护：confirmedAt 必须 <= evaluationTime
        if (confirmedAt > evaluationTime) {
            return {
                refSide: side,
                pivotPrice: price,
                occurredAt: p.occurredAt,
                confirmedAt: p.confirmedAt,
                status: 'INTACT',
                takenAt: null,
                takenByWick: null,
                closedBeyond: null,
                _idx: p._idx,
                _note: 'confirm 在未来（跳过，防泄漏）'
            };
        }

        // 扫描区间：[pivot._idx, evalIdx]（含两端），只看 evaluationTime 之前的蜡烛
        var startK = p._idx;
        var endK = evalIdx;
        var takenK = -1;
        for (var k = startK; k <= endK; k++) {
            var c = candles[k];
            // 该 candle 必须在 confirmedAt 之后（含 confirmedAt 那根；确认点本身不算"被扫"）
            if (c.openTime < confirmedAt) continue;
            if (c.openTime > evaluationTime) break; // 未来保护（理论上不会到 evalIdx 之后）

            var breached = false;
            if (side === 'HIGH') {
                // 空头流动性（BSL 在 swing high 之上）：价格向上刺破 high
                breached = (c.high > price * (1 + wickSlack)) || (c.close > price * (1 + wickSlack));
            } else {
                // 多头流动性（SSL 在 swing low 之下）：价格向下刺破 low
                breached = (c.low < price * (1 - wickSlack)) || (c.close < price * (1 - wickSlack));
            }
            if (breached) {
                takenK = k;
                break;
            }
        }

        if (takenK < 0) {
            return {
                refSide: side,
                pivotPrice: price,
                occurredAt: p.occurredAt,
                confirmedAt: p.confirmedAt,
                status: 'INTACT',
                takenAt: null,
                takenByWick: null,
                closedBeyond: null,
                _idx: p._idx
            };
        }

        var tc = candles[takenK];
        var closedBeyond;
        if (side === 'HIGH') {
            closedBeyond = tc.close > price * (1 + wickSlack);
        } else {
            closedBeyond = tc.close < price * (1 - wickSlack);
        }
        // takenByWick：影线刺破但收盘未越过 → true；收盘越过 → false
        var takenByWick = !closedBeyond;

        return {
            refSide: side,
            pivotPrice: price,
            occurredAt: p.occurredAt,
            confirmedAt: p.confirmedAt,
            status: 'TAKEN',
            takenAt: new Date(tc.openTime).toISOString(),
            takenByWick: takenByWick,
            closedBeyond: closedBeyond,
            _idx: p._idx,
            _takenCandleIdx: takenK
        };
    });

    // 按 pivot 时间升序，便于模型按 narrative 顺序阅读
    sweeps.sort(function (a, b) {
        var ta = Date.parse(a.occurredAt), tb = Date.parse(b.occurredAt);
        if (ta !== tb) return ta - tb;
        return a.pivotPrice - b.pivotPrice;
    });

    return {
        sweeps: sweeps,
        evaluationTime: evaluationTime,
        params: { wickSlack: wickSlack }
    };
}

/**
 * 保守的 Break 分类（半保守版 —— 用户 2026-08-22 明确）。
 *
 * 修正（同日）：break.direction 之前的"流动性语义"标反了，现改为标准 ICT break direction：
 *   - pivot 是 HIGH（被向上突破）→ direction = BULLISH（多头动作）
 *   - pivot 是 LOW （被向下突破）→ direction = BEARISH（空头动作）
 * 这等于 referenceSwing.refSide 的突破方向，不再按 BSL/SSL 流动性语义反转。
 *
 * 三个明确状态（每个 break 必含）：
 *   direction:        'BULLISH' | 'BEARISH'   （HIGH 被破=BULLISH，LOW 被破=BEARISH）
 *   relationToDelivery: 'SAME' | 'OPPOSITE' | 'UNKNOWN'
 *                       —— 纯 deterministic 客观事实：direction 与 deliveryAtBreak 的比较。
 *   classification:   'CONTINUATION' | 'MSS' | 'UNCLASSIFIED'
 *
 * 半保守决策（关键，禁止 OPPOSITE→MSS 直接升级）：
 *   - deliveryAtBreak = UNCLEAR → relationToDelivery = UNKNOWN，classification = UNCLASSIFIED
 *   - direction 与 deliveryAtBreak 相同（SAME）→ classification = CONTINUATION（顺向延续，可放心确定）
 *   - direction 与 deliveryAtBreak 相反（OPPOSITE）
 *         → classification 仍 = UNCLASSIFIED（不做 MSS 直接判定）
 *         → 附加 mssCandidate = true（提示下一层：需进一步判断是否击穿 protected/structural swing 才升级 MSS）
 *
 * 理由（用户分析）：方向相反只是 MSS 的"必要条件"，不是"充分条件"。
 *   一个 internal bullish retracement 突破小 internal swing high，在 BEARISH 框架下只是
 *   internal break，不应被机械升为 Bullish MSS。deterministic fact 一旦错，比 LLM 自己判错更危险，
 *   因为 prompt 已要求模型 MUST NOT override supplied break classification。
 *
 * referenceSwing 回指被刺破的 pivot（price + occurredAt + confirmedAt）。
 *
 * @param {Array} candles
 * @param {number} evalIdx
 * @param {Object} pivots
 * @param {Object} sweepResult  computeSweepLifecycle 的返回（含 sweeps）
 * @param {Object} [opts]
 *      deliveryHintEnabled {boolean} false 时所有 break 使用 UNCLEAR；默认 true
 *      pivotParams {Object} time-local pivot detector 参数；默认沿用 pivots.params
 * @returns {Object} { breaks:[...], evaluationTime }
 */
function classifyBreaks(candles, evalIdx, pivots, sweepResult, opts) {
    var o = opts || {};
    var deliveryHintEnabled = o.deliveryHintEnabled !== false;
    var pivotParams = o.pivotParams || pivots.params || {};

    var evaluationTime = candles[evalIdx].closeTime;
    var sweeps = sweepResult.sweeps || [];

    var breaks = [];
    var deliveryByCandleIdx = {};
    sweeps.forEach(function (s) {
        if (s.status !== 'TAKEN') return;

        var breakCandleIdx = s._takenCandleIdx;
        if (breakCandleIdx == null || breakCandleIdx < 0 || breakCandleIdx > evalIdx) {
            throw new Error('classifyBreaks: break candle 索引非法 ' + breakCandleIdx);
        }
        var breakEvaluationTime = candles[breakCandleIdx].closeTime;
        var deliveryState;
        if (!deliveryHintEnabled) {
            deliveryState = { direction: 'UNCLEAR', sourceConfirmedAt: null };
        } else {
            if (!deliveryByCandleIdx[breakCandleIdx]) {
                var localPivots = auditPivots.detectPivots(candles, breakCandleIdx, {
                    left: pivotParams.left,
                    right: pivotParams.right,
                    window: pivotParams.window
                });
                deliveryByCandleIdx[breakCandleIdx] = inferDeliveryStateFromPivots(
                    candles, breakCandleIdx, localPivots
                );
            }
            deliveryState = deliveryByCandleIdx[breakCandleIdx];
        }

        var deliveryAtBreak = deliveryState.direction;
        var deliverySourceConfirmedAt = deliveryState.sourceConfirmedAt;
        if (deliverySourceConfirmedAt != null) {
            var deliverySourceMs = Date.parse(deliverySourceConfirmedAt);
            if (!isFinite(deliverySourceMs) || deliverySourceMs > breakEvaluationTime) {
                throw new Error('classifyBreaks: FUTURE_LEAK deliverySourceConfirmedAt=' +
                    deliverySourceConfirmedAt + ' > breakEvaluationTime=' +
                    new Date(breakEvaluationTime).toISOString());
            }
        }

        // 标准 ICT break direction（修正反转 bug）：
        //   HIGH 被向上突破 → BULLISH（多头动作）
        //   LOW  被向下突破 → BEARISH（空头动作）
        var breakDir = (s.refSide === 'HIGH') ? 'BULLISH' : 'BEARISH';

        var relation;
        var classification;
        var mssCandidate = false;

        if (deliveryAtBreak === 'UNCLEAR') {
            // 无法判断当前 delivery → 关系 UNKNOWN，分类 UNCLASSIFIED
            relation = 'UNKNOWN';
            classification = 'UNCLASSIFIED';
        } else if (breakDir === deliveryAtBreak) {
            // 顺向：延续，非 shift —— 可较放心地确定 CONTINUATION
            relation = 'SAME';
            classification = 'CONTINUATION';
        } else {
            // 逆向：仅标为 MSS 候选，不自动升级为 MSS（方向是必要非充分条件）
            relation = 'OPPOSITE';
            classification = 'UNCLASSIFIED';
            mssCandidate = true;
        }

        breaks.push({
            direction: breakDir,
            level: s.pivotPrice,
            breakAt: s.takenAt,
            deliveryAtBreak: deliveryAtBreak,
            deliverySourceConfirmedAt: deliverySourceConfirmedAt,
            relationToDelivery: relation,
            classification: classification,
            mssCandidate: mssCandidate,
            referenceSwing: {
                refSide: s.refSide,
                price: s.pivotPrice,
                occurredAt: s.occurredAt,
                confirmedAt: s.confirmedAt
            },
            // 内部辅助（不发给模型）：是否仅影线刺破
            _takenByWick: s.takenByWick,
            _idx: s._idx
        });
    });

    // 按 breakAt 升序
    breaks.sort(function (a, b) {
        return Date.parse(a.breakAt) - Date.parse(b.breakAt);
    });

    return {
        breaks: breaks,
        evaluationTime: evaluationTime,
        params: {
            deliveryHintMode: deliveryHintEnabled ? 'time-local' : 'unclear',
            pivotParams: pivotParams
        }
    };
}

/**
 * 一键产出 marketFacts（sweeps + breaks），供脚本/测试调用。
 * @returns {Object} { sweeps:[...], breaks:[...], evaluationTime, params }
 */
function computeMarketFacts(candles, evalIdx, pivots, opts) {
    var o = opts || {};
    var sweep = computeSweepLifecycle(candles, evalIdx, pivots, opts);
    var brk = classifyBreaks(candles, evalIdx, pivots, sweep, opts);
    return {
        sweeps: sweep.sweeps,
        breaks: brk.breaks,
        evaluationTime: sweep.evaluationTime,
        params: {
            wickSlack: (o.wickSlack != null) ? o.wickSlack : 0,
            deliveryHintMode: o.deliveryHintEnabled === false ? 'unclear' : 'time-local'
        }
    };
}

/**
 * 机械推断"当前交付方向"提示（仅作 Break 分类的 time-local deliveryAtBreak 输入）。
 *
 * 口径（纯确定性、可审计，无任何复杂 ICT heuristic）：
 *   - 取所有 confirmedAt <= evaluationTime 的 pivot，按时间升序。
 *   - 维护"最近一个更高 high"和"最近一个更低 low"的突破。
 *   - 若最近的突破是 higher-high（价格创更高高）→ 偏 BULLISH 交付。
 *   - 若最近的突破是 lower-low（价格创更低低）→ 偏 BEARISH 交付。
 *   - 都没有明确突破 → UNCLEAR。
 *
 * 注意：这是"已确认结构呈现的机械方向"，不是模型判断，也不是完整 ICT 交付分析。
 * 仅用于帮助 classifyBreaks 区分 CONTINUATION（顺向）与 MSS（逆向候选）。
 * 即使这里给 UNCLEAR，break 也会标 UNCLASSIFIED —— 绝不伪造 shift。
 *
 * @returns {Object} { direction, sourceConfirmedAt }
 */
function inferDeliveryStateFromPivots(candles, evalIdx, pivots) {
    if (evalIdx == null || evalIdx < 0 || evalIdx >= candles.length) {
        throw new Error('inferDeliveryFromPivots: evalIdx 越界 ' + evalIdx);
    }
    var evaluationTime = candles[evalIdx].closeTime;

    // 收集所有 confirmed 的 pivot 点
    var pts = [];
    (pivots.highs || []).forEach(function (p) {
        var ca = Date.parse(p.confirmedAt);
        if (ca <= evaluationTime) pts.push({ kind: 'H', price: p.price, confirmedAt: ca });
    });
    (pivots.lows || []).forEach(function (p) {
        var ca = Date.parse(p.confirmedAt);
        if (ca <= evaluationTime) pts.push({ kind: 'L', price: p.price, confirmedAt: ca });
    });
    pts.sort(function (a, b) { return a.confirmedAt - b.confirmedAt; });

    var lastHigh = null;   // 最近的确认 high price
    var lastLow = null;    // 最近的确认 low price
    var lastBreak = null;  // 最近 HH/LL 事件；同时保留其 confirmedAt 供因果性审计

    for (var i = 0; i < pts.length; i++) {
        var pt = pts[i];
        if (pt.kind === 'H') {
            if (lastHigh != null && pt.price > lastHigh) {
                lastBreak = { direction: 'BULLISH', sourceConfirmedAt: pt.confirmedAt };
            }
            lastHigh = pt.price;
        } else {
            if (lastLow != null && pt.price < lastLow) {
                lastBreak = { direction: 'BEARISH', sourceConfirmedAt: pt.confirmedAt };
            }
            lastLow = pt.price;
        }
    }

    if (!lastBreak) {
        return { direction: 'UNCLEAR', sourceConfirmedAt: null };
    }
    return {
        direction: lastBreak.direction,
        sourceConfirmedAt: new Date(lastBreak.sourceConfirmedAt).toISOString()
    };
}

function inferDeliveryFromPivots(candles, evalIdx, pivots) {
    return inferDeliveryStateFromPivots(candles, evalIdx, pivots).direction;
}

module.exports = {
    DIR_VALUES: DIR_VALUES,
    computeSweepLifecycle: computeSweepLifecycle,
    classifyBreaks: classifyBreaks,
    computeMarketFacts: computeMarketFacts,
    inferDeliveryStateFromPivots: inferDeliveryStateFromPivots,
    inferDeliveryFromPivots: inferDeliveryFromPivots
};
