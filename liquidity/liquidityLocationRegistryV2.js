'use strict';

/**
 * LIQUIDITY_LOCATION_REGISTRY_V2 — registry for LiquidityLocationCandidateV2.
 *
 * Phase 1 scope: sourceType === 'EQ' only. The registry is source-agnostic by
 * construction (it never inspects a source-specific field to decide admission),
 * but no other source is produced in Phase 1.
 *
 * DELIBERATELY NOT A LIFECYCLE OWNER.
 * This registry stores location candidates and nothing else. It has no status
 * field, no state machine, and no notion of TAKEN / SWEPT / REJECTED / ACCEPTED
 * / INVALIDATED. Those are liquidity *interaction* semantics and belong to a
 * later phase; introducing them here would silently claim that liquidity exists
 * (see the LIQUIDITY_LOCATION_V2 semantic freeze). `register` only ever adds;
 * there is no `update`, no `applyLifecycleEvent`, and no mutation surface.
 *
 * Conventions follow the existing repo registry idiom
 * (liquidity/liquidityRegistry.js): a `createRegistry()` factory closing over a
 * private id-keyed store plus an insertion-order array. Unlike that registry,
 * ordering here is *registration order* and is the single deterministic
 * ordering guarantee.
 *
 * Guarantees:
 *   - deterministic ordering      registration order, never re-sorted
 *   - stable identity             id is derived from sourceType + sourceId
 *   - duplicate-safe              same id is never stored twice
 *   - conflict-aware              same id with different content is reported
 *   - serializable / restart-safe toJSON()/load() round-trip is lossless and
 *                                 re-registering loaded candidates is a no-op
 */

var candidateModule = require('./liquidityLocationCandidateV2');

var VERSION = 'LIQUIDITY_LOCATION_REGISTRY_V2';

function createRegistry(options) {
    var opts = options || {};
    var store = {};
    var order = [];
    var duplicateCount = 0;
    var conflictCount = 0;
    var conflictIds = [];
    var rejectedCount = 0;

    /**
     * @returns {boolean} true when the candidate was newly stored.
     *   A malformed candidate (fails the canonical schema) is rejected and
     *   counted, never stored. A repeated id is a no-op; if its content differs
     *   from the stored one it is additionally recorded as a conflict.
     */
    function register(candidate) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            rejectedCount++;
            return false;
        }
        if (!candidateModule.validate(candidate).valid) {
            rejectedCount++;
            return false;
        }
        var existing = store[candidate.id];
        if (existing) {
            duplicateCount++;
            if (candidateModule.stableSerialize(existing) !==
                    candidateModule.stableSerialize(candidate)) {
                conflictCount++;
                if (conflictIds.indexOf(candidate.id) < 0) conflictIds.push(candidate.id);
            }
            return false;
        }
        store[candidate.id] = candidate;
        order.push(candidate.id);
        return true;
    }

    function registerMany(candidates) {
        var list = Array.isArray(candidates) ? candidates : [];
        var added = 0;
        for (var i = 0; i < list.length; i++) {
            if (register(list[i])) added++;
        }
        return { added: added, considered: list.length };
    }

    function getById(id) {
        return store[id] || null;
    }

    function has(id) {
        return Boolean(store[id]);
    }

    /** Trace a candidate back through its source identity. */
    function getBySourceId(sourceType, sourceId) {
        return getById(candidateModule.candidateIdFor(sourceType, sourceId));
    }

    /**
     * Deterministic listing in registration order.
     * @param {Object} [filter] { side, sourceType, symbol, sourceId }
     */
    function list(filter) {
        var f = filter || {};
        var result = [];
        for (var i = 0; i < order.length; i++) {
            var candidate = store[order[i]];
            if (f.side !== undefined && candidate.side !== f.side) continue;
            if (f.sourceType !== undefined && candidate.sourceType !== f.sourceType) continue;
            if (f.sourceId !== undefined &&
                    (candidate.sourceProvenance || {}).sourceId !== f.sourceId) continue;
            if (f.symbol !== undefined &&
                    (candidate.sourceProvenance || {}).symbol !== f.symbol) continue;
            result.push(candidate);
        }
        return result;
    }

    function findBySide(side) {
        return list({ side: side });
    }

    function findBySourceType(sourceType) {
        return list({ sourceType: sourceType });
    }

    function size() {
        return order.length;
    }

    function clear() {
        store = {};
        order = [];
        duplicateCount = 0;
        conflictCount = 0;
        conflictIds = [];
        rejectedCount = 0;
    }

    function stats() {
        return {
            size: order.length,
            duplicates: duplicateCount,
            conflicts: conflictCount,
            conflictIds: conflictIds.slice(),
            rejected: rejectedCount
        };
    }

    /** Lossless, canonical, order-preserving serialization. */
    function toJSON() {
        var candidates = {};
        for (var i = 0; i < order.length; i++) {
            candidates[order[i]] = candidateModule.canonicalize(store[order[i]]);
        }
        return {
            version: VERSION,
            modelVersion: candidateModule.VERSION,
            order: order.slice(),
            candidates: candidates
        };
    }

    /**
     * Restart-safe load. Replaces current contents. Accepts only its own
     * version; anything else loads nothing rather than guessing.
     * @returns {number} number of candidates loaded
     */
    function load(payload) {
        clear();
        if (!payload || payload.version !== VERSION || !Array.isArray(payload.order) ||
                !payload.candidates || typeof payload.candidates !== 'object') {
            return 0;
        }
        var loaded = 0;
        for (var i = 0; i < payload.order.length; i++) {
            var candidate = payload.candidates[payload.order[i]];
            if (register(candidate)) loaded++;
        }
        return loaded;
    }

    return {
        version: VERSION,
        register: register,
        registerMany: registerMany,
        getById: getById,
        has: has,
        getBySourceId: getBySourceId,
        list: list,
        findBySide: findBySide,
        findBySourceType: findBySourceType,
        size: size,
        clear: clear,
        stats: stats,
        toJSON: toJSON,
        load: load
    };
}

function fromJSON(payload) {
    var registry = createRegistry();
    registry.load(payload);
    return registry;
}

module.exports = {
    VERSION: VERSION,
    createRegistry: createRegistry,
    fromJSON: fromJSON
};
