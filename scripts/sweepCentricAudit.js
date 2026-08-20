/**
 * Phase 11L.12 — Sweep-centric Validation（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/sweepCentricAudit.js BTCUSDT 90
 *
 * 从 SweepEvent 本身出发（非 HIGH 出发），按 liquidity 类型分组（EQL/EQH、PDH/PDL、SESSION、5m SWING、OTHER），
 * 看后续 1h 内：方向匹配 MSS 出现率 / protected MSS 率 / STRONG·EXPLOSIVE leg 率 / 形成 HIGH 率 / MFE·MAE。
 * 回答：什么 liquidity event 更容易"启动"后续有意义的 Delivery？
 * （修正 11L.11 HIGH-centric 的条件选择偏差 —— 先确认验证框架没把 Liquidity 价值测错）
 * 纯诊断，不改生产。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var sweepCentricAudit = require('../stats/sweepCentricAudit');

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
            var res = sweepCentricAudit.auditSweepCentric({
                sweepEvents: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                swings: result.swings || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                alerts: alerts,
                candles: candles
            });

            console.log('');
            console.log('SWEEP-CENTRIC VALIDATION (Phase 11L.12, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('母样本 = 全部 LIQUIDITY_SWEEP 事件（非 HIGH）；观察窗口 ' + res.windowBars + ' 根 5m（1h）');
            console.log('方向 = sweep.side 对应的 delivery 方向（SSL→BULLISH / BSL→BEARISH）');
            console.log('');
            console.log('=== Sweep 类型 → 后续 Delivery 启动率（n / MSS / protected MSS / StrongLeg / HIGH / MFE1h% / MAE1h%） ===');
            console.log(pad('Group', 10) + pad('n', 8) + pad('MSS', 8) + pad('protMSS', 9) +
                pad('StrongLeg', 11) + pad('HIGH', 8) + pad('MFE1h%', 9) + pad('MAE1h%', 9));
            res.order.forEach(function (g) {
                var x = res.groups[g];
                if (!x) return;
                console.log(pad(g, 10) + pad(x.n, 8) +
                    pad(pct(x.mss / x.n), 8) + pad(pct(x.protectedMss / x.n), 9) +
                    pad(pct(x.strongLeg / x.n), 11) + pad(pct(x.high / x.n), 8) +
                    pad(x.mfeCnt > 0 ? (x.mfeSum / x.mfeCnt).toFixed(2) : '-', 9) +
                    pad(x.mfeCnt > 0 ? (x.maeSum / x.mfeCnt).toFixed(2) : '-', 9));
            });
            console.log('');
            console.log('解读：');
            console.log('  - 若 EQL/EQH、PDH/PDL、SESSION 的 MSS/StrongLeg/HIGH 启动率明显高于 5m SWING →');
            console.log('    重要 liquidity 确实更易"启动"Delivery，5m Swing 应回归 Structure（降级）');
            console.log('  - 若各类型启动率相近 → 普通 Swing 与 EQL/PDH 一样是有效 liquidity object');
            console.log('  - 本表回答"什么 liquidity 更易启动 Delivery"，不受 HIGH 过滤的选择偏差影响');
            console.log('  - 纯诊断：生产判定与通知零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('SWEEP-CENTRIC AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
