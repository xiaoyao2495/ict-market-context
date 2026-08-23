/**
 * Phase 12.2 — ATR Directional Change Structural Swing Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/directionalChangeAudit.js BTCUSDT 90
 *
 * 对比：
 *   LEGACY   = replay 确认的全部 2-2 LOCAL_PIVOT（result.swings 数量）
 *   CANDIDATE= ATR Directional Change（0.5 / 0.75 / 1.0 / 1.5 / 2.0 ATR 五档）
 *
 * 每档输出（用户表）：n / swingsPerHour / medianBarsPerLeg / medianLegRangeAtr /
 *   alternationRate / medianConfirmDelay / replacement 分布（0/1/2-3/4+）。
 * 本轮不看 HIGH、不看交易结果、不碰 MSS/Liquidity，只比较市场结构本身。
 *
 * 纯诊断：pivotDetector / swingLiquidity / MSS / EQL / 通知全部零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var directionalChangeAudit = require('../stats/directionalChangeAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = process.env.SNAPSHOT_INTERVAL !== undefined
    ? parseInt(process.env.SNAPSHOT_INTERVAL, 10)
    : 12;
var KS = [0.5, 0.75, 1.0, 1.5, 2.0];

function fmt(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
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
            var legacyN = (result.swings || []).length;
            var stats = directionalChangeAudit.auditDc(candles5m, KS);

            console.log('');
            console.log('ATR DIRECTIONAL CHANGE STRUCTURAL SWING SHADOW (Phase 12.2, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('窗口 = ' + candles5m.length + ' bars（' + Math.round(candles5m.length / 12) + 'h）；confirmWith=close；ATR(14) 冻结于 extreme 时点');
            console.log('LEGACY（2-2 LOCAL_PIVOT）= ' + legacyN + ' 个（Phase 12.1 基线；75.1% 嵌套冗余）');
            console.log('');
            console.log(pad('k', 6) + pad('n', 8) + pad('/h', 8) + pad('medBars', 9) +
                pad('legRng/ATR', 12) + pad('alt%', 7) + pad('medDelay', 10) + pad('repMean', 9) + '  rep{0/1/2-3/4+}');
            stats.forEach(function (st) {
                var rb = st.replacementBuckets;
                console.log(
                    pad(st.k.toFixed(2), 6) +
                    pad(st.n, 8) +
                    pad(fnum(st.swingsPerHour, 1), 8) +
                    pad(st.medianBarsPerLeg === null ? '-' : String(st.medianBarsPerLeg), 9) +
                    pad(fnum(st.medianLegRangeAtr, 2), 12) +
                    pad((st.alternationRate * 100).toFixed(0) + '%', 7) +
                    pad(st.medianConfirmDelay === null ? '-' : String(st.medianConfirmDelay) + 'b', 10) +
                    pad(fnum(st.replacementMean, 2), 9) +
                    '  {' + (rb['0'] || 0) + '/' + (rb['1'] || 0) + '/' + (rb['2-3'] || 0) + '/' + (rb['4+'] || 0) + '}'
                );
            });
            console.log('');
            console.log('解读（对照用户理想形态：1 ATR ~2100 swings、median leg ~1.8 ATR、~35min/leg、alt 100%、delay ~10min）：');
            console.log('  - n 随 k 单调下降 = DC 降噪有效；1 ATR 档若接近 ~2-3k 数量级 → 结构粒度合理');
            console.log('  - medBars/leg × 5min = 结构平均时长；35min → 7 bars');
            console.log('  - medianLegRangeAtr >= 1.5 → leg 有真实价格纵深（非噪声级）');
            console.log('  - alt% 应为 100%（DC 严格交替，sanity）；rep{0/1/2-3/4+} 分布显示每个最终 Swing 吞掉多少 local extreme');
            console.log('  - medDelay 越小 → 确认越及时（实时性）');
            console.log('  - 本轮只看结构：达标后 Phase 12.3 才让 MSS 改吃 DC swings 做 shadow 对比');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('DIRECTIONAL CHANGE AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
