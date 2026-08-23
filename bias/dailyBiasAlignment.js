/**
 * Daily Bias -> Opportunity alignment (reporting only).
 * This module must never alter opportunity detection, tier, or notification policy.
 */

var BIAS_VALUES = ['BULLISH', 'BEARISH', 'UNCLEAR'];

function opportunitySide(direction) {
    if (direction === 'LONG' || direction === 'BULLISH') return 'BULLISH';
    if (direction === 'SHORT' || direction === 'BEARISH') return 'BEARISH';
    return null;
}

function computeBiasAlignment(biasOrSnapshot, opportunityDirection, status) {
    var snapshot = biasOrSnapshot && typeof biasOrSnapshot === 'object'
        ? biasOrSnapshot : { bias: biasOrSnapshot, status: status || 'VALID' };
    var snapshotStatus = snapshot.status || status || 'VALID';
    if (snapshotStatus === 'STALE' || snapshotStatus === 'UNKNOWN') return 'UNKNOWN';

    var bias = snapshot.bias;
    if (bias === 'UNCLEAR') return 'UNCLEAR';
    if (BIAS_VALUES.indexOf(bias) < 0) return 'UNKNOWN';

    var side = opportunitySide(opportunityDirection);
    if (!side) return 'UNKNOWN';
    return bias === side ? 'MATCH' : 'OPPOSITE';
}

function unknownDailyBias() {
    return {
        bias: 'UNKNOWN',
        confidence: null,
        alignment: 'UNKNOWN',
        status: 'UNKNOWN',
        evaluationTime: null,
        ageMs: null
    };
}

module.exports = {
    computeBiasAlignment: computeBiasAlignment,
    opportunitySide: opportunitySide,
    unknownDailyBias: unknownDailyBias
};
