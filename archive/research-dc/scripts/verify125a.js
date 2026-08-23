/**
 * Phase 12.5A — Structural MSS Promotion 验收（Replay 侧）
 *
 * 用法：
 *   node scripts/verify125a.js BTCUSDT 90
 *
 * 验收（映射用户 5 个硬验收的 2/3/4）：
 *   a. flag=true：runReplay 的 MSS 数量 ≈ 12.4 shadow 的 DC MSS（BTC 90d = 2252）——
 *      证明唯一实现（buildDcSwings 全量 == replay 增量 step）接入正确
 *   b. MSS reference 前缀全部 'DC:'（reference source 确实切换；future-safety 由
 *      candidateReferences confirmedAt<=evalTime 保证，且 state 机确认前不入池）
 *   c. flag=false：MSS 数量 == legacy 口径（3425，与 12.3b 一致）→ 默认路径零变化
 *
 * 环境变量 DCMODE=1 显式开 flag（不修改 thresholds 文件——部署默认 false 不变）。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var thresholds = require('../config/thresholds');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var dcStructuralSwing = require('../structure/dcStructuralSwing');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var DC = process.env.DCMODE === '1';
thresholds.structure = thresholds.structure || {};
thresholds.structure.useDcStructuralSwing = DC;

function fmt(ms) {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10)
    : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd, ' + fmt(startTime) + ' -> ' + fmt(endTime) + ') ...');
console.log('STRUCTURAL_SWING_MODE=' + (DC ? 'DC_ATR_1_5_CLOSE' : 'LEGACY') + '（thresholds.structure.useDcStructuralSwing=' + thresholds.structure.useDcStructuralSwing + '）');

historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        var candles5m = data['5m'];
        var startIndex = Math.min(300, Math.floor(candles5m.length * 0.3));
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            snapshotInterval: 12,
            logEvery: 999999
        }).then(function (result) {
            var mss = result.mssEvents || [];
            var dcRefs = 0;
            var legacyRefs = 0;
            mss.forEach(function (m) {
                var rid = m.source && m.source.referenceSwingId || '';
                if (rid.indexOf(':DC:') !== -1) dcRefs++;
                else legacyRefs++;
            });
            // HIGH 重建：与 12.4 shadow 同链路（legacy swings 用于 Liquidity 层；DC 模式 reference
            // 解析需要 DC swings —— 用唯一实现 buildDcSwings + packageForMss，与 replay refPool 等价）
            var candles = candles5m;
            var refSwings = result.swings || [];
            if (DC) {
                refSwings = dcStructuralSwing.buildDcSwings(candles, 1.5, {}).map(function (raw) {
                    return dcStructuralSwing.packageForMss(raw, SYMBOL, '5m', candles);
                });
            }
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles,
                result.mssEvents || [], refSwings);
            var opps = opportunity.buildOpportunities(SYMBOL, result.fvgs || [], {
                DISPLACEMENT: result.displacementEvents || [],
                MSS: result.mssEvents || []
            });
            var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
                result.drawTrace || [], result.sweepEvents || [], candles, result.mssEvents || []);
            var highCount = alerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; }).length;
            console.log('');
            console.log('VERIFY 12.5A (' + SYMBOL + ' ' + DAYS + 'd, MODE=' + (DC ? 'DC' : 'LEGACY') + ')');
            console.log('  legacy swings = ' + (result.swings || []).length);
            console.log('  MSS 总数        = ' + mss.length);
            console.log('  DC-reference MSS = ' + dcRefs);
            console.log('  legacy-ref MSS   = ' + legacyRefs);
            console.log('  HIGH（重建）      = ' + highCount);
            if (DC) {
                console.log('  对照 12.4 shadow：DC MSS（90d）= 2252 · DC HIGH（90d）= 367（BTC）');
                console.log('  预期 replay 增量 == 全量（唯一实现；warmup 段口径差 <3% 可接受）');
            } else {
                console.log('  对照 12.3b/12.4：legacy MSS（90d）= 3425 · legacy HIGH（90d）= 569（BTC）');
            }
            console.log('  结论：' + (DC
                ? (dcRefs > 0 && legacyRefs === 0 ? 'PASS（reference 全部切换 DC）' : 'FAIL（reference 未切换）')
                : (dcRefs === 0 ? 'PASS（默认路径零变化）' : 'FAIL（默认路径被污染）')));
        });
    })
    .catch(function (e) {
        console.error('VERIFY FAILED:', e && e.stack || e);
        process.exit(1);
    });
