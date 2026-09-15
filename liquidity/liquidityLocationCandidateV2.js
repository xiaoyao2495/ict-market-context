'use strict';

/**
 * LIQUIDITY_LOCATION_V2 — canonical Liquidity Location Candidate.
 *
 * SEMANTICS FROZEN (Liquidity Model V2, Phase 1):
 *
 *   Location             != Liquidity
 *   Liquidity Location   != Liquidity Interaction
 *   Interaction          != Response
 *
 * A LiquidityLocationCandidateV2 asserts only that a *location* exists which a
 * production detector has already identified. It does NOT assert that liquidity
 * exists there, that it was swept, rejected, or taken, and it carries no
 * interaction or response outcome. There is deliberately no status, lifecycle,
 * interaction, response or score field, and none may be inferred from this
 * object. Anything resembling TAKEN / SWEPT / REJECTED / ACCEPTED /
 * INVALIDATED belongs to a later phase and is explicitly out of contract here.
 *
 * Phase 1 source scope: sourceType === 'EQ' only. The shape is source-agnostic
 * so that later phases can add STRUCTURAL_SWING / HISTORICAL_SIGNIFICANT_EXTREME
 * / PREVIOUS_DAY_EXTREME without changing this contract, but no such source is
 * implemented, adapted or registered in Phase 1.
 *
 * ---------------------------------------------------------------------------
 * SIDE (frozen; must never be confused with trade direction)
 * ---------------------------------------------------------------------------
 *   EQH (equal highs, production liquidity.side === 'BSL') -> BUY_SIDE
 *   EQL (equal lows,  production liquidity.side === 'SSL') -> SELL_SIDE
 *
 *   BUY_SIDE  != LONG
 *   SELL_SIDE != SHORT
 *
 * `side` answers "which side of the market holds the resting orders this
 * location is suspected of hosting" — a property of the LOCATION. It does not
 * answer "which way to trade". This module therefore exposes no mapping from a
 * location side to a trade direction, and never emits LONG/SHORT.
 * ---------------------------------------------------------------------------
 */

var VERSION = 'LIQUIDITY_LOCATION_V2';
var SOURCE_TYPE_EQ = 'EQ';
var ID_PREFIX = 'LLOCV2';

var SIDE_BUY = 'BUY_SIDE';
var SIDE_SELL = 'SELL_SIDE';

// FROZEN: production EQ type -> location side.
var SIDE_BY_EQ_TYPE = { EQH: SIDE_BUY, EQL: SIDE_SELL };
// FROZEN: production EQ liquidity.side (BSL/SSL) -> location side. Cross-checked
// against SIDE_BY_EQ_TYPE by the adapter so an inconsistent source is rejected
// rather than silently trusted.
var SIDE_BY_EQ_LIQUIDITY_SIDE = { BSL: SIDE_BUY, SSL: SIDE_SELL };

// Rejection taxonomy. Every rejection is explicit and typed; a source that
// cannot be represented losslessly is never silently coerced.
var REJECTION = {
    NOT_AN_OBJECT: 'LIQUIDITY_LOCATION_SOURCE_NOT_OBJECT',
    SOURCE_TYPE_UNSUPPORTED: 'LIQUIDITY_LOCATION_SOURCE_TYPE_UNSUPPORTED',
    SOURCE_ID_MISSING: 'LIQUIDITY_LOCATION_SOURCE_ID_MISSING',
    SIDE_INCONSISTENT: 'LIQUIDITY_LOCATION_SIDE_INCONSISTENT',
    REFERENCE_PRICE_INVALID: 'LIQUIDITY_LOCATION_REFERENCE_PRICE_INVALID',
    PRICE_BAND_INVALID: 'LIQUIDITY_LOCATION_PRICE_BAND_INVALID',
    TIME_INVALID: 'LIQUIDITY_LOCATION_TIME_INVALID',
    CAUSALITY_INVALID: 'LIQUIDITY_LOCATION_CAUSALITY_INVALID',
    NOT_YET_CONFIRMED: 'LIQUIDITY_LOCATION_NOT_YET_CONFIRMED',
    ID_MISMATCH: 'LIQUIDITY_LOCATION_ID_MISMATCH',
    PROVENANCE_INVALID: 'LIQUIDITY_LOCATION_PROVENANCE_INVALID',
    MODEL_VERSION_MISMATCH: 'LIQUIDITY_LOCATION_MODEL_VERSION_MISMATCH'
};

function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isLocationSide(side) {
    return side === SIDE_BUY || side === SIDE_SELL;
}

/** FROZEN side mapping. Returns null for an unknown EQ type (never guesses). */
function sideForEqType(eqType) {
    return hasOwn(SIDE_BY_EQ_TYPE, eqType) ? SIDE_BY_EQ_TYPE[eqType] : null;
}

/** FROZEN cross-check mapping from the production liquidity.side field. */
function sideForEqLiquiditySide(liquiditySide) {
    return hasOwn(SIDE_BY_EQ_LIQUIDITY_SIDE, liquiditySide)
        ? SIDE_BY_EQ_LIQUIDITY_SIDE[liquiditySide] : null;
}

/**
 * Deterministic, injective, reversible candidate id.
 * The source id is recoverable, so a candidate can always be traced back to the
 * exact production object it was projected from.
 */
function candidateIdFor(sourceType, sourceId) {
    return [ID_PREFIX, sourceType, sourceId].join(':');
}

function sourceIdFromCandidateId(candidateId) {
    var parts = String(candidateId == null ? '' : candidateId).split(':');
    if (parts.length < 3 || parts[0] !== ID_PREFIX) return null;
    return parts.slice(2).join(':');
}

function sourceTypeFromCandidateId(candidateId) {
    var parts = String(candidateId == null ? '' : candidateId).split(':');
    if (parts.length < 3 || parts[0] !== ID_PREFIX) return null;
    return parts[1];
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Canonical value normalization: recursively sorts object keys and drops
 * undefined. Two candidates with the same logical content therefore serialize
 * to the same bytes regardless of property insertion order.
 */
function canonicalize(value) {
    if (Array.isArray(value)) {
        var list = [];
        for (var i = 0; i < value.length; i++) list.push(canonicalize(value[i]));
        return list;
    }
    if (value !== null && typeof value === 'object') {
        var out = {};
        Object.keys(value).sort().forEach(function (key) {
            if (value[key] !== undefined) out[key] = canonicalize(value[key]);
        });
        return out;
    }
    return value;
}

function stableSerialize(value) {
    return JSON.stringify(canonicalize(value));
}

/**
 * Build the canonical candidate from already-extracted, source-agnostic input.
 * This module never reads candles, never matches prices, never selects a
 * partner and never calls a model: it only shapes and validates.
 */
function createCandidate(input) {
    var source = input || {};
    var location = source.location || {};
    return {
        id: candidateIdFor(source.sourceType, source.sourceId),
        modelVersion: VERSION,
        side: source.side === undefined ? null : source.side,
        sourceType: source.sourceType === undefined ? null : source.sourceType,
        location: {
            referencePrice: location.referencePrice === undefined ? null : location.referencePrice,
            priceBand: location.priceBand === undefined ? null : clone(location.priceBand)
        },
        occurredAt: source.occurredAt === undefined ? null : source.occurredAt,
        confirmedAt: source.confirmedAt === undefined ? null : source.confirmedAt,
        sourceProvenance: source.sourceProvenance === undefined ? null : clone(source.sourceProvenance),
        semanticProvenance: source.semanticProvenance === undefined ? null : clone(source.semanticProvenance)
    };
}

/**
 * Structural + causal validation of a candidate.
 *
 * @param {Object} candidate
 * @param {Object} [options] { evaluationTime } — when provided, the candidate's
 *   confirmation must not be in the future relative to it (causality gate).
 * @returns {Object} { valid: boolean, errorCode: string|null }
 */
function validate(candidate, options) {
    var opts = options || {};
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return { valid: false, errorCode: REJECTION.NOT_AN_OBJECT };
    }
    if (candidate.modelVersion !== VERSION) {
        return { valid: false, errorCode: REJECTION.MODEL_VERSION_MISMATCH };
    }
    if (typeof candidate.sourceType !== 'string' || candidate.sourceType.length === 0) {
        return { valid: false, errorCode: REJECTION.SOURCE_TYPE_UNSUPPORTED };
    }
    if (!isLocationSide(candidate.side)) {
        return { valid: false, errorCode: REJECTION.SIDE_INCONSISTENT };
    }
    if (candidate.sourceType === SOURCE_TYPE_EQ) {
        if (candidate.side !== sideForEqType(candidate.sourceProvenance
                && candidate.sourceProvenance.eqType)) {
            return { valid: false, errorCode: REJECTION.SIDE_INCONSISTENT };
        }
    }
    if (!candidate.sourceProvenance || typeof candidate.sourceProvenance !== 'object' ||
            typeof candidate.sourceProvenance.sourceId !== 'string' ||
            candidate.sourceProvenance.sourceId.length === 0 ||
            candidate.sourceProvenance.sourceType !== candidate.sourceType) {
        return { valid: false, errorCode: REJECTION.PROVENANCE_INVALID };
    }
    if (candidate.id !== candidateIdFor(candidate.sourceType, candidate.sourceProvenance.sourceId)) {
        return { valid: false, errorCode: REJECTION.ID_MISMATCH };
    }
    if (!candidate.location || !isFiniteNumber(candidate.location.referencePrice)) {
        return { valid: false, errorCode: REJECTION.REFERENCE_PRICE_INVALID };
    }
    var band = candidate.location.priceBand;
    if (band !== null && band !== undefined) {
        if (band.lower === undefined || band.upper === undefined ||
                typeof band.lower !== 'number' || typeof band.upper !== 'number' ||
                !isFinite(band.lower) || !isFinite(band.upper) ||
                band.lower > band.upper) {
            return { valid: false, errorCode: REJECTION.PRICE_BAND_INVALID };
        }
        // The reference price must sit inside the band it is the centre of.
        if (candidate.location.referencePrice < band.lower ||
                candidate.location.referencePrice > band.upper) {
            return { valid: false, errorCode: REJECTION.PRICE_BAND_INVALID };
        }
    }
    if (!isFiniteNumber(candidate.occurredAt) || !isFiniteNumber(candidate.confirmedAt)) {
        return { valid: false, errorCode: REJECTION.TIME_INVALID };
    }
    if (candidate.occurredAt > candidate.confirmedAt) {
        return { valid: false, errorCode: REJECTION.CAUSALITY_INVALID };
    }
    if (opts.evaluationTime !== undefined) {
        if (!isFiniteNumber(opts.evaluationTime)) {
            return { valid: false, errorCode: REJECTION.TIME_INVALID };
        }
        if (candidate.confirmedAt > opts.evaluationTime) {
            return { valid: false, errorCode: REJECTION.NOT_YET_CONFIRMED };
        }
    }
    if (!candidate.semanticProvenance || typeof candidate.semanticProvenance !== 'object') {
        return { valid: false, errorCode: REJECTION.PROVENANCE_INVALID };
    }
    return { valid: true, errorCode: null };
}

module.exports = {
    VERSION: VERSION,
    SOURCE_TYPE_EQ: SOURCE_TYPE_EQ,
    ID_PREFIX: ID_PREFIX,
    SIDE_BUY: SIDE_BUY,
    SIDE_SELL: SIDE_SELL,
    SIDE_BY_EQ_TYPE: SIDE_BY_EQ_TYPE,
    SIDE_BY_EQ_LIQUIDITY_SIDE: SIDE_BY_EQ_LIQUIDITY_SIDE,
    REJECTION: REJECTION,
    isFiniteNumber: isFiniteNumber,
    isLocationSide: isLocationSide,
    sideForEqType: sideForEqType,
    sideForEqLiquiditySide: sideForEqLiquiditySide,
    candidateIdFor: candidateIdFor,
    sourceIdFromCandidateId: sourceIdFromCandidateId,
    sourceTypeFromCandidateId: sourceTypeFromCandidateId,
    clone: clone,
    canonicalize: canonicalize,
    stableSerialize: stableSerialize,
    createCandidate: createCandidate,
    validate: validate
};
