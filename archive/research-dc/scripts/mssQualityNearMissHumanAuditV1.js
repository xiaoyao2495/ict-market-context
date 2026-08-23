/**
 * MSS Quality Near-Miss Human Audit V1
 *
 * Diagnostic-only. Replays the exact BTCUSDT Opportunity Funnel Audit V1
 * window and creates formation-only review records for the closest current
 * production MSS-quality failures. Outcome is written separately.
 *
 * Usage:
 *   ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/mssQualityNearMissHumanAuditV1.js [funnel-dir] [out-dir]
 */
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var funnelAudit = require('./opportunityFunnelAuditV1');
var liveEngineMod = require('../live/liveEngine');
var displacementLeg = require('../stats/displacementLeg');
var mssReference = require('../stats/mssReference');
var opportunityQuality = require('../stats/opportunityQuality');
var liquidityProvenance = require('../stats/liquidityProvenance');
var thresholds = require('../config/thresholds');
var liveConfig = require('../config/live.json');

var ROOT = path.join(__dirname, '..');
var FUNNEL_DIR = process.argv[2] || '.audit-opportunity-funnel-v1-btcusdt-dc-20260823';
var OUT_DIR = process.argv[3] || '.audit-mss-quality-near-miss-human-v1-btcusdt-20260823';
var BAR_MS = 300000;
var DAY_MS = 86400000;
var OPPOSING_WINDOW_BARS = 24;
var BREAK_PCT_THRESHOLD = 0.0008;
var BODY_RATIO_THRESHOLD = 0.5;
var REVIEW_N = 20;

var PRODUCTION_FILES = [
    'config/thresholds.js', 'config/live.json', 'live/liveEngine.js',
    'replay/replayState.js', 'replay/replayEngine.js',
    'events/mssDetector.js', 'events/displacementDetector.js',
    'stats/mssReference.js', 'stats/displacementLeg.js',
    'stats/opportunityQuality.js', 'stats/liquidityProvenance.js',
    'stats/alertPrioritization.js', 'structure/dcStructuralSwing.js'
];

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
}
function hashes() {
    var out = {};
    PRODUCTION_FILES.forEach(function (f) { out[f] = sha(f); });
    return out;
}
function hashesEqual(a, b) {
    return PRODUCTION_FILES.every(function (f) { return a[f] === b[f]; });
}
function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function iso(ms) { return ms === null || ms === undefined ? null : new Date(ms).toISOString(); }
function isoCn(ms) { return ms === null || ms === undefined ? null : new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC+8'; }
function round(n, places) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    var p = Math.pow(10, places || 6);
    return Math.round(n * p) / p;
}
function compactCandle(c, index, role) {
    return c ? {
        index: index, role: role || null,
        openTime: c.openTime, closeTime: c.closeTime,
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.volume, closed: c.closed, source: c.source
    } : null;
}
function compactEvent(e) {
    return e ? {
        id: e.id, type: e.type, direction: e.direction,
        candleIndex: e.candleIndex, occurredAt: e.occurredAt,
        confirmedAt: e.confirmedAt, price: e.price,
        source: clone(e.source), metadata: clone(e.metadata)
    } : null;
}
function uniqueLegs(index) {
    var seen = {};
    var out = [];
    Object.keys(index || {}).forEach(function (id) {
        var leg = index[id];
        var key = leg.ids.join('|');
        if (!seen[key]) { seen[key] = true; out.push(leg); }
    });
    return out;
}

function main() {
    var before = hashes();
    var funnel = JSON.parse(fs.readFileSync(path.join(FUNNEL_DIR, 'funnel-audit.json'), 'utf8'));
    var nearMiss = JSON.parse(fs.readFileSync(path.join(FUNNEL_DIR, 'near-miss.json'), 'utf8'))
        .filter(function (x) { return x.failedCondition === 'MSS_QUALITY'; });
    if (nearMiss.length !== 185) throw new Error('EXPECTED_185_MSS_QUALITY_NEAR_MISS_GOT_' + nearMiss.length);
    if (!thresholds.structure || !thresholds.structure.useDcStructuralSwing) {
        throw new Error('PRODUCTION_MODE_MISMATCH: run with ARCHIVED_DIRECTIONAL_CHANGE=1');
    }
    var symbol = funnel.audit.symbol;
    var auditStart = funnel.audit.startTime;
    var auditEnd = funnel.audit.endTime;
    var engineStart = auditStart - (liveConfig.warmupDays || 30) * DAY_MS;
    var data = funnelAudit.loadMergedFuturesCache(symbol, engineStart, auditEnd);
    var candles = data['5m'].filter(function (c) {
        return c.closed !== false && c.closeTime >= engineStart && c.closeTime <= auditEnd;
    });
    assertContinuity(candles);

    var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
    var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var engine = liveEngineMod.createLiveEngine({
        symbol: symbol, exchangeInfo: data.exchangeInfo,
        structureCandles: structureCandles, calendarCandles: calendarCandles,
        fetcher: function (sym, tf) { return Promise.resolve(calendarCandles[tf] || []); },
        thresholds: thresholds
    }, {
        snapshotInterval: liveConfig.snapshotInterval,
        baseIndex: 0,
        dailyBiasProvider: function () {
            return { status: 'BYPASSED', bias: 'UNKNOWN', confidence: null };
        }
    });

    var chain = Promise.resolve();
    candles.forEach(function (c, i) {
        chain = chain.then(function () { return engine.onBar(c, i); });
    });
    return chain.then(function () {
        return analyze({
            before: before, funnel: funnel, nearMiss: nearMiss,
            symbol: symbol, auditStart: auditStart, auditEnd: auditEnd,
            data: data, candles: candles, state: engine.getState()
        });
    });
}

function assertContinuity(candles) {
    for (var i = 1; i < candles.length; i++) {
        if (candles[i].openTime !== candles[i - 1].openTime + BAR_MS) {
            throw new Error('5M_CONTINUITY_FAILURE ' + iso(candles[i - 1].closeTime) + ' -> ' + iso(candles[i].openTime));
        }
    }
}

function analyze(ctx) {
    var state = ctx.state;
    var allMss = state.eventRegistry.getByType(ctx.symbol, 'MSS');
    var allDisp = state.eventRegistry.getByType(ctx.symbol, 'DISPLACEMENT');
    var allSweeps = state.eventRegistry.getByType(ctx.symbol, 'LIQUIDITY_SWEEP');
    var mssPool = state.dcRefPool;
    var mssById = {};
    var refById = {};
    allMss.forEach(function (m) { mssById[m.id] = m; });
    mssPool.forEach(function (r) { refById[r.id] = r; });
    var legIndex = displacementLeg.buildWindowedLegIndex(allDisp, ctx.candles, allMss, mssPool, 900000);
    var legById = {};
    uniqueLegs(legIndex).forEach(function (l) { legById['LEG:' + l.ids[0]] = l; });

    var analyses = [];
    ctx.nearMiss.forEach(function (nm) {
        var leg = legById[nm.legId];
        if (!leg) throw new Error('NEAR_MISS_LEG_NOT_FOUND ' + nm.legId);
        var mss = leg.mssId ? mssById[leg.mssId] : null;
        var ref = mss && mss.source ? refById[mss.source.referenceSwingId] : null;
        var cls = mss ? mssReference.classifyMssReference(mss, mssPool) : { quality: 'NO_MSS', dims: {} };
        var components = qualityComponents(mss, ref, cls);
        var availableIndex = leg.availableIndex;
        var anchorIndex = leg.lastIndex;
        var dt = state.drawTrace && state.drawTrace[anchorIndex];
        var nearTarget = dt ? (leg.direction === 'BULLISH' ? dt.bslNear : dt.sslNear) : null;
        var tier = opportunityQuality.classifyOpportunityTier({
            mssQuality: cls.quality === 'NO_REFERENCE' ? 'NO_MSS' : cls.quality,
            legQuality: displacementLeg.classifyLegQuality(leg),
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });
        var prov = liquidityProvenance.associateSweeps({
            direction: leg.direction, leg: leg, availableAt: leg.availableAt,
            sweepEvents: allSweeps, maxLookbackBars: null
        });
        analyses.push({
            nearMiss: nm, leg: leg, mss: mss, ref: ref, cls: cls,
            components: components, tier: tier, nearTarget: nearTarget,
            liquidityContext: prov, availableIndex: availableIndex,
            completeOutcome: availableIndex + 10 < ctx.candles.length
        });
    });

    var frequency = componentFrequency(analyses);
    var ordered = partialOrder(analyses.filter(function (a) { return a.completeOutcome; }));
    var selected = selectIndependent(ordered, REVIEW_N);
    if (selected.length !== REVIEW_N) throw new Error('INDEPENDENT_REVIEW_SAMPLE_SHORTFALL ' + selected.length);
    var futureLeaks = [];
    var records = selected.map(function (a, i) { return buildRecord(a, i + 1, ctx, allDisp, allSweeps, futureLeaks); });
    var outcomes = selected.map(function (a, i) { return buildOutcome(a, i + 1, ctx.candles); });
    var after = hashes();
    var result = {
        audit: {
            version: 'MSS Quality Near-Miss Human Audit V1',
            sourceFunnel: path.resolve(FUNNEL_DIR, 'funnel-audit.json'),
            symbol: ctx.symbol, startTime: ctx.auditStart, endTime: ctx.auditEnd,
            startIso: iso(ctx.auditStart), endIso: iso(ctx.auditEnd),
            productionMode: 'DC_ATR_1_5_CLOSE', closedCandlesOnly: true,
            sourceNearMissCount: analyses.length, selectedIndependentSamples: records.length,
            orderingMethod: 'partial order only: fewer failed production components; current production quality category; within identical failure signature use native threshold deltas. No composite score.',
            outcomeExcludedFromFormationReview: true,
            dailyBiasFilterApplied: false
        },
        productionMssQualityDefinition: {
            highEligibleQuality: ['PROTECTED_SWING', 'HTF_RELEVANT'],
            protectedPath: 'wasLatestOpposingSwing && strongBreak',
            htfPath: 'wasLatestOpposingSwing && isRecentExtreme && strongBreak',
            wasLatestOpposingSwingThreshold: 'reference index in [mssIndex-24, mssIndex)',
            strongBreakThresholds: { breakPct: BREAK_PCT_THRESHOLD, breakBodyRatio: BODY_RATIO_THRESHOLD },
            isRecentExtremeWindowBars: mssReference.HTF_WINDOW_BARS,
            note: 'isRecentExtreme upgrades PROTECTED_SWING to HTF_RELEVANT; it is not additionally required for HIGH.'
        },
        failureComponentFrequency: frequency,
        selectedOrder: selected.map(function (a, i) {
            return {
                reviewId: 'MSS-HR-' + String(i + 1).padStart(2, '0'),
                legId: a.nearMiss.legId, mssEventId: a.mss ? a.mss.id : null,
                currentQuality: a.cls.quality, primaryFailureReason: a.components.primaryFailureReason,
                failedCoreComponents: a.components.failedCoreComponents,
                nativeThresholdDeltas: a.components.nativeThresholdDeltas
            };
        }),
        invariants: {
            PRODUCTION_CHANGED: !hashesEqual(ctx.before, after),
            FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
            THRESHOLD_CHANGED: ctx.before['config/thresholds.js'] !== after['config/thresholds.js'],
            DAILY_BIAS_FILTER_APPLIED: false,
            UNIQUE_MARKET_LEGS: uniqueCount(selected.map(function (a) { return a.nearMiss.legId; })) === selected.length,
            UNIQUE_MSS_EVENTS: uniqueNonNull(selected.map(function (a) { return a.mss ? a.mss.id : null; }))
        },
        futureLeakDetails: futureLeaks,
        humanReviewRecordPath: path.resolve(OUT_DIR, 'human-review-records.json'),
        outcomePath: path.resolve(OUT_DIR, 'outcomes-hidden-from-formation-review.json')
    };
    writeArtifacts(result, records, outcomes, analyses);
    return result;
}

function qualityComponents(mss, ref, cls) {
    var d = cls.dims || {};
    var referencePresent = !!(mss && ref);
    var latest = referencePresent ? !!d.wasLatestOpposingSwing : null;
    var breakPctPass = referencePresent && d.breakPct !== null ? d.breakPct >= BREAK_PCT_THRESHOLD : null;
    var bodyPass = referencePresent && d.breakBodyRatio !== null ? d.breakBodyRatio >= BODY_RATIO_THRESHOLD : null;
    var strong = referencePresent ? !!(breakPctPass && bodyPass) : null;
    var failed = [];
    if (!referencePresent) failed.push('REFERENCE_PRESENT');
    else {
        if (!latest) failed.push('WAS_LATEST_OPPOSING_SWING');
        if (!strong) failed.push('STRONG_BREAK');
    }
    var primary;
    if (!referencePresent) primary = mss ? 'REFERENCE_NOT_FOUND_IN_PRODUCTION_POOL' : 'NO_MSS_LINKED_TO_LEG';
    else if (!latest && !strong) primary = 'LATEST_OPPOSING_AND_STRONG_BREAK_FAILED';
    else if (!latest) primary = 'REFERENCE_OUTSIDE_24_BAR_OPPOSING_WINDOW';
    else if (!strong) primary = !breakPctPass && !bodyPass ? 'BREAK_PCT_AND_BODY_RATIO_BELOW_THRESHOLD'
        : (!breakPctPass ? 'BREAK_PCT_BELOW_THRESHOLD' : 'BREAK_BODY_RATIO_BELOW_THRESHOLD');
    else primary = 'NONE';
    return {
        failedCoreComponents: failed,
        primaryFailureReason: primary,
        failureSignature: failed.join('+') || 'NONE',
        nativeThresholdDeltas: {
            opposingWindowExcessBars: referencePresent && d.referenceAgeBars !== null ? Math.max(0, d.referenceAgeBars - OPPOSING_WINDOW_BARS) : null,
            breakPctDeficit: referencePresent && d.breakPct !== null ? round(Math.max(0, BREAK_PCT_THRESHOLD - d.breakPct), 8) : null,
            breakBodyRatioDeficit: referencePresent && d.breakBodyRatio !== null ? round(Math.max(0, BODY_RATIO_THRESHOLD - d.breakBodyRatio), 6) : null
        },
        conditions: [
            condition('referencePresent', referencePresent, true, referencePresent, true),
            condition('wasLatestOpposingSwing', latest, 'reference index in [mssIndex-24, mssIndex)', latest, true),
            condition('breakPct', d.breakPct !== undefined ? d.breakPct : null, BREAK_PCT_THRESHOLD, breakPctPass, true),
            condition('breakBodyRatio', d.breakBodyRatio !== undefined ? d.breakBodyRatio : null, BODY_RATIO_THRESHOLD, bodyPass, true),
            condition('strongBreak', strong, 'breakPct && breakBodyRatio pass', strong, true),
            condition('isRecentExtreme', d.isRecentExtreme !== undefined ? d.isRecentExtreme : null, true, d.isRecentExtreme === true, false, 'Only HTF_RELEVANT upgrade; not additionally required for HIGH'),
            condition('didReferenceCreateLastImpulse', d.didReferenceCreateLastImpulse !== undefined ? d.didReferenceCreateLastImpulse : null, true, d.didReferenceCreateLastImpulse === true, false, 'Exposed dimension; not used by current quality classification'),
            condition('referenceAgeBars', d.referenceAgeBars !== undefined ? d.referenceAgeBars : null, '<=24 for wasLatestOpposingSwing; <=6 for lastImpulse diagnostic', referencePresent ? d.referenceAgeBars <= 24 : null, true),
            condition('referenceTimeframe', d.referenceTimeframe || null, 'diagnostic field', null, false),
            condition('referenceType', d.referenceType || null, 'diagnostic field', null, false),
            condition('breakDistance', d.breakDistance !== undefined ? d.breakDistance : null, 'diagnostic field', null, false),
            condition('breakAtr', d.breakAtr !== undefined ? d.breakAtr : null, 'currently null/unused', null, false),
            condition('displacementScore', d.displacementScore !== undefined ? d.displacementScore : null, 'currently null/unused', null, false)
        ]
    };
}

function condition(name, actual, threshold, pass, gatesProtected, note) {
    return { name: name, actualValue: actual, threshold: threshold, pass: pass, gatesProtectedSwing: !!gatesProtected, note: note || null };
}

function componentFrequency(list) {
    var out = {
        total: list.length,
        currentQuality: {}, primaryFailureReason: {},
        components: {
            REFERENCE_PRESENT: { fail: 0, notEvaluable: 0 },
            WAS_LATEST_OPPOSING_SWING: { fail: 0, notEvaluable: 0 },
            STRONG_BREAK: { fail: 0, notEvaluable: 0 },
            BREAK_PCT: { fail: 0, notEvaluable: 0 },
            BREAK_BODY_RATIO: { fail: 0, notEvaluable: 0 },
            IS_RECENT_EXTREME: { fail: 0, notEvaluable: 0, classificationRole: 'HTF upgrade only' },
            DID_REFERENCE_CREATE_LAST_IMPULSE: { fail: 0, notEvaluable: 0, classificationRole: 'diagnostic only; unused' }
        }
    };
    list.forEach(function (a) {
        var q = a.cls.quality;
        out.currentQuality[q] = (out.currentQuality[q] || 0) + 1;
        var p = a.components.primaryFailureReason;
        out.primaryFailureReason[p] = (out.primaryFailureReason[p] || 0) + 1;
        var d = a.cls.dims || {};
        if (!a.ref || !a.mss) {
            out.components.REFERENCE_PRESENT.fail++;
            ['WAS_LATEST_OPPOSING_SWING','STRONG_BREAK','BREAK_PCT','BREAK_BODY_RATIO','IS_RECENT_EXTREME','DID_REFERENCE_CREATE_LAST_IMPULSE'].forEach(function (k) { out.components[k].notEvaluable++; });
            return;
        }
        if (!d.wasLatestOpposingSwing) out.components.WAS_LATEST_OPPOSING_SWING.fail++;
        var bp = d.breakPct !== null && d.breakPct >= BREAK_PCT_THRESHOLD;
        var br = d.breakBodyRatio !== null && d.breakBodyRatio >= BODY_RATIO_THRESHOLD;
        if (!bp) out.components.BREAK_PCT.fail++;
        if (!br) out.components.BREAK_BODY_RATIO.fail++;
        if (!(bp && br)) out.components.STRONG_BREAK.fail++;
        if (!d.isRecentExtreme) out.components.IS_RECENT_EXTREME.fail++;
        if (!d.didReferenceCreateLastImpulse) out.components.DID_REFERENCE_CREATE_LAST_IMPULSE.fail++;
    });
    Object.keys(out.components).forEach(function (k) {
        out.components[k].failRateOf185 = out.components[k].fail / out.total;
        out.components[k].evaluableCount = out.total - out.components[k].notEvaluable;
        out.components[k].failRateOfEvaluable = out.components[k].evaluableCount > 0 ? out.components[k].fail / out.components[k].evaluableCount : null;
    });
    return out;
}

function partialOrder(list) {
    var qualityRank = { INTERNAL: 0, MICRO_INTERNAL: 1, NO_REFERENCE: 2, NO_MSS: 3 };
    var signatureRank = {
        WAS_LATEST_OPPOSING_SWING: 0,
        STRONG_BREAK: 1,
        'WAS_LATEST_OPPOSING_SWING+STRONG_BREAK': 2,
        REFERENCE_PRESENT: 3
    };
    return list.slice().sort(function (a, b) {
        var ac = a.components.failedCoreComponents.length;
        var bc = b.components.failedCoreComponents.length;
        if (ac !== bc) return ac - bc;
        var aq = qualityRank[a.cls.quality] !== undefined ? qualityRank[a.cls.quality] : 9;
        var bq = qualityRank[b.cls.quality] !== undefined ? qualityRank[b.cls.quality] : 9;
        if (aq !== bq) return aq - bq;
        var as = signatureRank[a.components.failureSignature] !== undefined ? signatureRank[a.components.failureSignature] : 9;
        var bs = signatureRank[b.components.failureSignature] !== undefined ? signatureRank[b.components.failureSignature] : 9;
        if (as !== bs) return as - bs;
        var ad = a.components.nativeThresholdDeltas;
        var bd = b.components.nativeThresholdDeltas;
        if (a.components.failureSignature === 'WAS_LATEST_OPPOSING_SWING') {
            return ad.opposingWindowExcessBars - bd.opposingWindowExcessBars || a.leg.availableAt - b.leg.availableAt;
        }
        if (a.components.failureSignature === 'STRONG_BREAK') {
            return ad.breakPctDeficit - bd.breakPctDeficit || ad.breakBodyRatioDeficit - bd.breakBodyRatioDeficit || a.leg.availableAt - b.leg.availableAt;
        }
        return a.leg.availableAt - b.leg.availableAt;
    });
}

function selectIndependent(ordered, n) {
    var out = [];
    var legs = {};
    var mss = {};
    ordered.forEach(function (a) {
        if (out.length >= n) return;
        var legId = a.nearMiss.legId;
        var mssId = a.mss ? a.mss.id : null;
        if (legs[legId] || (mssId && mss[mssId])) return;
        legs[legId] = true;
        if (mssId) mss[mssId] = true;
        out.push(a);
    });
    return out;
}

function buildRecord(a, number, ctx, allDisp, allSweeps, futureLeaks) {
    var reviewId = 'MSS-HR-' + String(number).padStart(2, '0');
    var mssIndex = a.mss ? a.mss.candleIndex : a.leg.startIndex;
    var from = Math.max(0, mssIndex - 20);
    var formation = [];
    for (var i = from; i <= a.availableIndex; i++) {
        var c = ctx.candles[i];
        if (!c || c.closeTime > a.leg.availableAt) continue;
        var role = i === mssIndex ? (a.mss ? 'MSS_BREAK_CANDLE' : 'LEG_START_NO_MSS')
            : (i === a.availableIndex ? 'OPPORTUNITY_EVALUATION' : 'FORMATION');
        formation.push(compactCandle(c, i, role));
    }
    var breakCandle = a.mss ? ctx.candles[a.mss.candleIndex] : null;
    var refLevel = a.ref ? a.ref.price : (a.mss && a.mss.source ? a.mss.source.referencePrice : null);
    var breakClose = breakCandle ? breakCandle.close : null;
    var closeBeyond = breakClose !== null && refLevel !== null
        ? (a.leg.direction === 'BULLISH' ? breakClose - refLevel : refLevel - breakClose) : null;
    var disp = allDisp.filter(function (d) {
        return a.leg.ids.indexOf(d.id) !== -1 && d.confirmedAt <= a.leg.availableAt;
    }).map(compactEvent);
    var sweepIds = {};
    (a.liquidityContext && a.liquidityContext.allCandidates || []).forEach(function (s) { sweepIds[s.id] = true; });
    var sweeps = allSweeps.filter(function (s) { return sweepIds[s.id] && s.confirmedAt <= a.leg.availableAt; }).map(compactEvent);
    var rec = {
        reviewId: reviewId,
        time: { evaluationTime: a.leg.availableAt, evaluationTimeIso: iso(a.leg.availableAt), evaluationTimeUtc8: isoCn(a.leg.availableAt) },
        direction: a.leg.direction,
        opportunityTier: a.tier,
        opportunity: {
            id: a.nearMiss.entityId, legId: a.nearMiss.legId,
            legQuality: displacementLeg.classifyLegQuality(a.leg),
            nearDrawAvailable: a.nearTarget !== null && a.nearTarget !== undefined,
            nearTarget: a.nearTarget
        },
        MSS: {
            eventId: a.mss ? a.mss.id : null,
            referenceLevel: refLevel,
            referenceRoleType: a.ref ? { type: a.ref.type, side: a.ref.side, timeframe: a.ref.timeframe, source: a.ref.metadata && a.ref.metadata.source } : null,
            referenceObject: clone(a.ref),
            occurredAt: a.mss ? a.mss.occurredAt : null,
            confirmedAt: a.mss ? a.mss.confirmedAt : null,
            breakCandle: compactCandle(breakCandle, a.mss ? a.mss.candleIndex : null, 'MSS_BREAK_CANDLE'),
            breakClose: breakClose,
            closeBeyond: closeBeyond,
            structuralStateBefore: { available: false, value: null, reason: 'Current production 5m MSS event/classifier does not persist a structural-state-before field.' },
            structuralStateAfter: { available: false, value: null, reason: 'Current production 5m MSS event/classifier does not persist a structural-state-after field.' }
        },
        mssQuality: {
            currentQuality: a.cls.quality,
            productionDimensions: clone(a.cls.dims),
            conditions: clone(a.components.conditions),
            failedCoreComponents: clone(a.components.failedCoreComponents),
            primaryFailureReason: a.components.primaryFailureReason,
            nativeThresholdDeltas: clone(a.components.nativeThresholdDeltas),
            highThreshold: 'PROTECTED_SWING or HTF_RELEVANT'
        },
        liquidityContext: clone(a.liquidityContext),
        sweepContext: sweeps,
        displacementContext: {
            leg: clone(a.leg),
            events: disp,
            thresholds: clone(thresholds.events.displacement)
        },
        formationCandles: formation,
        outcomeIncludedInThisRecord: false,
        HUMAN_MSS_REVIEW: 'UNCERTAIN',
        HUMAN_HIGH_WORTHY: 'UNCERTAIN'
    };
    scanFuture(rec, a.leg.availableAt, reviewId, futureLeaks);
    return rec;
}

function buildOutcome(a, number, candles) {
    var out = [];
    for (var i = a.availableIndex + 1; i <= a.availableIndex + 10; i++) out.push(compactCandle(candles[i], i, 'OUTCOME'));
    return {
        reviewId: 'MSS-HR-' + String(number).padStart(2, '0'),
        evaluationTime: a.leg.availableAt,
        definition: '10 closed 5m candles after opportunity evaluationTime; excluded from formation review and selection/classification',
        candles: out
    };
}

function scanFuture(value, evaluationTime, reviewId, leaks, fieldPath) {
    if (!value || typeof value !== 'object') return;
    var base = fieldPath || [];
    Object.keys(value).forEach(function (k) {
        var v = value[k];
        var p = base.concat([k]);
        if (k === 'confirmedAt' && typeof v === 'number' && v > evaluationTime) {
            leaks.push({ reviewId: reviewId, fieldPath: p.join('.'), confirmedAt: v, evaluationTime: evaluationTime });
        }
        if (k === 'closeTime' && typeof v === 'number' && p[0] === 'formationCandles' && v > evaluationTime) {
            leaks.push({ reviewId: reviewId, fieldPath: p.join('.'), closeTime: v, evaluationTime: evaluationTime });
        }
        if (v && typeof v === 'object') scanFuture(v, evaluationTime, reviewId, leaks, p);
    });
}

function uniqueCount(list) {
    var s = {};
    list.forEach(function (x) { s[x] = true; });
    return Object.keys(s).length;
}
function uniqueNonNull(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        if (list[i] === null) continue;
        if (seen[list[i]]) return false;
        seen[list[i]] = true;
    }
    return true;
}

function writeArtifacts(result, records, outcomes, analyses) {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'audit-summary.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'human-review-records.json'), JSON.stringify(records, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'outcomes-hidden-from-formation-review.json'), JSON.stringify(outcomes, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'mss-near-miss-185-ledger.json'), JSON.stringify(analyses.map(function (a) {
        return {
            entityId: a.nearMiss.entityId, legId: a.nearMiss.legId,
            evaluationTime: a.leg.availableAt, direction: a.leg.direction,
            opportunityTier: a.tier, mssEventId: a.mss ? a.mss.id : null,
            currentQuality: a.cls.quality, productionDimensions: clone(a.cls.dims),
            components: clone(a.components)
        };
    }), null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'HUMAN_AUDIT_REPORT.md'), renderReport(result, records));
    console.error('Wrote MSS human audit to ' + OUT_DIR);
}

function renderReport(result, records) {
    var f = result.failureComponentFrequency;
    var lines = ['# MSS Quality Near-Miss Human Audit V1', '',
        '- Source MSS_QUALITY near-miss: ' + f.total,
        '- Selected independent review records: ' + records.length,
        '- Outcome is excluded from this formation report and stored separately.',
        '- No composite score was created.', '',
        '## Failure component frequency', '',
        '| Component | fail | not evaluable | evaluable | fail % of 185 | fail % evaluable |',
        '| --- | ---: | ---: | ---: | ---: | ---: |'];
    Object.keys(f.components).forEach(function (k) {
        var x = f.components[k];
        lines.push('| ' + k + ' | ' + x.fail + ' | ' + x.notEvaluable + ' | ' + x.evaluableCount + ' | ' + (x.failRateOf185 * 100).toFixed(2) + '% | ' + (x.failRateOfEvaluable === null ? '-' : (x.failRateOfEvaluable * 100).toFixed(2) + '%') + ' |');
    });
    lines.push('', 'Quality distribution: `' + JSON.stringify(f.currentQuality) + '`');
    lines.push('', 'Primary failure distribution: `' + JSON.stringify(f.primaryFailureReason) + '`');
    lines.push('', '## Review record index', '');
    records.forEach(function (r) {
        lines.push('- ' + r.reviewId + ' | ' + r.time.evaluationTimeUtc8 + ' | ' + r.direction + ' | ' + r.opportunityTier + ' | ' + r.mssQuality.currentQuality + ' | ' + r.mssQuality.primaryFailureReason + ' | leg=' + r.opportunity.legId);
    });
    lines.push('', '## Invariants', '');
    Object.keys(result.invariants).forEach(function (k) { lines.push('- ' + k + ' = ' + result.invariants[k]); });
    return lines.join('\n') + '\n';
}

if (require.main === module) {
    main().then(function (r) {
        console.error(JSON.stringify({ audit: r.audit, failureComponentFrequency: r.failureComponentFrequency, invariants: r.invariants }, null, 2));
    }).catch(function (e) {
        console.error('MSS HUMAN AUDIT FAILED:', e && e.stack || e);
        process.exit(1);
    });
}

module.exports = { main: main };
