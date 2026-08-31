/**
 * Phase 11L — LiveEngine 一致性验证（诊断脚本）
 * 用本地缓存的历史数据（loadAll）逐根推进 liveEngine，统计机会 tier 分布，
 * 对比回测 11D.8（BTC 90d：HIGH 420 / WATCH 899 / LOW 1410）。
 * Live 与 replay 均使用 A+C2 Canonical Displacement。
 */
var liveEngineMod = require('../live/liveEngine');
var dataSource = require('../live/dataSource');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);

var end = Date.now();
var start = end - DAYS * 24 * 3600 * 1000;

dataSource.fetchInitial(SYMBOL, DAYS).then(function (data) {
    var candles5m = (data['5m'] || []).slice();
    console.log(SYMBOL + ' 数据: ' + candles5m.length + ' 根 5m / ' + DAYS + 'd');

    // 组装 HTF 视图（与 backtest.js 一致：1h/4h → structure，1d/1w/1M → calendar）
    var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
    var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    var engine = liveEngineMod.createLiveEngine({
        symbol: SYMBOL,
        exchangeInfo: data.exchangeInfo,
        structureCandles: structureCandles,
        calendarCandles: calendarCandles,
        fetcher: dataSource.makeFetcher(calendarCandles),
        thresholds: require('../config/thresholds')
    }, { snapshotInterval: 12, baseIndex: 0 });

    var counts = { HIGH_QUALITY: 0, WATCH: 0, LOW_QUALITY: 0 };
    var hist = { delivery: {}, atrNull: 0, atrOk: 0, nearNull: 0, nearOk: 0, total: 0 };
    var highSamples = [];
    var chain = Promise.resolve();
    var t0 = Date.now();
    candles5m.forEach(function (c, idx) {
        chain = chain.then(function () {
            return engine.onBar(c, idx).then(function (opp) {
                if (opp) {
                    counts[opp.tier] = (counts[opp.tier] || 0) + 1;
                    hist.total++;
                    hist.delivery[opp.deliveryQuality] = (hist.delivery[opp.deliveryQuality] || 0) + 1;
                    if (opp.formationRangeAtr === null || opp.formationRangeAtr === undefined) hist.atrNull++; else hist.atrOk++;
                    if (opp.nearTarget === null || opp.nearTarget === undefined) hist.nearNull++; else hist.nearOk++;
                    if (opp.tier === 'HIGH_QUALITY' && highSamples.length < 5) {
                        highSamples.push(opp);
                    }
                }
            });
        });
    });
    return chain.then(function () {
        console.log('runtime ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
        console.log('LIVE tier 分布: ' + JSON.stringify(counts));
        console.log('DIAG delivery=' + JSON.stringify(hist.delivery));
        console.log('DIAG atrNull=' + hist.atrNull + ' atrOk=' + hist.atrOk + ' nearNull=' + hist.nearNull + ' nearOk=' + hist.nearOk + ' total=' + hist.total);
        console.log('（回测 11D.8 共享实现参考: HIGH 539 / WATCH 935 / LOW 2773）');
        if (counts.HIGH_QUALITY > 0) {
            var ratio = counts.HIGH_QUALITY / 539;
            console.log('HIGH 对比: ' + (ratio * 100).toFixed(0) + '% of backtest（±5% 内视为 parity）');
        }
        highSamples.forEach(function (o) {
            console.log('  HIGH 样本: ' + o.direction + ' ' + o.deliveryQuality +
                ' near ' + (o.nearDistPct !== null ? o.nearDistPct.toFixed(2) + '%' : '-') +
                ' @ ' + new Date(o.anchorTime + 8 * 3600000).toISOString().slice(0, 16));
        });
    });
}).catch(function (e) {
    console.error('验证失败:', e && e.stack || e);
    process.exit(1);
});
