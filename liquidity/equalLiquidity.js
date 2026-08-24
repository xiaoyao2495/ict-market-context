/**
 * Equal Liquidity V2（EQH / EQL）
 *
 * 固定顺序：Lifecycle eligibility → Price equality → Formation independence
 * → bounded anchor grouping。
 *
 * Pair 三状态：VALID_EQ / BORDERLINE_EQ / REJECT_EQ。只有 VALID_EQ pair 可以形成
 * production EQH/EQL liquidity object；其余状态由 pipeline 保留作诊断。
 */
var thresholds = require('../config/thresholds');
var atrIndicator = require('../indicators/atr');
var liquidityLifecycle = require('./liquidityLifecycle');

var INTERVAL_MS = {
    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
    '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000,
    '6h': 21600000, '8h': 28800000, '12h': 43200000,
    '1d': 86400000, '3d': 259200000, '1w': 604800000,
    '1M': 2592000000
};

var PAIR_STATE = {
    VALID: 'VALID_EQ',
    BORDERLINE: 'BORDERLINE_EQ',
    REJECT: 'REJECT_EQ'
};

/** 历史 audit 使用；V2 Price Gate 不使用 percentage tolerance。 */
function toleranceFor(price, percentageTolerance, tickSize, tickMultiplier) {
    var percent = (percentageTolerance || 0) * price;
    var tick = (tickSize || 0) * (tickMultiplier || 2);
    return Math.max(percent, tick);
}

/** V2 仅记录 barsApart，不据此拒绝。 */
function barsApart(a, b) {
    var ai = a.metadata && typeof a.metadata.index === 'number' ? a.metadata.index : null;
    var bi = b.metadata && typeof b.metadata.index === 'number' ? b.metadata.index : null;
    if (ai !== null && bi !== null) return Math.abs(ai - bi);
    var ms = INTERVAL_MS[a.timeframe] || 300000;
    return Math.round(Math.abs((b.sourceOpenTime || 0) - (a.sourceOpenTime || 0)) / ms);
}

function finitePositive(value) {
    return typeof value === 'number' && isFinite(value) && value > 0;
}

function chronological(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if (a.sourceOpenTime !== b.sourceOpenTime) return a.sourceOpenTime - b.sourceOpenTime;
    return String(a.id).localeCompare(String(b.id));
}

function closedCandlesThrough(candles, evaluationTime) {
    return (candles || []).filter(function (c) {
        return c && c.closed !== false && c.closeTime <= evaluationTime;
    }).sort(function (a, b) { return a.openTime - b.openTime; });
}

function indexCandles(candles) {
    var byOpen = {};
    var byClose = {};
    candles.forEach(function (c, index) {
        byOpen[c.openTime] = index;
        byClose[c.closeTime] = index;
    });
    return { byOpen: byOpen, byClose: byClose };
}

function sourceIndexOf(swing, context) {
    var metadataIndex = swing.metadata && typeof swing.metadata.index === 'number'
        ? swing.metadata.index
        : undefined;
    if (metadataIndex !== undefined && context.candles[metadataIndex] &&
        context.candles[metadataIndex].openTime === swing.sourceOpenTime) {
        return metadataIndex;
    }
    return context.candleIndex.byOpen[swing.sourceOpenTime];
}

function confirmationIndexOf(swing, context) {
    var sourceIndex = sourceIndexOf(swing, context);
    var right = swing.metadata && typeof swing.metadata.right === 'number'
        ? swing.metadata.right
        : 2;
    var inferred = sourceIndex === undefined ? undefined : sourceIndex + right;
    if (inferred !== undefined && context.candles[inferred] &&
        context.candles[inferred].closeTime === swing.confirmedAt) return inferred;
    return context.candleIndex.byClose[swing.confirmedAt];
}

/**
 * formation time 的 lifecycle state。优先从 closed candles 重放，避免更晚调用时把
 * future status 倒灌；无 path 时才使用带时间戳的对象状态作 fail-closed fallback。
 */
function lifecycleStateAt(firstSwing, secondConfirmedAt, candles) {
    var visible = (candles || []).filter(function (c) {
        return c && c.closed !== false &&
            c.closeTime > firstSwing.confirmedAt &&
            c.closeTime <= secondConfirmedAt;
    }).sort(function (a, b) { return a.closeTime - b.closeTime; });

    if (visible.length > 0) {
        var simulated = {
            price: firstSwing.price,
            side: firstSwing.side,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null
        };
        visible.forEach(function (c) {
            var event = liquidityLifecycle.evaluateLiquidity(simulated, c);
            if (!event) return;
            simulated.status = event.status;
            simulated.touchedAt = event.touchedAt;
            simulated.sweptAt = event.sweptAt;
            simulated.brokenAt = event.brokenAt;
        });
        return simulated.status;
    }

    if (firstSwing.brokenAt !== null && firstSwing.brokenAt !== undefined &&
        firstSwing.brokenAt <= secondConfirmedAt) return 'BROKEN';
    if (firstSwing.sweptAt !== null && firstSwing.sweptAt !== undefined &&
        firstSwing.sweptAt <= secondConfirmedAt) return 'SWEPT';
    if (firstSwing.touchedAt !== null && firstSwing.touchedAt !== undefined &&
        firstSwing.touchedAt <= secondConfirmedAt) return 'TOUCHED';
    if (firstSwing.status === 'BROKEN' || firstSwing.status === 'SWEPT') {
        return firstSwing.status;
    }
    return firstSwing.status === 'TOUCHED' ? 'TOUCHED' : 'ACTIVE';
}

function lifecycleEligible(state) {
    return state === 'ACTIVE' || state === 'TOUCHED';
}

/** Replay fast path：registry state 已推进到前一根，只补 second confirmedAt 当前 closed candle。 */
function lifecycleStateFromCurrent(firstSwing, secondSwing, context) {
    var secondConfirmedAt = secondSwing.confirmedAt;
    var current = firstSwing.status || 'ACTIVE';
    if (current === 'SWEPT' || current === 'BROKEN') return current;
    var index = confirmationIndexOf(secondSwing, context);
    if (index === undefined || firstSwing.confirmedAt >= secondConfirmedAt) return current;
    var c = context.candles[index];
    if (!c || c.closed === false) return current;
    var simulated = {
        price: firstSwing.price,
        side: firstSwing.side,
        status: current,
        touchedAt: firstSwing.touchedAt || null,
        sweptAt: firstSwing.sweptAt || null,
        brokenAt: firstSwing.brokenAt || null
    };
    var event = liquidityLifecycle.evaluateLiquidity(simulated, c);
    return event ? event.status : current;
}

function maxConsecutiveOutside(path, side, lower, upper) {
    var current = 0;
    var max = 0;
    path.forEach(function (c) {
        var outside = side === 'EQH' ? c.high < lower : c.low > upper;
        if (outside) {
            current++;
            if (current > max) max = current;
        } else {
            current = 0;
        }
    });
    return max;
}

function pairId(side, first, second) {
    return side + ':' + first.id + ':' + second.id;
}

function rejectPair(base, reason) {
    base.classification = PAIR_STATE.REJECT;
    base.rejectionReason = reason;
    return base;
}

/** 构造并分类一个 chronological same-side pair。 */
function classifyPair(first, second, side, context) {
    var cfg = context.cfg;
    var state = context.lifecycleFromCurrentState
        ? lifecycleStateFromCurrent(first, second, context)
        : lifecycleStateAt(first, second.confirmedAt, context.candles);
    var base = {
        pairId: pairId(side, first, second),
        side: side,
        firstSwingId: first.id,
        secondSwingId: second.id,
        firstSwingState: state,
        lifecycleEligible: lifecycleEligible(state),
        price1: first.price,
        price2: second.price,
        absoluteDistance: Math.abs(first.price - second.price),
        distanceATR: null,
        departureATR: null,
        maxConsecutiveBarsOutsideZone_0_5ATR: null,
        barsApart: barsApart(first, second),
        atrAtSecondSwingConfirmation: null,
        secondSwingConfirmedAt: second.confirmedAt,
        classification: null,
        rejectionReason: null,
        members: [first, second]
    };
    if (!base.lifecycleEligible) return rejectPair(base, 'FIRST_SWING_' + state);

    var secondConfirmIndex = confirmationIndexOf(second, context);
    if (secondConfirmIndex === undefined) {
        return rejectPair(base, 'SECOND_CONFIRMATION_CANDLE_UNAVAILABLE');
    }
    var atr = context.atrByConfirmedAt[second.confirmedAt];
    if (atr === undefined) {
        atr = atrIndicator.atr(context.candles, cfg.atrPeriod, secondConfirmIndex);
        context.atrByConfirmedAt[second.confirmedAt] = atr;
    }
    if (!finitePositive(atr)) return rejectPair(base, 'ATR_UNAVAILABLE');
    base.atrAtSecondSwingConfirmation = atr;
    base.distanceATR = base.absoluteDistance / atr;
    if (base.distanceATR > cfg.priceFailAboveATR) return rejectPair(base, 'PRICE_FAIL');

    var firstIndex = sourceIndexOf(first, context);
    var secondIndex = sourceIndexOf(second, context);
    if (firstIndex === undefined || secondIndex === undefined || secondIndex <= firstIndex) {
        return rejectPair(base, 'FORMATION_PATH_UNAVAILABLE');
    }
    var interSwing = context.candles.slice(firstIndex + 1, secondIndex).filter(function (c) {
        return c.closed !== false && c.closeTime <= second.confirmedAt;
    });
    var eqZonePrice;
    var departure;
    if (side === 'EQH') {
        eqZonePrice = Math.min(first.price, second.price);
        var lowest = Infinity;
        interSwing.forEach(function (c) { if (c.low < lowest) lowest = c.low; });
        departure = lowest === Infinity ? 0 : eqZonePrice - lowest;
    } else {
        eqZonePrice = Math.max(first.price, second.price);
        var highest = -Infinity;
        interSwing.forEach(function (c) { if (c.high > highest) highest = c.high; });
        departure = highest === -Infinity ? 0 : highest - eqZonePrice;
    }
    if (departure < 0) departure = 0;
    var zoneWidth = cfg.formationZoneATR * atr;
    base.departureATR = departure / atr;
    base.maxConsecutiveBarsOutsideZone_0_5ATR = maxConsecutiveOutside(
        interSwing, side, eqZonePrice - zoneWidth, eqZonePrice + zoneWidth
    );

    var strongPrice = base.distanceATR <= cfg.priceStrongMaxATR;
    var strongFormation =
        base.departureATR >= cfg.formationDepartureMinATR &&
        base.maxConsecutiveBarsOutsideZone_0_5ATR >=
            cfg.formationMinConsecutiveOutsideBars;
    base.classification = strongPrice && strongFormation
        ? PAIR_STATE.VALID
        : PAIR_STATE.BORDERLINE;
    return base;
}

function classifySidePairs(items, side, context) {
    var sorted = items.slice().sort(chronological);
    var pairs = [];
    var allowed = context.secondSwingIds;
    for (var j = 1; j < sorted.length; j++) {
        if (allowed && !allowed[sorted[j].id]) continue;
        for (var i = 0; i < j; i++) {
            pairs.push(classifyPair(sorted[i], sorted[j], side, context));
        }
    }
    return pairs;
}

/** Anchor-bounded grouping；禁止通过 B 做 graph transitive chain expansion。 */
function groupValidPairs(items, validPairs, side) {
    var sorted = items.slice().sort(chronological);
    var validByKey = {};
    validPairs.forEach(function (p) {
        validByKey[p.firstSwingId + '|' + p.secondSwingId] = p;
    });
    var used = {};
    var groups = [];
    sorted.forEach(function (anchor) {
        if (used[anchor.id]) return;
        var members = [anchor];
        var pairRows = [];
        sorted.forEach(function (candidate) {
            if (candidate.id === anchor.id || used[candidate.id]) return;
            var p = validByKey[anchor.id + '|' + candidate.id];
            if (!p) return;
            members.push(candidate);
            pairRows.push(p);
        });
        if (members.length >= 2) {
            members.forEach(function (m) { used[m.id] = true; });
            groups.push({ side: side, members: members, pairs: pairRows });
        }
    });
    return groups;
}

function buildGroup(group, type, side, symbol) {
    var sorted = group.members.slice().sort(chronological);
    var sum = 0;
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    var maxConfirmed = 0;
    var minOpen = Infinity;
    var maxClose = 0;
    sorted.forEach(function (m) {
        sum += m.price;
        if (m.price < minPrice) minPrice = m.price;
        if (m.price > maxPrice) maxPrice = m.price;
        if (m.confirmedAt > maxConfirmed) maxConfirmed = m.confirmedAt;
        if (m.sourceOpenTime < minOpen) minOpen = m.sourceOpenTime;
        if (m.sourceCloseTime > maxClose) maxClose = m.sourceCloseTime;
    });
    return {
        id: symbol + ':' + type + ':' + minOpen,
        symbol: symbol,
        timeframe: sorted[0].timeframe,
        type: type,
        side: side,
        price: sum / sorted.length,
        sourceOpenTime: minOpen,
        sourceCloseTime: maxClose,
        createdAt: maxConfirmed,
        confirmedAt: maxConfirmed,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: {
            pipelineVersion: 2,
            classification: PAIR_STATE.VALID,
            minPrice: minPrice,
            maxPrice: maxPrice,
            memberCount: sorted.length,
            members: sorted,
            validPairIds: group.pairs.map(function (p) { return p.pairId; }),
            pairFeatures: group.pairs.map(function (p) {
                return {
                    pairId: p.pairId,
                    distanceATR: p.distanceATR,
                    departureATR: p.departureATR,
                    maxConsecutiveBarsOutsideZone_0_5ATR:
                        p.maxConsecutiveBarsOutsideZone_0_5ATR,
                    barsApart: p.barsApart,
                    firstSwingState: p.firstSwingState
                };
            }),
            source: sorted[0].metadata ? sorted[0].metadata.source : null
        }
    };
}

/** 完整 V2 pipeline。 */
function evaluateEqualLiquidityPipeline(swings, options) {
    var opts = options || {};
    var symbol = opts.symbol || (swings && swings[0] && swings[0].symbol) || 'UNKNOWN';
    var evaluationTime = opts.evaluationTime !== undefined ? opts.evaluationTime : Date.now();
    var cfg = opts.thresholds || thresholds.equalLiquidity;
    // Replay fast path 可传 canonicalClosedCandles=true：保留全量数组索引，但所有 feature
    // 仍由 second confirmedAt/source index 截断，未来 candle 不会被读取。
    var candles = opts.canonicalClosedCandles
        ? (opts.candles || [])
        : closedCandlesThrough(opts.candles, evaluationTime);
    var seen = {};
    var confirmed = (swings || []).filter(function (s) {
        if (!s || s.confirmedAt > evaluationTime || seen[s.id]) return false;
        seen[s.id] = true;
        return true;
    });
    var highs = confirmed.filter(function (s) { return s.type === 'SWING_HIGH'; });
    var lows = confirmed.filter(function (s) { return s.type === 'SWING_LOW'; });
    var allowed = null;
    if (opts.secondSwingIds) {
        allowed = {};
        opts.secondSwingIds.forEach(function (id) { allowed[id] = true; });
    }
    var context = {
        cfg: cfg,
        candles: candles,
        candleIndex: opts.canonicalClosedCandles ? { byOpen: {}, byClose: {} } : indexCandles(candles),
        atrByConfirmedAt: {},
        secondSwingIds: allowed,
        lifecycleFromCurrentState: !!opts.lifecycleFromCurrentState
    };
    var pairs = classifySidePairs(highs, 'EQH', context)
        .concat(classifySidePairs(lows, 'EQL', context));
    var valid = pairs.filter(function (p) { return p.classification === PAIR_STATE.VALID; });
    var highGroups = groupValidPairs(
        highs,
        valid.filter(function (p) { return p.side === 'EQH'; }),
        'EQH'
    );
    var lowGroups = groupValidPairs(
        lows,
        valid.filter(function (p) { return p.side === 'EQL'; }),
        'EQL'
    );
    var objects = [];
    highGroups.forEach(function (g) { objects.push(buildGroup(g, 'EQH', 'BSL', symbol)); });
    lowGroups.forEach(function (g) { objects.push(buildGroup(g, 'EQL', 'SSL', symbol)); });
    return {
        pairs: pairs,
        validPairs: valid,
        borderlinePairs: pairs.filter(function (p) {
            return p.classification === PAIR_STATE.BORDERLINE;
        }),
        rejectedPairs: pairs.filter(function (p) {
            return p.classification === PAIR_STATE.REJECT;
        }),
        objects: objects
    };
}

function detectEqualLiquidity(swings, options) {
    return evaluateEqualLiquidityPipeline(swings, options).objects;
}

module.exports = {
    PAIR_STATE: PAIR_STATE,
    toleranceFor: toleranceFor,
    barsApart: barsApart,
    lifecycleStateAt: lifecycleStateAt,
    classifyPair: classifyPair,
    evaluateEqualLiquidityPipeline: evaluateEqualLiquidityPipeline,
    detectEqualLiquidity: detectEqualLiquidity
};
