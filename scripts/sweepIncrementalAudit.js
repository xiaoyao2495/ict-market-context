/**
 * Phase 11L.13 — Liquidity Incremental Value Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/sweepIncrementalAudit.js BTCUSDT 90
 *
 * 母样本 = 全部 LIQUIDITY_SWEEP（非 HIGH）。按共现分组：
 *   SWING_ONLY / SWING_OVERLAP / SIGNIFICANT_ONLY / SIGNIFICANT_OVERLAP
 * （共现 = 价格容差 0.1% + 时间窗口 12 bars 内存在其他类型的 sweep）
 * 多指标：Protected MSS / Strong·Explosive Leg / HIGH formation / MFE / MAE。
 * 回答：普通 5m Swing 是独立有效，还是搭了重要 liquidity 的便车？
 * 纯诊断，不改生产。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var sweepIncrementalAudit = require('../stats/sweepIncrementalAudit');

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
            var res = sweepIncrementalAudit.auditIncrementalValue({
                sweepEvents: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                swings: result.swings || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                alerts: alerts,
                candles: candles
            });
            var g = res.groups;

            console.log('');
            console.log('LIQUIDITY INCREMENTAL VALUE AUDIT (Phase 11L.13, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('母样本 = 全部 LIQUIDITY_SWEEP；共现判定：价格容差 ' + (res.priceTolerance * 100) + '% + 时间窗口 ' + res.overlapBars + ' bars');
            console.log('方向 = sweep.side 对应 delivery 方向；观察窗口 ' + res.windowBars + ' 根 5m（1h）');
            console.log('');
            console.log('=== 分组（n / Protected MSS / StrongLeg / HIGH / MFE1h% / MAE1h%） ===');
            console.log(pad('Group', 22) + pad('n', 7) + pad('protMSS', 9) +
                pad('StrongLeg', 11) + pad('HIGH', 8) + pad('MFE1h%', 9) + pad('MAE1h%', 9));
            res.order.forEach(function (k) {
                var x = g[k];
                console.log(pad(k, 22) + pad(x.n, 7) +
                    pad(pct(x.protectedMss / x.n), 9) + pad(pct(x.strongLeg / x.n), 11) +
                    pad(pct(x.high / x.n), 8) +
                    pad(x.mfeCnt > 0 ? (x.mfeSum / x.mfeCnt).toFixed(2) : '-', 9) +
                    pad(x.mfeCnt > 0 ? (x.maeSum / x.mfeCnt).toFixed(2) : '-', 9));
            });
            console.log('');
            console.log('解读：');
            console.log('  - SWING_ONLY.HIGH ≈ SIGNIFICANT_ONLY.HIGH → 普通 swing 有独立信息价值，不删');
            console.log('  - SWING_ONLY.HIGH 明显低、SWING_OVERLAP.HIGH 明显高 → swing 搭便车，删除/降级有据');
            console.log('  - 同时看 Protected MSS / StrongLeg / MFE —— 不只依赖 HIGH formation（HIGH 依赖当前定义）');
            console.log('  - 纯诊断：生产判定与通知零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('INCREMENTAL AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
