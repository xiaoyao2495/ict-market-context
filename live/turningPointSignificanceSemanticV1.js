'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — live semantic service.
 *
 * Owns the DeepSeek call for one already-confirmed Dynamic-D turning point and
 * answers one question only: at candidate.confirmedAt, was this turning process
 * independent and meaningful enough to be preserved as a historical anchor?
 *
 * Reuses the production-verified DeepSeek transport (ai/deepseekClient) with the
 * same proxy bypass, model identity normalization, secret handling and usage
 * logging as the 4H Bias and EQ_FVG semantic layers. No third client is created.
 *
 * Two hard guarantees:
 *
 * 1. FAIL CLOSED, NEVER PAUSE (spec §8/§64). Any failure — semantic unavailable,
 *    timeout, schema invalid, raw persistence failure, facts build failure, hash
 *    mismatch, unexpected model identity, store corruption — yields
 *    ANCHOR_ELIGIBLE=false for that one turning point and nothing more. The 5m
 *    pipeline, symbol polling, FVG monitoring and existing position protection
 *    are never delayed, blocked or paused.
 *
 * 2. ONE DECISION, FROZEN FOREVER (spec §41). A schema-valid decision is frozen
 *    on first receipt and never re-rolled. Retry exists only in the transport,
 *    only for timeout / 429 / 5xx / connection reset, and only while no valid
 *    response has been received.
 *
 * Hydration is strictly SERIAL. Serial execution is deliberate: it avoids the
 * known DeepSeek empty-200 race that parallel sampling provokes.
 */

var deepseekClient = require('../ai/deepseekClient');
var contract = require('../semantic/turningPointSignificanceSemanticV1');
var factsBuilder = require('../semantic/turningPointSignificanceFactsV1');
var storeModule = require('../semantic/turningPointSignificanceDecisionStoreV1');
var eligibilityModule = require('../liquidity/historicalAnchorEligibilityV1');

var TRANSPORT_MAX_ATTEMPTS = 2;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function errorCode(error) { return error && error.code || 'TURNING_SIGNIFICANCE_SEMANTIC_UNAVAILABLE'; }

function normalizedAlias(responseModel) {
    if (responseModel === contract.MODEL) return contract.MODEL;
    if (responseModel === contract.RESPONSE_MODEL_ALIAS) return contract.MODEL + '|' + contract.RESPONSE_MODEL_ALIAS;
    return null;
}

/** Default transport. Identical shape to the frozen EQ_FVG semantic request. */
function defaultRequest(facts) {
    if (deepseekClient.getModel() !== contract.MODEL) {
        return Promise.reject(Object.assign(new Error('TURNING_SIGNIFICANCE_MODEL_CONFIG_MISMATCH'),
            { code: 'TURNING_SIGNIFICANCE_MODEL_CONFIG_MISMATCH' }));
    }
    return deepseekClient.chat({
        systemPrompt: contract.SYSTEM_PROMPT,
        userPrompt: contract.USER_PREFIX + JSON.stringify(facts, null, 2),
        temperature: contract.TEMPERATURE,
        maxTokens: contract.MAX_TOKENS
    }, { maxAttempts: TRANSPORT_MAX_ATTEMPTS }).then(function (response) {
        var body = response.raw || {};
        var choice = body.choices && body.choices[0] || {};
        var usage = body.usage || {};
        return {
            rawContent: response.text,
            rawResponseModelId: body.model || contract.MODEL,
            usage: {
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0
            },
            finishReason: choice.finish_reason == null ? null : choice.finish_reason
        };
    });
}

function createService(options) {
    var opts = options || {};
    var config = opts.config || {};
    var buildFacts = opts.buildFacts || factsBuilder.buildProduction;
    var request = opts.request || defaultRequest;
    var store = opts.store || storeModule.createStore({ directory: opts.storeDirectory });
    var observe = opts.observe || function () {};
    var archive = opts.archive || function () { return null; };
    var sourceProvider = opts.sourceProvider || function () { return null; };
    var now = opts.now || Date.now;
    var inFlight = new Map();
    var resolved = {};
    var queue = [];
    var queued = {};
    var draining = false;
    var stats = { llmCalls: 0, cacheHits: 0, cacheMisses: 0, queued: 0, hydrated: 0, failed: 0 };

    function log(type, candidate, identity, decision, extra) {
        observe(Object.assign({
            event: type,
            symbol: candidate && candidate.symbol || null,
            turningPointId: candidate && candidate.id || null,
            processId: candidate && candidate.processId || null,
            side: candidate && candidate.pointSide || null,
            price: candidate && candidate.price == null ? null : candidate.price,
            confirmedAt: candidate && candidate.confirmedAt == null ? null : candidate.confirmedAt,
            factsHash: identity ? identity.factsHash.slice(0, 12) : null,
            decisionKey: identity ? identity.decisionKey.slice(0, 12) : null,
            significance: decision && decision.significance || null,
            confidence: decision && decision.confidence || null,
            eligible: null
        }, extra || {}));
    }

    function unavailable(candidate, identity, facts, error) {
        return {
            status: 'UNAVAILABLE',
            semanticVersion: contract.VERSION,
            promptVersion: contract.PROMPT_VERSION,
            promptHash: contract.PROMPT_SHA256,
            facts: facts || null,
            factsHash: identity && identity.factsHash || null,
            decisionKey: identity && identity.decisionKey || null,
            decision: null,
            decisionSource: null,
            eligible: false,
            gateResult: 'BLOCK',
            gateReason: 'TURNING_SIGNIFICANCE_SEMANTIC_UNAVAILABLE',
            errorCode: errorCode(error),
            semanticCallDurationMs: 0,
            usage: {}
        };
    }

    function finalize(candidate, result) {
        if (result.decisionKey) resolved[candidate.id] = result;
        log(result.eligible ? 'TURNING_SIGNIFICANCE_ANCHOR_ELIGIBLE' : 'TURNING_SIGNIFICANCE_ANCHOR_BLOCKED',
            candidate, { factsHash: result.factsHash || '', decisionKey: result.decisionKey || '' },
            result.decision, { eligible: result.eligible, reason: result.gateReason || result.errorCode || null,
                draftFacts: undefined });
        try {
            result.archivePath = archive({
                semanticTask: contract.VERSION,
                symbol: candidate.symbol,
                turningPointId: candidate.id,
                processId: candidate.processId,
                side: candidate.pointSide,
                price: candidate.price,
                confirmedAt: candidate.confirmedAt,
                significance: result.decision && result.decision.significance || null,
                confidence: result.decision && result.decision.confidence || null,
                primaryReason: result.decision && result.decision.primaryReason || null,
                evidence: result.decision && result.decision.evidence || [],
                counterEvidence: result.decision && result.decision.counterEvidence || [],
                eligible: result.eligible,
                gateReason: result.gateReason || null,
                errorCode: result.errorCode || null,
                factsHash: result.factsHash || null,
                promptHash: result.promptHash || null,
                decisionKey: result.decisionKey || null,
                semanticVersion: contract.VERSION,
                promptVersion: contract.PROMPT_VERSION,
                facts: result.facts || null,
                usage: clone(result.usage || {}),
                candidateContext: opts.candidateContext ? opts.candidateContext(candidate) : null,
                evaluationTime: now()
            });
        } catch (error) {
            log('TURNING_SIGNIFICANCE_ERROR', candidate, null, result.decision,
                { reason: 'TURNING_SIGNIFICANCE_CASE_ARCHIVE_FAILED', errorCode: errorCode(error) });
        }
        return result;
    }

    function available(candidate, identity, record, source, duration) {
        var gate = contract.evaluateGate(record.decision, config);
        var result = {
            status: 'AVAILABLE',
            semanticVersion: contract.VERSION,
            promptVersion: contract.PROMPT_VERSION,
            promptHash: contract.PROMPT_SHA256,
            facts: record.facts,
            factsHash: identity.factsHash,
            decisionKey: identity.decisionKey,
            decision: clone(record.decision),
            decisionSource: source,
            requestedModelId: record.requestedModelId,
            rawResponseModelId: record.rawResponseModelId,
            normalizedModelIdentity: record.normalizedModelIdentity,
            usage: clone(record.usage || {}),
            semanticCallDurationMs: duration || 0,
            // The canary gate: (SIGNIFICANT|VALID) at MEDIUM-or-higher confidence.
            eligible: gate.result === 'PASS',
            gateResult: gate.result,
            gateReason: gate.reason,
            errorCode: null
        };
        return finalize(candidate, result);
    }

    function resolveOne(candidate, sourceOverride) {
        if (config.semanticEnabled !== true) {
            return Promise.resolve({ status: 'DISABLED', semanticVersion: contract.VERSION,
                promptVersion: contract.PROMPT_VERSION, promptHash: contract.PROMPT_SHA256,
                facts: null, factsHash: null, decisionKey: null, decision: null,
                decisionSource: null, eligible: false, gateResult: 'BLOCK',
                gateReason: 'TURNING_SIGNIFICANCE_DISABLED', errorCode: null, usage: {} });
        }
        var source = sourceOverride || sourceProvider(candidate);
        var facts, identity;
        try {
            if (!source) throw Object.assign(new Error('TURNING_SIGNIFICANCE_FACT_SOURCE_MISSING'),
                { code: 'TURNING_SIGNIFICANCE_FACT_SOURCE_MISSING' });
            facts = buildFacts({ candidate: candidate, source: source });
            identity = storeModule.buildIdentity({
                semanticVersion: contract.VERSION,
                symbol: candidate.symbol,
                turningPointId: candidate.id,
                processId: candidate.processId,
                facts: facts,
                promptHash: contract.PROMPT_SHA256,
                promptVersion: contract.PROMPT_VERSION,
                requestedModelId: contract.MODEL
            });
        } catch (error) {
            var failedBuild = unavailable(candidate, identity, facts, error);
            log('TURNING_SIGNIFICANCE_ERROR', candidate, identity, null,
                { reason: failedBuild.gateReason, errorCode: failedBuild.errorCode });
            return Promise.resolve(finalize(candidate, failedBuild));
        }
        if (inFlight.has(identity.decisionKey)) return inFlight.get(identity.decisionKey);
        var pending = Promise.resolve().then(function () {
            var cached = store.lookup(identity);
            if (cached.status === 'HIT') {
                stats.cacheHits += 1;
                log('TURNING_SIGNIFICANCE_CACHE_HIT', candidate, identity, cached.record.decision, null);
                return available(candidate, identity, cached.record, 'FROZEN_STORE', 0);
            }
            stats.cacheMisses += 1;
            log('TURNING_SIGNIFICANCE_CACHE_MISS', candidate, identity, null, null);
            var raw = store.lookupRaw(identity);
            if (raw.status === 'HIT') {
                // Raw survived but the freeze did not: recover deterministically,
                // never by re-asking the model.
                contract.validateModelIdentity(contract.MODEL, raw.record.rawResponseModelId);
                var recovered = contract.parseDecision(raw.record.rawContent);
                var restored = store.freeze(identity, raw.record, recovered, now());
                log('TURNING_SIGNIFICANCE_FROZEN', candidate, identity, restored.record.decision, null,
                    { decisionSource: 'RAW_STORE_RECOVERY' });
                return available(candidate, identity, restored.record, 'RAW_STORE_RECOVERY', 0);
            }
            var started = now();
            stats.llmCalls += 1;
            return Promise.resolve().then(function () { return request(clone(facts)); }).then(function (response) {
                response.rawResponseModelId = response.rawResponseModelId || contract.MODEL;
                response.normalizedModelIdentity = normalizedAlias(response.rawResponseModelId);
                // RAW RESPONSE PERSIST BEFORE PARSE.
                var persisted = store.persistRaw(identity, response, now());
                log('TURNING_SIGNIFICANCE_RAW_PERSISTED', candidate, identity, null, null);
                var normalized = contract.validateModelIdentity(contract.MODEL, persisted.record.rawResponseModelId);
                if (persisted.record.normalizedModelIdentity !== normalized) {
                    throw Object.assign(new Error('TURNING_SIGNIFICANCE_RAW_MODEL_IDENTITY_MISMATCH'),
                        { code: 'TURNING_SIGNIFICANCE_RAW_MODEL_IDENTITY_MISMATCH' });
                }
                // A schema-invalid response is retained, blocks this anchor, and is
                // never re-rolled (spec §42).
                var decision = contract.parseDecision(persisted.record.rawContent);
                var frozen = store.freeze(identity, persisted.record, decision, now());
                log('TURNING_SIGNIFICANCE_FROZEN', candidate, identity, frozen.record.decision, null,
                    { decisionSource: frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE' });
                return available(candidate, identity, frozen.record,
                    frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE', now() - started);
            });
        }).catch(function (error) {
            var failed = unavailable(candidate, identity, facts, error);
            log('TURNING_SIGNIFICANCE_ERROR', candidate, identity, null,
                { reason: failed.gateReason, errorCode: failed.errorCode });
            return finalize(candidate, failed);
        }).finally(function () {
            if (inFlight.get(identity.decisionKey) === pending) inFlight.delete(identity.decisionKey);
        });
        inFlight.set(identity.decisionKey, pending);
        return pending;
    }

    /** Synchronous read of an already-resolved decision (used by the registry). */
    function eligibilityOf(candidateOrId) {
        var id = typeof candidateOrId === 'string' ? candidateOrId
            : candidateOrId && candidateOrId.id;
        if (!id) return null;
        var hit = resolved[id];
        if (hit) return hit;
        return null;
    }

    /**
     * Serial hydration queue. Fire-and-forget from the caller's perspective: the
     * returned promise resolves with null on any failure and never rejects.
     */
    function enqueue(candidate, sourceOverride) {
        if (config.semanticEnabled !== true || !candidate || !candidate.id) return Promise.resolve(null);
        if (queued[candidate.id] || resolved[candidate.id]) return Promise.resolve(resolved[candidate.id] || null);
        queued[candidate.id] = true;
        stats.queued += 1;
        return new Promise(function (resolve) {
            queue.push({ candidate: candidate, sourceOverride: sourceOverride, resolve: resolve });
            drain();
        });
    }

    function drain() {
        if (draining) return;
        var item = queue.shift();
        if (!item) return;
        draining = true;
        resolveOne(item.candidate, item.sourceOverride).then(function (result) {
            stats.hydrated += 1;
            item.resolve(result);
        }).catch(function (error) {
            stats.failed += 1;
            observe({ event: 'TURNING_SIGNIFICANCE_ERROR',
                symbol: item.candidate && item.candidate.symbol,
                turningPointId: item.candidate && item.candidate.id,
                errorCode: errorCode(error) });
            item.resolve(null);
        }).then(function () {
            draining = false;
            drain();
        });
    }

    /**
     * Pre-seed the synchronous view from the immutable decision store, so a
     * restart reproduces eligibility without re-asking the model (spec §40).
     * The decision files remain the single source of truth; this is a rebuildable
     * in-memory acceleration only. Returns the number of records restored.
     */
    function restoreEligibility() {
        if (typeof store.listDecisionRecords !== 'function') return 0;
        var restored = 0;
        store.listDecisionRecords().forEach(function (record) {
            var gate = contract.evaluateGate(record.decision, config);
            resolved[record.turningPointId] = {
                status: 'AVAILABLE',
                semanticVersion: contract.VERSION,
                promptVersion: contract.PROMPT_VERSION,
                promptHash: contract.PROMPT_SHA256,
                facts: record.facts,
                factsHash: record.factsHash,
                decisionKey: record.decisionKey,
                decision: clone(record.decision),
                decisionSource: 'FROZEN_STORE',
                eligible: gate.result === 'PASS',
                gateResult: gate.result,
                gateReason: gate.reason,
                errorCode: null,
                usage: clone(record.usage || {}),
                semanticCallDurationMs: 0
            };
            restored += 1;
        });
        return restored;
    }

    return {
        version: contract.VERSION,
        evaluate: resolveOne,
        enqueue: enqueue,
        eligibilityOf: eligibilityOf,
        restoreEligibility: restoreEligibility,
        getStats: function () { return clone(stats); },
        _inFlight: inFlight,
        _queue: queue
    };
}

/** Convenience factory matching the live wiring used by scripts/live.js. */
function createLiveRegistry(options) {
    var service = createService(options);
    var registry = eligibilityModule.createRegistry({
        config: options && options.config || {},
        observe: options && options.observe || function () {},
        eligibilityOf: service.eligibilityOf,
        enqueue: function (point) { return service.enqueue(point); }
    });
    return { service: service, registry: registry };
}

module.exports = {
    VERSION: contract.VERSION,
    TRANSPORT_MAX_ATTEMPTS: TRANSPORT_MAX_ATTEMPTS,
    defaultRequest: defaultRequest,
    createService: createService,
    createLiveRegistry: createLiveRegistry
};
