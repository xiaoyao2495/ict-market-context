/**
 * Phase 11L.14 — EXTERNAL_SWING Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/externalSwingAudit.js BTCUSDT 90
 *
 * 透明规则把普通 5m SWING 拆成 INTERNAL / EXTERNAL（age >= 24 bars 或接近 1h/4h 极值），
 * 五组审计（共现判定复用 11L.13）：
 *   INTERNAL_SWING_ONLY / EXTERNAL_SWING_ONLY / SIGNIFICANT_ONLY / OVERLAP
 * 指标：Protected MSS / STRONG·EXPLOSIVE Leg / HIGH formation / MFE·MAE。
 * 回答：Swing 里有没有一小部分"真正 meaningful"能接近 Significant？
 * 纯诊断，不改生产。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var externalSwingAudit = require('../stats/externalSwingAudit');

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
            var res = externalSwingAudit.auditExternalSwing({
                sweepEvents: result.sweepEvents || [],
                swings: result.swings || [],
                htfCandles: { '1h': data['1h'] || [], '4h': data['4h'] || [] },
                mssEvents: result.mssEvents || [],
                swingsForMss: result.swings || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                alerts: alerts,
                candles: candles
            });
            var g = res.groups;

            console.log('');
            console.log('EXTERNAL_SWING SHADOW (Phase 11L.14, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('EXTERNAL 规则：age >= ' + res.ageMinBars + ' bars（形成后长期未被取）OR 接近 1h/4h 极值 ±' + (res.htfTolerance * 100) + '%');
            console.log('共现判定：价格容差 ' + (res.priceTolerance * 100) + '% + 时间窗口 ' + res.overlapBars + ' bars');
            console.log('');
            console.log('=== 分组（n / Protected MSS / StrongLeg / HIGH / MFE1h% / MAE1h%） ===');
            console.log(pad('Group', 24) + pad('n', 7) + pad('protMSS', 9) +
                pad('StrongLeg', 11) + pad('HIGH', 8) + pad('MFE1h%', 9) + pad('MAE1h%', 9));
            res.order.forEach(function (k) {
                var x = g[k];
                console.log(pad(k, 24) + pad(x.n, 7) +
                    pad(pct(x.protectedMss / x.n), 9) + pad(pct(x.strongLeg / x.n), 11) +
                    pad(pct(x.high / x.n), 8) +
                    pad(x.mfeCnt > 0 ? (x.mfeSum / x.mfeCnt).toFixed(2) : '-', 9) +
                    pad(x.mfeCnt > 0 ? (x.maeSum / x.mfeCnt).toFixed(2) : '-', 9));
            });
            console.log('');
            console.log('解读：');
            console.log('  - INTERNAL ~7% / EXTERNAL ~15% / SIGNIFICANT ~17% → internal 回归 Structure，external 升级 Liquidity Object');
            console.log('  - EXTERNAL 仍 9-10% → Swing 整体弱，正式降级');
            console.log('  - OVERLAP = swing 与 significant 共现（11L.13 已证共现会抬升）');
            console.log('  - 纯诊断：生产判定与通知零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('EXTERNAL SWING AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
