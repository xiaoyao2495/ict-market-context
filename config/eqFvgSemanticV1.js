'use strict';

function bool(name, fallback) {
    if (process.env[name] === undefined) return fallback;
    return process.env[name] === 'true';
}

module.exports = function loadEqFvgSemanticConfig() {
    var confidence = process.env.EQ_FVG_SEMANTIC_REQUIRED_CONFIDENCE || 'HIGH';
    if (confidence !== 'HIGH') throw new Error('EQ_FVG_SEMANTIC_REQUIRED_CONFIDENCE_MUST_BE_HIGH_FOR_V1');
    var failClosed = bool('EQ_FVG_SEMANTIC_FAIL_CLOSED', true);
    if (!failClosed) throw new Error('EQ_FVG_SEMANTIC_FAIL_CLOSED_MUST_BE_TRUE_FOR_V1');
    return Object.freeze({
        enabled: bool('EQ_FVG_SEMANTIC_ENABLED', true),
        liveGateEnabled: bool('EQ_FVG_SEMANTIC_LIVE_GATE_ENABLED', true),
        failClosed: failClosed,
        requiredConfidence: confidence
    });
};
