/**
 * Phase 12.4 — Structural Swing Integration Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/structuralSwingIntegration.js BTCUSDT 90
 *
 * 两套完整链路（k=1.5 冻结，close confirm）：
 *   LEGACY: result.swings（2-2）→ legacy MSS → legacy displacement → legacy HIGH
 *   SHADOW: DC 1.5 swings → DC MSS → DC displacement → shadow HIGH
 * 单变量：fvgs / drawTrace / sweepEvents / candles 同一份（不碰 Liquidity）。
 * 输出四象限（BOTH / LEGACY_ONLY / DC_ONLY）各自 delivery。
 * 期望：LEGACY_ONLY forward 明显更差（删假结构）+ DC_ONLY 至少不差（发现新结构）。
 *
 * 纯诊断：生产 detector / MSS / 通知全部零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var directionalChangeAudit = require('../stats/directionalChangeAudit');
var structuralSwingIntegration = require('../stats/structuralSwingIntegration');

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

            // 统一 StrongLeg/disp 口径：legacy displacement + legacy legByDispId
            var dispByIndex = {};
            var legByDispIdLegacy = {};
            var legacyChain = (function () {
                // 复用 buildShadowAlerts 内部的 legacy 链（detectDisplacement + leg 索引）——
                // 为统一口径，这里用 legacy 的 displacement 事件构建 dispByIndex/legByDispId
                var dispL = require('../events/displacementDetector').detectDisplacement(candles, shadow.legacy.mss, {
                    symbol: SYMBOL, timeframe: '5m'
                });
                var legIdx = require('../stats/displacementLeg').buildWindowedLegIndex(dispL, candles, shadow.legacy.mss, shadow.legacy.swings);
                dispL.forEach(function (d) {
                    if (typeof d.candleIndex !== 'number') return;
                    if (!dispByIndex[d.candleIndex]) dispByIndex[d.candleIndex] = [];
                    dispByIndex[d.candleIndex].push(d);
                });
                return legIdx;
            })();
            Object.keys(legacyChain).forEach(function (k2) { legByDispIdLegacy[k2] = legacyChain[k2]; });

            var q = structuralSwingIntegration.quadrantSplit(shadow.legacy.alerts, shadow.dc.alerts);
            var bothLegacy = q.both.map(function (b) { return b.legacy; });
            var bothDc = q.both.map(function (b) { return b.dc; });
            var aBoth = structuralSwingIntegration.assessQuadrant(bothLegacy, candles, dispByIndex, legByDispIdLegacy);
            var aLegacyOnly = structuralSwingIntegration.assessQuadrant(q.legacyOnly, candles, dispByIndex, legByDispIdLegacy);
            var aDcOnly = structuralSwingIntegration.assessQuadrant(q.dcOnly, candles, dispByIndex, legByDispIdLegacy);
            var aDcBoth = structuralSwingIntegration.assessQuadrant(bothDc, candles, dispByIndex, legByDispIdLegacy);

            console.log('');
            console.log('STRUCTURAL SWING INTEGRATION SHADOW (Phase 12.4, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('k = ' + shadow.k + ' ATR · close confirm · 只换 MSS reference source（fvgs/drawTrace/sweep/candles 同一份）');
            console.log('Legacy swings = ' + shadow.legacy.swings.length + ' · DC swings = ' + shadow.dc.swings.length);
            console.log('Legacy HIGH = ' + q.legacyN + ' · DC HIGH = ' + q.dcN +
                ' · BOTH = ' + q.both.length + ' · LEGACY_ONLY = ' + q.legacyOnly.length +
                ' · DC_ONLY = ' + q.dcOnly.length + '（对齐容差 |anchorΔ| <= ' + structuralSwingIntegration.MAX_ANCHOR_DELTA + ' bars）');
            console.log('');

            function printQ(label, a, note) {
                console.log('--- ' + label + ' ---');
                console.log(pad('n', 6) + pad('NearHit30m', 12) + pad('NearHit1h', 12) + pad('MFE1h%', 10) +
                    pad('MAE1h%', 10) + pad('hasStrong', 12) + pad('strong/al', 10) + pad('breakPct med', 13));
                console.log(pad(String(a.n), 6) +
                    pad(pct(a.nearHit30m), 12) + pad(pct(a.nearHit1h), 12) +
                    pad(fnum(a.mfe1h, 3), 10) + pad(fnum(a.mae1h, 3), 10) +
                    pad(pct(a.hasStrongRate), 12) + pad(fnum(a.strongDispPerAlert, 2), 10) +
                    pad(a.breakPctMedian === null ? '-' : (a.breakPctMedian * 100).toFixed(3) + '%', 13));
                console.log(note ? '  注：' + note : '');
                console.log('');
            }
            printQ('BOTH（legacy 侧）', aBoth, '两套结构共识的 HIGH——baseline 质量');
            printQ('LEGACY_ONLY', aLegacyOnly, '被 DC 删除的 HIGH：若 forward 明显更差 → DC 删了假结构');
            printQ('DC_ONLY', aDcOnly, 'DC 新发现的 HIGH：若至少不差 → 新结构有增量价值');
            printQ('BOTH（DC 侧）', aDcBoth, '共识样本用 DC 参数的 delivery（供对照）');

            console.log('解读（用户 12.4 验收）：');
            console.log('  - LEGACY_ONLY：NearHit/MFE 明显低于 BOTH → DC 删除了假结构');
            console.log('  - DC_ONLY：NearHit/MFE 至少不低于 BOTH/legacy 基线 → 新结构有增量');
            console.log('  - hasStrongRate / strongDispPerAlert 为拆分的 disp 口径（不再用 111.3% 式数字）');
            console.log('  - 若两条件成立 → DC 可定义为正式 STRUCTURAL_SWING（Phase 12.5 再整合 Liquidity）');
            console.log('  - 纯诊断：生产 detector / MSS / 通知全部零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('STRUCTURAL SWING INTEGRATION FAILED:', error && error.stack || error);
        process.exit(1);
    });
