/**
 * Replay Engine（Phase 11R — Persistent State Refactor）
 *
 * 每根 5m K 推进一次状态机（不是每 12 根采样决策）。
 *
 * 架构：
 *   每根 K（决策循环）：
 *     1. 增量 liquidity（新 swing/equal 去重加入持久 registry）
 *     2. 慢变量快照刷新（每 snapshotInterval=12 根）：calendar/cluster/draw/bias/scenario
 *     3. 增量事件：sweep（lifecycle×新K）+ mss/displacement（增量检测，持久 consumed/atrSeries）
 *     4. 持久 AMD（amd/amdState.js 增量状态机）
 *     5. 增量 FVG（新 K 形成 + 已有 FVG 逐根 lifecycle）
 *     6. Entry Gate（previousState 持久 → INVALIDATED 真正可达）
 *     7. Pending Trade 逐根增量模拟 + cancelCheck（scenario/AMD 失效 → CANCELLED）
 *     8. plan 生成（gate 跃迁 ENTRY_READY）+ transition 记录
 *
 * 正确性：
 *   - 所有事件 confirmedAt <= evaluationTime（candle.closeTime）
 *   - AMD accumulation 冻结 / FVG lifecycle 逐根 / Gate previousState / Trade 增量
 *   - stepBars 参数仅用于日志节流，不用于决策
 */
var thresholds = require('../config/thresholds');
var replayState = require('./replayState');
var amdState = require('../amd/amdState');
var eventRegistry = require('../events/eventRegistry');
var mssDetector = require('../events/mssDetector');
var displacementDetector = require('../events/displacementDetector');
var atrIndicator = require('../indicators/atr');
var dcStructuralSwing = require('../structure/dcStructuralSwing'); // Phase 12.5A：唯一实现
var dailyLiquidity = require('../liquidity/dailyLiquidity');
var weeklyLiquidity = require('../liquidity/weeklyLiquidity');
var monthlyLiquidity = require('../liquidity/monthlyLiquidity');
var sessionLiquidity = require('../liquidity/sessionLiquidity');
var liquidityCluster = require('../liquidity/liquidityCluster');
var liquidityScorer = require('../liquidity/liquidityScorer');
var drawEngine = require('../draw/drawEngine');
var biasEngine = require('../bias/biasEngine');
var swingClassifier = require('../structure/swingClassifier');
var dealingRange = require('../structure/dealingRange');
var premiumDiscount = require('../context/premiumDiscount');
var pivotDetector = require('../structure/pivotDetector');
var amdAlignment = require('../amd/amdAlignment');
var scenarioEngine = require('../scenario/scenarioEngine');
var entryGate = require('../entry/entryGate');
var tradePlan = require('../trade/tradePlan');
var stopPlanner = require('../trade/stopPlanner');
var retraceTracker = require('./retraceTracker');
var shadowEntry = require('../stats/shadowEntry');
var narrativeBoundary = require('../stats/narrativeBoundary');

var RIGHT = 2;
var STRUCTURE_TIMEFRAMES = ['1d', '4h', '1h'];

/**
 * 刷新慢变量快照（calendar + cluster + draw + structure + bias + scenario）
 * 返回 snapshot 对象；calendar liquidity 去重加入持久 registry。
 */
function rebuildSnapshot(state, candles, index, evaluationTime, data) {
    var symbol = state.symbol;
    var slice = candles.slice(0, index + 1);
    var currentPrice = slice[slice.length - 1].close;
    var fetcher = data.fetcher;
    var cfg = data.thresholds || thresholds;

    var p1 = dailyLiquidity.getDailyLiquidity(symbol, evaluationTime, { fetcher: fetcher });
    var p2 = weeklyLiquidity.getWeeklyLiquidity(symbol, evaluationTime, { fetcher: fetcher });
    var p3 = monthlyLiquidity.getMonthlyLiquidity(symbol, evaluationTime, { fetcher: fetcher });
    var p4 = Promise.all(['ASIA', 'LONDON', 'NEW_YORK'].map(function (name) {
        return sessionLiquidity.getSessionLiquidity(symbol, name, evaluationTime, { candles: slice });
    })).then(function (lists) {
        var out = [];
        lists.forEach(function (l) { out = out.concat(l); });
        return out;
    });

    return Promise.all([p1, p2, p3, p4]).then(function (more) {
        more.forEach(function (list) {
            list.forEach(function (l) {
                state.registry.add(l); // 去重加入持久 registry
            });
        });

        // ---- Cluster + Draw ----
        var all = state.registry.getAll(symbol);
        var clusters = liquidityCluster.buildClusters(all, {
            symbol: symbol, evaluationTime: evaluationTime, tickSize: data.exchangeInfo.tickSize
        });
        clusters.forEach(function (c) {
            var bd = liquidityScorer.scoreCluster(c, { thresholds: cfg.strength }); // scorer 期望 strength 段
            c.strength = bd.final;
            c.metadata.strengthBreakdown = bd;
        });
        var draw = drawEngine.runDrawEngine({
            symbol: symbol, currentPrice: currentPrice,
            evaluationTime: evaluationTime, registry: state.registry, clusters: clusters
        });

        // ---- Structure + Location ----
        var structures = {};
        STRUCTURE_TIMEFRAMES.forEach(function (tf) {
            var candlesTf = data.structureCandles[tf] || [];
            var ps = pivotDetector.detectPivots(candlesTf, { left: RIGHT, right: RIGHT });
            structures[tf] = swingClassifier.classifyStructure(ps, { timeframe: tf, evaluationTime: evaluationTime });
        });
        var pivots4h = pivotDetector.detectPivots(data.structureCandles['4h'] || [], { left: RIGHT, right: RIGHT });
        var range = dealingRange.buildDealingRange(pivots4h, { evaluationTime: evaluationTime });
        var location = premiumDiscount.classifyLocation(currentPrice, range, {});

        // ---- Bias ----
        var bias = biasEngine.runBiasEngine({
            symbol: symbol, evaluationTime: evaluationTime, timeframe: state.timeframe,
            draw: draw, structures: structures, location: location,
            events: {
                sweeps: state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP'),
                mss: state.eventRegistry.getByType(symbol, 'MSS'),
                displacements: state.eventRegistry.getByType(symbol, 'DISPLACEMENT')
            }
        }, { thresholds: cfg });

        return {
            draw: draw,
            bias: bias,
            structures: structures,
            location: location
        };
    });
}

/**
 * 持久 AMD → 快照版接口视图（供 scenario/alignment 消费）
 * 用 lastPhase（演进后状态）+ lastDirection（reset 后保留方向）
 */
function amdView(amd) {
    var phase = amd.lastPhase || amd.phase;
    var state = phase === 'ACCUMULATION' ? 'ACCUMULATION_CONFIRMED'
        : phase === 'MANIPULATION' ? 'MANIPULATION_CONFIRMED'
        : phase === 'DISTRIBUTION' ? 'DISTRIBUTION_CONFIRMED'
        : phase === 'INVALIDATED' ? 'INVALIDATED'
        : 'SEARCHING';
    return {
        state: state,
        direction: amd.direction || amd.lastDirection,
        score: 0,
        accumulation: amd.accumulation,
        manipulation: amd.manipulation,
        distribution: amd.distribution,
        confirmedAt: amd.confirmedAt,
        invalidationReason: amd.invalidationReason
    };
}

/**
 * 主回放入口（每根 K 决策）
 * @param {Object} data {
 *   symbol, candles5m, structureCandles, calendarCandles, exchangeInfo,
 *   startIndex, snapshotInterval, logEvery
 * }
 * @param {Object} [options] { thresholds, onStep }
 * @returns {Promise<Object>} { steps, trades, transitions, summary }
 */
function runReplay(data, options) {
    var opts = options || {};
    var cfg = opts.thresholds || thresholds;
    var snapshotInterval = opts.snapshotInterval !== undefined ? opts.snapshotInterval : 12;
    var logEvery = opts.logEvery !== undefined ? opts.logEvery : 12;
    var candles = data.candles5m;
    var startIndex = data.startIndex !== undefined ? data.startIndex : 90;
    var endIndex = candles.length - 1;
    var symbol = data.symbol;
    // Phase 11S.1：fullWarmup —— 0 → startIndex-1 也推进增量状态（liquidity/events/AMD/FVG/gate），
    // 但不记录 steps/transitions/plan。用于 WARMUP_STABILITY 验证 persistent state 是否收敛。
    var fullWarmup = !!opts.fullWarmup;
    var recordFrom = startIndex;

    var state = replayState.createReplayState({
        symbol: symbol,
        timeframe: '5m',
        snapshotInterval: snapshotInterval
    });
    state.eventRegistry = eventRegistry.createEventRegistry();

    // 增量 ATR 序列（displacement 检测用；声明在 warmup 之前，避免 var 提升覆盖）
    var atrSeries = {};
    var prevAtr = null;

    // ---- warmup：0 → startIndex-1 只推进指标（ATR），不记录决策 ----
    // Phase 11R.1：ATR 必须在正式 evaluation 前 seed 成熟，
    // 否则 startIndex 处 prevAtr=null → TR/14 错误放大 range/ATR、body/ATR。
    // fullWarmup 模式下 ATR 由 processBar 的增量循环自然推进（不单独 seed）。
    var w;
    if (!fullWarmup) {
        for (w = 0; w < startIndex; w++) {
            prevAtr = updateAtrIncremental(atrSeries, candles, w, prevAtr, 14);
        }
    }
    state.atrSeries = atrSeries; // 供 incrementalFvg 的全局 ATR 使用

    // ---- Phase 12.5A：DC 状态机 warmup（唯一实现 structure/dcStructuralSwing.js） ----
    // 前 startIndex 根不跑 processBar（性能），但 DC 状态机必须消费完整历史——
    // 否则初始 candidate 缺失、warmup 段确认的 swings 不进 dcRefPool →
    // MSS 口径与 12.4 shadow（全量 buildDcSwings + detectMss）不一致。
    // fullWarmup 模式下 processBar 从 0 开始逐根 step（含 DC），无需此处预热。
    var useDcWarm = !!(cfg.structure && cfg.structure.useDcStructuralSwing);
    if (useDcWarm && !fullWarmup && startIndex > 0) {
        state.dcState = dcStructuralSwing.createDcState(undefined, { baseIndex: 0 });
        for (w = 0; w < startIndex; w++) {
            var wsw = dcStructuralSwing.stepDcState(state.dcState, candles[w], w, candles);
            if (wsw) {
                state.dcRefPool.push(dcStructuralSwing.packageForMss(wsw, symbol, '5m', candles));
            }
        }
    }

    var fetcher = function (sym, interval, limit, st, et) {
        return Promise.resolve(data.calendarCandles[interval] || []);
    };
    var fullData = {
        symbol: symbol,
        fetcher: fetcher,
        structureCandles: data.structureCandles,
        calendarCandles: data.calendarCandles,
        exchangeInfo: data.exchangeInfo,
        thresholds: cfg
    };

    var steps = [];
    var snapshot = null;
    var prevGateState = null;

    // ---- Phase 11S.1：Retrace Diagnostics（只诊断，不改变正式 Gate） ----
    state.retraces = [];
    state.activeRetrace = null;
    // ---- Phase 11T.3：逐根 AMD boundary trace（诊断，trigger 时对比 WATCH 快照） ----
    state.amdTrace = [];
    // ---- Phase 11D.9：逐根 bias + HTF 趋势 trace（Delivery Alignment Audit 用） ----
    // h1Ptr/h4Ptr 指针推进：每根只比较最近两根已收盘 HTF close（O(1) 均摊，无 future data）
    // 注意：1h/4h 在 structureCandles（backtest 组装），calendarCandles 只有 1d/1w/1M
    var h1Candles = (data.structureCandles && data.structureCandles['1h']) ||
        (data.calendarCandles && data.calendarCandles['1h']) || [];
    var h4Candles = (data.structureCandles && data.structureCandles['4h']) ||
        (data.calendarCandles && data.calendarCandles['4h']) || [];
    var h1Ptr = 0;
    var h4Ptr = 0;

    function closeActiveRetrace(index, evaluationTime, reason) {
        var r = retraceTracker.closeRetrace(state.activeRetrace, index, evaluationTime, reason);
        // DIAGNOSTIC_SHADOW_ENTRY：旁路模拟（正式 ENTRY_READY 判定不受影响）
        r.shadowResults = shadowEntry.runShadowEntries(r, {
            candles: candles,
            atrSeries: state.atrSeries || {},
            amdTrace: state.amdTrace || [],
            thresholds: cfg
        });
        // Phase 11E.3：Entry Confirmation Counterfactual（只诊断）
        r.confirmationResults = shadowEntry.runEntryConfirmation(r, {
            candles: candles,
            thresholds: cfg
        });
        state.retraces.push(r);
        state.activeRetrace = null;
    }

    function processBar(i) {
        if (i > endIndex) {
            return Promise.resolve();
        }
        var candle = candles[i];
        var evaluationTime = candle.closeTime;
        state.index = i;

        // ---- 1. 增量 liquidity ----
        replayState.incrementalLiquidity(state, candles, i, data.exchangeInfo, evaluationTime);

        // ---- 2. 慢变量快照（每 snapshotInterval 根） ----
        var doSnapshot = (i === (fullWarmup ? 0 : startIndex)) ||
            (i - state.lastSnapshotIndex) >= snapshotInterval;
        var snapshotPromise = doSnapshot
            ? rebuildSnapshot(state, candles, i, evaluationTime, fullData).then(function (sn) {
                snapshot = sn;
                state.snapshot = sn;
                state.lastSnapshotIndex = i;
            })
            : Promise.resolve();

        return snapshotPromise.then(function () {
            // ---- 3. 增量 ATR（O(1) Wilder 更新） ----
            prevAtr = updateAtrIncremental(atrSeries, candles, i, prevAtr, 14);

            // ---- 4. 增量事件 ----
            // Phase 12.5A：MSS reference source 切换（flag=false legacy 2-2 swings / true DC STRUCTURAL_SWING）。
            //   Liquidity Registry / EQL/EQH / Sweep / Draw / Opportunity / Alert 全部不动，只换 reference 池。
            //   DC 模式：每根 step 状态机，确认的新 swing 包装后加入 dcRefPool；consumed 独立（不混 legacy）。
            var useDc = !!(cfg.structure && cfg.structure.useDcStructuralSwing);
            var mssPool = state.swings;
            var mssConsumed = state.consumedMssRefs || (state.consumedMssRefs = {});
            if (useDc) {
                if (!state.dcState) {
                    state.dcState = dcStructuralSwing.createDcState(undefined, { baseIndex: 0 });
                }
                var rawSw = dcStructuralSwing.stepDcState(state.dcState, candle, i, candles);
                if (rawSw) {
                    state.dcRefPool.push(dcStructuralSwing.packageForMss(rawSw, symbol, '5m', candles));
                }
                mssPool = state.dcRefPool;
                mssConsumed = state.dcConsumedMssRefs || (state.dcConsumedMssRefs = {});
            }
            // mss：只检测新 K，持久 consumedRefs
            var newMssRaw = mssDetector.detectMss([candle], mssPool, {
                symbol: symbol,
                timeframe: '5m',
                baseIndex: i,
                consumedRefs: mssConsumed,
                thresholds: cfg
            });
            // displacement：只检测新 K，增量 ATR 序列
            var newDispRaw = displacementDetector.detectDisplacement([candle], newMssRaw, {
                symbol: symbol,
                timeframe: '5m',
                baseIndex: i,
                atrSeries: atrSeries,
                thresholds: cfg
            });
            var newEvents = replayState.incrementalEvents(state, candle, i, evaluationTime, newMssRaw, newDispRaw);

            // ---- 5. 持久 AMD ----
            amdState.updateAmdState(state.amd, {
                candle: candle,
                candleIndex: i,
                candles: candles.slice(0, i + 1),
                evaluationTime: evaluationTime,
                symbol: symbol,
                timeframe: '5m',
                registry: state.registry,
                draw: snapshot ? snapshot.draw : null,
                newSweeps: newEvents.sweeps,
                newMss: newEvents.mss,
                newDisplacements: newEvents.displacements
            }, { thresholds: cfg });

            // ---- 6. 增量 FVG（显式传完整 candles，时间语义清晰） ----
            replayState.incrementalFvg(state, candles, candle, i, evaluationTime, data.exchangeInfo, allDisplacements(state));

            // ---- 7. Scenario（每根计算：bias/draw 用快照缓存，AMD 用当前持久状态） ----
            // 关键：AMD manipulation 是 5m 瞬态，scenario 必须每根反映，不能等 12 根快照。
            var scenario = null;
            var alignment = null;
            if (snapshot && snapshot.bias) {
                var amdNow = amdView(state.amd);
                var alignResult = amdAlignment.align(
                    snapshot.bias,
                    state.amd.direction || state.amd.lastDirection
                );
                alignment = alignResult.alignment;
                scenario = scenarioEngine.runScenarioEngine({
                    symbol: symbol,
                    evaluationTime: evaluationTime,
                    bias: snapshot.bias,
                    draw: snapshot.draw,
                    amd: amdNow,
                    alignment: alignment,
                    conflicts: snapshot.bias.conflicts,
                    delivery: snapshot.bias.components.delivery
                }, { thresholds: cfg });
                state.lastScenario = scenario; // 供 pendingTrade cancelCheck
            }

            // ---- 8. Entry Gate（previousState 持久） ----
            var gate = entryGate.runEntryGate({
                symbol: symbol,
                evaluationTime: evaluationTime,
                currentPrice: candle.close,
                candle: candle, // Phase 11E.7：gate 语义 shadow（wick-touch 检查）
                scenario: scenario,
                action: scenario ? scenario.action : 'WAIT',
                amd: amdView(state.amd),
                alignment: alignment,
                fvgs: state.fvgReg.getBefore(evaluationTime),
                previousState: state.gate.state
            }, { thresholds: cfg });
            state.gate = { state: gate.state, fvgId: gate.fvg ? gate.fvg.id : null };

            // ---- Phase 11E.7：gate 语义 shadow 聚合（只诊断） ----
            if (gate.stats) {
                var gs = state.gateShadow = state.gateShadow || {
                    touchButCloseOutside: 0, closeInside: 0,
                    candTotal: 0, lt40: 0, ge40lt60: 0, ge60: 0, noDisp: 0
                };
                gs.candTotal += gate.stats.candidates;
                gs.lt40 += gate.stats.scoreHist.lt40;
                gs.ge40lt60 += gate.stats.scoreHist.ge40lt60;
                gs.ge60 += gate.stats.scoreHist.ge60;
                gs.noDisp += gate.stats.noDisplacement;
                if (gate.state === 'WAITING_RETRACE' || gate.state === 'ENTRY_READY') {
                    if (gate.stats.wickTouchButCloseOutside) gs.touchButCloseOutside++;
                    else if (gate.state === 'ENTRY_READY') gs.closeInside++;
                }
            }

            // ---- 7.5 Retrace Tracker（Phase 11S.1，只诊断不改变正式 Gate） ----
            // 冻结 WATCH + WAITING_RETRACE + primary FVG 的 zone，逐根追踪真实价格距离。
            var isWatch = scenario &&
                (scenario.scenarioState === 'BULLISH_WATCH' || scenario.scenarioState === 'BEARISH_WATCH');
            var gateRetracing = gate.state === 'WAITING_RETRACE' && gate.fvg;
            if (isWatch && gateRetracing) {
                if (!state.activeRetrace) {
                    state.activeRetrace = retraceTracker.createRetrace({
                        symbol: symbol,
                        direction: scenario.scenarioState === 'BULLISH_WATCH' ? 'BULLISH' : 'BEARISH',
                        fvg: gate.fvg,
                        watchIndex: i,
                        watchAt: evaluationTime,
                        atr: prevAtr,
                        draw: snapshot ? snapshot.draw : null,
                        amd: amdView(state.amd),
                        swings: state.swings,
                        tickSize: data.exchangeInfo.tickSize,
                        candle: candle,
                        // Phase 11T.3：WATCH 时 alignment / bias 快照
                        alignment: alignment,
                        bias: snapshot && snapshot.bias ? snapshot.bias.direction : null
                    });
                }
                retraceTracker.updateRetrace(state.activeRetrace, candle, i, prevAtr);
            } else if (state.activeRetrace) {
                // WATCH 结束 / 正式成交 / 失效 → 关闭并分类
                var retraceCloseReason =
                    (state.amd.lastPhase === 'INVALIDATED' || gate.state === 'INVALIDATED')
                        ? retraceTracker.CLOSE_REASON.INVALIDATED
                        : retraceTracker.CLOSE_REASON.WATCH_END;
                closeActiveRetrace(i, evaluationTime, retraceCloseReason);
            }

            // ---- 8. plan 生成（gate 跃迁 ENTRY_READY；fullWarmup 时 warmup 段不生成 plan） ----
            // Phase 11T.5R：lastNarrative 生命周期 —— scenario direction flip / draw flip → 清空
            // 必须先于 TradePlan：plan 不能消费到 stale 旧方向 narrative
            if (state.amd.lastNarrative && snapshot && scenario &&
                narrativeBoundary.shouldClearLastNarrative(
                    state.amd.lastNarrative,
                    scenario.scenarioState,
                    snapshot.draw ? snapshot.draw.direction : null
                )) {
                state.amd.lastNarrative = null;
            }

            // ---- 8. Entry Gate 跃迁 ENTRY_READY → CONFIRMATION_PENDING（Phase 11E.6） ----
            // 不再 gate 触发的当根直接 plan：等待下一根方向性确认 K（收盘后），
            // entry = 确认 K 收盘价，Stop/RR 基于确认后实际 entry 重算（最早 N+1 执行）。
            // fullWarmup 时 warmup 段不创建。
            if (gate.state === 'ENTRY_READY' && prevGateState !== 'ENTRY_READY' && scenario && i >= recordFrom && !state.pendingConfirmation) {
                var amdNowPlan = amdView(state.amd);
                state.pendingConfirmation = {
                    symbol: symbol,
                    evaluationTime: evaluationTime,
                    entryGate: gate,
                    amd: amdNowPlan,
                    swings: state.swings,
                    draw: snapshot.draw,
                    tickSize: data.exchangeInfo.tickSize,
                    atr: prevAtr,
                    retainedNarrative: state.amd.lastNarrative || null,
                    context: {
                        bias: snapshot.bias.direction,
                        scenario: scenario.scenarioState,
                        amd: amdNowPlan.state
                    },
                    invalidation: gate.invalidatedReason ? [gate.invalidatedReason] : [],
                    direction: amdNowPlan.direction === 'BULLISH' ? 'LONG' : 'SHORT',
                    triggerClose: candle.close,
                    triggerIndex: i,
                    confirmWaitBars: 0,
                    planContext: {
                        bias: snapshot.bias.direction,
                        drawDirection: snapshot.draw.direction,
                        alignment: alignment,
                        amdState: amdNowPlan.state
                    }
                };
                state.transitions.push({
                    type: 'CONFIRMATION_PENDING',
                    index: i,
                    evaluationTime: evaluationTime,
                    direction: state.pendingConfirmation.direction
                });
                state.confirmationStats = state.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 };
                state.confirmationStats.pending++;
            }

            // ---- 8.5 Confirmation 推进（Phase 11E.6）----
            // 每根收盘后检查：context 失效（取消）/ 超时 / 方向性确认 K。
            // 确认发生在当前 K 收盘 → entry = 当前 K close，pendingTrade entryIndex = i（最早 i+1 fill）。
            if (state.pendingConfirmation) {
                var pc = state.pendingConfirmation;
                pc.confirmWaitBars++;
                var confirmDirection = pc.direction; // 'LONG' | 'SHORT'
                // 1) context 失效（原 cancelCheck 语义：AMD_INVALIDATED / scenario 离开 WATCH 等）
                var confirmCancel = evaluateCancelReason(state, pc.planContext, candle, i);
                if (confirmCancel) {
                    state.transitions.push({
                        type: 'CONFIRMATION_CANCELLED',
                        index: i,
                        evaluationTime: evaluationTime,
                        reason: confirmCancel
                    });
                    state.confirmationStats = state.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 };
                    state.confirmationStats.cancelled++;
                    state.pendingConfirmation = null;
                } else if (pc.confirmWaitBars > (cfg.trade.simulator.maxEntryWaitBars !== undefined ? cfg.trade.simulator.maxEntryWaitBars : 12)) {
                    state.transitions.push({
                        type: 'CONFIRMATION_EXPIRED',
                        index: i,
                        evaluationTime: evaluationTime
                    });
                    state.confirmationStats = state.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 };
                    state.confirmationStats.expired++;
                    state.pendingConfirmation = null;
                } else {
                    // 2) 方向性确认 K（bullish: close > open 且 close > trigger close；bearish 反向）
                    var confirmed = confirmDirection === 'LONG'
                        ? (candle.close > candle.open && candle.close > pc.triggerClose)
                        : (candle.close < candle.open && candle.close < pc.triggerClose);
                    if (confirmed) {
                        var plan2 = tradePlan.buildTradePlan({
                            symbol: pc.symbol,
                            evaluationTime: evaluationTime,
                            entryGate: pc.entryGate,
                            currentPrice: candle.close,
                            // Phase 11E.6：确认 K 收盘价 = 实际 entry（不得按旧 entry 价格成交）
                            entryPrice: candle.close,
                            amd: pc.amd,
                            swings: pc.swings,
                            draw: pc.draw,
                            tickSize: pc.tickSize,
                            atr: pc.atr,
                            retainedNarrative: pc.retainedNarrative,
                            context: pc.context,
                            invalidation: pc.invalidation
                        }, { thresholds: cfg });
                        state.confirmationStats = state.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 };
                        if (plan2.status === 'READY' && !state.pendingTrade) {
                            // CONFIRMED → 组装 pendingTrade（entryIndex = 确认根 i）
                            var amd2 = pc.amd;
                            var lastRetrace2 = state.retraces.length > 0
                                ? state.retraces[state.retraces.length - 1] : null;
                            var boundaryAtWatch2 = (lastRetrace2 && lastRetrace2.closeIndex === i)
                                ? lastRetrace2.boundaryAtWatch : null;
                            var boundaryAtPlan2 = narrativeBoundary.boundaryFromAmd(amd2);
                            var stopCandidates2 = stopPlanner.buildStopCandidates({
                                direction: plan2.direction,
                                entryPrice: plan2.entry.price,
                                targetPrice: plan2.target.price,
                                amd: amd2,
                                retainedNarrative: pc.retainedNarrative,
                                swings: pc.swings,
                                fvg: pc.entryGate.fvg || {},
                                evaluationTime: evaluationTime,
                                tickSize: pc.tickSize,
                                atr: pc.atr
                            }, { thresholds: cfg });
                            var risk2 = plan2.direction === 'LONG'
                                ? plan2.entry.price - plan2.stop.price
                                : plan2.stop.price - plan2.entry.price;
                            state.pendingTrade = {
                                plan: plan2,
                                phase: 'WAIT_ENTRY',
                                waitBars: 0,
                                holdBars: 0,
                                mae: 0,
                                mfe: 0,
                                entryAt: null,
                                entryIndex: i,
                                confirmation: { confirmedAt: i, confirmWaitBars: pc.confirmWaitBars, triggerIndex: pc.triggerIndex },
                                diagnostics: {
                                    atr: pc.atr,
                                    initialRiskAtr: pc.atr > 0 ? risk2 / pc.atr : null,
                                    stopSource: plan2.stop.source,
                                    stopReferencePrice: plan2.stop.referencePrice,
                                    stopPrice: plan2.stop.price,
                                    stopDistance: risk2,
                                    stopDistanceAtr: pc.atr > 0 ? risk2 / pc.atr : null,
                                    stopCandidates: stopCandidates2,
                                    boundaryAtWatch: boundaryAtWatch2,
                                    boundaryAtPlan: boundaryAtPlan2,
                                    fvgScore: pc.entryGate.fvg && pc.entryGate.fvg._score !== undefined ? pc.entryGate.fvg._score
                                        : (pc.entryGate.fvg && pc.entryGate.fvg.score !== undefined ? pc.entryGate.fvg.score : null)
                                },
                                context: {
                                    bias: snapshot.bias.direction,
                                    amd: amd2.state,
                                    draw: snapshot.draw.direction,
                                    scenario: scenario.scenarioState,
                                    alignment: alignment,
                                    fvgZoneLow: pc.entryGate.fvg ? pc.entryGate.fvg.zoneLow : null,
                                    fvgZoneHigh: pc.entryGate.fvg ? pc.entryGate.fvg.zoneHigh : null
                                },
                                planContext: {
                                    bias: snapshot.bias.direction,
                                    drawDirection: snapshot.draw.direction,
                                    alignment: alignment,
                                    amdState: amd2.state,
                                    entryPrice: plan2.entry.price,
                                    stopPrice: plan2.stop.price,
                                    targetPrice: plan2.target.price,
                                    stopDistAtr: pc.atr > 0 ? risk2 / pc.atr : null
                                },
                                excursion: [],
                                waitTrace: [],
                                cancelCheck: pendingCancelCheck
                            };
                            state.transitions.push({
                                type: 'CONFIRMED',
                                index: i,
                                evaluationTime: evaluationTime,
                                direction: plan2.direction
                            });
                            state.transitions.push({
                                type: 'PLAN_CREATED',
                                index: i,
                                evaluationTime: evaluationTime,
                                direction: plan2.direction
                            });
                            state.confirmationStats.confirmed++;
                        } else if (plan2.status === 'REJECTED' &&
                            plan2.reasons && plan2.reasons.some(function (r) { return (r || '').indexOf('RR') !== -1; })) {
                            // RR < 1.5：确认后 entry 变差 → NO TRADE（风险收益纪律，不牺牲）
                            state.transitions.push({
                                type: 'CONFIRMATION_REJECTED_RR',
                                index: i,
                                evaluationTime: evaluationTime,
                                rr: plan2.rr
                            });
                            state.confirmationStats.rejectedRr++;
                        } else {
                            state.transitions.push({
                                type: 'CONFIRMATION_DROPPED',
                                index: i,
                                evaluationTime: evaluationTime,
                                status: plan2.status,
                                reasons: plan2.reasons || []
                            });
                            state.confirmationStats.dropped++;
                        }
                        state.pendingConfirmation = null;
                    }
                    // 未确认：继续等待下一根（不重置）
                }
            }

            // ---- 9. Pending Trade 增量 ----
            var settled = replayState.updatePendingTrade(state, candle, i, { thresholds: cfg });
            if (settled && (settled.status === 'WIN' || settled.status === 'LOSS' || settled.status === 'AMBIGUOUS')) {
                state.transitions.push({
                    type: 'TRADE_FILLED',
                    index: i,
                    evaluationTime: evaluationTime,
                    status: settled.status
                });
            }

            // ---- Phase 11E.4：cancel-shadow 追踪 ----
            // 正式 CANCELLED 后：把 plan 拷贝进 cancelShadows，继续记录至多 12 根原始状态
            // （touchEntry / cancelReason），供 cancel-policy shadow 离线重放（GRACE/HARD 模型需要
            // 知道"取消之后 scenario/AMD 是否恢复"）。只旁路记录，不影响正式状态。
            if (settled && settled.status === 'CANCELLED') {
                state.cancelShadows = state.cancelShadows || [];
                state.cancelShadows.push({
                    plan: settled.plan,
                    planContext: settled.planContext || null,
                    entryPrice: settled.entryPrice,
                    stopPrice: settled.stopPrice,
                    targetPrice: settled.targetPrice,
                    direction: settled.direction,
                    waitTrace: settled.waitTrace || [],
                    postTrace: [],
                    cancelIndex: i,
                    postBars: 0,
                    done: false
                });
            }
            if (state.cancelShadows) {
                state.cancelShadows.forEach(function (cs) {
                    if (cs.done) return;
                    if (i <= cs.cancelIndex) return; // cancel 那根已由 waitTrace 记录
                    var touchNow = (cs.direction === 'LONG' && candle.low <= cs.entryPrice && candle.high >= cs.entryPrice) ||
                                   (cs.direction === 'SHORT' && candle.high >= cs.entryPrice && candle.low <= cs.entryPrice);
                    cs.postTrace.push({
                        bar: cs.postBars,
                        index: i,
                        touchEntry: touchNow,
                        cancelReason: evaluateCancelReason(state, cs.planContext, candle, i),
                        close: candle.close
                    });
                    cs.postBars++;
                    // Phase 11E.4：postTrace 覆盖 48 根（对齐"取消后 48 bars 恢复检查"；
                    // GRACE/HARD 模型需要看到取消后更长的恢复/touch 窗口）
                    if (touchNow || cs.postBars >= 48) {
                        cs.done = true;
                    }
                });
            }

            // ---- 10. step 记录 + transition（fullWarmup 时 warmup 段 silent 推进内部状态） ----
            // Phase 11T.3/11T.4：逐根 AMD boundary trace（candle[i] 收盘后状态，诊断用）
            // （lastNarrative flip 清理已前移到 step 8 TradePlan 之前）
            state.amdTrace[i] = {
                boundary: narrativeBoundary.boundaryFromAmd(amdView(state.amd)),
                lastNarrative: state.amd.lastNarrative || null
            };
            // Phase 11D.7：逐根 near/macro draw target trace（Opportunity tier 的
            // Reachable Draw 维度 —— leg 完成时点取当根 near target，无需 retrace 关联）
            if (!state.drawTrace) state.drawTrace = [];
            if (snapshot.draw) {
                state.drawTrace[i] = {
                    bslNear: snapshot.draw.bsl && snapshot.draw.bsl.near ? snapshot.draw.bsl.near.targetPrice : null,
                    bslMacro: snapshot.draw.bsl && snapshot.draw.bsl.macro ? snapshot.draw.bsl.macro.targetPrice : null,
                    sslNear: snapshot.draw.ssl && snapshot.draw.ssl.near ? snapshot.draw.ssl.near.targetPrice : null,
                    sslMacro: snapshot.draw.ssl && snapshot.draw.ssl.macro ? snapshot.draw.ssl.macro.targetPrice : null
                };
            } else {
                state.drawTrace[i] = { bslNear: null, bslMacro: null, sslNear: null, sslMacro: null };
            }
            // Phase 11D.9：bias trace + 1h/4h 已收盘趋势方向（Delivery Alignment 维度）
            if (!state.biasTrace) state.biasTrace = [];
            state.biasTrace[i] = {
                direction: snapshot.bias ? snapshot.bias.direction : null,
                confidence: snapshot.bias && snapshot.bias.confidence !== undefined ? snapshot.bias.confidence : null
            };
            while (h1Ptr < h1Candles.length - 1 && h1Candles[h1Ptr + 1].closeTime <= evaluationTime) h1Ptr++;
            while (h4Ptr < h4Candles.length - 1 && h4Candles[h4Ptr + 1].closeTime <= evaluationTime) h4Ptr++;
            if (!state.htfTrendTrace) state.htfTrendTrace = [];
            state.htfTrendTrace[i] = {
                h1Up: h1Ptr >= 1 ? h1Candles[h1Ptr].close > h1Candles[h1Ptr - 1].close : null,
                h4Up: h4Ptr >= 1 ? h4Candles[h4Ptr].close > h4Candles[h4Ptr - 1].close : null
            };

            if (i >= recordFrom) {
                var step = {
                    index: i,
                    evaluationTime: evaluationTime,
                    price: candle.close,
                    biasDirection: snapshot ? snapshot.bias.direction : 'NEUTRAL',
                    biasConfidence: snapshot ? snapshot.bias.confidence : null,
                    drawDirection: snapshot ? snapshot.draw.direction : null,
                    amdPhase: state.amd.lastPhase,
                    amdState: amdView(state.amd).state,
                    amdDirection: state.amd.direction || state.amd.lastDirection,
                    alignment: alignment,
                    biasConflicts: snapshot ? snapshot.bias.conflicts.length : 0,
                    fvgTotal: state.fvgReg.size(),
                    gateReason: gate.reason || null,
                    scenarioState: scenario ? scenario.scenarioState : 'NEUTRAL',
                    action: scenario ? scenario.action : 'WAIT',
                    gateState: state.gate.state,
                    retraceActive: !!state.activeRetrace,
                    retraceMinDistanceAtr: state.activeRetrace
                        ? state.activeRetrace.minDistanceAtr
                        : null,
                    // ---- Phase 11R.2：State Convergence fingerprint 字段 ----
                    amdAccumulation: state.amd.accumulation,
                    amdManipulationEventId: state.amd.manipulation && state.amd.manipulation.sweepEvent
                        ? state.amd.manipulation.sweepEvent.id : null,
                    amdDistributionEventId: state.amd.distribution
                        ? (state.amd.distribution.displacementEvent
                            ? state.amd.distribution.displacementEvent.id
                            : state.amd.distribution.mssEvent ? state.amd.distribution.mssEvent.id : null)
                        : null,
                    activeLiquidityCount: state.registry.getActive(state.symbol).length,
                    eventCount: state.eventRegistry.size(),
                    // ---- Phase 11D：Narrative Diagnostics 字段 ----
                    // Draw primary target（Alignment 后续 hit rate 用）
                    drawPrimaryBsl: snapshot && snapshot.draw && snapshot.draw.bsl && snapshot.draw.bsl.primary
                        ? snapshot.draw.bsl.primary.targetPrice : null,
                    drawPrimarySsl: snapshot && snapshot.draw && snapshot.draw.ssl && snapshot.draw.ssl.primary
                        ? snapshot.draw.ssl.primary.targetPrice : null,
                    // ---- Phase 11R.2：consumedRefs 生命周期诊断（无界污染检查） ----
                    consumedRefsCount: Object.keys(state.consumedMssRefs || {}).length,
                    consumedRefsOldestAgeBars: oldestConsumedAgeBars(state.consumedMssRefs, evaluationTime),
                    consumedRefsOlderThan1d: consumedOlderThan(state.consumedMssRefs, evaluationTime, 1 * 24 * 3600 * 1000),
                    consumedRefsOlderThan7d: consumedOlderThan(state.consumedMssRefs, evaluationTime, 7 * 24 * 3600 * 1000)
                };
                steps.push(step);
                replayState.recordTransitions(state, {
                    scenarioState: step.scenarioState,
                    gateState: step.gateState,
                    amdPhase: step.amdPhase,
                    index: i,
                    evaluationTime: evaluationTime
                }, true);
                if (opts.onStep && (i % logEvery === 0 || i === startIndex)) {
                    opts.onStep(step, steps.length);
                }
            } else {
                replayState.recordTransitions(state, {
                    scenarioState: scenario ? scenario.scenarioState : 'NEUTRAL',
                    gateState: state.gate.state,
                    amdPhase: state.amd.lastPhase,
                    index: i,
                    evaluationTime: evaluationTime
                }, false);
            }
            prevGateState = gate.state;
            return processBar(i + 1);
        });
    }

    return processBar(fullWarmup ? 0 : startIndex).then(function () {
        // 数据结束强制关闭进行中的 retrace（归类 NEVER_CLOSE / 按实际距离）
        if (state.activeRetrace) {
            var lastIdx = candles.length - 1;
            var lastCandle = candles[lastIdx];
            closeActiveRetrace(lastIdx, lastCandle.closeTime, retraceTracker.CLOSE_REASON.DATA_END);
        }
        // Authoritative Run（Phase 11T.6）：数据结束仍未平仓的 OPEN trade → 记为 OPEN_AT_END
        // （避免被静默丢弃；realizedR=0 不计入 expectancy，但计入 trade 计数）
        if (state.pendingTrade && state.pendingTrade.phase === 'OPEN') {
            var openEnd = replayState.settleTrade(
                state, state.pendingTrade, 'OPEN_AT_END', null,
                candles[candles.length - 1].closeTime, false, candles.length - 1
            );
            state.trades.push(openEnd);
            state.pendingTrade = null;
        }
        return {
            symbol: symbol,
            steps: steps,
            trades: state.trades,
            transitions: state.transitions,
            retraces: state.retraces,
            // Phase 11T.4：逐根 AMD boundary/lastNarrative trace（诊断；warmupStabilityRetain 用）
            amdTrace: state.amdTrace || [],
            // Phase 11D.7：逐根 near/macro draw target trace（Opportunity tier 用）
            drawTrace: state.drawTrace || [],
            // Phase 11D.9：逐根 bias + HTF 趋势 trace（Delivery Alignment Audit 用）
            biasTrace: state.biasTrace || [],
            htfTrendTrace: state.htfTrendTrace || [],
            // Phase 11E.4：cancel-shadow 追踪（正式 cancel 后 12 根原始状态）
            cancelShadows: state.cancelShadows || [],
            // Phase 11E.6：confirmation funnel 统计
            confirmationStats: state.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 },
            // Phase 11E.7：gate 语义 shadow 聚合
            gateShadow: state.gateShadow || { touchButCloseOutside: 0, closeInside: 0, candTotal: 0, lt40: 0, ge40lt60: 0, ge60: 0, noDisp: 0 },
            // Phase 11D.3：Opportunity/DisplacementLeg 数据源
            fvgs: state.fvgReg.getAll(symbol),
            displacementEvents: state.eventRegistry.getByType(symbol, 'DISPLACEMENT'),
            mssEvents: state.eventRegistry.getByType(symbol, 'MSS'),
            // Phase 11D.8：liquidity sweep 事件（Alert Replay 的 Sweep 字段）
            sweepEvents: state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP'),
            swings: state.swings,
            // Phase 11L.17：equal liquidity 事件只读暴露（EQL/EQH 本体含 metadata.members，
            // 供 Equal Liquidity Quality Audit 用；零判定改动，仅暴露已有 registry 数据）
            equalLiquidity: state.registry.getByType(symbol, 'EQL').concat(state.registry.getByType(symbol, 'EQH')),
            // Phase 13：全部 liquidity 对象只读暴露（PDH/PDL/PWH/PWL/Session/EQH/EQL/SWING，
            // 含 status/touchedAt/sweptAt/confirmedAt——供 Draw on Liquidity 候选池重建；
            // 零判定改动，仅暴露已有 registry 数据）
            liquidityObjects: state.registry.getAll(symbol),
            // Phase 13：ATR 序列只读暴露（{index: atrValue}，供 distanceATR 归一；零判定改动）
            atrSeries: state.atrSeries || {},
            summary: {
                barCount: endIndex - startIndex + 1,
                stepCount: steps.length,
                tradeCount: state.trades.length,
                retraceCount: state.retraces.length
            }
        };
    });
}

/**
 * 全部已确认 displacement（供 FVG 关联）
 */
function allDisplacements(state) {
    return state.eventRegistry.getByType(state.symbol, 'DISPLACEMENT');
}

/**
 * Phase 11R.2：consumedRefs 生命周期诊断
 * consumedMssRefs = { swingId: consumedAtTimestamp }
 */
function oldestConsumedAgeBars(consumed, evaluationTime) {
    var barMs = 300000;
    var oldest = null;
    Object.keys(consumed || {}).forEach(function (id) {
        var t = consumed[id];
        if (typeof t === 'number') {
            if (oldest === null || t < oldest) {
                oldest = t;
            }
        }
    });
    if (oldest === null) {
        return null;
    }
    return Math.floor((evaluationTime - oldest) / barMs);
}

function consumedOlderThan(consumed, evaluationTime, windowMs) {
    var count = 0;
    Object.keys(consumed || {}).forEach(function (id) {
        var t = consumed[id];
        if (typeof t === 'number' && evaluationTime - t > windowMs) {
            count++;
        }
    });
    return count;
}

/**
 * 增量 Wilder ATR：每根 O(1) 更新
 */
function updateAtrIncremental(atrSeries, candles, i, prev, period) {
    var p = period || 14;
    if (i < p) {
        return null;
    }
    if (i === p) {
        var sum = 0;
        var k;
        for (k = 1; k <= p; k++) {
            sum += atrIndicator.trueRange(candles[k], candles[k - 1]);
        }
        var v = sum / p;
        atrSeries[i] = v;
        return v;
    }
    var next = (prev * (p - 1) + atrIndicator.trueRange(candles[i], candles[i - 1])) / p;
    atrSeries[i] = next;
    return next;
}

/**
 * Phase 11E.4：cancel 判定（提取为可复用函数——正式 cancelCheck 与 cancel-shadow 共用）
 * 返回取消原因字符串；null = 不取消。
 * 分类：AMD_INVALIDATED / SCENARIO_LEFT_WATCH / ALIGNMENT_OPPOSITE / BIAS_FLIP / DRAW_FLIP
 */
function evaluateCancelReason(state, planContext, candle, index) {
    var snapshot = state.snapshot;
    if (!snapshot || !snapshot.bias || !state.lastScenario) {
        return null;
    }
    // AMD INVALIDATED
    if (state.amd.lastPhase === 'INVALIDATED') {
        return 'AMD_INVALIDATED';
    }
    // scenario 不再 matching WATCH（action 离开 WATCH）→ 细分原因
    if (state.lastScenario.action !== 'WATCH') {
        var pc = planContext || null;
        if (pc && pc.bias) {
            var curBias = snapshot.bias.direction || '';
            var planBias = pc.bias || '';
            var biasFlip =
                (planBias.indexOf('BULLISH') !== -1 && curBias.indexOf('BEARISH') !== -1) ||
                (planBias.indexOf('BEARISH') !== -1 && curBias.indexOf('BULLISH') !== -1);
            if (biasFlip) {
                return 'BIAS_FLIP';
            }
        }
        if (pc && pc.alignment === 'MATCH') {
            var curAlign = amdAlignment.align(
                snapshot.bias,
                state.amd.direction || state.amd.lastDirection
            ).alignment;
            if (curAlign === 'OPPOSITE') {
                return 'ALIGNMENT_OPPOSITE';
            }
        }
        if (pc && pc.drawDirection) {
            var curDraw = snapshot.draw && snapshot.draw.direction;
            var drawFlip =
                (pc.drawDirection.indexOf('BSL') !== -1 && curDraw && curDraw.indexOf('SSL') !== -1) ||
                (pc.drawDirection.indexOf('SSL') !== -1 && curDraw && curDraw.indexOf('BSL') !== -1);
            if (drawFlip) {
                return 'DRAW_FLIP';
            }
        }
        return 'SCENARIO_LEFT_WATCH';
    }
    return null;
}

/**
 * pending trade 的 cancelCheck（Phase 11E.1/11E.4：返回取消原因字符串，null = 不取消）
 * 委托 evaluateCancelReason（this = pending，this.planContext 可用）
 */
function pendingCancelCheck(state, candle, index) {
    return evaluateCancelReason(state, this && this.planContext, candle, index);
}

module.exports = {
    runReplay: runReplay,
    amdView: amdView,
    _updateAtrIncremental: updateAtrIncremental,
    // Phase 11L（live）：实时引擎复用快照构建（bias/draw 与回测完全一致）
    rebuildSnapshot: rebuildSnapshot
};
