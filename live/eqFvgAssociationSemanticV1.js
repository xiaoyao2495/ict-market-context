'use strict';

var deepseekClient = require('../ai/deepseekClient');
var contract = require('../semantic/eqFvgAssociationSemanticV1');
var factsBuilder = require('../semantic/eqFvgAssociationFactsV1');
var storeModule = require('../semantic/eqFvgAssociationDecisionStoreV1');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function errorCode(error) { return error && error.code || 'EQ_FVG_SEMANTIC_UNAVAILABLE'; }
function normalizedAlias(responseModel) {
    if (responseModel === contract.MODEL) return contract.MODEL;
    if (responseModel === contract.RESPONSE_MODEL_ALIAS) return contract.MODEL + '|' + contract.RESPONSE_MODEL_ALIAS;
    return null;
}
function defaultRequest(facts) {
    if (deepseekClient.getModel() !== contract.MODEL) {
        return Promise.reject(Object.assign(new Error('EQ_FVG_MODEL_CONFIG_MISMATCH'), { code: 'EQ_FVG_MODEL_CONFIG_MISMATCH' }));
    }
    return deepseekClient.chat({ systemPrompt: contract.SYSTEM_PROMPT,
        userPrompt: contract.USER_PREFIX + JSON.stringify(facts, null, 2),
        temperature: contract.TEMPERATURE, maxTokens: contract.MAX_TOKENS }, { maxAttempts: 0 }).then(function (response) {
        var body = response.raw || {}, choice = body.choices && body.choices[0] || {};
        var usage = body.usage || {};
        return { rawContent: response.text, rawResponseModelId: body.model || contract.MODEL,
            usage: { promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0 },
            finishReason: choice.finish_reason == null ? null : choice.finish_reason };
    });
}

function createService(options) {
    var opts = options || {}, config = opts.config || {};
    var buildFacts = opts.buildFacts || factsBuilder.buildProduction;
    var request = opts.request || defaultRequest;
    var store = opts.store || storeModule.createStore({ directory: opts.storeDirectory });
    var observe = opts.observe || function () {};
    var notify = opts.notify || function () { return Promise.resolve(); };
    var archive = opts.archive || function () {};
    var getExecutionPreview = opts.getExecutionPreview || function () { return {}; };
    var now = opts.now || Date.now;
    var inFlight = new Map();
    var stats = { llmCalls: 0, cacheHits: 0, cacheMisses: 0 };

    function log(type, event, identity, decision, gate, extra) {
        observe(Object.assign({ event: type, symbol: event.symbol, eqId: event.liquidityId,
            fvgId: event.rawFvg.id, factsHash: identity ? identity.factsHash.slice(0, 12) : null,
            decisionKey: identity ? identity.decisionKey.slice(0, 12) : null,
            association: decision && decision.association || null,
            confidence: decision && decision.confidence || null,
            gateResult: gate && gate.result || null, reason: gate && gate.reason || null }, extra || {}));
    }
    function unavailable(event, identity, facts, error) {
        return { status: 'UNAVAILABLE', semanticVersion: contract.VERSION, promptVersion: contract.PROMPT_VERSION,
            promptHash: contract.PROMPT_SHA256, facts: facts || null, factsHash: identity && identity.factsHash || null,
            decisionKey: identity && identity.decisionKey || contract.sha256(event.liquidityId + '|' + event.rawFvg.id),
            decision: null, decisionSource: null, gateResult: 'BLOCK', gateReason: 'EQ_FVG_SEMANTIC_UNAVAILABLE',
            errorCode: errorCode(error), semanticCallDurationMs: 0 };
    }
    function finalize(event, result) {
        var preview = {};
        try { preview = getExecutionPreview(event) || {}; } catch (error) { preview = { errorCode: errorCode(error) }; }
        var record = { symbol: event.symbol, direction: event.liquidityType === 'EQL' ? 'LONG' : 'SHORT',
            eqId: event.liquidityId, fvgId: event.rawFvg.id, eqConfirmedAt: event.eqConfirmedAt,
            fvgConfirmedAt: event.rawFvg.confirmedAt, factsHash: result.factsHash,
            promptHash: result.promptHash, semanticVersion: result.semanticVersion,
            decisionKey: result.decisionKey, association: result.decision && result.decision.association || null,
            confidence: result.decision && result.decision.confidence || null,
            primaryReason: result.decision && result.decision.primaryReason || null,
            evidence: result.decision && result.decision.evidence || [],
            counterEvidence: result.decision && result.decision.counterEvidence || [],
            semanticGate: result.gateResult, semanticGateReason: result.gateReason,
            fourHourBias: preview.fourHourBias || null, fourHourGateResult: preview.fourHourGateResult || null,
            initialRR: preview.initialRR == null ? null : preview.initialRR,
            rrGateResult: preview.rrGateResult || null,
            executionEligible: result.gateResult === 'PASS' && preview.executionEligible === true,
            eventTime: event.rawFvg.confirmedAt, evaluationTime: now(), errorCode: result.errorCode || null };
        try { result.archivePath = archive(record); }
        catch (error) {
            result.status = 'UNAVAILABLE'; result.gateResult = 'BLOCK';
            result.gateReason = 'EQ_FVG_SEMANTIC_UNAVAILABLE'; result.errorCode = 'EQ_FVG_CASE_ARCHIVE_FAILED';
            record.semanticGate = 'BLOCK'; record.semanticGateReason = result.gateReason; record.errorCode = result.errorCode;
            log('EQ_FVG_SEMANTIC_ERROR', event, null, null, { result: 'BLOCK', reason: result.gateReason }, { errorCode: result.errorCode });
        }
        return Promise.resolve().then(function () { return notify(event, clone(result)); }).catch(function (error) {
            result.status = 'UNAVAILABLE'; result.gateResult = 'BLOCK';
            result.gateReason = 'EQ_FVG_SEMANTIC_UNAVAILABLE';
            result.errorCode = 'EQ_FVG_SEMANTIC_NOTIFICATION_FAILED';
            log('EQ_FVG_SEMANTIC_ERROR', event, null, result.decision,
                { result: result.gateResult, reason: result.gateReason }, { errorCode: 'EQ_FVG_SEMANTIC_NOTIFICATION_FAILED' });
        }).then(function () {
            result.executionAllowed = config.liveGateEnabled !== true || result.gateResult === 'PASS';
            return result;
        });
    }
    function available(event, identity, record, source, duration) {
        var gate = contract.evaluateGate(record.decision);
        var result = { status: 'AVAILABLE', semanticVersion: contract.VERSION, promptVersion: contract.PROMPT_VERSION,
            promptHash: contract.PROMPT_SHA256, facts: record.facts, factsHash: identity.factsHash,
            decisionKey: identity.decisionKey, decision: clone(record.decision), decisionSource: source,
            requestedModelId: record.requestedModelId, rawResponseModelId: record.rawResponseModelId,
            normalizedModelIdentity: record.normalizedModelIdentity, usage: clone(record.usage || {}),
            semanticCallDurationMs: duration || 0, gateResult: gate.result, gateReason: gate.reason, errorCode: null };
        log(gate.result === 'PASS' ? 'EQ_FVG_SEMANTIC_GATE_PASS' : 'EQ_FVG_SEMANTIC_GATE_BLOCK',
            event, identity, record.decision, gate);
        return finalize(event, result);
    }
    function evaluate(event, source) {
        if (config.enabled !== true) return Promise.resolve({ status: 'DISABLED', gateResult: 'PASS', gateReason: null,
            executionAllowed: true, semanticVersion: contract.VERSION, promptVersion: contract.PROMPT_VERSION,
            promptHash: contract.PROMPT_SHA256 });
        var facts, identity;
        try {
            facts = buildFacts({ event: event, state: source.state, candles: source.candles });
            identity = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: event.symbol,
                eqId: event.liquidityId, fvgId: event.rawFvg.id, facts: facts,
                promptHash: contract.PROMPT_SHA256, promptVersion: contract.PROMPT_VERSION, requestedModelId: contract.MODEL });
        } catch (error) {
            var failed = unavailable(event, identity, facts, error);
            log('EQ_FVG_SEMANTIC_ERROR', event, identity, null, { result: 'BLOCK', reason: failed.gateReason }, { errorCode: failed.errorCode });
            return finalize(event, failed);
        }
        if (inFlight.has(identity.decisionKey)) return inFlight.get(identity.decisionKey);
        var pending = Promise.resolve().then(function () {
            var cached = store.lookup(identity);
            if (cached.status === 'HIT') {
                stats.cacheHits += 1; log('EQ_FVG_SEMANTIC_CACHE_HIT', event, identity, cached.record.decision, null);
                return available(event, identity, cached.record, 'FROZEN_STORE', 0);
            }
            stats.cacheMisses += 1; log('EQ_FVG_SEMANTIC_CACHE_MISS', event, identity, null, null);
            var raw = store.lookupRaw(identity);
            if (raw.status === 'HIT') {
                contract.validateModelIdentity(contract.MODEL, raw.record.rawResponseModelId);
                var recovered = contract.parseDecision(raw.record.rawContent);
                var restored = store.freeze(identity, raw.record, recovered, now());
                log('EQ_FVG_SEMANTIC_FROZEN', event, identity, restored.record.decision, null, { decisionSource: 'RAW_STORE_RECOVERY' });
                return available(event, identity, restored.record, 'RAW_STORE_RECOVERY', 0);
            }
            var started = now(); stats.llmCalls += 1;
            return Promise.resolve().then(function () { return request(clone(facts)); }).then(function (response) {
                response.rawResponseModelId = response.rawResponseModelId || contract.MODEL;
                response.normalizedModelIdentity = normalizedAlias(response.rawResponseModelId);
                var persisted = store.persistRaw(identity, response, now());
                log('EQ_FVG_SEMANTIC_RAW_PERSISTED', event, identity, null, null);
                var normalized = contract.validateModelIdentity(contract.MODEL, persisted.record.rawResponseModelId);
                if (persisted.record.normalizedModelIdentity !== normalized) throw Object.assign(new Error('EQ_FVG_RAW_MODEL_IDENTITY_MISMATCH'), { code: 'EQ_FVG_RAW_MODEL_IDENTITY_MISMATCH' });
                var decision = contract.parseDecision(persisted.record.rawContent);
                var frozen = store.freeze(identity, persisted.record, decision, now());
                log('EQ_FVG_SEMANTIC_FROZEN', event, identity, frozen.record.decision, null, { decisionSource: frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE' });
                return available(event, identity, frozen.record, frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE', now() - started);
            });
        }).catch(function (error) {
            var failed = unavailable(event, identity, facts, error);
            log('EQ_FVG_SEMANTIC_ERROR', event, identity, null, { result: 'BLOCK', reason: failed.gateReason }, { errorCode: failed.errorCode });
            return finalize(event, failed);
        }).finally(function () { if (inFlight.get(identity.decisionKey) === pending) inFlight.delete(identity.decisionKey); });
        inFlight.set(identity.decisionKey, pending);
        return pending;
    }
    return { evaluate: evaluate, getStats: function () { return clone(stats); }, _inFlight: inFlight };
}

module.exports = { VERSION: contract.VERSION, defaultRequest: defaultRequest, createService: createService };
