/**
 * Phase 11L.16 — Swing Foundation Shadow Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/swingFoundationAudit.js BTCUSDT 90
 *
 * 母样本 = 全部 SWING 类 LIQUIDITY_SWEEP（非 HIGH 出发，沿用 sweep-centric 框架）。
 * 对每个被扫的 2-2 pivot，用 sweep 时点已知信息判定 5 个透明维度（不合成总分）：
 *   mssReference / protectedSwing / displacementLeg / dealingRange / excursion
 * 输出：
 *   A. 每维度 true vs false 的后续 delivery 指标（MSS / protectedMSS / StrongLeg / HIGH / MFE / MAE）
 *      → 哪个维度有真实区分力
 *   B. 维度命中数分布 0..5 → forward 曲线 → 是否单调（LOCAL/INTERNAL vs STRUCTURAL 的差距）
 *
 * 决策框架（用户）：STRUCTURAL（StrongLeg ~55% / HIGH ~16%）显著强于 LOCAL/INTERNAL（~35% / ~7%）
 *   → 有证据才正式收紧 Pivot→Swing 层；否则维持现状。
 * 纯诊断，生产 detector 零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var swingFoundationAudit = require('../stats/swingFoundationAudit');

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
            var res = swingFoundationAudit.auditSwingFoundation({
                sweepEvents: result.sweepEvents || [],
                swings: result.swings || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                alerts: alerts,
                candles: candles,
                htfCandles: { '1h': data['1h'], '4h': data['4h'] }
            });

            function printRow(label, g) {
                var mss = g.n > 0 ? pct(g.mss / g.n) : '-';
                var prot = g.n > 0 ? pct(g.protectedMss / g.n) : '-';
                var sl = g.n > 0 ? pct(g.strongLeg / g.n) : '-';
                var high = g.n > 0 ? pct(g.high / g.n) : '-';
                var mfe = g.mfeCnt > 0 ? (g.mfeSum / g.mfeCnt).toFixed(2) : '-';
                var mae = g.mfeCnt > 0 ? (g.maeSum / g.mfeCnt).toFixed(2) : '-';
                console.log(pad(label, 20) + pad(g.n, 6) + pad(mss, 9) + pad(prot, 10) + pad(sl, 10) + pad(high, 9) + pad(mfe, 8) + pad(mae, 8));
            }

            console.log('');
            console.log('SWING FOUNDATION AUDIT (Phase 11L.16, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('母样本 = SWING 类 sweep ' + res.nTotal + ' 笔（unresolved ' + res.unresolved + '）；窗口 1h；' +
                'excursionAtrMin=' + res.excursionAtrMin + ' htfTolerance=' + res.htfTolerance);
            console.log('维度判定窗口 = pivot 确认 → sweep 发生（sweep 时点已知，无 future leakage）');
            console.log('');
            console.log('=== A. 每维度 true vs false（n / MSS / protMSS / StrongLeg / HIGH / MFE / MAE） ===');
            console.log(pad('Dimension', 20) + pad('n', 6) + pad('MSS', 9) + pad('protMSS', 10) + pad('StrongLeg', 10) + pad('HIGH', 9) + pad('MFE', 8) + pad('MAE', 8));
            res.dims.forEach(function (d) {
                var s = res.dimensionStats[d];
                printRow(d + '=true', s.t);
                printRow(d + '=false', s.f);
            });
            console.log('');
            console.log('=== B. 维度命中数分布（0..5 → forward，看单调性） ===');
            console.log(pad('Hits', 20) + pad('n', 6) + pad('MSS', 9) + pad('protMSS', 10) + pad('StrongLeg', 10) + pad('HIGH', 9) + pad('MFE', 8) + pad('MAE', 8));
            for (var h = 0; h <= 5; h++) {
                printRow(h + '/5 dims', res.countDist[h]);
            }
            console.log('');
            console.log('解读：');
            console.log('  - 某维度 true 的 StrongLeg/HIGH 显著强于 false → 该特征有区分力，可纳入 Swing Qualification');
            console.log('  - 命中数 0-1 vs 4-5 若单调上升 → LOCAL/INTERNAL vs STRUCTURAL 差距真实，收紧 Pivot→Swing 有据');
            console.log('  - 若全维度无差异 → 2-2 pivot 直接当 liquidity 并无大害，维持现状');
            console.log('  - 纯诊断：pivotDetector / swingLiquidity / EQL/EQH / MSS / 通知全部零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('SWING FOUNDATION AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
