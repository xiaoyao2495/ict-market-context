/**
 * Phase 11L.7 — ICT Trigger Price Shadow Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/triggerPriceAudit.js BTCUSDT 90
 *
 * 单变量：母样本 = 与 11D.8/11L.4 完全一致的 HIGH_QUALITY 机会（buildTierIndex 同构），
 * 只改变"何时通知"（AVAILABLE / FVG_TOUCH / FVG_CE / OTE_62 / OTE_70_5）。
 * 零 Live 改动、零策略参数改动。
 *
 * 输出：五模型对比表 —— Trigger Rate / Median Wait / NearHit30m / NearHit1h /
 *       MFE-MAE / NoTrigger->NearHit / Effective Capture（= TriggerRate × NearHit1h）。
 */
var historicalLoader = require('../replay/historicalLoader');
var continuityChecker = require('../replay/continuityChecker');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var opportunityQuality = require('../stats/opportunityQuality');
var triggerPriceAudit = require('../stats/triggerPriceAudit');

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
function num(x, d) {
    if (x === null || x === undefined) return '-';
    return x.toFixed(d === undefined ? 2 : d);
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd, ' + fmt(startTime) + ' -> ' + fmt(endTime) + ') ...');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        console.log('5m: ' + candles5m.length + ' bars  [' + candles5m[0].source + ']  tickSize ' + data.exchangeInfo.tickSize);
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

            // 与 reportAlertReplay 完全同构的 HIGH 母样本构建
            var candles = candles5m;
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles || [],
                result.mssEvents || [], result.swings || []);
            var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
                DISPLACEMENT: result.displacementEvents || [],
                MSS: result.mssEvents || []
            });
            var items = opportunityQuality.buildTierIndex(opps, result.fvgs || [], legByDispId, result.drawTrace || []);
            var highs = items.filter(function (it) { return it.tier === 'HIGH_QUALITY' && it.hasLeg; });
            console.log('HIGH 母样本: ' + highs.length + ' 笔（' + fmt(candles[items[0].anchorIndex].closeTime) + ' -> ' + fmt(candles[items[items.length - 1].anchorIndex].closeTime) + '）');
            console.log('等待期限: ' + triggerPriceAudit.HORIZON_BARS + ' 根 5m（' + (triggerPriceAudit.HORIZON_BARS * 5) + ' 分钟）');

            // 五模型触发模拟 + 质量评估
            var results = triggerPriceAudit.simulateAll(items, result.fvgs || [], legByDispId, candles);
            var a = triggerPriceAudit.assess(results, candles);

            // 对比表
            console.log('');
            console.log('TRIGGER PRICE SHADOW AUDIT (Phase 11L.7, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log(pad('Trigger', 12) + pad('TriggerRate', 12) + pad('MedianWait', 11) +
                pad('NearHit30m', 11) + pad('NearHit1h', 11) + pad('MFE1h/MAE1h', 13) +
                pad('NoTrg->Hit', 11) + pad('EffCapture', 11));
            console.log(pad('', 12) + pad('(n)', 12) + pad('(min)', 11) +
                pad('%', 11) + pad('%', 11) + pad('%', 13) + pad('n', 11) + pad('%', 11));
            triggerPriceAudit.MODELS.forEach(function (m) {
                var x = a[m.key];
                console.log(pad(m.key, 12) +
                    pad(pct(x.triggerRate) + ' (' + x.triggered + '/' + x.n + ')', 12) +
                    pad(num(x.medianWaitMin, 0), 11) +
                    pad(pct(x.nearHit30m), 11) +
                    pad(pct(x.nearHit1h), 11) +
                    pad(num(x.mfe1h, 2) + '/' + num(x.mae1h, 2), 13) +
                    pad(x.noTriggerButNearHit, 11) +
                    pad(pct(x.effectiveCapture), 11));
            });
            // 触发分布：15m/30m/1h/4h 内已触发的比例（"等这个位置会损失多少机会"）
            console.log('  触发分布（Trigger Rate 随等待窗口累计）:');
            console.log(pad('', 12) + pad('@15m', 9) + pad('@30m', 9) + pad('@1h', 9) + pad('@4h', 9));
            triggerPriceAudit.MODELS.forEach(function (m) {
                var x = a[m.key];
                console.log(pad(m.key, 12) +
                    pad(pct(x.trigRate15m), 9) + pad(pct(x.trigRate30m), 9) +
                    pad(pct(x.trigRate1h), 9) + pad(pct(x.trigRate4h), 9));
            });
            console.log('  不可评估（缺 FVG/leg 摆动区）: ' +
                triggerPriceAudit.MODELS.map(function (m) { return m.key + '=' + a[m.key].unavailable; }).join(' '));
            console.log('  (BASELINE = availableAt 立即通知，即现行为；EffCapture = TriggerRate × NearHit1h)');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('TRIGGER PRICE AUDIT FAILED:', error);
        process.exit(1);
    });
