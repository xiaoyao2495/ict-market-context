'use strict';

var crypto = require('crypto');

var MODEL_VERSION = 'MARKET_REFERENCE_V1';
var SOURCE_TYPES = Object.freeze([
    'STRUCTURAL_SWING',
    'DYNAMIC_D_HISTORICAL_EXTREME',
    'PREVIOUS_DAY_EXTREME'
]);
var SIDES = Object.freeze(['BUY_SIDE', 'SELL_SIDE']);
var TOP_LEVEL_KEYS = Object.freeze([
    'confirmedAt', 'geometry', 'id', 'modelVersion', 'occurredAt',
    'side', 'sourceProvenance', 'sourceType', 'symbol', 'timeframe'
]);
var FORBIDDEN_KEYS = Object.freeze([
    'accepted', 'broken', 'consumed', 'entryDirection', 'liquidity',
    'liquidityScore', 'liquidityType', 'qualityScore', 'rejected',
    'signal', 'sweep', 'taken', 'tradeDirection'
]);

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype;
}

function assertJsonValue(value, path) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('MARKET_REFERENCE_NON_FINITE_' + path);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach(function (item, index) { assertJsonValue(item, path + '[' + index + ']'); });
        return;
    }
    if (!isPlainObject(value)) throw new Error('MARKET_REFERENCE_NOT_SERIALIZABLE_' + path);
    Object.keys(value).forEach(function (key) {
        if (FORBIDDEN_KEYS.indexOf(key) >= 0) {
            throw new Error('MARKET_REFERENCE_FORBIDDEN_FIELD_' + key);
        }
        assertJsonValue(value[key], path + '.' + key);
    });
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (isPlainObject(value)) {
        return Object.keys(value).sort().reduce(function (out, key) {
            out[key] = canonicalize(value[key]);
            return out;
        }, {});
    }
    return value;
}

function canonicalSerialize(value) {
    assertJsonValue(value, 'root');
    return JSON.stringify(canonicalize(value));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
}

function clone(value) {
    return JSON.parse(canonicalSerialize(value));
}

function referenceId(input) {
    var identity = [
        MODEL_VERSION,
        input.symbol,
        input.timeframe,
        input.sourceType,
        input.sourceNativeId
    ];
    return 'MRV1:' + crypto.createHash('sha256').update(canonicalSerialize(identity)).digest('hex');
}

function assertExactKeys(value, expected, code) {
    var actual = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    if (actual.length !== wanted.length || actual.some(function (key, index) { return key !== wanted[index]; })) {
        throw new Error(code);
    }
}

function assertReference(reference) {
    if (!isPlainObject(reference)) throw new Error('MARKET_REFERENCE_INVALID');
    assertExactKeys(reference, TOP_LEVEL_KEYS, 'MARKET_REFERENCE_TOP_LEVEL_SCHEMA_INVALID');
    if (reference.modelVersion !== MODEL_VERSION) throw new Error('MARKET_REFERENCE_MODEL_VERSION_INVALID');
    if (typeof reference.symbol !== 'string' || !reference.symbol) throw new Error('MARKET_REFERENCE_SYMBOL_INVALID');
    if (typeof reference.timeframe !== 'string' || !reference.timeframe) throw new Error('MARKET_REFERENCE_TIMEFRAME_INVALID');
    if (SOURCE_TYPES.indexOf(reference.sourceType) < 0) throw new Error('MARKET_REFERENCE_SOURCE_TYPE_INVALID');
    if (SIDES.indexOf(reference.side) < 0) throw new Error('MARKET_REFERENCE_SIDE_INVALID');
    if (!isPlainObject(reference.geometry)) throw new Error('MARKET_REFERENCE_GEOMETRY_INVALID');
    assertExactKeys(reference.geometry, ['price', 'type'], 'MARKET_REFERENCE_GEOMETRY_SCHEMA_INVALID');
    if (reference.geometry.type !== 'POINT') throw new Error('MARKET_REFERENCE_GEOMETRY_TYPE_INVALID');
    if (typeof reference.geometry.price !== 'number' || !Number.isFinite(reference.geometry.price) || reference.geometry.price <= 0) {
        throw new Error('MARKET_REFERENCE_PRICE_INVALID');
    }
    if (!Number.isFinite(reference.occurredAt) || !Number.isFinite(reference.confirmedAt) ||
            reference.occurredAt > reference.confirmedAt) {
        throw new Error('MARKET_REFERENCE_CAUSALITY_INVALID');
    }
    if (!isPlainObject(reference.sourceProvenance) ||
            typeof reference.sourceProvenance.sourceNativeId !== 'string' ||
            !reference.sourceProvenance.sourceNativeId) {
        throw new Error('MARKET_REFERENCE_SOURCE_PROVENANCE_INVALID');
    }
    assertJsonValue(reference, 'reference');
    var expectedId = referenceId({
        symbol: reference.symbol,
        timeframe: reference.timeframe,
        sourceType: reference.sourceType,
        sourceNativeId: reference.sourceProvenance.sourceNativeId
    });
    if (reference.id !== expectedId) throw new Error('MARKET_REFERENCE_ID_INVALID');
    return reference;
}

function createMarketReference(input) {
    if (!isPlainObject(input)) throw new Error('MARKET_REFERENCE_INPUT_INVALID');
    if (!isPlainObject(input.sourceProvenance)) throw new Error('MARKET_REFERENCE_SOURCE_PROVENANCE_INVALID');
    var provenance = clone(input.sourceProvenance);
    var reference = {
        id: referenceId({
            symbol: input.symbol,
            timeframe: input.timeframe,
            sourceType: input.sourceType,
            sourceNativeId: provenance.sourceNativeId
        }),
        modelVersion: MODEL_VERSION,
        symbol: input.symbol,
        timeframe: input.timeframe,
        sourceType: input.sourceType,
        side: input.side,
        geometry: { type: 'POINT', price: input.price },
        occurredAt: input.occurredAt,
        confirmedAt: input.confirmedAt,
        sourceProvenance: provenance
    };
    assertReference(reference);
    return deepFreeze(reference);
}

function deserialize(serialized) {
    if (typeof serialized !== 'string') throw new Error('MARKET_REFERENCE_SERIALIZATION_INVALID');
    var parsed = JSON.parse(serialized);
    assertReference(parsed);
    return deepFreeze(parsed);
}

module.exports = {
    MODEL_VERSION: MODEL_VERSION,
    SOURCE_TYPES: SOURCE_TYPES,
    SIDES: SIDES,
    FORBIDDEN_KEYS: FORBIDDEN_KEYS,
    createMarketReference: createMarketReference,
    assertReference: assertReference,
    referenceId: referenceId,
    canonicalSerialize: canonicalSerialize,
    deserialize: deserialize,
    deepFreeze: deepFreeze
};
