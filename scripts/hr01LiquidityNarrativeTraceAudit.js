#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var liveEngine = require('../live/liveEngine');
var thresholds = require('../config/thresholds');
var displacementLeg = require('../stats/displacementLeg');
var liquidityProvenance = require('../stats/liquidityProvenance');
var equalLiquidity = require('../liquidity/equalLiquidity');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.resolve(process.argv[2] || path.join(ROOT, '.audit-hr01-liquidity-narrative-trace-v1'));
var SYMBOL = 'BTCUSDT';
var EVALUATION_TIME = Date.parse('2026-08-11T08:44:59.999Z');
var ENGINE_START = Date.parse('2026-06-23T16:40:00.000Z');
var TARGET_LEG_FIRST_ID = 'BTCUSDT:5m:DISPLACEMENT:BULLISH:1786433400000';
var TARGET_LEG_ID = 'LEG:' + TARGET_LEG_FIRST_ID;
var TARGET_MSS_ID = 'BTCUSDT:5m:MSS:BULLISH:BTCUSDT:5m:SWING_HIGH:1786431900000';
var TARGET_LOW_TIMES = [1786386900000, 1786431000000];
var productionFiles = [
    'structure/pivotDetector.js', 'liquidity/equalLiquidity.js', 'liquidity/liquidityLifecycle.js',
    'events/sweepEventAdapter.js', 'events/mssSignalDetector.js', 'events/displacementDetector.js',
    'stats/liquidityProvenance.js', 'stats/opportunityQuality.js', 'live/liveEngine.js',
    'config/thresholds.js'
];

var hashesBefore = hashes();
var data = loadData();
var candles = data['5m'].filter(function (c) { return c.closeTime >= ENGINE_START && c.closeTime <= EVALUATION_TIME; });
var engine = liveEngine.createLiveEngine({
    symbol: SYMBOL,
    exchangeInfo: data.exchangeInfo,
    structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
    calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
    fetcher: function (symbol, interval) { return Promise.resolve(data[interval] || []); },
    thresholds: thresholds
}, {
    snapshotInterval: 12,
    baseIndex: 0,
    dailyBiasProvider: function () {
        return { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'BYPASSED', evaluationTime: null, ageMs: null };
    }
});

var state = engine.getState();
var creationAttempts = [];
var lifecycleTrace = [];
var eventCreationTrace = [];
var currentIndex = null;
var currentCandle = null;
var originalRegistryAdd = state.registry.add;
state.registry.add = function (obj) {
    var accepted = originalRegistryAdd(obj);
    if (obj && (obj.type === 'SWING_LOW' || obj.type === 'EQL' || obj.side === 'SSL')) {
        creationAttempts.push({
            attemptedAt: currentCandle ? currentCandle.closeTime : obj.confirmedAt,
            candleIndex: currentIndex,
            accepted: accepted,
            duplicateId: !accepted && !!state.registry.getById(obj.id),
            object: clone(obj)
        });
    }
    return accepted;
};
var originalApply = state.registry.applyLifecycleEvent;
state.registry.applyLifecycleEvent = function (id, transition) {
    var before = clone(state.registry.getById(id));
    var result = originalApply(id, transition);
    if (before && before.side === 'SSL') {
        lifecycleTrace.push({
            id: id, type: before.type, price: before.price,
            candleIndex: currentIndex, candle: compactCandle(currentCandle),
            beforeStatus: before.status, transition: clone(transition), after: clone(state.registry.getById(id))
        });
    }
    return result;
};
var originalEventAdd = state.eventRegistry.add;
state.eventRegistry.add = function (event) {
    var accepted = originalEventAdd(event);
    if (event && event.type === 'LIQUIDITY_SWEEP') {
        eventCreationTrace.push({ attemptedAt: currentCandle && currentCandle.closeTime, accepted: accepted, event: clone(event) });
    }
    return accepted;
};

var returned = [];
var chain = Promise.resolve();
candles.forEach(function (c, i) {
    chain = chain.then(function () {
        currentIndex = i;
        currentCandle = c;
        return engine.onBar(c, i).then(function (opp) { if (opp) returned.push(clone(opp)); });
    });
});

chain.then(buildReport).catch(function (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
});

function buildReport() {
    var allLiquidity = state.registry.getAll(SYMBOL).filter(visible);
    var allSweeps = state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP').filter(visible);
    var allMss = state.eventRegistry.getByType(SYMBOL, 'MSS').filter(visible);
    var allDisp = state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT').filter(visible);
    var targetSwings = TARGET_LOW_TIMES.map(function (t) {
        return state.registry.getById(SYMBOL + ':5m:SWING_LOW:' + t);
    });
    var lowTraces = targetSwings.map(function (s, n) { return pivotTrace(s, TARGET_LOW_TIMES[n]); });
    var targetIds = targetSwings.filter(Boolean).map(function (s) { return s.id; });
    var formationStart = targetSwings[0] ? targetSwings[0].confirmedAt : TARGET_LOW_TIMES[0];

    var generationTrace = creationAttempts.filter(function (a) {
        var o = a.object;
        if (!o || o.type !== 'EQL') return false;
        var ids = memberIds(o);
        return ids.some(function (id) { return targetIds.indexOf(id) !== -1; });
    }).map(compactGeneration);
    var acceptedEql = allLiquidity.filter(function (l) { return l.type === 'EQL'; });
    var targetEql = acceptedEql.filter(function (e) {
        var ids = memberIds(e);
        return targetIds.length === 2 && targetIds.every(function (id) { return ids.indexOf(id) !== -1; });
    });
    var targetA = targetSwings[0];
    var targetB = targetSwings[1];
    var grouping = targetA && targetB ? {
        priceA: targetA.price, priceB: targetB.price,
        memberDistance: round(Math.abs(targetA.price - targetB.price)),
        anchorTolerance: round(equalLiquidity.toleranceFor(
            Math.min(targetA.price, targetB.price), thresholds.equalLiquidity.percentageTolerance,
            data.exchangeInfo.tickSize, thresholds.tickSize.equalMultiplier
        )),
        barsApart: equalLiquidity.barsApart(targetA, targetB),
        minBarsApart: thresholds.equalLiquidity.minBarsApart,
        maxBarsApart: thresholds.equalLiquidity.maxBarsApart,
        priceTolerancePass: Math.abs(targetA.price - targetB.price) <= equalLiquidity.toleranceFor(
            Math.min(targetA.price, targetB.price), thresholds.equalLiquidity.percentageTolerance,
            data.exchangeInfo.tickSize, thresholds.tickSize.equalMultiplier
        ),
        barDistancePass: equalLiquidity.barsApart(targetA, targetB) >= thresholds.equalLiquidity.minBarsApart &&
            equalLiquidity.barsApart(targetA, targetB) <= thresholds.equalLiquidity.maxBarsApart,
        groupingAlgorithm: 'price-sorted greedy; compare candidate with group anchor; registry add dedupes by id'
    } : null;

    var regionalObjects = allLiquidity.filter(function (l) {
        if (l.side !== 'SSL') return false;
        return ((l.price >= 63750 && l.price <= 63850) && l.confirmedAt >= formationStart) ||
            memberIds(l).some(function (id) { return targetIds.indexOf(id) !== -1; });
    }).map(compactLiquidity);
    var regionalIds = regionalObjects.map(function (l) { return l.id; });
    var regionalSweeps = allSweeps.filter(function (s) { return regionalIds.indexOf(s.liquidityId) !== -1; });
    var regionalSweepChecks = regionalObjects.map(function (l) {
        var sw = regionalSweeps.filter(function (s) { return s.liquidityId === l.id; })[0];
        if (sw) return compactSweep(sw, l);
        return {
            sweepId: null, sourceLiquidityId: l.id, sourceType: l.type, sourcePrice: l.price,
            side: l.side, status: l.status, evaluationTimeVisible: l.confirmedAt <= EVALUATION_TIME,
            noSweepReason: l.status === 'BROKEN'
                ? 'Lifecycle classified closed-candle close-through as BROKEN, not SWEPT'
                : (l.status === 'TOUCHED' ? 'Touched but no wick-through-and-reclaim after confirmation' : 'No post-confirmation wick-through-and-reclaim')
        };
    });

    var legIndex = displacementLeg.buildWindowedLegIndex(allDisp, candles, allMss, state.swings, 900000);
    var leg = legIndex[TARGET_LEG_FIRST_ID];
    if (!leg) throw new Error('TARGET_LEG_NOT_FOUND');
    var association = liquidityProvenance.associateSweeps({
        direction: 'BULLISH', leg: leg, availableAt: EVALUATION_TIME,
        sweepEvents: allSweeps, maxLookbackBars: null
    });
    var eligibleIds = {};
    (association && association.allCandidates || []).forEach(function (c) { eligibleIds[c.id] = true; });
    var ranked = (association && association.allCandidates || []).slice().sort(function (a, b) {
        var da = Math.abs(a.barsBeforeLegStart), db = Math.abs(b.barsBeforeLegStart);
        return da - db || b.confirmedAt - a.confirmedAt;
    });
    var ranks = {};
    ranked.forEach(function (c, i) { ranks[c.id] = i + 1; });
    var immediateId = association && association.immediateSweep ? association.immediateSweep.id : null;
    var associationCandidates = (association && association.allCandidates || []).map(function (c) {
        return {
            sourceLiquidityId: c.sourceId, sourceType: c.sourceType, sourcePrice: c.sourcePrice,
            sweepId: c.id, sweepTime: candleAtIndex(c.candleIndex).openTime, confirmedAt: c.confirmedAt,
            relation: c.relation, barsFromLegStart: c.candleIndex - leg.startIndex,
            barsBeforeLegStart: c.barsBeforeLegStart, directionMatch: c.side === 'SSL',
            candidateRank: ranks[c.id], primary: c.id === immediateId,
            exclusionReason: null
        };
    });
    var allAssociationChecks = allSweeps.map(function (s) {
        var exclusions = [];
        var endIndex = leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex;
        var startBound = leg.startIndex - thresholds.events.sweepProvenance.maxLookbackBars;
        if (s.side !== 'SSL') exclusions.push('DIRECTION_MISMATCH');
        if (typeof s.confirmedAt !== 'number' || s.confirmedAt > EVALUATION_TIME) exclusions.push('CONFIRMED_AFTER_EVALUATION');
        if (typeof s.candleIndex !== 'number') exclusions.push('MISSING_CANDLE_INDEX');
        else {
            if (s.candleIndex > endIndex) exclusions.push('AFTER_LEG_END');
            if (s.candleIndex < startBound) exclusions.push('BEFORE_48_BAR_ASSOCIATION_WINDOW');
        }
        return {
            sweepId: s.id, sourceLiquidityId: s.liquidityId,
            sourceType: s.source && s.source.liquidityType,
            sourcePrice: s.price, side: s.side, confirmedAt: s.confirmedAt,
            candleIndex: s.candleIndex, barsFromLegStart: s.candleIndex - leg.startIndex,
            barsBeforeLegStart: leg.startIndex - s.candleIndex,
            eligible: !!eligibleIds[s.id], exclusionReasons: exclusions
        };
    });

    var targetSweepIds = {};
    targetIds.forEach(function (id) { targetSweepIds[id] = true; });
    targetEql.forEach(function (e) { targetSweepIds[e.id] = true; });
    var targetRaids = allSweeps.filter(function (s) { return targetSweepIds[s.liquidityId]; });
    var nearbyPreLegRaids = regionalSweeps.filter(function (s) { return s.confirmedAt <= leg.lastConfirmedAt; });
    var allFormationPreLegSslRaids = allSweeps.filter(function (s) {
        return s.side === 'SSL' && s.confirmedAt >= formationStart && s.confirmedAt <= leg.lastConfirmedAt;
    }).map(function (s) {
        var check = allAssociationChecks.filter(function (c) { return c.sweepId === s.id; })[0];
        var compact = compactSweep(s, state.registry.getById(s.liquidityId));
        compact.barsFromLegStart = s.candleIndex - leg.startIndex;
        compact.barsBeforeLegStart = leg.startIndex - s.candleIndex;
        compact.associationEligible = !!(check && check.eligible);
        compact.associationExclusionReasons = check ? check.exclusionReasons : [];
        return compact;
    });
    var targetMss = allMss.filter(function (m) { return m.id === TARGET_MSS_ID; })[0];
    var selectedRaid = nearbyPreLegRaids.slice().sort(function (a, b) { return b.confirmedAt - a.confirmedAt; })[0] || null;
    var leaks = [];
    regionalObjects.forEach(function (o) { if (o.confirmedAt > EVALUATION_TIME) leaks.push({ kind: 'LIQUIDITY_AFTER_EVALUATION', id: o.id }); });
    associationCandidates.forEach(function (c) {
        if (c.confirmedAt > leg.lastConfirmedAt) leaks.push({ kind: 'ASSOCIATED_SWEEP_AFTER_LEG_END', id: c.sweepId });
        if (c.confirmedAt > EVALUATION_TIME) leaks.push({ kind: 'ASSOCIATED_SWEEP_AFTER_EVALUATION', id: c.sweepId });
    });
    var pairEqlDetected = targetEql.length > 0;
    var primaryRoot = !targetA || !targetB ? 'A. LOW_PIVOTS_NOT_DETECTED'
        : (!pairEqlDetected ? 'B. EQL_NOT_GROUPED'
            : (targetRaids.length === 0 ? 'C. EQL_GROUPED_BUT_NOT_SWEPT'
                : (!(association && association.allCandidates || []).some(function (c) { return targetSweepIds[c.sourceId]; })
                    ? 'D. SWEEP_DETECTED_BUT_NOT_ASSOCIATED'
                    : 'G. OTHER')));
    var result = {
        audit: {
            reviewId: 'OQNR-HR-01', evaluationTime: EVALUATION_TIME,
            evaluationTimeIso: iso(EVALUATION_TIME), evaluationTimeUtc8: utc8(EVALUATION_TIME),
            direction: 'BULLISH', targetLegId: TARGET_LEG_ID,
            mssReference: { price: 63987.6, type: 'SWING_HIGH' },
            productionReplayPath: 'live/liveEngine.createLiveEngine().onBar',
            closedCandlesOnly: true, outcomeConsumed: false,
            engineStart: ENGINE_START, engineStartIso: iso(ENGINE_START), barsProcessed: candles.length
        },
        lowPivotTrace: lowTraces,
        equalLiquidityTrace: {
            pairGroupingCheck: grouping,
            targetPairEqlObjects: targetEql.map(compactLiquidity),
            relevantGenerationAttempts: generationTrace,
            EQL_DETECTED: pairEqlDetected ? 'YES' : 'NO',
            EQL_ID: targetEql[0] ? targetEql[0].id : null,
            EQL_PRICE: targetEql[0] ? targetEql[0].price : null,
            EQL_CONFIRMED_AT: targetEql[0] ? targetEql[0].confirmedAt : null,
            EQL_DETECTION_FAILURE_STAGE: pairEqlDetected ? null : (grouping && !grouping.priceTolerancePass ? 'PRICE_TOLERANCE_NOT_PASSED' : 'OTHER_GROUPING_STAGE')
        },
        regionalSslLiquidityObjects: regionalObjects,
        regionalObjectLifecycleTrace: lifecycleTrace.filter(function (x) { return regionalIds.indexOf(x.id) !== -1; }),
        sslRaidTrace: {
            scope: {
                formationStartInclusive: formationStart,
                formationStartIso: iso(formationStart),
                raidEndInclusive: leg.lastConfirmedAt,
                priceLowInclusive: 63750,
                priceHighInclusive: 63850,
                rationale: 'Target 63788/63820 SSL formation region; excludes unrelated historical same-price raids.'
            },
            SSL_RAID_DETECTED: nearbyPreLegRaids.length > 0 ? 'YES' : 'NO',
            SSL_RAID_SOURCE: selectedRaid ? selectedRaid.liquidityId : null,
            SSL_RAID_PRICE: selectedRaid ? selectedRaid.price : null,
            SSL_RAID_TIME: selectedRaid ? selectedRaid.occurredAt : null,
            SSL_RAID_CONFIRMED_AT: selectedRaid ? selectedRaid.confirmedAt : null,
            targetObjectRaids: targetRaids.map(function (s) { return compactSweep(s, state.registry.getById(s.liquidityId)); }),
            allSslRaidsAfterFirstLowBeforeLegEnd: allFormationPreLegSslRaids,
            allRegionalSweepChecks: regionalSweepChecks
        },
        legAssociationTrace: {
            leg: compactLeg(leg),
            associationWindow: {
                maxLookbackBars: thresholds.events.sweepProvenance.maxLookbackBars,
                startIndexInclusive: leg.startIndex - thresholds.events.sweepProvenance.maxLookbackBars,
                endIndexInclusive: leg.endIndex !== undefined ? leg.endIndex : leg.lastIndex,
                availableAt: EVALUATION_TIME
            },
            allCandidates: associationCandidates,
            immediateSweep: association && association.immediateSweep ? association.immediateSweep : null,
            allSweepChecks: allAssociationChecks,
            EQL_RAID_IN_CANDIDATES: !!(association && association.allCandidates || []).filter(function (c) { return targetSweepIds[c.sourceId]; }).length,
            EQL_RAID_SELECTED_PRIMARY: !!(association && association.immediateSweep && targetSweepIds[association.immediateSweep.sourceId]),
            LIQUIDITY_TAKEN_EXPECTED: associationCandidates.length > 0,
            LIQUIDITY_TAKEN_ACTUAL: false
        },
        narrativeTimeline: {
            eqlConfirmedAt: targetEql[0] ? targetEql[0].confirmedAt : null,
            sslRaidOccurredAt: selectedRaid ? selectedRaid.occurredAt : null,
            sslRaidConfirmedAt: selectedRaid ? selectedRaid.confirmedAt : null,
            mssOccurredAt: targetMss ? targetMss.occurredAt : null,
            mssConfirmedAt: targetMss ? targetMss.confirmedAt : null,
            displacementLegStartAt: leg.firstConfirmedAt ? candleAtIndex(leg.startIndex).openTime : null,
            displacementLegStartConfirmedAt: leg.firstConfirmedAt,
            displacementLegEndAt: leg.lastConfirmedAt,
            opportunityEvaluationTime: EVALUATION_TIME,
            raidToMssBars: selectedRaid && targetMss ? targetMss.candleIndex - selectedRaid.candleIndex : null,
            raidToLegStartBars: selectedRaid ? leg.startIndex - selectedRaid.candleIndex : null,
            mssToLegStartBars: targetMss ? leg.startIndex - targetMss.candleIndex : null
        },
        requiredFinal: {
            HR01_63788_LOW_DETECTED: !!targetA,
            HR01_63820_LOW_DETECTED: !!targetB,
            HR01_EQL_DETECTED: pairEqlDetected,
            HR01_SSL_RAID_DETECTED: nearbyPreLegRaids.length > 0,
            HR01_RAID_IN_LEG_CANDIDATES: associationCandidates.length > 0,
            HR01_RAID_SELECTED_PRIMARY: !!(association && association.immediateSweep),
            HR01_FORMATION_LIQUIDITY_TAKEN: false,
            HR01_PRIMARY_ROOT_CAUSE: primaryRoot
        },
        invariants: {
            PRODUCTION_CHANGED: JSON.stringify(hashesBefore) !== JSON.stringify(hashes()),
            FUTURE_LEAK_VIOLATIONS: leaks.length
        },
        futureLeakDetails: leaks,
        productionHashesBefore: hashesBefore,
        productionHashesAfter: hashes()
    };
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'hr01-liquidity-narrative-trace.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT, 'HR01_LIQUIDITY_NARRATIVE_TRACE_REPORT.md'), render(result));
    console.log(JSON.stringify({ requiredFinal: result.requiredFinal, invariants: result.invariants, output: OUT }, null, 2));
}

function pivotTrace(s, occurredAt) {
    var idx = candles.findIndex(function (c) { return c.openTime === occurredAt; });
    var c = candles[idx];
    var left = candles.slice(idx - 2, idx).map(compactCandle);
    var right = candles.slice(idx + 1, idx + 3).map(compactCandle);
    return {
        sourceSwingId: s ? s.id : null,
        requestedPrice: occurredAt === TARGET_LOW_TIMES[0] ? 63788 : 63820,
        actualPrice: s ? s.price : (c && c.low),
        occurredAt: c && c.openTime, occurredAtIso: c && iso(c.openTime),
        confirmedAt: s && s.confirmedAt, confirmedAtIso: s && iso(s.confirmedAt),
        pivotCandle: compactCandle(c), left2: left, right2: right,
        left2Pass: !!c && left.every(function (x) { return c.low < x.low; }),
        right2Pass: !!c && right.every(function (x) { return c.low <= x.low; }),
        confirmed: !!s,
        evaluationTimeVisible: !!s && s.confirmedAt <= EVALUATION_TIME,
        statusAtEvaluation: s && state.registry.getById(s.id) ? state.registry.getById(s.id).status : null
    };
}
function compactLiquidity(l) {
    return {
        id: l.id, type: l.type, side: l.side, price: l.price,
        occurredAt: l.sourceOpenTime, confirmedAt: l.confirmedAt, status: l.status,
        touchedAt: l.touchedAt, sweptAt: l.sweptAt, brokenAt: l.brokenAt,
        source: l.metadata && l.metadata.source,
        members: memberIds(l), uniqueMembers: Array.from(new Set(memberIds(l))),
        averagePrice: l.price,
        minPrice: l.metadata && l.metadata.minPrice,
        maxPrice: l.metadata && l.metadata.maxPrice,
        evaluationTimeVisible: l.confirmedAt <= EVALUATION_TIME
    };
}
function compactGeneration(a) {
    var x = compactLiquidity(a.object);
    x.attemptedAt = a.attemptedAt;
    x.accepted = a.accepted;
    x.duplicateId = a.duplicateId;
    x.tolerance = equalLiquidity.toleranceFor(
        x.minPrice || x.price, thresholds.equalLiquidity.percentageTolerance,
        data.exchangeInfo.tickSize, thresholds.tickSize.equalMultiplier
    );
    return x;
}
function compactSweep(s, l) {
    var c = s.source && s.source.candle;
    var wick = s.side === 'SSL' ? s.price - c.low : c.high - s.price;
    var closeBeyond = s.side === 'SSL' ? s.price - c.close : c.close - s.price;
    return {
        sweepId: s.id, sourceLiquidityId: s.liquidityId,
        sourceType: s.source && s.source.liquidityType,
        sourcePrice: s.price, side: s.side,
        occurredAt: s.occurredAt, occurredAtIso: iso(s.occurredAt),
        confirmedAt: s.confirmedAt, confirmedAtIso: iso(s.confirmedAt),
        sweepCandle: Object.assign({ openTime: s.occurredAt, closeTime: s.confirmedAt }, c),
        wickBeyond: round(wick), closeBeyond: round(closeBeyond),
        status: l ? l.status : 'SWEPT', evaluationTimeVisible: s.confirmedAt <= EVALUATION_TIME
    };
}
function compactLeg(l) {
    return {
        id: TARGET_LEG_ID, ids: l.ids, direction: l.direction,
        startIndex: l.startIndex, endIndex: l.endIndex !== undefined ? l.endIndex : l.lastIndex,
        firstConfirmedAt: l.firstConfirmedAt, lastConfirmedAt: l.lastConfirmedAt,
        availableAt: l.availableAt, mssId: l.mssId,
        rangeAtr: l.rangeAtr, netMoveAtr: l.netMoveAtr, bodyEfficiency: l.bodyEfficiency
    };
}
function memberIds(l) {
    return l && l.metadata && Array.isArray(l.metadata.members)
        ? l.metadata.members.map(function (m) { return m.id; }) : [];
}
function compactCandle(c) {
    return c ? { openTime: c.openTime, closeTime: c.closeTime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } : null;
}
function candleAtIndex(i) { return candles[i]; }
function visible(x) { return x && x.confirmedAt <= EVALUATION_TIME; }
function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
function round(n) { return Math.round(n * 1e8) / 1e8; }
function iso(t) { return typeof t === 'number' ? new Date(t).toISOString() : null; }
function utc8(t) { return new Date(t + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', ' UTC+8'); }
function hashes() {
    var out = {};
    productionFiles.forEach(function (f) { out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'); });
    return out;
}
function loadData() {
    var dir = path.join(ROOT, 'data-cache');
    var intervals = ['5m', '1h', '4h', '1d', '1w', '1M'];
    var result = {};
    intervals.forEach(function (tf) {
        var byOpen = {};
        fs.readdirSync(dir).filter(function (f) { return f.indexOf(SYMBOL + '_' + tf + '_') === 0 && /\.json$/.test(f); }).forEach(function (f) {
            var rows;
            try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
            (rows || []).forEach(function (c) {
                if (c && c.source === 'futures' && c.closed !== false && c.closeTime <= EVALUATION_TIME) byOpen[c.openTime] = c;
            });
        });
        result[tf] = Object.keys(byOpen).map(function (k) { return byOpen[k]; }).sort(function (a, b) { return a.openTime - b.openTime; });
    });
    var exchange = path.join(dir, SYMBOL + '_EXCHANGE.json');
    result.exchangeInfo = fs.existsSync(exchange) ? JSON.parse(fs.readFileSync(exchange, 'utf8')) : { symbol: SYMBOL, tickSize: 0.1 };
    return result;
}
function render(r) {
    var f = r.requiredFinal;
    var g = r.equalLiquidityTrace.pairGroupingCheck;
    return [
        '# HR-01 Liquidity Narrative Trace Audit', '',
        '- Evaluation: ' + r.audit.evaluationTimeIso,
        '- Outcome consumed: false', '',
        '## Pivot / EQL', '',
        '- 63788 LOW detected: ' + f.HR01_63788_LOW_DETECTED,
        '- 63820 LOW detected: ' + f.HR01_63820_LOW_DETECTED,
        '- Pair price distance: ' + (g && g.memberDistance),
        '- Production tolerance: ' + (g && g.anchorTolerance),
        '- Bars apart: ' + (g && g.barsApart) + ' (allowed ' + (g && g.minBarsApart) + '–' + (g && g.maxBarsApart) + ')',
        '- EQL detected: ' + f.HR01_EQL_DETECTED, '',
        '## Raid / association', '',
        '- SSL raid detected: ' + f.HR01_SSL_RAID_DETECTED,
        '- Raid in leg candidates: ' + f.HR01_RAID_IN_LEG_CANDIDATES,
        '- Raid selected primary: ' + f.HR01_RAID_SELECTED_PRIMARY,
        '- Formation liquidityTaken: ' + f.HR01_FORMATION_LIQUIDITY_TAKEN, '',
        '## Root cause', '',
        '- HR01_PRIMARY_ROOT_CAUSE: ' + f.HR01_PRIMARY_ROOT_CAUSE, '',
        '## Invariants', '',
        '- PRODUCTION_CHANGED = ' + r.invariants.PRODUCTION_CHANGED,
        '- FUTURE_LEAK_VIOLATIONS = ' + r.invariants.FUTURE_LEAK_VIOLATIONS, ''
    ].join('\n');
}
