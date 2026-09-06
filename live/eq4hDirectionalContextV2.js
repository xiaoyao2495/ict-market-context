'use strict';

var crypto = require('crypto');
var deepseekClient = require('../ai/deepseekClient');
var factsModule = require('../bias/directionalContext/4hDirectionalContextFactsV1');
var synthesis = require('../research/4hDirectionalContextLlmSynthesisV2');

var VERSION = '4H_DIRECTIONAL_CONTEXT_LLM_SYNTHESIS_V2';
var FACT_SET_VERSION = 'LLM_INPUT_FACT_SET_V1';
var PROMPT_HASH = 'f07b4f27cda27dc6a3188e0386e90a04353b0d922e15eb3d5401671f93c642fe';
var MODEL = 'deepseek-v4-flash';

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function actualPromptHash() {
    return crypto.createHash('sha256').update(synthesis.systemPrompt + '\n').digest('hex');
}

function unavailable(evaluationTime, errorCode) {
    return {
        status: 'UNAVAILABLE',
        researchOnly: true,
        evaluationTime: evaluationTime,
        latestClosedCandleTime: null,
        direction: null,
        confidence: null,
        dominantFacts: [],
        conflictingFacts: [],
        stateInterpretation: null,
        whatWouldChangeTheAssessment: [],
        promptVersion: VERSION,
        promptHash: PROMPT_HASH,
        factSetVersion: FACT_SET_VERSION,
        model: MODEL,
        errorCode: errorCode
    };
}

function alignment(context, expectedDirection) {
    if (!context || context.status !== 'AVAILABLE') return 'UNKNOWN';
    if (context.direction === 'NO_PRIORITY') return 'NO_PRIORITY';
    return context.direction === expectedDirection ? 'ALIGNED' : 'CONFLICT';
}

function defaultRequestDecision(facts) {
    if (actualPromptHash() !== PROMPT_HASH) {
        var promptError = new Error('V2_PROMPT_HASH_MISMATCH');
        promptError.code = 'V2_PROMPT_HASH_MISMATCH';
        return Promise.reject(promptError);
    }
    if (deepseekClient.getModel() !== MODEL) {
        var modelError = new Error('V2_MODEL_CONFIG_MISMATCH');
        modelError.code = 'V2_MODEL_CONFIG_MISMATCH';
        return Promise.reject(modelError);
    }
    return deepseekClient.chat({
        systemPrompt: synthesis.systemPrompt,
        userPrompt: synthesis.buildUserPrompt(facts),
        temperature: 0,
        maxTokens: deepseekClient.getAuditCompletionTokenLimit()
    }, { maxAttempts: 0 }).then(function (response) {
        var parsed;
        try {
            parsed = synthesis.validateOutput(JSON.parse(response.text));
        } catch (error) {
            error.code = error.code || 'V2_RESPONSE_SCHEMA_INVALID';
            throw error;
        }
        return parsed;
    });
}

function stableErrorCode(error) {
    var code = error && error.code;
    if (code === 'V2_PROMPT_HASH_MISMATCH' || code === 'V2_MODEL_CONFIG_MISMATCH') return code;
    if (/WARMUP/.test(error && error.message || '')) return 'FOUR_HOUR_WARMUP_UNAVAILABLE';
    if (/NON_FUTURES|NON_NATIVE|FOUR_HOUR_DATA_GAP/.test(error && error.message || '')) return 'FOUR_HOUR_DATA_INVALID';
    if (/SCHEMA|RESPONSE|JSON|DIRECTION|CONFIDENCE|TOP_LEVEL/.test((code || '') + ' ' + (error && error.message || ''))) return 'V2_RESPONSE_SCHEMA_INVALID';
    return code || 'V2_CONTEXT_UNAVAILABLE';
}

function createService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var getFourHourCandles = opts.getFourHourCandles || function () { return []; };
    var requestDecision = opts.requestDecision || defaultRequestDecision;
    var cache = new Map();
    var inFlight = new Map();

    function visibleSnapshot(evaluationTime) {
        if (typeof evaluationTime !== 'number' || !isFinite(evaluationTime)) {
            throw Object.assign(new Error('INVALID_EQ_CONFIRMED_AT'), {code:'INVALID_EQ_CONFIRMED_AT'});
        }
        if (actualPromptHash() !== PROMPT_HASH) {
            throw Object.assign(new Error('V2_PROMPT_HASH_MISMATCH'), {code:'V2_PROMPT_HASH_MISMATCH'});
        }
        var all = getFourHourCandles();
        if (!Array.isArray(all)) throw Object.assign(new Error('FOUR_HOUR_DATA_LOAD_FAILED'), {code:'FOUR_HOUR_DATA_LOAD_FAILED'});
        var closedAtCutoff = all.filter(function (c) {
            return c && c.closed === true && c.closeTime < evaluationTime;
        }).slice().sort(function (a, b) { return a.openTime - b.openTime; });
        if (closedAtCutoff.some(function (c) { return c.source !== 'futures'; })) {
            throw Object.assign(new Error('NON_FUTURES_4H_DATA'), {code:'NON_FUTURES_4H_DATA'});
        }
        if (closedAtCutoff.length === 0) throw Object.assign(new Error('NO_NATIVE_CLOSED_4H'), {code:'NO_NATIVE_CLOSED_4H'});
        factsModule.assertNativeFourHourSequence(closedAtCutoff);
        var latest = closedAtCutoff[closedAtCutoff.length - 1];
        return {
            candles: closedAtCutoff,
            latest: latest,
            key: [symbol, latest.closeTime, PROMPT_HASH, FACT_SET_VERSION].join('|')
        };
    }

    // Synchronous production boundary: it never performs network I/O. A miss is
    // frozen as UNAVAILABLE so research context cannot delay WATCH creation.
    function peek(evaluationTime) {
        try {
            var visible = visibleSnapshot(evaluationTime);
            var cached = cache.get(visible.key);
            if (cached && cached.sourceEvaluationTime <= evaluationTime) {
                return availableContext(evaluationTime, visible.latest.closeTime, cached.decision);
            }
            return unavailable(evaluationTime, 'V2_CONTEXT_CACHE_MISS');
        } catch (error) {
            return unavailable(evaluationTime, stableErrorCode(error));
        }
    }

    function resolve(evaluationTime) {
        return Promise.resolve().then(function () {
            var visible = visibleSnapshot(evaluationTime);
            var latest = visible.latest;
            var key = visible.key;
            var cached = cache.get(key);
            if (cached && cached.sourceEvaluationTime <= evaluationTime) {
                return availableContext(evaluationTime, latest.closeTime, cached.decision);
            }
            var pending = inFlight.get(key);
            if (pending && pending.sourceEvaluationTime <= evaluationTime) {
                return pending.promise.then(function (decision) {
                    return availableContext(evaluationTime, latest.closeTime, decision);
                });
            }
            var facts = factsModule.buildFacts(visible.candles, evaluationTime, {symbol:symbol});
            factsModule.assertCausality(facts);
            var request = Promise.resolve(requestDecision(clone(facts))).then(function (decision) {
                decision = synthesis.validateOutput(clone(decision));
                cache.set(key, {sourceEvaluationTime:evaluationTime,decision:clone(decision)});
                return decision;
            }).finally(function () {
                if (inFlight.get(key) && inFlight.get(key).promise === request) inFlight.delete(key);
            });
            inFlight.set(key, {sourceEvaluationTime:evaluationTime,promise:request});
            return request.then(function (decision) {
                return availableContext(evaluationTime, latest.closeTime, decision);
            });
        }).catch(function (error) {
            return unavailable(evaluationTime, stableErrorCode(error));
        });
    }

    return {
        resolve: resolve,
        peek: peek,
        cacheSize: function () { return cache.size; },
        _cache: cache
    };
}

function availableContext(evaluationTime, latestClosedCandleTime, decision) {
    return {
        status: 'AVAILABLE',
        researchOnly: true,
        evaluationTime: evaluationTime,
        latestClosedCandleTime: latestClosedCandleTime,
        direction: decision.direction,
        confidence: decision.confidence,
        dominantFacts: clone(decision.dominantFacts),
        conflictingFacts: clone(decision.conflictingFacts),
        stateInterpretation: decision.stateInterpretation,
        whatWouldChangeTheAssessment: clone(decision.whatWouldChangeTheAssessment),
        promptVersion: VERSION,
        promptHash: PROMPT_HASH,
        factSetVersion: FACT_SET_VERSION,
        model: MODEL,
        errorCode: null
    };
}

module.exports = {
    VERSION: VERSION,
    FACT_SET_VERSION: FACT_SET_VERSION,
    PROMPT_HASH: PROMPT_HASH,
    MODEL: MODEL,
    actualPromptHash: actualPromptHash,
    unavailable: unavailable,
    availableContext: availableContext,
    alignment: alignment,
    defaultRequestDecision: defaultRequestDecision,
    createService: createService
};
