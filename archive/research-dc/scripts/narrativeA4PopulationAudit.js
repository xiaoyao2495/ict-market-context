/**
 * Bias Phase 1 — Formation A.4 → 90d Population Audit（SHADOW，只读审计）
 *
 * 目的（用户路线 2026-08-21）：23-case sanity 已 PASS、G1+G3 certainty gate 已冻结。
 * 现在审计"考卷本身"——不评估 Bias accuracy，只统计 Formation Ground Truth 在
 * 90d 全量 candidate MSS 上的覆盖率与 drop reason 分布。
 *
 * 关键指标（用户定义）：
 *   - totalCandidateMSS        : 90d 内所有 MSS 事件数（BULL+BEAR）
 *   - eligibleCandidateMSS     : 有 >=1 eligible raid 的 MSS 数（进入 A.4 判定）
 *   - noRegisteredRaid         : 无任何 eligible raid 的 MSS 数（不进 A.4）
 *   - finalFormationGT         : TERMINAL_MANIPULATION_EPISODE 数（考卷最终样本）
 *   - coverage                 : finalFormationGT / eligibleCandidateMSS
 *   - decision 分布            : TERMINAL / NO_CLEAR_CAUSAL_RAID / NO_DISP
 *   - drop reason 细分         : step2 UNREGISTERED / G1 / G3 / step4 ALIGN / NO_DISP / NO_ELIGIBLE
 *   - G1 / G3 各自过滤量       : 从 certaintyGate / pricePathVeto 统计
 *   - BULL / BEAR 分布         : 按 direction 统计 finalGT 与 eligible
 *
 * 纪律：
 *   - 暂不给 coverage 设目标值（40% 不优化、80% 不庆祝）；只看留下来的 GT 干不干净。
 *   - Precision > Coverage；不评估 Bias；不改 production / 不调参。
 *   - 复用 narrativeA4Sanity23.js 同 replay 管线（同一 90d 缓存 20686，mssId 稳定）。
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA4PopulationAudit.js [SYMBOL] [DAYS]
 */
var fs = require('fs');
var path = require('path');
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var a4 = require('../stats/narrativeFormationA4');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.4 90d Population Audit ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
        var t0 = Date.now();
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: SNAPSHOT_INTERVAL,
            logEvery: 999999
        }).then(function (result) {
            console.log('Replay 完成 (' + Math.round((Date.now() - t0) / 1000) + 's)');

            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );
            var ctx = {
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                swings: result.swings || [],
                legByDispId: legByDispId,
                candles5m: candles5m,
                a4Trace: true,
                a4Traces: {}
            };

            var a4n = a4.buildNarrativesA4(ctx);
            var a4Traces = ctx.a4Traces || {};

            // ---- 聚合统计 ----
            var mssEvents = result.mssEvents || [];
            var totalCandidateMSS = mssEvents.length;

            // 计算 eligibleCandidateMSS（与 A.4 内部同逻辑：同方向、prevIdx < idx < Mi）
            var sweeps = ctx.sweeps;
            var GAP_MAX = 12; // 与 A.4 默认一致（ctx 未覆盖）
            var eligibleCountByMss = {};
            mssEvents.forEach(function (m) {
                var Mi = m.candleIndex, D = m.direction;
                var prevIdx = -Infinity;
                for (var p = 0; p < mssEvents.length; p++) {
                    if (mssEvents[p].candleIndex >= Mi) break;
                    if (mssEvents[p].direction === D) prevIdx = mssEvents[p].candleIndex;
                }
                var n = sweeps.filter(function (s) {
                    return s.direction === D && s.candleIndex > prevIdx && s.candleIndex < Mi;
                }).length;
                eligibleCountByMss[m.id] = n;
            });

            var eligibleCandidateMSS = 0;
            var noRegisteredRaid = 0;
            var decisionCount = {
                TERMINAL_MANIPULATION_EPISODE: 0,
                NO_CLEAR_CAUSAL_RAID: 0,
                NO_DISP: 0
            };
            // drop reason 细分
            var dropReason = {
                STEP2_UNREGISTERED: 0,   // pricePathVeto = UNREGISTERED_DEEPER_EXTREME
                G1: 0,                   // certaintyGate = G1_UNREGISTERED_DEEPER_IN_EPISODE
                G3: 0,                   // certaintyGate = G3_ISOLATED_SINGLE_EPISODE
                STEP4_ALIGN: 0,          // alignResult = false（NO_CLEAR 但 certaintyGate=null & pricePathVeto=OK）
                NO_DISP: 0,              // decision = NO_DISP
                NO_ELIGIBLE: 0           // 无任何 eligible raid
            };
            var dirFinalGT = { BULLISH: 0, BEARISH: 0 };
            var dirEligible = { BULLISH: 0, BEARISH: 0 };
            var dirNoClear = { BULLISH: 0, BEARISH: 0 };

            mssEvents.forEach(function (m) {
                var tr = a4Traces[m.id];
                var D = m.direction;
                var nElig = eligibleCountByMss[m.id] || 0;
                if (nElig === 0) {
                    noRegisteredRaid++;
                    dropReason.NO_ELIGIBLE++;
                    return;
                }
                eligibleCandidateMSS++;
                dirEligible[D]++;

                if (!tr || !tr.decision) {
                    // 理论上不应发生（A.4 对每个有 eligible 的 MSS 都写 trace），兜底记 NO_CLEAR
                    decisionCount.NO_CLEAR_CAUSAL_RAID++;
                    dirNoClear[D]++;
                    return;
                }
                if (tr.decision === 'TERMINAL_MANIPULATION_EPISODE') {
                    decisionCount.TERMINAL_MANIPULATION_EPISODE++;
                    dirFinalGT[D]++;
                } else if (tr.decision === 'NO_DISP') {
                    decisionCount.NO_DISP++;
                    dropReason.NO_DISP++;
                } else if (tr.decision === 'NO_CLEAR_CAUSAL_RAID') {
                    decisionCount.NO_CLEAR_CAUSAL_RAID++;
                    dirNoClear[D]++;
                    // 细分 drop reason
                    if (tr.pricePathVeto === 'UNREGISTERED_DEEPER_EXTREME') {
                        dropReason.STEP2_UNREGISTERED++;
                    } else if (tr.certaintyGate === 'G1_UNREGISTERED_DEEPER_IN_EPISODE') {
                        dropReason.G1++;
                    } else if (tr.certaintyGate === 'G3_ISOLATED_SINGLE_EPISODE') {
                        dropReason.G3++;
                    } else if (tr.alignResult === false) {
                        dropReason.STEP4_ALIGN++;
                    } else {
                        // 其他 NO_CLEAR（step 3 无 startCand 等）
                        dropReason.NO_ELIGIBLE++; // 复用计数（无更细分字段）
                    }
                }
            });

            var finalGT = decisionCount.TERMINAL_MANIPULATION_EPISODE;
            var coverage = eligibleCandidateMSS > 0
                ? (finalGT / eligibleCandidateMSS * 100) : 0;

            var out = [];
            out.push('=== A.4 Formation → 90d Population Audit (' + SYMBOL + ' ' + DAYS + 'd, futures) ===');
            out.push('窗口: ' + new Date(startTime).toISOString() + ' → ' + new Date(endTime).toISOString());
            out.push('（同一 90d 缓存 20686；mssId 稳定。只审计考卷本身，不评估 Bias accuracy。）');
            out.push('');
            out.push('──── 总量 ────');
            out.push('  totalCandidateMSS        = ' + totalCandidateMSS + '   (90d 内所有 MSS 事件 BULL+BEAR)');
            out.push('  noRegisteredRaid         = ' + noRegisteredRaid + '   (无 eligible raid，不进 A.4)');
            out.push('  eligibleCandidateMSS     = ' + eligibleCandidateMSS + '   (= total - noRegisteredRaid，进入 A.4 判定)');
            out.push('  finalFormationGT         = ' + finalGT + '   (TERMINAL_MANIPULATION_EPISODE，考卷最终样本)');
            out.push('  coverage                 = ' + finalGT + ' / ' + eligibleCandidateMSS +
                ' = ' + coverage.toFixed(1) + '%   (暂不设目标值)');
            out.push('');
            out.push('──── decision 分布（eligible 子集）────');
            out.push('  TERMINAL_MANIPULATION_EPISODE = ' + decisionCount.TERMINAL_MANIPULATION_EPISODE);
            out.push('  NO_CLEAR_CAUSAL_RAID          = ' + decisionCount.NO_CLEAR_CAUSAL_RAID);
            out.push('  NO_DISP                       = ' + decisionCount.NO_DISP);
            out.push('  (NO_CLEAR + NO_DISP 合计淘汰 = ' +
                (decisionCount.NO_CLEAR_CAUSAL_RAID + decisionCount.NO_DISP) +
                ' / ' + eligibleCandidateMSS + ')');
            out.push('');
            out.push('──── drop reason 细分（NO_CLEAR + NO_DISP 来源）────');
            out.push('  STEP2_UNREGISTERED (pricePathVeto, 定义⑤未登记更深) = ' + dropReason.STEP2_UNREGISTERED);
            out.push('  G1_UNREGISTERED_DEEPER_IN_EPISODE (certainty gate)  = ' + dropReason.G1);
            out.push('  G3_ISOLATED_SINGLE_EPISODE (certainty gate)         = ' + dropReason.G3);
            out.push('  STEP4_ALIGN (兜底 alignment 否决)                    = ' + dropReason.STEP4_ALIGN);
            out.push('  NO_DISP (无合法 bound displacement)                  = ' + dropReason.NO_DISP);
            out.push('  NO_ELIGIBLE (兜底/其他)                              = ' + dropReason.NO_ELIGIBLE);
            out.push('  (G1+G3 certainty gate 合计过滤 = ' + (dropReason.G1 + dropReason.G3) + ')');
            out.push('');
            out.push('──── BULL / BEAR 分布 ────');
            out.push('  BULLISH: eligible=' + dirEligible.BULLISH +
                '  finalGT=' + dirFinalGT.BULLISH +
                '  noClear=' + dirNoClear.BULLISH +
                '  coverage=' + (dirEligible.BULLISH ? (dirFinalGT.BULLISH / dirEligible.BULLISH * 100).toFixed(1) : '0') + '%');
            out.push('  BEARISH: eligible=' + dirEligible.BEARISH +
                '  finalGT=' + dirFinalGT.BEARISH +
                '  noClear=' + dirNoClear.BEARISH +
                '  coverage=' + (dirEligible.BEARISH ? (dirFinalGT.BEARISH / dirEligible.BEARISH * 100).toFixed(1) : '0') + '%');
            out.push('');
            out.push('结论：GT coverage = ' + coverage.toFixed(1) + '%（暂不设目标值）。');
            out.push('Precision > Coverage：留下来 ' + finalGT + ' 个 GT 必须干干净净，不追求覆盖率。');
            out.push('下一步：抽样 20 Bull + 20 Bear 人眼验收 → Formation Ground Truth FREEZE → Daily Bias Validation。');

            var text = out.join('\n');
            var outFile = path.join(__dirname, '..', 'outputs', 'a4population90d_' + SYMBOL + '_futures.txt');
            fs.writeFileSync(outFile, text);
            console.log(text);
            console.log('\n[written] ' + outFile);
        });
    })
    .catch(function (err) {
        console.error('FATAL', err);
        process.exit(1);
    });
