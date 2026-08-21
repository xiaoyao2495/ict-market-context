/**
 * Phase 13 — Draw on Liquidity Quantification（V1 shadow，90d）
 *
 * 用法：node scripts/drawLiquidityAudit.js [SYMBOL] [DAYS]
 * 输出：
 *   - Liquidity Map：ACTIVE 候选池构成（type 分布）
 *   - 未来 label 分布：下一个被 raid 的 liquidity（side/type/barsToDraw）
 *   - 基线对比：最近距离 baseline vs 随机 baseline 的 next-draw 预测准确率
 *   - 特征 cohort：HTF structure / dealing range zone / 最近候选侧 分组准确率
 *   - 抽样特征行（每 12 bars ≈ 1h）
 *
 * 纯诊断：不 score、不 threshold、不改通知。生产零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var thresholds = require('../config/thresholds');
var directionalChangeAudit = require('../stats/directionalChangeAudit');
var dcStructuralSwing = require('../structure/dcStructuralSwing');
var drawLiquidityAudit = require('../stats/drawLiquidityAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
// Phase 13.1：第 4 参数 'significant' → 候选池净化（排除 legacy 2-2 swing）
var SIGNIFICANT_ONLY = process.argv[4] === 'significant';
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

            // DC Structural Swing candidate（12.2 唯一实现；仅 candidate，不假定 significant）
            var dcRaw = directionalChangeAudit.buildDcSwings(candles5m, 1.5, { confirmWith: 'close' });
            var dcSwings = dcRaw.map(function (raw) {
                return dcStructuralSwing.packageForMss(raw, SYMBOL, '5m', candles5m);
            });

            var res = drawLiquidityAudit.auditDrawLiquidity({
                candles: candles5m,
                liquidityObjects: result.liquidityObjects || [],
                dcSwings: dcSwings,
                htfTrend: result.htfTrendTrace || [],
                htf1hCandles: data['1h'] || [],
                displacementEvents: result.displacementEvents || [],
                atrSeries: result.atrSeries || [],
                startIndex: startIndex,
                excludeLegacySwing: SIGNIFICANT_ONLY
            });

            console.log('');
            console.log('DRAW ON LIQUIDITY QUANTIFICATION (Phase 13' + (SIGNIFICANT_ONLY ? '.1' : ' V1') + ', ' + SYMBOL + ' ' + DAYS + 'd)');
            if (SIGNIFICANT_ONLY) {
                console.log('净化模式：排除 legacy 2-2 SWING；保留 PDH/PDL/PWH/PWL/Session/EQH/EQL/DC_SWING');
                console.log('（label = nextSignificantDrawSide/Type + barsToRaid，未来只进 label）');
            }
            console.log('liquidity objects = ' + (result.liquidityObjects || []).length +
                ' · DC swings = ' + dcSwings.length + ' · label 窗口 = ' + drawLiquidityAudit.HORIZON_BARS + ' bars (8h)');
            console.log('');

            // 候选池构成（用第一个采样 bar 的 ACTIVE 池近似？改用全局 type 统计）
            var typeCount = {};
            (result.liquidityObjects || []).forEach(function (l) {
                var g = drawLiquidityAudit.typeGroup(l.type);
                typeCount[g] = (typeCount[g] || 0) + 1;
            });
            var dcType = { DC_SWING: dcSwings.length };
            console.log('=== Liquidity Map 候选来源（90d 全量 type 分布；ACTIVE 池为逐 bar 重建） ===');
            Object.keys(typeCount).sort().forEach(function (g) {
                console.log(pad(g, 12) + typeCount[g]);
            });
            console.log(pad('DC_SWING', 12) + dcType.DC_SWING + '（Structural Liquidity Candidate，不假定 significant）');
            console.log('');

            console.log('=== Future Label 分布（下一个被 raid 的 significant liquidity） ===');
            console.log('  n = ' + res.n + ' 根有 label 的 bar（horizon 内存在下一个 draw）');
            console.log('  nextSide: ' + JSON.stringify(res.sideDist));
            console.log('  nextType: ' + JSON.stringify(res.typeDist));
            console.log('');

            console.log('=== 基线对比（预测 nextDrawSide） ===');
            console.log(pad('基线', 16) + pad('准确率', 8));
            console.log(pad('最近距离', 16) + pad(pct(res.accuracyNearest), 8));
            console.log(pad('随机(占比)', 16) + pad(pct(res.accuracyRandom), 8));
            console.log('  （若最近距离明显 > 随机 → 距离是有效特征；>70% 才有资格谈 Draw 预测）');
            console.log('');

            console.log('=== Phase 13.1 barsToRaid 分桶（30m/1h/4h/24h——"30min 内发生"≠"6h 后才发生"） ===');
            console.log(pad('桶', 8) + pad('n', 7) + pad('nearest', 9) + pad('HTF dir', 9) + pad('random', 9));
            ['30m', '1h', '4h', '24h', '>24h'].forEach(function (b) {
                var s = res.bucketStats[b];
                if (!s) return;
                console.log(pad(b, 8) + pad(String(s.n), 7) +
                    pad(pct(s.nearestN > 0 ? s.nearest / s.nearestN : null), 9) +
                    pad(pct(s.htfN > 0 ? s.htf / s.htfN : null), 9) +
                    pad(pct(s.randN > 0 ? s.rand / s.randN : null), 9));
            });
            console.log('  （nearest = 最近 ACTIVE 候选侧；HTF dir = h1+h4 同向方向；random = 候选池多数侧）');
            console.log('  预期若净化有效：30m 桶 nearest/HTF 应显著 > random，且 > V1 全池同桶');
            console.log('');

            console.log('=== 特征 cohort（按最近候选特征分组，预测 nextDrawSide 命中率） ===');
            function printCohort(label, c, hasDir) {
                var rate = (hasDir && c.n > 0) ? pct(c.hit / c.n) : '-';
                console.log(pad(label, 18) + pad(String(c.n), 7) + pad(rate, 8));
            }
            console.log(pad('cohort', 18) + pad('n', 7) + pad('命中率', 8));
            printCohort('HTF BULLISH', res.featureCohort.htfBullish, true);
            printCohort('HTF BEARISH', res.featureCohort.htfBearish, true);
            printCohort('HTF NEUTRAL', res.featureCohort.htfNeutral, false);
            printCohort('zone DISCOUNT', res.featureCohort.zoneDiscount, true);
            printCohort('zone PREMIUM', res.featureCohort.zonePremium, true);
            printCohort('zone EQ', res.featureCohort.zoneEq, false);
            printCohort('最近候选=上方', res.featureCohort.nearestIsUpper, true);
            printCohort('最近候选=下方', res.featureCohort.nearestIsLower, true);
            console.log('  （HTF BULLISH cohort 命中率 = 实际 nextDraw 为 BSL 的比例；>55% 有预测价值）');
            console.log('');

            console.log('=== 抽样特征行（每 12 bars ≈ 1h；最近候选 + label） ===');
            console.log(pad('t', 8) + pad('close', 12) + pad('next', 16) + pad('bars', 5) +
                pad('nearest', 18) + pad('distATR', 8) + pad('age', 5) + pad('zone', 9) + pad('htf', 12) + pad('align', 8));
            res.rows.slice(0, 20).forEach(function (r) {
                console.log(pad(String(r.t), 8) +
                    pad(String(r.close !== null && r.close !== undefined ? r.close.toFixed(2) : '-'), 12) +
                    pad(r.nextSide + ':' + r.nextType, 16) +
                    pad(String(r.barsToRaid), 5) +
                    pad(r.nearest.type + '(' + r.nearest.side + ')', 18) +
                    pad(r.nearest.distanceATR !== null ? r.nearest.distanceATR.toFixed(2) : '-', 8) +
                    pad(String(r.nearest.ageBars), 5) +
                    pad(String(r.nearest.zone || '-'), 9) +
                    pad(String(r.nearest.htfStructure), 12) +
                    pad(String(r.nearest.deliveryAlignment), 8));
            });
            console.log('  （共 ' + res.rows.length + ' 个采样行）');
            console.log('');

            console.log('解读（Phase 13 V1 验收）：');
            console.log('  - 最近距离 baseline 准确率若接近随机 → 距离不是 Draw 预测的有效特征，需换维度');
            console.log('  - HTF BULLISH / zone DISCOUNT cohort 命中率若 > 整体基线 → narrative 特征有增量');
            console.log('  - 纯诊断：不 score / 不 threshold / 不改通知；HIGH detector 完全解耦');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('DRAW LIQUIDITY AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
