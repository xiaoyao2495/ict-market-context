'use strict';

/**
 * HISTORICAL_ANCHOR_ELIGIBILITY_V1 — the seam between the semantic layer and the
 * deterministic anchor universes.
 *
 * It is deliberately a tiny SYNCHRONOUS read interface:
 *
 *   isEligible(point)   -> true only when a frozen semantic decision for that
 *                          exact turning point already says
 *                          (SIGNIFICANT|VALID) + MEDIUM_OR_HIGH
 *   filter(points)      -> the eligible anchor universe, order preserved
 *
 * The EQ partner matcher and the TP selector call these while running inside the
 * synchronous 5m step, so the answer can only ever come from an already-frozen
 * decision. Hydration is asynchronous, fire-and-forget, strictly SERIAL, and can
 * never block, delay, or fail the 5m pipeline.
 *
 * FAIL CLOSED (spec §8):
 *   missing record / semantic unavailable / timeout / schema invalid /
 *   raw persistence failed / facts build failed / hash mismatch /
 *   unexpected model identity / store corruption
 *     -> NOT eligible
 *     -> the raw Dynamic-D candidate is still kept and still archived
 *     -> the 5m pipeline continues
 *
 * ROLLBACK (spec §63):
 *   liveFilterEnabled=false restores the legacy Dynamic-D anchor universe
 *   immediately, while semantic decisions may keep being collected as shadow
 *   research data.
 */

var VERSION = 'HISTORICAL_ANCHOR_ELIGIBILITY_V1';

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function createRegistry(options) {
    var opts = options || {};
    var config = opts.config || {};
    var observe = opts.observe || function () {};
    var eligibilityOf = opts.eligibilityOf || function () { return null; };
    var enqueue = opts.enqueue || function () { return Promise.resolve(null); };
    // Called once per (turningPointId, candidateContext) for a BLOCKED anchor so
    // the exclusion is archived with the context that triggered it (spec §59).
    var archiveBlock = opts.archiveBlock || function () {};
    var records = {};
    var contexts = {};
    var stats = { requests: 0, hits: 0, misses: 0, hydrations: 0, eligible: 0, blocked: 0 };

    function turningPointIdOf(point) {
        return point && (point.id || point.turningPointId) || null;
    }

    function record(point, result) {
        var id = turningPointIdOf(point);
        if (!id) return null;
        stats.hits += 1;
        if (result && result.eligible === true) stats.eligible += 1; else stats.blocked += 1;
        var decision = result && result.decision || null;
        records[id] = {
            turningPointId: id,
            processId: point.processId || null,
            symbol: point.symbol || null,
            side: point.pointSide || null,
            price: point.price == null ? null : point.price,
            confirmedAt: point.confirmedAt == null ? null : point.confirmedAt,
            eligible: result && result.eligible === true,
            significance: decision && decision.significance || null,
            confidence: decision && decision.confidence || null,
            primaryReason: decision && decision.primaryReason || null,
            evidence: decision && decision.evidence || [],
            counterEvidence: decision && decision.counterEvidence || [],
            decision: decision,
            gateReason: result && result.gateReason || null,
            status: result && result.status || null,
            errorCode: result && result.errorCode || null,
            factsHash: result && result.factsHash || null,
            promptHash: result && result.promptHash || null,
            decisionKey: result && result.decisionKey || null,
            semanticVersion: result && result.semanticVersion || null
        };
        return records[id];
    }

    /** Publish an already-resolved result (used by tests and by the service). */
    function publish(point, result) {
        var stored = record(point, result);
        observe({ event: stored && stored.eligible
            ? 'TURNING_SIGNIFICANCE_ANCHOR_ELIGIBLE'
            : 'TURNING_SIGNIFICANCE_ANCHOR_BLOCKED',
        symbol: stored && stored.symbol, turningPointId: stored && stored.turningPointId,
        processId: stored && stored.processId, side: stored && stored.side, price: stored && stored.price,
        confirmedAt: stored && stored.confirmedAt,
        factsHash: stored && stored.factsHash ? stored.factsHash.slice(0, 12) : null,
        decisionKey: stored && stored.decisionKey ? stored.decisionKey.slice(0, 12) : null,
        significance: stored && stored.significance, confidence: stored && stored.confidence,
        eligible: !!(stored && stored.eligible),
        reason: stored && (stored.gateReason || stored.errorCode) });
        return stored;
    }

    function stateOf(point) {
        var id = turningPointIdOf(point);
        return id ? records[id] || null : null;
    }

    /** Full frozen semantic provenance for one anchor (used by plan/archive). */
    function significanceOf(point) {
        var record = stateOf(point);
        if (!record) return null;
        return {
            turningPointId: record.turningPointId, processId: record.processId,
            price: record.price, side: record.side, confirmedAt: record.confirmedAt,
            significance: record.significance, confidence: record.confidence,
            primaryReason: record.primaryReason,
            evidence: record.evidence, counterEvidence: record.counterEvidence,
            eligible: record.eligible, gateReason: record.gateReason, errorCode: record.errorCode,
            factsHash: record.factsHash, promptHash: record.promptHash,
            decisionKey: record.decisionKey, semanticVersion: record.semanticVersion
        };
    }

    /**
     * Record, at most once, that a BLOCKED anchor was actually consulted as an
     * EQ partner candidate / TP target candidate, and archive that exclusion.
     */
    function markContext(point, context) {
        var id = turningPointIdOf(point);
        var record = id ? records[id] : null;
        if (!record || !context) return;
        var seen = contexts[id] || (contexts[id] = {});
        if (seen[context]) return;
        seen[context] = true;
        record.candidateContext = Object.keys(seen).sort();
        if (record.eligible === true) return;
        try { archiveBlock(record, context); }
        catch (error) {
            observe({ event: 'TURNING_SIGNIFICANCE_ERROR', symbol: record.symbol,
                turningPointId: id,
                errorCode: error && error.code || 'TURNING_SIGNIFICANCE_CASE_ARCHIVE_FAILED' });
        }
    }

    /**
     * Synchronous fail-closed eligibility. Absent record => false, and the
     * candidate is queued for lazy hydration so a later step can qualify it.
     */
    function isEligible(point, context) {
        if (!point) return false;
        var existing = stateOf(point);
        if (existing) {
            if (context) markContext(point, context);
            return existing.eligible === true;
        }
        // Also consult an externally frozen decision source (restart recovery).
        var external = eligibilityOf(point);
        if (external) {
            record(point, external);
            if (context) markContext(point, context);
            return external.eligible === true;
        }
        stats.requests += 1;
        stats.misses += 1;
        // Lazy hydration: queued, never awaited, never able to throw outward.
        var queued = enqueue(point);
        if (queued && typeof queued.catch === 'function') {
            queued.catch(function (error) {
                observe({ event: 'TURNING_SIGNIFICANCE_ERROR', symbol: point.symbol,
                    turningPointId: turningPointIdOf(point), processId: point.processId,
                    errorCode: error && error.code || 'TURNING_SIGNIFICANCE_HYDRATION_FAILED' });
            });
        }
        return false;
    }

    /** Eligible anchor universe. Order is preserved exactly as supplied. */
    function filter(points) {
        var universe = points || [];
        if (config.liveFilterEnabled !== true) return universe.slice();
        return universe.filter(isEligible);
    }

    function snapshot() { return clone(records); }
    function getStats() { return clone(stats); }
    function hydrate(point) { stats.hydrations += 1; return enqueue(point); }

    /**
     * Pre-hydrate turning points that have just been confirmed. Serial and
     * fire-and-forget. Idempotent: an already-resolved or already-queued turning
     * point is a no-op, and the per-decision cache guarantees a single decision
     * even if several EQ/TP plans later reference the same anchor (spec §52/§82).
     */
    function ensure(points) {
        (points || []).forEach(function (point) {
            var id = turningPointIdOf(point);
            if (!id || records[id] || eligibilityOf(point)) return;
            stats.hydrations += 1;
            var queued = enqueue(point);
            if (queued && typeof queued.catch === 'function') {
                queued.catch(function () {});
            }
        });
    }

    return {
        isEligible: isEligible,
        filter: filter,
        ensure: ensure,
        publish: publish,
        stateOf: stateOf,
        significanceOf: significanceOf,
        markContext: markContext,
        snapshot: snapshot,
        getStats: getStats,
        hydrate: hydrate,
        turningPointIdOf: turningPointIdOf
    };
}

module.exports = { VERSION: VERSION, createRegistry: createRegistry };
