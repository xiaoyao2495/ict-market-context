/**
 * auditStructuralProvenance.js
 *
 * 4H audit-only Structural Provenance V1.1。
 * 仅消费 confirmed 2L/2R pivots、closed candles 与 deterministic break facts；
 * V1.1 仅增加 structural MSS 的 time-local state gate；
 * 不读取 production engine，不推断完整 ICT structural hierarchy。
 */

var DEFAULT_LEFT = 2;
var DEFAULT_RIGHT = 2;
var DEFAULT_WINDOW = 120;

function toMs(v) {
    return typeof v === 'number' ? v : Date.parse(v);
}

function iso(v) {
    return new Date(v).toISOString();
}

function max3(a, b, c) {
    return Math.max(toMs(a), toMs(b), toMs(c));
}

function pivotId(side, p) {
    return side + ':' + p._idx + ':' + p.price;
}

function persistedSwingId(s) {
    return [s.side, s.price, s.occurredAt, s.confirmedAt].join('|');
}

function structuralEventId(e) {
    return [e.type, e.direction, e.referenceLevel, e.eventTime, e.confirmedAt].join('|');
}

function candleIndexByOpenTime(candles, time) {
    var t = toMs(time);
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].openTime === t) return i;
    }
    return -1;
}

function mergePersistedSwings(candles, current, previous, evaluationTime) {
    var byId = {};
    (previous || []).forEach(function (s) {
        if (toMs(s.protectedConfirmedAt) > evaluationTime) return;
        if (s.status !== 'ACTIVE_PROTECTED') return;
        var restored = Object.assign({}, s);
        restored._controlIdx = candleIndexByOpenTime(candles, s.occurredAt);
        restored._bosIdx = candleIndexByOpenTime(candles, s.bosCandleTime);
        byId[persistedSwingId(restored)] = restored;
    });
    current.forEach(function (s) {
        var key = persistedSwingId(s);
        var carried = byId[key];
        if (carried && (carried.ancestry || []).length > (s.ancestry || []).length) {
            s.ancestry = (carried.ancestry || []).slice();
            s.ancestorProtectedSwing = carried.ancestorProtectedSwing;
        }
        byId[key] = s;
    });
    return Object.keys(byId).map(function (key) { return byId[key]; });
}

function mergeStructuralEvents(previous, current, evaluationTime) {
    var byId = {};
    (previous || []).concat(current || []).forEach(function (e) {
        if (toMs(e.confirmedAt) > evaluationTime) return;
        byId[structuralEventId(e)] = e;
    });
    return Object.keys(byId).map(function (key) { return byId[key]; });
}

function isConfirmedAt(p, evaluationTime) {
    return p && p.confirmedAt != null && toMs(p.confirmedAt) <= evaluationTime;
}

function pendingPivotCandidates(candles, evalIdx, kind, params) {
    var left = params.left != null ? params.left : DEFAULT_LEFT;
    var right = params.right != null ? params.right : DEFAULT_RIGHT;
    var start = Math.max(0, evalIdx - ((params.window != null ? params.window : DEFAULT_WINDOW) - 1));
    var out = [];

    for (var i = start; i <= evalIdx; i++) {
        if (i - left < 0 || i + right <= evalIdx) continue;
        var c = candles[i];
        var valid = true;
        var k;
        for (k = 1; k <= left; k++) {
            if (kind === 'LOW' && candles[i - k].low <= c.low) valid = false;
            if (kind === 'HIGH' && candles[i - k].high >= c.high) valid = false;
        }
        for (k = 1; k <= right && i + k <= evalIdx; k++) {
            if (kind === 'LOW' && candles[i + k].low <= c.low) valid = false;
            if (kind === 'HIGH' && candles[i + k].high >= c.high) valid = false;
        }
        if (!valid) continue;
        out.push({
            price: kind === 'LOW' ? c.low : c.high,
            occurredAt: iso(c.openTime),
            confirmedAt: null,
            _idx: i,
            _pending: true,
            requiredConfirmationIndex: i + right
        });
    }
    return out;
}

function firstCloseThrough(candles, evalIdx, parent, direction) {
    for (var i = parent._idx + 1; i <= evalIdx; i++) {
        var c = candles[i];
        if (!c.closed) continue;
        if (direction === 'BULLISH' && c.close > parent.price) return { candle: c, index: i };
        if (direction === 'BEARISH' && c.close < parent.price) return { candle: c, index: i };
    }
    return null;
}

function latestIntervening(candidates, parent, bos) {
    var parentTime = toMs(parent.occurredAt);
    var bosCloseTime = bos.candle.closeTime;
    var eligible = candidates.filter(function (p) {
        var t = toMs(p.occurredAt);
        return t > parentTime && t < bosCloseTime && p._idx <= bos.index;
    });
    eligible.sort(function (a, b) {
        var d = toMs(b.occurredAt) - toMs(a.occurredAt);
        if (d !== 0) return d;
        return b._idx - a._idx;
    });
    return eligible[0] || null;
}

function producedPivot(pivots, parent, bos, direction, evaluationTime) {
    var eligible = pivots.filter(function (p) {
        if (!isConfirmedAt(p, evaluationTime) || p._idx < bos.index) return false;
        return direction === 'BULLISH' ? p.price > parent.price : p.price < parent.price;
    });
    eligible.sort(function (a, b) {
        var d = toMs(a.occurredAt) - toMs(b.occurredAt);
        if (d !== 0) return d;
        return a._idx - b._idx;
    });
    return eligible[0] || null;
}

function rawProvenances(candles, evalIdx, pivots, direction, params) {
    var evaluationTime = candles[evalIdx].closeTime;
    var bullish = direction === 'BULLISH';
    var parents = bullish ? (pivots.highs || []) : (pivots.lows || []);
    var confirmedControls = bullish ? (pivots.lows || []) : (pivots.highs || []);
    var pendingControls = pendingPivotCandidates(
        candles, evalIdx, bullish ? 'LOW' : 'HIGH', params
    );
    var controls = confirmedControls.concat(pendingControls);
    var producedPool = bullish ? (pivots.highs || []) : (pivots.lows || []);
    var out = [];

    parents.forEach(function (parent) {
        if (!isConfirmedAt(parent, evaluationTime)) return;
        var bos = firstCloseThrough(candles, evalIdx, parent, direction);
        if (!bos || bos.candle.closeTime > evaluationTime) return;
        var controlling = latestIntervening(controls, parent, bos);
        if (!controlling) return;

        var produced = producedPivot(producedPool, parent, bos, direction, evaluationTime);
        var protectedConfirmedAt = controlling.confirmedAt == null ? null :
            max3(parent.confirmedAt, controlling.confirmedAt, bos.candle.closeTime);

        out.push({
            direction: direction,
            side: bullish ? 'LOW' : 'HIGH',
            parent: parent,
            controlling: controlling,
            bos: bos,
            produced: produced,
            protectedConfirmedAt: protectedConfirmedAt,
            provenanceStatus: protectedConfirmedAt == null || protectedConfirmedAt > evaluationTime
                ? 'PENDING' : 'CONFIRMED'
        });
    });
    return out;
}

function canonicalize(raw) {
    var byControl = {};
    raw.forEach(function (p) {
        var key = pivotId(p.side, p.controlling);
        var cur = byControl[key];
        if (!cur) {
            byControl[key] = p;
            return;
        }
        // 同一个 controlling swing 的首次 close-confirmed BOS 决定激活时点；
        // 后续更深 BOS 不能把 protectedConfirmedAt 向未来重写。
        if (p.bos.index < cur.bos.index) {
            byControl[key] = p;
            return;
        }
        if (p.bos.index === cur.bos.index) {
            if (p.direction === 'BULLISH' && p.parent.price > cur.parent.price) byControl[key] = p;
            if (p.direction === 'BEARISH' && p.parent.price < cur.parent.price) byControl[key] = p;
        }
    });
    return Object.keys(byControl).map(function (k) { return byControl[k]; });
}

function sourceSummary(s) {
    if (!s) return null;
    return {
        price: s.price,
        occurredAt: s.occurredAt,
        confirmedAt: s.confirmedAt,
        side: s.side,
        role: s.role,
        protectedConfirmedAt: s.protectedConfirmedAt
    };
}

function toProtectedSwing(p) {
    var bullish = p.direction === 'BULLISH';
    var producedPrice = p.produced ? p.produced.price : null;
    var s = {
        price: p.controlling.price,
        occurredAt: p.controlling.occurredAt,
        confirmedAt: p.controlling.confirmedAt,
        side: p.side,
        direction: p.direction,

        parentStructuralLevel: p.parent.price,
        parentStructuralConfirmedAt: p.parent.confirmedAt,

        bosLevel: p.parent.price,
        bosCandleTime: iso(p.bos.candle.openTime),
        bosClose: p.bos.candle.close,
        bosConfirmedAt: iso(p.bos.candle.closeTime),

        protectedConfirmedAt: iso(p.protectedConfirmedAt),
        supportedProducedLevel: producedPrice,
        supportedProducedConfirmedAt: p.produced ? p.produced.confirmedAt : null,

        role: bullish ? 'ACTIVE_PROTECTED_LOW' : 'ACTIVE_PROTECTED_HIGH',
        status: 'ACTIVE_PROTECTED',
        ancestry: [],
        ancestorProtectedSwing: null,
        supersededBy: null,
        brokenAt: null,
        brokenConfirmedAt: null,
        brokenByClose: false,
        structuralMssReference: false,

        _controlIdx: p.controlling._idx,
        _bosIdx: p.bos.index
    };
    if (bullish) {
        s.parentHigh = p.parent.price;
        s.producedHigh = producedPrice;
        s.supportedProducedHigh = producedPrice;
    } else {
        s.parentLow = p.parent.price;
        s.producedLow = producedPrice;
        s.supportedProducedLow = producedPrice;
    }
    return s;
}

function applySupersession(swings) {
    var groups = { BULLISH: [], BEARISH: [] };
    swings.forEach(function (s) { groups[s.direction].push(s); });

    Object.keys(groups).forEach(function (direction) {
        var arr = groups[direction];
        arr.sort(function (a, b) {
            var d = toMs(a.protectedConfirmedAt) - toMs(b.protectedConfirmedAt);
            if (d !== 0) return d;
            return a._bosIdx - b._bosIdx;
        });
        for (var i = 0; i < arr.length; i++) {
            if (i > 0) {
                var prev = arr[i - 1];
                var cur = arr[i];
                prev.role = prev.side === 'LOW'
                    ? 'SUPERSEDED_PROTECTED_LOW' : 'SUPERSEDED_PROTECTED_HIGH';
                prev.status = 'SUPERSEDED_PROTECTED';
                prev.supersededBy = cur.price;
                cur.ancestorProtectedSwing = prev.price;
                cur.ancestry = prev.ancestry.concat([prev.price]);
            }
        }
    });
    return groups;
}

function candleIndexAtOrAfter(candles, time) {
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].closeTime >= time) return i;
    }
    return -1;
}

function applyStructuralMss(candles, evalIdx, groups, bos) {
    var candidates = [];
    Object.keys(groups).forEach(function (direction) {
        var arr = groups[direction];
        for (var i = 0; i < arr.length; i++) {
            var s = arr[i];
            var activeFrom = toMs(s.protectedConfirmedAt);
            var activeUntil = i + 1 < arr.length
                ? toMs(arr[i + 1].protectedConfirmedAt) : Infinity;
            var startIdx = candleIndexAtOrAfter(candles, activeFrom);
            if (startIdx < 0) continue;
            for (var k = startIdx; k <= evalIdx; k++) {
                var c = candles[k];
                if (c.closeTime >= activeUntil) break;
                var broken = s.side === 'LOW' ? c.close < s.price : c.close > s.price;
                if (!broken) continue;
                s.status = 'BROKEN';
                s.brokenAt = iso(c.openTime);
                s.brokenConfirmedAt = iso(c.closeTime);
                s.brokenByClose = true;
                candidates.push({
                    direction: s.side === 'LOW' ? 'BEARISH' : 'BULLISH',
                    referenceLevel: s.price,
                    referenceRole: s.side === 'LOW'
                        ? 'ACTIVE_PROTECTED_LOW' : 'ACTIVE_PROTECTED_HIGH',
                    eventTime: iso(c.openTime),
                    confirmedAt: iso(c.closeTime),
                    sourceProtectedSwing: sourceSummary(s)
                });
                break;
            }
        }
    });

    candidates.sort(function (a, b) {
        var d = toMs(a.confirmedAt) - toMs(b.confirmedAt);
        if (d !== 0) return d;
        d = toMs(a.eventTime) - toMs(b.eventTime);
        if (d !== 0) return d;
        return a.referenceLevel - b.referenceLevel;
    });

    // V1.1：继承 V1 的 time-local state 来源（BOS / MSS），只给 protected
    // close-break 加 state gate。只有 opposite / UNKNOWN → direction 才是 MSS。
    // 同向 ACTIVE protected close-break 仍完成 BROKEN lifecycle，但降级为 continuation。
    var structuralState = 'UNKNOWN';
    var priorBos = (bos || []).slice().sort(function (a, b) {
        return toMs(a.confirmedAt) - toMs(b.confirmedAt);
    });
    var bosIdx = 0;
    var events = candidates.map(function (e) {
        while (bosIdx < priorBos.length &&
            toMs(priorBos[bosIdx].confirmedAt) < toMs(e.confirmedAt)) {
            structuralState = priorBos[bosIdx].direction;
            bosIdx++;
        }
        var before = structuralState;
        var changesState = before === 'UNKNOWN' || before !== e.direction;
        if (changesState) structuralState = e.direction;
        e.type = changesState ? 'STRUCTURAL_MSS' : 'STRUCTURAL_CONTINUATION';
        e.structuralStateBefore = before;
        e.structuralStateAfter = structuralState;
        e.stateChanged = changesState;

        var swing = groups[e.direction === 'BEARISH' ? 'BULLISH' : 'BEARISH']
            .filter(function (s) {
                return s.price === e.referenceLevel &&
                    s.occurredAt === e.sourceProtectedSwing.occurredAt;
            })[0];
        if (swing) swing.structuralMssReference = changesState;
        return e;
    });
    return { events: events };
}

function annotateStructuralStates(events) {
    var state = 'UNKNOWN';
    events.forEach(function (e) {
        if (e.type === 'STRUCTURAL_MSS' || e.type === 'STRUCTURAL_CONTINUATION') {
            state = e.structuralStateAfter;
            return;
        }
        var before = state;
        if (e.type === 'BOS' || e.type === 'STRUCTURAL_MSS') state = e.direction;
        e.structuralStateBefore = before;
        e.structuralStateAfter = state;
        e.stateChanged = before !== state;
    });
    return state;
}

function bosEvents(provenances, swings) {
    return provenances.map(function (p) {
        var s = swings.filter(function (x) {
            return x.side === p.side && x._controlIdx === p.controlling._idx;
        })[0] || null;
        return {
            type: 'BOS',
            direction: p.direction,
            referenceLevel: p.parent.price,
            referenceRole: p.direction === 'BULLISH'
                ? 'PARENT_STRUCTURAL_HIGH' : 'PARENT_STRUCTURAL_LOW',
            eventTime: iso(p.bos.candle.openTime),
            confirmedAt: iso(p.protectedConfirmedAt),
            sourceProtectedSwing: sourceSummary(s)
        };
    });
}

function applyPenetrations(candles, evalIdx, swings) {
    var out = [];
    swings.forEach(function (s) {
        var startIdx = candleIndexAtOrAfter(candles, toMs(s.protectedConfirmedAt));
        if (startIdx < 0) return;
        for (var i = startIdx; i <= evalIdx; i++) {
            var c = candles[i];
            var wickOnly = s.side === 'LOW'
                ? c.low < s.price && c.close >= s.price
                : c.high > s.price && c.close <= s.price;
            if (!wickOnly) continue;
            s.penetratedAt = iso(c.openTime);
            s.penetrationConfirmedAt = iso(c.closeTime);
            s.penetratedByWick = true;
            out.push({
                type: 'WICK_PENETRATION',
                side: s.side,
                referenceLevel: s.price,
                referenceRole: s.role,
                eventTime: iso(c.openTime),
                confirmedAt: iso(c.closeTime),
                sourceProtectedSwing: sourceSummary(s)
            });
            break;
        }
    });
    return out;
}

function breakCandle(candles, breakFact) {
    var t = toMs(breakFact.breakAt);
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].openTime === t) return candles[i];
    }
    return null;
}

function continuationEvents(candles, breaks, stateEvents, swings) {
    var out = [];
    (breaks || []).forEach(function (b) {
        if (b._takenByWick) return;
        var c = breakCandle(candles, b);
        if (!c) return;
        // 只看 break candle 收盘之前已经确认的最新 structural state event。
        // 不能从更老的同向 MSS 挑一个来覆盖更新的反向 BOS。
        var priorState = stateEvents.filter(function (e) {
            return toMs(e.confirmedAt) < c.closeTime;
        }).sort(function (a, z) {
            var d = toMs(z.confirmedAt) - toMs(a.confirmedAt);
            if (d !== 0) return d;
            // 同一 close 同时形成 BOS 与 MSS 时，MSS 是 structural state transition source。
            var ar = a.type === 'STRUCTURAL_MSS' ? 1 : 0;
            var zr = z.type === 'STRUCTURAL_MSS' ? 1 : 0;
            return zr - ar;
        })[0];
        if (!priorState || priorState.direction !== b.direction) return;

        var role = b.referenceSwing && b.referenceSwing.refSide === 'LOW'
            ? 'CONFIRMED_PIVOT_LOW' : 'CONFIRMED_PIVOT_HIGH';
        var protectedMatch = swings.filter(function (s) { return s.price === b.level; })[0];
        if (protectedMatch) role = protectedMatch.role;
        out.push({
            type: 'CONTINUATION',
            direction: b.direction,
            referenceLevel: b.level,
            referenceRole: role,
            eventTime: b.breakAt,
            confirmedAt: iso(c.closeTime),
            sourceProtectedSwing: priorState.sourceProtectedSwing
        });
    });
    return out;
}

function stripInternal(s) {
    var out = {};
    Object.keys(s).forEach(function (k) {
        if (k.charAt(0) !== '_') out[k] = s[k];
    });
    return out;
}

function computeStructuralProvenance(candles, evalIdx, pivots, opts) {
    var o = opts || {};
    if (evalIdx == null || evalIdx < 0 || evalIdx >= candles.length) {
        throw new Error('computeStructuralProvenance: evalIdx 越界 ' + evalIdx);
    }
    var evaluationTime = candles[evalIdx].closeTime;
    var previousSnapshot = o.previousSnapshot || null;
    if (previousSnapshot && toMs(previousSnapshot.evaluationTime) > evaluationTime) {
        throw new Error('computeStructuralProvenance: previousSnapshot 在未来');
    }
    var params = o.pivotParams || pivots.params || {
        left: DEFAULT_LEFT, right: DEFAULT_RIGHT, window: DEFAULT_WINDOW
    };
    var raw = rawProvenances(candles, evalIdx, pivots, 'BULLISH', params)
        .concat(rawProvenances(candles, evalIdx, pivots, 'BEARISH', params));
    var canonical = canonicalize(raw);
    var rawConfirmed = raw.filter(function (p) {
        return p.provenanceStatus === 'CONFIRMED' && p.protectedConfirmedAt <= evaluationTime;
    });
    var pending = canonical.filter(function (p) { return p.provenanceStatus === 'PENDING'; });
    var confirmed = canonical.filter(function (p) {
        return p.provenanceStatus === 'CONFIRMED' && p.protectedConfirmedAt <= evaluationTime;
    });
    var swings = mergePersistedSwings(
        candles,
        confirmed.map(toProtectedSwing),
        previousSnapshot && previousSnapshot.protectedSwings,
        evaluationTime
    );
    var groups = applySupersession(swings);
    var bos = mergeStructuralEvents(
        previousSnapshot && (previousSnapshot.structuralEvents || []).filter(function (e) {
            return e.type === 'BOS';
        }),
        bosEvents(rawConfirmed, swings),
        evaluationTime
    );
    var structuralBreaks = applyStructuralMss(candles, evalIdx, groups, bos);
    var mss = structuralBreaks.events.filter(function (e) {
        return e.type === 'STRUCTURAL_MSS';
    });
    var penetrations = applyPenetrations(candles, evalIdx, swings);
    var events = mergeStructuralEvents(
        previousSnapshot && previousSnapshot.structuralEvents,
        bos
        .concat(structuralBreaks.events)
        .concat(continuationEvents(candles, o.breaks || [], bos.concat(mss), swings)),
        evaluationTime
    );
    events.sort(function (a, b) {
        var d = toMs(a.confirmedAt) - toMs(b.confirmedAt);
        if (d !== 0) return d;
        return toMs(a.eventTime) - toMs(b.eventTime);
    });
    var structuralState = annotateStructuralStates(events);

    var futureLeakViolations = [];
    swings.forEach(function (s) {
        ['confirmedAt', 'parentStructuralConfirmedAt', 'bosConfirmedAt',
            'protectedConfirmedAt', 'supportedProducedConfirmedAt', 'brokenConfirmedAt',
            'penetrationConfirmedAt']
            .forEach(function (field) {
                if (s[field] != null && toMs(s[field]) > evaluationTime) {
                    futureLeakViolations.push({ type: 'PROTECTED_SWING', price: s.price, field: field });
                }
            });
    });
    events.forEach(function (e) {
        if (toMs(e.confirmedAt) > evaluationTime) {
            futureLeakViolations.push({ type: e.type, referenceLevel: e.referenceLevel, field: 'confirmedAt' });
        }
        if (e.sourceProtectedSwing &&
            toMs(e.sourceProtectedSwing.protectedConfirmedAt) > toMs(e.confirmedAt)) {
            futureLeakViolations.push({
                type: e.type,
                referenceLevel: e.referenceLevel,
                field: 'sourceProtectedSwing.protectedConfirmedAt'
            });
        }
    });
    penetrations.forEach(function (e) {
        if (toMs(e.confirmedAt) > evaluationTime) {
            futureLeakViolations.push({
                type: e.type, referenceLevel: e.referenceLevel, field: 'confirmedAt'
            });
        }
    });
    if (futureLeakViolations.length) {
        throw new Error('computeStructuralProvenance: FUTURE_LEAK ' +
            JSON.stringify(futureLeakViolations));
    }

    return {
        evaluationTime: evaluationTime,
        protectedSwings: swings.map(stripInternal),
        pendingProvenances: pending.map(function (p) {
            return {
                direction: p.direction,
                side: p.side,
                parentStructuralLevel: p.parent.price,
                parentStructuralConfirmedAt: p.parent.confirmedAt,
                controllingPrice: p.controlling.price,
                controllingOccurredAt: p.controlling.occurredAt,
                requiredConfirmationIndex: p.controlling.requiredConfirmationIndex,
                bosLevel: p.parent.price,
                bosCandleTime: iso(p.bos.candle.openTime),
                bosClose: p.bos.candle.close,
                bosConfirmedAt: iso(p.bos.candle.closeTime),
                status: 'PENDING'
            };
        }),
        penetrations: penetrations,
        structuralEvents: events,
        structuralState: structuralState,
        futureLeakViolations: futureLeakViolations,
        params: {
            left: params.left != null ? params.left : DEFAULT_LEFT,
            right: params.right != null ? params.right : DEFAULT_RIGHT,
            window: params.window != null ? params.window : DEFAULT_WINDOW,
            bosConfirmation: 'CLOSE_THROUGH_ONLY',
            structuralEventClassification: 'V1.1_STATE_GATED',
            persistence: 'PREVIOUS_SNAPSHOT_CARRY_FORWARD'
        },
        persistence: {
            previousEvaluationTime: previousSnapshot ? previousSnapshot.evaluationTime : null,
            carriedProtectedSwingCount: previousSnapshot ?
                (previousSnapshot.protectedSwings || []).filter(function (s) {
                    return s.status === 'ACTIVE_PROTECTED' &&
                        !confirmed.map(toProtectedSwing).some(function (cur) {
                        return persistedSwingId(cur) === persistedSwingId(s);
                    });
                }).length : 0
        }
    };
}

module.exports = {
    computeStructuralProvenance: computeStructuralProvenance
};
