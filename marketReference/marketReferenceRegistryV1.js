'use strict';

var referenceModule = require('./marketReferenceV1');

var REGISTRY_VERSION = 'MARKET_REFERENCE_REGISTRY_V1';

function order(a, b) {
    return a.confirmedAt - b.confirmedAt ||
        a.occurredAt - b.occurredAt ||
        a.sourceType.localeCompare(b.sourceType) ||
        a.id.localeCompare(b.id);
}

function exactPriceKey(price) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new Error('MARKET_REFERENCE_PRICE_QUERY_INVALID');
    }
    return String(price);
}

function createRegistry(initialReferences) {
    var byId = new Map();
    var byExactPrice = new Map();

    function sorted(items) { return items.slice().sort(order); }

    function register(reference) {
        referenceModule.assertReference(reference);
        reference = referenceModule.deepFreeze(reference);
        var existing = byId.get(reference.id);
        if (existing) {
            if (referenceModule.canonicalSerialize(existing) !== referenceModule.canonicalSerialize(reference)) {
                throw new Error('MARKET_REFERENCE_ID_COLLISION');
            }
            return existing;
        }
        byId.set(reference.id, reference);
        var key = exactPriceKey(reference.geometry.price);
        if (!byExactPrice.has(key)) byExactPrice.set(key, []);
        byExactPrice.get(key).push(reference);
        byExactPrice.set(key, sorted(byExactPrice.get(key)));
        return reference;
    }

    function registerMany(references) {
        if (!Array.isArray(references)) throw new Error('MARKET_REFERENCE_LIST_INVALID');
        return references.map(register);
    }

    function getById(id) { return byId.get(id) || null; }
    function list() { return sorted(Array.from(byId.values())); }
    function findBySourceType(sourceType) {
        if (referenceModule.SOURCE_TYPES.indexOf(sourceType) < 0) throw new Error('MARKET_REFERENCE_SOURCE_TYPE_INVALID');
        return list().filter(function (reference) { return reference.sourceType === sourceType; });
    }
    function findBySide(side) {
        if (referenceModule.SIDES.indexOf(side) < 0) throw new Error('MARKET_REFERENCE_SIDE_INVALID');
        return list().filter(function (reference) { return reference.side === side; });
    }
    function findConfirmedAsOf(evaluationTime) {
        if (!Number.isFinite(evaluationTime)) throw new Error('MARKET_REFERENCE_EVALUATION_TIME_INVALID');
        return list().filter(function (reference) { return reference.confirmedAt <= evaluationTime; });
    }
    function findExactPrice(price) {
        return (byExactPrice.get(exactPriceKey(price)) || []).slice();
    }
    function findExactPriceBySide(price, side) {
        return findExactPrice(price).filter(function (reference) { return reference.side === side; });
    }
    function serialize() {
        return referenceModule.canonicalSerialize({
            registryVersion: REGISTRY_VERSION,
            references: list()
        });
    }

    registerMany(initialReferences || []);
    return Object.freeze({
        register: register,
        registerMany: registerMany,
        getById: getById,
        list: list,
        findBySourceType: findBySourceType,
        findBySide: findBySide,
        findConfirmedAsOf: findConfirmedAsOf,
        findExactPrice: findExactPrice,
        findExactPriceBySide: findExactPriceBySide,
        serialize: serialize
    });
}

function deserialize(serialized) {
    if (typeof serialized !== 'string') throw new Error('MARKET_REFERENCE_REGISTRY_SERIALIZATION_INVALID');
    var payload = JSON.parse(serialized);
    if (!payload || payload.registryVersion !== REGISTRY_VERSION || !Array.isArray(payload.references) ||
            Object.keys(payload).sort().join(',') !== 'references,registryVersion') {
        throw new Error('MARKET_REFERENCE_REGISTRY_SERIALIZATION_INVALID');
    }
    var references = payload.references.map(function (reference) {
        return referenceModule.deserialize(referenceModule.canonicalSerialize(reference));
    });
    return createRegistry(references);
}

module.exports = {
    REGISTRY_VERSION: REGISTRY_VERSION,
    createRegistry: createRegistry,
    deserialize: deserialize,
    order: order
};
