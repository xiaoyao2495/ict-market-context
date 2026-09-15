'use strict';

/**
 * EQ_LIQUIDITY_LOCATION_SOURCE_V2 — EQ source ADAPTER.
 *
 * This is an ADAPTER, not a detector. It consumes the EQ objects that
 * Production has ALREADY emitted and re-expresses each one as a
 * LiquidityLocationCandidateV2.
 *
 * It is explicitly forbidden — and structurally unable — to:
 *   - re-run the EQ detector or the Dynamic-D detector
 *   - re-search historical partners or re-select a partner
 *   - re-compute the Current 2L/2R point
 *   - re-compute the ATR tolerance
 *   - call any model / re-derive Turning Significance
 *   - read any candle, price outcome, fill, SL, TP, R multiple, future FVG or
 *     future displacement
 *
 * The only inputs are the emitted EQ object plus an evaluation timestamp. Every
 * field of the candidate is a lossless re-projection of a field the production
 * detector already decided.
 *
 * Source-set freezing reuses the existing production projection
 * `live/eqSourceContextV1.fromLiquidity`, which is the sanctioned
 * "freeze the source set Production EQ already chose" contract and already
 * enforces the causal ordering source.occurredAt <= source.confirmedAt <=
 * eq.confirmedAt. Reusing it (rather than re-implementing a second causality
 * rule) is what makes "the adapter accepts an EQ iff the existing production
 * consumer accepts it" a structural property instead of a coincidence.
 *
 * `adapt` is TOTAL: it never throws. Any internal failure becomes a typed
 * UNAVAILABLE result. That is what lets Phase 1 attach this source to the
 * production pipeline as SHADOW infrastructure without any risk to WATCH,
 * notification, Entry, position protection or execution reconciliation.
 *
 * NOTE (scope): this Phase 1 fail-open applies to the V2 SHADOW
 * infrastructure only. It does NOT alter the fail-closed semantics of the
 * existing semantic trade gates, which remain exactly as configured.
 */

var candidateModule = require('./liquidityLocationCandidateV2');
var eqSourceContextV1 = require('../live/eqSourceContextV1');
var producer = require('./productionEqualLiquidityV1');
var dynamicD = require('./causalDynamicDHistoricalExtremes');

var VERSION = 'EQ_LIQUIDITY_LOCATION_SOURCE_V2';
var MODEL = producer.VERSION;                      // DYNAMIC_D_36H_CROSS_SOURCE_V1
var HISTORICAL_SOURCE = dynamicD.VERSION;          // CAUSAL_DYNAMIC_D_V1
var SOURCE_TYPE = candidateModule.SOURCE_TYPE_EQ;  // 'EQ'

var BAND_DERIVATION = {
    PROJECTED: 'PRODUCTION_EQ_TOLERANCE_LOSSLESS_PROJECTION',
    NOT_AVAILABLE: 'NOT_AVAILABLE_IN_SOURCE'
};

var REJECTION = {
    NOT_AN_EQ_OBJECT: 'EQ_LOCATION_SOURCE_NOT_AN_EQ_OBJECT',
    MODEL_VERSION_UNKNOWN: 'EQ_LOCATION_SOURCE_MODEL_VERSION_UNKNOWN',
    SIDE_INCONSISTENT: 'EQ_LOCATION_SOURCE_SIDE_INCONSISTENT',
    SOURCE_CONTEXT_UNAVAILABLE: 'EQ_LOCATION_SOURCE_CONTEXT_UNAVAILABLE',
    ADAPTER_INTERNAL_ERROR: 'EQ_LOCATION_SOURCE_ADAPTER_INTERNAL_ERROR'
};

function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
}

function unavailable(errorCode, detail) {
    return {
        status: 'UNAVAILABLE',
        version: VERSION,
        errorCode: errorCode,
        detail: detail === undefined ? null : detail,
        candidate: null
    };
}

/**
 * Lossless price-band projection.
 *
 * The production EQ already applied exactly one tolerance value to every
 * partner of an event (pairwiseToleranceAtrMultiplier x 5m Wilder ATR14), and
 * it is recorded on each partner as `eqTolerance`. The band is that existing,
 * already-applied tolerance re-expressed around the reference price — no new
 * threshold is introduced, and nothing is re-tuned.
 *
 * Returns null (and the candidate is still valid) when the source does not
 * carry one unambiguous positive tolerance. Inventing a band in that case would
 * be a new threshold, so we do not.
 */
function priceBandFor(partners, referencePrice) {
    if (!Array.isArray(partners) || partners.length === 0) return null;
    if (!isFiniteNumber(referencePrice)) return null;
    var tolerance = null;
    for (var i = 0; i < partners.length; i++) {
        var value = partners[i] && partners[i].eqTolerance;
        if (!isFiniteNumber(value) || value <= 0) return null;
        if (tolerance === null) {
            tolerance = value;
        } else if (value !== tolerance) {
            return null;   // ambiguous source: no single band exists
        }
    }
    if (tolerance === null) return null;
    return { lower: referencePrice - tolerance, upper: referencePrice + tolerance };
}

function appliedToleranceFor(partners) {
    if (!Array.isArray(partners) || partners.length === 0) return null;
    var tolerance = null;
    for (var i = 0; i < partners.length; i++) {
        var value = partners[i] && partners[i].eqTolerance;
        if (!isFiniteNumber(value)) return null;
        if (tolerance === null) tolerance = value;
        else if (value !== tolerance) return null;
    }
    return tolerance;
}

/**
 * Adapt one already-emitted production EQ object into a
 * LiquidityLocationCandidateV2.
 *
 * @param {Object} liquidity production EQ object (type EQH|EQL)
 * @param {Object} [options] { evaluationTime } — the moment of construction.
 *   The candidate's confirmedAt must not exceed it (causality gate). When
 *   omitted the gate is not applied, which is only acceptable for structural
 *   unit tests, never for a point-in-time audit.
 * @returns {Object} { status: 'AVAILABLE', candidate } |
 *                   { status: 'UNAVAILABLE', errorCode, detail, candidate: null }
 */
function adapt(liquidity, options) {
    try {
        var opts = options || {};
        if (!liquidity || typeof liquidity !== 'object' || Array.isArray(liquidity)) {
            return unavailable(REJECTION.NOT_AN_EQ_OBJECT);
        }
        if (liquidity.type !== 'EQH' && liquidity.type !== 'EQL') {
            return unavailable(REJECTION.NOT_AN_EQ_OBJECT, 'type=' + liquidity.type);
        }
        var metadata = liquidity.metadata;
        if (!metadata || metadata.eqModelVersion !== MODEL) {
            return unavailable(REJECTION.MODEL_VERSION_UNKNOWN,
                'eqModelVersion=' + (metadata && metadata.eqModelVersion));
        }

        // FROZEN side mapping, cross-checked between the EQ type and the
        // production liquidity.side field. An inconsistent source is rejected,
        // never silently trusted.
        var side = candidateModule.sideForEqType(liquidity.type);
        var sideFromLiquidity = candidateModule.sideForEqLiquiditySide(liquidity.side);
        if (side === null || sideFromLiquidity === null || side !== sideFromLiquidity) {
            return unavailable(REJECTION.SIDE_INCONSISTENT,
                'type=' + liquidity.type + ' liquiditySide=' + liquidity.side);
        }

        // Freeze the exact source set Production EQ already chose. This also
        // enforces the causal ordering of the frozen provenance.
        var sourceContext = eqSourceContextV1.fromLiquidity(liquidity);
        if (sourceContext.status !== 'AVAILABLE') {
            return unavailable(REJECTION.SOURCE_CONTEXT_UNAVAILABLE, sourceContext.errorCode);
        }

        var partners = sourceContext.historicalPartners;
        var band = priceBandFor(partners, liquidity.price);

        // Only existing upstream semantic provenance may appear here. The EQ
        // event does not embed Turning Significance (it is an upstream
        // ELIGIBILITY FILTER, not a recorded property), so it is reported as
        // not embedded and is NOT re-derived. A VALID turning point must never
        // be re-labelled as SIGNIFICANT liquidity: those are different questions.
        var semanticProvenance = {
            // Deliberately NOT a liquidity status: the candidate asserts nothing
            // about whether liquidity exists or what it did. This flag only says
            // whether the SOURCE carried semantic provenance at all.
            embedded: false,
            turningPointSignificance: null,
            liquiditySignificance: null,
            note: 'Production EQ does not embed Turning Significance provenance. '
                + 'It is applied upstream as an eligibility filter only and is '
                + 'deliberately NOT re-derived or mapped onto a liquidity semantic here.'
        };

        var sourceProvenance = {
            sourceId: liquidity.id,
            sourceType: SOURCE_TYPE,
            eqType: liquidity.type,
            liquiditySide: liquidity.side,
            symbol: liquidity.symbol,
            timeframe: liquidity.timeframe,
            eqModelVersion: metadata.eqModelVersion,
            sourceContextVersion: sourceContext.version,
            currentPoint: sourceContext.currentPivot,
            historicalPartners: partners,
            partnerCount: sourceContext.partnerCount,
            tolerance: {
                atrPeriod: metadata.pairwiseToleranceAtrPeriod,
                atrMultiplier: metadata.pairwiseToleranceAtrMultiplier,
                applied: appliedToleranceFor(partners)
            },
            priceBandDerivation: band === null
                ? BAND_DERIVATION.NOT_AVAILABLE : BAND_DERIVATION.PROJECTED,
            historicalSource: metadata.historicalSource,
            historicalExtremeLocalization: metadata.historicalExtremeLocalization,
            historicalLookbackBars: metadata.historicalLookbackBars,
            historicalLookbackTime: metadata.historicalLookbackTime,
            asOf: liquidity.confirmedAt
        };

        var candidate = candidateModule.createCandidate({
            sourceType: SOURCE_TYPE,
            sourceId: liquidity.id,
            side: side,
            location: { referencePrice: liquidity.price, priceBand: band },
            occurredAt: liquidity.occurredAt,
            confirmedAt: liquidity.confirmedAt,
            sourceProvenance: sourceProvenance,
            semanticProvenance: semanticProvenance
        });

        var check = candidateModule.validate(candidate, opts);
        if (!check.valid) return unavailable(check.errorCode, 'candidate validation failed');
        return { status: 'AVAILABLE', version: VERSION, errorCode: null, detail: null, candidate: candidate };
    } catch (error) {
        // Shadow isolation: an internal failure is reported, never propagated.
        return unavailable(REJECTION.ADAPTER_INTERNAL_ERROR, String(error && error.message));
    }
}

/**
 * Adapt a list of already-emitted EQ objects. Ordering is preserved exactly as
 * given (production / replay order); nothing is sorted or re-ranked.
 *
 * @returns {Object} { version, candidates, rejections, rejected, adapted }
 */
function adaptAll(liquidities, options) {
    var list = Array.isArray(liquidities) ? liquidities : [];
    var candidates = [];
    var rejections = [];
    for (var i = 0; i < list.length; i++) {
        var result = adapt(list[i], options);
        if (result.status === 'AVAILABLE') candidates.push(result.candidate);
        else rejections.push({ index: i, errorCode: result.errorCode, detail: result.detail });
    }
    return {
        version: VERSION,
        candidates: candidates,
        rejections: rejections,
        rejected: rejections.length,
        adapted: candidates.length
    };
}

/**
 * SHADOW ingest: adapt already-emitted EQ into the V2 registry.
 *
 * This is the only sanctioned way to attach the V2 model to a running pipeline
 * in Phase 1. It is total (never throws), writes only into `registry`, and
 * returns a summary — nothing is written back to the EQ event, the liquidity
 * registry, the trade state or any notification. Production consumers therefore
 * keep consuming the existing EQ objects unchanged.
 *
 * @returns {Object} { considered, adapted, rejected, registered, duplicates,
 *   rejections, failed, failureDetail }
 */
function shadowAttach(registry, liquidities, options) {
    var summary = {
        version: VERSION,
        considered: 0,
        adapted: 0,
        rejected: 0,
        registered: 0,
        duplicates: 0,
        rejections: [],
        failed: false,
        failureDetail: null
    };
    try {
        var list = Array.isArray(liquidities) ? liquidities : [];
        summary.considered = list.length;
        var out = adaptAll(list, options);
        summary.adapted = out.adapted;
        summary.rejected = out.rejected;
        summary.rejections = out.rejections;
        for (var i = 0; i < out.candidates.length; i++) {
            if (registry.register(out.candidates[i])) summary.registered++;
            else summary.duplicates++;
        }
    } catch (error) {
        // Shadow isolation: a failure here can never interrupt the pipeline.
        summary.failed = true;
        summary.failureDetail = String(error && error.message);
    }
    return summary;
}

module.exports = {
    VERSION: VERSION,
    MODEL: MODEL,
    HISTORICAL_SOURCE: HISTORICAL_SOURCE,
    SOURCE_TYPE: SOURCE_TYPE,
    BAND_DERIVATION: BAND_DERIVATION,
    REJECTION: REJECTION,
    priceBandFor: priceBandFor,
    appliedToleranceFor: appliedToleranceFor,
    adapt: adapt,
    adaptAll: adaptAll,
    shadowAttach: shadowAttach
};
