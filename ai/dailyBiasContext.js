/**
 * Frozen Daily Bias deterministic context builder.
 * Replays every visible 4H bar in time order; the final prompt still receives only 120 closed bars.
 */
var auditPivots = require('./auditPivots');
var auditMarketFacts = require('./auditMarketFacts');
var auditStructuralProvenance = require('./auditStructuralProvenance');

var WINDOW = 120;
var PIVOT_LEFT = 2;
var PIVOT_RIGHT = 2;

function buildDailyBiasContext(candles, evaluationTime) {
    var visible = (candles || []).filter(function (c) {
        return c.closed && c.closeTime <= evaluationTime;
    }).slice().sort(function (a, b) { return a.openTime - b.openTime; });

    if (visible.length < WINDOW) {
        throw new Error('Daily Bias requires at least ' + WINDOW + ' closed 4H candles; actual=' + visible.length);
    }

    var previousSnapshot = null;
    var pivots = null;
    var facts = null;
    var structural = null;
    for (var idx = 0; idx < visible.length; idx++) {
        pivots = auditPivots.detectPivots(visible, idx, {
            left: PIVOT_LEFT,
            right: PIVOT_RIGHT,
            window: WINDOW
        });
        facts = auditMarketFacts.computeMarketFacts(visible, idx, pivots, {
            deliveryHintEnabled: true
        });
        structural = auditStructuralProvenance.computeStructuralProvenance(
            visible, idx, pivots, {
                breaks: facts.breaks,
                previousSnapshot: previousSnapshot
            });
        previousSnapshot = structural;
    }

    return {
        candles: visible.slice(-WINDOW),
        confirmedSwings: { highs: pivots.highs, lows: pivots.lows },
        marketFacts: {
            sweeps: facts.sweeps,
            breaks: facts.breaks,
            protectedSwings: structural.protectedSwings,
            pendingProvenances: structural.pendingProvenances,
            penetrations: structural.penetrations,
            structuralEvents: structural.structuralEvents,
            structuralState: structural.structuralState,
            futureLeakViolations: structural.futureLeakViolations
        }
    };
}

module.exports = {
    buildDailyBiasContext: buildDailyBiasContext,
    WINDOW: WINDOW
};
