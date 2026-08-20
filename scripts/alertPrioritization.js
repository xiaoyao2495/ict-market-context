/**
 * Phase 11L.15 — Alert Prioritization Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/alertPrioritization.js BTCUSDT 90
 *
 * 第一版 Alert Filter：HIGH + Significant Liquidity → PRIORITY_HIGH（其余 SUPPRESSED，不推钉钉）
 *   Significant = EQL / EQH / PDL / PDH / Session（普通 5M SWING 不够格）
 *
 * 两个口径都输出：
 *   A. immediate 口径（通知显示口径）：immediateSweep 显著
 *   B. window 口径（窗口内存在）：allCandidates 任一显著
 *
 * 输出 HIGH_TOTAL / PRIORITY / SUPPRESSED（含原因分布）+ forward 指标（NearHit30m/1h/MFE/MAE）。
 * 回答：通知量从 575 降到多少；PRIORITY vs SUPPRESSED 质量是否恶化。
 * 纯 shadow：不改钉钉、不改 HIGH、不改通知。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var alertPrioritization = require('../stats/alertPrioritization');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = process.env.SNAPSHOT_INTERVAL !== undefined
    ? parseInt(process.env.SNAPSHOT_INTERVAL, 10)
    : 12;

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

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd, ' + fmt(startTime) + ' -> ' + fmt(endTime) + ') ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        console.log('5m: ' + candles5m.length + ' bars  [' + (candles5m[0] && candles5m[0].source) + ']  tickSize ' + data.exchangeInfo.tickSize);
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
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
            logEvery: 999999
        }).then(function (result) {
            console.log('Replay 完成 (' + Math.round((Date.now() - t0) / 1000) + 's)');
            var candles = candles5m;
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles || [],
                result.mssEvents || [], result.swings || []);
            var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
                DISPLACEMENT: result.displacementEvents || [],
                MSS: result.mssEvents || []
            });
            var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
                result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);
            var highs = alerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; });
            var res = alertPrioritization.auditPrioritization(highs, candles);

            function printRow(label, acc) {
                var near30 = acc.nearCnt30m > 0 ? pct(acc.nearHit30m / acc.nearCnt30m) : '-';
                var near1h = acc.nearCnt1h > 0 ? pct(acc.nearHit1h / acc.nearCnt1h) : '-';
                var mfe = acc.mfeCnt > 0 ? (acc.mfeSum / acc.mfeCnt).toFixed(2) : '-';
                var mae = acc.mfeCnt > 0 ? (acc.maeSum / acc.mfeCnt).toFixed(2) : '-';
                console.log(pad(label, 26) + pad(acc.n, 6) + pad(near30, 12) + pad(near1h, 12) + pad(mfe, 9) + pad(mae, 9));
            }
            function printBlock(title, v) {
                console.log('');
                console.log(title);
                console.log(pad('Group', 26) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
                    pad('MFE1h%', 9) + pad('MAE1h%', 9));
                printRow('PRIORITY_HIGH', v.priority);
                printRow('SUPPRESSED_HIGH', v.suppressed);
                var reasons = Object.keys(v.suppressedReasons).sort();
                reasons.forEach(function (r) {
                    console.log(pad('  原因 ' + r, 26) + pad(v.suppressedReasons[r], 6));
                });
            }

            console.log('');
            console.log('ALERT PRIORITIZATION SHADOW (Phase 11L.15, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('规则：HIGH + Significant Liquidity → PRIORITY_HIGH；Significant = EQL/EQH/PDL/PDH/SESSION');
            console.log('口径：通知后 availableIndex+1 起；notificationPrice 基准；production HIGH 未改动');
            console.log('');
            console.log('=== Baseline（全部 HIGH = 生产现状，钉钉当前会全部推） ===');
            console.log(pad('Group', 26) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9));
            printRow('ALL_HIGH', res.baseline);

            printBlock('=== A. immediate 口径（immediateSweep 显著，= 通知显示口径） ===', res.variants.immediate);
            printBlock('=== B. window 口径（allCandidates 任一显著，= 窗口内存在） ===', res.variants.window);

            function rate(v) {
                return v.priority.n + '/' + res.total + ' (' + pct(v.priority.n / res.total) + ')  抑制 ' + v.suppressed.n + ' (' + pct(v.suppressed.n / res.total) + ')';
            }
            console.log('');
            console.log('A 消息量：PRIORITY ' + rate(res.variants.immediate));
            console.log('B 消息量：PRIORITY ' + rate(res.variants.window));
            console.log('');
            console.log('解读：');
            console.log('  - PRIORITY vs SUPPRESSED 的 NearHit/MFE 差异 → 显著流动性是否有真实筛选价值');
            console.log('  - 若消息量明显下降且质量无恶化 → 钉钉只推 PRIORITY_HIGH（正式上线需用户定）；');
            console.log('  - 若 SUPPRESSED 质量也高 → 该门槛太严，需再看 NearDistance/ATR 等第二阶段特征');
            console.log('  - 纯 shadow：钉钉 / HIGH / 通知均未改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('ALERT PRIORITIZATION AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
