/**
 * Phase 11L.10 — Liquidity Relevance Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/liquidityRelevanceAudit.js BTCUSDT 90
 *
 * 90d HIGH=575，三维度：
 *   ① Recency × Source significance 交叉表（SIGNIFICANT/SWING × recency 桶 + NONE）
 *   ② Post-sweep behavior 分布（IMMEDIATE_REJECTION / RE_CROSS / ADJACENT / DELAYED_RECLAIM / NO_SWEEP）
 * 回答：普通 SWING_LOW 的 sweep 到底有没有解释价值；sweep 后价格行为是否比 recency 更接近 Narrative。
 * 纯诊断：不改 48 bars、不改通知、不让 Sweep 参与 HIGH。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var liquidityRelevanceAudit = require('../stats/liquidityRelevanceAudit');

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
            var res = liquidityRelevanceAudit.auditRelevance(highs, candles);

            console.log('');
            console.log('LIQUIDITY RELEVANCE AUDIT (Phase 11L.10, ' + SYMBOL + ' ' + DAYS + 'd, HIGH ' + highs.length + ' 笔)');
            console.log('窗口 48；口径=通知后 availableIndex+1 起；SIGNIFICANT=EQL/EQH/PDH/PDL/SESSION，SWING=SWING_HIGH/LOW');

            // A. Recency × Source 交叉表
            console.log('');
            console.log('=== A. Recency × Source significance（n / NearHit1h / MFE1h%） ===');
            console.log(pad('Row', 26) + pad('n', 6) + pad('NearHit1h', 12) + pad('MFE1h%', 9));
            var crossOrder = res.crossOrder.slice().sort(function (a, b) {
                // NONE 最后；其余按 significance 组 + recency 桶
                if (a === 'NONE') return 1;
                if (b === 'NONE') return -1;
                return a.localeCompare(b);
            });
            crossOrder.forEach(function (row) {
                var c = res.cross[row];
                var near1h = c.nearCnt1h > 0 ? pct(c.nearHit1h / c.nearCnt1h) : '-';
                var mfe = c.mfeCnt > 0 ? (c.mfeSum / c.mfeCnt).toFixed(2) : '-';
                console.log(pad(row, 26) + pad(c.n, 6) + pad(near1h, 12) + pad(mfe, 9));
            });

            // B. Post-sweep behavior
            console.log('');
            console.log('=== B. Post-sweep behavior（n / NearHit30m / NearHit1h / MFE1h% / MAE1h%） ===');
            console.log(pad('Behavior', 20) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9));
            res.behaviorOrder.forEach(function (k) {
                var b = res.behavior[k];
                if (!b || b.n === 0) return;
                var near30 = b.nearCnt30m > 0 ? pct(b.nearHit30m / b.nearCnt30m) : '-';
                var near1h = b.nearCnt1h > 0 ? pct(b.nearHit1h / b.nearCnt1h) : '-';
                var mfe = b.mfeCnt > 0 ? (b.mfeSum / b.mfeCnt).toFixed(2) : '-';
                var mae = b.mfeCnt > 0 ? (b.maeSum / b.mfeCnt).toFixed(2) : '-';
                console.log(pad(k, 20) + pad(b.n, 6) + pad(near30, 12) + pad(near1h, 12) + pad(mfe, 9) + pad(mae, 9));
            });

            console.log('');
            console.log('解读：');
            console.log('  - IMMEDIATE_REJECTION（raid→rejection→repricing）若明显强于 RE_CROSS → post-sweep behavior 有信息价值');
            console.log('  - SWING vs SIGNIFICANT 的 NearHit 差异 → 普通 SWING_LOW 是否应与 EQL/PDL/Session 同权重');
            console.log('  - 若两类都无差异 → Liquidity Taken 维持纯 Context（ZEC/ACE 只是显示怪，无统计差异）');
            console.log('  - 纯审计：48 bars / 通知 / HIGH 判定均未改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('LIQUIDITY RELEVANCE AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
