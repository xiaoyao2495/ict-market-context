'use strict';

/**
 * CROSS_SOURCE_PATH_INTEGRITY_V1 shadow replay - PHASE 2, fully OFFLINE.
 *
 * NOTHING in this file - or anything it requires - performs network I/O:
 *   it requires only `fs`-free pure modules: the Two-Bar detector, the Dynamic-D
 *   engine, the frozen path-integrity rule and the breakout entry rules.
 *   `scripts/research/crossSourcePathIntegrityShadowReplayV1.js` asserts at runtime that
 *   no network module is loaded before it calls into here.
 *
 * §1 the replay uses exactly the PRODUCTION deterministic chain, in production order:
 *
 *   detectCandidates -> buildCurrentPoint -> matchDynamicDPartners (tolerance)
 *     -> [ CROSS_SOURCE_PATH_INTEGRITY_V1 ]  <- the ONE variable
 *     -> buildEqSetup -> buildBreakoutPlan
 *
 * §2 before/after share the identical population. Two independent pipeline instances (two
 * separate Causal Dynamic-D states) are advanced in lockstep over the same bars. `matchDynamicDPartners`
 * MUTATES its state (AGE_EXPIRY / STRICT_CROSS), so the SWEEP SEMANTICS is an explicit,
 * documented precondition of this audit rather than a hidden side effect:
 *
 *   sweepMode='detached'  (default) the matcher runs against a DETACHED copy of the arm's
 *       survival list, so no candidate can retire a reference on behalf of another candidate.
 *       This is what production effectively does for the population under study: in production
 *       the matcher is reached ONLY after both Pattern and Context LLM gates, and this replay
 *       deliberately does NOT re-run those gates (§2: no re-call -> no population drift).
 *       Running an ungated sweep instead would substitute a *more* aggressive invalidation for
 *       the LLM gate and thereby hide the very defect this audit measures (whether the PATH
 *       filter catches a market-consumed reference).
 *   sweepMode='swept'     the matcher mutates the shared state, i.e. every candidate sweeps for
 *       every other candidate. Kept only as an ablation; it is NOT production-faithful.
 *
 * Either way the two arms advance through byte-identical states, so the only difference between
 * 'before' and 'after' is whether the frozen PATH filter is applied.
 *
 * The Pattern/Context LLM layer sits UPSTREAM of the matcher and is not re-run, so it cannot
 * drift between the arms: the measured population is the deterministic candidate population
 * that reaches the EQ stage. Every LLM-aligned Two-Bar is a subset of it.
 */

var twoBar = require('../../../strategy/twoBarReversalV1');
var pipelineMod = require('../../../strategy/twoBarLivePipelineV1');
var setupMod = require('../../../strategy/twoBarSetupV1');
var pathIntegrity = require('../../../strategy/crossSourcePathIntegrityV1');
var rules = require('../../../execution/breakoutEntryRulesV1');

var VERSION = 'PATH_INTEGRITY_OFFLINE_REPLAY_V1';
var MULT = setupMod.EQ_TOLERANCE_ATR_MULTIPLIER;
var SWEEP_MODES = ['detached', 'swept'];

function r6(value) {
    return value === null || value === undefined ? null : Math.round(value * 1e6) / 1e6;
}

function clonePoint(point) {
    var copy = {};
    Object.keys(point).forEach(function (key) { copy[key] = point[key]; });
    return copy;
}

/**
 * §2 the matcher's state input. `detached` hands it a copy of the survival list (and of every
 * point in it) so its AGE_EXPIRY / STRICT_CROSS mutations cannot leak to other candidates; the
 * arm's real state is used untouched, exactly as the plan builder expects.
 */
function stateForMatcher(arm, sweepMode) {
    var state = arm.dynamicDState();
    if (sweepMode === 'swept') return state;
    return { symbol: state.symbol, timeframe: state.timeframe,
        recentSurvivalPoints: state.recentSurvivalPoints.map(clonePoint) };
}

/** §2 invariant: in `detached` mode the arm's own ACTIVE reference universe must never change. */
function activeSignature(state) {
    return state.recentSurvivalPoints.filter(function (p) { return p && p.state === 'ACTIVE'; })
        .map(function (p) { return p.id; }).sort().join('|');
}

/**
 * §6/§7 the HTF gate is the FIRST gate in `buildBreakoutPlan` and it only checks DIRECTION
 * (strength/confidence are recorded, never gated). The replay neutralises it to the direction
 * aligned with the setup so that `initialSL` / `initialTP` / `initialRR` are comparable between
 * the arms and reflect the EQ + target geometry - which is what this audit measures. This does
 * not alter any rule, threshold or gate; it only chooses the replay's bias input.
 */
function frozenBias(direction, closedAt) {
    return {
        status: 'AVAILABLE',
        semantic: { direction: direction, strength: 'MODERATE', confidence: 'MEDIUM' },
        closedAt: closedAt,
        expectedClosedAt: closedAt
    };
}

/**
 * §7 classify an UNKNOWN (fail-closed) result WITHOUT touching the frozen rule: the rule reports
 * every fail-closed path as UNKNOWN/MISSING_INTERMEDIATE_BARS, so the specific cause is derived
 * here from the result's own fields plus the inputs.
 */
function classifyUnknown(result, twoBarPoint, partner) {
    if (!result || result.status !== 'UNKNOWN') return null;
    if (result.anchorOccurredAt === null || result.partnerPrice === null ||
            result.twoBarExtreme === null || result.k1OpenTime === null) {
        return 'MISSING_PROVENANCE';
    }
    if (!(result.anchorOccurredAt < result.k1OpenTime)) return 'OTHER';
    // A gap makes the rule bail out before it ever counts bars.
    if (result.intermediateBarCount === 0) return 'MISSING_INTERMEDIATE_BARS';
    return 'OTHER';
}

/** Extra, non-frozen diagnostic: was any candidate intermediate bar closing after confirmation? */
function hasFutureBar(bars, anchorOccurredAt, k1OpenTime, confirmedAt) {
    if (!bars || !(anchorOccurredAt < k1OpenTime)) return false;
    var found = false;
    for (var i = 0; i < bars.length; i++) {
        var bar = bars[i];
        if (!bar) continue;
        if (bar.openTime > anchorOccurredAt && bar.openTime < k1OpenTime) {
            if (bar.closeTime > confirmedAt) found = true;
        }
    }
    return found;
}

function summarizePlan(result) {
    if (!result) return { ok: false, reasonCode: 'NOT_EVALUATED' };
    if (!result.ok) {
        return { ok: false, reasonCode: result.reasonCode,
            partial: result.plan ? {
                partnerId: result.plan.dynamicDPartnerId,
                partnerPrice: result.plan.dynamicDPartnerPrice,
                entryTrigger: result.plan.entryTrigger
            } : null };
    }
    var p = result.plan;
    return {
        ok: true, reasonCode: null,
        partnerId: p.dynamicDPartnerId, partnerPrice: p.dynamicDPartnerPrice,
        eqType: p.eqType, eqDistance: r6(p.eqDistance), eqTolerance: r6(p.eqTolerance),
        entryTrigger: p.entryTrigger, initialSL: p.initialSL, initialTP: p.initialTP,
        initialRR: r6(p.initialRR), riskPrice: r6(p.initialRiskPrice),
        rewardPrice: r6(p.initialRewardPrice), targetDynamicDId: p.targetDynamicDId,
        targetPrice: p.targetPrice, requestedQty: p.requestedQty, htfDirection: p.htfDirection
    };
}

/**
 * §2/§3 evaluate ONE candidate under both arms.
 * `armBefore`/`armAfter` carry their own Dynamic-D state; both must already be advanced to
 * `currentBarIndex`.
 */
function evaluateCandidate(candidate, ctx) {
    var symbol = ctx.symbol;
    var candles = ctx.candles;
    var currentBarIndex = ctx.currentBarIndex;
    var armBefore = ctx.armBefore;
    var armAfter = ctx.armAfter;
    var sweepMode = ctx.sweepMode === 'swept' ? 'swept' : 'detached';
    var currentPoint = twoBar.buildCurrentPoint(candidate, { symbol: symbol });

    var activeBefore = activeSignature(armBefore.dynamicDState());
    var activeAfter = activeSignature(armAfter.dynamicDState());

    var partnersBefore = twoBar.matchDynamicDPartners(
        stateForMatcher(armBefore, sweepMode), currentPoint, ctx.tolerance, currentBarIndex);
    var partnersAfter = twoBar.matchDynamicDPartners(
        stateForMatcher(armAfter, sweepMode), currentPoint, ctx.tolerance, currentBarIndex);

    // §2 single-variable invariant: both arms saw the same population.
    var idsBefore = partnersBefore.map(function (p) { return p.id; }).join('|');
    var idsAfter = partnersAfter.map(function (p) { return p.id; }).join('|');
    var populationIdentical = idsBefore === idsAfter;
    if (!populationIdentical) {
        throw new Error('ARM_DIVERGENCE ' + symbol + ' ' + currentPoint.id +
            ' before=' + idsBefore + ' after=' + idsAfter);
    }
    // §2 in `detached` mode the matcher must not have touched either arm's reference universe.
    if (sweepMode === 'detached') {
        if (activeSignature(armBefore.dynamicDState()) !== activeBefore ||
                activeSignature(armAfter.dynamicDState()) !== activeAfter) {
            throw new Error('REPLAY_MUTATED_DYNAMIC_D_STATE ' + symbol + ' ' + currentPoint.id);
        }
    }

    var evaluations = partnersBefore.map(function (partner) {
        var chain = pathIntegrity.evaluateCrossSourcePathIntegrity({
            twoBar: currentPoint, partner: partner, bars: candles });
        var unknownReason = classifyUnknown(chain, currentPoint, partner);
        if (unknownReason === 'MISSING_INTERMEDIATE_BARS' &&
                hasFutureBar(candles, chain.anchorOccurredAt, chain.k1OpenTime, currentPoint.confirmedAt)) {
            unknownReason = 'FUTURE_DATA';
        }
        return {
            partnerId: partner.id, partnerPrice: partner.price,
            partnerOccurredAt: partner.occurredAt, partnerConfirmedAt: partner.confirmedAt,
            eqDistance: r6(Math.abs(currentPoint.price - partner.price)),
            status: chain.status, reason: chain.reason,
            ok: chain.ok === true, unknownReason: unknownReason,
            boundary: r6(chain.boundary),
            anchorOccurredAt: chain.anchorOccurredAt, k1OpenTime: chain.k1OpenTime,
            intermediateBarCount: chain.intermediateBarCount,
            minIntermediateLow: r6(chain.minIntermediateLow),
            maxIntermediateHigh: r6(chain.maxIntermediateHigh),
            violatingBarOpenTime: chain.violatingBar ? chain.violatingBar.openTime : null,
            violatingBarCloseTime: chain.violatingBar ? chain.violatingBar.closeTime : null,
            violatingLow: chain.violatingBar ? chain.violatingBar.low : null,
            violatingHigh: chain.violatingBar ? chain.violatingBar.high : null
        };
    });
    var accepted = evaluations.filter(function (e) { return e.ok === true; })
        .map(function (e) {
            return partnersBefore.filter(function (p) { return p.id === e.partnerId; })[0];
        });

    var beforeSetup = partnersBefore.length
        ? twoBar.buildEqSetup(currentPoint, partnersBefore, ctx.tolerance) : null;
    var afterSetup = accepted.length
        ? twoBar.buildEqSetup(currentPoint, accepted, ctx.tolerance) : null;

    var planCtx = function (setup) {
        return rules.buildBreakoutPlan(setup, {
            symbolRules: ctx.symbolRules,
            bias: frozenBias(currentPoint.direction, currentPoint.confirmedAt),
            currentContractPrice: ctx.contractPrice,
            dynamicDPoints: armBefore.dynamicDState().recentSurvivalPoints,
            candles: candles,
            anchorEligibility: null
        });
    };
    var beforePlan = beforeSetup ? summarizePlan(planCtx(beforeSetup)) : { ok: false, reasonCode: 'NO_DYNAMIC_D_EQ_PARTNER' };
    var afterPlan = afterSetup ? summarizePlan(planCtx(afterSetup)) : { ok: false, reasonCode: 'NO_DYNAMIC_D_EQ_PARTNER' };

    var oldPartnerId = partnersBefore.length ? partnersBefore[0].id : null;
    var newPartnerId = accepted.length ? accepted[0].id : null;
    var setupBefore = partnersBefore.length > 0;
    var setupAfter = accepted.length > 0;

    return {
        symbol: symbol, direction: currentPoint.direction, twoBarId: currentPoint.id,
        k1OpenTime: currentPoint.k1OpenTime, k2OpenTime: currentPoint.k2OpenTime,
        k2CloseTime: currentPoint.k2CloseTime, confirmedAt: currentPoint.confirmedAt,
        twoBarExtreme: currentPoint.price, twoBarLow: currentPoint.twoBarLow,
        twoBarHigh: currentPoint.twoBarHigh, extremeBar: currentPoint.extremeBar,
        atrAtConfirmation: r6(ctx.tolerance / MULT), eqTolerance: r6(ctx.tolerance),
        partnerCountBefore: partnersBefore.length,
        partnerCountAfter: accepted.length,
        evaluations: evaluations,
        before: beforePlan, after: afterPlan,
        flags: {
            setupBefore: setupBefore,
            setupAfter: setupAfter,
            oldPartnerId: oldPartnerId,
            newPartnerId: newPartnerId,
            partnerUnchanged: Boolean(setupBefore && setupAfter && oldPartnerId === newPartnerId),
            partnerReplaced: Boolean(setupBefore && setupAfter && oldPartnerId !== newPartnerId),
            setupRemoved: Boolean(setupBefore && !setupAfter),
            // §3 must be 0: the filter can only REMOVE candidates, never create one.
            setupCreatedByPathFilter: Boolean(!setupBefore && setupAfter)
        }
    };
}

/** §1/§3 one symbol, offline. Returns every EQ-stage candidate in the audit window. */
function replaySymbol(input) {
    var candles = input.candles;
    var window = input.window;
    var symbol = input.symbol;
    var sweepMode = input.sweepMode === 'swept' ? 'swept' : 'detached';
    var counts = {
        bars: candles.length, candidates: 0, candidatesInWindow: 0,
        eqToleranceMatches: 0, eqToleranceMatchesInWindow: 0,
        pathPass: 0, pathReject: 0, pathUnknown: 0,
        setupsBefore: 0, setupsAfter: 0,
        partnerUnchanged: 0, partnerReplaced: 0, setupRemoved: 0, setupCreatedByPathFilter: 0,
        planPreserved: 0, planLost: 0
    };
    var unknownReasons = { MISSING_INTERMEDIATE_BARS: 0, MISSING_PROVENANCE: 0, FUTURE_DATA: 0, OTHER: 0 };
    var samples = [];

    // The detector is a pure function of the whole series (exactly how the production pipeline
    // calls it each closed bar), so one pass + grouping by endIndex is production-equivalent.
    var candidates = twoBar.detectCandidates(candles);
    var byEndIndex = {};
    candidates.forEach(function (candidate) {
        if (!byEndIndex[candidate.endIndex]) byEndIndex[candidate.endIndex] = [];
        byEndIndex[candidate.endIndex].push(candidate);
    });

    var armBefore = pipelineMod.createPipeline({ symbol: symbol });
    var armAfter = pipelineMod.createPipeline({ symbol: symbol });

    for (var i = 1; i < candles.length; i++) {
        var warmedBefore = armBefore.warmupThrough(candles, i);
        var warmedAfter = armAfter.warmupThrough(candles, i);
        if (warmedBefore.atr !== warmedAfter.atr) {
            throw new Error('ARM_DIVERGENCE_ATR ' + symbol + ' at index ' + i);
        }
        var list = byEndIndex[i];
        if (!list || list.length === 0) continue;
        if (!(warmedBefore.atr > 0)) continue;
        var tolerance = warmedBefore.atr * MULT;
        var inWindow = candles[i].closeTime >= window.startTime &&
            candles[i].closeTime <= window.endTime;
        var contractPrice = candles[i].close;

        for (var c = 0; c < list.length; c++) {
            counts.candidates += 1;
            var sample = evaluateCandidate(list[c], {
                symbol: symbol, candles: candles, currentBarIndex: i, tolerance: tolerance,
                armBefore: armBefore, armAfter: armAfter, sweepMode: sweepMode,
                symbolRules: input.symbolRules, contractPrice: contractPrice
            });
            sample.inWindow = inWindow;
            if (!inWindow) continue;

            counts.candidatesInWindow += 1;
            if (sample.partnerCountBefore > 0) {
                counts.eqToleranceMatches += 1;
                counts.eqToleranceMatchesInWindow += 1;
            }
            sample.evaluations.forEach(function (e) {
                if (e.status === 'PASS') counts.pathPass += 1;
                else if (e.status === 'FAIL') counts.pathReject += 1;
                else {
                    counts.pathUnknown += 1;
                    var key = e.unknownReason || 'OTHER';
                    unknownReasons[key] = (unknownReasons[key] || 0) + 1;
                }
            });
            if (sample.flags.setupBefore) counts.setupsBefore += 1;
            if (sample.flags.setupAfter) counts.setupsAfter += 1;
            if (sample.flags.partnerUnchanged) counts.partnerUnchanged += 1;
            if (sample.flags.partnerReplaced) counts.partnerReplaced += 1;
            if (sample.flags.setupRemoved) counts.setupRemoved += 1;
            if (sample.flags.setupCreatedByPathFilter) counts.setupCreatedByPathFilter += 1;
            if (sample.before.ok && sample.after.ok) counts.planPreserved += 1;
            if (sample.before.ok && !sample.after.ok) counts.planLost += 1;
            samples.push(sample);
        }
    }
    samples.sort(function (a, b) {
        return a.confirmedAt - b.confirmedAt || String(a.twoBarId).localeCompare(String(b.twoBarId));
    });

    return { symbol: symbol, window: window, sweepMode: sweepMode, counts: counts,
        unknownReasons: unknownReasons, samples: samples };
}

module.exports = {
    VERSION: VERSION,
    MULT: MULT,
    SWEEP_MODES: SWEEP_MODES,
    r6: r6,
    clonePoint: clonePoint,
    stateForMatcher: stateForMatcher,
    activeSignature: activeSignature,
    frozenBias: frozenBias,
    classifyUnknown: classifyUnknown,
    hasFutureBar: hasFutureBar,
    summarizePlan: summarizePlan,
    evaluateCandidate: evaluateCandidate,
    replaySymbol: replaySymbol
};
