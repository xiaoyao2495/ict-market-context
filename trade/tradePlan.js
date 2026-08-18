/**
 * Trade Plan（Phase 10）
 *
 * 状态：
 *   NOT_AVAILABLE  Entry Gate 未到 ENTRY_READY
 *   ENTRY_MISSED   价格已越过 entry，无法合理回踩
 *   REJECTED       RR 不足（INSUFFICIENT_RR）或 stop/target invalid
 *   READY          Entry Gate ENTRY_READY + Entry valid + Stop valid + Target valid + RR >= minRR
 *
 * ENTRY_READY（Phase 9）只表示"可以考虑入场"；
 * TRADE_PLAN READY（Phase 10）才表示"风险收益也合理"。
 */
var thresholds = require('../config/thresholds');
var entryPlanner = require('./entryPlanner');
var stopPlanner = require('./stopPlanner');
var targetPlanner = require('./targetPlanner');
var rrCalculator = require('./rrCalculator');
var tradeExplanation = require('./tradeExplanation');

/**
 * @param {Object} input {
 *   symbol, evaluationTime,
 *   entryGate,        entryGate 输出
 *   currentPrice,
 *   amd,              amdStateMachine 输出（stop 参考）
 *   swings,           confirmed swing liquidity（stop 参考）
 *   draw,             drawEngine 输出（target）
 *   tickSize, atr,
 *   context,          { bias, scenario, amd } 摘要（可传入或自动提取）
 *   invalidation      invalidation 描述数组（可传入）
 * }
 * @param {Object} [options] { thresholds }
 * @returns {Object} Trade Plan
 */
function buildTradePlan(input, options) {
    var opts = options || {};
    var symbol = input.symbol || 'UNKNOWN';
    var evaluationTime = input.evaluationTime;
    var gate = input.entryGate || {};
    var currentPrice = input.currentPrice;
    var amd = input.amd || {};
    var direction = input.direction || (gate.fvg && (gate.fvg.direction === 'BULLISH' ? 'LONG' : 'SHORT')) || null;

    // ---- context ----
    var context = input.context || {};
    if (!context.bias && gate.scenarioRef) {
        context.bias = gate.scenarioRef.direction;
    }
    if (!context.scenario && gate.scenarioRef) {
        context.scenario = gate.scenarioRef.scenarioState;
    }
    if (!context.amd && amd.state) {
        context.amd = amd.state;
    }

    var id = symbol + ':TRADE:' + (evaluationTime || Date.now());
    var reasons = [];

    // ---- 1. Entry ----
    // Phase 11E.6：input.entryPrice = 确认 K 收盘价（方向性确认发生在 K 收盘，最早 N+1 执行；
    // 不得回头按确认前旧 entry 价格成交——与 same-signal-candle 语义一致）
    var entry;
    if (input.entryPrice !== undefined && input.entryPrice !== null) {
        entry = {
            status: 'READY',
            price: input.entryPrice,
            reason: 'CONFIRMED_CLOSE',
            mode: 'CONFIRMED'
        };
    } else {
        entry = entryPlanner.planEntry({
            entryGate: gate,
            currentPrice: currentPrice,
            direction: direction,
            evaluationTime: evaluationTime
        }, opts);
    }

    if (entry.status === 'NOT_AVAILABLE') {
        return {
            id: id, symbol: symbol, createdAt: evaluationTime,
            direction: direction, status: 'NOT_AVAILABLE',
            entry: null, stop: null, target: null,
            risk: null, reward: null, rr: null,
            context: context, invalidation: input.invalidation || [],
            reasons: [entry.reason]
        };
    }
    if (entry.status === 'ENTRY_MISSED') {
        return {
            id: id, symbol: symbol, createdAt: evaluationTime,
            direction: direction, status: 'ENTRY_MISSED',
            entry: entry, stop: null, target: null,
            risk: null, reward: null, rr: null,
            context: context, invalidation: input.invalidation || [],
            reasons: [entry.reason]
        };
    }

    // ---- 2. Stop ----
    var stop = stopPlanner.planStop({
        direction: direction,
        entryPrice: entry.price,
        amd: amd,
        // Phase 11T.5：retained TradeContextSnapshot（上一轮 narrative 边界，正式化）
        retainedNarrative: input.retainedNarrative || null,
        swings: input.swings || [],
        fvg: gate.fvg || {},
        evaluationTime: evaluationTime,
        tickSize: input.tickSize,
        atr: input.atr
    }, opts);
    if (stop.status !== 'READY') {
        return rejected(id, symbol, evaluationTime, direction, context, entry, stop, null, null, null, [stop.reason], input, opts);
    }

    // ---- 3. Target ----
    var target = targetPlanner.planTarget({
        direction: direction,
        entryPrice: entry.price,
        draw: input.draw || {}
    }, opts);
    if (target.status !== 'READY') {
        return rejected(id, symbol, evaluationTime, direction, context, entry, stop, target, null, null, [target.reason], input, opts);
    }

    // ---- 4. RR ----
    var rr = rrCalculator.calculateRR({
        direction: direction,
        entryPrice: entry.price,
        stopPrice: stop.price,
        targetPrice: target.price
    }, opts);
    if (rr.status !== 'READY') {
        return rejected(id, symbol, evaluationTime, direction, context, entry, stop, target, rr, null, [rr.reason], input, opts);
    }

    var plan = {
        id: id,
        symbol: symbol,
        createdAt: evaluationTime,
        direction: direction,
        status: 'READY',
        entry: {
            type: entry.type,
            price: entry.price,
            zoneLow: entry.zoneLow,
            zoneHigh: entry.zoneHigh,
            // Phase 11E.6：CONFIRMED（确认 K 收盘价入场）vs ZONE（gate 价格）
            mode: entry.mode || 'ZONE'
        },
        stop: {
            price: stop.price,
            source: stop.source,
            referencePrice: stop.referencePrice,
            buffer: stop.buffer
        },
        target: {
            price: target.price,
            source: target.source,
            candidateId: target.candidateId,
            strength: target.strength,
            drawScore: target.drawScore
        },
        risk: rr.risk,
        reward: rr.reward,
        rr: rr.rr,
        context: context,
        invalidation: input.invalidation || [],
        reasons: reasons
    };
    plan.explanation = tradeExplanation.buildTradeExplanation(plan, opts);
    return plan;
}

function rejected(id, symbol, evaluationTime, direction, context, entry, stop, target, rr, risk, reasons, input, options) {
    var opts = options || {};
    var plan = {
        id: id,
        symbol: symbol,
        createdAt: evaluationTime,
        direction: direction,
        status: 'REJECTED',
        entry: entry.status === 'READY'
            ? { type: entry.type, price: entry.price, zoneLow: entry.zoneLow, zoneHigh: entry.zoneHigh }
            : entry,
        stop: stop.status === 'READY'
            ? { price: stop.price, source: stop.source, referencePrice: stop.referencePrice, buffer: stop.buffer }
            : stop,
        target: target && target.status === 'READY'
            ? { price: target.price, source: target.source, candidateId: target.candidateId, strength: target.strength, drawScore: target.drawScore }
            : target,
        risk: rr && rr.risk !== undefined ? rr.risk : null,
        reward: rr && rr.reward !== undefined ? rr.reward : null,
        rr: rr && rr.rr !== undefined ? rr.rr : null,
        context: context,
        invalidation: input.invalidation || [],
        reasons: reasons
    };
    plan.explanation = tradeExplanation.buildTradeExplanation(plan, opts);
    return plan;
}

module.exports = {
    buildTradePlan: buildTradePlan
};
