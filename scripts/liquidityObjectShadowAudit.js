/**
 * Phase 11L.11 — Liquidity Object Reclassification Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/liquidityObjectShadowAudit.js BTCUSDT 90
 *
 * 同一批 90d HIGH：
 *   生产模型（含普通 5m SWING） vs shadow 模型（排除 SWING_HIGH/SWING_LOW，仅保留
 *   EQL/EQH/PDH/PDL/Session 等 external liquidity）
 * 比较：
 *   ① Liquidity Taken 覆盖率（~90% → 掉到多少）
 *   ② SIGNIFICANT / SWING_ONLY / NONE 三组的 NearHit30m/1h、MFE/MAE
 *   ③ SIGNIFICANT 示例通知行（肉眼 ICT Narrative 检查）
 * 历史诊断：使用 authoritative structural-primitive exclusion projection。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var liquidityObjectShadowAudit = require('../stats/liquidityObjectShadowAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = process.env.SNAPSHOT_INTERVAL !== undefined
    ? parseInt(process.env.SNAPSHOT_INTERVAL, 10)
    : 12;

function fmt(ms) {
    var d = new Date(ms + 8 * 3600000);
    return d.toISOString().slice(0, 16).replace('T', ' ');
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
            var res = liquidityObjectShadowAudit.auditObjectShadow(highs, result.sweepEvents || [], candles, {});
            var g = res.groups;

            console.log('');
            console.log('LIQUIDITY OBJECT RECLASSIFICATION SHADOW (Phase 11L.11, ' + SYMBOL + ' ' + DAYS + 'd, HIGH ' + res.total + ' 笔)');
            console.log('shadow 模型排除 SWING_HIGH/SWING_LOW（仅 EQL/EQH/PDH/PDL/Session 等 external liquidity）');
            console.log('');
            console.log('=== ① 覆盖率 ===');
            console.log('  生产（含 SWING）: ' + pct(res.prodCoverage));
            console.log('  shadow（仅 SIGNIFICANT）: ' + pct(res.shadowCoverage));
            console.log('  掉幅: ' + pct(res.prodCoverage - res.shadowCoverage));
            console.log('');
            console.log('=== ② 分组（n / NearHit30m / NearHit1h / MFE1h% / MAE1h%） ===');
            console.log(pad('Group', 14) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9));
            ['SIGNIFICANT', 'SWING_ONLY', 'NONE'].forEach(function (k) {
                var x = g[k];
                if (!x) return;
                var near30 = x.nearCnt30m > 0 ? pct(x.nearHit30m / x.nearCnt30m) : '-';
                var near1h = x.nearCnt1h > 0 ? pct(x.nearHit1h / x.nearCnt1h) : '-';
                var mfe = x.mfeCnt > 0 ? (x.mfeSum / x.mfeCnt).toFixed(2) : '-';
                var mae = x.mfeCnt > 0 ? (x.maeSum / x.mfeCnt).toFixed(2) : '-';
                console.log(pad(k, 14) + pad(x.n, 6) + pad(near30, 12) + pad(near1h, 12) + pad(mfe, 9) + pad(mae, 9));
            });
            console.log('');
            console.log('=== ③ SIGNIFICANT 示例（前 12 条，肉眼 ICT Narrative 检查） ===');
            console.log(pad('方向', 8) + pad('side', 6) + pad('type', 14) + pad('price', 12) + pad('relation', 12) +
                pad('bars前', 8) + pad('anchorTime(UTC+8)', 18));
            res.significantSamples.forEach(function (s) {
                console.log(pad(s.direction, 8) + pad(s.side, 6) + pad(String(s.sourceType), 14) +
                    pad(String(s.sourcePrice), 12) + pad(s.relation, 12) + pad(String(s.barsBeforeLegStart), 8) +
                    pad(fmt(s.anchorTime), 18));
            });
            console.log('');
            console.log('解读：');
            console.log('  - SIGNIFICANT NearHit 明显优于 SWING_ONLY（如 72%+ vs 65%）→ 有理由正式删普通 5m Swing');
            console.log('  - SIGNIFICANT 样本只有几十笔且 NearHit 与 Swing 差不多 → 需定义 EXTERNAL_SWING / LIQUIDITY_BEARING_SWING');
            console.log('  - 覆盖率掉幅 = 普通 Swing 在解释层的占比（当前 ~90% 里绝大部分是 SWING）');
            console.log('  - 历史诊断：使用 authoritative structural-primitive exclusion projection');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('OBJECT SHADOW AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
