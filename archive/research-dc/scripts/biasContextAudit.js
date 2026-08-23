/**
 * Phase 13A.1 — 当前 Bias 审计（90d）
 *
 * 用法：node scripts/biasContextAudit.js [SYMBOL] [DAYS]
 *
 * 输出：
 *   - 当前 Bias direction 分布（biasEngine 总分输出）
 *   - Bias vs nextDrawSide 命中率（整体 + 30m/1h/4h/24h 分桶）
 *   - 4 组件（liquidity/structure/location/delivery）direction 分布 + 各自 vs nextDraw 命中
 *   - conflicts 分布
 *   - confidence 分层命中（高置信是否更强）
 *
 * 纯诊断：biasEngine / 通知零改动。13A.2-5 的 Context 组合将以此 baseline 为对照。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var directionalChangeAudit = require('../stats/directionalChangeAudit');
var dcStructuralSwing = require('../structure/dcStructuralSwing');
var biasContextAudit = require('../stats/biasContextAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;

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
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
        var t0 = Date.now();
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: SNAPSHOT_INTERVAL,
            logEvery: 999999
        }).then(function (result) {
            console.log('Replay 完成 (' + Math.round((Date.now() - t0) / 1000) + 's)');

            var dcRaw = directionalChangeAudit.buildDcSwings(candles5m, 1.5, { confirmWith: 'close' });
            var dcSwings = dcRaw.map(function (raw) {
                return dcStructuralSwing.packageForMss(raw, SYMBOL, '5m', candles5m);
            });

            var res = biasContextAudit.auditCurrentBias({
                candles: candles5m,
                biasTrace: result.biasTrace || [],
                liquidityObjects: result.liquidityObjects || [],
                dcSwings: dcSwings,
                atrSeries: result.atrSeries || {},
                htf1hCandles: data['1h'] || [],
                displacementEvents: result.displacementEvents || [],
                startIndex: startIndex
            });

            console.log('');
            console.log('PHASE 13A.1 — CURRENT BIAS AUDIT (' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('label = 未来第一个被 raid 的 significant liquidity（13.1 口径，排除 legacy 2-2 swing）');
            console.log('n = ' + res.n + ' 根（bias 有值 + label 存在）');
            console.log('');

            console.log('=== 1. 当前 Bias direction 分布（biasEngine 总分输出） ===');
            console.log('  ' + JSON.stringify(res.biasDirDist));
            console.log('');

            console.log('=== 2. Bias vs nextDrawSide（BULLISH/LEAN_BULLISH→BSL / BEARISH/LEAN_BEARISH→SSL） ===');
            console.log('  整体命中率 = ' + pct(res.biasAcc) + '（n=' + res.biasN + '）');
            console.log(pad('桶', 8) + pad('n', 7) + pad('命中率', 9));
            ['30m', '1h', '4h', '24h', '>24h'].forEach(function (b) {
                var s = res.biasByBucket[b];
                if (!s) return;
                console.log(pad(b, 8) + pad(String(s.n), 7) + pad(pct(s.hit / s.n), 9));
            });
            console.log('  （对比 13.1：30m 桶 nearest 76.2% / HTF dir 66.9%——Bias 需证明自己有独立增量）');
            console.log('');

            console.log('=== 3. 组件 direction 分布 + vs nextDraw 命中 ===');
            console.log(pad('组件', 12) + pad('BULL', 7) + pad('BEAR', 7) + pad('NEUT', 7) + pad('命中率', 9) + pad('n', 7));
            ['liquidity', 'structure', 'location', 'delivery'].forEach(function (name) {
                var d = res.componentDist[name] || {};
                var a = res.componentAcc[name];
                console.log(pad(name, 12) +
                    pad(String(d.BULLISH || 0), 7) + pad(String(d.BEARISH || 0), 7) + pad(String(d.NEUTRAL || 0), 7) +
                    pad(pct(a && a.n > 0 ? a.hit / a.n : null), 9) + pad(String(a ? a.n : 0), 7));
            });
            console.log('  （组件命中率 = 组件方向与 nextDrawSide 一致的比例，有方向时）');
            console.log('');

            console.log('=== 4. conflicts 分布 ===');
            var cfKeys = Object.keys(res.conflictDist);
            if (cfKeys.length === 0) console.log('  （无 conflicts 记录）');
            cfKeys.forEach(function (k) { console.log(pad(k, 40) + res.conflictDist[k]); });
            console.log('');

            console.log('=== 5. confidence 分层命中 ===');
            console.log(pad('band', 8) + pad('n', 7) + pad('命中率', 9));
            ['lo', 'mid', 'hi'].forEach(function (b) {
                var s = res.confidenceBands[b];
                console.log(pad(b, 8) + pad(String(s.n), 7) + pad(pct(s.n > 0 ? s.hit / s.n : null), 9));
            });
            console.log('');

            console.log('解读（13A.1 验收）：');
            console.log('  - bias 整体命中率若 ≈ 50% → 当前 Bias Engine 无 draw 预测力，13A.2-5 有空间');
            console.log('  - 若 30m 桶也明显 < 13.1 的 nearest 76.2% → 静态 map 比 Bias 更接近真相');
            console.log('  - 组件命中率谁最高 → 13A.2-5 的 Context 组合应从它优先取材');
            console.log('  - 纯诊断：biasEngine / 通知零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('BIAS CONTEXT AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
