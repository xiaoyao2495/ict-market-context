/**
 * Event Engine —— 统一市场事件流水线
 *
 * 每根已收盘 candle：
 *   Liquidity lifecycle → Sweep adapter → MSS detector → Displacement detector → Event Registry
 *
 * 输出三类事件：
 *   LIQUIDITY_SWEEP / MSS / DISPLACEMENT
 *
 * 所有事件 confirmedAt = 触发 candle.closeTime。
 * deterministic + replay safe（只处理 closed candle，reference 只取已确认）。
 */
var lifecycle = require('../liquidity/liquidityLifecycle');
var sweepEventAdapter = require('./sweepEventAdapter');
var mssDetector = require('./mssDetector');
var displacementDetector = require('./displacementDetector');
var eventRegistry = require('./eventRegistry');

/**
 * @param {Object} input
 *   {
 *     symbol, timeframe,
 *     candles,           // 已收盘 K 线（升序）
 *     swings,            // SWING_HIGH / SWING_LOW liquidity
 *     liquidityRegistry, // 已含全部 liquidity（含 daily/weekly/...）的 registry
 *     eventRegistry      // 可选：传入则复用
 *   }
 * @returns {Object} { eventRegistry, sweepEvents, mssEvents, displacementEvents }
 */
function runEventEngine(input) {
    var symbol = input.symbol;
    var timeframe = input.timeframe || '5m';
    var candles = input.candles || [];
    var swings = input.swings || [];
    var liquidityRegistry = input.liquidityRegistry;
    var reg = input.eventRegistry || eventRegistry.createEventRegistry();

    var sweepEvents = [];
    var mssEvents = [];
    var displacementEvents = [];

    // ---- 1. Sweep：推进 lifecycle 并转事件 ----
    candles.forEach(function (candle, i) {
        if (candle.closed === false) {
            return;
        }
        if (!liquidityRegistry) {
            return;
        }
        liquidityRegistry.getAll(symbol).forEach(function (l) {
            if (l.confirmedAt > candle.closeTime) {
                return;
            }
            var result = lifecycle.evaluateLiquidity(l, candle);
            if (!result) {
                return;
            }
            liquidityRegistry.applyLifecycleEvent(l.id, result);
            if (result.status === 'SWEPT') {
                var ev = sweepEventAdapter.buildSweepEvent(l, candle, i, timeframe);
                if (ev && reg.add(ev)) {
                    sweepEvents.push(ev);
                }
            }
        });
    });

    // ---- 2. MSS ----
    mssEvents = mssDetector.detectMss(candles, swings, {
        symbol: symbol,
        timeframe: timeframe
    });
    mssEvents.forEach(function (ev) {
        reg.add(ev);
    });

    // ---- 3. Displacement（same-candle MSS bonus） ----
    displacementEvents = displacementDetector.detectDisplacement(candles, mssEvents, {
        symbol: symbol,
        timeframe: timeframe
    });
    displacementEvents.forEach(function (ev) {
        reg.add(ev);
    });

    return {
        eventRegistry: reg,
        sweepEvents: sweepEvents,
        mssEvents: mssEvents,
        displacementEvents: displacementEvents
    };
}

module.exports = {
    runEventEngine: runEventEngine
};
