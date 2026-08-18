/**
 * Phase 11L.1 — Live/Replay Semantic Parity 对账（诊断脚本）
 *
 * BTC 30d：同一批 K 线分别驱动
 *   A. Replay：runReplay → 11D.8 报告层构建 alerts（authoritative）
 *   B. Live：liveEngine 逐根推进 → 全部机会（含非 HIGH）
 * 按 opportunityId 对账：MATCH / TIER_MISMATCH / ANCHOR_MISMATCH / LIVE_ONLY / REPLAY_ONLY
 * 目标：同一 Opportunity 的 MSS/Leg/FVG/Near Draw/Tier 完全一致；HIGH 不应凭空多 25%。
 */
var replayEngine = require('../replay/replayEngine');
var dataSource = require('../live/dataSource');
var liveEngineMod = require('../live/liveEngine');
var opportunity = require('../stats/opportunity');
var displacementLeg = require('../stats/displacementLeg');
var mssReference = require('../stats/mssReference');
var alertReplay = require('../stats/alertReplay');
var thresholds = require('../config/thresholds');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '30', 10);

var end = Date.now();
var start = end - DAYS * 24 * 3600 * 1000;

function buildReplayAlerts(result, candles) {
    // 共享 authoritative leg 索引（15min 窗，与 Live 同一实现）
    var legByDispId = displacementLeg.buildWindowedLegIndex(
        result.displacementEvents || [], candles || [],
        result.mssEvents || [], result.swings || []);
    var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
        DISPLACEMENT: result.displacementEvents || [],
        MSS: result.mssEvents || []
    });
    return alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
        result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);
}

dataSource.fetchInitial(SYMBOL, DAYS).then(function (data) {
    var candles5m = (data['5m'] || []).slice();
    console.log(SYMBOL + ' ' + DAYS + 'd: ' + candles5m.length + ' 根 5m');

    var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
    var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var fetcher = dataSource.makeFetcher(calendarCandles);

    // ---- A. Replay（authoritative） ----
    return replayEngine.runReplay({
        symbol: SYMBOL,
        candles5m: candles5m,
        structureCandles: structureCandles,
        calendarCandles: calendarCandles,
        exchangeInfo: data.exchangeInfo,
        fetcher: fetcher,
        thresholds: thresholds
    }, {
        fullWarmup: true,
        recordFrom: 0,
        snapshotInterval: 12
    }).then(function (result) {
        var replayAlerts = buildReplayAlerts(result, candles5m);
        console.log('Replay alerts: ' + replayAlerts.length +
            '（HIGH ' + replayAlerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; }).length + '）');

        // ---- B. Live（逐根推进） ----
        var engine = liveEngineMod.createLiveEngine({
            symbol: SYMBOL,
            exchangeInfo: data.exchangeInfo,
            structureCandles: structureCandles,
            calendarCandles: calendarCandles,
            fetcher: fetcher,
            thresholds: thresholds
        }, { snapshotInterval: 12, baseIndex: 0 });

        var liveOpps = [];
        var chain = Promise.resolve();
        var t0 = Date.now();
        candles5m.forEach(function (c, idx) {
            chain = chain.then(function () {
                return engine.onBar(c, idx).then(function (opp) { if (opp) liveOpps.push(opp); });
            });
        });
        return chain.then(function () {
            var tail = engine.flushLeg();
            if (tail) liveOpps.push(tail);
            console.log('Live opps: ' + liveOpps.length +
                '（HIGH ' + liveOpps.filter(function (o) { return o.tier === 'HIGH_QUALITY'; }).length + '）' +
                ' runtime ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

            // ---- 对账 ----
            var replayMap = {};
            replayAlerts.forEach(function (a) { replayMap[a.id] = a; });
            var liveMap = {};
            liveOpps.forEach(function (o) { liveMap[o.id] = o; });

            var stats = { MATCH: 0, TIER_MISMATCH: 0, ANCHOR_MISMATCH: 0, LIVE_ONLY: 0, REPLAY_ONLY: 0, total: 0 };
            var liveOnlyDetails = [];
            var mismatchDetails = [];
            var ids = Object.keys(replayMap).concat(Object.keys(liveMap)).filter(function (v, i, a) { return a.indexOf(v) === i; });
            ids.forEach(function (id) {
                var r = replayMap[id];
                var l = liveMap[id];
                stats.total++;
                if (!r) {
                    stats.LIVE_ONLY++;
                    if (liveOnlyDetails.length < 20) liveOnlyDetails.push(l);
                    return;
                }
                if (!l) {
                    stats.REPLAY_ONLY++;
                    return;
                }
                if (r.tier !== l.tier) {
                    stats.TIER_MISMATCH++;
                    if (mismatchDetails.length < 10) mismatchDetails.push({ id: id, replayTier: r.tier, liveTier: l.tier, mss: [r.mssQuality, l.mssQuality], leg: [r.legQuality, l.legQuality] });
                    return;
                }
                if (r.anchorIndex !== l.anchorIndex) {
                    stats.ANCHOR_MISMATCH++;
                    return;
                }
                stats.MATCH++;
            });

            console.log('');
            console.log('PARITY 对账（' + SYMBOL + ' ' + DAYS + 'd）');
            console.log('  ' + JSON.stringify(stats));
            var highR = replayAlerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; }).length;
            var highL = liveOpps.filter(function (o) { return o.tier === 'HIGH_QUALITY'; }).length;
            console.log('  HIGH: Replay ' + highR + ' vs Live ' + highL + '（' + (highR > 0 ? (highL / highR * 100).toFixed(0) + '%' : '-') + '）');

            console.log('');
            console.log('  前 20 LIVE_ONLY（是否为 Leg grouping 造成？）');
            liveOnlyDetails.forEach(function (o, k) {
                console.log('  ' + pad(k + 1, 3) + ' ' + o.id.slice(0, 46) + ' ' + pad(o.tier.replace('_QUALITY', ''), 5) +
                    ' ' + pad(o.direction, 7) + ' @' + o.anchorIndex + ' ' + o.mssQuality.replace('_SWING', '') + '|' + o.legQuality +
                    (o.nearDistPct !== null ? ' near ' + o.nearDistPct.toFixed(2) + '%' : ''));
            });
            if (mismatchDetails.length > 0) {
                console.log('');
                console.log('  TIER_MISMATCH 前 10（r=Replay, l=Live）');
                mismatchDetails.forEach(function (m) {
                    console.log('  ' + m.id.slice(0, 46) + ' r:' + m.replayTier.replace('_QUALITY', '') + ' l:' + m.liveTier.replace('_QUALITY', '') +
                        ' mss[' + m.mss[0].replace('_SWING', '') + '|' + m.mss[1].replace('_SWING', '') + '] leg[' + m.leg[0] + '|' + m.leg[1] + ']');
                });
            }
        });
    });
}).catch(function (e) {
    console.error('parity 失败:', e && e.stack || e);
    process.exit(1);
});

function pad(s, n) {
    s = String(s);
    while (s.length < n) s = ' ' + s;
    return s;
}
