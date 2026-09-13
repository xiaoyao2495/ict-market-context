'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var pivotDetector = require('../../structure/pivotDetector');
var swingLiquidity = require('../../liquidity/swingLiquidity');
var productionEq = require('../../liquidity/productionEqualLiquidityV1');
var dynamicD = require('../../liquidity/causalDynamicDHistoricalExtremes');
var watchModel = require('../../live/eqFvgCountWatchV1');
var capture = require('./replayImpactCapture');

var ROOT = path.join(__dirname, '..', '..');
var OUT = path.join(ROOT, 'research-output', 'same-process-wick-localization-v1', 'eq-diff-trace-audit-v1');
var START = Date.parse('2026-09-05T16:00:00.000Z');
var END = Date.parse('2026-09-12T16:00:00.000Z');
var BAR = 5 * 60 * 1000;
var SYMBOLS = Object.keys(capture.SPECS);
var REASONS = [
    'ANCHOR_PRICE_ENTERED_EQ_TOLERANCE',
    'ANCHOR_PRICE_LEFT_EQ_TOLERANCE',
    'ANCHOR_OCCURRENCE_ENTERED_36H_WINDOW',
    'ANCHOR_OCCURRENCE_LEFT_36H_WINDOW',
    'ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE',
    'PAIRING_PRIORITY_CHANGED',
    'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS',
    'MULTIPLE_CAUSAL_EFFECTS',
    'UNEXPLAINED_DIFFERENCE'
];

function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + stable(value[key]);
    }).join(',') + '}';
    return JSON.stringify(value);
}

function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function iso(ms) { return typeof ms === 'number' ? new Date(ms).toISOString() : null; }
function bj(ms) { return typeof ms === 'number' ? new Date(ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC+8' : null; }
function same(a, b) { return stable(a) === stable(b); }
function processKey(point) { return point.processId; }
function pivotSide(pivot) { return pivot.type === 'SWING_HIGH' ? 'HIGH' : 'LOW'; }
function pivotOccurredAt(pivot) { return pivot.occurredAt === undefined ? pivot.sourceOpenTime : pivot.occurredAt; }
function decisionKey(symbol, pivot) {
    return [symbol, pivotSide(pivot), pivotOccurredAt(pivot), pivot.price, pivot.confirmedAt].join('|');
}

function ordinaryPivots(symbol, rows, index) {
    var right = 2;
    var middle = index - right;
    if (middle < 0) return [];
    var lo = Math.max(0, middle - right);
    var hi = Math.min(rows.length - 1, middle + right);
    var found = pivotDetector.detectPivots(rows.slice(lo, hi + 1), { left: right, right: right });
    var pivots = found.filter(function (point) { return point.index + lo === middle; }).map(function (point) {
        return { type: point.type, index: point.index + lo, price: point.price, confirmedAt: point.confirmedAt, time: point.time };
    });
    return swingLiquidity.buildSwingLiquidity(symbol, '5m', pivots, rows, right);
}

function canonicalOldPoint(state, point) {
    var priorId = point.id;
    point.id = ['DYND', state.symbol, state.timeframe, point.pointSide,
        point.selectorOccurredAt, point.confirmedAt].join(':');
    point.price = point.selectorWickPrice;
    point.priceSource = 'CLOSE_SELECTOR_WICK_BUSINESS';
    point.occurredAt = point.selectorOccurredAt;
    point.occurredBarIndex = point.selectorOccurredBarIndex;
    point.localizationMode = 'OLD_CLOSE_SELECTOR_WICK_A';
    point.localizedExtremeOpenTime = point.selectorOccurredAt;
    point.localizedExtremePrice = point.selectorWickPrice;
    delete state.confirmedPointById[priorId];
    state.confirmedPointById[point.id] = point;
}

function createLane(symbol, mode) {
    return {
        mode: mode,
        state: productionEq.createState({ symbol: symbol, timeframe: '5m' }),
        decisions: [],
        inactivationEvidence: {}
    };
}

function candidateView(lane, point, pivot, tolerance, rows, rank) {
    var sourceIndex = pivot.metadata.index;
    var occurredAt = pivotOccurredAt(pivot);
    var ageBars = sourceIndex - point.occurredBarIndex;
    var causalConfirmed = point.confirmedAt <= occurredAt;
    var occurredBefore = point.occurredAt < occurredAt;
    var within36h = causalConfirmed && occurredBefore && ageBars >= 1 && ageBars <= dynamicD.LOOKBACK_BARS;
    var present = lane.state.dynamicD.recentSurvivalPoints.indexOf(point) !== -1;
    var active = point.state === 'ACTIVE';
    var ageExpired = dynamicD.isAgeExpired(point, occurredAt);
    var strictCross = dynamicD.strictCrosses(point, pivot);
    var distance = Math.abs(pivot.price - point.price);
    var passesTolerance = distance <= tolerance;
    var eligibleBeforeLifecycle = present && active && within36h;
    var matches = eligibleBeforeLifecycle && !ageExpired && !strictCross && passesTolerance;
    return {
        rank: rank,
        processId: point.processId,
        pointId: point.id,
        side: point.pointSide,
        selectorOccurredAt: point.selectorOccurredAt,
        selectorOccurredAtUtc: iso(point.selectorOccurredAt),
        selectorPrice: point.selectorPrice,
        selectorWickPrice: point.selectorWickPrice,
        canonicalOccurredAt: point.occurredAt,
        canonicalOccurredAtUtc: iso(point.occurredAt),
        canonicalPrice: point.price,
        confirmedAt: point.confirmedAt,
        confirmedAtUtc: iso(point.confirmedAt),
        thetaSnapshot: point.thetaAtExtreme,
        activeStatusAtEvaluation: point.state,
        activeStatusBeforeEvaluation: point.state,
        activeStatusAfterEvaluation: point.state,
        causalConfirmed: causalConfirmed,
        occurredBeforeCurrentPoint: occurredBefore,
        presentInSurvivalRegistry: present,
        ageBars: ageBars,
        ageMinutes: ageBars * 5,
        within36h: within36h,
        boundaryBars: dynamicD.LOOKBACK_BARS,
        ageExpired: ageExpired,
        strictCrossAtCurrentPivot: strictCross,
        eligibleBeforeLifecycle: eligibleBeforeLifecycle,
        distanceToCurrentPrice: distance,
        distanceToCurrentAtr: lane.state.fiveMinuteAtrValue > 0 ? distance / lane.state.fiveMinuteAtrValue : null,
        passesTolerance: passesTolerance,
        matches: matches,
        statusTransitionEvidence: lane.inactivationEvidence[point.processId] || null
    };
}

function transitionEvidence(lane, point, pivot, rows, reason) {
    if (reason !== 'STRICT_CROSS') return null;
    var candle = rows[pivot.metadata.index];
    return {
        crossingPivotId: pivot.id,
        crossingCandleOpenTime: candle.openTime,
        crossingCandleOpenTimeUtc: iso(candle.openTime),
        crossingHigh: candle.high,
        crossingLow: candle.low,
        anchor: point.price,
        oldStatus: 'ACTIVE',
        newStatus: 'INACTIVE',
        reason: reason
    };
}

function evaluate(lane, symbol, pivot, rows) {
    var tolerance = lane.state.fiveMinuteAtrValue * require('../../config/thresholds').equalLiquidity.priceStrongMaxATR;
    var points = lane.state.dynamicD.confirmedPoints.filter(function (point) {
        return point.pointSide === pivotSide(pivot) && point.confirmedAt <= pivot.confirmedAt;
    });
    var candidates = points.map(function (point, rank) {
        return candidateView(lane, point, pivot, tolerance, rows, rank + 1);
    });
    var byProcess = new Map(candidates.map(function (view) { return [view.processId, view]; }));
    var eligible = productionEq.eligibleHistoricalPoints(lane.state, pivot);
    var matching = [];
    eligible.forEach(function (point) {
        if (dynamicD.isAgeExpired(point, pivotOccurredAt(pivot))) {
            dynamicD.markInactive(point, 'AGE_EXPIRY', pivotOccurredAt(pivot));
            var expiredView = byProcess.get(point.processId);
            if (expiredView) expiredView.activeStatusAfterEvaluation = point.state;
            return;
        }
        if (dynamicD.strictCrosses(point, pivot)) {
            var evidence = transitionEvidence(lane, point, pivot, rows, 'STRICT_CROSS');
            dynamicD.markInactive(point, 'STRICT_CROSS', pivot.confirmedAt);
            lane.inactivationEvidence[point.processId] = evidence;
            var currentView = byProcess.get(point.processId);
            if (currentView) {
                currentView.statusTransitionEvidence = evidence;
                currentView.activeStatusAfterEvaluation = point.state;
            }
            return;
        }
        if (Math.abs(pivot.price - point.price) <= tolerance) matching.push(point);
    });
    var currentPoint = {
        id: pivot.id,
        side: pivotSide(pivot),
        openTime: pivotOccurredAt(pivot),
        openTimeUtc: iso(pivotOccurredAt(pivot)),
        price: pivot.price,
        confirmedAt: pivot.confirmedAt,
        confirmedAtUtc: iso(pivot.confirmedAt),
        sourceIndex: pivot.metadata.index,
        atr14: lane.state.fiveMinuteAtrValue,
        eqToleranceAbsolute: tolerance,
        eqTolerancePct: pivot.price ? tolerance / pivot.price : null
    };
    lane.decisions.push({
        identity: decisionKey(symbol, pivot),
        symbol: symbol,
        side: currentPoint.side,
        evaluationTime: pivot.confirmedAt,
        evaluationTimeUtc: iso(pivot.confirmedAt),
        currentPoint: currentPoint,
        eventExists: matching.length > 0,
        historicalPartners: matching.map(function (point) { return byProcess.get(point.processId); }),
        candidateOrderingRule: 'RECENT_SURVIVAL_REGISTRY_INSERTION_ORDER_NO_PRIMARY_SELECTION',
        candidates: candidates
    });
}

function runLane(symbol, rows, mode) {
    var lane = createLane(symbol, mode);
    for (var i = 0; i < rows.length; i++) {
        productionEq.updateFiveMinuteAtr(lane.state, rows[i], i ? rows[i - 1] : null, i);
        dynamicD.pruneSurvivalBeforeBar(lane.state.dynamicD, i - dynamicD.LOOKBACK_BARS - 2);
        var detected = dynamicD.step(lane.state.dynamicD, rows[i], i, rows);
        if (mode === 'OLD_A') detected.dynamicDPoints.forEach(function (point) {
            canonicalOldPoint(lane.state.dynamicD, point);
        });
        ordinaryPivots(symbol, rows, i).forEach(function (pivot) { evaluate(lane, symbol, pivot, rows); });
    }
    var rawFvgSurface = [];
    for (var j = 0; j < rows.length; j++) {
        var fvg = watchModel.rawFvgAt(rows, j, symbol);
        if (fvg) rawFvgSurface.push(fvg);
    }
    return {
        mode: mode,
        symbol: symbol,
        processes: lane.state.dynamicD.confirmedPoints.map(function (point) {
            return {
                processId: point.processId,
                side: point.pointSide,
                selectorOccurredAt: point.selectorOccurredAt,
                selectorPrice: point.selectorPrice,
                selectorWickPrice: point.selectorWickPrice,
                canonicalOccurredAt: point.occurredAt,
                canonicalPrice: point.price,
                confirmedAt: point.confirmedAt,
                thetaSnapshot: point.thetaAtExtreme
            };
        }),
        decisions: lane.decisions,
        rawFvgSurface: rawFvgSurface
    };
}

function transitionMechanisms(oldView, newView) {
    var mechanisms = [];
    if (!oldView || !newView) return ['PROCESS_VIEW_MISSING'];
    if (!oldView.passesTolerance && newView.passesTolerance) mechanisms.push('ANCHOR_PRICE_ENTERED_EQ_TOLERANCE');
    if (oldView.passesTolerance && !newView.passesTolerance) mechanisms.push('ANCHOR_PRICE_LEFT_EQ_TOLERANCE');
    if (!oldView.within36h && newView.within36h) mechanisms.push('ANCHOR_OCCURRENCE_ENTERED_36H_WINDOW');
    if (oldView.within36h && !newView.within36h) mechanisms.push('ANCHOR_OCCURRENCE_LEFT_36H_WINDOW');
    if ((oldView.activeStatusAtEvaluation !== newView.activeStatusAtEvaluation) ||
            (oldView.strictCrossAtCurrentPivot !== newView.strictCrossAtCurrentPivot) ||
            (oldView.presentInSurvivalRegistry !== newView.presentInSurvivalRegistry)) {
        mechanisms.push('ACTIVE_STATUS_CHANGED_DUE_TO_NEW_CANONICAL_PRICE');
    }
    return mechanisms;
}

function classifyReason(classification, subtype, oldDecision, newDecision) {
    if (classification === 'HISTORICAL_PARTNER_CHANGED_ONLY' && subtype === 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS') {
        return { changeReason: 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS', mechanisms: changedMembershipMechanisms(oldDecision, newDecision) };
    }
    if (classification === 'HISTORICAL_PARTNER_CHANGED_ONLY') {
        return { changeReason: 'MULTIPLE_CAUSAL_EFFECTS', mechanisms: [
            'SAME_PROCESS_CANONICAL_ANCHOR_PRICE_REANCHORED',
            'SAME_PROCESS_CANONICAL_ANCHOR_OCCURRENCE_REANCHORED'
        ] };
    }
    var mechanisms = changedMembershipMechanisms(oldDecision, newDecision);
    var permitted = mechanisms.filter(function (value) { return value !== 'PROCESS_VIEW_MISSING'; });
    var unique = Array.from(new Set(permitted));
    if (unique.length === 1) return { changeReason: unique[0], mechanisms: mechanisms };
    if (unique.length > 1) return { changeReason: 'MULTIPLE_CAUSAL_EFFECTS', mechanisms: mechanisms };
    return { changeReason: 'UNEXPLAINED_DIFFERENCE', mechanisms: mechanisms };
}

function changedMembershipMechanisms(oldDecision, newDecision) {
    var oldBy = new Map(oldDecision.candidates.map(function (view) { return [view.processId, view]; }));
    var newBy = new Map(newDecision.candidates.map(function (view) { return [view.processId, view]; }));
    var ids = Array.from(new Set(oldDecision.historicalPartners.concat(newDecision.historicalPartners).map(function (view) {
        return view.processId;
    })));
    var mechanisms = [];
    ids.forEach(function (id) {
        var oldView = oldBy.get(id);
        var newView = newBy.get(id);
        if (!!(oldView && oldView.matches) !== !!(newView && newView.matches)) {
            mechanisms = mechanisms.concat(transitionMechanisms(oldView, newView));
        }
    });
    return Array.from(new Set(mechanisms));
}

function deltaViews(oldDecision, newDecision) {
    var oldBy = new Map(oldDecision.candidates.map(function (view) { return [view.processId, view]; }));
    var newBy = new Map(newDecision.candidates.map(function (view) { return [view.processId, view]; }));
    var ids = Array.from(new Set(oldDecision.historicalPartners.concat(newDecision.historicalPartners).map(function (view) {
        return view.processId;
    })));
    return ids.map(function (id) {
        var oldView = oldBy.get(id) || null;
        var newView = newBy.get(id) || null;
        return {
            processId: id,
            old: oldView,
            new: newView,
            anchorPriceDelta: oldView && newView ? newView.canonicalPrice - oldView.canonicalPrice : null,
            anchorPriceDeltaPct: oldView && newView && oldView.canonicalPrice ?
                (newView.canonicalPrice - oldView.canonicalPrice) / oldView.canonicalPrice : null,
            anchorTimeDeltaBars: oldView && newView ? (newView.canonicalOccurredAt - oldView.canonicalOccurredAt) / BAR : null,
            anchorTimeDeltaMinutes: oldView && newView ? (newView.canonicalOccurredAt - oldView.canonicalOccurredAt) / 60000 : null,
            statusTransitionEvidence: oldView && newView &&
                (oldView.activeStatusAfterEvaluation !== newView.activeStatusAfterEvaluation ||
                oldView.strictCrossAtCurrentPivot !== newView.strictCrossAtCurrentPivot) ? {
                    oldAnchor: oldView.canonicalPrice,
                    newAnchor: newView.canonicalPrice,
                    oldStatusBeforeEvaluation: oldView.activeStatusBeforeEvaluation,
                    newStatusBeforeEvaluation: newView.activeStatusBeforeEvaluation,
                    oldStatusAfterEvaluation: oldView.activeStatusAfterEvaluation,
                    newStatusAfterEvaluation: newView.activeStatusAfterEvaluation,
                    oldLaneTransition: oldView.statusTransitionEvidence,
                    newLaneTransition: newView.statusTransitionEvidence
                } : null
        };
    });
}

function processTrace(oldLane, newLane, selectorAt, oldPrice, newPrice) {
    var oldPoint = oldLane.processes.find(function (point) {
        return point.selectorOccurredAt === selectorAt && point.canonicalPrice === oldPrice;
    });
    var newPoint = newLane.processes.find(function (point) {
        return point.selectorOccurredAt === selectorAt && point.canonicalPrice === newPrice;
    });
    if (!oldPoint || !newPoint || oldPoint.processId !== newPoint.processId) {
        return { found: false, expectedSelectorOccurredAt: selectorAt, expectedOldPrice: oldPrice, expectedNewPrice: newPrice };
    }
    function interactions(lane) {
        return lane.decisions.map(function (decision) {
            if (decision.evaluationTime < START || decision.evaluationTime >= END) return null;
            var candidate = decision.candidates.find(function (view) { return view.processId === oldPoint.processId; });
            if (!candidate) return null;
            var matched = decision.historicalPartners.some(function (view) { return view.processId === oldPoint.processId; });
            return {
                evaluationTime: decision.evaluationTime,
                evaluationTimeUtc: decision.evaluationTimeUtc,
                currentPoint: decision.currentPoint,
                eventExists: decision.eventExists,
                matchedAsHistoricalPartner: matched,
                candidate: candidate
            };
        }).filter(Boolean);
    }
    var oldInteractions = interactions(oldLane), newInteractions = interactions(newLane);
    function uniqueTransitions(items) {
        var seen = {};
        return items.filter(function (item) {
            var evidence = item.candidate.statusTransitionEvidence;
            if (!evidence) return false;
            var key = stable(evidence);
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }
    return {
        found: true,
        processId: oldPoint.processId,
        oldPoint: oldPoint,
        newPoint: newPoint,
        confirmedAtUnchanged: oldPoint.confirmedAt === newPoint.confirmedAt,
        thetaUnchanged: oldPoint.thetaSnapshot === newPoint.thetaSnapshot,
        anchorPriceDelta: newPoint.canonicalPrice - oldPoint.canonicalPrice,
        anchorTimeDeltaBars: (newPoint.canonicalOccurredAt - oldPoint.canonicalOccurredAt) / BAR,
        oldCandidateDecisionCount: oldInteractions.length,
        newCandidateDecisionCount: newInteractions.length,
        oldEqPartnerMatches: oldInteractions.filter(function (item) { return item.matchedAsHistoricalPartner; }),
        newEqPartnerMatches: newInteractions.filter(function (item) { return item.matchedAsHistoricalPartner; }),
        oldStatusTransitions: uniqueTransitions(oldInteractions),
        newStatusTransitions: uniqueTransitions(newInteractions)
    };
}

function compareSymbol(oldLane, newLane) {
    var oldProcesses = new Map(oldLane.processes.map(function (point) { return [processKey(point), point]; }));
    var newProcesses = new Map(newLane.processes.map(function (point) { return [processKey(point), point]; }));
    var processIdsEqual = same(Array.from(oldProcesses.keys()), Array.from(newProcesses.keys()));
    var processFieldsEqual = processIdsEqual && Array.from(oldProcesses.keys()).every(function (id) {
        var a = oldProcesses.get(id), b = newProcesses.get(id);
        return a.side === b.side && a.confirmedAt === b.confirmedAt && a.thetaSnapshot === b.thetaSnapshot &&
            a.selectorOccurredAt === b.selectorOccurredAt && a.selectorPrice === b.selectorPrice;
    });
    var oldDecisions = new Map(oldLane.decisions.map(function (decision) { return [decision.identity, decision]; }));
    var newDecisions = new Map(newLane.decisions.map(function (decision) { return [decision.identity, decision]; }));
    var keysEqual = same(Array.from(oldDecisions.keys()), Array.from(newDecisions.keys()));
    var hidden = {
        dynamicDProcessIdSet: processIdsEqual,
        dynamicDProcessFields: processFieldsEqual,
        currentPoint: keysEqual,
        currentPointConfirmedAt: keysEqual,
        atr14: keysEqual,
        eqTolerance: keysEqual,
        evaluationTime: keysEqual,
        dynamicDTheta: processFieldsEqual,
        rawFvgSurface: hash(oldLane.rawFvgSurface) === hash(newLane.rawFvgSurface)
    };
    if (keysEqual) Array.from(oldDecisions.keys()).forEach(function (key) {
        var a = oldDecisions.get(key), b = newDecisions.get(key);
        hidden.currentPoint = hidden.currentPoint && same(a.currentPoint.id, b.currentPoint.id) && a.currentPoint.price === b.currentPoint.price && a.currentPoint.openTime === b.currentPoint.openTime;
        hidden.currentPointConfirmedAt = hidden.currentPointConfirmedAt && a.currentPoint.confirmedAt === b.currentPoint.confirmedAt;
        hidden.atr14 = hidden.atr14 && a.currentPoint.atr14 === b.currentPoint.atr14;
        hidden.eqTolerance = hidden.eqTolerance && a.currentPoint.eqToleranceAbsolute === b.currentPoint.eqToleranceAbsolute;
        hidden.evaluationTime = hidden.evaluationTime && a.evaluationTime === b.evaluationTime;
    });
    var ledger = [];
    Array.from(oldDecisions.keys()).forEach(function (key) {
        var oldDecision = oldDecisions.get(key), newDecision = newDecisions.get(key);
        if (!newDecision || oldDecision.evaluationTime < START || oldDecision.evaluationTime >= END) return;
        var classification = null, subtype = null;
        if (oldDecision.eventExists && newDecision.eventExists) {
            var oldIds = oldDecision.historicalPartners.map(function (view) { return view.processId; });
            var newIds = newDecision.historicalPartners.map(function (view) { return view.processId; });
            var exactAnchors = same(oldDecision.historicalPartners.map(function (view) {
                return [view.processId, view.canonicalPrice, view.canonicalOccurredAt, view.confirmedAt];
            }), newDecision.historicalPartners.map(function (view) {
                return [view.processId, view.canonicalPrice, view.canonicalOccurredAt, view.confirmedAt];
            }));
            if (exactAnchors) classification = 'EXACT_SAME_EQ';
            else {
                classification = 'HISTORICAL_PARTNER_CHANGED_ONLY';
                subtype = same(oldIds, newIds) ? 'SAME_PROCESS_REANCHORED' : 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS';
            }
        } else if (!oldDecision.eventExists && newDecision.eventExists) classification = 'ADDED_EQ';
        else if (oldDecision.eventExists && !newDecision.eventExists) classification = 'REMOVED_EQ';
        if (!classification) return;
        var reason = classification === 'EXACT_SAME_EQ' ? { changeReason: null, mechanisms: [] } :
            classifyReason(classification, subtype, oldDecision, newDecision);
        ledger.push({
            identity: key,
            oldEqIdentity: oldDecision.eventExists ? key + '|partners=' + oldDecision.historicalPartners.map(function (view) { return view.processId; }).join(',') : null,
            newEqIdentity: newDecision.eventExists ? key + '|partners=' + newDecision.historicalPartners.map(function (view) { return view.processId; }).join(',') : null,
            symbol: oldDecision.symbol,
            side: oldDecision.side,
            classification: classification,
            subtype: subtype,
            changeReason: reason.changeReason,
            causalMechanisms: reason.mechanisms,
            evaluationTime: oldDecision.evaluationTime,
            evaluationTimeUtc: oldDecision.evaluationTimeUtc,
            currentPoint: oldDecision.currentPoint,
            oldHistoricalPartners: oldDecision.historicalPartners,
            newHistoricalPartners: newDecision.historicalPartners,
            anchorDeltas: deltaViews(oldDecision, newDecision),
            oldCandidateOrdering: oldDecision.candidates,
            newCandidateOrdering: newDecision.candidates
        });
    });
    return { ledger: ledger, hidden: hidden };
}

function counts(rows) {
    var result = { exactSame: 0, partnerChanged: 0, sameProcessReanchored: 0, pairingSwitched: 0, added: 0, removed: 0 };
    rows.forEach(function (row) {
        if (row.classification === 'EXACT_SAME_EQ') result.exactSame++;
        if (row.classification === 'HISTORICAL_PARTNER_CHANGED_ONLY') result.partnerChanged++;
        if (row.subtype === 'SAME_PROCESS_REANCHORED') result.sameProcessReanchored++;
        if (row.subtype === 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS') result.pairingSwitched++;
        if (row.classification === 'ADDED_EQ') result.added++;
        if (row.classification === 'REMOVED_EQ') result.removed++;
    });
    result.oldEq = result.exactSame + result.partnerChanged + result.removed;
    result.newEq = result.exactSame + result.partnerChanged + result.added;
    return result;
}

function buildAudit() {
    var audit = {
        task: 'SAME_PROCESS_WICK_LOCALIZATION_EQ_DIFF_TRACE_AUDIT_V1',
        window: { start: START, endExclusive: END },
        symbols: {}, ledger: [], hiddenLogicChecks: {},
        specialTraces: {},
        candidateOrdering: 'RECENT_SURVIVAL_REGISTRY_INSERTION_ORDER_NO_PRIMARY_SELECTION'
    };
    SYMBOLS.forEach(function (symbol) {
        var rows = capture.candles(capture.SPECS[symbol]);
        var oldLane = runLane(symbol, rows, 'OLD_A');
        var newLane = runLane(symbol, rows, 'NEW_B');
        var compared = compareSymbol(oldLane, newLane);
        var summary = counts(compared.ledger);
        audit.symbols[symbol] = summary;
        audit.hiddenLogicChecks[symbol] = compared.hidden;
        audit.ledger = audit.ledger.concat(compared.ledger);
        if (symbol === 'BTCUSDT') audit.specialTraces.btc = processTrace(
            oldLane, newLane, Date.parse('2026-09-06T15:05:00.000Z'), 79466.8, 79125.3);
        if (symbol === 'ETHUSDT') audit.specialTraces.eth = processTrace(
            oldLane, newLane, Date.parse('2026-09-12T05:25:00.000Z'), 2508.34, 2504.57);
    });
    var diff = audit.ledger.filter(function (row) { return row.classification !== 'EXACT_SAME_EQ'; });
    audit.totalDiffCases = diff.length;
    audit.unexplainedCases = diff.filter(function (row) { return row.changeReason === 'UNEXPLAINED_DIFFERENCE'; }).length;
    audit.explainedCases = audit.totalDiffCases - audit.unexplainedCases;
    audit.reasonDistribution = {};
    REASONS.forEach(function (reason) { audit.reasonDistribution[reason] = 0; });
    diff.forEach(function (row) { audit.reasonDistribution[row.changeReason] = (audit.reasonDistribution[row.changeReason] || 0) + 1; });
    Object.keys(audit.reasonDistribution).forEach(function (reason) {
        audit.reasonDistribution[reason] = { count: audit.reasonDistribution[reason], percentage: audit.reasonDistribution[reason] / audit.totalDiffCases };
    });
    audit.mechanismDistribution = {};
    diff.forEach(function (row) {
        row.causalMechanisms.forEach(function (mechanism) {
            audit.mechanismDistribution[mechanism] = (audit.mechanismDistribution[mechanism] || 0) + 1;
        });
    });
    audit.hiddenLogicPass = Object.keys(audit.hiddenLogicChecks).every(function (symbol) {
        return Object.keys(audit.hiddenLogicChecks[symbol]).every(function (key) { return audit.hiddenLogicChecks[symbol][key] === true; });
    });
    return audit;
}

function csvCell(value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    return '"' + text.replace(/"/g, '""') + '"';
}

function writeCsv(audit) {
    var fields = ['identity', 'oldEqIdentity', 'newEqIdentity', 'symbol', 'side', 'classification', 'subtype', 'changeReason', 'evaluationTime',
        'currentPoint', 'oldHistoricalPartners', 'newHistoricalPartners', 'anchorDeltas', 'causalMechanisms',
        'oldCandidateOrdering', 'newCandidateOrdering'];
    return [fields.join(',')].concat(audit.ledger.map(function (row) {
        return fields.map(function (field) { return csvCell(row[field]); }).join(',');
    })).join('\n') + '\n';
}

function renderCase(row) {
    var anchorLines = row.anchorDeltas.map(function (delta) {
        function side(view) {
            if (!view) return 'absent';
            return 'anchor=' + view.canonicalPrice + '@' + bj(view.canonicalOccurredAt) +
                ', statusBefore/After=' + view.activeStatusBeforeEvaluation + '/' + view.activeStatusAfterEvaluation + ', ageBars=' + view.ageBars +
                ', within36h=' + view.within36h + ', distance=' + view.distanceToCurrentPrice +
                ', distanceATR=' + view.distanceToCurrentAtr + ', tolerancePass=' + view.passesTolerance +
                ', strictCross=' + view.strictCrossAtCurrentPivot + ', matches=' + view.matches;
        }
        return '  - `' + delta.processId + '`\n    - OLD: `' + side(delta.old) + '`\n    - NEW: `' + side(delta.new) +
            '`\n    - delta: `price=' + delta.anchorPriceDelta + ', pricePct=' + delta.anchorPriceDeltaPct +
            ', timeBars=' + delta.anchorTimeDeltaBars + ', timeMinutes=' + delta.anchorTimeDeltaMinutes +
            '`\n    - statusTransitionEvidence: `' + JSON.stringify(delta.statusTransitionEvidence) + '`';
    }).join('\n');
    return [
        '### ' + row.symbol + ' ' + row.side + ' @ ' + bj(row.evaluationTime), '',
        '- classification: `' + row.classification + (row.subtype ? ' / ' + row.subtype : '') + '`',
        '- changeReason: `' + row.changeReason + '`',
        '- mechanisms: `' + row.causalMechanisms.join(', ') + '`',
        '- Current Point: `' + bj(row.currentPoint.openTime) + ' / ' + row.currentPoint.price +
            '`; confirmedAt=`' + bj(row.currentPoint.confirmedAt) + '`; ATR14=`' + row.currentPoint.atr14 +
            '`; tolerance=`' + row.currentPoint.eqToleranceAbsolute + '` (' + (row.currentPoint.eqTolerancePct * 100).toFixed(6) + '%)',
        '- OLD matching partners: `' + row.oldHistoricalPartners.map(function (p) { return p.processId + ' @ ' + p.canonicalPrice + ' / ' + bj(p.canonicalOccurredAt); }).join('; ') + '`',
        '- NEW matching partners: `' + row.newHistoricalPartners.map(function (p) { return p.processId + ' @ ' + p.canonicalPrice + ' / ' + bj(p.canonicalOccurredAt); }).join('; ') + '`',
        '- Anchor traces:', anchorLines || '  - none',
        '- Candidate ordering: registry insertion order; OLD=' + row.oldCandidateOrdering.length + ', NEW=' + row.newCandidateOrdering.length + '; no primary selector.', ''
    ].join('\n');
}

function sampleRows(audit, classification, minimum) {
    var rows = audit.ledger.filter(function (row) { return row.classification === classification; });
    var selected = [], used = {};
    rows.forEach(function (row) {
        if (!used[row.symbol] && selected.length < minimum) { selected.push(row); used[row.symbol] = true; }
    });
    rows.forEach(function (row) { if (selected.length < minimum && selected.indexOf(row) < 0) selected.push(row); });
    return selected;
}

function samplePartnerRows(audit) {
    var selected = [];
    ['SAME_PROCESS_REANCHORED', 'PAIRING_SWITCHED_TO_DIFFERENT_PROCESS'].forEach(function (subtype) {
        SYMBOLS.forEach(function (symbol) {
            var row = audit.ledger.find(function (candidate) {
                return candidate.symbol === symbol && candidate.subtype === subtype;
            });
            if (row) selected.push(row);
        });
    });
    return selected;
}

function renderSamples(title, rows) {
    return ['# ' + title, ''].concat(rows.map(renderCase)).join('\n');
}

function specialTrace(trace, selectorAt, oldPrice, newPrice, title) {
    var header = ['# ' + title, '', '- selectorOccurredAt: `' + bj(selectorAt) + '`', '- old/new price: `' + oldPrice + ' → ' + newPrice + '`', ''];
    if (!trace || !trace.found) header.push('`FROZEN_PROCESS_NOT_FOUND`', '');
    else {
        header.push('- processId: `' + trace.processId + '`',
            '- canonical occurredAt: `' + bj(trace.oldPoint.canonicalOccurredAt) + ' → ' + bj(trace.newPoint.canonicalOccurredAt) + '`',
            '- anchorTimeDeltaBars: `' + trace.anchorTimeDeltaBars + '`',
            '- confirmedAt unchanged: `' + trace.confirmedAtUnchanged + '`',
            '- theta unchanged: `' + trace.thetaUnchanged + '`',
            '- candidate decisions OLD/NEW: `' + trace.oldCandidateDecisionCount + '/' + trace.newCandidateDecisionCount + '`',
            '- EQ partner matches OLD/NEW: `' + trace.oldEqPartnerMatches.length + '/' + trace.newEqPartnerMatches.length + '`',
            '- strict-cross status traces OLD/NEW: `' + trace.oldStatusTransitions.length + '/' + trace.newStatusTransitions.length + '`', '',
            '## OLD EQ partner matches', '', '```json', JSON.stringify(trace.oldEqPartnerMatches, null, 2), '```', '',
            '## NEW EQ partner matches', '', '```json', JSON.stringify(trace.newEqPartnerMatches, null, 2), '```', '',
            '## ACTIVE/BROKEN evidence', '', '```json', JSON.stringify({ old: trace.oldStatusTransitions, new: trace.newStatusTransitions }, null, 2), '```', '');
        if (!trace.oldEqPartnerMatches.length && !trace.newEqPartnerMatches.length &&
                !trace.oldStatusTransitions.length && !trace.newStatusTransitions.length) {
            header.push('`NO_DOWNSTREAM_EQ_EFFECT_IN_WINDOW`', '');
        }
    }
    return header.join('\n');
}

function report(audit) {
    var lines = ['# SAME_PROCESS_WICK_LOCALIZATION_EQ_DIFF_TRACE_AUDIT_V1', '', '## 1. SUMMARY', '',
        '| Symbol | OLD EQ | NEW EQ | EXACT SAME | PARTNER CHANGED | ADDED | REMOVED |',
        '|---|---:|---:|---:|---:|---:|---:|'];
    SYMBOLS.forEach(function (symbol) { var s = audit.symbols[symbol]; lines.push('| ' + symbol + ' | ' + s.oldEq + ' | ' + s.newEq + ' | ' + s.exactSame + ' | ' + s.partnerChanged + ' | ' + s.added + ' | ' + s.removed + ' |'); });
    lines.push('', '## 2. REASON DISTRIBUTION', '');
    Object.keys(audit.reasonDistribution).sort().forEach(function (reason) { var value = audit.reasonDistribution[reason]; lines.push('- ' + reason + ': ' + value.count + ' (' + (value.percentage * 100).toFixed(2) + '%)'); });
    lines.push('', 'Observed causal mechanisms may be multiple within one event-level reason:');
    Object.keys(audit.mechanismDistribution).sort().forEach(function (mechanism) { lines.push('- ' + mechanism + ': ' + audit.mechanismDistribution[mechanism]); });
    lines.push('', '## 3. ADDED EQ EXAMPLES', '', sampleRows(audit, 'ADDED_EQ', 5).map(renderCase).join('\n'),
        '## 4. REMOVED EQ EXAMPLES', '', sampleRows(audit, 'REMOVED_EQ', 5).map(renderCase).join('\n'),
        '## 5. PARTNER CHANGED EXAMPLES', '',
        samplePartnerRows(audit).map(renderCase).join('\n'),
        '## 6. HIDDEN LOGIC CHECK', '', '```json', JSON.stringify(audit.hiddenLogicChecks, null, 2), '```', '',
        'Production pairing rule is registry insertion order with all matching partners retained. There is no primary-partner ranking or selector.', '',
        '## 7. UNEXPLAINED DIFFERENCES', '', 'UNEXPLAINED_DIFFERENCES=' + audit.unexplainedCases, '');
    return lines.join('\n');
}

function writeAudit(audit) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'eq-diff-ledger.json'), JSON.stringify(audit.ledger, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'eq-diff-ledger.csv'), writeCsv(audit));
    fs.writeFileSync(path.join(OUT, 'reason-summary.json'), JSON.stringify({ totalDiffCases: audit.totalDiffCases, explainedCases: audit.explainedCases, unexplainedCases: audit.unexplainedCases, distribution: audit.reasonDistribution, mechanismDistribution: audit.mechanismDistribution }, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'symbol-summary.json'), JSON.stringify(audit.symbols, null, 2) + '\n');
    fs.writeFileSync(path.join(OUT, 'sample-added.md'), renderSamples('ADDED EQ SAMPLE TRACE', sampleRows(audit, 'ADDED_EQ', 5)).trimEnd() + '\n');
    fs.writeFileSync(path.join(OUT, 'sample-removed.md'), renderSamples('REMOVED EQ SAMPLE TRACE', sampleRows(audit, 'REMOVED_EQ', 5)).trimEnd() + '\n');
    fs.writeFileSync(path.join(OUT, 'sample-partner-changed.md'), renderSamples('PARTNER CHANGED SAMPLE TRACE', samplePartnerRows(audit)).trimEnd() + '\n');
    fs.writeFileSync(path.join(OUT, 'BTC-79466-to-79125-trace.md'), specialTrace(audit.specialTraces.btc, Date.parse('2026-09-06T15:05:00.000Z'), 79466.8, 79125.3, 'BTC 79466.8 TO 79125.3 TRACE').trimEnd() + '\n');
    fs.writeFileSync(path.join(OUT, 'ETH-89-bar-shift-trace.md'), specialTrace(audit.specialTraces.eth, Date.parse('2026-09-12T05:25:00.000Z'), 2508.34, 2504.57, 'ETH 89-BAR SHIFT TRACE').trimEnd() + '\n');
    fs.writeFileSync(path.join(OUT, 'AUDIT_REPORT.md'), report(audit).trimEnd() + '\n');
}

function main() {
    var audit = buildAudit();
    writeAudit(audit);
    console.log(JSON.stringify({ symbols: audit.symbols, totalDiffCases: audit.totalDiffCases, explainedCases: audit.explainedCases, unexplainedCases: audit.unexplainedCases, reasonDistribution: audit.reasonDistribution, mechanismDistribution: audit.mechanismDistribution, hiddenLogicPass: audit.hiddenLogicPass }, null, 2));
}

if (require.main === module) main();
module.exports = {
    START: START,
    END: END,
    buildAudit: buildAudit,
    writeAudit: writeAudit,
    transitionMechanisms: transitionMechanisms,
    classifyReason: classifyReason,
    changedMembershipMechanisms: changedMembershipMechanisms,
    compareSymbol: compareSymbol,
    counts: counts,
    stable: stable,
    hash: hash
};
