'use strict';

var deepseekClient = require('../ai/deepseekClient');
var factBuilder = require('../bias/directionalContext/4hBiasFactsV3');
var semanticContract = require('../bias/4hBiasSemanticV3');
var decisionStoreV1 = require('../bias/4hBiasDecisionStoreV1');
var path = require('path');

var VERSION = '4H_BIAS_V3';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.keys(value).forEach(function (key) { deepFreeze(value[key]); });
    return Object.freeze(value);
}

function errorView(stage, error) {
    return {
        stage: stage,
        code: error && error.code || 'FOUR_HOUR_BIAS_ERROR',
        message: error && error.message || String(error)
    };
}

function defaultRequestSemantic(input) {
    if (deepseekClient.getModel() !== semanticContract.MODEL) {
        return Promise.reject(Object.assign(new Error('V3_MODEL_CONFIG_MISMATCH'), { code: 'V3_MODEL_CONFIG_MISMATCH' }));
    }
    return deepseekClient.chat({
        systemPrompt: semanticContract.SYSTEM_PROMPT,
        userPrompt: semanticContract.buildUserPrompt(input),
        temperature: 0,
        maxTokens: deepseekClient.getAuditCompletionTokenLimit()
    }, { maxAttempts: 0 }).then(function (response) {
        var parsed;
        try {
            parsed = JSON.parse(response.text);
        } catch (error) {
            error.code = 'V3_RESPONSE_JSON_INVALID';
            throw error;
        }
        return semanticContract.validateOutput(parsed);
    });
}

function createService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var getFourHourCandles = opts.getFourHourCandles || function () { return []; };
    var requestSemantic = opts.requestSemantic || defaultRequestSemantic;
    var buildFacts = opts.buildFacts || factBuilder.build;
    var now = opts.now || Date.now;
    var observe = opts.observe || function () {};
    var observeDecision = opts.observeDecision || function () {};
    var promptHash = opts.promptHash || semanticContract.PROMPT_HASH;
    var promptVersion = opts.promptVersion || semanticContract.VERSION;
    var modelId = opts.modelId || deepseekClient.getModel();
    var decisionStore = opts.decisionStore || decisionStoreV1.createStore({
        directory: opts.decisionStorePath || path.join(__dirname, '..', '.live-state', '4h-bias-decisions-v1')
    });
    var current = null;
    var lastProcessedClosed4hCloseTime = null;
    var inFlight = new Map();
    var stats = { biasBuildCount: 0, llmCallCount: 0 };

    function latestFullyClosed(evaluationTime) {
        var candles = getFourHourCandles();
        if (!Array.isArray(candles)) throw Object.assign(new Error('FOUR_HOUR_DATA_LOAD_FAILED'), { code: 'FOUR_HOUR_DATA_LOAD_FAILED' });
        return candles.filter(function (c) {
            return c && c.closed === true && c.closeTime <= evaluationTime;
        }).slice().sort(function (a, b) { return b.closeTime - a.closeTime; })[0] || null;
    }

    function identity(latest, facts) {
        return decisionStoreV1.buildIdentity({
            symbol: symbol,
            openTime: latest.openTime,
            closeTime: latest.closeTime,
            factsVersion: factBuilder.VERSION,
            facts: facts,
            promptHash: promptHash,
            promptVersion: promptVersion,
            modelId: modelId
        });
    }

    function snapshot(closedAt, status, facts, semantic, error, generatedAt, provenance) {
        var source = provenance || {};
        return deepFreeze({
            version: VERSION,
            symbol: symbol,
            timeframe: '4h',
            closedAt: closedAt,
            generatedAt: generatedAt,
            status: status,
            semantic: semantic ? clone(semantic) : null,
            facts: facts ? clone(facts) : null,
            factSetVersion: factBuilder.VERSION,
            factsHash: source.factsHash || null,
            decisionKey: source.decisionKey || null,
            decisionSource: source.decisionSource || null,
            promptHash: promptHash,
            promptVersion: promptVersion,
            model: modelId,
            error: error ? clone(error) : null
        });
    }

    function publish(next, durations) {
        if (current && typeof current.closedAt === 'number' &&
            typeof next.closedAt === 'number' && next.closedAt < current.closedAt) {
            return current;
        }
        current = next;
        lastProcessedClosed4hCloseTime = next.closedAt;
        observe({
            symbol: symbol,
            closedAt: next.closedAt,
            generatedAt: next.generatedAt,
            status: next.status,
            direction: next.semantic && next.semantic.direction || null,
            strength: next.semantic && next.semantic.strength || null,
            confidence: next.semantic && next.semantic.confidence || null,
            facts: clone(next.facts),
            factsHash: next.factsHash,
            decisionKey: next.decisionKey,
            decisionSource: next.decisionSource,
            promptHash: next.promptHash,
            promptVersion: next.promptVersion,
            modelId: next.model,
            buildDurationMs: durations.buildDurationMs,
            llmDurationMs: durations.llmDurationMs
        });
        return next;
    }

    function refresh(evaluationTime) {
        var latest;
        try {
            latest = latestFullyClosed(evaluationTime);
        } catch (error) {
            var dataUnavailable = snapshot(null, 'UNAVAILABLE', null, null, errorView('DATA', error), now());
            return Promise.resolve(publish(dataUnavailable, { buildDurationMs: 0, llmDurationMs: 0 }));
        }
        if (!latest) {
            var noClosed = snapshot(null, 'UNAVAILABLE', null, null,
                { stage: 'DATA', code: 'NO_FULLY_CLOSED_NATIVE_4H', message: 'No fully closed native 4H candle' }, now());
            return Promise.resolve(publish(noClosed, { buildDurationMs: 0, llmDurationMs: 0 }));
        }
        if (lastProcessedClosed4hCloseTime === latest.closeTime && current) return Promise.resolve(current);
        var buildStarted = now();
        var factSet;
        stats.biasBuildCount += 1;
        try {
            factSet = buildFacts(getFourHourCandles(), latest.closeTime, { symbol: symbol });
            if (factSet.closedAt !== latest.closeTime) throw new Error('V3_FACT_CLOSE_MISMATCH');
        } catch (error) {
            var unavailable = snapshot(latest.closeTime, 'UNAVAILABLE', null, null, errorView('FACT_BUILD', error), now());
            return Promise.resolve(publish(unavailable, { buildDurationMs: now() - buildStarted, llmDurationMs: 0 }));
        }
        var buildDuration = now() - buildStarted;
        var input = semanticContract.buildInput(factSet);
        var decisionIdentity;
        try {
            decisionIdentity = identity(latest, factSet.facts);
        } catch (error) {
            var invalidIdentity = snapshot(latest.closeTime, 'UNAVAILABLE', factSet.facts, null,
                errorView('DECISION_IDENTITY', error), now());
            return Promise.resolve(publish(invalidIdentity, { buildDurationMs: buildDuration, llmDurationMs: 0 }));
        }
        var key = decisionIdentity.decisionKey;
        if (inFlight.has(key)) return inFlight.get(key);
        var cache;
        try {
            cache = decisionStore.lookup(decisionIdentity);
        } catch (error) {
            observeDecisionEvent(error.code === 'BIAS_DECISION_STORE_CORRUPT' ?
                '4H_BIAS_DECISION_STORE_CORRUPT' : '4H_BIAS_DECISION_STORE_ERROR', decisionIdentity, null, null);
            var corrupt = snapshot(latest.closeTime, 'UNAVAILABLE', factSet.facts, null,
                errorView('DECISION_STORE', error), now(), provenance(decisionIdentity, null));
            return Promise.resolve(publish(corrupt, { buildDurationMs: buildDuration, llmDurationMs: 0 }));
        }
        if (cache.status === 'HIT') {
            observeDecisionEvent('4H_BIAS_DECISION_CACHE_HIT', decisionIdentity, cache.record.decision, 'FROZEN_STORE');
            return Promise.resolve(publish(snapshot(latest.closeTime, 'AVAILABLE', cache.record.facts,
                cache.record.decision, null, now(), provenance(decisionIdentity, 'FROZEN_STORE')),
            { buildDurationMs: buildDuration, llmDurationMs: 0 }));
        }
        observeDecisionEvent('4H_BIAS_DECISION_CACHE_MISS', decisionIdentity, null, null);
        var llmStarted = now();
        stats.llmCallCount += 1;
        // Invoke inside the promise chain: configuration/client failures such as
        // a synchronously missing API key must degrade to PARTIAL, not escape.
        var pending = Promise.resolve().then(function () {
            return requestSemantic(clone(input));
        }).then(function (semantic) {
            semantic = semanticContract.validateOutput(clone(semantic));
            var candidate = {
                direction: semantic.direction,
                strength: semantic.strength,
                confidence: semantic.confidence
            };
            var frozen;
            try {
                frozen = decisionStore.freeze(decisionIdentity, candidate, now());
            } catch (error) {
                error.biasFailureStage = 'DECISION_STORE';
                throw error;
            }
            var source = frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE';
            observeDecisionEvent(frozen.created ? '4H_BIAS_DECISION_FROZEN' : '4H_BIAS_DECISION_CACHE_HIT',
                decisionIdentity, frozen.record.decision, source);
            return publish(snapshot(latest.closeTime, 'AVAILABLE', frozen.record.facts, frozen.record.decision,
                null, now(), provenance(decisionIdentity, source)), {
                buildDurationMs: buildDuration,
                llmDurationMs: now() - llmStarted
            });
        }).catch(function (error) {
            var storeFailure = error.biasFailureStage === 'DECISION_STORE';
            if (storeFailure) observeDecisionEvent('4H_BIAS_DECISION_STORE_ERROR', decisionIdentity, null, null);
            return publish(snapshot(latest.closeTime, storeFailure ? 'UNAVAILABLE' : 'PARTIAL', factSet.facts,
                null, errorView(storeFailure ? 'DECISION_STORE' : 'SEMANTIC', error), now(),
                provenance(decisionIdentity, null)), {
                buildDurationMs: buildDuration,
                llmDurationMs: now() - llmStarted
            });
        }).finally(function () {
            if (inFlight.get(key) === pending) inFlight.delete(key);
        });
        inFlight.set(key, pending);
        return pending;
    }

    function provenance(decisionIdentity, source) {
        return {
            factsHash: decisionIdentity.factsHash,
            decisionKey: decisionIdentity.decisionKey,
            decisionSource: source
        };
    }

    function observeDecisionEvent(event, decisionIdentity, decision, source) {
        observeDecision({
            event: event,
            symbol: symbol,
            fourHourCloseTime: decisionIdentity.decisionKeyFields.candle.closeTime,
            factsHash: decisionIdentity.factsHash.slice(0, 12),
            promptHash: promptHash.slice(0, 12),
            modelId: modelId,
            decisionSource: source || null,
            direction: decision && decision.direction || null,
            strength: decision && decision.strength || null,
            confidence: decision && decision.confidence || null
        });
    }

    return {
        refresh: refresh,
        getCurrent: function () { return current; },
        getLastProcessedClosed4hCloseTime: function () { return lastProcessedClosed4hCloseTime; },
        getStats: function () { return clone(stats); },
        identity: identity,
        _inFlight: inFlight
    };
}

module.exports = {
    VERSION: VERSION,
    deepFreeze: deepFreeze,
    defaultRequestSemantic: defaultRequestSemantic,
    createService: createService
};
