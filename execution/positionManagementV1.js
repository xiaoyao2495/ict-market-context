'use strict';

/**
 * POSITION_MANAGEMENT_V1 - deterministic dynamic SL / TP rules.
 *
 * SL is monotonic risk tightening:
 *   LONG  may only move UP,   SHORT may only move DOWN.
 * TP is a dynamic target repricing and may move in BOTH directions.
 *
 * Every update consumes only causally confirmed Dynamic-D points whose
 * confirmedAt is strictly after the position opened.
 */

var VERSION = 'POSITION_MANAGEMENT_V1';

function finite(v) { return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)); }

/**
 * §33/§34 dynamic stop.
 * @param {string} direction LONG | SHORT
 * @param {number} currentStop
 * @param {number} candidate new Dynamic-D extreme (LOW for long, HIGH for short)
 * @param {number} currentMark current MARK_PRICE
 */
function nextStop(direction, currentStop, candidate, currentMark) {
    if (!finite(currentStop) || !finite(candidate) || !finite(currentMark)) {
        return { action: 'IGNORE', reason: 'NON_FINITE_INPUT' };
    }
    var stop = Number(currentStop);
    var cand = Number(candidate);
    var mark = Number(currentMark);
    if (direction === 'LONG') {
        if (!(cand > stop)) return { action: 'IGNORE', reason: 'WOULD_LOOSEN_STOP' };
        if (!(cand < mark)) return { action: 'IGNORE', reason: 'CANDIDATE_NOT_BELOW_MARK' };
        return { action: 'UPDATE', newStop: cand, reason: 'TIGHTEN_UP' };
    }
    if (!(cand < stop)) return { action: 'IGNORE', reason: 'WOULD_LOOSEN_STOP' };
    if (!(cand > mark)) return { action: 'IGNORE', reason: 'CANDIDATE_NOT_ABOVE_MARK' };
    return { action: 'UPDATE', newStop: cand, reason: 'TIGHTEN_DOWN' };
}

/**
 * §35/§36 dynamic target repricing - both directions are legal, the only
 * constraint is that the new target must sit in front of the current mark.
 */
function nextTarget(direction, currentTarget, candidate, currentMark) {
    if (!finite(candidate) || !finite(currentMark)) {
        return { action: 'IGNORE', reason: 'NON_FINITE_INPUT' };
    }
    var cand = Number(candidate);
    var mark = Number(currentMark);
    if (direction === 'LONG') {
        if (!(cand > mark)) return { action: 'IGNORE', reason: 'TARGET_NOT_ABOVE_MARK' };
    } else if (!(cand < mark)) {
        return { action: 'IGNORE', reason: 'TARGET_NOT_BELOW_MARK' };
    }
    if (finite(currentTarget) && Number(currentTarget) === cand) {
        return { action: 'IGNORE', reason: 'UNCHANGED' };
    }
    return { action: 'UPDATE', newTarget: cand, reason: 'REPRICE_TARGET' };
}

/** §37/§38 only causally confirmed points after the position opened may act. */
function isEligibleUpdate(point, positionOpenedAt, evaluationTime) {
    if (!point || typeof point.confirmedAt !== 'number' || typeof point.occurredAt !== 'number') return false;
    if (point.confirmedAt > evaluationTime) return false;
    if (typeof positionOpenedAt === 'number' && !(point.confirmedAt > positionOpenedAt)) return false;
    return true;
}

/**
 * §27 pending breakout entry invalidation.
 *   A: the stop level was traded before the trigger  -> invalidate
 *   B: a new opposite context-aligned Two-Bar confirmed -> invalidate
 */
function pendingEntryInvalidation(plan, ctx) {
    var o = ctx || {};
    if (!plan) return { cancel: false, reason: null };
    if (finite(o.currentContractPrice)) {
        var price = Number(o.currentContractPrice);
        if (plan.direction === 'LONG' ? price <= Number(plan.initialSL)
            : price >= Number(plan.initialSL)) {
            return { cancel: true, reason: 'INITIAL_SL_TRADED_BEFORE_BREAKOUT' };
        }
    }
    if (o.oppositeTwoBarConfirmed === true) {
        return { cancel: true, reason: 'OPPOSITE_TWO_BAR_CONFIRMED' };
    }
    return { cancel: false, reason: null };
}

/**
 * §39/§40 protection replacement order. New protection is placed and confirmed
 * BEFORE the old one is cancelled, so the position is never unprotected.
 */
var REPLACEMENT_SEQUENCE = ['PLACE_NEW', 'CONFIRM_NEW', 'CANCEL_OLD', 'RECONCILE'];

function replacementDecision(placeResult) {
    if (placeResult && placeResult.ok === true) {
        return { action: 'CANCEL_OLD', sequence: REPLACEMENT_SEQUENCE };
    }
    return { action: 'KEEP_OLD_AND_HALT_NEW_ENTRIES', sequence: REPLACEMENT_SEQUENCE,
        reason: 'NEW_PROTECTION_FAILED' };
}

module.exports = {
    VERSION: VERSION,
    REPLACEMENT_SEQUENCE: REPLACEMENT_SEQUENCE,
    nextStop: nextStop,
    nextTarget: nextTarget,
    isEligibleUpdate: isEligibleUpdate,
    pendingEntryInvalidation: pendingEntryInvalidation,
    replacementDecision: replacementDecision
};
