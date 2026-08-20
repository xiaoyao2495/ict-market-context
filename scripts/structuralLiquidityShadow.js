/**
 * Phase 12.5B — Structural Liquidity Causal Chain Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/structuralLiquidityShadow.js BTCUSDT 90
 *
 * 因果链（冻结定义）：
 *   DC STRUCTURAL_SWING → Structural BSL/SSL candidate → 实际 Raid → 方向匹配 DC MSS
 *     → MSS 所属当前 Displacement Leg → CAUSAL LIQUIDITY
 * 对比现状（相关性窗口 windowHasSignificant）→ 四象限：
 *   BOTH / CAUSAL_ONLY / WINDOW_ONLY / NEITHER + 各组 forward（NearHit30m/1h、MFE、MAE）
 * 审计字段（不预锁时间上限）：objectAgeAtRaid / raidToMssBars / mssToLegBars / raidToLegBars 分布
 * 验收案例（ETH 20:09 SHORT）：2267.09（45 bars 前、价格下方旧 EQH）不得命中 causal；
 *   必须基于当时数据给出真实 causal BSL（2318.78 / 2305.50 / 其他 / NONE 均可）。
 *
 * 纯诊断：生产判定（windowHasSignificant / 通知）零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var directionalChangeAudit = require('../stats/directionalChangeAudit');
var structuralSwingIntegration = require('../stats/structuralSwingIntegration');
var structuralLiquidityShadow = require('../stats/structuralLiquidityShadow');
var displacementDetector = require('../events/displacementDetector');
var displacementLeg = require('../stats/displacementLeg');

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
function fnum(x, d) {
    if (x === null || x === undefined) return '-';
    return x.toFixed(d);
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
            var candles = candles5m;
            var ctx = {
                candles: candles,
                fvgs: result.fvgs || [],
                drawTrace: result.drawTrace || [],
                sweepEvents: result.sweepEvents || [],
                symbol: SYMBOL,
                timeframe: '5m',
                k: structuralSwingIntegration.DEFAULT_K
            };
            var dcRaw = directionalChangeAudit.buildDcSwings(candles, structuralSwingIntegration.DEFAULT_K, { confirmWith: 'close' });
            var shadow = structuralSwingIntegration.buildShadowAlerts(ctx, result.swings || [], dcRaw);
            var dc = shadow.dc;

            // DC 链路 leg 索引（与 buildChainAlerts 内部同口径重建）
            var dispDc = displacementDetector.detectDisplacement(candles, dc.mss, { symbol: SYMBOL, timeframe: '5m' });
            var legByDispId = displacementLeg.buildWindowedLegIndex(dispDc, candles, dc.mss, dc.swings);

            var res = structuralLiquidityShadow.auditCausalShadow(dc.alerts, {
                dcSwings: dc.swings,
                dcMss: dc.mss,
                candles: candles,
                legByDispId: legByDispId
            });

            console.log('');
            console.log('STRUCTURAL LIQUIDITY CAUSAL CHAIN SHADOW (Phase 12.5B, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('DC swings = ' + dc.swings.length + ' · DC MSS = ' + dc.mss.length +
                ' · DC HIGH = ' + dc.alerts.filter(function (a) { return a.tier === 'HIGH_QUALITY'; }).length);
            console.log('因果链：Raid → 方向匹配 DC MSS → 当前 Displacement Leg（confirmedAt 严格，不锁时间上限）');
            console.log('');

            console.log('=== 四象限（CAUSAL 因果链 vs WINDOW 48bars 相关性） ===');
            console.log(pad('Quadrant', 14) + pad('n', 6) + pad('NearHit30m', 11) + pad('NearHit1h', 11) +
                pad('MFE1h%', 9) + pad('MAE1h%', 9));
            function printQ(label, a) {
                console.log(pad(label, 14) + pad(String(a.n), 6) +
                    pad(pct(a.nearCnt30m > 0 ? a.nearHit30m / a.nearCnt30m : null), 11) +
                    pad(pct(a.nearCnt1h > 0 ? a.nearHit1h / a.nearCnt1h : null), 11) +
                    pad(fnum(a.mfeCnt > 0 ? a.mfeSum / a.mfeCnt : null, 3), 9) +
                    pad(fnum(a.mfeCnt > 0 ? a.maeSum / a.mfeCnt : null, 3), 9));
            }
            ['BOTH', 'CAUSAL_ONLY', 'WINDOW_ONLY', 'NEITHER'].forEach(function (q) {
                printQ(q, res.quadrants[q]);
            });
            console.log('');
            console.log('  因果链覆盖率 = ' + pct(res.causalRate) + '（' + Math.round(res.causalRate * res.total) + '/' + res.total + '）');
            console.log('  窗口相关性率 = ' + pct(res.windowRate) + '（' + Math.round(res.windowRate * res.total) + '/' + res.total + '）');
            console.log('');

            console.log('=== 时间分布（审计字段，暂不设上限） ===');
            function printDist(label, dist) {
                console.log(pad(label, 18) + JSON.stringify(dist));
            }
            printDist('objectAgeAtRaid', res.dist.objectAgeAtRaid);
            printDist('raidToMssBars', res.dist.raidToMssBars);
            printDist('mssToLegBars', res.dist.mssToLegBars);
            printDist('raidToLegBars', res.dist.raidToLegBars);
            console.log('');

            console.log('=== WINDOW_ONLY 样例（现状给、因果链不给的 HIGH——疑似误关联） ===');
            var wo = res.samples.filter(function (s) { return s.quadrant === 'WINDOW_ONLY'; });
            wo.slice(0, 5).forEach(function (s) {
                console.log('  ' + s.direction + ' anchor=' + s.anchorIndex + ' windowSig=' +
                    s.windowSignificantPrices.map(function (w) { return w.sourceType + '@' + w.sourcePrice + ' (' + w.barsBeforeLegStart + 'b)'; }).join(' / '));
            });
            console.log('  （WINDOW_ONLY 共 ' + wo.length + ' 条；若大量且 forward 差 → 相关性窗口产生错误 narrative 的实证）');
            console.log('');

            console.log('=== CAUSAL_ONLY 样例（因果链发现、窗口没给的 HIGH） ===');
            var co = res.samples.filter(function (s) { return s.quadrant === 'CAUSAL_ONLY'; });
            co.slice(0, 5).forEach(function (s) {
                console.log('  ' + s.direction + ' anchor=' + s.anchorIndex + ' causal ' + s.causalSide +
                    ' @ ' + s.causalPrice + ' raid=' + s.causalRaidIndex + ' (raidToLeg ' + s.causalRaidToLegBars + 'b)');
            });
            console.log('  （CAUSAL_ONLY 共 ' + co.length + ' 条）');
            console.log('');

            // 案例复核：第 4 参数 "YYYY-MM-DD HH:MM"（UTC+8）→ 打印该 anchor 时刻 ±3 bars 的
            // HIGH 完整因果链（candidate/raid/MSS/leg）——用于 ETH 20:09 案例等验收。
            var filterArg = process.argv[4];
            if (filterArg) {
                var filterMs = Date.parse(filterArg.replace(' ', 'T') + ':00+08:00');
                if (!isNaN(filterMs)) {
                    console.log('=== 案例复核：anchor ' + filterArg + '（UTC+8）±15min 的 HIGH ===');
                    res.samples.forEach(function (s) {
                        if (typeof s.anchorTime !== 'number') return;
                        if (Math.abs(s.anchorTime - filterMs) > 15 * 60 * 1000) return;
                        console.log('  ' + s.direction + ' id=' + s.id + ' anchor=' + fmt(s.anchorTime) +
                            ' quadrant=' + s.quadrant);
                        if (s.causalPrice !== null) {
                            console.log('    causal: ' + s.causalSide + ' @ ' + s.causalPrice +
                                ' raid=' + fmt(s.causalRaidTime) +
                                ' mss=' + s.causalMssId +
                                ' leg=' + s.causalLegId +
                                ' (raidToLeg ' + s.causalRaidToLegBars + 'b)');
                        } else {
                            console.log('    causal: NONE（该 HIGH 无因果链命中）');
                        }
                        console.log('    windowSignificant: ' + (s.windowSignificantPrices.length === 0 ? 'NONE' :
                            s.windowSignificantPrices.map(function (w) {
                                return w.sourceType + ' @ ' + w.sourcePrice + ' (' + w.barsBeforeLegStart + 'b)';
                            }).join(' / ')));
                    });
                    console.log('');
                }
            }

            console.log('解读（用户 12.5B 验收）：');
            console.log('  - WINDOW_ONLY 占比高且 forward 差 → 相关性窗口大量产生错误 narrative（2267.09 类误关联），因果链替代有据');
            console.log('  - CAUSAL_ONLY 占比与 forward → 因果链是否有增量（窗口漏掉的真实 raid 链）');
            console.log('  - BOTH 是两法共识；NEITHER 是窗口和因果链都关联不到的 HIGH');
            console.log('  - 时间分布决定后续是否设上限（如 raidToLegBars 集中在 1-6 → 可锁 6；分散 → 不锁）');
            console.log('  - 纯诊断：生产 windowHasSignificant / 通知零改动');
            console.log('');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('STRUCTURAL LIQUIDITY SHADOW FAILED:', error && error.stack || error);
        process.exit(1);
    });
