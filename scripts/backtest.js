/**
 * Historical Replay Backtest（Phase 11R）
 *
 * 用法：
 *   node scripts/backtest.js BTCUSDT 7      # 最近 7 天（每根 5m 决策）
 *   node scripts/backtest.js ETHUSDT 14
 *
 * 数据：Binance USDⓈ-M Futures（经 7890 代理），
 *       按 replayStart - warmup → replayEnd 加载全部 timeframe（historicalLoader）
 * 回放：每根 5m K 推进状态机（Persistent AMD / FVG lifecycle / Gate previousState /
 *       Pending Trade 增量 + cancelCheck）；慢变量快照每 12 根刷新
 * 输出：CONTINUITY（数据完整性）+ FUNNEL（状态跃迁口径）+ EXPECTANCY
 *
 * IMPORTANT: 历史回放模拟，不是实盘信号。
 */
var binanceRest = require('../data/binanceRest');
var historicalLoader = require('../replay/historicalLoader');
var continuityChecker = require('../replay/continuityChecker');
var replayEngine = require('../replay/replayEngine');
var replayStats = require('../stats/replayStats');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '7', 10);
var SNAPSHOT_INTERVAL = process.env.SNAPSHOT_INTERVAL !== undefined
    ? parseInt(process.env.SNAPSHOT_INTERVAL, 10)
    : 12; // 慢变量快照刷新间隔（默认 12；SNAPSHOT_INTERVAL=1 为 correctness oracle）
var LOG_EVERY = 12; // 日志节流：每 12 根打印一次（决策仍然是每根）

// Phase 11T.4/11T.5：Narrative Snapshot Retention（正式启用，默认 on）
// 正式化后默认 enabled=true；DISABLE_LAST_NARRATIVE=1 可强制关闭（改动前对照 / 诊断）。
if (process.env.DISABLE_LAST_NARRATIVE === '1') {
    require('../config/thresholds').amd.lastNarrative.enabled = false;
}

// 诊断：固定 endTime（同窗口对照，排除窗口前移噪声）
var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

function fmt(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd, ' + fmt(startTime) + ' -> ' + fmt(endTime) + ') ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        // ---- Continuity Check ----
        console.log('');
        console.log('CONTINUITY CHECK');
        ['5m', '1h', '4h', '1d', '1w', '1M'].forEach(function (iv) {
            var cc = continuityChecker.checkContinuity(data[iv], iv);
            var line = '  ' + pad(iv, 3) + ' n=' + pad(cc.total, 6) +
                ' expected=' + pad(cc.expected, 6) +
                (cc.valid ? '  OK' : '  GAPS ' + cc.gaps.length + ' / DUP ' + cc.duplicates.length + ' / OOO ' + cc.outOfOrder.length);
            console.log(line);
        });

        var candles5m = data['5m'];
        console.log('');
        console.log('5m: ' + candles5m.length + ' bars  [' + candles5m[0].source + ']  tickSize ' + data.exchangeInfo.tickSize);
        console.log('Replay: every 5m bar decision, slow snapshot every 12 bars');
        console.log('');

        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3)); // warmup：至少 300 根或 30%
        console.log('Replay: every 5m bar decision, slow snapshot every ' + SNAPSHOT_INTERVAL + ' bars');
        console.log('');
        var t0 = Date.now();
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: {
                '1d': data['1d'],
                '4h': data['4h'],
                '1h': data['1h']
            },
            calendarCandles: {
                '1d': data['1d'],
                '1w': data['1w'],
                '1M': data['1M']
            },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: SNAPSHOT_INTERVAL,
            logEvery: LOG_EVERY
        }, {
            onStep: function (step, n) {
                if (n % 200 === 0) {
                    console.log('  bar ' + step.index + ' @ ' + fmt(step.evaluationTime) +
                        ' [' + step.scenarioState + ' / ' + step.action + ' / AMD ' + step.amdState + ']');
                }
            }
        }).then(function (result) {
            console.log('');
            report(SYMBOL, result, startIndex, candles5m, data, Math.round((Date.now() - t0) / 1000));
        });
    })
    .catch(function (error) {
        console.error('BACKTEST FAILED:', error);
        process.exit(1);
    });

function report(symbol, result, startIndex, candles, data, runtimeSec) {
    var steps = result.steps;
    var trades = result.trades;
    var funnel = replayStats.computeFunnel(result.transitions);
    var overall = replayStats.computeOverall(trades);
    var byBias = replayStats.groupExpectancy(trades, ['context.bias']);
    var byAmd = replayStats.groupExpectancy(trades, ['context.amd']);
    var byDraw = replayStats.groupExpectancy(trades, ['context.draw']);

    console.log('========================================');
    console.log(symbol + '  HISTORICAL REPLAY  (' + fmt(steps[0].evaluationTime) + ' -> ' + fmt(steps[steps.length - 1].evaluationTime) + ')');
    console.log('Decision: every 5m bar (' + steps.length + ' bars from index ' + startIndex + ')');
    console.log('');

    // ---- Run #6 DATA 段 ----
    console.log('DATA');
    console.log('  bars          ' + (candles ? candles.length : steps.length));
    console.log('  evaluated     ' + steps.length + '  (warmup ' + startIndex + ' bars)');
    console.log('  runtime       ' + (runtimeSec !== undefined ? runtimeSec + 's' : 'N/A'));
    console.log('  source        ' + (candles && candles[0] ? candles[0].source : 'N/A'));
    console.log('');

    console.log('FUNNEL (state transitions, unique opportunities)');
    // denominator 一律用 evaluated bars（steps.length），不依赖 transition 计数
    var base = steps.length;
    var pct = function (n) {
        return (base > 0 ? (n / base * 100) : 0).toFixed(3) + '%';
    };
    var amdManipCount = steps.filter(function (s) { return s.amdState === 'MANIPULATION_CONFIRMED'; }).length;
    var amdDistCount = steps.filter(function (s) { return s.amdState === 'DISTRIBUTION_CONFIRMED'; }).length;
    console.log('  bars evaluated     ' + pad(steps.length, 6));
    console.log('  directional bias   ' + pad(steps.filter(function (s) { return s.biasDirection !== 'NEUTRAL'; }).length, 6) + '  ' + pad(pct(steps.filter(function (s) { return s.biasDirection !== 'NEUTRAL'; }).length), 8));
    console.log('  AMD manipulation   ' + pad(amdManipCount, 6) + '  ' + pad(pct(amdManipCount), 8));
    console.log('  AMD distribution   ' + pad(amdDistCount, 6) + '  ' + pad(pct(amdDistCount), 8));
    console.log('  WATCH opportunities' + pad(funnel.watchEntries, 6) + '  ' + pad(pct(funnel.watchEntries), 8));
    console.log('  ENTRY_READY        ' + pad(funnel.entryReadyEntries, 6) + '  ' + pad(pct(funnel.entryReadyEntries), 8));
    console.log('  plans READY        ' + pad(funnel.plansReady, 6) + '  ' + pad(pct(funnel.plansReady), 8));
    console.log('  trades filled      ' + pad(funnel.tradeFilled, 6) + '  ' + pad(pct(funnel.tradeFilled), 8));
    if (amdManipCount + amdDistCount > 0) {
        console.log('  AMD manip/dist → WATCH conversion: ' +
            funnel.watchEntries + ' / ' + (amdManipCount + amdDistCount) + ' = ' +
            (funnel.watchEntries / (amdManipCount + amdDistCount) * 100).toFixed(1) + '%');
    }
    console.log('');

    console.log('AMD STATE OCCUPANCY (per bar)');
    var amdCount = {};
    steps.forEach(function (s) { amdCount[s.amdState] = (amdCount[s.amdState] || 0) + 1; });
    Object.keys(amdCount).sort().forEach(function (k) {
        console.log('  ' + pad(k, 28) + pad(amdCount[k], 6));
    });
    console.log('');

    // ---- Run #6 ALIGNMENT 段 ----
    console.log('ALIGNMENT OCCUPANCY (per bar)');
    var alignCount = {};
    steps.forEach(function (s) { alignCount[s.alignment || 'UNCONFIRMED'] = (alignCount[s.alignment || 'UNCONFIRMED'] || 0) + 1; });
    ['MATCH', 'OPPOSITE', 'UNCONFIRMED'].forEach(function (k) {
        console.log('  ' + pad(k, 28) + pad(alignCount[k] || 0, 6));
    });
    console.log('');

    console.log('GATE STATE OCCUPANCY (per bar)');
    var gateCount = {};
    steps.forEach(function (s) { gateCount[s.gateState] = (gateCount[s.gateState] || 0) + 1; });
    Object.keys(gateCount).sort().forEach(function (k) {
        console.log('  ' + pad(k, 28) + pad(gateCount[k], 6));
    });
    // WATCH 期间的 gate 分布（诊断 ENTRY_READY=0 断在哪）
    var watchSteps = steps.filter(function (s) { return s.scenarioState.indexOf('WATCH') !== -1; });
    if (watchSteps.length > 0) {
        var watchGate = {};
        watchSteps.forEach(function (s) { watchGate[s.gateState] = (watchGate[s.gateState] || 0) + 1; });
        console.log('  (during WATCH: ' + JSON.stringify(watchGate) + ')');
    }
    console.log('');

    // ---- Run #6 MEMORY DIAGNOSTICS 段 ----
    var lastStep = steps[steps.length - 1];
    console.log('MEMORY DIAGNOSTICS (end of window)');
    console.log('  active liquidity ' + (lastStep ? lastStep.activeLiquidityCount : 'N/A'));
    console.log('  events          ' + (lastStep ? lastStep.eventCount : 'N/A'));
    console.log('  consumedRefs    total ' + (lastStep ? lastStep.consumedRefsCount : 'N/A') +
        '  >1d ' + (lastStep ? lastStep.consumedRefsOlderThan1d : 'N/A') +
        '  >7d ' + (lastStep ? lastStep.consumedRefsOlderThan7d : 'N/A'));
    console.log('');

    console.log('TRADE RESULTS');
    console.log('  Total ' + overall.total + ' | WIN ' + overall.wins + ' | LOSS ' + overall.losses +
        ' | AMBIGUOUS ' + overall.ambiguous + ' | EXPIRED ' + overall.expired + ' | CANCELLED ' + overall.cancelled +
        ' | OPEN_AT_END ' + overall.openEnd);
    console.log('  Win rate (closed): ' + (overall.winRate * 100).toFixed(1) + '%');
    console.log('  Avg R: ' + overall.avgR + '   Median R: ' + overall.medianR + '   Total R: ' + overall.totalR);
    console.log('  Profit factor: ' + overall.profitFactor + '   Max consecutive losses: ' + overall.maxConsecLosses);
    console.log('  Avg hold bars: ' + overall.avgHoldBars + '   Avg MFE R: ' + overall.avgMfeR + '   Avg MAE R: ' + overall.avgMaeR);
    console.log('  (R = risk multiple, not probability; OPEN_AT_END = 回放结束未平仓，realizedR 不计入)');
    console.log('');

    function printGroup(title, groups) {
        console.log(title);
        var keys = Object.keys(groups).sort();
        if (keys.length === 0) {
            console.log('  (no closed trades)');
            console.log('');
            return;
        }
        keys.forEach(function (k) {
            var g = groups[k];
            console.log('  ' + pad(k, 14) + ' n=' + pad(g.total, 4) +
                '  win ' + pad((g.winRate * 100).toFixed(0) + '%', 5) +
                '  avgR ' + pad(g.avgR, 7) +
                '  totalR ' + pad(g.totalR, 8) +
                '  maxLoss ' + g.maxConsecLosses);
        });
        console.log('');
    }

    printGroup('EXPECTANCY BY BIAS', byBias);
    printGroup('EXPECTANCY BY AMD', byAmd);
    printGroup('EXPECTANCY BY DRAW', byDraw);

    console.log('RECENT TRADES');
    trades.slice(-8).forEach(function (t) {
        var fvgScore = t.diagnostics && t.diagnostics.fvgScore !== undefined && t.diagnostics.fvgScore !== null
            ? t.diagnostics.fvgScore : 'N/A';
        console.log('  ' + fmt(t.createdAt) + ' ' + pad(t.direction, 5) +
            ' ' + pad(t.status, 10) +
            ' entry ' + t.entryPrice + ' stop ' + t.stopPrice + ' target ' + t.targetPrice +
            ' rr ' + t.rr + ' realizedR ' + t.realizedR +
            ' [' + t.context.bias + '|' + t.context.amd + '|' + t.context.draw + ']' +
            ' fvg ' + fvgScore);
    });
    if (trades.length === 0) {
        console.log('  (none — no plan reached READY + fill)');
    }
    console.log('');

    // ---- Phase 11S：STOP DIAGNOSTICS（只诊断，不调参） ----
    reportStopDiagnostics(trades, candles);

    // ---- Phase 11S.1：RETRACE + SHADOW ENTRY DIAGNOSTICS（只诊断） ----
    reportRetraceDiagnostics(result.retraces);

    // ---- Phase 11D：Narrative Diagnostics（三张表，先不看交易盈亏） ----
    reportNarrativeDiagnostics(steps, candles);

    // ---- Phase 11T：Stop Semantics Audit（纯诊断，不改正式规则） ----
    reportStopSemantics(result, candles);

    // ---- Phase 11T.2：Stop Candidate V2 Counterfactual（shadow only, baseline frozen） ----
    reportStopV2Counterfactual(result, candles, symbol);

    // ---- Phase 11T.3：Narrative Boundary Integrity Audit（四张表，只诊断） ----
    reportNarrativeBoundary(result, candles, symbol);

    // ---- Phase 11E：Execution Diagnostics（11E.1 取消审计 + 11E.2 excursion，只诊断） ----
    reportExecutionDiagnostics(result, candles);

    // ---- Phase 11E.4：Cancel Policy Shadow（5 模型离线重放，只诊断） ----
    reportCancelShadow(result, candles);

    // ---- Phase 11E.6：Directional Confirmation funnel（正式化后全链路） ----
    reportConfirmationFunnel(result);

    // ---- Phase 11E.7：Gate 语义 shadow（close-in-zone vs wick-touch + score 分布） ----
    reportGateShadow(result);

    // ---- Phase 11N：Narrative Direction Validation（交易层拿掉，只看方向） ----
    reportNarrativeDirection(result, candles);

    // ---- Phase 11D.3：Opportunity / DisplacementLeg 统计（ICT 父级，诊断） ----
    reportOpportunities(result);

    // ---- Phase 11D.7：Opportunity Quality Tier（MSS × Leg × Near Draw → 1h Validation） ----
    reportOpportunityQuality(result, candles);

    // ---- Phase 11D.8：Opportunity Alert Replay（历史通知回放 + 距离分层，防统计幻觉） ----
    reportAlertReplay(result, candles);

    // ---- Phase 11D.9：Delivery Alignment Audit（A/B/C 类拆分，方向质量） ----
    reportDeliveryAlignment(result, candles);

    // ---- Phase 11D.10：HTF Liquidity Context（sweep 层级，1H/4H pivots + PDH/PDL） ----
    reportHtfLiquidityContext(result, candles, data);

    // ---- Phase 11D.6：MSS Reference 检测审计（为什么没有 PROTECTED/HTF 档） ----
    reportMssReferenceAudit(result);

    // ---- Phase 11D.6b：MSS 锚点方向验证（样本充足：全部 MSS 事件） ----
    reportMssDirection(result, candles);
    console.log('IMPORTANT: Historical replay simulation only. No order will be placed.');
    // Authoritative Run（11T.6）：进程内存用量（180d 长 registry 健康度）
    var mu = process.memoryUsage();
    console.log('MEMORY USAGE: rss ' + Math.round(mu.rss / 1048576) + 'MB / heapUsed ' + Math.round(mu.heapUsed / 1048576) + 'MB');
    console.log('========================================');
}

/**
 * Phase 11E.7 — Gate 语义 shadow（只诊断，gate 行为零改动）
 * 量化两个最可疑的 ENTRY_READY 瓶颈：
 *   a) close-in-zone vs wick-touch：ICT 2022 是价格"触及"FVG（wick 进入即可），
 *      当前实现要求收盘价在 zone 内 → touchButCloseOutside 计数
 *   b) FVG score 分布：score>=60（entryThreshold）是自研过滤器，ICT 无此概念 →
 *      被 60 门槛过滤掉的候选量（ge40lt60 部分）
 */
function reportGateShadow(result) {
    var gs = result.gateShadow || { touchButCloseOutside: 0, closeInside: 0, candTotal: 0, lt40: 0, ge40lt60: 0, ge60: 0, noDisp: 0 };
    var total = gs.touchButCloseOutside + gs.closeInside;
    console.log('GATE SEMANTIC SHADOW (Phase 11E.7 — diagnostic only, gate frozen)');
    if (total === 0) {
        console.log('  (no WAITING_RETRACE/ENTRY_READY bars sampled)');
    } else {
        console.log('  close-in-zone(ENTRY_READY) ' + gs.closeInside +
            ' vs wick-touch-but-close-outside ' + gs.touchButCloseOutside +
            ' → wick 触及但收盘在 zone 外的比例 ' + (gs.touchButCloseOutside / total * 100).toFixed(0) + '%');
        console.log('  候选 FVG score 分布（方向匹配 + displacement 关联后）：n=' + gs.candTotal +
            ' | <40 ' + gs.lt40 + ' | 40-60 ' + gs.ge40lt60 + ' | >=60 ' + gs.ge60 +
            '（entryThreshold=60 过滤掉 ' + gs.ge40lt60 + ' 个候选）');
        console.log('  无 displacementEventId 被排除 ' + gs.noDisp);
    }
    console.log('');
}

/**
 * Phase 11N — Narrative Direction Validation（只诊断，不改任何策略）
 * 锚点 = FVG 第一次真实回踩（wick 触及 zone），未来 30m/1h/4h 是否朝 Narrative 方向运行。
 * 三张表：① Direction Hit ② MFE/MAE ③ Primary Draw Hit；按 MATCH/OPPOSITE/UNCONFIRMED/ALL 分组。
 */
function reportNarrativeDirection(result, candles) {
    var narrativeDirection = require('../stats/narrativeDirection');
    var mssReference = require('../stats/mssReference');
    var displacementLeg = require('../stats/displacementLeg');
    // Phase 11D.4/11D.5：fvg → displacement → leg/MSS 链
    var dispByDispId = {};
    (result.displacementEvents || []).forEach(function (d) { dispByDispId[d.id] = d; });
    // 构建 DisplacementLeg（连续同向 displacement 合并）+ 补 candles 维度 + Leg Quality
    var mssById = {};
    (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    // Phase 11L.1：共享 15min 窗 authoritative leg 索引（与 Live 单一实现）
    var windowedLegs = displacementLeg.buildWindowedLegIndex(result.displacementEvents || [], candles || [], result.mssEvents || [], result.swings || []);
    var legQualityByDispId = {};
    Object.keys(windowedLegs).forEach(function (id) { legQualityByDispId[id] = windowedLegs[id].quality; });
    var fvgToMssQuality = {};
    var fvgToLegQuality = {};
    (result.fvgs || []).forEach(function (f) {
        var disp = f.displacementEventId ? dispByDispId[f.displacementEventId] : null;
        var mssId = disp && disp.metadata && disp.metadata.mssEventId ? disp.metadata.mssEventId : null;
        if (!mssId) {
            fvgToMssQuality[f.id] = 'NO_MSS';
        } else {
            var mssEvent = mssById[mssId];
            fvgToMssQuality[f.id] = mssEvent
                ? mssReference.classifyMssReference(mssEvent, result.swings || []).quality
                : 'NO_MSS';
        }
        fvgToLegQuality[f.id] = f.displacementEventId
            ? (legQualityByDispId[f.displacementEventId] || 'NO_LEG')
            : 'NO_LEG';
    });
    var retraces = result.retraces || [];
    var events = retraces.map(function (r) {
        return narrativeDirection.analyzeRetrace(r, candles, { fvgToMssQuality: fvgToMssQuality, fvgToLegQuality: fvgToLegQuality });
    }).filter(function (e) { return e !== null; });
    console.log('NARRATIVE DIRECTION VALIDATION (Phase 11N — trade layer removed, direction only)');
    if (events.length === 0) {
        console.log('  (no retrace with real FVG touch)');
        console.log('');
        return;
    }
    var sum = narrativeDirection.summarizeNarrativeDirection(events);
    var groups = sum.groups;

    function row(g, name) {
        var out = name + ' (n=' + g.n + ')';
        ['w30m', 'w1h', 'w4h'].forEach(function (w) {
            var s = g[w];
            out += ' | ' + (s.n > 0 ? '' : '') + 'hit ' + (s.n > 0 ? Math.round(s.hit / g.n * 100) + '%' : '-');
        });
        return out;
    }
    // ① Direction Hit Rate
    console.log('  ① Direction Hit（窗口结束净涨跌符合 Narrative）');
    console.log('  ' + pad('group', 18) + pad('n', 4) + pad('30m', 7) + pad('1h', 7) + pad('4h', 7));
    ['MATCH', 'OPPOSITE', 'UNCONFIRMED', 'ALL'].forEach(function (k) {
        var g = groups[k];
        if (!g || g.n === 0) return;
        console.log('  ' + pad(k, 18) + pad(g.n, 4) +
            ['w30m', 'w1h', 'w4h'].map(function (w) {
                return pad(Math.round(g[w].hit / g.n * 100) + '%', 7);
            }).join(''));
    });
    // ② MFE/MAE
    console.log('  ② MFE/MAE ratio（顺向 vs 反向波动比）');
    console.log('  ' + pad('group', 18) + pad('n', 4) + pad('30m', 7) + pad('1h', 7) + pad('4h', 7));
    ['MATCH', 'OPPOSITE', 'UNCONFIRMED', 'ALL'].forEach(function (k) {
        var g = groups[k];
        if (!g || g.n === 0) return;
        console.log('  ' + pad(k, 18) + pad(g.n, 4) +
            ['w30m', 'w1h', 'w4h'].map(function (w) {
                var s = g[w];
                var ratio = s.maeCnt > 0 && s.maeSum > 0 ? s.mfeSum / s.maeSum : 0;
                return pad(ratio.toFixed(2) + 'x', 7);
            }).join(''));
    });
    // ③ Draw Hit（Near vs Macro，Phase 11D.2 双层目标验证）
    console.log('  ③ Draw Hit（N = near 近端目标 / M = macro HTF 结构目标）');
    console.log('  ' + pad('group', 18) + pad('n', 4) + pad('30mN', 7) + pad('1hN', 7) + pad('4hN', 7) + pad('30mM', 7) + pad('1hM', 7) + pad('4hM', 7));
    ['MATCH', 'OPPOSITE', 'UNCONFIRMED', 'ALL'].forEach(function (k) {
        var g = groups[k];
        if (!g || g.n === 0) return;
        var cells = [];
        ['w30m', 'w1h', 'w4h'].forEach(function (w) {
            var s = g[w];
            cells.push(pad(s.nearTargetCnt > 0 ? Math.round(s.nearDrawHit / s.nearTargetCnt * 100) + '%' : '-', 7));
        });
        ['w30m', 'w1h', 'w4h'].forEach(function (w) {
            var s = g[w];
            cells.push(pad(s.targetCnt > 0 ? Math.round(s.drawHit / s.targetCnt * 100) + '%' : '-', 7));
        });
        console.log('  ' + pad(k, 18) + pad(g.n, 4) + cells.join(''));
    });
    // ④ BULLISH/BEARISH 拆分（direction hit）
    console.log('  ④ By Direction（Direction Hit）');
    console.log('  ' + pad('direction', 12) + pad('n', 4) + pad('30m', 7) + pad('1h', 7) + pad('4h', 7));
    ['BULLISH', 'BEARISH'].forEach(function (k) {
        var g = sum.byDirection[k];
        if (!g || g.n === 0) return;
        console.log('  ' + pad(k, 12) + pad(g.n, 4) +
            ['w30m', 'w1h', 'w4h'].map(function (w) {
                return pad(Math.round(g[w].hit / g.n * 100) + '%', 7);
            }).join(''));
    });
    // ⑤ By Symbol（direction hit）
    console.log('  ⑤ By Symbol（Direction Hit）');
    console.log('  ' + pad('symbol', 10) + pad('n', 4) + pad('30m', 7) + pad('1h', 7) + pad('4h', 7));
    Object.keys(sum.bySymbol).forEach(function (k) {
        var g = sum.bySymbol[k];
        console.log('  ' + pad(k, 10) + pad(g.n, 4) +
            ['w30m', 'w1h', 'w4h'].map(function (w) {
                return pad(Math.round(g[w].hit / g.n * 100) + '%', 7);
            }).join(''));
    });
    // ⑥ MSS Quality（Phase 11D.4：1h 主验证——Direction Hit / MFE / MAE / Near Draw Hit）
    console.log('  ⑥ By MSS Quality（1h 主验证：hit / MFE / MAE / Near Draw Hit）');
    console.log('  ' + pad('quality', 16) + pad('n', 4) + pad('hit', 7) + pad('MFE', 7) + pad('MAE', 7) + pad('nearHit', 8));
    ['NO_MSS', 'MICRO_INTERNAL', 'INTERNAL', 'PROTECTED_SWING', 'HTF_RELEVANT'].forEach(function (k) {
        var g = sum.byMssQuality[k];
        if (!g || g.n === 0) return;
        var w = g.w1h;
        var mfe = w.maeCnt > 0 ? (w.mfeSum / g.n).toFixed(2) + '%' : '-';
        var mae = w.maeCnt > 0 ? (w.maeSum / g.n).toFixed(2) + '%' : '-';
        console.log('  ' + pad(k, 16) + pad(g.n, 4) +
            pad(Math.round(w.hit / g.n * 100) + '%', 7) + pad(mfe, 7) + pad(mae, 7) +
            pad(w.nearTargetCnt > 0 ? Math.round(w.nearDrawHit / w.nearTargetCnt * 100) + '%' : '-', 8));
    });
    console.log('  (若 hit 随 quality 单调上升 → MSS quality 有方向增量价值；否则 MSS 对方向预测无增量)');
    // ⑦ MSS × Leg Quality 二维（Phase 11D.5：Protected Swing 被强 leg 打穿 = 高质量 MSS）
    console.log('  ⑦ MSS × Leg Quality（1h：hit / n / MFE / Near Draw Hit）');
    console.log('  ' + pad('mss|leg', 24) + pad('n', 4) + pad('hit', 7) + pad('MFE', 7) + pad('nearHit', 8));
    var comboOrder = ['NO_MSS|NO_LEG', 'NO_MSS|WEAK', 'NO_MSS|NORMAL', 'NO_MSS|STRONG', 'NO_MSS|EXPLOSIVE',
        'MICRO_INTERNAL|WEAK', 'MICRO_INTERNAL|NORMAL', 'MICRO_INTERNAL|STRONG',
        'INTERNAL|WEAK', 'INTERNAL|NORMAL', 'INTERNAL|STRONG', 'INTERNAL|EXPLOSIVE',
        'PROTECTED_SWING|WEAK', 'PROTECTED_SWING|NORMAL', 'PROTECTED_SWING|STRONG', 'PROTECTED_SWING|EXPLOSIVE',
        'HTF_RELEVANT|STRONG', 'HTF_RELEVANT|EXPLOSIVE'];
    comboOrder.forEach(function (k) {
        var g = sum.byMssLegCombo[k];
        if (!g || g.n === 0) return;
        var w = g.w1h;
        console.log('  ' + pad(k, 24) + pad(g.n, 4) +
            pad(Math.round(w.hit / g.n * 100) + '%', 7) +
            pad(w.maeCnt > 0 ? (w.mfeSum / g.n).toFixed(2) + '%' : '-', 7) +
            pad(w.nearTargetCnt > 0 ? Math.round(w.nearDrawHit / w.nearTargetCnt * 100) + '%' : '-', 8));
    });
    console.log('  (期望：MICRO+WEAK 低 → INTERNAL+STRONG 中 → PROTECTED+STRONG/EXPLOSIVE 高 → 即 MSS 质量被 leg 动量激活)');
    console.log('');
}

/**
 * Phase 11D.3 — Opportunity / DisplacementLeg 统计（ICT 父级，只诊断）
 * 同一 Displacement Leg 的多个 FVG = 一个机会（钉钉推送去重单位）
 */
function reportOpportunities(result) {
    var opportunity = require('../stats/opportunity');
    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    var s = opportunity.summarizeOpportunities(opps);
    console.log('OPPORTUNITY STATS (Phase 11D.3 — DisplacementLeg 父级，只诊断)');
    if (opps.length === 0) {
        console.log('  (no opportunities)');
        console.log('');
        return;
    }
    console.log('  opportunities ' + s.opportunities + ' | FVG ' + s.totalFvgs +
        ' | 合并率 ' + (s.opportunities > 0 ? Math.round((1 - s.opportunities / s.totalFvgs) * 100) + '%' : '-') +
        ' | 多 FVG 机会 ' + s.multiFvgOpps + ' | MSS 关联 ' + s.mssLinkedOpps +
        ' | avg FVG/机会 ' + s.avgFvgPerOpp.toFixed(1));
    // 每机会 FVG 数分布
    var hist = { 1: 0, 2: 0, 3: 0, '4+': 0 };
    opps.forEach(function (o) {
        var n = o.fvgIds.length;
        if (n >= 4) hist['4+']++;
        else hist[n]++;
    });
    console.log('  FVG 数分布：' + Object.keys(hist).map(function (k) { return k + ' FVG × ' + hist[k]; }).join(' | '));
    console.log('  (同一 leg 连续同向 displacement 合并，窗口 ' + (opportunity.LEG_MERGE_MS / 60000) + ' 分钟；');
    console.log('   钉钉推送将以 Opportunity 为单位，不再同一次 displacement 连推多个 FVG)');
    console.log('');
}

/**
 * Phase 11D.7 — Opportunity Quality Tier（规则分层 + 1h Validation，纯诊断）
 * Structure(MSS) × Delivery(Leg) × Reachable Draw(Near) → HIGH/WATCH/LOW → 1h 表现
 * 锚 = leg 完成时刻（最早 N+1 观察），大样本，不依赖稀有 FVG retrace。
 */
function reportOpportunityQuality(result, candles) {
    var opportunity = require('../stats/opportunity');
    var displacementLeg = require('../stats/displacementLeg');
    var mssReference = require('../stats/mssReference');
    var opportunityQuality = require('../stats/opportunityQuality');

    // 1. legs：displacement → leg（+ candles 价量维度 + leg quality + mss quality 重算）
    var mssById = {};
    (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    // Phase 11L.1：共享 15min 窗 authoritative leg 索引（与 Live 单一实现）
    var legByDispId = displacementLeg.buildWindowedLegIndex(result.displacementEvents || [], candles || [], result.mssEvents || [], result.swings || []);

    // 2. opportunities → tier index
    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    var items = opportunityQuality.buildTierIndex(opps, result.fvgs || [], legByDispId, result.drawTrace || []);

    console.log('OPPORTUNITY QUALITY TIER (Phase 11D.7 — MSS × Leg × Near Draw → 分层，只诊断)');
    if (items.length === 0) {
        console.log('  (no opportunities)');
        console.log('');
        return;
    }

    // tier 分布 + 组成
    var byTier = {};
    items.forEach(function (it) {
        var k = it.tier + '|' + it.mssQuality + '|' + it.legQuality;
        byTier[k] = (byTier[k] || 0) + 1;
    });
    var tierOrder = ['HIGH_QUALITY', 'WATCH', 'LOW_QUALITY'];
    tierOrder.forEach(function (t) {
        var n = items.filter(function (it) { return it.tier === t; }).length;
        var withLeg = items.filter(function (it) { return it.tier === t && it.hasLeg; }).length;
        var withNear = items.filter(function (it) { return it.tier === t && it.hasLeg && it.nearTarget !== null && it.nearTarget !== undefined; }).length;
        console.log('  ' + pad(t, 14) + pad(n, 6) + ' 个机会' +
            ' | 有 leg 锚点 ' + withLeg + ' | 有 near draw ' + withNear);
        // 组成（mss|leg 前 3）
        var comp = Object.keys(byTier).filter(function (k) { return k.indexOf(t + '|') === 0; })
            .sort(function (a, b) { return byTier[b] - byTier[a]; }).slice(0, 3);
        comp.forEach(function (k) {
            console.log('      ' + k.split('|')[1] + '|' + k.split('|')[2] + ' × ' + byTier[k]);
        });
    });

    // 3. 1h validation（11L.4：锚 = 通知可用时点 availableAt 之后 N+1）
    var agg = opportunityQuality.validateTiers(items, candles || [], 12);
    console.log('  1H VALIDATION（11L.4：锚 = 通知可用时点 availableAt 之后 N+1）');
    console.log('  ' + pad('tier', 14) + pad('n', 5) + pad('dirHit', 8) + pad('MFE', 9) + pad('MAE', 9) + pad('nearHit', 9));
    tierOrder.forEach(function (t) {
        var a = agg[t];
        if (!a || a.n === 0) {
            console.log('  ' + pad(t, 14) + pad(0, 5) + '  (no anchored opportunities)');
            return;
        }
        console.log('  ' + pad(t, 14) + pad(a.n, 5) +
            pad(Math.round(a.hit / a.n * 100) + '%', 8) +
            pad((a.mfeSum / a.n).toFixed(2) + '%', 9) +
            pad((a.maeSum / a.n).toFixed(2) + '%', 9) +
            pad(a.nearCnt > 0 ? Math.round(a.nearHit / a.nearCnt * 100) + '%' : '-', 9));
    });
    console.log('  (期望 HIGH > WATCH > LOW 单调：方向 hit / MFE / nearHit；MAE 反向单调；');
    console.log('   tier 只含 Structure+Delivery+Near，direction conflict 在 retrace 层单独看)');
    console.log('');
}

/**
 * Phase 11D.8 — Opportunity Alert Replay（历史通知回放，纯诊断）
 * 验证"过去 90 天如果已部署，我会收到什么通知、值不值得看"。
 * 通知时点 = 信息完备（leg 完成），同一 opp 只通知一次；含 Near Draw 距离分层
 * 防统计幻觉（<0.1 / 0.1-0.25 / 0.25-0.5 / 0.5-1 / >1 %）。
 */
function reportAlertReplay(result, candles) {
    var opportunity = require('../stats/opportunity');
    var displacementLeg = require('../stats/displacementLeg');
    var mssReference = require('../stats/mssReference');
    var alertReplay = require('../stats/alertReplay');

    // legs（与 11D.7 同构）
    var mssById = {};
    (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    // Phase 11L.1：共享 15min 窗 authoritative leg 索引（与 Live 单一实现）
    var legByDispId = displacementLeg.buildWindowedLegIndex(result.displacementEvents || [], candles || [], result.mssEvents || [], result.swings || []);

    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
        result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);
    var a = alertReplay.assessAlerts(alerts, candles || []);

    console.log('ALERT REPLAY (Phase 11D.8 — 历史通知回放，只诊断)');
    if (alerts.length === 0) {
        console.log('  (no alerts)');
        console.log('');
        return;
    }
    console.log('  通知总数 ' + alerts.length + ' | 覆盖 ' + a.days + ' 天 | 平均 ' + a.perDay.toFixed(1) + ' 条/天' +
        ' | HIGH ' + (a.byTier.HIGH_QUALITY || 0) + ' (每周 ' + a.perWeekHigh.toFixed(1) + ')' +
        ' | 不可评估（通知点超出数据）' + a.incomplete);
    console.log('  byTier：HIGH ' + (a.byTier.HIGH_QUALITY || 0) + ' | WATCH ' + (a.byTier.WATCH || 0) +
        ' | LOW ' + (a.byTier.LOW_QUALITY || 0));

    // 通知质量（30m/1h）—— 11L.4：锚 = 通知可用时点 availableAt 之后 N+1
    console.log('  通知质量（11L.4：锚 = 通知可用时点 availableAt 之后 N+1，修正 information-availability leakage）');
    console.log('  ' + pad('tier', 14) + pad('n', 5) +
        pad('nearHit30m', 11) + pad('nearHit1h', 11) + pad('MFE1h', 9) + pad('MAE1h', 9));
    ['HIGH_QUALITY', 'WATCH', 'LOW_QUALITY'].forEach(function (t) {
        var s = a.tierStats[t];
        if (!s || s.n === 0) {
            console.log('  ' + pad(t, 14) + pad(0, 5));
            return;
        }
        console.log('  ' + pad(t, 14) + pad(s.n, 5) +
            pad(s.w30m.nearCnt > 0 ? Math.round(s.w30m.nearHit / s.w30m.nearCnt * 100) + '%' : '-', 11) +
            pad(s.w1h.nearCnt > 0 ? Math.round(s.w1h.nearHit / s.w1h.nearCnt * 100) + '%' : '-', 11) +
            pad((s.w1h.mfeSum / s.n).toFixed(2) + '%', 9) +
            pad((s.w1h.maeSum / s.n).toFixed(2) + '%', 9));
    });

    // Near Draw 距离分层（防统计幻觉核心）
    console.log('  Near Draw 距离分层（nearHit1h，防"距离太近天然命中"幻觉）');
    console.log('  ' + pad('bucket', 12) + pad('HIGH', 8) + pad('WATCH', 8) + pad('LOW', 8) + pad('HIGH n', 8));
    alertReplay.DIST_BUCKETS.forEach(function (b) {
        var d = a.distBuckets[b.key];
        if (!d) {
            console.log('  ' + pad(b.key, 12) + pad('-', 8) + pad('-', 8) + pad('-', 8) + pad(0, 8));
            return;
        }
        function cell(tier) {
            var x = d[tier];
            if (!x || x.nearCnt1h === 0) return '-';
            return Math.round(x.nearHit1h / x.nearCnt1h * 100) + '%';
        }
        console.log('  ' + pad(b.key, 12) +
            pad(cell('HIGH_QUALITY'), 8) + pad(cell('WATCH'), 8) + pad(cell('LOW_QUALITY'), 8) +
            pad(d.HIGH_QUALITY ? d.HIGH_QUALITY.n : 0, 8));
    });
    console.log('  (若 >0.5% 距离桶 HIGH 仍明显 >> WATCH/LOW → 信号硬；若仅 <0.25% 近桶占优 → 距离幻觉)');
    console.log('');

    // 最近 25 条通知（真实时间顺序；11L.4：time = 通知可用时点 availableAt）
    console.log('  最近 25 条通知（时间升序，同一 Opportunity 仅一次；time = notifiedAt）');
    console.log('  ' + pad('#', 4) + pad('time', 17) + pad('dir', 8) + pad('tier', 14) +
        pad('mss|leg', 24) + pad('near%', 8) + pad('fvg', 5) + pad('sweep', 18) + pad('price', 12));
    alerts.slice(-25).forEach(function (al, k) {
        var idx = alerts.length - 25 + k;
        var notifyTime = al.availableAt !== undefined && al.availableAt !== null ? al.availableAt : al.anchorTime;
        console.log('  ' + pad(idx + 1, 4) + pad(fmt(notifyTime + 8 * 3600000), 17) +
            pad(al.direction === 'BULLISH' ? 'LONG' : 'SHORT', 8) +
            pad(al.tier.replace('_QUALITY', ''), 14) +
            pad((al.mssQuality === 'NO_MSS' ? 'noMSS' : al.mssQuality.replace('_SWING', '')) + '|' + al.legQuality, 24) +
            pad(al.nearDistPct !== null ? al.nearDistPct.toFixed(2) + '%' : '-', 8) +
            pad(al.fvgCount, 5) +
            pad(al.sweep ? (al.sweep.side + '@' + al.sweep.price.toFixed(1) + ' (-' + al.sweep.barsAgo + ')') : '-', 18) +
            pad(al.anchorPrice.toFixed(1), 12));
    });
    console.log('');

    // 人工抽查清单：HIGH_QUALITY 均匀抽样 25 条（TradingView 核对；11L.4：time = notifiedAt）
    var highs = alerts.filter(function (al) { return al.tier === 'HIGH_QUALITY'; });
    console.log('  人工抽查清单（HIGH_QUALITY 均匀抽样 ' + Math.min(25, highs.length) + ' 条，TradingView 核对；time = notifiedAt）');
    console.log('  ' + pad('#', 4) + pad('time(UTC+8)', 17) + pad('dir', 6) + pad('price', 11) +
        pad('mssRef', 12) + pad('break%', 8) + pad('legAtr', 8) + pad('near%', 8) + pad('fvgZone', 18));
    var step = Math.max(1, Math.floor(highs.length / 25));
    var sampled = [];
    for (var i = 0; i < highs.length && sampled.length < 25; i += step) {
        sampled.push(highs[i]);
    }
    sampled.forEach(function (al, k) {
        var notifyTime = al.availableAt !== undefined && al.availableAt !== null ? al.availableAt : al.anchorTime;
        console.log('  ' + pad(k + 1, 4) + pad(fmt(notifyTime + 8 * 3600000), 17) +
            pad(al.direction === 'BULLISH' ? 'LONG' : 'SHORT', 6) +
            pad(al.anchorPrice.toFixed(1), 11) +
            pad(al.mssRefPrice !== null && al.mssRefPrice !== undefined ? al.mssRefPrice.toFixed(1) : '-', 12) +
            pad(al.mssBreakPct !== null && al.mssBreakPct !== undefined ? (al.mssBreakPct * 100).toFixed(3) + '%' : '-', 8) +
            pad(al.legRangeAtr !== null && al.legRangeAtr !== undefined ? al.legRangeAtr.toFixed(1) : '-', 8) +
            pad(al.nearDistPct !== null ? al.nearDistPct.toFixed(2) + '%' : '-', 8) +
            pad(al.fvgZone ? al.fvgZone.map(function (z) { return z.toFixed(1); }).join('-') : '-', 18));
    });
    console.log('  (mssRef = MSS reference 价格；break% = 突破幅度；legAtr = leg range(ATR)；near% = 距 near draw；');
    console.log('   复核 4 问：① MSS 是否像关键结构 shift ② leg 肉眼是否干净 ③ near draw 是否合理近端流动性 ④ 值得打开图看吗)');
    console.log('');
}

/**
 * Phase 11D.9 — Delivery Alignment Audit（纯诊断）
 * 人工复核（#10）暴露：HIGH_QUALITY 81% nearHit（11L.4 通知时点修正前 88%）但 41% dirHit 的根因 =
 * "强局部结构" ≠ "主导方向"。本段把 HIGH 拆成 A/B/C 三类，验证 4 个
 * alignment 维度能否把 dirHit 拉高。
 */
function reportDeliveryAlignment(result, candles) {
    var opportunity = require('../stats/opportunity');
    var displacementLeg = require('../stats/displacementLeg');
    var mssReference = require('../stats/mssReference');
    var alertReplay = require('../stats/alertReplay');
    var deliveryAlignment = require('../stats/deliveryAlignment');

    // legs（与 11D.8 同构）
    var mssById = {};
    (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    // Phase 11L.1：共享 15min 窗 authoritative leg 索引（与 Live 单一实现）
    var legByDispId = displacementLeg.buildWindowedLegIndex(result.displacementEvents || [], candles || [], result.mssEvents || [], result.swings || []);

    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
        result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);

    console.log('DELIVERY ALIGNMENT AUDIT (Phase 11D.9 — A/B/C 类拆分，方向质量，只诊断)');
    if (alerts.length === 0) {
        console.log('  (no alerts)');
        console.log('');
        return;
    }
    var rows = alerts.map(function (al) {
        return deliveryAlignment.analyzeDeliveryAlignment(al, candles || [], legByDispId,
            result.biasTrace || [], result.htfTrendTrace || []);
    }).filter(function (r) { return r !== null; });
    var s = deliveryAlignment.assessDeliveryClasses(rows);

    // ① By class（A/B/C）
    console.log('  ① By Delivery Class（对齐人工复核 A/B/C）');
    console.log('  ' + pad('class', 20) + pad('n', 5) + pad('dirHit1h', 10) + pad('nearHit1h', 11) + pad('MFE1h', 9));
    ['DELIVERY_ALIGNED', 'LOCAL_VALID', 'FALSE_DIRECTIONAL'].forEach(function (k) {
        var c = s.byClass[k];
        if (!c || c.n === 0) {
            console.log('  ' + pad(k, 20) + pad(0, 5));
            return;
        }
        console.log('  ' + pad(k, 20) + pad(c.n, 5) +
            pad(Math.round(c.dirHit / c.n * 100) + '%', 10) +
            pad(c.nearCnt > 0 ? Math.round(c.nearHit / c.nearCnt * 100) + '%' : '-', 11) +
            pad((c.mfeSum / c.n).toFixed(2) + '%', 9));
    });
    var allHigh = s.byClass.DELIVERY_ALIGNED ? s.byClass.DELIVERY_ALIGNED.n + (s.byClass.LOCAL_VALID ? s.byClass.LOCAL_VALID.n : 0) + (s.byClass.FALSE_DIRECTIONAL ? s.byClass.FALSE_DIRECTIONAL.n : 0) : 0;
    console.log('  (DELIVERY_ALIGNED dirHit 应显著 > 全 HIGH 基线 41%；分类 = ①HTF 全同向 + ③deliveryHold + ④continuation)');
    console.log('');

    // ② By HTF alignment score
    console.log('  ② By HTF Alignment（bias/1h/4h 方向一致性 score/count）');
    console.log('  ' + pad('score', 10) + pad('n', 5) + pad('dirHit1h', 10));
    Object.keys(s.byHtfScore).sort().forEach(function (k) {
        var c = s.byHtfScore[k];
        console.log('  ' + pad(k, 10) + pad(c.n, 5) + pad(Math.round(c.dirHit / c.n * 100) + '%', 10));
    });
    console.log('  (全同向 = score/count 满格；0/x = 全部相反 → FALSE_DIRECTIONAL 候选)');
    console.log('');

    // ③ By sweep 层级
    console.log('  ③ By Sweep 层级（信号前 liquidity sweep 的 timeframe）');
    console.log('  ' + pad('level', 12) + pad('n', 5) + pad('dirHit1h', 10));
    ['HTF(1h+)', 'MID(15m)', '5M', 'NONE'].forEach(function (k) {
        var c = s.bySweepLevel[k];
        if (!c || c.n === 0) {
            console.log('  ' + pad(k, 12) + pad(0, 5));
            return;
        }
        console.log('  ' + pad(k, 12) + pad(c.n, 5) + pad(Math.round(c.dirHit / c.n * 100) + '%', 10));
    });
    console.log('  (若 HTF(1h+) sweep 的 dirHit 明显更高 → sweep 层级是方向质量的关键维度)');
    console.log('');
}

/**
 * Phase 11D.10 — HTF Liquidity Context（纯诊断）
 * 1H/4H confirmed pivots + PDH/PDL 流动性层；每次 Opportunity 判定此前被扫的
 * 最高层级（4H_SWING > PDH_PDL > 1H_SWING > 5M_INTERNAL > NONE）。
 * 验证"扫的是什么级别的流动性"能否解释 Delivery 差异。
 */
function reportHtfLiquidityContext(result, candles, data) {
    var opportunity = require('../stats/opportunity');
    var displacementLeg = require('../stats/displacementLeg');
    var mssReference = require('../stats/mssReference');
    var alertReplay = require('../stats/alertReplay');
    var deliveryAlignment = require('../stats/deliveryAlignment');
    var htfLiquidityContext = require('../stats/htfLiquidityContext');

    // legs + alerts（与 11D.8/11D.9 同构）
    var mssById = {};
    (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
    // Phase 11L.1：共享 15min 窗 authoritative leg 索引（与 Live 单一实现）
    var legByDispId = displacementLeg.buildWindowedLegIndex(result.displacementEvents || [], candles || [], result.mssEvents || [], result.swings || []);
    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
        result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);

    // HTF liquidity pool（1H/4H confirmed pivots）+ PDH/PDL（动态）
    var pool = htfLiquidityContext.buildHtfLiquidity(
        data && data['1h'], data && data['4h']);
    var data1d = data && data['1d'];

    console.log('HTF LIQUIDITY CONTEXT (Phase 11D.10 — sweep 层级，1H/4H pivots + PDH/PDL，只诊断)');
    console.log('  pool：1H_SWING ' + pool.filter(function (x) { return x.level === '1H_SWING'; }).length +
        ' | 4H_SWING ' + pool.filter(function (x) { return x.level === '4H_SWING'; }).length +
        ' | （PDH/PDL 按 alert 时点动态取 1d 前一日）');
    if (alerts.length === 0) {
        console.log('  (no alerts)');
        console.log('');
        return;
    }

    var rows = alerts.map(function (al) {
        var da = deliveryAlignment.analyzeDeliveryAlignment(al, candles || [], legByDispId,
            result.biasTrace || [], result.htfTrendTrace || []);
        if (!da) return null;
        var sw = htfLiquidityContext.sweepLevelOf(al, candles || [], pool, data1d);
        return {
            sweepLevel: sw.level,
            sweepDistPct: sw.distPct,
            distToMssRefPct: sw.distToMssRefPct,
            deliveryClass: da.deliveryClass,
            htfScore: da.htfAlign.score,
            htfCount: da.htfAlign.count,
            dirHit1h: da.dirHit1h,
            nearHit1h: da.nearHit1h,
            mfe1h: da.mfe1h,
            mssQuality: al.mssQuality,
            legQuality: al.legQuality
        };
    }).filter(function (r) { return r !== null; });
    var s = htfLiquidityContext.assessSweepLevels(rows);

    // ① By Sweep Level
    console.log('  ① By Sweep Level（leg 完成前 48 根内被扫最高层级）');
    console.log('  ' + pad('level', 14) + pad('n', 5) + pad('dirHit1h', 10) + pad('nearHit1h', 11) + pad('MFE1h', 9));
    htfLiquidityContext.LEVEL_ORDER.forEach(function (k) {
        var c = s.byLevel[k];
        if (!c || c.n === 0) {
            console.log('  ' + pad(k, 14) + pad(0, 5));
            return;
        }
        console.log('  ' + pad(k, 14) + pad(c.n, 5) +
            pad(Math.round(c.dirHit / c.n * 100) + '%', 10) +
            pad(c.nearCnt > 0 ? Math.round(c.nearHit / c.nearCnt * 100) + '%' : '-', 11) +
            pad((c.mfeSum / c.n).toFixed(2) + '%', 9));
    });
    console.log('  (若 HTF 层级 dirHit 明显高于 5M/NONE → "扫的级别"解释 delivery 差异)');
    console.log('');

    // ② 假设验证：Sweep Level × MSS × Leg（HTF 合并 vs 5M/NONE，dirHit1h）
    console.log('  ② 假设验证：Sweep Level × MSS × Leg → dirHit1h（HTF 层合并）');
    var groups = { 'HTF': ['4H_SWING', 'PDH_PDL', '1H_SWING'], '5M': ['5M_INTERNAL'], 'NONE': ['NONE'] };
    console.log('  ' + pad('sweep', 10) + pad('mss|leg', 22) + pad('n', 5) + pad('dirHit1h', 10));
    ['HTF', '5M', 'NONE'].forEach(function (g) {
        var levels = groups[g];
        [['PROTECTED+', 'STRONG+'], ['PROTECTED+', 'NORMAL-'], ['INTERNAL-', 'STRONG+'], ['INTERNAL-', 'NORMAL-']].forEach(function (combo) {
            var c = null;
            levels.forEach(function (lv) {
                var x = s.byLevelCombo[lv + '|' + combo[0] + '|' + combo[1]];
                if (x) {
                    if (!c) c = { n: 0, dirHit: 0 };
                    c.n += x.n;
                    c.dirHit += x.dirHit;
                }
            });
            if (!c || c.n === 0) return;
            console.log('  ' + pad(g, 10) + pad(combo[0] + '|' + combo[1], 22) + pad(c.n, 5) +
                pad(Math.round(c.dirHit / c.n * 100) + '%', 10));
        });
    });
    console.log('  (重点：HTF|PROTECTED+|STRONG+ 是否显著 > 5M|PROTECTED+|STRONG+ → sweep 层级有增量)');
    console.log('');

    // ③ Direction Confidence 初步分布（标签后续正式化）
    var conf = { ALIGNED: { n: 0, dirHit: 0 }, UNCONFIRMED: { n: 0, dirHit: 0 }, COUNTERTREND: { n: 0, dirHit: 0 } };
    rows.forEach(function (r) {
        var isHtfSweep = ['4H_SWING', 'PDH_PDL', '1H_SWING'].indexOf(r.sweepLevel) !== -1;
        var label;
        if (isHtfSweep && r.htfCount > 0 && r.htfScore / r.htfCount >= 2 / 3) {
            label = 'ALIGNED';
        } else if (r.htfCount > 0 && r.htfScore === 0) {
            label = 'COUNTERTREND';
        } else {
            label = 'UNCONFIRMED';
        }
        conf[label].n++;
        if (r.dirHit1h) conf[label].dirHit++;
    });
    console.log('  ③ Direction Confidence 初步（ALIGNED = HTF sweep + HTF 方向 ≥2/3；COUNTERTREND = HTF 全反向；UNCONFIRMED = 其余）');
    console.log('  ' + pad('label', 14) + pad('n', 5) + pad('dirHit1h', 10));
    ['ALIGNED', 'UNCONFIRMED', 'COUNTERTREND'].forEach(function (k) {
        var c = conf[k];
        console.log('  ' + pad(k, 14) + pad(c.n, 5) + pad(c.n > 0 ? Math.round(c.dirHit / c.n * 100) + '%' : '-', 10));
    });
    console.log('  (标签仅初步口径，钉钉正式化前需用户确认规则)');
    console.log('');
}

/**
 * Phase 11D.6 — MSS Reference 检测审计（纯诊断）
 * 回答"为什么没有 PROTECTED_SWING / HTF_RELEVANT 档"：四条件各自命中率 + 维度分布
 */
function reportMssReferenceAudit(result) {
    var mssReference = require('../stats/mssReference');
    var mssEvents = result.mssEvents || [];
    var swings = result.swings || [];
    if (mssEvents.length === 0) {
        console.log('MSS REFERENCE AUDIT (Phase 11D.6): (no MSS events)');
        console.log('');
        return;
    }
    var audit = mssReference.auditMssReferences(mssEvents, swings);
    console.log('MSS REFERENCE AUDIT (Phase 11D.6 — 检测分布，只诊断)');
    console.log('  total ' + audit.total + ' | ' +
        'MICRO_INTERNAL ' + audit.qualityDist.MICRO_INTERNAL + ' | ' +
        'INTERNAL ' + audit.qualityDist.INTERNAL + ' | ' +
        'PROTECTED_SWING ' + audit.qualityDist.PROTECTED_SWING + ' | ' +
        'HTF_RELEVANT ' + audit.qualityDist.HTF_RELEVANT + ' | ' +
        'NO_REFERENCE ' + audit.qualityDist.NO_REFERENCE);
    console.log('  referenceType: SWING_HIGH ' + (audit.refTypes.SWING_HIGH || 0) + ' | SWING_LOW ' + (audit.refTypes.SWING_LOW || 0));
    var c = audit.condHits;
    console.log('  条件命中：wasLatestOpposingSwing ' + c.wasLatestOpposingSwing + '/' + audit.total +
        ' | strong(breakPct+bodyRatio) ' + c.strong + '/' + audit.total +
        ' | PROTECTED/HTF 组合 ' + c.allThree + '/' + audit.total);
    console.log('  referenceAgeBars 分布：<=6 ' + audit.ageBars.le6 + ' | 7-24 ' + audit.ageBars.le24 + ' | >24 ' + audit.ageBars.gt24);
    console.log('  (若 wasLatestOpposingSwing 命中率极低 → MSS reference 选择偏内部 pivot，未指向关键 opposing structure)');
    console.log('');
}

/**
 * Phase 11D.6b — MSS 锚点方向验证（MSS 事件为锚点，样本充足）
 * mssQuality × legQuality → 1h Direction Hit / MFE / MAE / Near Hit
 * 回答："Protected Swing 被强 leg 打穿 = 高质量 MSS" 是否有方向增量
 */
function reportMssDirection(result, candles) {
    var mssDirection = require('../stats/mssDirection');
    var mssReference = require('../stats/mssReference');
    var displacementLeg = require('../stats/displacementLeg');
    var mssEvents = result.mssEvents || [];
    var swings = result.swings || [];
    if (mssEvents.length === 0) {
        console.log('MSS DIRECTION VALIDATION (Phase 11D.6b — MSS anchor)');
        console.log('  (no MSS events)');
        console.log('');
        return;
    }
    // leg 构建（mssId → legQuality）
    var legs = displacementLeg.buildDisplacementLegs(result.displacementEvents || [], swings);
    legs.forEach(function (leg) {
        displacementLeg.enrichLegWithCandles(leg, candles);
        displacementLeg.classifyLegQuality(leg);
    });
    var legByMssId = {};
    legs.forEach(function (leg) {
        if (leg.mssId && !legByMssId[leg.mssId]) {
            legByMssId[leg.mssId] = leg;
        }
    });
    // nearTarget：每个 MSS 时点的 Near Draw 目标（用该 index 的 snapshot？无快照 → 用 draw 平均近似不可行，
    // 简化：用 MSS 事件最近 96 根内的同向 swing 极值作为 near 参考 → 或直接 null（nearHit 不可用））
    // 更实用：near 目标用最近同型 swing 价格（MSS 后最近可触及的 liquidity）
    var events = mssEvents.map(function (m) {
        var q = mssReference.classifyMssReference(m, swings).quality;
        var leg = legByMssId[m.id] || null;
        var near = null;
        // 最近同型 swing（MSS 后第一个同方向结构 = near liquidity）
        if (m.direction === 'BULLISH') {
            var best = null;
            swings.forEach(function (s) {
                if (s.type === 'SWING_HIGH' && s.metadata && s.metadata.index > m.candleIndex &&
                    (!best || s.metadata.index < best.metadata.index)) {
                    best = s;
                }
            });
            if (best) near = best.price;
        } else {
            var best2 = null;
            swings.forEach(function (s) {
                if (s.type === 'SWING_LOW' && s.metadata && s.metadata.index > m.candleIndex &&
                    (!best2 || s.metadata.index < best2.metadata.index)) {
                    best2 = s;
                }
            });
            if (best2) near = best2.price;
        }
        return mssDirection.analyzeMssEvent(m, candles, {
            mssQuality: q,
            legQuality: leg ? leg.quality : 'NO_LEG',
            nearTarget: near
        });
    }).filter(function (e) { return e !== null; });
    var sum = mssDirection.summarizeMssDirection(events);
    console.log('MSS DIRECTION VALIDATION (Phase 11D.6b — MSS anchor, n=' + events.length + ')');
    // ① By MSS Quality（1h）
    console.log('  ' + pad('quality', 16) + pad('n', 5) + pad('1h hit', 8) + pad('1h MFE', 8) + pad('1h MAE', 8) + pad('nearHit', 8));
    ['NO_MSS', 'MICRO_INTERNAL', 'INTERNAL', 'PROTECTED_SWING', 'HTF_RELEVANT'].forEach(function (k) {
        var g = sum.byQuality[k];
        if (!g || g.n === 0) return;
        var w = g.w1h;
        console.log('  ' + pad(k, 16) + pad(g.n, 5) +
            pad(Math.round(w.hit / g.n * 100) + '%', 8) +
            pad((w.mfeSum / g.n).toFixed(2) + '%', 8) +
            pad((w.maeSum / g.n).toFixed(2) + '%', 8) +
            pad(w.hasNear > 0 ? Math.round(w.nearHit / w.hasNear * 100) + '%' : '-', 8));
    });
    // ② MSS × Leg 二维（1h hit）
    console.log('  MSS × Leg（1h hit / n）');
    console.log('  ' + pad('mss|leg', 24) + pad('n', 5) + pad('1h hit', 8) + pad('MFE', 8) + pad('nearHit', 8));
    var order = ['MICRO_INTERNAL|WEAK', 'MICRO_INTERNAL|NORMAL', 'MICRO_INTERNAL|STRONG',
        'INTERNAL|WEAK', 'INTERNAL|NORMAL', 'INTERNAL|STRONG', 'INTERNAL|EXPLOSIVE',
        'PROTECTED_SWING|WEAK', 'PROTECTED_SWING|NORMAL', 'PROTECTED_SWING|STRONG', 'PROTECTED_SWING|EXPLOSIVE',
        'HTF_RELEVANT|STRONG', 'HTF_RELEVANT|EXPLOSIVE'];
    order.forEach(function (k) {
        var g = sum.byCombo[k];
        if (!g || g.n === 0) return;
        var w = g.w1h;
        console.log('  ' + pad(k, 24) + pad(g.n, 5) +
            pad(Math.round(w.hit / g.n * 100) + '%', 8) +
            pad((w.mfeSum / g.n).toFixed(2) + '%', 8) +
            pad(w.hasNear > 0 ? Math.round(w.nearHit / w.hasNear * 100) + '%' : '-', 8));
    });
    console.log('  (MSS anchor 样本充足；若 PROTECTED+STRONG/EXPLOSIVE hit 显著高于 INTERNAL/MICRO → MSS quality 有真实方向增量)');
    console.log('');
}

/**
 * Phase 11E.4 — Cancel Policy Shadow（只诊断，正式 cancelCheck 一行不改）
 *
 * 对每笔 baseline CANCELLED 的 plan，用 waitTrace（cancel 前）+ postTrace（cancel 后至多 12 根）
 * 离线重放 5 种取消语义：
 *   BASELINE                 当前：cancel 根 cancelReason 非 null 即取消
 *   TOUCH_PRIORITY           取消根已 touch entry → CANCEL_FILL_AMBIGUOUS（不判错，单独计数）
 *   GRACE_1 / GRACE_2        SCENARIO_LEFT_WATCH 延迟 1/2 根；期间恢复 WATCH → 保留
 *   HARD_INVALIDATION_ONLY   只有 AMD_INVALIDATED / ALIGNMENT_OPPOSITE 才取消；SCENARIO 不杀
 *
 * 每模型统计：cancelled / rescued fills（保留后成交）/ targetHit@12-24-48 / stopHit /
 *             falseRescue（rescued 后先打 stop 且 target 未达）/ ambiguous（TOUCH 模型）
 */
function reportCancelShadow(result, candles) {
    var trades = result.trades || [];
    var cancelShadows = result.cancelShadows || [];
    var cancelled = trades.filter(function (t) { return t.status === 'CANCELLED'; });
    if (cancelled.length === 0 && cancelShadows.length === 0) {
        console.log('CANCEL POLICY SHADOW (Phase 11E.4 — 5 models, diagnostic only)');
        console.log('  (no cancelled plans)');
        console.log('');
        return;
    }
    console.log('CANCEL POLICY SHADOW (Phase 11E.4 — 5 models, diagnostic only, baseline frozen)');

    // 组装每个 cancelled plan 的完整轨迹：waitTrace + postTrace（按 bar 序）
    var shadowMap = {};
    cancelShadows.forEach(function (cs) {
        shadowMap[cs.plan && cs.plan.id ? cs.plan.id : ''] = cs;
    });
    var plans = cancelled.map(function (t) {
        var cs = shadowMap[t.planId || ''] || null;
        var trace = (t.waitTrace || []).concat(cs ? cs.postTrace : []);
        return {
            planId: t.planId,
            direction: t.direction,
            entryPrice: t.entryPrice,
            stopPrice: t.stopPrice,
            targetPrice: t.targetPrice,
            trace: trace,
            cancelReason: t.cancelReason
        };
    });

    function simulateFrom(plan, startIdx) {
        // 从 trace[startIdx] 起模拟：返回 { targetHit, stopHit, hitBar, maeR, mfeR, first }
        var dir = plan.direction;
        var entry = plan.entryPrice;
        var stop = plan.stopPrice;
        var target = plan.targetPrice;
        var risk = dir === 'LONG' ? entry - stop : stop - entry;
        var mae = 0;
        var mfe = 0;
        var targetHit = false;
        var stopHit = false;
        var first = null;
        for (var k = startIdx; k < plan.trace.length; k++) {
            var c = candles[plan.trace[k].index];
            if (!c) break;
            if (dir === 'LONG') {
                var maeNow = entry - c.low;
                var mfeNow = c.high - entry;
                if (maeNow > mae) mae = maeNow;
                if (mfeNow > mfe) mfe = mfeNow;
                if (!stopHit && c.low <= stop) { stopHit = true; first = 'STOP'; }
                if (!targetHit && c.high >= target) { targetHit = true; if (!first) first = 'TARGET'; }
            } else {
                var maeNow2 = c.high - entry;
                var mfeNow2 = entry - c.low;
                if (maeNow2 > mae) mae = maeNow2;
                if (mfeNow2 > mfe) mfe = mfeNow2;
                if (!stopHit && c.high >= stop) { stopHit = true; first = 'STOP'; }
                if (!targetHit && c.low <= target) { targetHit = true; if (!first) first = 'TARGET'; }
            }
        }
        return {
            targetHit: targetHit,
            stopHit: stopHit,
            first: first,
            maeR: risk > 0 ? mae / risk : 0,
            mfeR: risk > 0 ? mfe / risk : 0
        };
    }

    // 每个模型的重放
    function replayModel(model) {
        var out = { cancelled: 0, rescued: 0, ambiguous: 0, targetHit12: 0, targetHit24: 0, targetHit48: 0, stopHit: 0, falseRescue: 0, maeRSum: 0, mfeRSum: 0 };
        plans.forEach(function (p) {
            var grace = model === 'GRACE_1' ? 1 : (model === 'GRACE_2' ? 2 : 0);
            var touchPriority = model === 'TOUCH_PRIORITY';
            var hardOnly = model === 'HARD_INVALIDATION_ONLY';
            var i;
            var cancelledAt = null;
            var filledAt = null;
            for (i = 0; i < p.trace.length; i++) {
                var s = p.trace[i];
                var reason = s.cancelReason;
                var shouldCancel = false;
                if (reason) {
                    if (touchPriority) {
                        // Cancel-vs-Fill intrabar ambiguity：不判成 fill 也不判成 cancel，单独标记
                        if (s.touchEntry) out.ambiguous++;
                        shouldCancel = true;
                    } else if (hardOnly) {
                        // 只有硬失效才取消；SCENARIO_LEFT_WATCH 不杀 setup（继续本根 touch 检查）
                        if (reason === 'AMD_INVALIDATED' || reason === 'ALIGNMENT_OPPOSITE') {
                            shouldCancel = true;
                        }
                    } else if (reason === 'SCENARIO_LEFT_WATCH' && grace > 0) {
                        // 本根已 touch entry → 成交优先（grace 语义：取消让位于成交）
                        if (s.touchEntry) {
                            filledAt = i;
                            break;
                        }
                        // 延迟 grace 根：期间 touch → 成交；恢复（cancelReason null）→ 保留；仍失效 → 取消
                        var recovered = false;
                        var j;
                        for (j = i + 1; j <= i + grace && j < p.trace.length; j++) {
                            if (p.trace[j].touchEntry) { filledAt = j; break; }
                            if (!p.trace[j].cancelReason) { recovered = true; break; }
                        }
                        if (filledAt !== null) break;
                        if (!recovered) {
                            shouldCancel = true;
                        }
                    } else {
                        shouldCancel = true;
                    }
                }
                if (shouldCancel) {
                    cancelledAt = i;
                    break;
                }
                if (filledAt !== null) break; // grace 窗口内已成交
                // 后 fill（正式语义：cancel 先于 fill；本根无 cancel 或模型决定不取消 → 检查 touch）
                if (s.touchEntry) {
                    filledAt = i;
                    break;
                }
            }
            if (filledAt !== null) {
                out.rescued++;
                var sim = simulateFrom(p, filledAt);
                if (sim.targetHit) {
                    out.targetHit12 += filledAt + 1 <= 12 ? 1 : 0;
                    out.targetHit24 += filledAt + 1 <= 24 ? 1 : 0;
                    out.targetHit48 += 1;
                }
                if (sim.stopHit) {
                    out.stopHit++;
                    if (!sim.targetHit) out.falseRescue++;
                }
                out.maeRSum += sim.maeR;
                out.mfeRSum += sim.mfeR;
            } else if (cancelledAt !== null) {
                out.cancelled++;
            } else {
                // trace 结束仍未 cancel/fill（如 HARD 模型在 SCENARIO 场景 trace 只有 12 根）
                out.cancelled++; // 保守：未成交视为取消
            }
        });
        return out;
    }

    var models = ['BASELINE', 'TOUCH_PRIORITY', 'GRACE_1', 'GRACE_2', 'HARD_INVALIDATION_ONLY'];
    var rows = {};
    models.forEach(function (m) { rows[m] = replayModel(m); });

    console.log('  ' + pad('model', 24) + pad('cancelled', 9) + pad('rescued', 8) +
        pad('tgt@12', 7) + pad('tgt@24', 7) + pad('tgt@48', 7) + pad('stopHit', 8) +
        pad('falseRescue', 12) + pad('ambiguous', 10) + pad('avgMAE', 7) + pad('avgMFE', 7));
    models.forEach(function (m) {
        var r = rows[m];
        console.log('  ' + pad(m, 24) + pad(r.cancelled, 9) + pad(r.rescued, 8) +
            pad(r.targetHit12, 7) + pad(r.targetHit24, 7) + pad(r.targetHit48, 7) +
            pad(r.stopHit, 8) + pad(r.falseRescue, 12) + pad(r.ambiguous, 10) +
            pad(r.rescued > 0 ? (r.maeRSum / r.rescued).toFixed(2) + 'R' : '-', 7) +
            pad(r.rescued > 0 ? (r.mfeRSum / r.rescued).toFixed(2) + 'R' : '-', 7));
    });
    console.log('  (rescued = 该模型保留后最终成交；tgt@h = 成交后 h bars 内达 target；falseRescue = 保留后先打 stop 且 target 未达；');
    console.log('   ambiguous = TOUCH_PRIORITY 标记的 Cancel-vs-Fill 同根歧义；BASELINE 行 = 当前正式结果)');
    console.log('');
}

/**
 * Phase 11E.6 — Directional Confirmation funnel（正式化后全链路）
 * ENTRY_READY → CONFIRMATION_PENDING → CONFIRMED → PLAN_READY → FILLED → CLOSED
 * 重点：CONFIRMATION_REJECTED_RR（确认后 entry 变差 → RR<1.5 → NO TRADE，风险收益纪律）
 */
function reportConfirmationFunnel(result) {
    var stats = result.confirmationStats || { pending: 0, confirmed: 0, rejectedRr: 0, cancelled: 0, expired: 0, dropped: 0 };
    var trades = result.trades || [];
    var filled = trades.filter(function (t) {
        return t.status === 'WIN' || t.status === 'LOSS' || t.status === 'AMBIGUOUS' || t.status === 'OPEN_AT_END';
    }).length;
    var closed = trades.filter(function (t) {
        return t.status === 'WIN' || t.status === 'LOSS' || t.status === 'AMBIGUOUS';
    }).length;
    console.log('CONFIRMATION FUNNEL (Phase 11E.6 — directional confirmation formalized)');
    console.log('  ENTRY_READY → CONFIRMATION_PENDING ' + stats.pending +
        ' | CONFIRMED → PLAN_READY ' + stats.confirmed +
        ' | FILLED ' + filled +
        ' | CLOSED ' + closed);
    console.log('  CONFIRMATION_REJECTED_RR ' + stats.rejectedRr +
        '（确认后 entry 变差 RR<1.5 → NO TRADE） | CANCELLED during wait ' + stats.cancelled +
        ' | EXPIRED ' + stats.expired + ' | DROPPED ' + stats.dropped);
    console.log('  (CONFIRMED = 确认 K 收盘成立并 plan READY；entry 用确认 K close，最早 N+1 成交)');
    console.log('');
}

/**
 * Phase 11E — Execution Diagnostics（只诊断，全部规则冻结）
 *
 * 11E.1：ENTRY_READY → CANCELLED 审计
 *   取消原因分类（AMD_INVALIDATED / SCENARIO_LEFT_WATCH / ALIGNMENT_OPPOSITE /
 *                 BIAS_FLIP / DRAW_FLIP / ENTRY_WAIT_TIMEOUT）
 *   + 取消时 elapsedBars / 价格相对 entry
 *   + 取消后 12/24/48 bars 是否重达原 entry / 原 target（判断取消是否过度敏感）
 *
 * 11E.2：FILLED → early excursion 审计
 *   入场后 1/2/3/5/8/12 bars 的 MAE/MFE（R 单位）
 *   + barsToMaxMAE / barsToFirstPositiveMFE / barsTo1R / barsToStop
 *   回答："先 -1R 再 +8R"是 Entry 过早还是 Stop 不合理
 */
function reportExecutionDiagnostics(result, candles) {
    var trades = result.trades || [];
    var plans = trades; // trades 数组包含所有 plan 结局（含 CANCELLED/EXPIRED）

    function fmtPct(x) { return (x * 100).toFixed(0) + '%'; }

    // ---------- 11E.1 ----------
    var cancelled = trades.filter(function (t) { return t.status === 'CANCELLED'; });
    var expired = trades.filter(function (t) { return t.status === 'EXPIRED'; });
    var filled = trades.filter(function (t) {
        return t.status === 'WIN' || t.status === 'LOSS' || t.status === 'AMBIGUOUS' || t.status === 'OPEN_AT_END';
    });
    var totalPlans = trades.length;

    console.log('EXECUTION DIAGNOSTICS (Phase 11E — diagnostic only, all rules frozen)');
    console.log('11E.1 ENTRY_READY → OUTCOME（plans ' + totalPlans + ' = filled ' + filled.length +
        ' + cancelled ' + cancelled.length + ' + expired ' + expired.length + '）');
    if (totalPlans === 0) {
        console.log('  (no plans)');
        console.log('');
    } else {
        // 取消原因分类
        var reasons = {};
        cancelled.forEach(function (t) {
            var k = t.cancelReason || 'OTHER';
            reasons[k] = (reasons[k] || 0) + 1;
        });
        ['AMD_INVALIDATED', 'SCENARIO_LEFT_WATCH', 'ALIGNMENT_OPPOSITE', 'BIAS_FLIP', 'DRAW_FLIP', 'ENTRY_WAIT_TIMEOUT', 'OTHER']
            .forEach(function (k) {
                if (reasons[k]) {
                    console.log('  ' + pad(k, 24) + pad(reasons[k], 4) +
                        ' ' + fmtPct(reasons[k] / totalPlans) + ' of plans');
                }
            });
        if (expired.length > 0) {
            console.log('  ' + pad('ENTRY_WAIT_TIMEOUT', 24) + pad(expired.length, 4) + ' ' + fmtPct(expired.length / totalPlans) + ' of plans');
        }
        console.log('');

        // 取消后恢复检查（12/24/48 bars 是否重达原 entry / 原 target）+ cancel-candle touch
        if (candles && cancelled.length > 0) {
            console.log('  取消后恢复检查（重达原 entry / 原 target）+ cancel-candle touch');
            console.log('  ' + pad('reason', 24) + pad('n', 3) + pad('entry@12', 8) + pad('entry@24', 8) + pad('entry@48', 8) +
                pad('tgt@24', 7) + pad('tgt@48', 7) + pad('avgWait', 8) + pad('touch@Cancel', 13) + pad('avgDev%', 8));
            var byReason = {};
            cancelled.forEach(function (t) { (byReason[t.cancelReason || 'OTHER'] = byReason[t.cancelReason || 'OTHER'] || []).push(t); });
            Object.keys(byReason).forEach(function (k) {
                var list = byReason[k];
                var entryHits = { 12: 0, 24: 0, 48: 0 };
                var tgtHits = { 24: 0, 48: 0 };
                var waitSum = 0;
                var devSum = 0;
                var touchCancel = 0;
                list.forEach(function (t) {
                    var from = (t.exitIndex !== null && t.exitIndex !== undefined ? t.exitIndex : 0) + 1;
                    var dev = t.entryPrice > 0
                        ? (t.cancelPrice - t.entryPrice) / t.entryPrice * 100 : 0;
                    devSum += Math.abs(dev);
                    waitSum += (t.cancelElapsedBars || 0);
                    // Phase 11E.1：cancel candle 本身是否已触及 entry（Cancel-vs-Fill intrabar ambiguity）
                    var cancelCandle = candles[t.exitIndex !== null && t.exitIndex !== undefined ? t.exitIndex : 0];
                    if (cancelCandle) {
                        if (t.direction === 'LONG' && cancelCandle.low <= t.entryPrice) touchCancel++;
                        if (t.direction === 'SHORT' && cancelCandle.high >= t.entryPrice) touchCancel++;
                    }
                    [12, 24, 48].forEach(function (h) {
                        for (var i = from; i < Math.min(candles.length, from + h); i++) {
                            var c = candles[i];
                            if (!c) break;
                            if (t.direction === 'LONG' && c.low <= t.entryPrice) { entryHits[h]++; break; }
                            if (t.direction === 'SHORT' && c.high >= t.entryPrice) { entryHits[h]++; break; }
                        }
                    });
                    [24, 48].forEach(function (h) {
                        for (var j = from; j < Math.min(candles.length, from + h); j++) {
                            var c2 = candles[j];
                            if (!c2) break;
                            if (t.direction === 'LONG' && c2.high >= t.targetPrice) { tgtHits[h]++; break; }
                            if (t.direction === 'SHORT' && c2.low <= t.targetPrice) { tgtHits[h]++; break; }
                        }
                    });
                });
                console.log('  ' + pad(k, 24) + pad(list.length, 3) +
                    pad(fmtPct(entryHits[12] / list.length), 8) + pad(fmtPct(entryHits[24] / list.length), 8) + pad(fmtPct(entryHits[48] / list.length), 8) +
                    pad(fmtPct(tgtHits[24] / list.length), 7) + pad(fmtPct(tgtHits[48] / list.length), 7) +
                    pad((waitSum / list.length).toFixed(1), 8) +
                    pad(fmtPct(touchCancel / list.length), 13) +
                    pad((devSum / list.length).toFixed(2) + '%', 8));
            });
            console.log('  (entry@h = 取消后 h bars 内重新触及原 entry；tgt@h = 达到原 target；');
            console.log('   touch@Cancel = 取消那根 K 本身已触及 entry → Cancel-vs-Fill intrabar ordering ambiguity；avgDev = 取消价偏离)');
            console.log('');
        }

        // 每笔 plan 明细
        console.log('  明细（每笔 plan 结局）');
        trades.slice(-12).forEach(function (t) {
            var extra = '';
            if (t.status === 'CANCELLED') {
                extra = ' reason ' + (t.cancelReason || '?') + ' wait ' + (t.cancelElapsedBars || 0) + ' bars';
            } else if (t.status === 'EXPIRED') {
                extra = ' wait ' + (t.waitBars || 0) + ' bars';
            } else if (t.excursion) {
                var e = t.excursion;
                extra = ' stopATR ' + (t.diagnostics && t.diagnostics.stopDistanceAtr !== null ? t.diagnostics.stopDistanceAtr.toFixed(2) : '?') +
                    ' MFE ' + t.mfeR + 'R barsTo1R ' + (e.barsTo1R === null ? '-' : e.barsTo1R) +
                    ' barsToStop ' + (t.exitIndex !== null && t.entryIndex !== null ? t.exitIndex - t.entryIndex : '-');
            }
            console.log('  ' + fmt(t.createdAt) + ' ' + pad(t.direction, 5) + ' ' + pad(t.status, 11) +
                ' entry ' + t.entryPrice + ' rr ' + t.rr + extra);
        });
        console.log('');
    }

    // ---------- 11E.2 ----------
    var closed = trades.filter(function (t) {
        return t.status === 'WIN' || t.status === 'LOSS' || t.status === 'AMBIGUOUS';
    });
    console.log('11E.2 FILLED → EARLY EXCURSION（closed ' + closed.length + '）');
    if (closed.length === 0) {
        console.log('  (no closed trades)');
        console.log('');
        return;
    }
    // 汇总：1/2/3/5/8/12 bars 平均 MAE/MFE R
    console.log('  入场后 MAE/MFE R（均值）—— bars: 1 / 2 / 3 / 5 / 8 / 12');
    ['maeR', 'mfeR'].forEach(function (field) {
        var cells = [1, 2, 3, 5, 8, 12].map(function (b) {
            var vals = [];
            closed.forEach(function (t) {
                var s = t.excursion && t.excursion['at' + b];
                if (s && s[field] !== undefined && s[field] !== null) vals.push(s[field]);
            });
            if (vals.length === 0) return 'N/A';
            var sum = vals.reduce(function (a, v) { return a + v; }, 0);
            return (sum / vals.length).toFixed(2) + 'R';
        });
        console.log('  ' + pad(field, 6) + ' ' + cells.join(' / '));
    });
    // 关键 bar 指标（逐笔）
    console.log('  逐笔：barsToMaxMAE / firstPosMFE / to1R / toStop / MFE-before-stop');
    closed.forEach(function (t) {
        var e = t.excursion || {};
        console.log('  ' + fmt(t.createdAt) + ' ' + pad(t.direction, 5) + ' ' + pad(t.status, 9) +
            ' maxMAE@' + (e.barsToMaxMAE === null ? '-' : e.barsToMaxMAE) +
            ' firstMFE@' + (e.barsToFirstPositiveMFE === null ? '-' : e.barsToFirstPositiveMFE) +
            ' to1R@' + (e.barsTo1R === null ? '-' : e.barsTo1R) +
            ' toStop@' + (t.exitIndex !== null && t.entryIndex !== null ? t.exitIndex - t.entryIndex : '-') +
            ' MFE ' + t.mfeR + 'R / MAE ' + t.maeR + 'R' +
            (t.mfeBeforeStop !== undefined && t.mfeBeforeStop !== null ? ' MFE-before-stop ' + t.mfeBeforeStop.toFixed(2) : ''));
    });
    console.log('  (若 barsTo1R << barsToMaxMFE：入场后先打 1R 再走 MFE → Entry 过早，非 Stop 不合理)');
    console.log('');

    // ---------- 11E.5：Entry Confirmation Shadow（3 确认模型 vs ENTRY_NOW） ----------
    var shadowEntry = require('../stats/shadowEntry');
    var conf = shadowEntry.summarizeConfirmations(result.retraces || []);
    console.log('11E.5 ENTRY CONFIRMATION SHADOW（shadow，只诊断；3 确认模型 vs ENTRY NOW）');
    if (conf.length === 0) {
        console.log('  (no retrace with zone touch)');
    } else {
        var nowRow = conf.filter(function (c) { return c.variant === 'ENTRY_NOW'; })[0];
        var nowN = nowRow ? nowRow.entries : 0;
        console.log('  ' + pad('model', 24) + pad('n', 4) + pad('retain', 8) + pad('avgMAE', 8) + pad('avgMFE', 8) +
            pad('tgtHit', 7) + pad('stopOut', 8) + pad('avgRR', 7));
        var order = ['ENTRY_NOW', 'AFTER_1_BAR_CONFIRM', 'AFTER_RECLAIM', 'AFTER_MIDPOINT_RECLAIM'];
        var display = {
            'ENTRY_NOW': 'ENTRY_NOW (当前)',
            'AFTER_1_BAR_CONFIRM': 'AFTER_1_DIRECTIONAL_BAR',
            'AFTER_RECLAIM': 'FVG_RECLAIM',
            'AFTER_MIDPOINT_RECLAIM': 'MIDPOINT_RECLAIM'
        };
        order.forEach(function (k) {
            var row = conf.filter(function (c) { return c.variant === k; })[0];
            if (!row) return;
            var retainPct = nowN > 0 ? (row.entries / nowN * 100).toFixed(0) + '%' : '-';
            console.log('  ' + pad(display[k] || k, 24) + pad(row.entries, 4) + pad(retainPct, 8) +
                pad((row.maeRSum / row.entries).toFixed(2) + 'R', 8) +
                pad((row.mfeRSum / row.entries).toFixed(2) + 'R', 8) +
                pad(((row.targetHit / row.entries) * 100).toFixed(0) + '%', 7) +
                pad(((row.stopOut / row.entries) * 100).toFixed(0) + '%', 8) +
                pad(row.avgRr !== null ? row.avgRr.toFixed(1) : '-', 7));
        });
        console.log('  (retain = 相对 ENTRY_NOW 的样本保留率；确认越严格 entry 越晚 → MAE 更小但 RR 更差，找平衡点)');
    }
    console.log('');
}

/**
 * Phase 11T — Stop Semantics Audit
 * 1. STOP_TOO_TIGHT_CANDIDATE 桶（标记不拒单）
 * 2. STOP SURVIVAL CURVE（0.25-2.0 ATR，Narrative 活到 Primary Draw 的比例）
 * 3. 候选诊断（baseline vs ATR 档的 narrativeInvalidation）
 */
function reportStopSemantics(result, candles) {
    var ss = require('../stats/stopSemantics');
    var trades = result.trades || [];
    var retraces = result.retraces || [];

    console.log('STOP SEMANTICS AUDIT (Phase 11T — diagnostic only, baseline stop frozen)');

    // 1. STOP_TOO_TIGHT_CANDIDATE
    var flagged = ss.flagTooTight(trades);
    var flags = flagged.filter(function (f) { return f.flag; });
    console.log('STOP_TOO_TIGHT_CANDIDATE (marked, NOT rejected)');
    if (flags.length === 0) {
        console.log('  (none)');
    } else {
        flags.forEach(function (f) {
            console.log('  ' + pad(f.tradeId ? f.tradeId.slice(-24) : 'N/A', 26) +
                ' ' + pad(f.direction, 5) +
                ' entry ' + f.entryPrice + ' stop ' + f.stopPrice +
                ' stopAtr ' + (f.stopDistanceAtr === null ? 'N/A' : f.stopDistanceAtr) +
                ' rr ' + f.rr +
                ' mfeBeforeStopR ' + (f.mfeBeforeStopR === null ? 'N/A' : f.mfeBeforeStopR) +
                ' [' + f.reasons.join('; ') + ']');
        });
    }
    console.log('');

    // 2. STOP SURVIVAL CURVE（Phase 11T.1 二维：ATR 档 × Narrative Validity）
    // 构造 entry 集合：正式 trades + shadow triggered 且 sim 存在的
    var entries = [];
    trades.forEach(function (t) {
        if (t.status !== 'WIN' && t.status !== 'LOSS' && t.status !== 'AMBIGUOUS') return;
        entries.push({
            direction: t.direction,
            entryPrice: t.entryPrice,
            targetPrice: t.targetPrice,
            atr: t.diagnostics && t.diagnostics.atr ? t.diagnostics.atr : null,
            entryIndex: t.entryIndex !== undefined ? t.entryIndex : null,
            diagnostics: t.diagnostics || null
        });
    });
    retraces.forEach(function (r) {
        (r.shadowResults || []).forEach(function (sr) {
            if (!sr.triggered || !sr.sim) return;
            entries.push({
                direction: r.direction === 'BULLISH' ? 'LONG' : 'SHORT',
                entryPrice: sr.triggerPrice,
                targetPrice: sr.sim.targetPrice,
                atr: r.atrAtWatch || null,
                entryIndex: sr.triggerIndex !== undefined ? sr.triggerIndex : r.watchIndex,
                amd: r.amd || null,
                swings: r.swings || [],
                fvg: { zoneLow: r.zoneLow, zoneHigh: r.zoneHigh },
                tickSize: r.tickSize || 0,
                watchAt: r.watchAt
            });
        });
    });
    if (entries.length > 0 && candles) {
        var curve = ss.survivalCurve(entries, candles, {});
        console.log('STOP SURVIVAL CURVE (n=' + curve.entries + ' entries, ' +
            'survive = primary draw target hit before stop)');
        console.log('  ' + pad('stop distance', 13) + pad('total', 5) + pad('all', 8) +
            pad('valid', 8) + pad('micro', 8) + pad('avgMFE R', 9) + pad('avgMAE R', 9));
        ss.SURVIVAL_TIERS.forEach(function (t) {
            var row = curve.tiers[t];
            console.log('  ' + pad(t + ' ATR', 13) + pad(row.total, 5) +
                pad((row.rate * 100).toFixed(0) + '%', 8) +
                pad('(' + row.validTotal + ') ' + (row.validRate * 100).toFixed(0) + '%', 8) +
                pad('(' + row.microTotal + ') ' + (row.microRate * 100).toFixed(0) + '%', 8) +
                pad(row.avgMfeR.toFixed(2), 9) + pad(row.avgMaeR.toFixed(2), 9));
        });
        console.log('  valid  = stop 越过 manipulation extreme / accumulation boundary (narrative invalidation)');
        console.log('  micro  = stop 未越过 invalidation 边界（micro structure only）');
        console.log('  (比较 valid vs micro：若 valid 显著更高 → 真正起作用的是 narrative invalidation 而非 ATR 距离)');
    } else {
        console.log('STOP SURVIVAL CURVE: (no entries with atr)');
    }
    console.log('');

    // 3. REFERENCE SURVIVAL（四类 reference + baseline + ATR 档）
    var ref = ss.referenceSurvival(entries, candles);
    if (ref.entries > 0) {
        console.log('REFERENCE SURVIVAL (n=' + ref.entries + ' entries — 按 stop reference 分组)');
        console.log('  ' + pad('source', 22) + pad('n', 5) + pad('survive', 8) + pad('avgMAE R', 9) +
            pad('avgMFE R', 9) + pad('avgRR', 8));
        var order = ['MANIPULATION_SWEEP', 'ACCUMULATION_RANGE', 'SWING', 'FVG_FALLBACK', 'ATR_BASED'];
        order.forEach(function (k) {
            var row = ref.bySource[k];
            if (!row) return;
            console.log('  ' + pad(k, 22) + pad(row.n, 5) +
                pad((row.rate * 100).toFixed(1) + '%', 8) +
                pad(row.avgMaeR.toFixed(2), 9) + pad(row.avgMfeR.toFixed(2), 9) +
                pad(row.avgRr === 0 ? 'N/A' : row.avgRr.toFixed(1), 8));
        });
        console.log('  (目标：最符合叙事失效语义且未毁掉 RR 的 reference，非最高胜率)');
    } else {
        console.log('REFERENCE SURVIVAL: (no entries with candidates)');
    }
    console.log('');

    // 4. 候选诊断（正式 trades 的 baseline vs ATR 档）
    var rows = ss.candidateRows(trades);
    if (rows.length > 0) {
        console.log('STOP CANDIDATE NARRATIVE INVALIDATION (per trade)');
        var shown = {};
        rows.forEach(function (r) {
            if (!shown[r.tradeId]) {
                shown[r.tradeId] = true;
                console.log('  ' + pad(r.tradeId ? r.tradeId.slice(-24) : 'N/A', 26) + ' ' + r.status);
            }
            console.log('    ' + pad(r.source, 24) +
                ' distAtr ' + pad(r.distanceAtr === null ? 'N/A' : r.distanceAtr, 7) +
                ' rr ' + pad(r.rr === null ? 'N/A' : r.rr, 7) +
                ' invalidation ' + (r.narrativeInvalidation === null ? 'N/A' : r.narrativeInvalidation ? 'YES' : 'no') +
                (r.beyondManip ? ' [beyond manip]' : '') +
                (r.beyondAcc ? ' [beyond acc]' : '') +
                (r.isBaseline ? ' [BASELINE]' : ''));
        });
    } else {
        console.log('STOP CANDIDATE INVALIDATION: (no trades with candidates)');
    }
    console.log('');
}

/**
 * Phase 11T.2 — Stop Candidate V2 Counterfactual（shadow only, baseline frozen）
 * 样本口径与 Phase 11T survivalCurve 一致：正式 trades + Phase 11S.1 shadow entries
 * （shadow 无 diagnostics.stopCandidates → 用 amd/swings/fvg 快照重建）。
 * 输出：COVERAGE / MATRIX（用户模板）/ TOO_CLOSE_TO_NOISE 诊断 / Baseline vs V2 配对 /
 *       V2_POOL_ROW（machine-readable，供 pooled 汇总）
 */
function reportStopV2Counterfactual(result, candles, symbol) {
    var v2 = require('../stats/stopV2Counterfactual');
    var stopPlanner = require('../trade/stopPlanner');
    var trades = result.trades || [];
    var retraces = result.retraces || [];
    var entries = [];

    // 1. 正式 trades（closed）
    trades.forEach(function (t) {
        if (t.status !== 'WIN' && t.status !== 'LOSS' && t.status !== 'AMBIGUOUS') return;
        if (!t.entryPrice || !t.targetPrice || !t.diagnostics || !t.diagnostics.atr) return;
        if (t.entryIndex === null || t.entryIndex === undefined) return;
        entries.push(t);
    });

    // 2. shadow entries（Phase 11S.1 trigger；重建 stopCandidates）
    retraces.forEach(function (r) {
        (r.shadowResults || []).forEach(function (sr) {
            if (!sr.triggered || !sr.sim) return;
            if (sr.stop && sr.stop.status !== 'READY') return;
            if (!sr.target) return;
            var atr = r.atrAtWatch || 0;
            if (!atr || atr <= 0) return;
            var dir = r.direction === 'BULLISH' ? 'LONG' : 'SHORT';
            var cands = null;
            try {
                cands = stopPlanner.buildStopCandidates({
                    direction: dir,
                    entryPrice: sr.triggerPrice,
                    targetPrice: sr.target.price,
                    amd: r.amd || {},
                    swings: r.swings || [],
                    fvg: { zoneLow: r.zoneLow, zoneHigh: r.zoneHigh },
                    evaluationTime: r.watchAt,
                    tickSize: r.tickSize || 0,
                    atr: atr
                }, {});
            } catch (err) {
                cands = null;
            }
            entries.push({
                direction: dir,
                entryPrice: sr.triggerPrice,
                targetPrice: sr.target.price,
                stopPrice: sr.stop.price,
                entryIndex: sr.triggerIndex !== undefined ? sr.triggerIndex : r.watchIndex,
                diagnostics: {
                    atr: atr,
                    stopCandidates: cands
                }
            });
        });
    });

    if (entries.length === 0 || !candles) {
        console.log('STOP V2 COUNTERFACTUAL (Phase 11T.2): (no entries with atr / no candles)');
        console.log('');
        return;
    }

    var m = v2.v2Matrix(entries, candles, {});
    var p = v2.baselineVsV2(entries, candles, {});

    console.log('STOP V2 COUNTERFACTUAL (Phase 11T.2 — shadow only, baseline stopPlanner frozen)');
    console.log('  horizon ' + m.horizon + ' bars (24h @5m) | same target per plan | AMBIGUOUS counted as stop-out');

    // 1. Coverage
    var c = m.coverage;
    console.log('COVERAGE (n=' + c.total + ' closed trades)');
    console.log('  manip-only ' + pad(c.manipOnly, 5) + ' | acc-only ' + pad(c.accOnly, 5) +
        ' | both ' + pad(c.both, 5) + ' | none ' + pad(c.none, 5) +
        '   (none = 无 narrative reference → V2 无候选)');
    console.log('');

    // 2. Matrix
    console.log('MATRIX (survival = target first; tgtHit = target ever reached; stop->tgt = stop-out then target / stop-out)');
    console.log('  ' + pad('model', 34) + pad('n', 4) + pad('surv', 6) + pad('tgtHit', 7) +
        pad('stop->tgt', 9) + pad('medATR', 7) + pad('medRR', 6) + pad('RR>=1.5', 8));
    var keys = ['BASELINE', 'MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION',
        'MANIPULATION_INVALIDATION_NBUF', 'ACCUMULATION_INVALIDATION_NBUF'];
    keys.forEach(function (k) {
        var r = m.rows[k];
        if (r.n === 0) {
            console.log('  ' + pad(k, 34) + '  (no candidates)');
            return;
        }
        console.log('  ' + pad(k, 34) + pad(r.n, 4) +
            pad((r.survivalRate * 100).toFixed(0) + '%', 6) +
            pad((r.targetHitRate * 100).toFixed(0) + '%', 7) +
            pad(r.stopToTargetRate === null ? 'N/A' : (r.stopToTargetRate * 100).toFixed(0) + '%', 9) +
            pad(r.medianDistAtr === null ? 'N/A' : r.medianDistAtr.toFixed(2), 7) +
            pad(r.medianRR === null ? 'N/A' : r.medianRR.toFixed(1), 6) +
            pad((r.rrGe15 * 100).toFixed(0) + '%', 8));
    });
    console.log('  (NBUF = V2 + noise buffer: min distance ' + 1.0 + ' ATR; tooClose thresholds 0.5/0.75/1.0 diagnostic only)');
    console.log('');

    // 3. TOO_CLOSE_TO_NOISE（V2 raw，诊断不拒单）
    console.log('TOO_CLOSE_TO_NOISE (V2 raw distATR, diagnostic only — NOT rejected)');
    ['MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION'].forEach(function (k) {
        var r = m.rows[k];
        if (r.n === 0) return;
        var parts = r.tooClose.map(function (tc) {
            return '<' + tc.threshold + ' n=' + tc.n + ' (' + (tc.rate * 100).toFixed(0) + '%)';
        });
        console.log('  ' + pad(k, 34) + parts.join('  '));
    });
    console.log('');

    // 4. Baseline vs V2 配对
    console.log('BASELINE vs V2 (paired, same target per plan)');
    console.log('  ' + pad('model', 34) + pad('pairs', 5) + pad('baseSurv', 8) + pad('v2Surv', 7) +
        pad('dSurv', 6) + pad('RR>=1.5', 8) + pad('gainButRR<1.5', 13));
    ['MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION',
        'MANIPULATION_INVALIDATION_NBUF', 'ACCUMULATION_INVALIDATION_NBUF'].forEach(function (k) {
        var r = p.models[k];
        if (!r || r.pairs === 0) return;
        console.log('  ' + pad(k, 34) + pad(r.pairs, 5) +
            pad((r.baseSurvRate * 100).toFixed(0) + '%', 8) +
            pad((r.v2SurvRate * 100).toFixed(0) + '%', 7) +
            pad((r.survDelta >= 0 ? '+' : '') + (r.survDelta * 100).toFixed(0) + '%', 6) +
            pad((r.rrGe15Rate * 100).toFixed(0) + '%', 8) +
            pad((r.survGainButRrLt15Rate * 100).toFixed(0) + '%', 13));
    });
    console.log('  (gainButRR<1.5 = V2 提高 survival 但 RR<1.5 的占比 → 不能直接采用)');
    console.log('  (判定优先级：Narrative survival / Target reach / Stop-out-then-target / RR preservation；不用 Win Rate)');
    console.log('');

    // 5. machine-readable 行（pooled 汇总用）
    var rowJson = {};
    keys.forEach(function (k) {
        var r = m.rows[k];
        rowJson[k] = {
            n: r.n,
            surv: r.n > 0 ? Math.round(r.survivalRate * 1000) / 1000 : 0,
            tgtHit: r.n > 0 ? Math.round(r.targetHitRate * 1000) / 1000 : 0,
            stopTgt: r.stopToTargetRate === null ? null : Math.round(r.stopToTargetRate * 1000) / 1000,
            stopOutN: r.stopOutN,
            rrN: r.rrN,
            medATR: r.medianDistAtr === null ? null : Math.round(r.medianDistAtr * 100) / 100,
            medRR: r.medianRR === null ? null : Math.round(r.medianRR * 100) / 100,
            rrGe15: r.rrN > 0 ? Math.round(r.rrGe15 * 1000) / 1000 : 0
        };
    });
    var pairJson = {};
    ['MANIPULATION_INVALIDATION', 'ACCUMULATION_INVALIDATION',
        'MANIPULATION_INVALIDATION_NBUF', 'ACCUMULATION_INVALIDATION_NBUF'].forEach(function (k) {
        var r = p.models[k];
        pairJson[k] = r ? {
            pairs: r.pairs,
            baseSurv: Math.round(r.baseSurvRate * 1000) / 1000,
            v2Surv: Math.round(r.v2SurvRate * 1000) / 1000,
            dSurv: Math.round(r.survDelta * 1000) / 1000,
            rrGe15: Math.round(r.rrGe15Rate * 1000) / 1000,
            gainButRrLt15: Math.round(r.survGainButRrLt15Rate * 1000) / 1000
        } : null;
    });
    console.log('V2_POOL_ROW ' + symbol + ' ' + JSON.stringify({ matrix: rowJson, pairs: pairJson, coverage: c }));
    console.log('');
}

/**
 * Phase 11T.3 — Narrative Boundary Integrity Audit（四张表，只诊断，正式规则冻结）
 *
 * 样本 = 正式 trades（closed）+ shadow entries（triggered），与 Phase 11T 一致。
 * 核心问题：无 narrative stop reference 的 entry（Phase 11T.2 的 26%）
 *   是市场语义（MISSING_FROM_START）还是 pipeline 丢失（LOST_AFTER_WATCH）？
 *
 * ① Boundary Presence Performance：PRESENT vs MISSING（按 WATCH 时快照分组）
 * ② Boundary Loss Pipeline：四类分类（shadow: watch vs trigger；正式: watch vs plan）
 * ③ Performance 细表（与 ① 合并输出，含 MFE/MAE/DrawHit/stopOutThenTarget）
 * ④ Cross Asset：NB_POOL_ROW machine-readable（供 pooled 汇总）
 */
function reportNarrativeBoundary(result, candles, symbol) {
    var nb = require('../stats/narrativeBoundary');
    var trades = result.trades || [];
    var retraces = result.retraces || [];
    var entries = [];
    var formalCount = 0;

    // 1. 正式 trades（diagnostics.boundaryAtWatch/boundaryAtPlan 由 replayEngine 冻结）
    trades.forEach(function (t) {
        if (t.status !== 'WIN' && t.status !== 'LOSS' && t.status !== 'AMBIGUOUS') return;
        if (!t.entryPrice || !t.targetPrice || !t.diagnostics || !t.diagnostics.atr) return;
        if (t.entryIndex === null || t.entryIndex === undefined) return;
        entries.push({
            direction: t.direction,
            entryPrice: t.entryPrice,
            targetPrice: t.targetPrice,
            stopPrice: t.stopPrice,
            entryIndex: t.entryIndex,
            diagnostics: t.diagnostics,
            boundaryAtWatch: t.diagnostics.boundaryAtWatch || null,
            boundaryAtAction: t.diagnostics.boundaryAtPlan || null,
            alignmentAtWatch: null,
            biasAtWatch: null,
            fvgScoreAtWatch: null,
            formal: true
        });
        formalCount++;
    });

    // 2. shadow entries（boundaryAtWatch = retrace 冻结；boundaryAtAction = trigger 时实时 amdTrace）
    retraces.forEach(function (r) {
        (r.shadowResults || []).forEach(function (sr) {
            if (!sr.triggered || !sr.sim) return;
            if (sr.stop && sr.stop.status !== 'READY') return;
            if (!sr.target) return;
            var atr = r.atrAtWatch || 0;
            if (!atr || atr <= 0) return;
            entries.push({
                direction: r.direction === 'BULLISH' ? 'LONG' : 'SHORT',
                entryPrice: sr.triggerPrice,
                targetPrice: sr.target.price,
                stopPrice: sr.stop.price,
                entryIndex: sr.triggerIndex !== undefined ? sr.triggerIndex : r.watchIndex,
                diagnostics: { atr: atr },
                boundaryAtWatch: sr.boundaryAtWatch || null,
                boundaryAtAction: sr.amdAtTrigger || null,
                alignmentAtWatch: sr.alignmentAtWatch || null,
                biasAtWatch: sr.biasAtWatch || null,
                fvgScoreAtWatch: sr.fvgScoreAtWatch || null,
                formal: false
            });
        });
    });

    console.log('NARRATIVE BOUNDARY INTEGRITY (Phase 11T.3 — diagnostic only, all rules frozen)');
    if (entries.length === 0 || !candles) {
        console.log('  (no entries with atr / no candles)');
        console.log('');
        return;
    }

    // ① ③ Boundary Presence Performance
    var table = nb.boundaryPresenceTable(entries, candles, {});
    function printRow(label, row) {
        console.log('  ' + pad(label, 10) +
            pad(row.n, 4) +
            pad((row.survivalRate * 100).toFixed(0) + '%', 6) +
            pad((row.targetHitRate * 100).toFixed(0) + '%', 7) +
            pad(row.stopToTargetRate === null ? 'N/A' : (row.stopToTargetRate * 100).toFixed(0) + '%', 10) +
            pad(row.avgMfePct.toFixed(2) + '%', 8) +
            pad(row.avgMaePct.toFixed(2) + '%', 8) +
            pad(row.mfeMae === null ? 'N/A' : row.mfeMae.toFixed(2), 7) +
            pad(row.medRr === null ? 'N/A' : row.medRr.toFixed(1), 7) +
            pad(row.medStopAtr === null ? 'N/A' : row.medStopAtr.toFixed(2), 8) +
            pad(row.alignMatchRate === null ? 'N/A' : (row.alignMatchRate * 100).toFixed(0) + '%', 8) +
            pad(row.medFvgScore === null ? 'N/A' : row.medFvgScore.toFixed(0), 8));
    }
    console.log('①③ BOUNDARY PRESENCE PERFORMANCE（PRESENT = WATCH 时存在 manip extreme 或 acc boundary）');
    console.log('  ' + pad('group', 10) + pad('n', 4) + pad('surv', 6) + pad('tgtHit', 7) +
        pad('stop->tgt', 10) + pad('avgMFE', 8) + pad('avgMAE', 8) + pad('MFE/MAE', 7) +
        pad('medRR', 7) + pad('stopATR', 8) + pad('MATCH', 8) + pad('FVGscr', 8));
    printRow('PRESENT', table.present);
    printRow('MISSING', table.missing);
    console.log('  amdState@WATCH PRESENT: ' + JSON.stringify(table.present.amdStates));
    console.log('  amdState@WATCH MISSING: ' + JSON.stringify(table.missing.amdStates));
    console.log('');

    // ② Boundary Loss Pipeline（四类）
    var loss = nb.boundaryLossTable(entries);
    console.log('② BOUNDARY LOSS PIPELINE（watch vs trigger/plan 实时，' + loss.total + ' entries）');
    ['PRESENT_THROUGHOUT', 'MISSING_FROM_START', 'LOST_AFTER_WATCH', 'PRESENT_AT_TRIGGER_ONLY'].forEach(function (k) {
        var r = loss.classification[k];
        if (!r) return;
        console.log('  ' + pad(k, 26) + pad(r.n, 5) + '  ' + (r.pct * 100).toFixed(1) + '%');
    });
    console.log('  (LOST_AFTER_WATCH > 0 → AMD reset / context 未冻结，工程问题；MISSING_FROM_START 主导 → 市场语义)');
    console.log('  正式 trades 数：' + formalCount + '（diagnostics.boundaryAtWatch/boundaryAtPlan 冻结在 plan 时）');
    console.log('');

    // ④ Cross Asset machine-readable
    function rowJson(row) {
        return {
            n: row.n,
            surv: row.survivalRate,
            tgtHit: row.targetHitRate,
            stopTgt: row.stopToTargetRate,
            mfe: Math.round(row.avgMfePct * 100) / 100,
            mae: Math.round(row.avgMaePct * 100) / 100,
            mfeMae: row.mfeMae === null ? null : Math.round(row.mfeMae * 100) / 100,
            medRR: row.medRr === null ? null : Math.round(row.medRr * 100) / 100,
            stopATR: row.medStopAtr === null ? null : Math.round(row.medStopAtr * 100) / 100,
            match: row.alignMatchRate === null ? null : row.alignMatchRate,
            fvg: row.medFvgScore === null ? null : row.medFvgScore
        };
    }
    console.log('NB_POOL_ROW ' + symbol + ' ' + JSON.stringify({
        present: rowJson(table.present),
        missing: rowJson(table.missing),
        loss: loss.classification,
        formalCount: formalCount
    }));
    console.log('');

    // ---- Phase 11T.4：Snapshot Retention Shadow 对照（paired, same entry/target） ----
    reportRetainShadow(result, candles, symbol, entries);
    console.log('');
}

/**
 * Phase 11T.4 — Narrative Snapshot Retention Shadow（paired 对照，只统计）
 * baseline stop（正式逻辑，trigger 实时 AMD）vs retain stop（lastNarrative 补边界）
 */
function reportRetainShadow(result, candles, symbol, boundaryEntries) {
    var nb = require('../stats/narrativeBoundary');
    var enabled = require('../config/thresholds').amd.lastNarrative.enabled;
    var retraces = result.retraces || [];
    var pairs = [];
    var sources = { LIVE: {}, RETAIN: {} };

    retraces.forEach(function (r) {
        (r.shadowResults || []).forEach(function (sr) {
            if (!sr.triggered || !sr.sim) return;
            if (!sr.target) return;
            if (!sr.stopLive || sr.stopLive.status !== 'READY') return;
            if (!sr.stopRetain || sr.stopRetain.status !== 'READY') return;
            var atr = r.atrAtWatch || 0;
            if (!atr || atr <= 0) return;
            var dir = r.direction === 'BULLISH' ? 'LONG' : 'SHORT';
            var triggerIdx = sr.triggerIndex !== undefined ? sr.triggerIndex : r.watchIndex;
            var base = {
                direction: dir,
                entryPrice: sr.triggerPrice,
                targetPrice: sr.target.price,
                atr: atr,
                startIdx: triggerIdx
            };
            var lo = nb.entryOutcome({ stopPrice: sr.stopLive.price, entryPrice: base.entryPrice, targetPrice: base.targetPrice, direction: dir, atr: atr, startIdx: triggerIdx }, candles, {});
            var ro = nb.entryOutcome({ stopPrice: sr.stopRetain.price, entryPrice: base.entryPrice, targetPrice: base.targetPrice, direction: dir, atr: atr, startIdx: triggerIdx }, candles, {});
            if (lo.first === 'NEITHER' && ro.first === 'NEITHER') return; // 无信息量
            sources.LIVE[sr.stopLive.source] = (sources.LIVE[sr.stopLive.source] || 0) + 1;
            sources.RETAIN[sr.stopRetain.source] = (sources.RETAIN[sr.stopRetain.source] || 0) + 1;
            pairs.push({
                live: lo,
                retain: ro,
                liveStopAtr: Math.abs(base.entryPrice - sr.stopLive.price) / atr,
                retainStopAtr: Math.abs(base.entryPrice - sr.stopRetain.price) / atr,
                livePresent: nb.isPresent(sr.amdAtTrigger),
                retainPresent: sr.stopRetain.source === 'MANIPULATION_SWEEP' || sr.stopRetain.source === 'ACCUMULATION_RANGE',
                watchPresent: nb.isPresent(sr.boundaryAtWatch)
            });
        });
    });

    console.log('RETAIN SHADOW (Phase 11T.4 — snapshot retention, baseline frozen, paired same entry/target)');
    console.log('  retention enabled: ' + enabled + ' (RETAIN_LAST_NARRATIVE=1 to enable; default off = baseline)');
    if (pairs.length === 0) {
        console.log('  (no paired shadow entries)');
        return;
    }

    function med(arr) {
        if (!arr || arr.length === 0) return null;
        var s = arr.slice().sort(function (a, b) { return a - b; });
        var m = Math.floor(s.length / 2);
        return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    var liveAtrs = pairs.map(function (p) { return p.liveStopAtr; });
    var retainAtrs = pairs.map(function (p) { return p.retainStopAtr; });
    var liveSot = pairs.filter(function (p) { return p.live.first === 'STOP'; }).length;
    var liveSotT = pairs.filter(function (p) { return p.live.first === 'STOP' && p.live.stopOutThenTarget; }).length;
    var retainSot = pairs.filter(function (p) { return p.retain.first === 'STOP'; }).length;
    var retainSotT = pairs.filter(function (p) { return p.retain.first === 'STOP' && p.retain.stopOutThenTarget; }).length;
    var liveTgt = pairs.filter(function (p) { return p.live.first === 'TARGET' || p.live.stopOutThenTarget; }).length;
    var retainTgt = pairs.filter(function (p) { return p.retain.first === 'TARGET' || p.retain.stopOutThenTarget; }).length;
    var liveRrGe15 = pairs.filter(function (p) { return p.live.rr !== null && p.live.rr >= 1.5; }).length;
    var retainRrGe15 = pairs.filter(function (p) { return p.retain.rr !== null && p.retain.rr >= 1.5; }).length;
    var liveMiss = pairs.filter(function (p) { return !p.livePresent; }).length;
    var retainMiss = pairs.filter(function (p) { return !p.retainPresent; }).length;
    var watchPresentLost = pairs.filter(function (p) { return p.watchPresent && !p.livePresent; }).length;

    console.log('  stop reference source（LIVE vs RETAIN）：');
    ['MANIPULATION_SWEEP', 'ACCUMULATION_RANGE', 'SWING_LOW', 'SWING_HIGH', 'FVG_ZONE_LOW', 'FVG_ZONE_HIGH'].forEach(function (k) {
        var l = sources.LIVE[k] || 0, r2 = sources.RETAIN[k] || 0;
        if (l === 0 && r2 === 0) return;
        console.log('    ' + pad(k, 20) + ' live ' + pad(l, 4) + '  retain ' + pad(r2, 4));
    });
    console.log('  paired (n=' + pairs.length + ')');
    console.log('    ' + pad('metric', 14) + pad('LIVE', 10) + pad('RETAIN', 10) + pad('delta', 8));
    function pct(a, b) { return b > 0 ? (a / b * 100).toFixed(0) + '%' : 'N/A'; }
    console.log('    ' + pad('med stopATR', 14) + pad(med(liveAtrs) === null ? 'N/A' : med(liveAtrs).toFixed(2), 10) +
        pad(med(retainAtrs) === null ? 'N/A' : med(retainAtrs).toFixed(2), 10) +
        pad(med(retainAtrs) - med(liveAtrs) >= 0 ? '+' + (med(retainAtrs) - med(liveAtrs)).toFixed(2) : (med(retainAtrs) - med(liveAtrs)).toFixed(2), 8));
    console.log('    ' + pad('stop->target', 14) + pad(pct(liveSotT, liveSot), 10) + pad(pct(retainSotT, retainSot), 10) +
        pad((pct(liveSotT, liveSot) === 'N/A' || pct(retainSotT, retainSot) === 'N/A') ? '-' : (parseFloat(pct(retainSotT, retainSot)) - parseFloat(pct(liveSotT, liveSot)) >= 0 ? '+' : '') + (parseFloat(pct(retainSotT, retainSot)) - parseFloat(pct(liveSotT, liveSot))).toFixed(0) + '%', 8));
    console.log('    ' + pad('targetHit', 14) + pad(pct(liveTgt, pairs.length), 10) + pad(pct(retainTgt, pairs.length), 10) +
        pad((parseFloat(pct(retainTgt, pairs.length)) - parseFloat(pct(liveTgt, pairs.length)) >= 0 ? '+' : '') + (parseFloat(pct(retainTgt, pairs.length)) - parseFloat(pct(liveTgt, pairs.length))).toFixed(0) + '%', 8));
    console.log('    ' + pad('RR>=1.5', 14) + pad(pct(liveRrGe15, pairs.length), 10) + pad(pct(retainRrGe15, pairs.length), 10) +
        pad((parseFloat(pct(retainRrGe15, pairs.length)) - parseFloat(pct(liveRrGe15, pairs.length)) >= 0 ? '+' : '') + (parseFloat(pct(retainRrGe15, pairs.length)) - parseFloat(pct(liveRrGe15, pairs.length))).toFixed(0) + '%', 8));
    console.log('    ' + pad('boundary missing', 14) + pad(pct(liveMiss, pairs.length), 10) + pad(pct(retainMiss, pairs.length), 10));
    console.log('  LOST_AFTER_WATCH 挽回：watch-present 但 live-missing = ' + watchPresentLost + ' / ' + pairs.length + ' (' + (watchPresentLost / pairs.length * 100).toFixed(1) + '%)');
    console.log('  (LIVE = trigger 实时 AMD 的正式逻辑 stop；RETAIN = lastNarrative 补边界；只统计，不替换正式 stop)');
    console.log('RET_POOL_ROW ' + symbol + ' ' + JSON.stringify({
        enabled: enabled,
        n: pairs.length,
        live: {
            medAtr: Math.round(med(liveAtrs) * 100) / 100,
            stopTgt: liveSot > 0 ? Math.round(liveSotT / liveSot * 1000) / 1000 : null,
            tgtHit: pairs.length > 0 ? Math.round(liveTgt / pairs.length * 1000) / 1000 : 0,
            rrGe15: pairs.length > 0 ? Math.round(liveRrGe15 / pairs.length * 1000) / 1000 : 0,
            missing: pairs.length > 0 ? Math.round(liveMiss / pairs.length * 1000) / 1000 : 0
        },
        retain: {
            medAtr: Math.round(med(retainAtrs) * 100) / 100,
            stopTgt: retainSot > 0 ? Math.round(retainSotT / retainSot * 1000) / 1000 : null,
            tgtHit: pairs.length > 0 ? Math.round(retainTgt / pairs.length * 1000) / 1000 : 0,
            rrGe15: pairs.length > 0 ? Math.round(retainRrGe15 / pairs.length * 1000) / 1000 : 0,
            missing: pairs.length > 0 ? Math.round(retainMiss / pairs.length * 1000) / 1000 : 0
        },
        watchPresentLost: watchPresentLost,
        sources: { live: sources.LIVE, retain: sources.RETAIN }
    }));
}

/**
 * Phase 11D — Narrative Diagnostics
 * 1. Bias × AMD Direction occupancy
 * 2. Alignment 后续结果（MATCH/OPPOSITE/UNCONFIRMED → 未来 12/24/48 根 MFE/MAE/Draw hit）
 * 3. AMD Role 分类（CONTINUATION/RETRACEMENT/REVERSAL_CANDIDATE/COUNTER_TREND/UNCLASSIFIED）
 */
function reportNarrativeDiagnostics(steps, candles) {
    var ns = require('../stats/narrativeStats');

    console.log('NARRATIVE DIAGNOSTICS (Phase 11D — narrative value, no P&L)');
    if (!steps || steps.length === 0) {
        console.log('  (no steps)');
        console.log('');
        return;
    }

    // 1. Bias × AMD Direction
    console.log('BIAS × AMD DIRECTION (occupancy)');
    var bt = ns.biasAmdTable(steps);
    console.log('  ' + pad('bias', 14) + pad('amdDir', 10) + pad('count', 8) + pad('pct', 8));
    bt.rows.forEach(function (r) {
        console.log('  ' + pad(r.bias, 14) + pad(r.amd, 10) + pad(r.count, 8) + pad(r.pct.toFixed(2) + '%', 8));
    });
    console.log('  (amdDir = NONE 表示 AMD 未到 manipulation/distribution 明确方向)');
    console.log('');

    // 2. Alignment 后续结果
    console.log('ALIGNMENT FORWARD STATS (future MFE/MAE % + Primary Draw hit rate)');
    var fwd = ns.alignmentForwardStats(steps, candles, {});
    ['MATCH', 'OPPOSITE', 'UNCONFIRMED'].forEach(function (a) {
        var row = fwd[a];
        if (!row || row.n === 0) {
            console.log('  ' + pad(a, 12) + ' n=0');
            return;
        }
        console.log('  ' + pad(a, 12) + ' n=' + pad(row.n, 5));
        ns.LOOKAHEADS.forEach(function (lb) {
            var st = row.lookaheads[lb];
            console.log('    lookahead ' + pad(lb, 3) + ' bars: MFE ' + pad(st.mfePct.toFixed(2) + '%', 8) +
                ' MAE ' + pad(st.maePct.toFixed(2) + '%', 8) +
                ' DrawHit ' + pad((st.hitRate * 100).toFixed(1) + '%', 8));
        });
    });
    console.log('  (MFE/MAE 按 AMD direction 方向计 %，DrawHit = primary draw target 被触及比例)');
    console.log('');

    // 3. AMD Role
    console.log('AMD ROLE (static classification)');
    var rt = ns.amdRoleTable(steps);
    Object.keys(ns.AMD_ROLE).forEach(function (k) {
        var role = ns.AMD_ROLE[k];
        console.log('  ' + pad(role, 20) + pad(rt.roles[role] || 0, 6));
    });
    console.log('  (MATCH→CONTINUATION | OPPOSITE+MED/HIGH→RETRACEMENT | OPPOSITE+LOW→REVERSAL_CANDIDATE)');
    console.log('');
}

/**
 * Phase 11S.1 — Retrace Diagnostics（WATCH → FVG zone 的距离分布 + Shadow Entry 对比）
 */
function reportRetraceDiagnostics(retraces) {
    var list = retraces || [];
    console.log('RETRACE DIAGNOSTICS (Phase 11S.1 — diagnostic only, formal Entry Gate frozen)');
    if (list.length === 0) {
        console.log('  (no WATCH + WAITING_RETRACE retraces)');
        console.log('');
        return;
    }

    // 1. 分类分布
    console.log('RETRACE CLASSIFICATION (WATCH+FVG frozen zone outcomes)');
    var cls = {};
    list.forEach(function (r) { cls[r.classification] = (cls[r.classification] || 0) + 1; });
    ['TOUCHED_ZONE', 'NEAR_MISS_0_05_ATR', 'NEAR_MISS_0_10_ATR', 'NEAR_MISS_0_25_ATR', 'NEVER_CLOSE', 'INVALIDATED_BEFORE_RETRACE'].forEach(function (k) {
        console.log('  ' + pad(k, 28) + pad(cls[k] || 0, 6));
    });
    console.log('');

    // 2. minDistanceAtr 分布（核心问题：差多远）
    console.log('MIN DISTANCE TO ZONE (ATR-normalized)');
    var buckets = { '0 (in zone)': 0, '0-0.05': 0, '0.05-0.10': 0, '0.10-0.25': 0, '0.25-0.50': 0, '0.50-1.00': 0, '>1.00': 0 };
    list.forEach(function (r) {
        var d = r.minDistanceAtr;
        if (d === null || d === undefined || d === Infinity) { buckets['>1.00']++; return; }
        if (d <= 0) buckets['0 (in zone)']++;
        else if (d <= 0.05) buckets['0-0.05']++;
        else if (d <= 0.10) buckets['0.05-0.10']++;
        else if (d <= 0.25) buckets['0.10-0.25']++;
        else if (d <= 0.50) buckets['0.25-0.50']++;
        else if (d <= 1.00) buckets['0.50-1.00']++;
        else buckets['>1.00']++;
    });
    Object.keys(buckets).forEach(function (b) {
        console.log('  ' + pad(b, 12) + pad(buckets[b], 6));
    });
    console.log('');

    // 3. 明细（最近 8 条）
    console.log('RETRACE DETAIL (recent)');
    list.slice(-8).forEach(function (r) {
        console.log('  ' + fmt(r.watchAt).slice(5) + ' ' + pad(r.direction, 7) +
            ' ' + pad(r.classification, 25) +
            ' initDistAtr ' + pad(r.initialDistanceAtr === null ? 'N/A' : r.initialDistanceAtr, 7) +
            ' minDistAtr ' + pad(r.minDistanceAtr === Infinity || r.minDistanceAtr === null ? 'N/A' : r.minDistanceAtr, 7) +
            ' bars ' + pad(r.barsWatched, 4) +
            ' zone ' + r.zoneLow + '-' + r.zoneHigh +
            ' [' + r.closeReason + ']');
    });
    console.log('');

    // 4. Shadow Entry 对比（DIAGNOSTIC_SHADOW_ENTRY）
    var shadow = require('../stats/shadowEntry');
    var rows = shadow.summarizeShadows(list);
    console.log('SHADOW ENTRY (DIAGNOSTIC_SHADOW_ENTRY — hypothetical, no formal plan)');
    console.log('  ' + pad('tolerance', 14) + pad('entries', 7) + pad('filled', 6) +
        pad('win', 5) + pad('loss', 5) + pad('amb', 5) + pad('exp', 5) + pad('can', 5) +
        pad('avgR', 8) + pad('totalR', 8) + pad('stopDistAtr', 12));
    rows.forEach(function (row) {
        console.log('  ' + pad(row.toleranceLabel, 14) + pad(row.entries, 7) + pad(row.filled, 6) +
            pad(row.wins, 5) + pad(row.losses, 5) + pad(row.ambiguous, 5) + pad(row.expired, 5) + pad(row.cancelled, 5) +
            pad(row.avgR, 8) + pad(row.totalR, 8) +
            pad(row.avgStopDistanceAtr === null ? 'N/A' : row.avgStopDistanceAtr, 12));
    });
    console.log('  (entry price = trigger bar close; stop/target use frozen rules; not a strategy recommendation)');
    console.log('');
}

function reportStopDiagnostics(trades, candles) {
    var sd = require('../stats/stopDiagnostics');
    var closed = trades.filter(function (t) { return t.status === 'WIN' || t.status === 'LOSS'; });

    console.log('STOP DIAGNOSTICS (Phase 11S — diagnostic only, no parameter change)');
    if (closed.length === 0) {
        console.log('  (no closed trades)');
        console.log('');
        return;
    }

    // 1. Stop Source 分布
    console.log('STOP SOURCE DISTRIBUTION');
    var sources = sd.analyzeStopSources(closed);
    Object.keys(sources).sort().forEach(function (k) {
        var s = sources[k];
        console.log('  ' + pad(k, 22) + ' n=' + pad(s.count, 4) + '  win ' + s.wins + ' / loss ' + s.losses);
    });
    console.log('');

    // 2. Stop Distance (ATR) 分桶
    console.log('STOP DISTANCE (ATR-normalized)');
    var buckets = sd.analyzeStopDistance(closed);
    Object.keys(buckets).sort().forEach(function (b) {
        var x = buckets[b];
        console.log('  ' + pad(b, 18) + ' n=' + pad(x.count, 4) + '  win ' + x.wins + ' / loss ' + x.losses);
    });
    console.log('');

    // 3. Stop Candidates 对比（每笔旁路候选）
    console.log('STOP CANDIDATES (baseline vs alternatives, per trade)');
    var rows = sd.analyzeCandidates(closed);
    if (rows.length === 0) {
        console.log('  (no candidate data)');
    } else {
        // 只显示最近 4 笔 trade 的候选（避免刷屏）
        var shownTrades = {};
        rows.forEach(function (r) {
            if (!shownTrades[r.tradeId] && Object.keys(shownTrades).length < 4) {
                shownTrades[r.tradeId] = true;
                console.log('  ' + pad(r.tradeId.slice(0, 30), 32) + ' ' + r.status);
                rows.filter(function (x) { return x.tradeId === r.tradeId; }).forEach(function (c) {
                    console.log('    ' + pad(c.source, 22) + ' risk ' + pad(c.risk, 8) +
                        '  distAtr ' + pad(c.distanceAtr === null ? 'N/A' : c.distanceAtr, 7) +
                        '  rr ' + pad(c.rr === null ? 'N/A' : c.rr, 7) +
                        (c.isBaseline ? '  [BASELINE]' : ''));
                });
            }
        });
    }
    console.log('');

    // 4. Winner / Loss MAE-MFE 分布
    var mm = sd.analyzeMaeMfe(closed);
    console.log('MAE / MFE DISTRIBUTION (in R)');
    ['win', 'loss'].forEach(function (k) {
        console.log('  ' + pad(k.toUpperCase(), 6) +
            ' MAE median ' + pad(mm[k].maeR.median === null ? 'N/A' : mm[k].maeR.median, 6) +
            ' p90 ' + pad(mm[k].maeR.p90 === null ? 'N/A' : mm[k].maeR.p90, 6) +
            ' | MFE median ' + pad(mm[k].mfeR.median === null ? 'N/A' : mm[k].mfeR.median, 6) +
            ' p90 ' + pad(mm[k].mfeR.p90 === null ? 'N/A' : mm[k].mfeR.p90, 6));
    });
    console.log('');

    // 5. STOP_OUT_THEN_TARGET
    if (candles && candles.length > 0) {
        var sot = sd.analyzeStopOutThenTarget(closed, candles, [12, 24]);
        console.log('STOP-OUT-THEN-TARGET (LOSS 后到达原 Target 的比例)');
        [12, 24].forEach(function (lb) {
            var o = sot['lookahead_' + lb];
            console.log('  lookahead ' + pad(lb, 3) + ' bars: ' + o.hitTarget + ' / ' + o.losses +
                (o.rate !== null ? ' = ' + o.rate + '%' : ''));
        });
        console.log('');
    }

    // 6. Stop Efficiency 明细
    console.log('STOP EFFICIENCY (per trade)');
    sd.stopEfficiencyRows(closed).forEach(function (r) {
        console.log('  ' + pad(r.tradeId.slice(0, 26), 28) +
            ' ' + pad(r.status, 5) +
            ' riskAtr ' + pad(r.initialRiskAtr === null ? 'N/A' : r.initialRiskAtr, 7) +
            ' maeR ' + pad(r.maeR, 6) +
            ' mfeR ' + pad(r.mfeR, 6) +
            ' rr ' + pad(r.rr, 7) +
            ' [' + (r.stopSource || '') + ']');
    });
    console.log('');
}
