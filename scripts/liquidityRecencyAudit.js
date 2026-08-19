/**
 * Phase 11L.10 — Liquidity Recency Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/liquidityRecencyAudit.js BTCUSDT 90
 *
 * 90d HIGH=575 按 immediateSweep.barsBeforeLegStart 分桶（INSIDE_LEG / 1-3 / 4-6 / 7-12 / 13-24 / 25-48 / NONE），
 * 每桶 n / NearHit30m / NearHit1h / MFE / MAE。
 * 回答：Sweep 离 Delivery 越近，机会质量是否越高；ZEC 22-bars sweep 是显示怪还是统计也没价值。
 * 纯审计：不改 48 bars、不改通知、不让 Sweep 参与 HIGH。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var liquidityRecencyAudit = require('../stats/liquidityRecencyAudit');

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
            var res = liquidityRecencyAudit.auditLiquidityRecency(highs, candles);
            var buckets = res.buckets;

            console.log('');
            console.log('LIQUIDITY RECENCY AUDIT (Phase 11L.10, ' + SYMBOL + ' ' + DAYS + 'd, HIGH ' + highs.length + ' 笔)');
            console.log('（immediateSweep 距 leg.startIndex 的 bars；窗口 48；口径=通知后 availableIndex+1 起）');
            console.log(pad('Bucket', 14) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9));
            res.order.forEach(function (k) {
                var b = buckets[k];
                if (!b || b.n === 0) return;
                var near30 = b.nearCnt30m > 0 ? pct(b.nearHit30m / b.nearCnt30m) : '-';
                var near1h = b.nearCnt1h > 0 ? pct(b.nearHit1h / b.nearCnt1h) : '-';
                var mfe = b.mfeCnt > 0 ? (b.mfeSum / b.mfeCnt).toFixed(2) : '-';
                var mae = b.mfeCnt > 0 ? (b.maeSum / b.mfeCnt).toFixed(2) : '-';
                console.log(pad(k, 14) + pad(b.n, 6) + pad(near30, 12) + pad(near1h, 12) + pad(mfe, 9) + pad(mae, 9));
            });
            console.log('');
            console.log('解读：');
            console.log('  - 若各桶 NearHit 差不多 → Liquidity Taken 永远只是 Context（不参与 HIGH）');
            console.log('  - 若 1-6 bars 明显强、13-48 bars 接近 NONE → 有证据定义 notificationSweep，');
            console.log('    甚至未来让 Recent Sweep 成为 Opportunity Quality 维度（需用户决策，本次不改）');
            console.log('  - NONE = 48 窗口内无方向匹配 sweep（N=48 时约占 ~9.6%）');
            console.log('  - 纯审计：48 bars / 通知 / HIGH 判定均未改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('LIQUIDITY RECENCY AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
