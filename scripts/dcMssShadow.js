/**
 * Phase 12.3 — DC Structural Swing MSS Shadow（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/dcMssShadow.js BTCUSDT 90
 *
 * V1 定案（用户）：ATR DC k=1.0 + close confirmation；Legacy MSS authoritative、DC MSS 纯 shadow。
 * 两套 MSS 用同一 detectMss、同一 cfg、同一 candles（离线全量，consumedRefs 独立），可比。
 * 先输出 Structure Quality（churn/密度/break 质量），再输出 Delivery Quality
 * （1h displacement 命中 / MFE / MAE / 同套后续同向 MSS 率）。不看 HIGH。
 *
 * 纯诊断：pivotDetector / swingLiquidity / mssDetector / 生产所有消费方零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var dcMssShadow = require('../stats/dcMssShadow');

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
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles,
                result.mssEvents || [], result.swings || []);
            var dispByIndex = {};
            (result.displacementEvents || []).forEach(function (d) {
                if (typeof d.candleIndex !== 'number') return;
                if (!dispByIndex[d.candleIndex]) dispByIndex[d.candleIndex] = [];
                dispByIndex[d.candleIndex].push(d);
            });

            var KS = [1.0, 1.5]; // Phase 12.3b：只变 k，其余冻结
            var shadows = KS.map(function (k) {
                return dcMssShadow.buildDcMss(candles, result.swings || [], {
                    symbol: SYMBOL,
                    timeframe: '5m',
                    k: k
                });
            });
            var legacy = shadows[0].legacy; // legacy 两档相同，取第一份
            var days = DAYS;

            var ls = dcMssShadow.structureStats(legacy.mss, days);
            var ld = dcMssShadow.deliveryStats(legacy.mss, candles, { dispByIndex: dispByIndex, legByDispId: legByDispId });
            var rows = [];
            shadows.forEach(function (sh) {
                rows.push({
                    k: sh.k,
                    swings: sh.dc.swings.length,
                    s: dcMssShadow.structureStats(sh.dc.mss, days),
                    d: dcMssShadow.deliveryStats(sh.dc.mss, candles, { dispByIndex: dispByIndex, legByDispId: legByDispId })
                });
            });

            console.log('');
            console.log('DC MSS SHADOW (Phase 12.3b, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('confirmWith = close · ATR frozen at extreme · 同一 detectMss / cfg / candles · churn 窗口 30min · delivery 窗口 1h');
            console.log('LEGACY swings = ' + legacy.swings.length + '（2-2 LOCAL_PIVOT） · DC swings = ' +
                rows.map(function (r) { return r.k + 'ATR:' + r.swings; }).join(' / '));
            console.log('');

            console.log('=== 第一层：Structure Quality（MSS 本身） ===');
            var colW = 26;
            function header3() {
                console.log(pad('指标', colW) + pad('Legacy', 12) + pad('DC 1.0', 12) + pad('DC 1.5', 12));
            }
            function row3(label, lv, v10, v15) {
                console.log(pad(label, colW) + pad(String(lv), 12) + pad(String(v10), 12) + pad(String(v15), 12));
            }
            header3();
            row3('MSS 总数', ls.n, rows[0].s.n, rows[1].s.n);
            row3('每天 MSS', fnum(ls.perDay, 1), fnum(rows[0].s.perDay, 1), fnum(rows[1].s.perDay, 1));
            row3('BULL / BEAR', ls.bull + '/' + ls.bear, rows[0].s.bull + '/' + rows[0].s.bear, rows[1].s.bull + '/' + rows[1].s.bear);
            row3('MSS 间隔 mean', fnum(ls.gapMean, 1), fnum(rows[0].s.gapMean, 1), fnum(rows[1].s.gapMean, 1));
            row3('MSS 间隔 median', ls.gapMedian, rows[0].s.gapMedian, rows[1].s.gapMedian);
            row3('churn flips (30min)', ls.churnFlips, rows[0].s.churnFlips, rows[1].s.churnFlips);
            row3('churn rate', pct(ls.churnRate), pct(rows[0].s.churnRate), pct(rows[1].s.churnRate));
            row3('churn clusters', ls.churnClusters, rows[0].s.churnClusters, rows[1].s.churnClusters);
            row3('同向短重复', ls.sameDirShort, rows[0].s.sameDirShort, rows[1].s.sameDirShort);
            row3('同向短重复 rate', pct(ls.sameDirShort / ls.n), pct(rows[0].s.sameDirShort / rows[0].s.n), pct(rows[1].s.sameDirShort / rows[1].s.n));
            row3('reference swing 利用率', pct(ls.refSwingCount / legacy.swings.length), pct(rows[0].s.refSwingCount / rows[0].swings), pct(rows[1].s.refSwingCount / rows[1].swings));
            row3('breakPct median', ls.breakPctMedian === null ? '-' : (ls.breakPctMedian * 100).toFixed(3) + '%',
                rows[0].s.breakPctMedian === null ? '-' : (rows[0].s.breakPctMedian * 100).toFixed(3) + '%',
                rows[1].s.breakPctMedian === null ? '-' : (rows[1].s.breakPctMedian * 100).toFixed(3) + '%');
            row3('bodyRatio median', fnum(ls.bodyRatioMedian, 2), fnum(rows[0].s.bodyRatioMedian, 2), fnum(rows[1].s.bodyRatioMedian, 2));
            row3('closeStrength median', fnum(ls.closeStrengthMedian, 2), fnum(rows[0].s.closeStrengthMedian, 2), fnum(rows[1].s.closeStrengthMedian, 2));
            console.log('');

            console.log('=== 第二层：Delivery Quality（MSS 后 1h） ===');
            header3();
            row3('n', ld.n, rows[0].d.n, rows[1].d.n);
            row3('STRONG/EXPLOSIVE disp 命中率', pct(ld.dispStrongRate), pct(rows[0].d.dispStrongRate), pct(rows[1].d.dispStrongRate));
            row3('顺向 MFE mean (%)', fnum(ld.mfeMean, 3), fnum(rows[0].d.mfeMean, 3), fnum(rows[1].d.mfeMean, 3));
            row3('逆向 MAE mean (%)', fnum(ld.maeMean, 3), fnum(rows[0].d.maeMean, 3), fnum(rows[1].d.maeMean, 3));
            row3('同套后续同向 MSS 率', pct(ld.nextSameDirMssRate), pct(rows[0].d.nextSameDirMssRate), pct(rows[1].d.nextSameDirMssRate));
            console.log('');

            console.log('解读（用户 12.3b 验收框架）：');
            console.log('  - 若 1.5 ATR：MSS -30% 左右 + churn rate 7.7%→5~6% + 短重复率明显降 +');
            console.log('    StrongLeg>=Legacy + MFE>=Legacy + MAE 不恶化 → Structural Swing 改进成立');
            console.log('  - 若仍 MSS 大减但 churn rate ~7.0%、delivery 差不多 → 根因在 MSS detector');
            console.log('    自身（break/reference 语义），停止 DC 参数寻优，转审计 mssDetector');
            console.log('  - future-safety：candidateReferences 只放行 confirmedAt <= evalTime（专项测试锁定）');
            console.log('  - 纯诊断：生产 detector / MSS / 通知全部零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('DC MSS SHADOW FAILED:', error && error.stack || error);
        process.exit(1);
    });
