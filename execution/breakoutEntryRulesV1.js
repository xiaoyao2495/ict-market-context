'use strict';

/**
 * BREAKOUT_ENTRY_RULES_V1 - deterministic entry contract for the Two-Bar chain.
 *
 * Long  : breakout STOP_MARKET BUY  at Two-Bar high
 * Short : breakout STOP_MARKET SELL at Two-Bar low
 *
 * Initial protection:
 *   LONG  SL = min(twoBarLow, EQ Dynamic-D partner low)
 *   SHORT SL = max(twoBarHigh, EQ Dynamic-D partner high)
 *   TP = nearest causal ACTIVE opposite-side Dynamic-D in front of the planned entry
 *
 * No LLM, no FVG, no 2L/2R, no pivot.
 */

var VERSION = 'BREAKOUT_ENTRY_RULES_V1';
var MIN_INITIAL_RR = 1.0;
var MIN_TARGET_NOTIONAL = 20;

function finite(v) {
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}
function decimals(step) {
    var s = String(step);
    if (s.indexOf('e-') >= 0) return Number(s.split('e-')[1]);
    return s.indexOf('.') < 0 ? 0 : s.length - s.indexOf('.') - 1;
}
function legalize(value, step, mode) {
    var scaled = Number(value) / Number(step);
    var units = mode === 'UP' ? Math.ceil(scaled - 1e-12)
        : mode === 'DOWN' ? Math.floor(scaled + 1e-12) : Math.round(scaled);
    return Number((units * Number(step)).toFixed(decimals(step)));
}
function validateRules(rules) {
    return !!rules && rules.source === 'futures' && finite(rules.tickSize) && Number(rules.tickSize) > 0 &&
        finite(rules.stepSize) && Number(rules.stepSize) > 0 &&
        finite(rules.minQty) && Number(rules.minQty) > 0 &&
        finite(rules.maxQty) && Number(rules.maxQty) >= Number(rules.minQty) &&
        finite(rules.minNotional) && Number(rules.minNotional) >= 0;
}

/**
 * §15 HTF gate: DIRECTION ONLY. Strength and confidence are recorded but never gate.
 */
function htfDirectionGate(direction, bias) {
    if (!bias || bias.status !== 'AVAILABLE' || !bias.semantic ||
            !finite(bias.closedAt) || !finite(bias.expectedClosedAt) ||
            Number(bias.closedAt) !== Number(bias.expectedClosedAt)) {
        return { ok: false, reasonCode: 'HTF_UNAVAILABLE' };
    }
    var d = bias.semantic.direction;
    if (d !== 'BULLISH' && d !== 'BEARISH') return { ok: false, reasonCode: 'HTF_NEUTRAL' };
    var expected = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
    if (d !== expected) return { ok: false, reasonCode: 'HTF_NOT_ALIGNED' };
    return { ok: true, htfDirection: d };
}

/** §17 entry trigger: the Two-Bar extreme in the breakout direction. */
function rawEntryTrigger(setup) {
    return setup.direction === 'LONG' ? setup.twoBarHigh : setup.twoBarLow;
}

/** §21 an already-crossed trigger is refused; we never chase price. */
function checkNotAlreadyCrossed(direction, trigger, currentContractPrice) {
    if (!finite(currentContractPrice)) {
        return { ok: false, reasonCode: 'CONTRACT_PRICE_UNAVAILABLE' };
    }
    var price = Number(currentContractPrice);
    if (direction === 'LONG' ? price >= trigger : price <= trigger) {
        return { ok: false, reasonCode: 'ENTRY_TRIGGER_ALREADY_CROSSED' };
    }
    return { ok: true };
}

/** §22/§23 initial SL: protect the wider of the Two-Bar and the EQ partner. */
function initialStopRaw(setup) {
    var partner = setup.partners && setup.partners[0] ? Number(setup.partners[0].price) : null;
    if (!finite(partner)) return null;
    return setup.direction === 'LONG'
        ? Math.min(Number(setup.twoBarLow), partner)
        : Math.max(Number(setup.twoBarHigh), partner);
}

function tradeThrough(point, candles, decisionTime) {
    return (candles || []).some(function (candle) {
        if (!candle || candle.closed === false || candle.closeTime > decisionTime ||
                candle.closeTime <= point.confirmedAt) return false;
        return point.pointSide === 'HIGH' ? candle.high > point.price : candle.low < point.price;
    });
}

/** §24 nearest causal ACTIVE opposite-side Dynamic-D strictly in front of the entry. */
function selectTarget(direction, plannedEntry, points, candles, decisionTime, anchorEligibility) {
    var side = direction === 'LONG' ? 'HIGH' : 'LOW';
    var eligible = (points || []).filter(function (point) {
        if (!point || point.state !== 'ACTIVE' || point.pointSide !== side || !finite(point.price) ||
                !finite(point.confirmedAt) || point.confirmedAt > decisionTime) return false;
        if (direction === 'LONG' ? point.price <= plannedEntry : point.price >= plannedEntry) return false;
        if (anchorEligibility && anchorEligibility.isEligible(point, 'TP_TARGET_CANDIDATE') !== true) return false;
        return !tradeThrough(point, candles, decisionTime);
    });
    eligible.sort(function (a, b) {
        var d = Math.abs(a.price - plannedEntry) - Math.abs(b.price - plannedEntry);
        return d || Number(a.confirmedAt) - Number(b.confirmedAt) || String(a.id).localeCompare(String(b.id));
    });
    return eligible[0] || null;
}

function sizeOrder(direction, rawEntry, rawStop, rawTarget, rules) {
    if (!validateRules(rules)) return { ok: false, reasonCode: 'INVALID_SYMBOL_RULES' };
    var entry = legalize(rawEntry, rules.tickSize, 'NEAREST');
    var stop = legalize(rawStop, rules.tickSize, 'NEAREST');
    var target = legalize(rawTarget, rules.tickSize, 'NEAREST');
    if ((finite(rules.minPrice) && (entry < rules.minPrice || stop < rules.minPrice || target < rules.minPrice)) ||
        (finite(rules.maxPrice) && Number(rules.maxPrice) > 0 &&
            (entry > rules.maxPrice || stop > rules.maxPrice || target > rules.maxPrice))) {
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

/**
 * §26 BreakoutEntryPlan. Gate order: HTF direction -> already crossed -> target ->
 * initial SL -> sizing -> RR. Every rejection returns the partially filled plan.
 */
function buildBreakoutPlan(setup, context) {
    var ctx = context || {};
    var rules = ctx.symbolRules;
    var decisionTime = setup.confirmedAt;
    var raw = rawEntryTrigger(setup);
    var plannedEntry = validateRules(rules) ? legalize(raw, rules.tickSize, 'NEAREST') : raw;
    var base = {
        setupId: setup.id,
        // The consumed EQ is the matched Dynamic-D liquidity identity.  Keep it
        // distinct from the EqSetup identity used to derive the trade id.
        eqId: setup.nearestPartnerId,
        symbol: setup.symbol,
        direction: setup.direction,
        eqType: setup.type,
        twoBarId: setup.twoBarId,
        twoBarDirection: setup.twoBarDirection,
        twoBarHigh: setup.twoBarHigh,
        twoBarLow: setup.twoBarLow,
        k1OpenTime: setup.k1OpenTime,
        k2OpenTime: setup.k2OpenTime,
        dynamicDPartnerId: setup.nearestPartnerId,
        dynamicDPartnerPrice: setup.partners && setup.partners[0] ? setup.partners[0].price : null,
        eqDistance: setup.eqDistance,
        eqTolerance: setup.eqTolerance,
        entryTrigger: plannedEntry,
        entryWorkingType: 'CONTRACT_PRICE',
        protectionWorkingType: 'MARK_PRICE',
        decisionTime: decisionTime,
        setupConfirmedAt: setup.confirmedAt,
        patternConfidence: setup.patternConfidence,
        contextConfidence: setup.contextConfidence,
        liveTradingEnabled: ctx.liveTradingEnabled === true
    };
    var gate = htfDirectionGate(setup.direction, ctx.bias);
    if (!gate.ok) return { ok: false, reasonCode: gate.reasonCode, plan: base };
    base.htfDirection = gate.htfDirection;
    base.htfStrength = ctx.bias.semantic.strength;
    base.htfConfidence = ctx.bias.semantic.confidence;
    base.htfSnapshotAt = ctx.bias.closedAt;

    var crossed = checkNotAlreadyCrossed(setup.direction, plannedEntry, ctx.currentContractPrice);
    if (!crossed.ok) return { ok: false, reasonCode: crossed.reasonCode, plan: base };

    var target = selectTarget(setup.direction, plannedEntry, ctx.dynamicDPoints, ctx.candles,
        decisionTime, ctx.anchorEligibility || null);
    if (!target) return { ok: false, reasonCode: 'NO_VALID_DYNAMIC_D_TARGET', plan: base };

    var stopRaw = initialStopRaw(setup);
    if (!finite(stopRaw)) return { ok: false, reasonCode: 'INVALID_STOP_GEOMETRY', plan: base };

    var sized = sizeOrder(setup.direction, plannedEntry, stopRaw, target.price, rules);
    if (!sized.ok) return { ok: false, reasonCode: sized.reasonCode, plan: base };

    var geo = geometry(setup.direction, sized.entryPrice, sized.stopPrice, sized.targetPrice);
    Object.assign(base, {
        entryPrice: sized.entryPrice, stopPrice: sized.stopPrice, targetPrice: sized.targetPrice,
        initialSL: sized.stopPrice, initialTP: sized.targetPrice,
        initialRiskPrice: geo.risk, initialRewardPrice: geo.reward, initialRR: geo.rr,
        targetDynamicDId: target.id, targetConfirmedAt: target.confirmedAt, targetAnchorPrice: target.price,
        targetNotional: sized.targetNotional, requestedQty: sized.requestedQty
    });
    return geo.ok ? { ok: true, plan: base } : { ok: false, reasonCode: geo.reasonCode, plan: base };
}

module.exports = {
    VERSION: VERSION,
    MIN_INITIAL_RR: MIN_INITIAL_RR,
    MIN_TARGET_NOTIONAL: MIN_TARGET_NOTIONAL,
    legalize: legalize,
    validateRules: validateRules,
    htfDirectionGate: htfDirectionGate,
    rawEntryTrigger: rawEntryTrigger,
    checkNotAlreadyCrossed: checkNotAlreadyCrossed,
    initialStopRaw: initialStopRaw,
    selectTarget: selectTarget,
    tradeThrough: tradeThrough,
    sizeOrder: sizeOrder,
    geometry: geometry,
    buildBreakoutPlan: buildBreakoutPlan
};
