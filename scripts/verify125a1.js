/**
 * Phase 12.5A.1 — Live Structural Reference Consistency 端到端验证
 *
 * 用法：
 *   node scripts/verify125a1.js BTCUSDT 30 [DC|LEGACY]
 *
 * 验证（P0 fix）：DC 模式下 createLiveEngine 逐根 onBar，评估机会时
 *   classifyMssReference 必须用 dcRefPool（与 MSS 生成同一 pool）：
 *   - 断言：存在 mssQuality !== 'NO_MSS' 的机会（修复前用 legacy swings 解析 DC MSS
 *     → 全部 NO_REFERENCE → HIGH 大量漏报）
 *   - 断言：这些机会的 mssReferenceSwingId 含 ':DC:'（MSS 追溯）
 *   - 报告：opp 的 tier 分布 / mssQuality 分布（对照修复前 legacy pool 的 NO_REFERENCE）
 *
 * 纯诊断：生产判定零改动（本脚本只读验证）。
 */
var historicalLoader = require('../replay/historicalLoader');
var liveEngineMod = require('../live/liveEngine');
var thresholds = require('../config/thresholds');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '30', 10);
var MODE = process.argv[4] || 'DC'; // DC | LEGACY
var DC = MODE === 'DC';
thresholds.structure = thresholds.structure || {};
thresholds.structure.useDcStructuralSwing = DC;

function fmt(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) ...');
console.log('STRUCTURAL_SWING_MODE=' + (DC ? 'DC_ATR_1_5_CLOSE' : 'LEGACY') + '（Live 端到端）');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles = data['5m'];
        var engine = liveEngineMod.createLiveEngine({
            symbol: SYMBOL,
            exchangeInfo: data.exchangeInfo,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            fetcher: function () { return Promise.resolve([]); },
            thresholds: thresholds
        }, { snapshotInterval: 12, baseIndex: 0 });

        var opps = [];
        var chain = Promise.resolve();
        candles.forEach(function (c, i) {
            chain = chain.then(function () {
                return engine.onBar(c, i).then(function (opp) {
                    if (opp) opps.push(opp);
                });
            });
        });
        return chain.then(function () {
            var tierDist = {};
            var mssDist = {};
            var dcRef = 0;
            var nonNoMss = 0;
            opps.forEach(function (o) {
                tierDist[o.tier] = (tierDist[o.tier] || 0) + 1;
                mssDist[o.mssQuality] = (mssDist[o.mssQuality] || 0) + 1;
                if (o.mssQuality !== 'NO_MSS') nonNoMss++;
                if (o.mssReferenceSwingId && o.mssReferenceSwingId.indexOf(':DC:') !== -1) dcRef++;
            });
            console.log('');
            console.log('VERIFY 12.5A.1（' + SYMBOL + ' ' + DAYS + 'd, MODE=' + MODE + '）');
            console.log('  opportunities = ' + opps.length);
            console.log('  tier 分布     = ' + JSON.stringify(tierDist));
            console.log('  mssQuality 分布 = ' + JSON.stringify(mssDist));
            console.log('  非 NO_MSS 机会  = ' + nonNoMss + '/' + opps.length);
            console.log('  :DC: reference  = ' + dcRef);
            if (DC) {
                var ok = nonNoMss > 0;
                console.log('  结论：' + (ok
                    ? 'PASS（DC MSS 被正确解析为 quality —— P0 修复生效；修复前用 legacy pool 会全 NO_REFERENCE）'
                    : 'FAIL（全部 NO_MSS —— P0 仍在，MSS quality 解析失败）'));
            } else {
                console.log('  结论：' + (nonNoMss > 0
                    ? 'PASS（legacy 模式 mssQuality 正常，回归零变化）'
                    : 'FAIL（legacy 模式也全 NO_MSS？异常）'));
            }
        });
    })
    .catch(function (e) {
        console.error('VERIFY FAILED:', e && e.stack || e);
        process.exit(1);
    });
