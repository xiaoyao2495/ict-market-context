/**
 * Phase 13A.2 — HTF DC Structure 独立审计（90d）
 *
 * 用法：node scripts/htfDcStructureAudit.js [SYMBOL] [DAYS]
 *
 * 输出：
 *   - 4H / 1D DC Structure state 分布（BULLISH/BEARISH/TRANSITION/NEUTRAL）
 *   - 核心表：HTF Context × n × PDH First % × PDL First % × DrawDirHit%（流动性首次触碰方向命中）
 *     （DrawDirHit = 该 context 方向 vs 实际哪侧 significant liquidity 先被 raid 的方向命中率；
 *      这是 HTF Structure feature audit，**不是 Bias 验证、不作下一代 Bias Ground Truth**）
 *     （1D Bull/Bear、4H Bull/Bear、4 种 alignment 组合）
 *   - horizon 分桶（<=4h / <=8h / <=12h / <=24h）
 *
 *  ⚠️ 隔离纪律：本文件只证明"HTF DC Structure 对流动性首次触碰方向（哪侧 significant
 *     liquidity 先被 raid）有统计信息"。这属 HTF Structure feature audit，**不是 Bias 验证、
 *     不作下一代 Bias Ground Truth**。Bias = 决定等待哪侧 raid + raid 后找哪侧 delivery，
 *     不是预测下一边流动性谁先被碰——13A.2 测的恰是"谁先被碰"，天然在 Bias 范围之外。
 * 纯诊断：biasEngine / 通知零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var directionalChangeAudit = require('../stats/directionalChangeAudit');
var dcStructuralSwing = require('../structure/dcStructuralSwing');
var htfDcStructureAudit = require('../stats/htfDcStructureAudit');

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

            var res = htfDcStructureAudit.auditHtfDcStructure({
                candles: candles5m,
                liquidityObjects: result.liquidityObjects || [],
                dcSwings: dcSwings,
                htf4hCandles: data['4h'] || [],
                htf1dCandles: data['1d'] || [],
                startIndex: startIndex
            });

            // HTF state 分布（诊断）
            var st4 = htfDcStructureAudit.buildHtfDcStates(data['4h'] || []);
            var st1 = htfDcStructureAudit.buildHtfDcStates(data['1d'] || []);
            function stateDist(states) {
                var d = {};
                states.forEach(function (s) { d[s.state] = (d[s.state] || 0) + 1; });
                return JSON.stringify(d);
            }

            console.log('');
            console.log('PHASE 13A.2 — HTF DC STRUCTURE AUDIT (' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('DC k=' + htfDcStructureAudit.DC_K + ' · confirmWith=close · TRANSITION = swing 确认后 ' +
                htfDcStructureAudit.TRANSITION_BARS + ' 根 htf bar');
            console.log('4H DC states: ' + stateDist(st4) + ' · 1D DC states: ' + stateDist(st1));
            console.log('label = 未来第一个被 raid 的 significant liquidity（horizon 24h；13.1 口径）');
            console.log('参考：Legacy Bias Engine 整体 51.7%（13A.1 冻结，属 Bias accuracy，与本 DrawDirHit 不同口径，仅作背景）');
            console.log('');

            console.log('=== 核心表：HTF Context → PDH_FIRST / PDL_FIRST ===');
            console.log('  （PDH_FIRST = 上方 significant（BSL）先被 raid；PDL_FIRST = 下方（SSL）先被 raid）');
            console.log('  （DrawDirHit = 该 context 方向 vs 实际 first draw（哪侧流动性先被 raid）方向命中率）');
            console.log('  （这是 HTF Structure feature audit，不是 Bias 验证）');
            console.log(pad('Context', 24) + pad('n', 7) + pad('PDH First', 11) + pad('PDL First', 11) + pad('DrawDirHit', 10));
            function printCtx(label, a) {
                var bslP = a.n > 0 ? a.bsl / a.n : null;
                console.log(pad(label, 24) + pad(String(a.n), 7) +
                    pad(pct(bslP), 11) + pad(pct(bslP !== null ? 1 - bslP : null), 11) +
                    pad(pct(bslP !== null ? (bslP >= 0.5 ? bslP : 1 - bslP) : null), 10));
            }
            ['1D_BULLISH', '1D_BEARISH', '4H_BULLISH', '4H_BEARISH',
                'ALIGN_BULLISH', 'ALIGN_BEARISH', 'CONFLICT_BULL_BEAR', 'CONFLICT_BEAR_BULL'
            ].forEach(function (k) {
                if (res.byContext[k]) printCtx(k, res.byContext[k]);
            });
            console.log('');

            console.log('=== horizon 分桶（<=4h / <=8h / <=12h / <=24h） ===');
            ['<=4h', '<=8h', '<=12h', '<=24h'].forEach(function (hk) {
                var h = res.byHorizon[hk];
                if (!h) return;
                console.log('--- ' + hk + ' ---');
                console.log(pad('Context', 24) + pad('n', 7) + pad('PDH First', 11) + pad('PDL First', 11) + pad('DrawDirHit', 10));
                ['1D_BULLISH', '1D_BEARISH', '4H_BULLISH', '4H_BEARISH',
                    'ALIGN_BULLISH', 'ALIGN_BEARISH', 'CONFLICT_BULL_BEAR', 'CONFLICT_BEAR_BULL'
                ].forEach(function (k) {
                    if (h[k]) printCtx(k, h[k]);
                });
                console.log('');
            });

            console.log('解读（13A.2 验收）：');
            console.log('  - 关注时间尺度：4H DC → 短期（<=4h/8h）桶；1D DC → 24h 桶');
            console.log('  - DrawDirHit > 55% 且 n 够 → HTF DC Structure 对流动性首次触碰方向有统计信息（HTF feature audit）');
            console.log('  - 这不验证 Bias：Bias=决定等待哪侧 raid + raid 后找哪侧 delivery，不是预测下一边谁先被碰');
            console.log('  - ALIGN 组 vs CONFLICT 组 → 对齐是否有增量');
            console.log('  - 纯诊断：biasEngine / 通知零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('HTF DC STRUCTURE AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
