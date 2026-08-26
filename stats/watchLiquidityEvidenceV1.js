'use strict';

/**
 * Minimal WATCH Production Consumption P1.
 *
 * Additive observability only. This module cannot create/cancel/rank a WATCH,
 * mutate the liquidity registry, or change Scenario/notification behavior.
 */
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var featureFlag = require('../config/watchLiquidityEvidenceV1');
var sweepContextFlag = require('../config/sweepContextV1');
var sweepContextV1 = require('./sweepContextV1');

var SCHEMA_VERSION = 'WatchLiquidityEvidenceV1';
var PRIMARY_SELECTION_SEMANTIC = 'CURRENT_PRODUCTION_RECENCY_HEURISTIC';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function biasAlignment(bias) {
    if (!bias) return { direction: 'UNKNOWN', alignment: 'NOT_APPLICABLE', evaluationTime: null, status: 'UNKNOWN' };
    var direction = bias.bias === 'BULLISH' || bias.bias === 'BEARISH' ? bias.bias :
        bias.bias === 'UNCLEAR' ? 'NEUTRAL' : 'UNKNOWN';
    var alignment = bias.alignment;
    if (alignment === 'UNCLEAR') alignment = 'NEUTRAL';
    if (alignment !== 'MATCH' && alignment !== 'OPPOSITE' && alignment !== 'NEUTRAL') alignment = 'NOT_APPLICABLE';
    return { direction: direction, alignment: alignment, evaluationTime: bias.evaluationTime == null ? null : bias.evaluationTime, status: bias.status || 'UNKNOWN' };
}

function candidateOrder(a, b) {
    if (a.confirmedAt !== b.confirmedAt) return a.confirmedAt - b.confirmedAt;
    if ((a.candleIndex || 0) !== (b.candleIndex || 0)) return (a.candleIndex || 0) - (b.candleIndex || 0);
    if (String(a.id) !== String(b.id)) return String(a.id).localeCompare(String(b.id));
    return String(a.sourceId).localeCompare(String(b.sourceId));
}

function transitionTime(status, source, sweep) {
    if (status === 'BROKEN') return source && source.brokenAt || null;
    if (status === 'SWEPT') return source && source.sweptAt || sweep.confirmedAt;
    if (status === 'TOUCHED') return source && source.touchedAt || null;
    if (status === 'ACTIVE') return source && source.confirmedAt || null;
    return null;
}

function firstCandleAfter(candles, confirmedAt) {
    var low = 0, high = (candles || []).length;
    while (low < high) {
        var mid = (low + high) >> 1;
        if (candles[mid].closeTime <= confirmedAt) low = mid + 1;
        else high = mid;
    }
    return low;
}

function projectLifecycle(sweep, source, candles, evaluationTime) {
    var state = {
        side: sweep.side,
        price: sweep.sourcePrice,
        status: 'SWEPT',
        touchedAt: sweep.confirmedAt,
        sweptAt: sweep.confirmedAt,
        brokenAt: null
    };
    var rows = candles || [];
    // Resolve by confirmedAt rather than trusting a replay-local candleIndex.
    // Persisted/frozen sources can use different warmup origins while timestamps
    // remain canonical. The window is ordered and closed-candle only.
    var start = firstCandleAfter(rows, sweep.confirmedAt);
    for (var i = start; i < rows.length; i++) {
        var candle = rows[i];
        if (!candle || candle.closed === false || candle.closeTime <= sweep.confirmedAt) continue;
        if (candle.closeTime > evaluationTime) break;
        var change = liquidityLifecycle.evaluateLiquidity(state, candle);
        if (!change) continue;
        state.status = change.status;
        state.touchedAt = change.touchedAt;
        state.sweptAt = change.sweptAt;
        state.brokenAt = change.brokenAt;
        if (state.status === 'BROKEN') break;
    }
    // The registry is the authoritative production lifecycle source. A source
    // may already carry a time-local BROKEN transition captured by the normal
    // production replay (notably an EQ object transition). Preserve it when it
    // was available by this WATCH evaluation, while hiding future registry
    // state. This is a read-only projection; the registry is never mutated.
    if (source && source.status === 'BROKEN' && typeof source.brokenAt === 'number' &&
        source.brokenAt <= evaluationTime &&
        (state.status !== 'BROKEN' || state.brokenAt == null || source.brokenAt < state.brokenAt)) {
        state.status = 'BROKEN';
        state.brokenAt = source.brokenAt;
    }
    var at = transitionTime(state.status, state, sweep);
    var eventId = state.status === 'SWEPT' ? sweep.id :
        state.status === 'BROKEN' && at != null ? 'LIFECYCLE_TRANSITION:' + sweep.sourceId + ':BROKEN:' + at :
        at != null ? 'LIFECYCLE_TRANSITION:' + sweep.sourceId + ':' + state.status + ':' + at : null;
    return {
        status: state.status,
        transition: state.status === 'SWEPT' ? 'LIQUIDITY_SWEPT' : state.status === 'BROKEN' ? 'LIQUIDITY_BROKEN' :
            state.status === 'TOUCHED' ? 'LIQUIDITY_TOUCHED' : 'LIQUIDITY_ACTIVE',
        transitionEventId: eventId,
        transitionAt: at,
        provenance: {
            sourceEngine: 'liquidity/liquidityLifecycle.js',
            sourceLiquidityId: sweep.sourceId,
            sourceRegistryStatusAtEvaluation: source && source.status || null,
            projectionMode: 'READ_ONLY_REGISTRY_AND_CLOSED_CANDLE_PROJECTION'
        }
    };
}

function identityOf(sweep, source, evaluationTime) {
    if (sweep.sourceType === 'SWING_HIGH' || sweep.sourceType === 'SWING_LOW') {
        return { status: sweep.sourceId ? 'RESOLVED' : 'UNRESOLVED', canonicalSwingId: sweep.sourceId || null,
            canonicalSwingIds: sweep.sourceId ? [sweep.sourceId] : [], eqObjectId: null };
    }
    if (sweep.sourceType === 'EQH' || sweep.sourceType === 'EQL') {
        var members = source && source.confirmedAt <= evaluationTime && source.metadata && source.metadata.members || [];
        var ids = members.filter(function (member) { return member.confirmedAt <= evaluationTime; }).map(function (member) { return member.id; });
        ids = ids.filter(function (id, index) { return id && ids.indexOf(id) === index; }).sort();
        return { status: sweep.sourceId ? 'REGISTRY_IDENTITY_RESOLVED' : 'UNRESOLVED', canonicalSwingId: null,
            canonicalSwingIds: ids, eqObjectId: sweep.sourceId || null };
    }
    return { status: sweep.sourceId ? 'REGISTRY_IDENTITY_RESOLVED' : 'UNRESOLVED', canonicalSwingId: null,
        canonicalSwingIds: [], eqObjectId: null };
}

function mapCandidate(sweep, opts) {
    var evaluationTime = opts.evaluationTime;
    if (!sweep || typeof sweep.confirmedAt !== 'number' || sweep.confirmedAt > evaluationTime) return null;
    var source = opts.registry && opts.registry.getById ? opts.registry.getById(sweep.sourceId) : null;
    var identity = identityOf(sweep, source, evaluationTime);
    var lifecycle = projectLifecycle(sweep, source, opts.candles, evaluationTime);
    var candidate = {
        candidateKey: String(sweep.id) + '|' + String(sweep.sourceId),
        sweepEventId: sweep.id || null,
        sourceId: sweep.sourceId || null,
        sourceType: sweep.sourceType || 'UNKNOWN',
        sourceTimeframe: sweep.sourceTimeframe || 'UNKNOWN',
        sourcePrice: sweep.sourcePrice,
        side: sweep.side || null,
        direction: sweep.side === 'SSL' ? 'BULLISH' : sweep.side === 'BSL' ? 'BEARISH' : null,
        confirmedAt: sweep.confirmedAt,
        candleIndex: sweep.candleIndex,
        relation: sweep.relation || null,
        barsBeforeLegStart: sweep.barsBeforeLegStart,
        identityStatus: identity.status,
        canonicalSwingId: identity.canonicalSwingId,
        canonicalSwingIds: identity.canonicalSwingIds,
        eqObjectId: identity.eqObjectId,
        eqMembershipEventIds: identity.canonicalSwingIds.map(function (id) { return 'EQ_MEMBERSHIP:' + identity.eqObjectId + ':' + id; }),
        lifecycleStatus: lifecycle.status,
        lifecycleTransition: lifecycle.transition,
        lifecycleTransitionEventId: lifecycle.transitionEventId,
        lifecycleTransitionAt: lifecycle.transitionAt,
        provenance: lifecycle.provenance
    };
    if (opts.sweepContextV1Enabled) {
        candidate.sweepContextV1 = sweepContextV1.buildSweepContextV1(sweep, {
            registry: opts.registry,
            projectSwingContextV1: opts.projectSwingContextV1
        });
    }
    return candidate;
}

function build(watch, options) {
    var opts = options || {};
    var evaluationTime = opts.evaluationTime !== undefined ? opts.evaluationTime : watch.updatedAt;
    var sweepContextV1Enabled = opts.sweepContextV1Enabled !== undefined
        ? !!opts.sweepContextV1Enabled : sweepContextFlag.isEnabled(opts.env);
    var legacyPrimary = watch.liquidityTaken && watch.liquidityTaken.primary || null;
    var candidates = (watch.liquidityTaken && watch.liquidityTaken.allCandidates || []).map(function (item) {
        return mapCandidate(item, { evaluationTime:evaluationTime, registry:opts.registry, candles:opts.candles,
            sweepContextV1Enabled:sweepContextV1Enabled, projectSwingContextV1:opts.projectSwingContextV1 });
    }).filter(Boolean).sort(candidateOrder);
    var primaryCandidate = legacyPrimary && candidates.filter(function (item) {
        return item.sweepEventId === legacyPrimary.id && item.sourceId === legacyPrimary.sourceId;
    })[0] || null;
    var identityStatus = primaryCandidate ? primaryCandidate.identityStatus : 'UNRESOLVED';
    return {
        schemaVersion: SCHEMA_VERSION,
        watchId: watch.id,
        evaluationTime: evaluationTime,
        identityStatus: identityStatus,
        liquidity: primaryCandidate ? {
            canonicalSwingId: primaryCandidate.canonicalSwingId,
            canonicalSwingIds: clone(primaryCandidate.canonicalSwingIds),
            liquiditySide: primaryCandidate.side,
            sourceId: primaryCandidate.sourceId,
            sourceType: primaryCandidate.sourceType,
            eqObjectId: primaryCandidate.eqObjectId,
            lifecycleStatus: primaryCandidate.lifecycleStatus,
            lifecycleTransition: primaryCandidate.lifecycleTransition,
            lifecycleTransitionEventId: primaryCandidate.lifecycleTransitionEventId,
            lifecycleTransitionAt: primaryCandidate.lifecycleTransitionAt
        } : {
            canonicalSwingId:null, canonicalSwingIds:[], liquiditySide:null, sourceId:null, sourceType:null,
            eqObjectId:null, lifecycleStatus:'UNRESOLVED', lifecycleTransition:null,
            lifecycleTransitionEventId:null, lifecycleTransitionAt:null
        },
        sweep: primaryCandidate ? {
            eventId:primaryCandidate.sweepEventId, sourceId:primaryCandidate.sourceId, sourceType:primaryCandidate.sourceType,
            side:primaryCandidate.side, direction:primaryCandidate.direction, confirmedAt:primaryCandidate.confirmedAt
        } : null,
        // `candidates` is the frozen contract field. `allCandidates` is kept as
        // the explicit compatibility alias named by the P1 acceptance plan.
        candidates: clone(candidates),
        allCandidates: candidates,
        currentPrimary: primaryCandidate ? {
            candidateKey:primaryCandidate.candidateKey, sweepEventId:primaryCandidate.sweepEventId,
            sourceId:primaryCandidate.sourceId, sourceType:primaryCandidate.sourceType, side:primaryCandidate.side,
            direction:primaryCandidate.direction, confirmedAt:primaryCandidate.confirmedAt,
            selectionSemantic:PRIMARY_SELECTION_SEMANTIC, causalPrimaryClaim:false
        } : {
            candidateKey:null, sweepEventId:null, sourceId:null, sourceType:null, side:null,
            direction:null, confirmedAt:null, selectionSemantic:PRIMARY_SELECTION_SEMANTIC, causalPrimaryClaim:false
        },
        bias: biasAlignment(opts.dailyBias || watch.dailyBias),
        blockedCausalEvidence: {
            reactionPolicyDependent:true, reactionLegProductionAllowed:false, attributedMssProductionAllowed:false,
            sameDeliveryDisplacementProductionAllowed:false, followThroughProductionAllowed:false
        },
        provenance: {
            adapterVersion:SCHEMA_VERSION,
            productionPrimarySweepEventId:legacyPrimary && legacyPrimary.id || null,
            candidateSweepEventIds:candidates.map(function (item) { return item.sweepEventId; }),
            swingSource:'existing sweep sourceId / liquidity registry',
            eqSource:'existing EQ registry metadata.members',
            lifecycleSource:'liquidity/liquidityLifecycle.js',
            sweepSource:'existing LIQUIDITY_SWEEP event',
            biasSource:'existing Daily Bias enrichment'
        }
    };
}

function attach(watch, options) {
    var opts = options || {};
    var enabled = opts.enabled !== undefined ? opts.enabled : featureFlag.isEnabled(opts.env);
    if (!enabled || !watch) return watch;
    watch.liquidityEvidenceV1 = build(watch, opts);
    return watch;
}

module.exports = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    PRIMARY_SELECTION_SEMANTIC: PRIMARY_SELECTION_SEMANTIC,
    candidateOrder: candidateOrder,
    firstCandleAfter: firstCandleAfter,
    biasAlignment: biasAlignment,
    projectLifecycle: projectLifecycle,
    identityOf: identityOf,
    mapCandidate: mapCandidate,
    build: build,
    attach: attach
};
