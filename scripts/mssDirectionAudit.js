/**
 * Phase 11L.9 — Production MSS Direction Integrity Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/mssDirectionAudit.js BTCUSDT 90
 *
 * 对 575 条 HIGH 逐笔检查 leg.direction vs leg.mssId 对应 MSS 的 direction：
 *   MATCH / OPPOSITE / MISSING / NO_MSS + OPPOSITE·MISSING 明细。
 * 目的：确认 11L.8-S2 观察到的"production 575 vs shadow 570"差异是否来自
 * 生产 leg.mssId 挂了方向不匹配的同根 MSS。纯诊断，不改生产。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var mssDirectionAudit = require('../stats/mssDirectionAudit');

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
            var mssById = {};
            (result.mssEvents || []).forEach(function (m) { mssById[m.id] = m; });
            var audit = mssDirectionAudit.auditMssDirection(highs, legByDispId, mssById);

            console.log('');
            console.log('MSS DIRECTION INTEGRITY AUDIT (Phase 11L.9, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('HIGH 总数: ' + audit.total);
            console.log(pad('MATCH', 12) + pad(audit.MATCH, 8));
            console.log(pad('OPPOSITE', 12) + pad(audit.OPPOSITE, 8));
            console.log(pad('MISSING', 12) + pad(audit.MISSING, 8));
            console.log(pad('NO_MSS', 12) + pad(audit.NO_MSS, 8));
            console.log('');
            console.log('--- OPPOSITE / MISSING 明细（按 anchorIndex） ---');
            audit.details.forEach(function (d) {
                var line = pad(d.status, 9) + ' ' + pad(String(d.id).slice(0, 44), 44) +
                    ' leg=' + pad(d.legDirection, 8) + (d.mssDirection ? ' mss=' + pad(d.mssDirection, 8) : '') +
                    ' @' + d.anchorIndex + ' (' + fmt(d.anchorTime) + ')';
                if (d.mssCandleIndex !== undefined) {
                    line += ' mss@' + d.mssCandleIndex + ' leg[' + d.legStartIndex + '..' + d.legEndIndex + ']';
                }
                console.log(line);
            });
            if (audit.details.length === 0) {
                console.log('（无）');
            }
            console.log('');
            console.log('解读：');
            console.log('  - MATCH 应为绝大多数；OPPOSITE = 生产 leg.mssId 挂了方向不匹配的同根 MSS（挂账 §8.6 疑点）');
            console.log('  - 若 OPPOSITE 属实（如 5 笔）→ 再决定是否修（改 displacementDetector same-candle 校验方向）');
            console.log('  - 若 OPPOSITE = 0 → 570 vs 575 差异来自其他原因（如 tail leg / shadow 选择差异），关闭挂账');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('MSS DIRECTION AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
