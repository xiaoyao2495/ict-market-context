/**
 * Phase 11L.8 — Liquidity Provenance / MSS-Leg Relation Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/provenanceAudit.js BTCUSDT 90
 *
 * 第一刀：只解释、不改判定 —— 不修改 HIGH/WATCH/LOW、MSS、Displacement、通知时机。
 * 输出三块：
 *   1. MSS ↔ Leg relation 分层（BEFORE_LEG / INSIDE_LEG / AFTER_LEG / NONE）
 *      × HIGH n / NearHit30m / NearHit1h / MFE / MAE
 *      —— 看"当前 same-candle/严格顺序到底漏了多少真正 Delivery"
 *   2. Sweep Provenance 关联率 + 候选 barsBeforeLegStart 分布（真实分布决定正式窗口 N）
 *   3. 窗口敏感性：maxLookbackBars = 6/12/24/48/96 时的关联率（不拍脑袋定 N）
 *
 * 口径与 11D.8/11L.4 一致：通知后最早 N+1 = availableIndex+1 起统计；
 * MFE/MAE 以 notificationPrice 为基准；nearHit 以 notificationNearTarget 为目标。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var liquidityProvenance = require('../stats/liquidityProvenance');

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
            // 复用 buildAlerts（内含 11L.8 的 liquidityContext + mssRelation）
            var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
                result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);
            var highs = alerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; });
            console.log('Alerts: ' + alerts.length + '，HIGH: ' + highs.length +
                '（' + fmt(candles[alerts[0].anchorIndex].closeTime) + ' -> ' + fmt(candles[alerts[alerts.length - 1].anchorIndex].closeTime) + '）');

            runMssRelationTable(highs, candles);
            runSweepProvenance(highs, alerts, result.sweepEvents || [], candles);
        });
    })
    .catch(function (error) {
        console.error('PROVENANCE AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });

/**
 * 1. MSS ↔ Leg relation 分层表
 * 统计口径与 assessAlerts 一致：post-alert 从 availableIndex+1 起；
 * MFE/MAE 以 notificationPrice 为基准；nearHit 以 notificationNearTarget 为目标。
 */
function runMssRelationTable(highs, candles) {
    var RELS = ['BEFORE_LEG', 'INSIDE_LEG', 'AFTER_LEG', 'NONE'];
    var agg = {};
    RELS.forEach(function (r) {
        agg[r] = { n: 0, nearHit30m: 0, nearCnt30m: 0, nearHit1h: 0, nearCnt1h: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 };
    });
    highs.forEach(function (al) {
        var rel = al.mssRelation || 'NONE';
        var a = agg[rel];
        if (!a) a = agg.NONE;
        var availIdx = al.availableIndex !== undefined ? al.availableIndex : al.anchorIndex;
        var start = availIdx !== null && availIdx !== undefined ? availIdx + 1 : null;
        if (start === null || start >= candles.length) return;
        var basePrice = al.notificationPrice !== undefined && al.notificationPrice !== null ? al.notificationPrice : al.anchorPrice;
        var hitTarget = al.notificationNearTarget !== undefined && al.notificationNearTarget !== null ? al.notificationNearTarget : al.nearTarget;
        var bullish = al.direction === 'BULLISH';
        var windows = [{ key: '30m', bars: 6 }, { key: '1h', bars: 12 }];
        var mfe = 0, mae = 0;
        var nearHit30m = false, nearHit1h = false;
        windows.forEach(function (w) {
            var lastJ = Math.min(start + w.bars - 1, candles.length - 1);
            var hit = false;
            for (var j = start; j <= lastJ; j++) {
                var c = candles[j];
                if (!c) break;
                if (bullish) {
                    if (c.high - basePrice > mfe) mfe = c.high - basePrice;
                    if (basePrice - c.low > mae) mae = basePrice - c.low;
                    if (hitTarget !== null && hitTarget !== undefined && c.high >= hitTarget) hit = true;
                } else {
                    if (basePrice - c.low > mfe) mfe = basePrice - c.low;
                    if (c.high - basePrice > mae) mae = basePrice - c.high;
                    if (hitTarget !== null && hitTarget !== undefined && c.low <= hitTarget) hit = true;
                }
            }
            if (w.key === '30m') nearHit30m = hit;
            else nearHit1h = hit;
        });
        a.n++;
        if (hitTarget !== null && hitTarget !== undefined) {
            a.nearCnt30m++;
            a.nearCnt1h++;
            if (nearHit30m) a.nearHit30m++;
            if (nearHit1h) a.nearHit1h++;
        }
        a.mfeSum += mfe / basePrice * 100;
        a.maeSum += mae / basePrice * 100;
        a.mfeCnt++;
    });

    console.log('');
    console.log('=== 1. MSS ↔ Leg Relation（HIGH 母样本，' + highs.length + ' 笔） ===');
    console.log(pad('Relation', 12) + pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) +
        pad('MFE1h%', 9) + pad('MAE1h%', 9));
    RELS.forEach(function (r) {
        var a = agg[r];
        console.log(pad(r, 12) + pad(a.n, 6) +
            pad(pct(a.nearCnt30m > 0 ? a.nearHit30m / a.nearCnt30m : null), 12) +
            pad(pct(a.nearCnt1h > 0 ? a.nearHit1h / a.nearCnt1h : null), 12) +
            pad(a.mfeCnt > 0 ? (a.mfeSum / a.mfeCnt).toFixed(2) : '-', 9) +
            pad(a.mfeCnt > 0 ? (a.maeSum / a.mfeCnt).toFixed(2) : '-', 9));
    });
    console.log('  (BEFORE_LEG = MSS 在位移腿前；INSIDE_LEG = 同一根/腿内完成 structure break + displacement；' +
        'AFTER_LEG = MSS 在腿后（理论罕见）；NONE = 无 MSS 链)');
}

/**
 * 2. Sweep Provenance 关联率 + 候选 barsBeforeLegStart 分布
 * 3. 窗口敏感性（maxLookbackBars = 6/12/24/48/96 → 关联率）→ 正式窗口决策依据
 */
function runSweepProvenance(highs, alerts, sweepEvents, candles) {
    // 2a. 关联率（生产窗口 48）
    var linked = 0;
    var relDist = { BEFORE_LEG: 0, INSIDE_LEG: 0, AFTER_LEG: 0 };
    var sourceTypeDist = {};
    var barDist = {}; // immediateSweep barsBeforeLegStart 分布（每 3 bars 一桶）
    var barValues = [];
    highs.forEach(function (al) {
        var ctx = al.liquidityContext;
        if (!ctx || !ctx.immediateSweep) return;
        linked++;
        relDist[ctx.immediateSweep.relation] = (relDist[ctx.immediateSweep.relation] || 0) + 1;
        var st = ctx.immediateSweep.sourceType || 'UNKNOWN';
        sourceTypeDist[st] = (sourceTypeDist[st] || 0) + 1;
        if (typeof ctx.immediateSweep.barsBeforeLegStart === 'number') {
            var b = Math.floor(ctx.immediateSweep.barsBeforeLegStart / 3) * 3;
            var key = b >= 0 ? (b + '-' + (b + 2)) : 'leg内';
            barDist[key] = (barDist[key] || 0) + 1;
            barValues.push(ctx.immediateSweep.barsBeforeLegStart);
        }
    });
    // 候选池：全 HIGH 的所有 allCandidates（看窗口内候选真实分布）
    var candDist = {};
    var candValues = [];
    highs.forEach(function (al) {
        var ctx = al.liquidityContext;
        if (!ctx) return;
        ctx.allCandidates.forEach(function (s) {
            if (typeof s.barsBeforeLegStart === 'number') {
                candValues.push(s.barsBeforeLegStart);
                var key = s.barsBeforeLegStart >= 0 ? 'B' + s.barsBeforeLegStart : 'LEG内';
                candDist[key] = (candDist[key] || 0) + 1;
            }
        });
    });

    console.log('');
    console.log('=== 2. Sweep Provenance（HIGH ' + highs.length + ' 笔，生产窗口 ' +
        liquidityProvenance.DEFAULT_MAX_LOOKBACK_BARS + '） ===');
    console.log('关联率: ' + linked + '/' + highs.length + ' (' + pct(linked / highs.length) + ')  NONE: ' + (highs.length - linked));
    console.log('immediate relation: ' + JSON.stringify(relDist));
    console.log('sourceType: ' + JSON.stringify(sourceTypeDist));
    if (candValues.length > 0) {
        candValues.sort(function (a, b) { return a - b; });
        var med = candValues[Math.floor(candValues.length / 2)];
        console.log('候选 barsBeforeLegStart: min=' + candValues[0] + ' median=' + med + ' max=' + candValues[candValues.length - 1] + '（n=' + candValues.length + '）');
    }
    console.log('候选分布（B<0 = 腿内）: ' + JSON.stringify(candDist));

    // 3. 窗口敏感性（48 为生产窗口；其余为敏感性参考）
    console.log('');
    console.log('=== 3. 窗口敏感性（maxLookbackBars → 关联率；★48 = production） ===');
    console.log(pad('N', 6) + pad('linked', 8) + pad('rate', 8) + pad('median bars', 12));
    [6, 12, 24, 48, 96].forEach(function (N) {
        var cnt = 0;
        var vals = [];
        highs.forEach(function (al) {
            var ctx = liquidityProvenance.associateSweeps({
                direction: al.direction,
                leg: {
                    startIndex: al.legStartIndex !== null ? al.legStartIndex : al.anchorIndex,
                    endIndex: al.anchorIndex,
                    firstConfirmedAt: null,
                    lastConfirmedAt: null
                },
                availableAt: al.availableAt !== undefined ? al.availableAt : al.anchorTime,
                sweepEvents: sweepEvents,
                maxLookbackBars: N
            });
            if (ctx && ctx.immediateSweep) {
                cnt++;
                if (typeof ctx.immediateSweep.barsBeforeLegStart === 'number') vals.push(ctx.immediateSweep.barsBeforeLegStart);
            }
        });
        var med = '-';
        if (vals.length > 0) {
            vals.sort(function (a, b) { return a - b; });
            med = String(vals[Math.floor(vals.length / 2)]);
        }
        console.log(pad((N === 48 ? '★' : '') + N, 6) + pad(cnt + '/' + highs.length, 8) + pad(pct(cnt / highs.length), 8) + pad(med, 12));
    });
    console.log('  (48 为 production explainability 窗口：~90% 关联率，避免为 99% 挂过旧 sweep)');
    console.log('');
}
