/**
 * Phase 11L — Live Engine（实时机会雷达核心）
 *
 * 把回测的单根状态推进复用到实时。Production notification 的新入口是
 * valid Displacement -> backward matching liquidity -> Displacement Watch；legacy
 * Opportunity tier 继续返回给统计/兼容层，但不再决定 FVG retracement DingTalk。
 *
 * 与回测 11D.8 的一致性保证：
 *   - 复用同一批检测器（incrementalLiquidity / incrementalEvents / incrementalFvg /
 *     mssDetector / displacementDetector / amdState / rebuildSnapshot）
 *   - 内部维护全局 index 对齐的 candles 窗口（window.length === index+1，
 *     与回测 candles.slice(0, index+1) 语义完全一致）
 *   - leg 合并语义与 buildDisplacementLegs 一致（连续同向、相邻 index、最多 3 根）
 *   - tier 判定复用 classifyOpportunityTier（同一阈值）
 *   - near target 取 snapshot.draw 的 near（与 drawTrace 同源）
 *
 * 不包含：gate / scenario 决策 / 交易执行 / 下单 —— 纯机会发现。
 */
var replayState = require('../replay/replayState');
var eventRegistry = require('../events/eventRegistry');
var displacementDetector = require('../events/displacementDetector');
var amdState = require('../amd/amdState');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
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

var LEG_MAX_BARS = 3;

function attachWatchLiquidityEvidenceV1(candidate, context) {
    var ctx = context || {};
    if (!ctx.enabled || !candidate) return candidate;
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

    var state = replayState.createReplayState({ symbol: symbol, timeframe: '5m', snapshotInterval: snapshotInterval,
        eqProductionVersion: opts.eqProductionVersion });
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

    // 共享增量 Leg builder（Phase 11L.1：15min 时间窗 = buildOpportunities 语义，Replay/Live 单一实现）
    var legBuilder = displacementLeg.createWindowedLegBuilder();

    /**
     * Displacement-Centric Watch V1: the leg/displacement is the trigger. Only
     * after it exists do we look backward for matching sweep provenance.
     * Native FVG is calculated from each displacement's own K1/K2/K3 candles;
     * state.fvgReg is deliberately not passed to the builder.
     */
    function emitDisplacementWatch(leg, evaluationTime) {
        if (!leg || !leg.ids || !leg.ids.length) return null;
        leg.endIndex = leg.lastIndex;
        displacementLeg.enrichLegWithCandles(leg, window);
        displacementLeg.classifyLegQuality(leg);
        var dailyBias;
        try {
            dailyBias = dailyBiasProvider
                ? dailyBiasProvider(leg.direction, evaluationTime, { displacementLegId: 'LEG:' + leg.ids[0] })
                : dailyBiasAlignment.unknownDailyBias();
        } catch (e) {
            dailyBias = dailyBiasAlignment.unknownDailyBias();
        }
        var candidate = displacementWatch.buildWatch({
            symbol: symbol,
            leg: leg,
            evaluationTime: evaluationTime,
            sweepEvents: state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP'),
            displacements: state.eventRegistry.getByType(symbol, 'DISPLACEMENT'),
            mssEvents: state.eventRegistry.getByType(symbol, 'MSS'),
            candles: window,
            structuralState: state.structural5m,
            dailyBias: dailyBias,
            existing: watchById['WATCH:' + symbol + ':' + leg.direction + ':LEG:' + leg.ids[0]] || null
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
            prevAtr = replayEngine._updateAtrIncremental(atrSeries, window, i, prevAtr, 14);

            // ---- 4. Incremental structural provenance + events ----
            var structuralStep = structuralProvenance5m.step(
                state.structural5m, candle, i, newConfirmedSwings
            );
            structuralStep.events.forEach(function (event) {
                state.eventRegistry.add(event);
            });
            var newMssRaw = structuralStep.mss;
            var newDispRaw = displacementDetector.detectDisplacement([candle], newMssRaw, {
                symbol: symbol, timeframe: '5m', baseIndex: i,
                atrSeries: atrSeries, thresholds: cfg
            });
            var newEvents = replayState.incrementalEvents(state, candle, i, evaluationTime, newMssRaw, newDispRaw);

            // ---- 5. 持久 AMD ----
            amdState.updateAmdState(state.amd, {
                candle: candle, candleIndex: i,
                candles: window,
                evaluationTime: evaluationTime,
                symbol: symbol, timeframe: '5m',
                registry: state.registry,
                draw: snapshot ? snapshot.draw : null,
                newSweeps: newEvents.sweeps,
                newMss: newEvents.mss,
                newDisplacements: newEvents.displacements
            }, { thresholds: cfg });

            // ---- 6. 增量 FVG（全局 candles） ----
            var allDisp = state.eventRegistry.getByType(symbol, 'DISPLACEMENT');
            replayState.incrementalFvg(state, window, candle, i, evaluationTime, data.exchangeInfo, allDisp);

            // ---- 6.5 逐根 drawTrace（评估用 leg 完成那根的 near，与回测 drawTrace[anchor] 对齐） ----
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

            // ---- 7. Leg 检测 + 机会评估（共享 builder：与 Replay 单一实现） ----
            // anchor = leg.lastIndex 的蜡烛（leg 真正完成那根），不是当前新 displacement 根
            // 11L.4：availableIndex = 当前推进根 index（= 系统首次能确认 leg 结束的时点）
            var opp = null;
            (newEvents.displacements || []).forEach(function (d) {
                var r = legBuilder.feed(d);
                if (r.closed) {
                    emitDisplacementWatch(r.closed, evaluationTime);
                    var anchorCandle = window[r.closed.lastIndex];
                    if (anchorCandle) {
                        opp = evaluateOpportunity(r.closed, r.closed.lastIndex, anchorCandle, i) || opp;
                    }
                }
            });
            // Fix 2（11L.2）：每根收盘检查 leg 是否已过期（过去 15min 无同向 displacement）
            // 避免 LATE notification / 永不评估（Live 常驻无"数据结束"）
            var expired = legBuilder.closeExpired(evaluationTime);
            if (expired) {
                emitDisplacementWatch(expired, evaluationTime);
                var anchorCandle2 = window[expired.lastIndex];
                if (anchorCandle2) {
                    opp = evaluateOpportunity(expired, expired.lastIndex, anchorCandle2, i) || opp;
                }
            }
            // Re-evaluate the current open leg every closed candle. This is what lets K3
            // confirm a native FVG one bar after its owning displacement K2 without any
            // future-state backfill. No new displacement is required for that upgrade.
            if (legBuilder.getOpen()) emitDisplacementWatch(legBuilder.getOpen(), evaluationTime);
            return opp;
        });
    }

    /**
     * 评估已完成的 leg → 返回机会（含 tier）。去重/投递由调用方负责（Fix 3，11L.3）。
     * @param {number} [availableIndex] 11L.4：系统首次能确认 leg 结束的根 index
     *   （feed/closeExpired 关闭时 = 当前推进根 i；flushLeg 无上下文时回退 anchorIndex）
     */
    function evaluateOpportunity(leg, anchorIndex, anchorCandle, availableIndex) {
        var oppId = leg.mssId || ('LEG:' + leg.ids[0]);
        // 机会身份与 Replay 的 buildOpportunities 一致：只有 FVG 归属到 leg 才构成机会
        // （buildOpportunities 遍历 fvgs → fvg.displacementEventId → leg → opp；无 FVG 的 leg 不成机会）
        var legFvgs = state.fvgReg.getAll(symbol).filter(function (f) {
            return f.displacementEventId && leg.ids.indexOf(f.displacementEventId) !== -1;
        });
        if (legFvgs.length === 0) return null;

        // leg 价量维度（用全局窗口补全；enrich 期望 endIndex 字段）
        leg.endIndex = leg.lastIndex;
        if (leg.startIndex >= 0 && leg.lastIndex < window.length && window[leg.lastIndex]) {
            displacementLeg.enrichLegWithCandles(leg, window);
        }
        var legQuality = displacementLeg.classifyLegQuality(leg);

        // MSS quality is enrichment from time-local structural provenance;
        // age/latest-swing/reference-role cannot suppress MSS or HIGH eligibility.
        var mssQuality = 'NO_MSS';
        if (leg.mssId) {
            var mssEvent = null;
            state.eventRegistry.getByType(symbol, 'MSS').some(function (m) {
                if (m.id === leg.mssId) { mssEvent = m; return true; }
                return false;
            });
            if (mssEvent) {
                mssQuality = structuralProvenance5m.qualityForMss(mssEvent);
            }
        }

        // near draw（drawTrace[anchorIndex] 的 near target，与回测 drawTrace[anchor] 同源；snapshot 兜底）
        var nearTarget = null;
        var dt = state.drawTrace && state.drawTrace[anchorIndex] ? state.drawTrace[anchorIndex] : null;
        if (dt) {
            nearTarget = leg.direction === 'BULLISH' ? dt.bslNear : dt.sslNear;
        }
        if (nearTarget === null && snapshot && snapshot.draw) {
            nearTarget = leg.direction === 'BULLISH'
                ? (snapshot.draw.bsl && snapshot.draw.bsl.near ? snapshot.draw.bsl.near.targetPrice : null)
                : (snapshot.draw.ssl && snapshot.draw.ssl.near ? snapshot.draw.ssl.near.targetPrice : null);
        }
        var anchorPrice = anchorCandle.close;
        var nearDistPct = nearTarget !== null && nearTarget !== undefined && anchorPrice > 0
            ? Math.abs(nearTarget - anchorPrice) / anchorPrice * 100
            : null;

        var tier = opportunityQuality.classifyOpportunityTier({
            mssQuality: mssQuality,
            mssExists: !!mssEvent,
            legQuality: legQuality,
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });

        // 11L.4：通知可用时点（系统首次能确认 leg 结束）——
        //   availableIndex 优先（调用方当前根）；builder timeout 场景由调用方传入；
        //   flushLeg（无上下文）回退 leg.availableIndex / anchorIndex
        var availIdx = availableIndex !== undefined && availableIndex !== null
            ? availableIndex
            : (leg.availableIndex !== undefined && leg.availableIndex !== null ? leg.availableIndex : anchorIndex);
        var availCandle = window[availIdx];

        // Phase 11L.7：Notification Snapshot 收口 —— 通知内容（价格/Near Draw/距离）必须在
        // availableAt 时重新冻结（anchor→available 的 15min 内 liquidity 可能已被触及/扫掉/更近）。
        //   notificationPrice        = availableIndex 处 close
        //   notificationNearTarget   = drawTrace[availableIndex] 的 near（回退 anchor 冻结值）
        //   notificationNearDistPct  = |notificationNearTarget - notificationPrice| / notificationPrice
        var dtAvail = state.drawTrace && state.drawTrace[availIdx] ? state.drawTrace[availIdx] : null;
        var notifNear = null;
        if (dtAvail) {
            notifNear = leg.direction === 'BULLISH' ? dtAvail.bslNear : dtAvail.sslNear;
        }
        if (notifNear === null || notifNear === undefined) {
            notifNear = nearTarget;
        }
        var notifPrice = availCandle ? availCandle.close : null;
        var notifDist = notifNear !== null && notifNear !== undefined && notifPrice !== null && notifPrice > 0
            ? Math.abs(notifNear - notifPrice) / notifPrice * 100
            : null;

        // FVG 结构证据数（leg 关联的 FVG）
        var fvgCount = state.fvgReg.getAll(symbol).filter(function (f) {
            return f.displacementEventId && leg.ids.indexOf(f.displacementEventId) !== -1;
        }).length;
        var opp = {
            id: oppId,
            tier: tier,
            direction: leg.direction,
            mssQuality: mssQuality,
            legQuality: legQuality,
            legRangeAtr: leg.rangeAtr,
            // Authoritative Structural MSS provenance fields (diagnostic only).
            mssId: leg.mssId || null,
            mssReferenceSwingId: mssEvent && mssEvent.source ? (mssEvent.source.referenceSwingId || null) : null,
            mssReferenceRole: mssEvent ? mssEvent.referenceStructuralRole : null,
            protectedBreak: !!(mssEvent && mssEvent.protectedBreak),
            mssGrade: mssEvent ? mssEvent.mssGrade : null,
            structuralStateBefore: mssEvent ? mssEvent.structuralStateBefore : null,
            structuralStateAfter: mssEvent ? mssEvent.structuralStateAfter : null,
            provenanceAvailable: !!(mssEvent && mssEvent.provenanceAvailable),
            provenanceId: mssEvent ? (mssEvent.provenanceId || null) : null,
            anchorIndex: anchorIndex,
            anchorTime: anchorCandle.closeTime,
            anchorPrice: anchorPrice,
            availableIndex: availIdx,
            availableAt: availCandle ? availCandle.closeTime : (leg.availableAt !== undefined ? leg.availableAt : anchorCandle.closeTime),
            closeReason: leg.closeReason || 'timeout',
            nearTarget: nearTarget,
            nearDistPct: nearDistPct,
            // Phase 11L.7：通知时点快照（消息显示 / post-alert 统计基准）
            notificationPrice: notifPrice,
            notificationNearTarget: notifNear,
            notificationNearDistPct: notifDist,
            fvgCount: fvgCount,
            nearConsumed: false
        };

        // 11L.5（P0-2）Near Draw stale-at-notification —— 数据结论（90d）：
        // "通知前 near 被触及/穿越"的机会 1h hit 反而更高（81% vs 剔除后 33-41%），
        // 触及 ≠ 失效（近端流动性被测试恰是机会生效标志）→ 用户决策【放弃 suppress】。
        // 仅标记 nearConsumed 供日志观察，不拦截任何 HIGH。
        if (tier === 'HIGH_QUALITY' && nearTarget !== null && nearTarget !== undefined && availIdx > anchorIndex) {
            var cons = nearStaleness.checkNearConsumed(nearTarget, leg.direction, window, anchorIndex + 1, availIdx);
            opp.nearConsumed = cons.consumed;
        }

        // Phase 11L.8：Liquidity Provenance + MSS↔Leg relation（Live/Replay 同一关联函数）。
        //   通知行 "Liquidity Taken:" 的数据源；sweep.confirmedAt <= availableAt（无 future leakage）。
        var availTime2 = availCandle ? availCandle.closeTime : (opp.availableAt !== undefined ? opp.availableAt : anchorCandle.closeTime);
        var sweepEventsAll = state.eventRegistry.getByType(symbol, 'LIQUIDITY_SWEEP');
        var prov = liquidityProvenance.associateSweeps({
            direction: leg.direction,
            leg: leg,
            availableAt: availTime2,
            sweepEvents: sweepEventsAll,
            maxLookbackBars: null // 使用 thresholds.events.sweepProvenance.maxLookbackBars（当前 48）
        });
        opp.liquidityContext = prov;
        opp.mssRelation = liquidityProvenance.classifyMssLegRelation(leg, mssEvent);
        var narrativeRaid = prov && prov.immediateSweep ? prov.immediateSweep : null;
        opp.raidToMssBars = narrativeRaid && mssEvent &&
            typeof narrativeRaid.candleIndex === 'number' && typeof mssEvent.candleIndex === 'number'
            ? mssEvent.candleIndex - narrativeRaid.candleIndex : null;
        opp.mssToDisplacementBars = mssEvent && typeof mssEvent.candleIndex === 'number'
            ? leg.startIndex - mssEvent.candleIndex : null;

        // Phase 11L.15 — Alert Prioritization（B 口径，用户选定；A 口径数据失败已关闭）：
        //   HIGH + 48 窗口内存在任一 Significant Liquidity（EQL/EQH/PDL/PDH/Session）
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
        flushLeg: function () {
            var closed = legBuilder.close();
            if (!closed) return null;
            var anchorCandle = window[closed.lastIndex];
            if (!anchorCandle) return null;
            return evaluateOpportunity(closed, closed.lastIndex, anchorCandle);
        },
        symbol: symbol
    };
    engine.eqProductionVersion = state.eqProductionVersion;
    return engine;
}

module.exports = {
    attachWatchLiquidityEvidenceV1: attachWatchLiquidityEvidenceV1,
    createLiveEngine: createLiveEngine,
    attachDailyBias: attachDailyBias,
    LEG_MAX_BARS: LEG_MAX_BARS
};
