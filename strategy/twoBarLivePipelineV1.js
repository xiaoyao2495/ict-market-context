'use strict';

/**
 * TWO_BAR_LIVE_PIPELINE_V1 - the production per-bar pipeline.
 *
 * One closed 5m candle in:
 *   1. advance the shared Causal Dynamic-D state and the 5m Wilder ATR14
 *   2. take the Two-Bar candidates that COMPLETE on this bar (K2 = this bar)
 *   3. Two-Bar pattern LLM -> preceding-leg LLM  (only these two)
 *   4. TwoBarCurrentPoint -> Dynamic-D EQ match -> EqSetup
 *   5. deterministic BreakoutEntryPlan (4H direction gate, trigger, SL, TP, RR)
 *   6. hand the plan to breakoutExecutionV1
 *
 * This module is used by both the live runner and the causal replay, so the
 * replay exercises the real wiring rather than calling the rules directly.
 *
 * It never touches pivots, FVG, WATCH or any EQ/FVG semantic gate.
 */

var dynamicD = require('../liquidity/causalDynamicDHistoricalExtremes');
var twoBar = require('./twoBarReversalV1');
var rules = require('../execution/breakoutEntryRulesV1');

var VERSION = 'TWO_BAR_LIVE_PIPELINE_V1';
var ATR_PERIOD = 14;

function trueRange(candle, prevClose) {
    var range = candle.high - candle.low;
    if (prevClose === null || prevClose === undefined) return range;
    return Math.max(range, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
}

function emptyFunnel() {
    return {
        bars: 0, candidates: 0,
        patternRejected: 0, contextRejected: 0, eqNoPartner: 0, llmErrors: 0,
        patternClear: 0, contextAligned: 0, eqMatched: 0,
        htfRejected: 0, htfAligned: 0,
        alreadyCrossed: 0, noTarget: 0, rrRejected: 0,
        plans: 0, accepted: 0, noSetup: 0
    };
}

/**
 * @param {Object} options
 *   symbol, setupService (strategy/twoBarSetupV1), execution (breakoutExecutionV1),
 *   observe, getBias, getExpected4hClosedAt, getSymbolRules, getCurrentContractPrice
 */
function createPipeline(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var setupService = opts.setupService;
    var execution = opts.execution;
    var observe = opts.observe || function () {};
    var getBias = opts.getBias || function () { return null; };
    var getExpected4hClosedAt = opts.getExpected4hClosedAt || function () { return null; };
    var getSymbolRules = opts.getSymbolRules || function () { return null; };
    var getCurrentContractPrice = opts.getCurrentContractPrice || function () { return null; };

    var dynamicDState = dynamicD.createState({ symbol: symbol });
    var atrValue = null;
    var atrSeedSum = 0;
    var lastIndex = (opts.startIndex === undefined ? 0 : opts.startIndex) - 1;
    var funnel = emptyFunnel();
    var frozenSetupIds = {};

    function advanceDynamicD(candles, index) {
        var candle = candles[index];
        if (index > 0) {
            var tr = trueRange(candle, candles[index - 1].close);
            if (index <= ATR_PERIOD) atrSeedSum += tr;
            if (index === ATR_PERIOD) atrValue = atrSeedSum / ATR_PERIOD;
            else if (index > ATR_PERIOD && atrValue !== null) {
                atrValue = (atrValue * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
            }
        }
        dynamicD.pruneSurvivalBeforeBar(dynamicDState, index - dynamicD.LOOKBACK_BARS - 2);
        var step = dynamicD.step(dynamicDState, candle, index, candles);
        return step.dynamicDPoints || [];
    }

    /**
     * Process exactly one newly closed bar.
     * @returns {Promise<Object>} the funnel delta for this bar
     */
    function onClosedBar(candles, index) {
        if (index !== lastIndex + 1) {
            return Promise.reject(new Error(VERSION + ' requires continuous incremental bars'));
        }
        lastIndex = index;
        funnel.bars += 1;
        var candle = candles[index];
        var newPoints = advanceDynamicD(candles, index);
        var evaluationTime = candle.closeTime;

        var delta = { index: index, candidates: 0, setups: [], plans: [], reasons: [] };
        if (execution) {
            execution.onDynamicD(newPoints, evaluationTime);
        }
        if (!setupService) return Promise.resolve(delta);

        // only candidates whose K2 is this bar
        var candidates = twoBar.detectCandidates(candles).filter(function (c) {
            return c.endIndex === index;
        });
        delta.candidates = candidates.length;
        funnel.candidates += candidates.length;
        if (candidates.length === 0) return Promise.resolve(delta);

        var chain = Promise.resolve();
        candidates.forEach(function (candidate) {
            chain = chain.then(function () {
                return setupService.evaluateCandidate(candidate, {
                    candles: candles, atrValue: atrValue, dynamicDState: dynamicDState, currentBarIndex: index
                }).then(function (result) {
                    if (result.status !== 'SETUP') {
                        funnel.noSetup += 1;
                        if (result.reason === 'PATTERN_NOT_CLEAR') funnel.patternRejected += 1;
                        else if (result.reason === 'CONTEXT_NOT_ALIGNED' ||
                                result.reason === 'INSUFFICIENT_CONTEXT') funnel.contextRejected += 1;
                        else if (result.reason === 'NO_DYNAMIC_D_EQ_PARTNER') funnel.eqNoPartner += 1;
                        else funnel.llmErrors += 1;
                        delta.reasons.push({ reason: result.reason, stage: result.stage });
                        return null;
                    }
                    funnel.eqMatched += 1;
                    var setup = result.setup;
                    if (frozenSetupIds[setup.id]) return null;
                    frozenSetupIds[setup.id] = true;
                    delta.setups.push(setup);
                    if (execution) execution.onTwoBar(setup);
                    var bias = getBias();
                    var biasForGate = bias ? Object.assign({}, bias, {
                        expectedClosedAt: getExpected4hClosedAt()
                    }) : null;
                    var built = rules.buildBreakoutPlan(setup, {
                        symbolRules: getSymbolRules(),
                        bias: biasForGate,
                        currentContractPrice: getCurrentContractPrice(),
                        dynamicDPoints: dynamicDState.recentSurvivalPoints,
                        candles: candles,
                        anchorEligibility: null,
                        liveTradingEnabled: opts.liveTradingEnabled === true
                    });
                    if (!built.ok) {
                        if (built.reasonCode === 'HTF_UNAVAILABLE' || built.reasonCode === 'HTF_NEUTRAL' ||
                                built.reasonCode === 'HTF_NOT_ALIGNED') funnel.htfRejected += 1;
                        else if (built.reasonCode === 'ENTRY_TRIGGER_ALREADY_CROSSED') funnel.alreadyCrossed += 1;
                        else if (built.reasonCode === 'NO_VALID_DYNAMIC_D_TARGET') funnel.noTarget += 1;
                        else funnel.rrRejected += 1;
                        delta.reasons.push({ reason: built.reasonCode, setupId: setup.id });
                        return execution.onTwoBar(setup);
                    }
                    funnel.htfAligned += 1;
                    funnel.plans += 1;
                    delta.plans.push(built.plan);
                    if (!execution) return null;
                    return execution.onSetup(built).then(function (submit) {
                        if (submit && (submit.status === 'SHADOW_ORDER' ||
                                submit.status === 'BREAKOUT_ENTRY_PENDING')) funnel.accepted += 1;
                        return null;
                    });
                });
            });
        });
        return chain.then(function () { return delta; });
    }

    return {
        VERSION: VERSION,
        /**
         * Advance Dynamic-D + ATR over already-closed history without running the
         * setup stages, so the first live bar has a warm causal context.
         */
        warmupThrough: function (candles, endIndex) {
            for (var i = lastIndex + 1; i <= endIndex; i++) {
                advanceDynamicD(candles, i);
                lastIndex = i;
                funnel.bars += 1;
            }
            return { bars: lastIndex + 1, atr: atrValue };
        },
        onClosedBar: onClosedBar,
        funnel: function () {
            var out = JSON.parse(JSON.stringify(funnel));
            // Stage counts are derived because the setup service fails closed with a
            // single reason: a candidate that is not rejected at the pattern stage
            // was pattern-CLEAR by construction. llmErrors are attributed to the
            // pattern stage (conservative: they are removed before patternClear).
            out.patternClear = out.candidates - out.patternRejected - out.llmErrors;
            out.contextAligned = out.patternClear - out.contextRejected;
            out.htfAligned = out.eqMatched - out.htfRejected;
            return out;
        },
        dynamicDState: function () { return dynamicDState; },
        atr: function () { return atrValue; }
    };
}

module.exports = { VERSION: VERSION, createPipeline: createPipeline, emptyFunnel: emptyFunnel };
