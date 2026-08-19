/**
 * Phase 11L.8 第二刀 — MSS↔Leg Shadow Association Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/mssShadowAudit.js BTCUSDT 90
 *
 * 旁路候选集：现有 authoritative HIGH vs 允许 related MSS 位于 leg 前方（leg.start 前 1~6 根）的
 * shadow opportunity。只改 MSS↔Leg association，其他（Liquidity/DisplacementLeg/FVG/Near Draw/tier 规则）
 * 全部冻结。不改生产 HIGH。
 *
 * 输出三组对比（30m/1h NearHit / MFE / MAE + 样本量）：
 *   INSIDE_LEG / BEFORE_LEG / NO_RELATED_MSS
 * 决策语义：BEFORE ≈ INSIDE 甚至更好 → 有理由解除 same-candle 限制；
 *           BEFORE 明显更差 → 当前严格语义过滤了噪声，不该放宽。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var mssShadowAudit = require('../stats/mssShadowAudit');

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
            var items = mssShadowAudit.buildShadowItems(opps, result.fvgs || [], legByDispId,
                result.mssEvents || [], result.swings || [], result.drawTrace || [], candles || [], {});
            var groups = mssShadowAudit.assessShadow(items, candles);

            // 现有 authoritative HIGH（对照基线：same-candle 关联）
            var existingHigh = items.filter(function (it) { return it.group === 'INSIDE_LEG' && it.tier === 'HIGH_QUALITY'; }).length;

            console.log('');
            console.log('MSS↔LEG SHADOW ASSOCIATION AUDIT (Phase 11L.8, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('beforeLookbackBars: ' + mssShadowAudit.DEFAULT_BEFORE_BARS +
                '（leg.start 前 1~' + mssShadowAudit.DEFAULT_BEFORE_BARS + ' 根 = 最多 30 分钟）');
            console.log('现有 authoritative HIGH（INSIDE_LEG + tier=HIGH）: ' + existingHigh);
            console.log('');
            console.log(pad('Group', 14) + pad('all', 6) + pad('HIGH', 6) +
                pad('HIGH NearHit30m', 16) + pad('HIGH NearHit1h', 15) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9) + pad('ALL NearHit1h', 14));
            ['INSIDE_LEG', 'BEFORE_LEG', 'NO_RELATED_MSS'].forEach(function (g) {
                var x = groups[g];
                if (!x) return;
                var near30 = x.highNearCnt30m > 0 ? pct(x.highNearHit30m / x.highNearCnt30m) : '-';
                var near1h = x.highNearCnt1h > 0 ? pct(x.highNearHit1h / x.highNearCnt1h) : '-';
                var mfe = x.highMfeCnt > 0 ? (x.highMfeSum / x.highMfeCnt).toFixed(2) : '-';
                var mae = x.highMfeCnt > 0 ? (x.highMaeSum / x.highMfeCnt).toFixed(2) : '-';
                var allNear = x.allNearCnt1h > 0 ? pct(x.allNearHit1h / x.allNearCnt1h) : '-';
                console.log(pad(g, 14) + pad(x.all, 6) + pad(x.high, 6) +
                    pad(near30, 16) + pad(near1h, 15) + pad(mfe, 9) + pad(mae, 9) + pad(allNear, 14));
            });
            console.log('');
            console.log('解读：');
            console.log('  - BEFORE_LEG.HIGH = shadow 放宽后新增的 HIGH 数量（INSIDE_LEG.HIGH 为现有基线）');
            console.log('  - 若 BEFORE 的 HIGH NearHit1h ≈ INSIDE 甚至更高 → 有理由解除 same-candle 限制');
            console.log('  - 若 BEFORE 明显更低 → 当前严格语义过滤了噪声，不该放宽');
            console.log('  - NO_RELATED_MSS 永远无缘 HIGH（NO_MSS → LOW），其 ALL NearHit1h 是对照基线');
            console.log('  - 本审计不修改任何生产判定（Liquidity/DisplacementLeg/FVG/Near Draw/tier 规则冻结）');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('MSS SHADOW AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
