/**
 * Phase 11L — Live Engine（实时机会雷达核心）
 *
 * 把回测的单根状态推进（liquidity / snapshot / ATR / events / AMD / FVG）
 * 复用到实时：每根 5m 收盘推进一次，检测 DisplacementLeg 完成 →
 * 评估 Opportunity tier（MSS × Leg × Near Draw）→ 返回新 HIGH_QUALITY 机会。
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
var mssDetector = require('../events/mssDetector');
var displacementDetector = require('../events/displacementDetector');
var amdState = require('../amd/amdState');
var replayEngine = require('../replay/replayEngine');
var mssReference = require('../stats/mssReference');
var displacementLeg = require('../stats/displacementLeg');
var opportunityQuality = require('../stats/opportunityQuality');
var thresholds = require('../config/thresholds');

var LEG_MAX_BARS = 3;

/**
 * @param {Object} data { symbol, exchangeInfo, structureCandles, calendarCandles, fetcher, thresholds }
 * @param {Object} [options] { snapshotInterval, baseIndex }
 * @returns {Object} engine
 */
function createLiveEngine(data, options) {
    var opts = options || {};
    var cfg = data.thresholds || thresholds;
    var symbol = data.symbol;
    var snapshotInterval = opts.snapshotInterval !== undefined ? opts.snapshotInterval : 12;
    var baseIndex = opts.baseIndex !== undefined ? opts.baseIndex : 0;

    var state = replayState.createReplayState({ symbol: symbol, timeframe: '5m', snapshotInterval: snapshotInterval });
    state.eventRegistry = eventRegistry.createEventRegistry();
    var atrSeries = {};
    var prevAtr = null;
    state.atrSeries = atrSeries;
    var snapshot = null;
    // Fix 3（11L.3 P1）：engine 不再维护 pushed/去重集合 —— 机会只负责"检测并返回"，
    // 投递确认（钉钉 errcode=0）与去重（delivered）由 scripts/live.js 负责：
    //   钉钉失败 → 机会保留 pending，下轮重试；确认成功才记 delivered（跨重启持久化）。
    var window = []; // 全局 index 对齐的已收盘 5m 序列（window.length === 最后 index + 1）

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
        replayState.incrementalLiquidity(state, window, i, data.exchangeInfo, evaluationTime);

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

            // ---- 4. 增量事件 ----
            var newMssRaw = mssDetector.detectMss([candle], state.swings, {
                symbol: symbol, timeframe: '5m', baseIndex: i,
                consumedRefs: state.consumedMssRefs || (state.consumedMssRefs = {}),
                thresholds: cfg
            });
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
            var opp = null;
            (newEvents.displacements || []).forEach(function (d) {
                var r = legBuilder.feed(d);
                if (r.closed) {
                    var anchorCandle = window[r.closed.lastIndex];
                    if (anchorCandle) {
                        opp = evaluateOpportunity(r.closed, r.closed.lastIndex, anchorCandle) || opp;
                    }
                }
            });
            // Fix 2（11L.2）：每根收盘检查 leg 是否已过期（过去 15min 无同向 displacement）
            // 避免 LATE notification / 永不评估（Live 常驻无"数据结束"）
            var expired = legBuilder.closeExpired(evaluationTime);
            if (expired) {
                var anchorCandle2 = window[expired.lastIndex];
                if (anchorCandle2) {
                    opp = evaluateOpportunity(expired, expired.lastIndex, anchorCandle2) || opp;
                }
            }
            return opp;
        });
    }

    /**
     * 评估已完成的 leg → 返回机会（含 tier）。去重/投递由调用方负责（Fix 3，11L.3）。
     */
    function evaluateOpportunity(leg, anchorIndex, anchorCandle) {
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

        // mss quality
        var mssQuality = 'NO_MSS';
        if (leg.mssId) {
            var mssEvent = null;
            state.eventRegistry.getByType(symbol, 'MSS').some(function (m) {
                if (m.id === leg.mssId) { mssEvent = m; return true; }
                return false;
            });
            if (mssEvent) {
                mssQuality = mssReference.classifyMssReference(mssEvent, state.swings || []).quality;
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
            legQuality: legQuality,
            nearDrawAvailable: nearTarget !== null && nearTarget !== undefined,
            directionConflict: false
        });

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
            anchorIndex: anchorIndex,
            anchorTime: anchorCandle.closeTime,
            anchorPrice: anchorPrice,
            nearTarget: nearTarget,
            nearDistPct: nearDistPct,
            fvgCount: fvgCount
        };
        return opp;
    }

    function getState() { return state; }
    function getWindowLength() { return window.length; }

    var engine = {
        onBar: onBar,
        getState: getState,
        getWindowLength: getWindowLength,
        flushLeg: function () {
            var closed = legBuilder.close();
            if (!closed) return null;
            var anchorCandle = window[closed.lastIndex];
            if (!anchorCandle) return null;
            return evaluateOpportunity(closed, closed.lastIndex, anchorCandle);
        },
        symbol: symbol
    };
    return engine;
}

module.exports = {
    createLiveEngine: createLiveEngine,
    LEG_MAX_BARS: LEG_MAX_BARS
};
