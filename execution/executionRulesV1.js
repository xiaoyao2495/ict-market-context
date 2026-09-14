'use strict';

var VERSION = 'REAL_ORDER_EXECUTION_V1';
var MIN_INITIAL_RR = 1.0;
var MIN_TARGET_NOTIONAL = 20;

function finite(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function decimals(step) {
    var value = String(step);
    if (value.indexOf('e-') >= 0) return Number(value.split('e-')[1]);
    return value.indexOf('.') < 0 ? 0 : value.length - value.indexOf('.') - 1;
}
function legalize(value, step, mode) {
    var scaled = Number(value) / Number(step);
    var units = mode === 'UP' ? Math.ceil(scaled - 1e-12)
        : mode === 'DOWN' ? Math.floor(scaled + 1e-12) : Math.round(scaled);
    return Number((units * Number(step)).toFixed(decimals(step)));
}

function validateRules(rules) {
    if (!rules || rules.source !== 'futures' || !finite(rules.tickSize) || Number(rules.tickSize) <= 0 ||
        !finite(rules.stepSize) || Number(rules.stepSize) <= 0 ||
        !finite(rules.minQty) || Number(rules.minQty) <= 0 ||
        !finite(rules.maxQty) || Number(rules.maxQty) < Number(rules.minQty) ||
        !finite(rules.minNotional) || Number(rules.minNotional) < 0) return false;
    return true;
}

function sizeOrder(direction, rawEntry, rawStop, rawTarget, rules) {
    if (!validateRules(rules)) return { ok: false, reasonCode: 'INVALID_SYMBOL_RULES' };
    var entry = legalize(rawEntry, rules.tickSize, direction === 'LONG' ? 'DOWN' : 'UP');
    var stop = legalize(rawStop, rules.tickSize, 'NEAREST');
    var target = legalize(rawTarget, rules.tickSize, 'NEAREST');
    if ((finite(rules.minPrice) && (entry < rules.minPrice || stop < rules.minPrice || target < rules.minPrice)) ||
        (finite(rules.maxPrice) && Number(rules.maxPrice) > 0 && (entry > rules.maxPrice || stop > rules.maxPrice || target > rules.maxPrice))) {
        return { ok: false, reasonCode: 'INVALID_SYMBOL_RULES' };
    }
    var targetNotional = Math.max(MIN_TARGET_NOTIONAL, Number(rules.minNotional));
    var qty = legalize(targetNotional / entry, rules.stepSize, 'UP');
    if (qty < Number(rules.minQty)) qty = legalize(rules.minQty, rules.stepSize, 'UP');
    if (!finite(qty) || qty <= 0 || qty > Number(rules.maxQty)) return { ok: false, reasonCode: 'INVALID_QTY' };
    if (qty * entry + 1e-9 < targetNotional) return { ok: false, reasonCode: 'ORDER_NOTIONAL_INVALID' };
    return { ok: true, entryPrice: entry, stopPrice: stop, targetPrice: target,
        targetNotional: targetNotional, requestedQty: qty, actualNotional: qty * entry };
}

function biasGate(direction, bias, expectedClosedAt) {
    if (!bias || bias.status !== 'AVAILABLE' || !bias.semantic || !finite(bias.closedAt) ||
        !finite(expectedClosedAt) || Number(bias.closedAt) !== Number(expectedClosedAt)) {
        return { ok: false, reasonCode: 'HTF_UNAVAILABLE' };
    }
    var expected = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    if (bias.semantic.direction !== expected) return { ok: false, reasonCode: 'HTF_NOT_ALIGNED' };
    if (bias.semantic.strength !== 'STRONG') return { ok: false, reasonCode: 'HTF_NOT_STRONG' };
    if (bias.semantic.confidence !== 'HIGH') return { ok: false, reasonCode: 'HTF_NOT_HIGH_CONFIDENCE' };
    return { ok: true };
}

function geometry(direction, entry, stop, target) {
    var risk = direction === 'LONG' ? entry - stop : stop - entry;
    var reward = direction === 'LONG' ? target - entry : entry - target;
    if (!(risk > 0)) return { ok: false, reasonCode: 'INVALID_STOP_GEOMETRY', risk: risk, reward: reward };
    if (!(reward > 0)) return { ok: false, reasonCode: 'INVALID_TARGET_GEOMETRY', risk: risk, reward: reward };
    var rr = reward / risk;
    return rr + 1e-12 < MIN_INITIAL_RR
        ? { ok: false, reasonCode: 'TRADE_SPACE_INSUFFICIENT', risk: risk, reward: reward, rr: rr }
        : { ok: true, risk: risk, reward: reward, rr: rr };
}

function tradeThrough(point, candles, decisionTime) {
    return (candles || []).some(function (candle) {
        if (!candle || candle.closed === false || candle.closeTime > decisionTime || candle.closeTime <= point.confirmedAt) return false;
        return point.pointSide === 'HIGH' ? candle.high > point.price : candle.low < point.price;
    });
}

/**
 * Nearest ACTIVE opposite-side historical target.
 *
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 narrows exactly one thing: the
 * eligible anchor universe. ACTIVE semantics, strict-cross/trade-through
 * semantics, the opposite-side requirement, the profitability-side requirement,
 * the nearest ordering and the single-target rule are all unchanged. A weak
 * candidate is never replaced by an automatic fallback — it leaves the universe
 * and the existing selector continues with the next eligible anchor.
 */
function selectTarget(direction, entry, points, candles, decisionTime, anchorEligibility) {
    var side = direction === 'LONG' ? 'HIGH' : 'LOW';
    var eligible = (points || []).filter(function (point) {
        if (!point || point.state !== 'ACTIVE' || point.pointSide !== side || !finite(point.price) ||
            !finite(point.confirmedAt) || point.confirmedAt > decisionTime) return false;
        if (direction === 'LONG' ? point.price <= entry : point.price >= entry) return false;
        if (anchorEligibility && anchorEligibility.isEligible(point, 'TP_TARGET_CANDIDATE') !== true) return false;
        return !tradeThrough(point, candles, decisionTime);
    });
    eligible.sort(function (a, b) {
        var d = Math.abs(a.price - entry) - Math.abs(b.price - entry);
        return d || Number(a.confirmedAt) - Number(b.confirmedAt) || String(a.id).localeCompare(String(b.id));
    });
    return eligible[0] || null;
}

function sourceTimes(event) {
    var context = event.eqSourceContext || {};
    var pivot = context.currentPivot || {};
    return { occurredAt: pivot.occurredAt !== undefined ? pivot.occurredAt : null,
        confirmedAt: pivot.confirmedAt !== undefined ? pivot.confirmedAt : event.eqConfirmedAt };
}

/**
 * Frozen semantic provenance for one historical anchor. Read-only: the entry
 * plan records what the semantic layer decided, it never re-decides or re-rolls.
 */
function anchorSignificance(anchorEligibility, point) {
    if (!anchorEligibility || !point || typeof anchorEligibility.significanceOf !== 'function') return null;
    var record = anchorEligibility.significanceOf(point);
    if (!record) return null;
    return {
        turningPointId: record.turningPointId, processId: record.processId,
        price: record.price, side: record.side, confirmedAt: record.confirmedAt,
        significance: record.significance, confidence: record.confidence,
        primaryReason: record.primaryReason,
        evidence: record.evidence || [], counterEvidence: record.counterEvidence || [],
        eligible: record.eligible === true, gateReason: record.gateReason || null,
        errorCode: record.errorCode || null,
        factsHash: record.factsHash, promptHash: record.promptHash,
        decisionKey: record.decisionKey, semanticVersion: record.semanticVersion
    };
}

function buildEntryPlan(event, context) {
    var direction = event.liquidityType === 'EQL' ? 'LONG' : 'SHORT';
    var decisionTime = event.rawFvg.confirmedAt;
    var rawEntry = (Number(event.rawFvg.low) + Number(event.rawFvg.high)) / 2;
    var anchorEligibility = context.anchorEligibility || null;
    var target = selectTarget(direction, rawEntry, context.dynamicDPoints, context.candles, decisionTime, anchorEligibility);
    var times = sourceTimes(event);
    var base = {
        tradeId: context.tradeId,
        watchId: event.watchId,
        symbol: event.symbol,
        direction: direction,
        eqId: event.liquidityId,
        eqType: event.liquidityType,
        eqPrice: event.eqSourceContext && event.eqSourceContext.status !== 'UNAVAILABLE' && event.eqSourceContext.currentPivot &&
            finite(event.eqSourceContext.currentPivot.price) ? Number(event.eqSourceContext.currentPivot.price) : null,
        eqOccurredAt: times.occurredAt,
        eqConfirmedAt: times.confirmedAt,
        eqHistoricalPartners: event.eqSourceContext && event.eqSourceContext.historicalPartners || [],
        eqCurrentPoint: event.eqSourceContext && event.eqSourceContext.currentPivot || null,
        // HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 provenance. The Current Point
        // (causal 2L/2R) is deliberately NOT significance filtered: significance
        // applies to the Historical Partner side only.
        eqHistoricalAnchorSignificance: ((event.eqSourceContext && event.eqSourceContext.historicalPartners) || [])
            .map(function (partner) { return anchorSignificance(anchorEligibility, partner); })
            .filter(function (record) { return !!record; }),
        fvgId: event.rawFvg.id,
        fvgIndex: event.rawFvg.k3Index,
        fvgLow: event.rawFvg.low,
        fvgHigh: event.rawFvg.high,
        fvgMidpoint: rawEntry,
        fvgConfirmedAt: decisionTime,
        decisionTime: decisionTime,
        eqFvgSemantic: event.eqFvgSemantic ? {
            version: event.eqFvgSemantic.semanticVersion,
            association: event.eqFvgSemantic.decision && event.eqFvgSemantic.decision.association,
            confidence: event.eqFvgSemantic.decision && event.eqFvgSemantic.decision.confidence,
            primaryReason: event.eqFvgSemantic.decision && event.eqFvgSemantic.decision.primaryReason,
            evidence: event.eqFvgSemantic.decision && event.eqFvgSemantic.decision.evidence || [],
            counterEvidence: event.eqFvgSemantic.decision && event.eqFvgSemantic.decision.counterEvidence || [],
            factsHash: event.eqFvgSemantic.factsHash,
            promptHash: event.eqFvgSemantic.promptHash,
            decisionKey: event.eqFvgSemantic.decisionKey,
            gateResult: event.eqFvgSemantic.gateResult,
            gateReason: event.eqFvgSemantic.gateReason
        } : null,
        liveTradingEnabled: context.liveTradingEnabled === true
    };
    if (!finite(base.eqPrice)) return { ok: false, reasonCode: 'INVALID_STOP_GEOMETRY', plan: base };
    var biasResult = biasGate(direction, context.bias, context.expected4hClosedAt);
    if (!biasResult.ok) return { ok: false, reasonCode: biasResult.reasonCode, plan: base };
    if (!target) return { ok: false, reasonCode: 'NO_VALID_DYNAMIC_D_TARGET', plan: base };
    var sized = sizeOrder(direction, rawEntry, base.eqPrice, target.price, context.symbolRules);
    if (!sized.ok) return { ok: false, reasonCode: sized.reasonCode, plan: base };
    var geo = geometry(direction, sized.entryPrice, sized.stopPrice, sized.targetPrice);
    Object.assign(base, {
        entryPrice: sized.entryPrice, stopPrice: sized.stopPrice, targetPrice: sized.targetPrice,
        initialRiskPrice: geo.risk, initialRewardPrice: geo.reward, initialRR: geo.rr,
        targetDynamicDId: target.id, targetConfirmedAt: target.confirmedAt,
        targetAnchorSignificance: anchorSignificance(anchorEligibility, target),
        targetAnchorPrice: target.price,
        htfDirection: context.bias.semantic.direction, htfStrength: context.bias.semantic.strength,
        htfConfidence: context.bias.semantic.confidence, htfSnapshotAt: context.bias.closedAt,
        htfFactsHash: context.bias.factsHash || null, htfDecisionKey: context.bias.decisionKey || null,
        targetNotional: sized.targetNotional, requestedQty: sized.requestedQty
    });
    return geo.ok ? { ok: true, plan: base } : { ok: false, reasonCode: geo.reasonCode, plan: base };
}

module.exports = { VERSION: VERSION, MIN_INITIAL_RR: MIN_INITIAL_RR,
    MIN_TARGET_NOTIONAL: MIN_TARGET_NOTIONAL, legalize: legalize, validateRules: validateRules,
    sizeOrder: sizeOrder, biasGate: biasGate, geometry: geometry, selectTarget: selectTarget,
    buildEntryPlan: buildEntryPlan };
