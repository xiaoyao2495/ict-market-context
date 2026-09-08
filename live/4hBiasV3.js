'use strict';

var deepseekClient = require('../ai/deepseekClient');
var factBuilder = require('../bias/directionalContext/4hBiasFactsV3');
var semanticContract = require('../bias/4hBiasSemanticV3');

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

    function identity(closedAt) {
        return [symbol, closedAt, VERSION, factBuilder.VERSION, semanticContract.PROMPT_HASH].join('|');
    }

    function snapshot(closedAt, status, facts, semantic, error, generatedAt) {
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
            promptHash: semanticContract.PROMPT_HASH,
            model: semanticContract.MODEL,
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
            summary: next.semantic && next.semantic.summary || null,
            conflicts: next.semantic && next.semantic.conflicts || null,
            facts: clone(next.facts),
            promptHash: next.promptHash,
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
        var key = identity(latest.closeTime);
        if (inFlight.has(key)) return inFlight.get(key);

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
        var llmStarted = now();
        stats.llmCallCount += 1;
        // Invoke inside the promise chain: configuration/client failures such as
        // a synchronously missing API key must degrade to PARTIAL, not escape.
        var pending = Promise.resolve().then(function () {
            return requestSemantic(clone(input));
        }).then(function (semantic) {
            semantic = semanticContract.validateOutput(clone(semantic));
            return publish(snapshot(latest.closeTime, 'AVAILABLE', factSet.facts, semantic, null, now()), {
                buildDurationMs: buildDuration,
                llmDurationMs: now() - llmStarted
            });
        }).catch(function (error) {
            return publish(snapshot(latest.closeTime, 'PARTIAL', factSet.facts, null, errorView('SEMANTIC', error), now()), {
                buildDurationMs: buildDuration,
                llmDurationMs: now() - llmStarted
            });
        }).finally(function () {
            if (inFlight.get(key) === pending) inFlight.delete(key);
        });
        inFlight.set(key, pending);
        return pending;
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
