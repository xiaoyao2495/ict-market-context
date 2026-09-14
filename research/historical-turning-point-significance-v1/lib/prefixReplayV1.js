'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — deterministic prefix replay.
 *
 * Reconstructs the exact Production per-bar sequence over an arbitrary 5m candle
 * prefix, using the SAME production modules the live engine uses. It exists so
 * that semantic facts can be rebuilt AS OF any candidate.confirmedAt, and so the
 * prefix/full-history parity gate (spec §70) has a single canonical driver.
 *
 * It is a research/verification harness. It changes no production rule and owns
 * no threshold. Detection remains productionDynamicD (via replayState).
 *
 * Read-only guarantee: this module only reads candles. Nothing after the final
 * supplied candle can influence any output.
 */

var path = require('path');
var ROOT = path.join(__dirname, '..', '..', '..');

var replayState = require(path.join(ROOT, 'replay', 'replayState'));
var replayEngine = require(path.join(ROOT, 'replay', 'replayEngine'));
var eventRegistry = require(path.join(ROOT, 'events', 'eventRegistry'));
var displacementDetector = require(path.join(ROOT, 'events', 'displacementDetector'));
var multiCandleDisplacementDetector = require(path.join(ROOT, 'events', 'multiCandleDisplacementDetector'));
var thresholds = require(path.join(ROOT, 'config', 'thresholds'));

/**
 * Advance a production-identical replay over `candles` (already sorted,
 * continuous, closed 5m).
 *
 * `options.checkpoints` — optional array of candle closeTime values. When a bar
 * whose closeTime matches is reached, the state AT THAT BAR is captured:
 *
 *   { candles: window.slice(),                  // prefix ending on this bar
 *     swingIds: state.swings.map(...),          // confirmed swings as of now
 *     swings: state.swings.slice(),
 *     displacements: state.displacementStore.getAsOf(closeTime, symbol) }
 *
 * Snapshotting inside the single pass is exactly equivalent to re-running the
 * whole replay on the truncated prefix (the loop body is a pure function of the
 * candles seen so far), but it is O(N) instead of O(N * checkpoints). The parity
 * gate (spec §70) uses it to prove prefix/full-history fact identity.
 *
 * @returns {Object} {
 *   dynamicDPoints  every confirmed Dynamic-D candidate, in confirmation order
 *   equalLiquidity  every confirmed production EQ observation
 *   swings          every confirmed causal 2L/2R swing
 *   checkpoints     { <closeTime>: snapshot } (only when requested)
 *   state           final replay state (displacementStore / swings / productionEq)
 * }
 */
function runPrefixReplay(candles, options) {
    var opts = options || {};
    var symbol = opts.symbol || 'BTCUSDT';
    var cfg = opts.thresholds || thresholds;
    var requested = opts.checkpoints || null;
    var checkpoints = {};
    var pending = {};
    if (requested) {
        for (var c = 0; c < requested.length; c++) pending[requested[c]] = true;
    }
    var state = replayState.createReplayState({ symbol: symbol, timeframe: '5m' });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var atrSeries = {};
    var prevAtr = null;
    var window = [];
    var dynamicDPoints = [];
    var equalLiquidity = [];
    var swings = [];

    for (var i = 0; i < candles.length; i++) {
        var candle = candles[i];
        if (!candle || candle.closed === false) {
            throw new Error('TURNING_SIGNIFICANCE_PREFIX_REQUIRES_CLOSED_CANDLES');
        }
        window.push(candle);
        var evaluationTime = candle.closeTime;

        var liquidityStep = replayState.incrementalLiquidity(state, window, i, null, evaluationTime);
        var added = liquidityStep || [];
        for (var s = 0; s < added.length; s++) swings.push(added[s]);
        // incrementalLiquidity advances the Dynamic-D detector internally; the
        // newly confirmed candidates are exposed on the production EQ state.
        var confirmed = state.productionEq.dynamicD.confirmedPoints;
        for (var d = dynamicDPoints.length; d < confirmed.length; d++) dynamicDPoints.push(confirmed[d]);
        for (var e = equalLiquidity.length; e < state.productionEq.events.length; e++) equalLiquidity.push(state.productionEq.events[e]);

        prevAtr = replayEngine._updateAtrIncremental(atrSeries, window, i, prevAtr,
            cfg.events.displacement.multiCandle.atrPeriod);
        var rawDisplacements = displacementDetector.detectSingleCandleDisplacement([candle], {
            symbol: symbol, timeframe: '5m', baseIndex: i, atrSeries: atrSeries, thresholds: cfg
        });
        rawDisplacements = rawDisplacements.concat(multiCandleDisplacementDetector.detectAt(window, i, {
            symbol: symbol, timeframe: '5m', atrSeries: atrSeries, thresholds: cfg
        }));
        replayState.incrementalEvents(state, candle, i, evaluationTime, rawDisplacements);

        if (pending[evaluationTime]) {
            delete pending[evaluationTime];
            checkpoints[evaluationTime] = {
                closeTime: evaluationTime,
                barIndex: i,
                candles: window.slice(),
                swings: state.swings.slice(),
                displacements: state.displacementStore.getAsOf(evaluationTime, symbol)
            };
        }
    }

    return {
        symbol: symbol,
        dynamicDPoints: dynamicDPoints,
        equalLiquidity: equalLiquidity,
        swings: swings,
        checkpoints: checkpoints,
        state: state
    };
}

module.exports = { runPrefixReplay: runPrefixReplay };
