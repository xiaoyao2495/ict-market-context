/**
 * Bias Phase 1 — ICT Narrative Ground Truth（90d/180d）
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeLabelAudit.js [SYMBOL] [DAYS]
 *   （ARCHIVED_DIRECTIONAL_CHANGE=1：DC MSS 链路——narrative 用 Structural MSS，12.5A flag）
 *
 * 输出：
 *   - Narrative Formation 分布（BULLISH/BEARISH n、Raid→MSS→Disp 转化率）
 *   - 时间结构（Raid→MSS / MSS→Disp / Raid→Disp median bars）
 *   - Follow-through outcome（30m/1h/4h MFE、1h MAE、Near Draw Hit、Continuation、Invalidation）
 *
 * 纯诊断：Detection 冻结、Bias Engine 不动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var thresholds = require('../config/thresholds');
var displacementLeg = require('../stats/displacementLeg');
var narrativeLabelAudit = require('../stats/narrativeLabelAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
// Narrative 用 Structural MSS（12.5A flag）——脚本强制 DC 链路
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

function fmt(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}
function pct(x) {
    if (x === null || x === undefined) return '-';
    return (x * 100).toFixed(1) + '%';
}
function fnum(x, d) {
    if (x === null || x === undefined) return '-';
    return x.toFixed(d);
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd, ' + fmt(startTime) + ' -> ' + fmt(endTime) + ') ...');

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

            // leg 归属索引（12.5B 口径：leg.mssId = displacement 的 mssEventId）
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );

            var res = narrativeLabelAudit.auditNarratives({
                candles: candles5m,
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                drawTrace: result.drawTrace || []
            });

            console.log('');
            console.log('BIAS PHASE 1 — ICT NARRATIVE GROUND TRUTH (' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('Narrative Formation = Opposite Raid → Structural MSS(DC) → Displacement(leg 归属)');
            console.log('Follow-through 单独作为 Outcome（不混入 setup）');
            console.log('');

            console.log('=== Population Audit ===');
            console.log('  总 sweep（有方向）    = ' + res.stats.totalSweeps +
                '（Bull ' + res.stats.bullSweeps + ' / Bear ' + res.stats.bearSweeps + '）');
            console.log('  完整 Narrative 链     = ' + res.stats.narratives +
                '（' + JSON.stringify(res.stats.narrByRaidSide) + '）');
            console.log('  SSL Raid → 完整 Bull Narrative = ' + pct(
                res.stats.bullSweeps > 0 ? (res.stats.narrByRaidSide.SSL || 0) / res.stats.bullSweeps : null));
            console.log('  BSL Raid → 完整 Bear Narrative = ' + pct(
                res.stats.bearSweeps > 0 ? (res.stats.narrByRaidSide.BSL || 0) / res.stats.bearSweeps : null));
            console.log('');

            console.log('=== 时间结构（median bars） ===');
            console.log('  Raid → MSS      ' + fnum(res.stats.medianBars.raidToMss, 1) + ' bars');
            console.log('  MSS → Disp      ' + fnum(res.stats.medianBars.mssToDisp, 1) + ' bars');
            console.log('  Raid → Disp     ' + fnum(res.stats.medianBars.raidToDisp, 1) + ' bars');
            console.log('');

            console.log('=== Follow-through Outcome ===');
            console.log(pad('Narrative', 10) + pad('n', 6) + pad('MFE30m', 9) + pad('MFE1h', 9) +
                pad('MFE4h', 9) + pad('MAE1h', 9) + pad('NearHit1h', 10) + pad('Cont', 7) + pad('Inv', 7));
            ['BULLISH', 'BEARISH'].forEach(function (dir) {
                var s = res.outcomeSummary[dir];
                if (!s || s.n === 0) return;
                console.log(pad(dir, 10) + pad(String(s.n), 6) +
                    pad(fnum(s.mfe30mMean, 1), 9) + pad(fnum(s.mfe1hMean, 1), 9) +
                    pad(fnum(s.mfe4hMean, 1), 9) + pad(fnum(s.mae1hMean, 1), 9) +
                    pad(pct(s.nearHit1hRate), 10) + pad(pct(s.continuationRate), 7) + pad(pct(s.invalidationRate), 7));
            });
            console.log('');

            // 人工抽查锚点（人眼 Narrative 过关用，用户 2026-08-21 09:08 强化）
            // 随机抽 20 Bullish + 20 Bearish 完整链，打印时间/价格/间隔，便于在图上核对
            // 程序所谓的 Raid→MSS→Displacement 是否真像 ICT delivery，而非仅代码形式满足。
            function pickSamples(arr, k) { return arr.slice(0, k); }
            function reviewLine(n) {
                var rc = candles5m[n.raidIndex], mc = candles5m[n.mssIndex], dc = candles5m[n.dispIndex];
                var f = function (ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-'; };
                var rp = rc ? rc.close : null, dp = dc ? dc.close : null;
                var dt = dc ? dc.closeTime : null, mt = mc ? mc.closeTime : null;
                return pad(n.raidSide, 4) + ' raid ' + f(n.raidTime) + '(' + (rp !== null ? rp.toFixed(1) : '-') + ')'
                    + ' -> MSS ' + f(mt) + '(+' + (n.raidToMssBars !== null ? n.raidToMssBars : '-') + 'b)'
                    + ' -> Disp ' + f(dt) + '(+' + (n.mssToDispBars !== null ? n.mssToDispBars : '-') + 'b)'
                    + ' base=' + (dp !== null ? dp.toFixed(1) : '-');
            }
            var bull = res.narratives.filter(function (n) { return n.raidSide === 'SSL'; });
            var bear = res.narratives.filter(function (n) { return n.raidSide === 'BSL'; });
            console.log('');
            console.log('=== 人工抽查锚点（随机选 20 Bullish + 20 Bearish，图上核对 ICT delivery）===');
            console.log('  Bullish (SSL raid->Bull MSS->Bull Disp) n=' + bull.length + '：');
            pickSamples(bull, 20).forEach(function (n) { console.log('   ' + reviewLine(n)); });
            console.log('  Bearish (BSL raid->Bear MSS->Bear Disp) n=' + bear.length + '：');
            pickSamples(bear, 20).forEach(function (n) { console.log('   ' + reviewLine(n)); });

            console.log('解读（Bias Phase 1 验收）：');
            console.log('  ⚠️ 第一轮 Population Audit 只审"考卷答案"四项，不评估任何 Bias 模型准不准：');
            console.log('    ① Bull/Bear Narrative 数量与频率是否合理（看 narrByRaidSide / sweeps 比例）');
            console.log('    ② Raid→MSS→Disp 时间顺序/间隔是否自然（看 median bars，非预设上限）');
            console.log('    ③ Narrative 成立后是否确有方向性 follow-through（看 MFE / Cont，NearHit 仅作参考非结论）');
            console.log('    ④ 有无大量"机械闭环但无价格意义"的 Narrative（低 MFE + 高 Inv → 先修 Ground Truth，绝不进 Bias 比较）');
            console.log('  - 若四项过关 → 才作为 Bias 考场；否则先修 Narrative 定义');
            console.log('  - MFE/MAE 是 follow-through 的独立 outcome，不参与 Narrative Formation 判定');
            console.log('  - 纯诊断：Detection 冻结、Bias Engine 不动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('NARRATIVE LABEL AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
