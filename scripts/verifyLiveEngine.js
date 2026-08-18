/**
 * Phase 11L — LiveEngine 一致性验证（诊断脚本）
 * 用本地缓存的历史数据（loadAll）逐根推进 liveEngine，统计机会 tier 分布，
 * 对比回测 11D.8（BTC 90d：HIGH 420 / WATCH 899 / LOW 1410）。
 * 注意：live 引擎 leg 语义 = buildDisplacementLegs（连续同向相邻 index、≤3 根），
 * 回测机会 = buildOpportunities（时间窗 15min）——边界可能略不同，目标数量级一致。
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
    var hist = { mss: {}, leg: {}, atrNull: 0, atrOk: 0, nearNull: 0, nearOk: 0, total: 0 };
    var highSamples = [];
    var chain = Promise.resolve();
    var t0 = Date.now();
    candles5m.forEach(function (c, idx) {
        chain = chain.then(function () {
            return engine.onBar(c, idx).then(function (opp) {
                if (opp) {
                    counts[opp.tier] = (counts[opp.tier] || 0) + 1;
                    hist.total++;
                    hist.mss[opp.mssQuality] = (hist.mss[opp.mssQuality] || 0) + 1;
                    hist.leg[opp.legQuality] = (hist.leg[opp.legQuality] || 0) + 1;
                    if (opp.legRangeAtr === null || opp.legRangeAtr === undefined) hist.atrNull++; else hist.atrOk++;
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
        console.log('DIAG mss=' + JSON.stringify(hist.mss) + ' leg=' + JSON.stringify(hist.leg));
        console.log('DIAG atrNull=' + hist.atrNull + ' atrOk=' + hist.atrOk + ' nearNull=' + hist.nearNull + ' nearOk=' + hist.nearOk + ' total=' + hist.total);
        console.log('（回测 11D.8 参考: HIGH 420 / WATCH 899 / LOW 1410）');
        if (counts.HIGH_QUALITY > 0) {
            var ratio = counts.HIGH_QUALITY / 420;
            console.log('HIGH 对比: ' + (ratio * 100).toFixed(0) + '% of backtest（±25% 内视为一致）');
        }
        highSamples.forEach(function (o) {
            console.log('  HIGH 样本: ' + o.direction + ' ' + o.mssQuality + '|' + o.legQuality +
                ' near ' + (o.nearDistPct !== null ? o.nearDistPct.toFixed(2) + '%' : '-') +
                ' @ ' + new Date(o.anchorTime + 8 * 3600000).toISOString().slice(0, 16));
        });
    });
}).catch(function (e) {
    console.error('验证失败:', e && e.stack || e);
    process.exit(1);
});
