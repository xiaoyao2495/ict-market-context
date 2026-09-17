'use strict';

/**
 * TWO_BAR_SETUP_V1 - the production setup pipeline.
 *
 *   deterministic candidate -> pattern LLM -> (CLEAR) -> preceding-leg LLM
 *   -> CONTEXT_ALIGNED_TWO_BAR_REVERSAL -> Dynamic-D EQ match -> EqSetup
 *
 * The LLM is used for exactly two semantic tasks (pattern, preceding leg). After
 * the setup is context-aligned everything is deterministic: Dynamic-D matching,
 * EQ, entry, SL, TP, RR, order management. No EQ/FVG/entry semantic LLM exists.
 *
 * Fail-closed: timeout, invalid JSON, provider error, BORDERLINE, NOT_TREND or
 * INSUFFICIENT_CONTEXT all produce NO_SETUP.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var LIB = require('../research/reversalPatternSemanticAuditV1');
var twoBar = require('./twoBarReversalV1');
var deepseekClient = require('../ai/deepseekClient');

var VERSION = 'TWO_BAR_SETUP_V1';
var PROMPT_VERSION = 'TWO_BAR_REVERSAL_PROMPT_V1';
var MODEL = 'deepseek-v4-flash';
var EQ_TOLERANCE_ATR_MULTIPLIER = 0.7; // frozen, unchanged from production

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function canonical(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(canonical);
    return Object.keys(value).sort().reduce(function (acc, k) { acc[k] = canonical(value[k]); return acc; }, {});
}
function stable(value) { return JSON.stringify(canonical(value)); }

/** Frozen decision store: one immutable record per identity, create-if-absent. */
function createFileStore(dir) {
    function file(key) { return path.join(dir, key + '.json'); }
    return {
        lookup: function (key) {
            try {
                return JSON.parse(fs.readFileSync(file(key), 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
        },
        freeze: function (key, record) {
            fs.mkdirSync(dir, { recursive: true });
            var tmp = file(key) + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, stable(record), { flag: 'wx', mode: 0o600 });
            try {
                fs.linkSync(tmp, file(key));
                return { created: true, record: record };
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                return { created: false, record: JSON.parse(fs.readFileSync(file(key), 'utf8')) };
            } finally {
                try { fs.unlinkSync(tmp); } catch (ignore) {}
            }
        }
    };
}

function createMemoryStore() {
    var records = {};
    return {
        lookup: function (key) { return records[key] ? JSON.parse(JSON.stringify(records[key])) : null; },
        freeze: function (key, record) {
            if (records[key]) return { created: false, record: records[key] };
            records[key] = JSON.parse(JSON.stringify(record));
            return { created: true, record: records[key] };
        }
    };
}

/**
 * @param {Object} options
 *   symbol, decisionStore | decisionStoreDir, requestSemantic, observe
 */
function createService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var store = opts.decisionStore ||
        (opts.decisionStoreDir ? createFileStore(opts.decisionStoreDir) : createMemoryStore());
    var observe = opts.observe || function () {};
    var requestSemantic = opts.requestSemantic || function (systemPrompt, userPrompt) {
        return deepseekClient.chat({
            systemPrompt: systemPrompt,
            userPrompt: userPrompt,
            temperature: 0,
            maxTokens: deepseekClient.getAuditCompletionTokenLimit()
        }, { maxAttempts: 0 }).then(function (response) {
            return JSON.parse(response.text);
        });
    };

    function ask(key, systemPrompt, userPrompt, validate) {
        var cached = store.lookup(key);
        if (cached) return Promise.resolve({ decision: cached.decision, source: 'FROZEN_STORE' });
        return Promise.resolve()
            .then(function () { return requestSemantic(systemPrompt, userPrompt); })
            .then(function (parsed) {
                var decision = validate(parsed);
                var frozen = store.freeze(key, { decision: decision, promptVersion: PROMPT_VERSION });
                return { decision: frozen.record.decision, source: frozen.created ? 'LLM_FRESH' : 'FROZEN_STORE' };
            });
    }

    /**
     * Evaluate one deterministic candidate.
     * ctx: { candles, atrValue, dynamicDState, currentBarIndex }
     */
    function evaluateCandidate(candidate, ctx) {
        var k1 = candidate.windowBars[0];
        var k2 = candidate.windowBars[1];
        var confirmedAt = k2.closeTime;
        var patternKey = sha256(stable([symbol, candidate.direction, k1.openTime, k2.openTime,
            PROMPT_VERSION, MODEL, 'PATTERN']));
        var payload = LIB.buildUserPayload(symbol, '5m', candidate.windowBars, candidate.windowFacts, confirmedAt);
        LIB.assertWindowWithinConfirmation(candidate.windowBars, confirmedAt);
        LIB.assertNoFutureData(payload, confirmedAt);

        return ask(patternKey, LIB.SYSTEM_PROMPT, LIB.buildUserPrompt(payload), function (parsed) {
            return LIB.validateLlmOutput(parsed, 'TWO_BAR_REVERSAL');
        }).then(function (patternResult) {
            var matches = (patternResult.decision.matches || []).filter(function (m) {
                return m.pattern === 'TWO_BAR_REVERSAL';
            });
            var match = matches[0] || null;
            if (!match || match.label !== 'CLEAR') {
                observe({ event: 'TWO_BAR_PATTERN_REJECTED', symbol: symbol, k1OpenTime: k1.openTime,
                    label: match ? match.label : 'NONE' });
                return { status: 'NO_SETUP', reason: 'PATTERN_NOT_CLEAR', stage: 'PATTERN' };
            }
            var precedingBars = ctx.candles.slice(Math.max(0, candidate.startIndex - LIB.PRECEDING_MAX_BARS),
                candidate.startIndex);
            if (precedingBars.length < LIB.PRECEDING_MIN_BARS) {
                return { status: 'NO_SETUP', reason: 'INSUFFICIENT_CONTEXT', stage: 'CONTEXT' };
            }
            var upToK1 = ctx.candles.slice(0, candidate.startIndex + 1);
            var facts = LIB.buildPrecedingFacts(precedingBars, k1, upToK1);
            var expected = LIB.expectedContextDirection(candidate.direction);
            var contextPayload = LIB.buildContextPayload(symbol, '5m', candidate.direction, 'CLEAR',
                precedingBars, k1, k2, facts, confirmedAt);
            LIB.assertWindowWithinConfirmation(precedingBars.concat([k1, k2]), confirmedAt);
            LIB.assertNoFutureData(contextPayload, confirmedAt);
            var contextKey = sha256(stable([symbol, candidate.direction, k1.openTime, k2.openTime,
                PROMPT_VERSION, MODEL, 'CONTEXT']));
            return ask(contextKey, LIB.CONTEXT_SYSTEM_PROMPT, LIB.buildContextUserPrompt(contextPayload),
                function (parsed) { return LIB.validateContextOutput(parsed, expected); }
            ).then(function (contextResult) {
                var context = contextResult.decision;
                if (context.label !== 'CLEAR' || context.detectedDirection !== expected) {
                    observe({ event: 'TWO_BAR_CONTEXT_REJECTED', symbol: symbol, k1OpenTime: k1.openTime,
                        label: context.label, detected: context.detectedDirection });
                    return { status: 'NO_SETUP', reason: 'CONTEXT_NOT_ALIGNED', stage: 'CONTEXT' };
                }
                var currentPoint = twoBar.buildCurrentPoint(candidate, {
                    symbol: symbol,
                    patternConfidence: match.confidence,
                    contextConfidence: context.confidence,
                    contextDetectedDirection: context.detectedDirection,
                    contextEstimatedLegBars: context.estimatedLegBars
                });
                var tolerance = ctx.atrValue * EQ_TOLERANCE_ATR_MULTIPLIER;
                var partners = twoBar.matchDynamicDPartners(ctx.dynamicDState, currentPoint, tolerance,
                    ctx.currentBarIndex);
                if (partners.length === 0) {
                    observe({ event: 'TWO_BAR_EQ_NO_PARTNER', symbol: symbol, twoBarId: currentPoint.id,
                        price: currentPoint.price, tolerance: tolerance });
                    return { status: 'NO_SETUP', reason: 'NO_DYNAMIC_D_EQ_PARTNER', stage: 'EQ',
                        currentPoint: currentPoint };
                }
                var setup = twoBar.buildEqSetup(currentPoint, partners, tolerance);
                observe({ event: 'TWO_BAR_SETUP_CONFIRMED', symbol: symbol, setupId: setup.id,
                    direction: setup.direction, eqType: setup.type, twoBarId: setup.twoBarId,
                    k1OpenTime: setup.k1OpenTime, k2OpenTime: setup.k2OpenTime,
                    partnerId: setup.nearestPartnerId, eqDistance: setup.eqDistance,
                    eqTolerance: setup.eqTolerance, availableAt: setup.availableAt });
                return { status: 'SETUP', setup: setup, patternSource: patternResult.source,
                    contextSource: contextResult.source };
            });
        }).catch(function (error) {
            observe({ event: 'TWO_BAR_SETUP_ERROR', symbol: symbol, code: (error && error.code) || 'LLM_ERROR',
                message: (error && error.message) || String(error) });
            return { status: 'NO_SETUP', reason: 'LLM_ERROR', stage: 'LLM',
                errorCode: (error && error.code) || 'LLM_ERROR' };
        });
    }

    return { evaluateCandidate: evaluateCandidate, store: store, VERSION: VERSION };
}

module.exports = {
    VERSION: VERSION,
    PROMPT_VERSION: PROMPT_VERSION,
    MODEL: MODEL,
    EQ_TOLERANCE_ATR_MULTIPLIER: EQ_TOLERANCE_ATR_MULTIPLIER,
    createFileStore: createFileStore,
    createMemoryStore: createMemoryStore,
    createService: createService
};
