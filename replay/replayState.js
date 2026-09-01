/**
 * Persistent Replay State（Phase 11R）
 *
 * 真正的有状态时间系统核心。与快照版 evaluateContext 的区别：
 *
 * 快照版（旧）：每次 evaluation 全量重算 Liquidity→Bias→AMD→FVG→Gate
 * 本版（新）：
 *   - 每根 K：增量推进【状态型】组件
 *       AMD（amd/amdState.js 持久状态机）
 *       Liquidity registry（新 swing/equal 去重加入，旧 status 保留）
 *       Sweep / Displacement 事件（只取新 K 产生的）
 *       FVG（新 K 形成 + 已有 FVG 逐根 lifecycle）
 *       Entry Gate（previousState 持久）
 *       Pending Trade（逐根增量模拟 + cancelCheck）
 *   - 每 snapshotInterval 根（默认 12）：刷新【慢变量快照】
 *       Calendar liquidity（PDH/PWH/PMH/Session——日/周边界才变）
 *       Cluster / Draw / Bias / Scenario / Structure / Location
 *
 * 正确性保证：
 *   - 所有事件 confirmedAt <= evaluationTime（candle.closeTime）
 *   - FVG lifecycle 逐根推进（历史 FILLED 不会被重新视为 ACTIVE）
 *   - Gate INVALIDATED 通过 previousState 真正可达
 *   - Pending Trade 每根与 context 同步（scenario/AMD 失效 → CANCELLED）
 */
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');
var productionEqualLiquidityV1 = require('../liquidity/productionEqualLiquidityV1');
var liquidityLifecycle = require('../liquidity/liquidityLifecycle');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var liquidityTakenEventAdapter = require('../events/liquidityTakenEventAdapter');
var sweepEventAdapter = require('../events/sweepEventAdapter');
var fvgDetector = require('../fvg/fvgDetector');
var fvgLifecycle = require('../fvg/fvgLifecycle');
var fvgRegistry = require('../fvg/fvgRegistry');
var amdState = require('../amd/amdState');
var structuralProvenance5m = require('../structure/structuralProvenance5m');
var canonicalDisplacementStore = require('../events/canonicalDisplacementStore');

var RIGHT = 2;

function createReplayState(options) {
    var opts = options || {};
    return {
        symbol: opts.symbol || 'UNKNOWN',
        timeframe: opts.timeframe || '5m',
        eqProductionModel: productionEqualLiquidityV1.VERSION,
        index: 0,

        // ---- 持久 liquidity registry（增量加入，不重建） ----
        registry: liquidityRegistry.createRegistry(),
        swings: [],
        productionEq: productionEqualLiquidityV1.createState({
            symbol: opts.symbol || 'UNKNOWN',
            timeframe: opts.timeframe || '5m',
            fourHourCandles: opts.fourHourCandles || []
        }),
        structural5m: structuralProvenance5m.createState({
            symbol: opts.symbol || 'UNKNOWN', timeframe: opts.timeframe || '5m'
        }),

        // ---- 事件（持久，id 去重） ----
        eventRegistry: null, // 由调用方注入 events/eventRegistry
        takenLiquidityIds: null, // 首次从 Event Registry 派生的运行时去重缓存
        displacementStore: canonicalDisplacementStore.createCanonicalDisplacementStore(),

        // ---- 持久状态机 ----
        amd: amdState.createAmdState(),
        fvgReg: fvgRegistry.createFvgRegistry(),
        gate: { state: 'CLOSED', fvgId: null },
        pendingTrade: null,
        trades: [],

        // ---- 慢变量快照（每 snapshotInterval 刷新） ----
        snapshot: {
            cluster: [],
            draw: null,
            bias: null,
            scenario: null,
            structures: null,
            location: null
        },
        snapshotInterval: opts.snapshotInterval !== undefined ? opts.snapshotInterval : 12,
        lastSnapshotIndex: -1,

        // ---- transition 记录（Funnel 用） ----
        transitions: [],
        prevScenarioState: null,
        prevGateState: 'CLOSED',
        prevAmdPhase: 'SEARCHING',

        // ---- ATR 增量 ----
        atrValue: null
    };
}

/**
 * 每根 K 增量更新 liquidity：新 2/2 pivot → ordinary swing → cross-source EQ observation。
 * 返回本根新产生的 swing 列表。
 *
 * Phase 11D.4（性能）：增量 pivot —— 原实现每根 slice(0, index+1) + detectPivots 全量 = O(n²)
 * （180d 单币 ~30 分钟的主热点）。新实现利用 pivot 语义：pivot 极值 K 在 index = K + RIGHT
 * 时被右确认，每根最多一个新确认 pivot（极值 K = index - RIGHT），只需检测 5 根局部窗口。
 * 等价性：全量 detectPivots(candles[0..index]) 的已确认 pivot 集合 = 增量累积集合（每根恰覆盖
 * 新确认的 pivot）。buildSwingLiquidity 逐 pivot 独立处理（不依赖集合完整性）。Production EQ
 * 只评估本根新确认的 ordinary 2/2，并读取连续维护的 ATR50 历史点状态。
 */
function incrementalLiquidity(state, candles, index, exchangeInfo, evaluationTime) {
    // 1. 增量 pivot：极值 K = index - RIGHT（确认根恰为 index）
    var newPivots = [];
    var mid = index - RIGHT;
    if (mid >= 0) {
        var lo = Math.max(0, mid - RIGHT);
        var hi = Math.min(candles.length - 1, mid + RIGHT);
        var win = candles.slice(lo, hi + 1);
        var local = pivotDetector.detectPivots(win, { left: RIGHT, right: RIGHT });
        local.forEach(function (p) {
            var globalIdx = p.index + lo;
            if (globalIdx === mid) {
                newPivots.push({
                    type: p.type,
                    index: globalIdx,
                    price: p.price,
                    confirmedAt: p.confirmedAt,
                    time: p.time
                });
            }
        });
    }

    // 2. 新 swing（逐 pivot 独立，等价）
    var newSwings = swingLiquidity.buildSwingLiquidity(
        state.symbol,
        state.timeframe,
        newPivots,
        candles,
        RIGHT
    );
    var addedSwings = [];
    newSwings.forEach(function (s) {
        if (state.registry.add(s)) {
            addedSwings.push(s);
        }
    });

    // 3. Production EQ replacement: current confirmed ordinary 2/2 versus
    // prior 36H confirmed causal ATR50 ZigZag, same-side and unviolated before
    // current occurrence. The returned EQH/EQL is a point-in-time observation;
    // no V2/V3 cluster identity, lifecycle, or member evolution is executed.
    var equalStep = productionEqualLiquidityV1.step(
        state.productionEq, candles[index], index, candles, addedSwings
    );
    var equal = equalStep.equalLiquidity;
    equal.forEach(function (e) {
        state.registry.add(e);
    });

    // 4. 增量维护 state.swings（原实现每根全量 concat，等价且省 O(swings)）
    addedSwings.forEach(function (s) {
        state.swings.push(s);
    });

    return addedSwings;
}

/**
 * 每根 K 增量事件：
 * 1. pre-bar Narrative Liquidity × 新 K → objective TAKEN event
 * 2. lifecycle × 新 K → SWEPT → sweep 事件（legacy semantics unchanged）
 * 3. A/C2 raw detections canonicalize into the sole production Displacement store
 */
function incrementalEvents(state, candle, index, evaluationTime, rawDisplacements) {
    var newTaken = [];
    var newSweeps = [];
    var registry = state.registry;

    // Restart/prefix-safe first-Taken ledger is the existing unified Event Registry.
    // Derive a runtime cache once, then advance it with registered events; it is
    // not a second persistence source and can always be rebuilt after restart.
    var takenByLiquidityId = state.takenLiquidityIds;
    if (!takenByLiquidityId) {
        takenByLiquidityId = {};
        state.eventRegistry.getByType(state.symbol, 'LIQUIDITY_TAKEN').forEach(function (event) {
            if (event && event.liquidityId) takenByLiquidityId[event.liquidityId] = true;
        });
        state.takenLiquidityIds = takenByLiquidityId;
    }

    // Taken is evaluated before this candle mutates lifecycle. Same-candle event
    // ordering is deterministic: registry insertion order is TAKEN, then SWEEP.
    var all = registry.getAll(state.symbol);
    for (var i = 0; i < all.length; i++) {
        var l = all[i];
        if (!takenByLiquidityId[l.id]) {
            var taken = liquidityTakenEventAdapter.buildTakenEvent(l, candle, index, state.timeframe);
            if (taken && state.eventRegistry.add(taken)) {
                takenByLiquidityId[l.id] = true;
                newTaken.push(taken);
            }
        }

        // Existing lifecycle/Sweep path below is intentionally unchanged.
        if (l.confirmedAt > candle.closeTime) {
            continue; // 防未来数据
        }
        if (l.status !== 'ACTIVE' && l.status !== 'TOUCHED') {
            continue; // 已消耗的不再评估
        }
        var r = liquidityLifecycle.evaluateLiquidity(l, candle);
        if (!r) {
            continue;
        }
        registry.applyLifecycleEvent(l.id, r);
        if (r.status === 'SWEPT') {
            var ev = sweepEventAdapter.buildSweepEvent(l, candle, index);
            if (ev) {
                ev.timeframe = state.timeframe;
                if (state.eventRegistry.add(ev)) {
                    newSweeps.push(ev);
                }
            }
        }
    }

    var canonical = state.displacementStore.process(rawDisplacements || [], evaluationTime);
    return { taken: newTaken, sweeps: newSweeps, displacements: canonical.created, displacementEvidenceUpdated: canonical.updated };
}

/**
 * 每根 K 增量 FVG：新 K 形成的新 FVG（窗口 [i-2, i]）+ 已有 ACTIVE FVG 逐根 lifecycle
 *
 * Phase 11R.1 修复（P0）：
 * - 显式接收完整 candles + index，tail = candles.slice(max(0, index-2), index+1)
 *   （旧实现用 state.candlesSlice.slice(-3)，取的是整个数据集最后三根，
 *    导致回放大部分时间 FVG Registry 没有记录当前时刻真正形成的 FVG）
 * - FVG lifecycle 从 formation candle 之后一根开始：
 *   第三根 K 收盘后才确认 FVG，它自己不能又被当作未来回踩（formation ≠ mitigation）
 */
function incrementalFvg(state, candles, candle, index, evaluationTime, exchangeInfo, displacementsAll) {
    if (index < 2 || !candles || candles.length < 3) {
        return;
    }

    // 新 FVG：只检测当前 [index-2, index] 三根（全局时间语义）
    var tail = candles.slice(Math.max(0, index - 2), index + 1);
    if (tail.length < 3) {
        return;
    }
    var newFvgs = fvgDetector.detectFvg(tail, {
        symbol: state.symbol,
        timeframe: state.timeframe,
        evaluationTime: evaluationTime,
        tickSize: exchangeInfo.tickSize,
        displacements: displacementsAll,
        // Phase 11R.1：全局索引（tail 切片时 displacement 关联/ATR 必须用全局索引）
        baseIndex: index - 2,
        atrSeries: state.atrSeries
    });
    // 修正 candleIndex（tail 内索引 → 全局索引）+ id 基于全局 openTime
    newFvgs.forEach(function (f) {
        f.candleIndex = index;
        f.id = state.symbol + ':' + state.timeframe + ':FVG:' + f.direction + ':' + candle.openTime;
        state.fvgReg.add(f);
    });

    // lifecycle：只推进【已确认】（candleIndex < index）的 FVG；
    // 本根刚形成（candleIndex === index）的 FVG 不参与自身评估。
    var fvgs = state.fvgReg.getAll(state.symbol);
    for (var i = 0; i < fvgs.length; i++) {
        var f = fvgs[i];
        if (f.candleIndex >= index) {
            continue; // formation candle 不是 mitigation candle
        }
        if (f.status === 'ACTIVE' || f.status === 'TOUCHED' || f.status === 'MIDPOINT_TOUCHED') {
            var r = fvgLifecycle.evaluateFvg(f, candle);
            if (r && r.changed) {
                fvgLifecycle.applyFvgEvent(f, r);
            }
        }
    }
}

/**
 * 每根 K 推进 pending trade（增量模拟 + cancelCheck）
 * @returns {Object|null} 本根结算的 trade 结果
 */
function updatePendingTrade(state, candle, index, options) {
    var pending = state.pendingTrade;
    if (!pending) {
        return null;
    }
    // P0（Phase 11T.5R）：信号 K 禁止 self-fill —— 策略在 candle N 收盘后才生成 plan，
    // 用 N 的 high/low 判断成交 = future leakage。最早允许 fill 的是 candle N+1。
    // 信号 K 完全跳过 pending 处理（不 fill、不 cancelCheck、不 waitBars++）。
    if (pending.phase === 'WAIT_ENTRY' && index <= pending.entryIndex) {
        return null;
    }
    var cfg = (options && options.thresholds || require('../config/thresholds')).trade;

    var plan = pending.plan;
    var direction = plan.direction;
    var entryPrice = plan.entry.price;
    var stopPrice = plan.stop.price;
    var targetPrice = plan.target.price;
    var initialRisk = direction === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;

    // ---- WAIT_ENTRY ----
    if (pending.phase === 'WAIT_ENTRY') {
        // Phase 11E.4：waitTrace（每根原始状态，供 cancel-policy shadow 离线重放）
        if (pending.waitTrace) {
            var touchNow = (direction === 'LONG' && candle.low <= entryPrice && candle.high >= entryPrice) ||
                           (direction === 'SHORT' && candle.high >= entryPrice && candle.low <= entryPrice);
            var traceReason = pending.cancelCheck
                ? pending.cancelCheck.call(pending, state, candle, index)
                : null;
            pending.waitTrace.push({
                bar: pending.waitBars,
                index: index,
                touchEntry: touchNow,
                cancelReason: traceReason,
                close: candle.close
            });
        }
        // cancelCheck（Phase 11E.1：返回原因字符串，null = 不取消）
        var cancelReason = pending.cancelCheck
            ? pending.cancelCheck.call(pending, state, candle, index)
            : null;
        if (cancelReason) {
            var cancelled = settleTrade(state, pending, 'CANCELLED', null, candle.closeTime, false, index);
            cancelled.cancelReason = cancelReason;
            cancelled.cancelAt = candle.closeTime;
            cancelled.cancelElapsedBars = pending.waitBars;
            cancelled.cancelPrice = candle.close;
            state.pendingTrade = null;
            state.trades.push(cancelled);
            return cancelled;
        }
        // 超时
        if (pending.waitBars >= (cfg.simulator.maxEntryWaitBars !== undefined ? cfg.simulator.maxEntryWaitBars : 12)) {
            var expired = settleTrade(state, pending, 'EXPIRED', null, candle.closeTime, false, index);
            state.pendingTrade = null;
            state.trades.push(expired);
            return expired;
        }
        // 尝试入场
        var fill = (direction === 'LONG' && candle.low <= entryPrice && candle.high >= entryPrice) ||
                   (direction === 'SHORT' && candle.high >= entryPrice && candle.low <= entryPrice);
        if (fill) {
            pending.phase = 'OPEN';
            pending.entryAt = candle.closeTime;
            pending.holdBars = 0;
        } else {
            pending.waitBars++;
            return null;
        }
    }

    // ---- OPEN ----
    if (pending.phase === 'OPEN') {
        pending.holdBars++;

        // MAE / MFE（Phase 11T：记录 MAE-before-MFE 轨迹——MFE 创新高时锁存当时 MAE）
        if (direction === 'LONG') {
            if (entryPrice - candle.low > pending.mae) pending.mae = entryPrice - candle.low;
            if (candle.high - entryPrice > pending.mfe) {
                pending.mfe = candle.high - entryPrice;
                pending.maeAtMfePeak = pending.mae;
            }
        } else {
            if (candle.high - entryPrice > pending.mae) pending.mae = candle.high - entryPrice;
            if (entryPrice - candle.low > pending.mfe) {
                pending.mfe = entryPrice - candle.low;
                pending.maeAtMfePeak = pending.mae;
            }
        }
        // Phase 11E.2：excursion 轨迹（每根累计 MAE/MFE，价格单位）
        if (pending.excursion) {
            pending.excursion.push({ bar: pending.holdBars, mae: pending.mae, mfe: pending.mfe });
        }

        var stopHit = direction === 'LONG' ? candle.low <= stopPrice : candle.high >= stopPrice;
        var targetHit = direction === 'LONG' ? candle.high >= targetPrice : candle.low <= targetPrice;

        // Phase 11T：stop 触发前的 MFE（narrative 在被扫前走多远）
        if (stopHit && !targetHit) {
            pending.mfeBeforeStop = pending.mfe;
        }

        if (stopHit && targetHit) {
            var amb = settleTrade(state, pending, 'AMBIGUOUS', null, candle.closeTime, true, index);
            state.pendingTrade = null;
            state.trades.push(amb);
            return amb;
        }
        if (stopHit) {
            var loss = settleTrade(state, pending, 'LOSS', stopPrice, candle.closeTime, false, index);
            state.pendingTrade = null;
            state.trades.push(loss);
            return loss;
        }
        if (targetHit) {
            var win = settleTrade(state, pending, 'WIN', targetPrice, candle.closeTime, false, index);
            state.pendingTrade = null;
            state.trades.push(win);
            return win;
        }
    }

    return null;
}

/**
 * Phase 11E.2：入场后 excursion 采样与关键 bar 指标
 * @param {Array} history [{bar, mae, mfe}]（OPEN 后每根累计，价格单位）
 * @param {number} entryPrice
 * @param {string} direction 'LONG' | 'SHORT'
 * @param {number} initialRisk
 * @returns {Object} {
 *   at1, at2, at3, at5, at8, at12: {maeR, mfeR},
 *   barsToMaxMAE, barsToFirstPositiveMFE, barsTo1R
 * }
 */
function computeExcursion(history, entryPrice, direction, initialRisk) {
    var out = {
        at1: null, at2: null, at3: null, at5: null, at8: null, at12: null,
        barsToMaxMAE: null,
        barsToFirstPositiveMFE: null,
        barsTo1R: null
    };
    if (!history || history.length === 0) {
        return out;
    }
    var r = function (priceMove) {
        return initialRisk > 0 ? priceMove / initialRisk : 0;
    };
    [1, 2, 3, 5, 8, 12].forEach(function (b) {
        var hit = null;
        history.forEach(function (h) {
            if (h.bar <= b) { hit = h; }
        });
        if (hit) {
            out['at' + b] = {
                maeR: Math.round(r(hit.mae) * 1000) / 1000,
                mfeR: Math.round(r(hit.mfe) * 1000) / 1000
            };
        }
    });
    var maxMae = -1;
    history.forEach(function (h) {
        if (h.mae > maxMae) { maxMae = h.mae; out.barsToMaxMAE = h.bar; }
        if (out.barsToFirstPositiveMFE === null && h.mfe > 0) {
            out.barsToFirstPositiveMFE = h.bar;
        }
        if (out.barsTo1R === null && h.mae >= initialRisk) {
            out.barsTo1R = h.bar;
        }
    });
    return out;
}

function settleTrade(state, pending, status, exitPrice, exitAt, ambiguous, exitIndex) {
    var plan = pending.plan;
    var direction = plan.direction;
    var entryPrice = plan.entry.price;
    var stopPrice = plan.stop.price;
    var targetPrice = plan.target.price;
    var initialRisk = direction === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;

    var realizedR = 0;
    if (status === 'WIN') {
        realizedR = direction === 'LONG'
            ? (targetPrice - entryPrice) / initialRisk
            : (entryPrice - targetPrice) / initialRisk;
    } else if (status === 'LOSS') {
        realizedR = -1;
    }

    var result = {
        planId: plan.id,
        symbol: state.symbol,
        direction: direction,
        entryPrice: entryPrice,
        entryAt: pending.entryAt,
        entryIndex: pending.entryIndex !== undefined ? pending.entryIndex : null,
        exitPrice: exitPrice,
        exitAt: exitAt,
        exitIndex: exitIndex !== undefined ? exitIndex : null,
        stopPrice: stopPrice,
        targetPrice: targetPrice,
        rr: plan.rr,
        status: status,
        realizedR: Math.round(realizedR * 10000) / 10000,
        mae: Math.round(pending.mae * 10000) / 10000,
        mfe: Math.round(pending.mfe * 10000) / 10000,
        maeR: Math.round((pending.mae / initialRisk) * 10000) / 10000,
        mfeR: Math.round((pending.mfe / initialRisk) * 10000) / 10000,
        holdBars: pending.holdBars,
        waitBars: pending.waitBars,
        ambiguous: !!ambiguous,
        context: pending.context,
        createdAt: plan.createdAt,
        planContext: pending.planContext || null,
        // Phase 11E.4：waitTrace（WAIT_ENTRY 期间每根原始状态）
        waitTrace: pending.waitTrace || null
    };
    // Phase 11E.2：FILLED（OPEN 过）trade 的入场后 excursion 采样
    if (pending.excursion && pending.excursion.length > 0) {
        result.excursion = computeExcursion(pending.excursion, entryPrice, direction, initialRisk);
    }
    // Phase 11S：Stop Placement Diagnostics（旁路数据）
    if (pending.diagnostics) {
        result.diagnostics = pending.diagnostics;
    }
    // Phase 11T：Stop Semantics 轨迹（MAE-before-MFE / MFE-before-stop）
    result.maeAtMfePeak = pending.maeAtMfePeak !== undefined ? Math.round(pending.maeAtMfePeak * 10000) / 10000 : null;
    result.mfeBeforeStop = pending.mfeBeforeStop !== undefined ? Math.round(pending.mfeBeforeStop * 10000) / 10000 : null;
    return result;
}

/**
 * 记录 transition（Funnel 用，状态跃迁而非采样占用）
 * @param {boolean} [push] 是否 push 到 state.transitions（fullWarmup 的 warmup 段传 false，
 *                         只推进内部 prev* 状态跟踪，不产生 funnel 记录）
 */
function recordTransitions(state, stepInfo, push) {
    var t = state.transitions;
    var shouldPush = push !== false;

    // scenario transition
    if (state.prevScenarioState !== stepInfo.scenarioState) {
        var prev = state.prevScenarioState;
        if (shouldPush) {
            t.push({
                type: 'SCENARIO_TRANSITION',
                from: prev,
                to: stepInfo.scenarioState,
                index: state.index,
                evaluationTime: stepInfo.evaluationTime
            });
            if (stepInfo.scenarioState === 'BULLISH_WATCH' || stepInfo.scenarioState === 'BEARISH_WATCH') {
                t.push({
                    type: 'SCENARIO_ENTER_WATCH',
                    direction: stepInfo.scenarioState === 'BULLISH_WATCH' ? 'BULLISH' : 'BEARISH',
                    index: state.index,
                    evaluationTime: stepInfo.evaluationTime
                });
            }
        }
        state.prevScenarioState = stepInfo.scenarioState;
    }

    // gate transition
    if (state.prevGateState !== stepInfo.gateState) {
        if (shouldPush) {
            t.push({
                type: 'GATE_TRANSITION',
                from: state.prevGateState,
                to: stepInfo.gateState,
                index: state.index,
                evaluationTime: stepInfo.evaluationTime
            });
            if (stepInfo.gateState === 'ENTRY_READY') {
                t.push({
                    type: 'ENTRY_GATE_ENTER_READY',
                    index: state.index,
                    evaluationTime: stepInfo.evaluationTime
                });
            }
        }
        state.prevGateState = stepInfo.gateState;
    }

    // AMD transition
    if (state.prevAmdPhase !== stepInfo.amdPhase) {
        if (shouldPush) {
            t.push({
                type: 'AMD_TRANSITION',
                from: state.prevAmdPhase,
                to: stepInfo.amdPhase,
                index: state.index,
                evaluationTime: stepInfo.evaluationTime
            });
        }
        state.prevAmdPhase = stepInfo.amdPhase;
    }
}

module.exports = {
    createReplayState: createReplayState,
    incrementalLiquidity: incrementalLiquidity,
    incrementalEvents: incrementalEvents,
    incrementalFvg: incrementalFvg,
    updatePendingTrade: updatePendingTrade,
    recordTransitions: recordTransitions,
    settleTrade: settleTrade
};
