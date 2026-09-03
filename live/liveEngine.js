/**
 * Phase 11L — Live Engine（实时机会雷达核心）
 *
 * 把回测的单根状态推进复用到实时。Production notification 的新入口是
 * valid Displacement -> backward matching liquidity -> Displacement Watch；legacy
 * Opportunity tier 继续返回给统计/兼容层，但不再决定 FVG retracement DingTalk。
 *
 * 与回测 11D.8 的一致性保证：
 *   - 复用同一批检测器（incrementalLiquidity / incrementalEvents / incrementalFvg /
 *     displacementDetector / amdState / rebuildSnapshot）
 *   - 内部维护全局 index 对齐的 candles 窗口（window.length === index+1，
 *     与回测 candles.slice(0, index+1) 语义完全一致）
 *   - A/C2 raw detections merge only through canonical overlap semantics
 *   - tier 判定复用 classifyOpportunityTier（同一阈值）
 *   - near target 取 snapshot.draw 的 near（与 drawTrace 同源）
 *
 * 不包含：gate / scenario 决策 / 交易执行 / 下单 —— 纯机会发现。
 */
var replayState = require('../replay/replayState');
var eventRegistry = require('../events/eventRegistry');
var displacementDetector = require('../events/displacementDetector');
var multiCandleDisplacementDetector = require('../events/multiCandleDisplacementDetector');
var amdState = require('../amd/amdState');
var replayEngine = require('../replay/replayEngine');
var opportunityQuality = require('../stats/opportunityQuality');
var nearStaleness = require('../stats/nearStaleness');
var liquidityProvenance = require('../stats/liquidityProvenance');
var alertPrioritization = require('../stats/alertPrioritization');
var structuralProvenance5m = require('../structure/structuralProvenance5m');
var displacementWatch = require('../stats/displacementWatch');
var watchLiquidityEvidenceV1 = require('../stats/watchLiquidityEvidenceV1');
var watchLiquidityEvidenceFlag = require('../config/watchLiquidityEvidenceV1');
var sweepContextFlag = require('../config/sweepContextV1');
var runtimeSwingContextV1 = require('../stats/runtimeSwingContextV1');
var dailyBiasAlignment = require('../bias/dailyBiasAlignment');
var thresholds = require('../config/thresholds');

function attachWatchLiquidityEvidenceV1(candidate, context) {
    var ctx = context || {};
    if (!ctx.enabled || !candidate) return candidate;
    // WatchLiquidityEvidenceV1 is a legacy Sweep-specific envelope. A Taken
    // WATCH must never put a Taken id into sweepEventId compatibility fields.
    if (candidate.liquidityTrigger === 'LIQUIDITY_TAKEN') return candidate;
    try {
        watchLiquidityEvidenceV1.attach(candidate, {
            enabled: true,
            evaluationTime: ctx.evaluationTime,
            registry: ctx.registry,
            candles: ctx.candles,
            dailyBias: ctx.dailyBias,
            sweepContextV1Enabled: ctx.sweepContextV1Enabled,
            projectSwingContextV1: ctx.projectSwingContextV1
        });
    } catch (e) {
        // P1 is observability-only: enrichment failure must never alter
        // WATCH existence, identity, direction, timing, or transitions.
        if (ctx.errors) ctx.errors.push({
            watchId: candidate.id,
            evaluationTime: ctx.evaluationTime,
            code: e && e.code || 'WATCH_LIQUIDITY_EVIDENCE_V1_ERROR',
            message: e && e.message || String(e)
        });
    }
    return candidate;
}

function attachDailyBias(opp, provider) {
    try {
        opp.dailyBias = provider
            ? provider(opp.direction, opp.availableAt, opp)
            : dailyBiasAlignment.unknownDailyBias();
    } catch (e) {
        opp.dailyBias = dailyBiasAlignment.unknownDailyBias();
    }
    return opp;
}

/**
 * @param {Object} data { symbol, exchangeInfo, structureCandles, calendarCandles, fetcher, thresholds }
 * @param {Object} [options] { snapshotInterval, baseIndex, dailyBiasProvider }
 * @returns {Object} engine
 */
function createLiveEngine(data, options) {
    var opts = options || {};
    var cfg = data.thresholds || thresholds;
    var symbol = data.symbol;
    var snapshotInterval = opts.snapshotInterval !== undefined ? opts.snapshotInterval : 12;
    var baseIndex = opts.baseIndex !== undefined ? opts.baseIndex : 0;
    var dailyBiasProvider = opts.dailyBiasProvider;
    var watchLiquidityEvidenceV1Enabled = opts.watchLiquidityEvidenceV1Enabled !== undefined
        ? !!opts.watchLiquidityEvidenceV1Enabled
        : watchLiquidityEvidenceFlag.isEnabled();
    var sweepContextV1Enabled = opts.sweepContextV1Enabled !== undefined
        ? !!opts.sweepContextV1Enabled : sweepContextFlag.isEnabled();

    var state = replayState.createReplayState({
        symbol: symbol,
        timeframe: '5m',
        snapshotInterval: snapshotInterval,
        fourHourCandles: data.structureCandles && data.structureCandles['4h'] || []
    });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var atrSeries = {};
    var prevAtr = null;
    state.atrSeries = atrSeries;
    var snapshot = null;
    // Fix 3（11L.3 P1）：engine 不再维护 pushed/去重集合 —— 机会只负责"检测并返回"，
    // 投递确认（钉钉 errcode=0）与去重（delivered）由 scripts/live.js 负责：
    //   钉钉失败 → 机会保留 pending，下轮重试；确认成功才记 delivered（跨重启持久化）。
    var window = []; // 全局 index 对齐的已收盘 5m 序列（window.length === 最后 index + 1）
    var watchById = {};
    var watchUpdates = [];
    var runtimeSwingContext = sweepContextV1Enabled ? runtimeSwingContextV1.createRuntimeSwingContextV1({
        symbol: symbol,
        initialCandles5m: data.contextCandles5m || [],
        structureCandles: data.structureCandles || {},
        getCandles5m: function () { return window; },
        getRegistry: function () { return state.registry; },
        getStructuralState: function () { return state.structural5m; }
    }) : null;

    var fullData = {
        symbol: symbol,
        fetcher: data.fetcher,
        structureCandles: data.structureCandles,
        calendarCandles: data.calendarCandles,
        exchangeInfo: data.exchangeInfo,
        thresholds: cfg
    };

    /**
     * Displacement-Centric Watch V1: canonical displacement is the trigger. Only
     * after it exists do we look backward for matching LIQUIDITY_TAKEN.
     * Native FVG is calculated from each displacement's own K1/K2/K3 candles;
     * state.fvgReg is deliberately not passed to the builder.
     */
    function emitDisplacementWatch(displacement, evaluationTime) {
        if (!displacement || !displacement.id) return null;
        var dailyBias;
        try {
            dailyBias = dailyBiasProvider
                ? dailyBiasProvider(displacement.direction, evaluationTime, { canonicalDisplacementId: displacement.id })
                : dailyBiasAlignment.unknownDailyBias();
        } catch (e) {
            dailyBias = dailyBiasAlignment.unknownDailyBias();
        }
        var candidate = displacementWatch.buildWatch({
            symbol: symbol,
            displacement: displacement,
            evaluationTime: evaluationTime,
            takenEvents: state.eventRegistry.getByType(symbol, 'LIQUIDITY_TAKEN'),
            candles: window,
            dailyBias: dailyBias,
            existing: watchById['WATCH:' + symbol + ':' + displacement.direction + ':DISPLACEMENT:' + displacement.id] || null
        });
        if (!candidate) return null;
        if (watchLiquidityEvidenceV1Enabled || sweepContextV1Enabled) {
            if (!state.watchLiquidityEvidenceV1Errors) state.watchLiquidityEvidenceV1Errors = [];
            attachWatchLiquidityEvidenceV1(candidate, {
                enabled: true,
                evaluationTime: evaluationTime,
                registry: state.registry,
                candles: window,
                dailyBias: dailyBias,
                sweepContextV1Enabled: sweepContextV1Enabled,
                projectSwingContextV1: runtimeSwingContext && runtimeSwingContext.projectSwingContextV1,
                errors: state.watchLiquidityEvidenceV1Errors
            });
        }
        var old = watchById[candidate.id];
        var changed = !old || displacementWatch.watchFingerprint(old) !== displacementWatch.watchFingerprint(candidate);
        watchById[candidate.id] = candidate;
        if (changed) watchUpdates.push(JSON.parse(JSON.stringify(candidate)));
        return candidate;
    }

    /**
     * 单根推进（5m 已收盘，index 必须 == window.length 且连续）。
     * 内部把 candle push 进 window 后，用完整 window 驱动检测器（全局 index 语义）。
     * @returns {Promise<Object|null>} 该根完成评估的新 HIGH 机会（若 leg 结束且 tier=HIGH 且未推送）
     */
    function onBar(candle, index) {
        if (index !== window.length) {
            throw new Error('liveEngine.onBar: index ' + index + ' != window.length ' + window.length + '（必须连续推进）');
        }
        window.push(candle);
        var i = index;
        var evaluationTime = candle.closeTime;

        // ---- 1. 增量 liquidity（全局 slice 语义） ----
        var newConfirmedSwings = replayState.incrementalLiquidity(state, window, i, data.exchangeInfo, evaluationTime);

        // ---- 2. 慢变量快照（每 snapshotInterval 根） ----
        var doSnapshot = (i === baseIndex) || (i - (state.lastSnapshotIndex !== undefined ? state.lastSnapshotIndex : baseIndex - snapshotInterval)) >= snapshotInterval;
        var snapshotPromise = doSnapshot
            ? replayEngine.rebuildSnapshot(state, window, i, evaluationTime, fullData).then(function (sn) {
                snapshot = sn;
                state.snapshot = sn;
                state.lastSnapshotIndex = i;
            })
            : Promise.resolve();

        return snapshotPromise.then(function () {
            // ---- 3. 增量 ATR ----
            prevAtr = replayEngine._updateAtrIncremental(atrSeries, window, i, prevAtr,
                cfg.events.displacement.multiCandle.atrPeriod);

            // ---- 4. Generic structural lifecycle + price-only Displacement ----
            var structuralStep = structuralProvenance5m.step(
                state.structural5m, candle, i, newConfirmedSwings
            );
            structuralStep.events.forEach(function (event) {
                state.eventRegistry.add(event);
            });
            var newDispRaw = displacementDetector.detectSingleCandleDisplacement([candle], {
                symbol: symbol, timeframe: '5m', baseIndex: i,
                atrSeries: atrSeries, thresholds: cfg
            });
            newDispRaw = newDispRaw.concat(multiCandleDisplacementDetector.detectAt(window, i, {
                symbol: symbol, timeframe: '5m', atrSeries: atrSeries, thresholds: cfg
            }));
            var newEvents = replayState.incrementalEvents(state, candle, i, evaluationTime, newDispRaw);

            // ---- 5. 持久 AMD ----
            amdState.updateAmdState(state.amd, {
                candle: candle, candleIndex: i,
                candles: window,
                evaluationTime: evaluationTime,
                symbol: symbol, timeframe: '5m',
                registry: state.registry,
                draw: snapshot ? snapshot.draw : null,
                newSweeps: newEvents.sweeps,
                newDisplacements: newEvents.displacements
            }, { thresholds: cfg });

            // ---- 6. 增量 FVG（全局 candles） ----
            var allDisp = state.displacementStore.getEndingFrom(
                Math.max(0, i - cfg.fvg.maxDisplacementBars), i, evaluationTime, symbol);
            replayState.incrementalFvg(state, window, candle, i, evaluationTime, data.exchangeInfo, allDisp);

            // ---- 6.5 逐根 drawTrace（canonical formation end 的 near） ----
            if (!state.drawTrace) state.drawTrace = [];
            if (snapshot && snapshot.draw) {
                state.drawTrace[i] = {
                    bslNear: snapshot.draw.bsl && snapshot.draw.bsl.near ? snapshot.draw.bsl.near.targetPrice : null,
                    bslMacro: snapshot.draw.bsl && snapshot.draw.bsl.macro ? snapshot.draw.bsl.macro.targetPrice : null,
                    sslNear: snapshot.draw.ssl && snapshot.draw.ssl.near ? snapshot.draw.ssl.near.targetPrice : null,
                    sslMacro: snapshot.draw.ssl && snapshot.draw.ssl.macro ? snapshot.draw.ssl.macro.targetPrice : null
                };
            } else {
                state.drawTrace[i] = { bslNear: null, bslMacro: null, sslNear: null, sslMacro: null };
            }

            // ---- 7. Canonical Displacement → WATCH / downstream opportunity ----
            var opp = null;
            (newEvents.displacements || []).forEach(function (d) {
                emitDisplacementWatch(d, evaluationTime);
                opp = evaluateOpportunity(d, i) || opp;
            });
            // A canonical ending on the previous candle may gain its native K3 FVG now.
            state.displacementStore.getEndingAt(i - 1, evaluationTime, symbol).forEach(function (d) {
                if (d.endIndex === i - 1) emitDisplacementWatch(d, evaluationTime);
            });
            return opp;
        });
    }

    /** Canonical Displacement downstream opportunity (legacy notification path is not used). */
    function evaluateOpportunity(displacement, availableIndex) {
        var oppId = 'DISPLACEMENT:' + displacement.id;
        var formationFvgs = state.fvgReg.getAll(symbol).filter(function (f) {
            return f.displacementEventId === displacement.id;
        });
        if (formationFvgs.length === 0) return null;
        var anchorIndex = displacement.endIndex;
        var anchorCandle = window[anchorIndex];
        if (!anchorCandle) return null;
        var delivery = opportunityQuality.describeCanonicalDelivery(displacement, window);
        var nearTarget = null;
        var dt = state.drawTrace && state.drawTrace[anchorIndex] ? state.drawTrace[anchorIndex] : null;
        if (dt) {
            nearTarget = displacement.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        }
        if (nearTarget === null && snapshot && snapshot.draw) {
            nearTarget = displacement.direction === 'BULLISH'
                ? (snapshot.draw.bsl && snapshot.draw.bsl.near ? snapshot.draw.bsl.near.targetPrice : null)
                : (snapshot.draw.ssl && snapshot.draw.ssl.near ? snapshot.draw.ssl.near.targetPrice : null);
        }
        var anchorPrice = anchorCandle.close;
        var nearDistPct = nearTarget !== null && nearTarget !== undefined && anchorPrice > 0
            ? Math.abs(nearTarget - anchorPrice) / anchorPrice * 100
            : null;

        var tier = opportunityQuality.classifyOpportunityTier({
            deliveryQuality: delivery.quality,
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });
        var availIdx = availableIndex !== undefined && availableIndex !== null ? availableIndex : anchorIndex;
        var availCandle = window[availIdx];
        var dtAvail = state.drawTrace && state.drawTrace[availIdx] ? state.drawTrace[availIdx] : null;
        var notifNear = null;
        if (dtAvail) {
            notifNear = displacement.direction === 'BULLISH' ? dtAvail.bslNear : dtAvail.sslNear;
        }
        if (notifNear === null || notifNear === undefined) {
            notifNear = nearTarget;
        }
        var notifPrice = availCandle ? availCandle.close : null;
        var notifDist = notifNear !== null && notifNear !== undefined && notifPrice !== null && notifPrice > 0
            ? Math.abs(notifNear - notifPrice) / notifPrice * 100
            : null;

        var opp = {
            id: oppId,
            tier: tier,
            direction: displacement.direction,
            deliveryQuality: delivery.quality,
            formationRangeAtr: delivery.rangeAtr,
            canonicalDisplacementId: displacement.id,
            anchorIndex: anchorIndex,
            anchorTime: anchorCandle.closeTime,
            anchorPrice: anchorPrice,
            availableIndex: availIdx,
            availableAt: availCandle ? availCandle.closeTime : displacement.confirmedAt,
            closeReason: 'canonical-confirmation',
            nearTarget: nearTarget,
            nearDistPct: nearDistPct,
            // Phase 11L.7：通知时点快照（消息显示 / post-alert 统计基准）
            notificationPrice: notifPrice,
            notificationNearTarget: notifNear,
            notificationNearDistPct: notifDist,
            fvgCount: formationFvgs.length,
            nearConsumed: false
        };

        // 11L.5（P0-2）Near Draw stale-at-notification —— 数据结论（90d）：
        // "通知前 near 被触及/穿越"的机会 1h hit 反而更高（81% vs 剔除后 33-41%），
        // 触及 ≠ 失效（近端流动性被测试恰是机会生效标志）→ 用户决策【放弃 suppress】。
        // 仅标记 nearConsumed 供日志观察，不拦截任何 HIGH。
        if (tier === 'HIGH_QUALITY' && nearTarget !== null && nearTarget !== undefined && availIdx > anchorIndex) {
            var cons = nearStaleness.checkNearConsumed(nearTarget, displacement.direction, window, anchorIndex + 1, availIdx);
            opp.nearConsumed = cons.consumed;
        }

        // Phase 11L.8：Liquidity Provenance（Live/Replay 同一关联函数）。
        //   通知行 "Liquidity Taken:" 的数据源；sweep.confirmedAt <= availableAt（无 future leakage）。
        var availTime2 = availCandle ? availCandle.closeTime : (opp.availableAt !== undefined ? opp.availableAt : anchorCandle.closeTime);
        var sweepEventsAll = state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP');
        var prov = liquidityProvenance.associateSweeps({
            direction: displacement.direction,
            displacement: displacement,
            availableAt: availTime2,
            sweepEvents: sweepEventsAll,
            maxLookbackBars: null // 使用 thresholds.events.sweepProvenance.maxLookbackBars（当前 48）
        });
        opp.liquidityContext = prov;

        // Phase 11L.15 — Alert Prioritization（B 口径，用户选定；A 口径数据失败已关闭）：
        //   HIGH + 48 窗口内存在任一 Significant Liquidity（EQL/EQH/Session）
        //     → PRIORITY_HIGH（钉钉立即推）
        //   否则 → STANDARD_HIGH（只落日志 / shadow）
        // 硬约束：notifyPriority 只决定通知优先级，绝不回写 tier——
        // Detection（HIGH/WATCH/LOW）冻结，通知筛选层不得混进机会检测层。
        if (tier === 'HIGH_QUALITY') {
            opp.notifyPriority = alertPrioritization.windowHasSignificant(opp)
                ? 'PRIORITY_HIGH'
                : 'STANDARD_HIGH';
        }

        // Daily Bias V1 is reporting-only enrichment. It runs strictly after tier and
        // notifyPriority are finalized, and failures degrade to UNKNOWN without touching either.
        return attachDailyBias(opp, dailyBiasProvider);
    }

    function getState() { return state; }
    function getWindowLength() { return window.length; }

    var engine = {
        onBar: onBar,
        getState: getState,
        getWindowLength: getWindowLength,
        drainDisplacementWatchUpdates: function () {
            var out = watchUpdates.slice();
            watchUpdates = [];
            return out;
        },
        getDisplacementWatches: function () {
            return Object.keys(watchById).map(function (id) { return watchById[id]; });
        },
        symbol: symbol
    };
    engine.eqProductionModel = state.eqProductionModel;
    return engine;
}

module.exports = {
    attachWatchLiquidityEvidenceV1: attachWatchLiquidityEvidenceV1,
    createLiveEngine: createLiveEngine,
    attachDailyBias: attachDailyBias
};
