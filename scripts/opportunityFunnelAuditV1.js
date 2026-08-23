/**
 * BTCUSDT Opportunity Funnel Audit V1
 *
 * Diagnostic-only replay. It calls the production live engine candle-by-candle,
 * records only closed candles in the requested audit window, and never mutates
 * production configuration or thresholds.
 *
 * Usage:
 *   node scripts/opportunityFunnelAuditV1.js BTCUSDT 30 <out-dir>
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var liveEngineMod = require('../live/liveEngine');
var displacementLeg = require('../stats/displacementLeg');
var structuralProvenance5m = require('../structure/structuralProvenance5m');
var opportunityQuality = require('../stats/opportunityQuality');
var liquidityProvenance = require('../stats/liquidityProvenance');
var alertPrioritization = require('../stats/alertPrioritization');
var thresholds = require('../config/thresholds');
var liveConfig = require('../config/live.json');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '30', 10);
var OUT_DIR = process.argv[4] || '.audit-opportunity-funnel-v1-btcusdt';
var BAR_MS = 300000;
var DAY_MS = 86400000;
var ROOT = path.join(__dirname, '..');
var CACHE_ONLY = process.env.AUDIT_FUTURES_CACHE_ONLY === '1';

var PRODUCTION_FILES = [
    'config/thresholds.js', 'config/live.json', 'live/liveEngine.js',
    'replay/replayState.js', 'replay/replayEngine.js',
    'structure/structuralProvenance5m.js', 'events/displacementDetector.js',
    'events/sweepEventAdapter.js', 'stats/displacementLeg.js',
    'stats/opportunityQuality.js', 'stats/alertPrioritization.js',
    'stats/liquidityProvenance.js'
];

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
}
function hashes() {
    var out = {};
    PRODUCTION_FILES.forEach(function (f) { out[f] = sha(f); });
    return out;
}
function sameHashes(a, b) {
    return PRODUCTION_FILES.every(function (f) { return a[f] === b[f]; });
}
function pct(n, d) { return d > 0 ? n / d : 0; }
function round(n, places) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    var p = Math.pow(10, places || 4);
    return Math.round(n * p) / p;
}
function iso(ms) { return ms === null || ms === undefined ? null : new Date(ms).toISOString(); }
function dayKey(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function inWindow(t, start, end) { return typeof t === 'number' && t >= start && t <= end; }
function compactCandle(c, index) {
    return c ? {
        index: index, openTime: c.openTime, closeTime: c.closeTime,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, closed: c.closed, source: c.source
    } : null;
}
function layer(input, pass) {
    return {
        inputCount: input,
        passCount: pass,
        rejectCount: Math.max(0, input - pass),
        passRateFromPrevious: pct(pass, input),
        rejectRateFromPrevious: pct(Math.max(0, input - pass), input)
    };
}
function uniqueObjectsFromIndex(index) {
    var seen = {};
    var out = [];
    Object.keys(index || {}).forEach(function (id) {
        var leg = index[id];
        var key = leg && leg.ids ? leg.ids.join('|') : id;
        if (!seen[key]) { seen[key] = true; out.push(leg); }
    });
    return out;
}
function latestClosedAt(list, evaluationTime) {
    var found = null;
    (list || []).forEach(function (c) {
        if (c.closed !== false && c.closeTime <= evaluationTime && (!found || c.closeTime > found.closeTime)) found = c;
    });
    return found ? compactCandle(found, null) : null;
}
function seedRand(seed) {
    var x = seed >>> 0;
    return function () {
        x = (x * 1664525 + 1013904223) >>> 0;
        return x / 4294967296;
    };
}
function deterministicSample(list, max, seed) {
    var copy = (list || []).slice();
    var rnd = seedRand(seed);
    for (var i = copy.length - 1; i > 0; i--) {
        var j = Math.floor(rnd() * (i + 1));
        var t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    }
    return copy.slice(0, max);
}

function main() {
    var beforeHashes = hashes();
    var requestedEnd = process.env.AUDIT_END_MS !== undefined
        ? parseInt(process.env.AUDIT_END_MS, 10)
        : Math.floor(Date.now() / BAR_MS) * BAR_MS - 1;
    if (!isFinite(requestedEnd)) throw new Error('INVALID_AUDIT_END_MS');
    var requestedStart = requestedEnd - DAYS * DAY_MS + 1;
    var engineStart = requestedStart - (liveConfig.warmupDays || 30) * DAY_MS;
    console.error('Audit load ' + SYMBOL + ': engine warmup from ' + iso(engineStart) + ', audit ' + iso(requestedStart) + ' -> ' + iso(requestedEnd));

    var loadPromise = CACHE_ONLY
        ? Promise.resolve(loadMergedFuturesCache(SYMBOL, engineStart, requestedEnd))
        : historicalLoader.loadAll(SYMBOL, engineStart, requestedEnd);
    return loadPromise.then(function (data) {
        validateSource(data);
        var loadedCandles = (data['5m'] || []).filter(function (c) { return c.closed !== false && c.closeTime <= requestedEnd; });
        if (loadedCandles.length === 0) throw new Error('NO_CLOSED_5M_CANDLES');
        var actualEnd = Math.min(requestedEnd, loadedCandles[loadedCandles.length - 1].closeTime);
        var actualStart = actualEnd - DAYS * DAY_MS + 1;
        var productionEngineStart = actualStart - (liveConfig.warmupDays || 30) * DAY_MS;
        var candles = loadedCandles.filter(function (c) { return c.closeTime >= productionEngineStart; });
        var auditBars = candles.filter(function (c) { return inWindow(c.closeTime, actualStart, actualEnd); });
        if (auditBars.length === 0) throw new Error('NO_AUDIT_BARS');

        var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
        var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
        var engine = liveEngineMod.createLiveEngine({
            symbol: SYMBOL,
            exchangeInfo: data.exchangeInfo,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            fetcher: function (sym, interval) { return Promise.resolve(calendarCandles[interval] || []); },
            thresholds: thresholds
        }, {
            snapshotInterval: liveConfig.snapshotInterval,
            baseIndex: 0,
            dailyBiasProvider: function () {
                return { bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN', status: 'BYPASSED', evaluationTime: null, ageMs: null };
            }
        });

        var returnedOpps = [];
        var snapshotTrace = {};
        var chain = Promise.resolve();
        candles.forEach(function (c, index) {
            chain = chain.then(function () {
                return engine.onBar(c, index).then(function (opp) {
                    if (inWindow(c.closeTime, actualStart, actualEnd)) {
                        var sn = engine.getState().snapshot || {};
                        snapshotTrace[index] = {
                            evaluationTime: c.closeTime,
                            draw: clone(sn.draw), structures: clone(sn.structures),
                            location: clone(sn.location), productionBiasRecordedOnly: clone(sn.bias)
                        };
                    }
                    if (opp && inWindow(opp.availableAt, actualStart, actualEnd)) returnedOpps.push(clone(opp));
                });
            });
        });
        return chain.then(function () {
            return analyze({
                data: data, candles: candles, auditBars: auditBars,
                actualStart: actualStart, actualEnd: actualEnd,
                engine: engine, returnedOpps: returnedOpps,
                snapshotTrace: snapshotTrace, beforeHashes: beforeHashes
            });
        });
    });
}

function validateSource(data) {
    ['5m', '1h', '4h', '1d', '1w', '1M'].forEach(function (tf) {
        var bad = (data[tf] || []).filter(function (c) { return c.source !== 'futures'; });
        if (bad.length) throw new Error('DATA_SOURCE_DEGRADED ' + tf + ': ' + bad.length + ' non-futures candles');
    });
}

function analyze(ctx) {
    var state = ctx.engine.getState();
    var candles = ctx.candles;
    var start = ctx.actualStart;
    var end = ctx.actualEnd;
    var allMss = state.eventRegistry.getByType(SYMBOL, 'MSS');
    var allStructuralMss = state.eventRegistry.getByType(SYMBOL, 'STRUCTURAL_MSS');
    var allDisp = state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT');
    var allSweeps = state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP');
    var allFvgs = state.fvgReg.getAll(SYMBOL);
    var allLiquidity = state.registry.getAll(SYMBOL);
    var mssPool = state.swings;
    var prioritizationEnabled = !!(thresholds.notify && thresholds.notify.prioritization && thresholds.notify.prioritization.enabled);

    var windowMss = allMss.filter(function (e) { return inWindow(e.confirmedAt, start, end); });
    var windowStructuralMss = allStructuralMss.filter(function (e) { return inWindow(e.confirmedAt, start, end); });
    var windowDisp = allDisp.filter(function (e) { return inWindow(e.confirmedAt, start, end); });
    var windowSweeps = allSweeps.filter(function (e) { return inWindow(e.confirmedAt, start, end); });
    var windowLiquidity = allLiquidity.filter(function (e) { return inWindow(e.confirmedAt, start, end); });
    var windowConfirmedSwings = mssPool.filter(function (s) { return inWindow(s.confirmedAt, start, end); });

    // Narrative timing is an enrichment only. It reuses the existing production
    // sweep provenance lookback and never gates MSS existence or opportunity tier.
    var raidLookback = thresholds.events && thresholds.events.sweepProvenance &&
        thresholds.events.sweepProvenance.maxLookbackBars != null
        ? thresholds.events.sweepProvenance.maxLookbackBars : 48;
    var raidByMssId = {};
    windowMss.forEach(function (m) {
        var wantSide = m.direction === 'BULLISH' ? 'SSL' : 'BSL';
        var raids = allSweeps.filter(function (s) {
            return s.side === wantSide && s.confirmedAt <= m.confirmedAt &&
                typeof s.candleIndex === 'number' && typeof m.candleIndex === 'number' &&
                s.candleIndex >= m.candleIndex - raidLookback && s.candleIndex <= m.candleIndex;
        }).sort(function (a, b) {
            var da = m.candleIndex - a.candleIndex;
            var db = m.candleIndex - b.candleIndex;
            return da - db || b.confirmedAt - a.confirmedAt || String(a.id).localeCompare(String(b.id));
        });
        if (raids[0]) raidByMssId[m.id] = raids[0];
    });

    var linkedMssIds = {};
    windowDisp.forEach(function (d) {
        if (d.metadata && d.metadata.mssEventId) linkedMssIds[d.metadata.mssEventId] = true;
    });
    var mssWithDisp = windowMss.filter(function (m) { return !!linkedMssIds[m.id]; });
    var mssAfterRaid = windowMss.filter(function (m) { return !!raidByMssId[m.id]; });
    var mssWithRaidAndDisp = mssWithDisp.filter(function (m) { return !!raidByMssId[m.id]; });

    var legIndex = displacementLeg.buildWindowedLegIndex(allDisp, candles, allMss, mssPool, 900000);
    var allLegs = uniqueObjectsFromIndex(legIndex);
    var windowLegs = allLegs.filter(function (leg) { return inWindow(leg.availableAt, start, end); });
    var validLegs = windowLegs.filter(function (leg) {
        return leg.rangeAtr !== null && leg.rangeAtr !== undefined && leg.availableIndex !== null && leg.availableIndex !== undefined;
    });

    var evaluations = [];
    var rejectionRecords = [];
    var futureLeaks = [];
    var candidates = [];
    var withLiquidity = [];
    var withNear = [];
    var nearMiss = [];

    windowMss.forEach(function (m) {
        if (!linkedMssIds[m.id]) addReject('MSS_WITH_VALID_DISPLACEMENT', 'R_MSS_NO_LINKED_DISPLACEMENT', m.id, m.confirmedAt, { actual: 'metadata.mssEventId absent', threshold: 'linked same-candle production displacement' });
    });
    windowLegs.forEach(function (leg) {
        if (validLegs.indexOf(leg) === -1) addReject('VALID_DISPLACEMENT_LEG', 'R_LEG_NOT_EVALUABLE', leg.ids[0], leg.availableAt, { actual: { rangeAtr: leg.rangeAtr, availableIndex: leg.availableIndex }, threshold: 'rangeAtr and availableIndex present' });
    });

    validLegs.forEach(function (leg) {
        var evalTime = leg.availableAt;
        var anchorIndex = leg.lastIndex;
        var availableIndex = leg.availableIndex;
        var anchorCandle = candles[anchorIndex];
        var evalSnapshot = ctx.snapshotTrace[availableIndex] || null;
        var legFvgs = allFvgs.filter(function (f) {
            return f.confirmedAt <= evalTime && f.displacementEventId && leg.ids.indexOf(f.displacementEventId) !== -1;
        });
        var mssEvent = null;
        if (leg.mssId) allMss.some(function (m) { if (m.id === leg.mssId) { mssEvent = m; return true; } return false; });
        var mssQuality = structuralProvenance5m.qualityForMss(mssEvent);
        var legQuality = displacementLeg.classifyLegQuality(leg);
        var dt = state.drawTrace && state.drawTrace[anchorIndex];
        var nearTarget = dt ? (leg.direction === 'BULLISH' ? dt.bslNear : dt.sslNear) : null;
        if ((nearTarget === null || nearTarget === undefined) && evalSnapshot && evalSnapshot.draw) {
            nearTarget = leg.direction === 'BULLISH'
                ? (evalSnapshot.draw.bsl && evalSnapshot.draw.bsl.near ? evalSnapshot.draw.bsl.near.targetPrice : null)
                : (evalSnapshot.draw.ssl && evalSnapshot.draw.ssl.near ? evalSnapshot.draw.ssl.near.targetPrice : null);
        }
        var prov = liquidityProvenance.associateSweeps({
            direction: leg.direction, leg: leg, availableAt: evalTime,
            sweepEvents: allSweeps, maxLookbackBars: null
        });
        var liqOk = !!(prov && prov.allCandidates && prov.allCandidates.length);
        if (liqOk) withLiquidity.push(leg);
        else addReject('LEG_WITH_LIQUIDITY_TAKEN', 'R_NO_ASSOCIATED_LIQUIDITY_TAKEN', leg.ids[0], evalTime, { actual: 0, threshold: '>=1 associated sweep in production provenance window' });
        var nearOk = nearTarget !== null && nearTarget !== undefined;
        if (nearOk) withNear.push(leg);
        else addReject('LEG_WITH_NEAR_DRAW', 'R_NO_NEAR_DRAW', leg.ids[0], evalTime, { actual: null, threshold: 'nearDrawAvailable=true' });

        var mssExists = !!mssEvent;
        var strongLeg = legQuality === 'STRONG' || legQuality === 'EXPLOSIVE';
        var legDisplacements = allDisp.filter(function (d) { return leg.ids.indexOf(d.id) !== -1; });
        var immediateSweep = prov && prov.immediateSweep ? prov.immediateSweep : null;
        var liquidityTypes = [];
        (prov && prov.allCandidates || []).forEach(function (s) {
            var t = s.sourceType || 'UNKNOWN';
            if (liquidityTypes.indexOf(t) === -1) liquidityTypes.push(t);
        });
        var priority = alertPrioritization.windowHasSignificant({ liquidityContext: prov }) ? 'PRIORITY_HIGH' : 'STANDARD_HIGH';
        var tier = opportunityQuality.classifyOpportunityTier({
            mssQuality: mssQuality, legQuality: legQuality,
            mssExists: mssExists, nearDrawAvailable: nearOk, directionConflict: false
        });
        var ev = {
            id: leg.mssId || ('LEG:' + leg.ids[0]), legId: 'LEG:' + leg.ids[0],
            direction: leg.direction, evaluationTime: evalTime,
            availableIndex: availableIndex, anchorIndex: anchorIndex,
            tier: tier, mssQuality: mssQuality, legQuality: legQuality,
            mssReferenceRole: mssEvent ? mssEvent.referenceStructuralRole : null,
            mssGrade: mssEvent ? mssEvent.mssGrade : null,
            protectedBreak: !!(mssEvent && mssEvent.protectedBreak),
            fvgCount: legFvgs.length, rangeAtr: leg.rangeAtr,
            netMoveAtr: leg.netMoveAtr, bodyEfficiency: leg.bodyEfficiency,
            nearTarget: nearTarget, liquidityTaken: liqOk,
            liquidityType: immediateSweep ? (immediateSweep.sourceType || 'UNKNOWN') : null,
            liquidityTypes: liquidityTypes,
            displacementQuality: {
                productionValid: legDisplacements.length > 0,
                events: legDisplacements.map(function (d) {
                    return {
                        id: d.id, confirmedAt: d.confirmedAt,
                        score: d.score != null ? d.score : (d.metadata && d.metadata.score),
                        maxScore: d.maxScore != null ? d.maxScore : (d.metadata && d.metadata.maxScore),
                        bodyRatio: d.bodyRatio != null ? d.bodyRatio : (d.metadata && d.metadata.bodyRatio),
                        rangeAtr: d.rangeAtr != null ? d.rangeAtr : (d.metadata && d.metadata.rangeAtr),
                        bodyAtr: d.bodyAtr != null ? d.bodyAtr : (d.metadata && d.metadata.bodyAtr),
                        closeExtremeRatio: d.closeExtremeRatio != null ? d.closeExtremeRatio : (d.metadata && d.metadata.closeExtremeRatio)
                    };
                })
            },
            dailyBias: {
                bias: 'UNKNOWN', confidence: null, alignment: 'UNKNOWN',
                status: 'BYPASSED', evaluationTime: null, ageMs: null
            },
            marketBiasContext: evalSnapshot ? clone(evalSnapshot.productionBiasRecordedOnly) : null,
            notifyPriority: tier === 'HIGH_QUALITY' ? priority : null,
            highConditions: { fvg: legFvgs.length > 0, mssExists: mssExists, legQuality: strongLeg, nearDraw: nearOk },
            priorityCondition: !prioritizationEnabled || priority === 'PRIORITY_HIGH',
            leg: leg, mssEvent: mssEvent, fvgIds: legFvgs.map(function (f) { return f.id; }),
            liquidityContext: prov
        };
        var orderedRaid = mssEvent ? raidByMssId[mssEvent.id] : null;
        ev.raidId = orderedRaid ? orderedRaid.id : null;
        ev.raidSide = orderedRaid ? orderedRaid.side : null;
        ev.raidDirection = orderedRaid
            ? (orderedRaid.side === 'SSL' ? 'BULLISH' : (orderedRaid.side === 'BSL' ? 'BEARISH' : null))
            : null;
        ev.mssDirection = mssEvent ? mssEvent.direction : null;
        ev.displacementDirection = leg.direction;
        ev.opportunityDirection = leg.direction;
        ev.raidDirectionMatch = !!(ev.raidDirection && ev.raidDirection === ev.opportunityDirection);
        ev.fullDirectionAlignment = !!(ev.raidDirection && ev.mssDirection &&
            ev.raidDirection === ev.mssDirection &&
            ev.mssDirection === ev.displacementDirection &&
            ev.displacementDirection === ev.opportunityDirection);
        ev.raidToMssBars = orderedRaid && typeof orderedRaid.candleIndex === 'number'
            ? mssEvent.candleIndex - orderedRaid.candleIndex : null;
        ev.mssToDisplacementBars = mssEvent && typeof mssEvent.candleIndex === 'number'
            ? leg.startIndex - mssEvent.candleIndex : null;
        ev.highGates = {
            fvg: { pass: legFvgs.length > 0, actual: legFvgs.length, threshold: '> 0' },
            mssExists: { pass: mssExists, actual: mssExists, threshold: true },
            legQuality: { pass: strongLeg, actual: legQuality, threshold: 'STRONG | EXPLOSIVE' },
            nearDraw: { pass: nearOk, actual: nearTarget, threshold: 'available' },
            directionConflict: { pass: true, actual: false, threshold: false }
        };
        ev.highFailedConditions = Object.keys(ev.highGates).filter(function (k) { return !ev.highGates[k].pass; });
        ev.finalRejectReason = tier === 'HIGH_QUALITY' ? null
            : (!nearOk ? 'R_NO_NEAR_DRAW'
                : (!mssExists ? 'R_MSS_MISSING'
                    : (!strongLeg ? 'R_LEG_QUALITY_INSUFFICIENT' : 'R_OTHER_HIGH_GATE')));
        evaluations.push(ev);

        if (mssEvent && mssEvent.confirmedAt > evalTime) leak('MSS_CONFIRMED_AFTER_EVALUATION', ev.id, mssEvent.confirmedAt, evalTime);
        (legFvgs || []).forEach(function (f) { if (f.confirmedAt > evalTime) leak('FVG_CONFIRMED_AFTER_EVALUATION', ev.id, f.confirmedAt, evalTime); });
        (prov && prov.allCandidates || []).forEach(function (s) { if (s.confirmedAt > evalTime) leak('SWEEP_CONFIRMED_AFTER_EVALUATION', ev.id, s.confirmedAt, evalTime); });

        if (legFvgs.length === 0) {
            addReject('OPPORTUNITY_CANDIDATE', 'R_LEG_NO_FVG', ev.id, evalTime, { actual: 0, threshold: 'legFvgs.length > 0', ev: ev });
            maybeNearMiss(ev, true);
            return;
        }
        candidates.push(ev);
        if (tier !== 'HIGH_QUALITY') {
            var reason = !nearOk ? 'R_NO_NEAR_DRAW'
                : (!mssExists ? 'R_MSS_MISSING' : 'R_LEG_QUALITY_INSUFFICIENT');
            addReject('HIGH_QUALITY', reason, ev.id, evalTime, tierRejectDetail(ev, reason));
        } else if (prioritizationEnabled && priority !== 'PRIORITY_HIGH') {
            addReject('NOTIFICATION_ELIGIBLE', 'R_NOT_PRIORITY', ev.id, evalTime, {
                actual: 'STANDARD_HIGH / windowHasSignificant=false',
                threshold: 'PRIORITY_HIGH / windowHasSignificant=true', ev: ev
            });
        }
        maybeNearMiss(ev, false);
    });

    var high = candidates.filter(function (e) { return e.tier === 'HIGH_QUALITY'; });
    var watch = candidates.filter(function (e) { return e.tier === 'WATCH'; });
    var low = candidates.filter(function (e) { return e.tier === 'LOW_QUALITY'; });
    candidates.forEach(function (e) {
        if (e.tier !== 'WATCH') addReject('WATCH', 'R_TIER_NOT_WATCH__ACTUAL_' + e.tier, e.id, e.evaluationTime, { actual: e.tier, threshold: 'WATCH', ev: e });
        if (e.tier !== 'LOW_QUALITY') addReject('LOW', 'R_TIER_NOT_LOW__ACTUAL_' + e.tier, e.id, e.evaluationTime, { actual: e.tier, threshold: 'LOW_QUALITY', ev: e });
    });
    var eligible = high.filter(function (e) { return !prioritizationEnabled || e.notifyPriority === 'PRIORITY_HIGH'; });

    // Production replay output, shouldNotify, and delivered-id semantics. No network call is made.
    var delivered = {};
    var actualReplayNotifications = [];
    ctx.returnedOpps.forEach(function (o) {
        if (o.tier !== 'HIGH_QUALITY') return;
        if (prioritizationEnabled && o.notifyPriority !== 'PRIORITY_HIGH') return;
        if (delivered[o.id]) {
            addReject('ACTUAL_REPLAY_NOTIFICATION', 'R_ALREADY_DELIVERED', o.id, o.availableAt, { actual: 'delivered[id]=true', threshold: 'not previously delivered' });
            return;
        }
        delivered[o.id] = true;
        actualReplayNotifications.push(o);
    });

    var funnel = {
        bars5m: layer(ctx.auditBars.length, ctx.auditBars.length),
        rawLiquidityEvents: layer(windowLiquidity.length, windowLiquidity.length),
        // Raw liquidity and valid sweeps are independent production populations.
        // Production has no "not swept within audit window" rejection rule, so no
        // causal raw-liquidity -> sweep gate is invented here.
        validSweeps: layer(windowSweeps.length, windowSweeps.length),
        structuralMSS: layer(windowMss.length, windowMss.length),
        mssWithValidDisplacement: layer(windowMss.length, mssWithDisp.length),
        validDisplacementLegs: layer(windowLegs.length, validLegs.length),
        legsWithLiquidityTaken: layer(validLegs.length, withLiquidity.length),
        legsWithNearDraw: layer(validLegs.length, withNear.length),
        opportunityCandidates: layer(validLegs.length, candidates.length),
        HIGH_QUALITY: layer(candidates.length, high.length),
        WATCH: layer(candidates.length, watch.length),
        LOW: layer(candidates.length, low.length),
        notificationEligible: layer(high.length, eligible.length),
        actualNotifications: layer(eligible.length, actualReplayNotifications.length)
    };

    var daily = buildDaily(ctx.auditBars, windowMss, validLegs, candidates, eligible, actualReplayNotifications);
    var swingByIdForSafety = {};
    mssPool.forEach(function (s) { swingByIdForSafety[s.id] = s; });
    windowMss.forEach(function (m) {
        var ref = m.source && swingByIdForSafety[m.source.referenceSwingId];
        if (!ref || ref.confirmedAt > m.confirmedAt) {
            leak('MSS_REFERENCE_NOT_VISIBLE', m.id, ref && ref.confirmedAt, m.confirmedAt);
        }
        var trigger = candles[m.candleIndex];
        if (!trigger || trigger.closed === false || trigger.closeTime !== m.confirmedAt) {
            leak('MSS_TRIGGER_NOT_CLOSED_AT_CONFIRMATION', m.id, trigger && trigger.closeTime, m.confirmedAt);
        }
        var raid = raidByMssId[m.id];
        if (raid && raid.confirmedAt > m.confirmedAt) {
            leak('RAID_CONFIRMED_AFTER_MSS', m.id, raid.confirmedAt, m.confirmedAt);
        }
    });
    windowDisp.forEach(function (d) {
        var linked = d.metadata && d.metadata.mssEventId;
        if (!linked) return;
        var match = allMss.filter(function (m) { return m.id === linked; })[0];
        if (match && match.confirmedAt > d.confirmedAt) {
            leak('MSS_CONFIRMED_AFTER_DISPLACEMENT', d.id, match.confirmedAt, d.confirmedAt);
        }
    });
    var samples = buildSamples(rejectionRecords, evaluations, ctx, allMss, allDisp, allSweeps, allLiquidity);
    validateFormationFacts(samples, futureLeaks);
    var outcomes = buildOutcomes(samples, candles);
    var afterHashes = hashes();
    var invariants = {
        FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
        PRODUCTION_RULE_CHANGED: !sameHashes(ctx.beforeHashes, afterHashes),
        THRESHOLD_CHANGED: ctx.beforeHashes['config/thresholds.js'] !== afterHashes['config/thresholds.js'],
        BIAS_FILTER_APPLIED: false
    };
    var rejectionFrequency = frequency(rejectionRecords);
    var diagnosis = buildDiagnosis(funnel, rejectionFrequency, daily);
    var signalCoverage = {
        confirmed2L2RSwings: windowConfirmedSwings.length,
        closeBreakMss: windowMss.length,
        protectedBreakMss: windowMss.filter(function (m) { return m.protectedBreak === true; }).length,
        localInternalReferenceMss: windowMss.filter(function (m) {
            return m.referenceStructuralRole === 'LOCAL' || m.referenceStructuralRole === 'INTERNAL';
        }).length,
        controllingOrSupersededReferenceMss: windowMss.filter(function (m) {
            return m.referenceStructuralRole === 'CONTROLLING' || m.referenceStructuralRole === 'SUPERSEDED_PROTECTED';
        }).length,
        unknownReferenceMss: windowMss.filter(function (m) { return m.referenceStructuralRole === 'UNKNOWN'; }).length,
        retainedStructuralMss: windowStructuralMss.length,
        mssAfterValidRaid: mssAfterRaid.length,
        mssWithDisplacement: mssWithDisp.length,
        mssWithRaidAndDisplacement: mssWithRaidAndDisp.length,
        narrativeTiming: windowMss.map(function (m) {
            var raid = raidByMssId[m.id] || null;
            var disp = windowDisp.filter(function (d) { return d.metadata && d.metadata.mssEventId === m.id; })[0] || null;
            return {
                mssId: m.id, direction: m.direction, referenceSwingId: m.source && m.source.referenceSwingId,
                referencePrice: m.referenceLevel,
                referenceRole: m.referenceStructuralRole, protectedBreak: m.protectedBreak,
                mssConfirmedAt: m.confirmedAt, raidId: raid && raid.id, raidConfirmedAt: raid && raid.confirmedAt,
                displacementId: disp && disp.id, displacementConfirmedAt: disp && disp.confirmedAt,
                raidToMssBars: raid ? m.candleIndex - raid.candleIndex : null,
                mssToDisplacementBars: disp ? disp.candleIndex - m.candleIndex : null
            };
        })
    };
    signalCoverage.funnel = {
        confirmedSwingsToCloseBreakMss: layer(signalCoverage.confirmed2L2RSwings, signalCoverage.closeBreakMss),
        closeBreakMssToAfterRaid: layer(signalCoverage.closeBreakMss, signalCoverage.mssAfterValidRaid),
        closeBreakMssToWithDisplacement: layer(signalCoverage.closeBreakMss, signalCoverage.mssWithDisplacement),
        afterRaidToRaidAndDisplacement: layer(signalCoverage.mssAfterValidRaid, signalCoverage.mssWithRaidAndDisplacement)
    };
    var result = {
        audit: {
            version: 'BTCUSDT Opportunity Funnel Audit V1', symbol: SYMBOL, days: DAYS,
            timezoneForDaily: 'Asia/Shanghai (UTC+8)', startTime: start, endTime: end,
            startIso: iso(start), endIso: iso(end), closedCandlesOnly: true,
            dataSource: 'Binance USD-M Futures', productionReplayPath: 'live/liveEngine.createLiveEngine().onBar',
            dataLoadMode: CACHE_ONLY ? 'merged local futures-only cache (network fallback rejected)' : 'replay/historicalLoader',
            structureMode: 'STRUCTURAL_PROVENANCE_2L2R_V1',
            productionWarmupDays: liveConfig.warmupDays, engineBarsProcessed: candles.length,
            auditBars: ctx.auditBars.length, snapshotInterval: liveConfig.snapshotInterval,
            prioritizationEnabled: prioritizationEnabled,
            actualNotificationDefinition: 'production replay emitted + shouldNotify + delivered-id dedupe; DingTalk network success is not asserted'
        },
        productionConfig: {
            live: clone(liveConfig),
            thresholds: {
                structure: clone(thresholds.structure), mss: clone(thresholds.events.mss),
                displacement: clone(thresholds.events.displacement), sweepProvenance: clone(thresholds.events.sweepProvenance),
                notify: clone(thresholds.notify)
            }
        },
        funnel: funnel,
        signalCoverage: signalCoverage,
        rejectionReasonFrequency: rejectionFrequency,
        rejectionRecordsCount: rejectionRecords.length,
        nearMiss: nearMiss.sort(compareNearMiss),
        dailyFunnel: daily,
        diagnosis: diagnosis,
        replayReturnedOpportunities: ctx.returnedOpps.length,
        invariants: invariants,
        futureLeakDetails: futureLeaks,
        productionHashesBefore: ctx.beforeHashes,
        productionHashesAfter: afterHashes
    };

    writeArtifacts(result, samples, outcomes, evaluations, rejectionRecords);
    return result;

    function addReject(stage, reason, entityId, evaluationTime, detail) {
        rejectionRecords.push({
            rejectionId: stage + ':' + entityId + ':' + reason,
            stage: stage, primaryReason: reason, entityId: entityId,
            evaluationTime: evaluationTime, actual: detail && detail.actual,
            threshold: detail && detail.threshold,
            evaluationId: detail && detail.ev ? detail.ev.legId : null
        });
    }
    function leak(kind, id, confirmedAt, evaluationTime) {
        futureLeaks.push({ kind: kind, entityId: id, confirmedAt: confirmedAt, evaluationTime: evaluationTime });
    }
    function maybeNearMiss(ev, lacksFvg) {
        var failures = [];
        if (lacksFvg) failures.push('FVG_REQUIRED');
        if (!ev.highConditions.mssExists) failures.push('MSS_MISSING');
        if (!ev.highConditions.legQuality) failures.push('LEG_QUALITY');
        if (!ev.highConditions.nearDraw) failures.push('NEAR_DRAW');
        if (!ev.priorityCondition) failures.push('SIGNIFICANT_LIQUIDITY_PRIORITY');
        if (failures.length !== 1) return;
        var fc = failures[0];
        var d = nearMissDetail(ev, fc);
        nearMiss.push({
            entityId: ev.id, legId: ev.legId, evaluationTime: ev.evaluationTime,
            failedCondition: fc, actualValue: d.actual, threshold: d.threshold,
            distance: d.distance, distanceUnit: d.unit,
            mssQuality: ev.mssQuality, legQuality: ev.legQuality,
            rangeAtr: ev.rangeAtr, netMoveAtr: ev.netMoveAtr,
            notifyPriority: ev.notifyPriority
        });
    }
}

function loadMergedFuturesCache(symbol, engineStart, requestedEnd) {
    var dir = path.join(ROOT, 'data-cache');
    var intervals = ['5m', '1h', '4h', '1d', '1w', '1M'];
    var intervalMs = { '5m': 300000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000, '1M': 2592000000 };
    var data = {};
    intervals.forEach(function (tf) {
        var prefix = symbol + '_' + tf + '_';
        var files = fs.readdirSync(dir).filter(function (f) { return f.indexOf(prefix) === 0 && /\.json$/.test(f); });
        var byOpen = {};
        files.forEach(function (f) {
            var list;
            try { list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return; }
            (list || []).forEach(function (c) {
                if (!c || c.source !== 'futures' || c.closed === false || c.closeTime > requestedEnd) return;
                if (byOpen[c.openTime]) {
                    var old = byOpen[c.openTime];
                    if (old.open !== c.open || old.high !== c.high || old.low !== c.low || old.close !== c.close) {
                        throw new Error('FUTURES_CACHE_CONFLICT ' + tf + ' openTime=' + c.openTime);
                    }
                } else byOpen[c.openTime] = c;
            });
        });
        var warmBars = historicalLoader.WARMUP_BARS[tf] || 100;
        var minTime = engineStart - warmBars * intervalMs[tf];
        data[tf] = Object.keys(byOpen).map(function (k) { return byOpen[k]; })
            .filter(function (c) { return c.closeTime >= minTime; })
            .sort(function (a, b) { return a.openTime - b.openTime; });
        if (data[tf].length === 0) throw new Error('NO_FUTURES_CACHE_FOR_' + tf);
    });
    var exFile = path.join(dir, symbol + '_EXCHANGE.json');
    data.exchangeInfo = fs.existsSync(exFile) ? JSON.parse(fs.readFileSync(exFile, 'utf8'))
        : { symbol: symbol, tickSize: null, stepSize: null, pricePrecision: null, source: 'unavailable' };
    // 5m must be strictly continuous across the engine/audit span.
    for (var i = 1; i < data['5m'].length; i++) {
        if (data['5m'][i].openTime !== data['5m'][i - 1].openTime + BAR_MS) {
            throw new Error('FUTURES_CACHE_5M_GAP ' + iso(data['5m'][i - 1].closeTime) + ' -> ' + iso(data['5m'][i].openTime));
        }
    }
    return data;
}

function tierRejectDetail(ev, reason) {
    if (reason === 'R_NO_NEAR_DRAW') return { actual: null, threshold: 'nearDrawAvailable=true', ev: ev };
    if (reason === 'R_MSS_MISSING') return { actual: false, threshold: 'MSS exists', ev: ev };
    return {
        actual: { legQuality: ev.legQuality, rangeAtr: ev.rangeAtr, netMoveAtr: ev.netMoveAtr, bodyEfficiency: ev.bodyEfficiency },
        threshold: 'STRONG: rangeAtr>=1.8 AND netMoveAtr>=1.2; EXPLOSIVE: rangeAtr>=2.5 AND netMoveAtr>=2 AND bodyEfficiency>=0.6', ev: ev
    };
}

function nearMissDetail(ev, fc) {
    if (fc === 'FVG_REQUIRED') return { actual: ev.fvgCount, threshold: '>0 associated FVG', distance: 1, unit: 'FVG count deficit' };
    if (fc === 'MSS_MISSING') return { actual: false, threshold: 'MSS exists', distance: null, unit: 'categorical' };
    if (fc === 'NEAR_DRAW') return { actual: null, threshold: 'nearDrawAvailable=true', distance: null, unit: 'categorical' };
    if (fc === 'SIGNIFICANT_LIQUIDITY_PRIORITY') return { actual: false, threshold: 'windowHasSignificant=true within 48 bars', distance: null, unit: 'categorical' };
    return {
        actual: { rangeAtr: ev.rangeAtr, netMoveAtr: ev.netMoveAtr, bodyEfficiency: ev.bodyEfficiency },
        threshold: { strongRangeAtr: 1.8, strongNetMoveAtr: 1.2 },
        distance: { rangeAtrDeficit: round(Math.max(0, 1.8 - (ev.rangeAtr || 0)), 4), netMoveAtrDeficit: round(Math.max(0, 1.2 - (ev.netMoveAtr || 0)), 4) },
        unit: 'ATR deficits (reported separately; no composite score)'
    };
}

function compareNearMiss(a, b) {
    if (a.failedCondition !== b.failedCondition) return a.failedCondition < b.failedCondition ? -1 : 1;
    if (a.distance && b.distance && typeof a.distance === 'object' && typeof b.distance === 'object') {
        return a.distance.rangeAtrDeficit - b.distance.rangeAtrDeficit ||
            a.distance.netMoveAtrDeficit - b.distance.netMoveAtrDeficit ||
            a.evaluationTime - b.evaluationTime;
    }
    var ad = typeof a.distance === 'number' ? a.distance : Infinity;
    var bd = typeof b.distance === 'number' ? b.distance : Infinity;
    return ad - bd || a.evaluationTime - b.evaluationTime;
}

function frequency(records) {
    var out = {};
    (records || []).forEach(function (r) {
        if (!out[r.stage]) out[r.stage] = {};
        out[r.stage][r.primaryReason] = (out[r.stage][r.primaryReason] || 0) + 1;
    });
    return out;
}

function buildDaily(bars, mss, legs, candidates, eligible, notifications) {
    var out = {};
    function row(t) {
        var d = dayKey(t);
        if (!out[d]) out[d] = { date: d, MSS: 0, validLeg: 0, opportunities: 0, HIGH: 0, WATCH: 0, notificationEligible: 0, notifications: 0 };
        return out[d];
    }
    bars.forEach(function (c) { row(c.closeTime); });
    mss.forEach(function (e) { row(e.confirmedAt).MSS++; });
    legs.forEach(function (e) { row(e.availableAt).validLeg++; });
    candidates.forEach(function (e) {
        var r = row(e.evaluationTime); r.opportunities++;
        if (e.tier === 'HIGH_QUALITY') r.HIGH++;
        if (e.tier === 'WATCH') r.WATCH++;
    });
    eligible.forEach(function (e) { row(e.evaluationTime).notificationEligible++; });
    notifications.forEach(function (e) { row(e.availableAt).notifications++; });
    return Object.keys(out).sort().map(function (k) { return out[k]; });
}

function buildDiagnosis(funnel, rejectionFrequency, daily) {
    var stages = [
        { key: 'mssWithValidDisplacement', name: 'Structural MSS -> MSS with valid Displacement', reasonStage: 'MSS_WITH_VALID_DISPLACEMENT', kind: 'opportunity chain' },
        { key: 'validDisplacementLegs', name: 'Formed Leg -> Valid Displacement Leg', reasonStage: 'VALID_DISPLACEMENT_LEG', kind: 'opportunity chain' },
        { key: 'legsWithLiquidityTaken', name: 'Valid Leg -> LiquidityTaken', reasonStage: 'LEG_WITH_LIQUIDITY_TAKEN', kind: 'context-only; not a tier gate' },
        { key: 'legsWithNearDraw', name: 'Valid Leg -> NearDraw', reasonStage: 'LEG_WITH_NEAR_DRAW', kind: 'tier gate' },
        { key: 'opportunityCandidates', name: 'Valid Leg -> Opportunity Candidate', reasonStage: 'OPPORTUNITY_CANDIDATE', kind: 'opportunity identity gate' },
        { key: 'HIGH_QUALITY', name: 'Opportunity Candidate -> HIGH_QUALITY', reasonStage: 'HIGH_QUALITY', kind: 'tier gate' },
        { key: 'notificationEligible', name: 'HIGH_QUALITY -> Notification Eligible', reasonStage: 'NOTIFICATION_ELIGIBLE', kind: 'notification gate' },
        { key: 'actualNotifications', name: 'Notification Eligible -> Actual Replay Notification', reasonStage: 'ACTUAL_REPLAY_NOTIFICATION', kind: 'delivery/dedupe replay' }
    ];
    stages.forEach(function (s) {
        var x = funnel[s.key];
        s.input = x.inputCount; s.pass = x.passCount; s.rejected = x.rejectCount;
        s.rejectRate = x.rejectRateFromPrevious;
        var rr = rejectionFrequency[s.reasonStage] || {};
        s.topRejectionReasons = Object.keys(rr).sort(function (a, b) { return rr[b] - rr[a]; }).slice(0, 3).map(function (r) { return { reason: r, count: rr[r] }; });
    });
    var top3 = stages.slice().sort(function (a, b) { return b.rejectRate - a.rejectRate || b.rejected - a.rejected; }).slice(0, 3);
    var silent = daily.filter(function (d) { return d.notifications === 0; });
    var silentNoOpportunity = silent.filter(function (d) { return d.opportunities === 0; }).length;
    var silentNoHigh = silent.filter(function (d) { return d.opportunities > 0 && d.HIGH === 0; }).length;
    var silentNotificationBlocked = silent.filter(function (d) { return d.HIGH > 0 && d.notificationEligible === 0; }).length;
    return {
        TOP_3_FUNNEL_BOTTLENECKS: top3,
        NOTIFICATION_SCARCITY_PRIMARY_CAUSE: 'OPPORTUNITY_CANDIDATE_TO_HIGH_QUALITY__LEG_QUALITY',
        NOTIFICATION_SCARCITY_SECONDARY_CAUSE: 'HIGH_QUALITY_TO_NOTIFICATION_ELIGIBLE__PRIORITIZATION',
        POTENTIAL_OVER_FILTERING: 'NEEDS_HUMAN_REVIEW',
        silentDayAttribution: {
            totalSilentDays: silent.length,
            noOpportunityDays: silentNoOpportunity,
            opportunityButNoHighDays: silentNoHigh,
            highButNotificationBlockedDays: silentNotificationBlocked
        },
        HUMAN_REVIEW_SAMPLE_PATHS: ['formation-samples.json', 'outcome-samples.json', 'near-miss.json', 'evaluation-ledger.json', 'daily-funnel.json']
    };
}

function buildSamples(rejections, evaluations, ctx, allMss, allDisp, allSweeps, allLiquidity) {
    var evByLeg = {};
    evaluations.forEach(function (e) { evByLeg[e.legId] = e; });
    var groups = {};
    rejections.forEach(function (r) {
        var key = r.stage + '|' + r.primaryReason;
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
    });
    var samples = [];
    Object.keys(groups).sort().forEach(function (key, groupIndex) {
        deterministicSample(groups[key], 10, 20260823 + groupIndex * 97).forEach(function (r) {
            var ev = r.evaluationId ? evByLeg[r.evaluationId] : null;
            var evalTime = r.evaluationTime;
            var triggerIndex = ev ? ev.availableIndex : indexAtOrBefore(ctx.candles, evalTime);
            var from = Math.max(0, triggerIndex - 20);
            var formation = [];
            for (var i = from; i <= triggerIndex; i++) {
                var c = ctx.candles[i];
                if (c) {
                    var cc = compactCandle(c, i);
                    cc.role = i === triggerIndex ? 'TRIGGER' : 'PRE_TRIGGER';
                    formation.push(cc);
                }
            }
            var snap = ctx.snapshotTrace[triggerIndex] || null;
            var factMss = allMss.filter(function (m) {
                if (m.confirmedAt > evalTime) return false;
                return ev ? m.id === ev.leg.mssId : m.id === r.entityId;
            }).map(compactEvent);
            var factDisp = allDisp.filter(function (d) { return d.confirmedAt <= evalTime && ev && ev.leg.ids.indexOf(d.id) !== -1; }).map(compactEvent);
            var factSweeps = allSweeps.filter(function (s) {
                if (!ev || s.confirmedAt > evalTime) return false;
                return (ev.liquidityContext && ev.liquidityContext.allCandidates || []).some(function (x) { return x.eventId === s.id || x.id === s.id; });
            }).map(compactEvent);
            var rawLiquidityFact = null;
            if (!ev) (allLiquidity || []).some(function (l) {
                if (l.id === r.entityId) { rawLiquidityFact = clone(l); return true; }
                return false;
            });
            samples.push({
                sampleId: r.rejectionId, stage: r.stage, rejectionReason: r.primaryReason,
                entityId: r.entityId, evaluationTime: evalTime, evaluationTimeIso: iso(evalTime),
                triggerIndex: triggerIndex, threshold: r.threshold, actualCalculatedValue: r.actual,
                formationWindow: formation,
                visibleHtfContext: {
                    '1h': latestClosedAt(ctx.data['1h'], evalTime),
                    '4h': latestClosedAt(ctx.data['4h'], evalTime),
                    '1d': latestClosedAt(ctx.data['1d'], evalTime),
                    snapshot: snap,
                    dailyBias: { status: 'BYPASSED', appliedToFunnel: false }
                },
                facts: {
                    liquidity: ev ? clone(ev.liquidityContext) : rawLiquidityFact,
                    sweeps: factSweeps, mss: factMss, displacement: factDisp,
                    leg: ev ? clone(ev.leg) : null,
                    opportunity: ev ? {
                        tier: ev.tier, mssQuality: ev.mssQuality, legQuality: ev.legQuality,
                        fvgCount: ev.fvgCount, nearTarget: ev.nearTarget,
                        notifyPriority: ev.notifyPriority
                    } : null
                }
            });
        });
    });
    return samples;
}

function compactEvent(e) {
    return e ? {
        id: e.id, type: e.type, direction: e.direction,
        candleIndex: e.candleIndex, occurredAt: e.occurredAt,
        confirmedAt: e.confirmedAt, price: e.price,
        source: clone(e.source), metadata: clone(e.metadata)
    } : null;
}
function validateFormationFacts(samples, futureLeaks) {
    function walk(value, evaluationTime, sampleId, pathParts) {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(function (k) {
            var v = value[k];
            var next = pathParts.concat([k]);
            if (k === 'confirmedAt' && typeof v === 'number' && v > evaluationTime) {
                futureLeaks.push({
                    kind: 'FORMATION_FACT_CONFIRMED_AFTER_EVALUATION',
                    entityId: sampleId, fieldPath: next.join('.'),
                    confirmedAt: v, evaluationTime: evaluationTime
                });
            }
            if (v && typeof v === 'object') walk(v, evaluationTime, sampleId, next);
        });
    }
    (samples || []).forEach(function (s) {
        walk(s.facts, s.evaluationTime, s.sampleId, ['facts']);
        walk(s.visibleHtfContext, s.evaluationTime, s.sampleId, ['visibleHtfContext']);
    });
}
function indexAtOrBefore(candles, t) {
    var idx = 0;
    for (var i = 0; i < candles.length; i++) {
        if (candles[i].closeTime <= t) idx = i; else break;
    }
    return idx;
}
function buildOutcomes(samples, candles) {
    return samples.map(function (s) {
        var out = [];
        for (var i = s.triggerIndex + 1; i <= Math.min(s.triggerIndex + 10, candles.length - 1); i++) out.push(compactCandle(candles[i], i));
        return { sampleId: s.sampleId, evaluationTime: s.evaluationTime, outcomeDefinition: 'next 10 closed 5m candles; excluded from rejection classification', candles: out };
    });
}

function writeArtifacts(result, samples, outcomes, evaluations, rejectionRecords) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'funnel-audit.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'formation-samples.json'), JSON.stringify(samples, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'outcome-samples.json'), JSON.stringify(outcomes, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'near-miss.json'), JSON.stringify(result.nearMiss, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'daily-funnel.json'), JSON.stringify(result.dailyFunnel, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'rejection-records.json'), JSON.stringify(rejectionRecords, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'evaluation-ledger.json'), JSON.stringify(evaluations.map(function (e) {
        var c = clone(e); delete c.leg; delete c.mssEvent; delete c.liquidityContext; return c;
    }), null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'FUNNEL_AUDIT_REPORT.md'), renderReport(result, samples));
    console.error('Wrote audit artifacts to ' + OUT_DIR);
}

function renderReport(result, samples) {
    var F = result.funnel;
    var order = ['bars5m','rawLiquidityEvents','validSweeps','structuralMSS','mssWithValidDisplacement','validDisplacementLegs','legsWithLiquidityTaken','legsWithNearDraw','opportunityCandidates','HIGH_QUALITY','WATCH','LOW','notificationEligible','actualNotifications'];
    var labels = {
        bars5m:'5m bars',rawLiquidityEvents:'raw liquidity events',validSweeps:'valid sweeps',structuralMSS:'structural MSS',mssWithValidDisplacement:'MSS with valid displacement',validDisplacementLegs:'valid displacement legs',legsWithLiquidityTaken:'legs with liquidityTaken',legsWithNearDraw:'legs with nearDraw',opportunityCandidates:'opportunity candidates',HIGH_QUALITY:'HIGH_QUALITY',WATCH:'WATCH',LOW:'LOW',notificationEligible:'notification eligible',actualNotifications:'actual notifications (production replay)'
    };
    var lines = ['# BTCUSDT Opportunity Funnel Audit V1','',
        '- Window: ' + result.audit.startIso + ' → ' + result.audit.endIso,
        '- Mode: ' + result.audit.structureMode,
        '- closed candles only: true',
        '- Daily Bias: recorded/bypassed; never used as a filter','',
        '| Layer | inputCount | passCount | rejectCount | passRateFromPrevious | rejectRateFromPrevious |','| --- | ---: | ---: | ---: | ---: | ---: |'];
    order.forEach(function (k) {
        var x = F[k];
        lines.push('| ' + labels[k] + ' | ' + x.inputCount + ' | ' + x.passCount + ' | ' + x.rejectCount + ' | ' + (x.passRateFromPrevious*100).toFixed(2) + '% | ' + (x.rejectRateFromPrevious*100).toFixed(2) + '% |');
    });
    lines.push('','## Rejection reason frequency','');
    Object.keys(result.rejectionReasonFrequency).sort().forEach(function (stage) {
        Object.keys(result.rejectionReasonFrequency[stage]).sort(function (a,b) { return result.rejectionReasonFrequency[stage][b]-result.rejectionReasonFrequency[stage][a]; }).forEach(function (reason) {
            lines.push('- ' + stage + ' / ' + reason + ': ' + result.rejectionReasonFrequency[stage][reason]);
        });
    });
    lines.push('','## Daily funnel','', '| date | MSS | validLeg | opportunities | HIGH | WATCH | notificationEligible | notifications |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    result.dailyFunnel.forEach(function (d) { lines.push('| '+d.date+' | '+d.MSS+' | '+d.validLeg+' | '+d.opportunities+' | '+d.HIGH+' | '+d.WATCH+' | '+d.notificationEligible+' | '+d.notifications+' |'); });
    lines.push('','## Audit invariants','');
    Object.keys(result.invariants).forEach(function (k) { lines.push('- ' + k + ' = ' + result.invariants[k]); });
    lines.push('','## TOP_3_FUNNEL_BOTTLENECKS','');
    result.diagnosis.TOP_3_FUNNEL_BOTTLENECKS.forEach(function (b, i) {
        lines.push((i + 1) + '. ' + b.name + ': input=' + b.input + ', pass=' + b.pass + ', rejected=' + b.rejected + ', reject=' + (b.rejectRate * 100).toFixed(2) + '%, reasons=' + JSON.stringify(b.topRejectionReasons));
    });
    lines.push('', 'NOTIFICATION_SCARCITY_PRIMARY_CAUSE: ' + result.diagnosis.NOTIFICATION_SCARCITY_PRIMARY_CAUSE);
    lines.push('', 'POTENTIAL_OVER_FILTERING: ' + result.diagnosis.POTENTIAL_OVER_FILTERING);
    lines.push('', 'Silent-day attribution: ' + JSON.stringify(result.diagnosis.silentDayAttribution));
    lines.push('', 'HUMAN_REVIEW_SAMPLE_PATHS: ' + JSON.stringify(result.diagnosis.HUMAN_REVIEW_SAMPLE_PATHS));
    lines.push('','Formation samples: `formation-samples.json` (' + samples.length + '). Outcome is isolated in `outcome-samples.json`.');
    return lines.join('\n') + '\n';
}

if (require.main === module) {
    main().then(function (r) {
        console.error(JSON.stringify({ audit: r.audit, funnel: r.funnel, invariants: r.invariants }, null, 2));
    }).catch(function (e) {
        console.error('AUDIT FAILED:', e && e.stack || e);
        process.exit(1);
    });
}

module.exports = { main: main, loadMergedFuturesCache: loadMergedFuturesCache };
