'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — single configuration source.
 *
 * Two independent switches (rollback contract, spec §63):
 *   TURNING_SIGNIFICANCE_SEMANTIC_ENABLED
 *     Computes/freezes semantic decisions. When false, no facts are built, no
 *     LLM is called, and no frozen decision is created.
 *   TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED
 *     Applies the eligibility result to the LIVE anchor universe (EQ historical
 *     partner + TP target). When false the legacy Dynamic-D universe is fully
 *     restored, while semantic evaluation may keep running as shadow research
 *     collection.
 *
 * Emergency rollback is therefore: LIVE_FILTER=false (+ keep SEMANTIC=true if
 * research data must not be lost). No code change is required to roll back.
 *
 * The V1 canary admits only SIGNIFICANT / VALID decisions whose confidence is
 * at least the configured minimum. Confidence is ordered LOW < MEDIUM < HIGH;
 * this is a threshold, not exact equality. A semantic failure must never fall
 * open.
 */

function bool(name, fallback) {
    if (process.env[name] === undefined) return fallback;
    return process.env[name] === 'true';
}

function loadConfig(env) {
    var source = env || process.env;
    function flag(name, fallback) {
        if (source[name] === undefined) return fallback;
        return source[name] === 'true';
    }
    var minimumConfidence = source.TURNING_SIGNIFICANCE_MINIMUM_CONFIDENCE || 'MEDIUM';
    if (['LOW', 'MEDIUM', 'HIGH'].indexOf(minimumConfidence) < 0) {
        throw new Error('TURNING_SIGNIFICANCE_MINIMUM_CONFIDENCE_INVALID');
    }
    var failClosed = flag('TURNING_SIGNIFICANCE_FAIL_CLOSED', true);
    if (!failClosed) throw new Error('TURNING_SIGNIFICANCE_FAIL_CLOSED_MUST_BE_TRUE_FOR_V1');
    var allowedLabels = (source.TURNING_SIGNIFICANCE_ALLOWED_LABELS || 'SIGNIFICANT,VALID')
        .split(',').map(function (label) { return label.trim(); }).filter(Boolean);
    if (allowedLabels.slice().sort().join('|') !== 'SIGNIFICANT|VALID') {
        throw new Error('TURNING_SIGNIFICANCE_ALLOWED_LABELS_MUST_BE_SIGNIFICANT_VALID_FOR_V1');
    }
    var semanticEnabled = flag('TURNING_SIGNIFICANCE_SEMANTIC_ENABLED', true);
    var liveFilterEnabled = flag('TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED', true);
    // A live filter without semantic evaluation could only ever produce an empty
    // anchor universe. The sanctioned rollback is LIVE_FILTER=false with
    // SEMANTIC=true (shadow research); the inverse is a hard misconfiguration.
    if (!semanticEnabled && liveFilterEnabled) {
        throw new Error('TURNING_SIGNIFICANCE_LIVE_FILTER_REQUIRES_SEMANTIC_ENABLED');
    }
    return Object.freeze({
        semanticEnabled: semanticEnabled,
        liveFilterEnabled: liveFilterEnabled,
        failClosed: failClosed,
        minimumConfidence: minimumConfidence,
        allowedLabels: Object.freeze(allowedLabels)
    });
}

module.exports = function loadTurningSignificanceConfig() { return loadConfig(); };
module.exports.loadConfig = loadConfig;
module.exports.bool = bool;
