/**
 * Bias Phase 1 — Narrative Anchor Event-Chain Inspector（纯只读审计，不改任何算法）
 *
 * 复刻 scripts/narrativeLabelAudit.js 的 load→replay→legIndex→auditNarratives 管线，
 * 但只做一次事：对前 20 SSL + 前 20 BSL Narrative 锚点，打印每一条的
 *   raid bar OHLC + 是否真流动性扫单
 *   MSS bar OHLC + 方向
 *   displacement leg（startIndex..endIndex）真实净移动方向与 ATR 归一化幅度
 * 用于人工/事件链审计三问：
 *   Q1 Raid 是否真实   Q2 MSS 是否真实且方向正确
 *   Q3 绑定的 Displacement 是否真是造成/确认该 MSS 的 repricing leg（同方向净移动）
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeAnchorInspect.js [SYMBOL] [DAYS]
 * 纯诊断，Detection 冻结、Bias Engine 不动、buildNarratives 不改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var narrativeLabelAudit = require('../stats/narrativeLabelAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

function fmt(ms) {
    return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-';
}
function p(x, d) { return (x === null || x === undefined) ? '-' : x.toFixed(d === undefined ? 1 : d); }

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for anchor inspection ...');

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

            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );
            var res = narrativeLabelAudit.auditNarratives({
                candles: candles5m,
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                drawTrace: result.drawTrace || []
            });

            // 重建 legByMssId（与 buildNarratives 同口径）以取 leg.endIndex / atr
            var legByMssId = {};
            Object.keys(legByDispId).forEach(function (did) {
                var leg = legByDispId[did];
                if (!leg || !leg.mssId) return;
                if (!legByMssId[leg.mssId]) legByMssId[leg.mssId] = [];
                legByMssId[leg.mssId].push(leg);
            });

            var bull = res.narratives.filter(function (n) { return n.raidSide === 'SSL'; });
            var bear = res.narratives.filter(function (n) { return n.raidSide === 'BSL'; });

            function inspect(n, idx) {
                var rc = candles5m[n.raidIndex], mc = candles5m[n.mssIndex], dc = candles5m[n.dispIndex];
                if (!rc || !mc || !dc) return '  [' + idx + '] ⚠️ 缺 candle 数据';
                // raid 扫单检查（coarse proxy）：SSL→raid low 破前 24 根低点；BSL→raid high 破前 24 根高点
                var preLo = Infinity, preHi = -Infinity;
                for (var k = Math.max(0, n.raidIndex - 24); k < n.raidIndex; k++) {
                    if (candles5m[k]) { preLo = Math.min(preLo, candles5m[k].low); preHi = Math.max(preHi, candles5m[k].high); }
                }
                var sweepOk = n.raidSide === 'SSL' ? (rc.low < preLo) : (rc.high > preHi);
                // MSS 检查（coarse proxy）：BULLISH→MSS high 破前 48 根高点；BEARISH→MSS low 破前 48 根低点
                var mPreLo = Infinity, mPreHi = -Infinity;
                for (var m = Math.max(0, n.mssIndex - 48); m < n.mssIndex; m++) {
                    if (candles5m[m]) { mPreLo = Math.min(mPreLo, candles5m[m].low); mPreHi = Math.max(mPreHi, candles5m[m].high); }
                }
                var mssDir = n.raidSide === 'SSL' ? 'BULLISH' : 'BEARISH';
                var mssBreakOk = mssDir === 'BULLISH' ? (mc.high > mPreHi) : (mc.low < mPreLo);
                // disp leg 真实移动（与 buildNarratives 同口径：leg.mssId === mss.id 且方向一致）
                var leg = null;
                (legByMssId[n.mssId] || []).forEach(function (l) { if (l.direction === mssDir) leg = l; });
                var moveTxt = '?';
                if (leg) {
                    var sB = candles5m[leg.startIndex], eB = candles5m[leg.endIndex];
                    if (sB && eB) {
                        // 单根 bar 用自身实体(close-open)度量方向；多根用 close[end]-close[start]
                        var net = (leg.endIndex === leg.startIndex)
                            ? (eB.close - eB.open)
                            : (eB.close - sB.close);
                        var atr = leg.atr;
                        var norm = (atr && atr > 0) ? (net / atr) : null;
                        var dirOk = (mssDir === 'BULLISH' && net > 0) || (mssDir === 'BEARISH' && net < 0);
                        moveTxt = 'leg[' + leg.startIndex + '..' + leg.endIndex + '] bars=' + (leg.endIndex - leg.startIndex + 1) +
                            ' net=' + (net > 0 ? '+' : '') + net.toFixed(1) +
                            ' (' + (norm !== null ? (norm > 0 ? '+' : '') + norm.toFixed(2) + 'ATR' : 'atr?') + ')' +
                            (dirOk ? ' DIR✓' : ' ⚠️DIR✗');
                    }
                }
                return '  [' + idx + '] ' + n.raidSide + ' raid idx=' + n.raidIndex + ' ' + fmt(n.raidTime) +
                    ' OHLs=' + p(rc.open, 1) + '/' + p(rc.high, 1) + '/' + p(rc.low, 1) + '/' + p(rc.close, 1) +
                    (sweepOk ? ' SWEEP✓' : ' ⚠️SWEEP✗') +
                    '\n        MSS idx=' + n.mssIndex + ' ' + fmt(n.mssTime) + ' dir=' + mssDir +
                    ' OHLs=' + p(mc.open, 1) + '/' + p(mc.high, 1) + '/' + p(mc.low, 1) + '/' + p(mc.close, 1) +
                    (mssBreakOk ? ' BREAK✓' : ' ⚠️BREAK✗') +
                    '\n        ' + moveTxt;
            }

            console.log('\n=== Anchor Event-Chain Inspection (前 20 SSL + 前 20 BSL) ===');
            console.log('--- BULLISH (SSL raid → Bull MSS → Bull Disp) ---');
            bull.slice(0, 20).forEach(function (n, i) { console.log(inspect(n, i + 1)); });
            console.log('--- BEARISH (BSL raid → Bear MSS → Bear Disp) ---');
            bear.slice(0, 20).forEach(function (n, i) { console.log(inspect(n, i + 1)); });
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('ANCHOR INSPECT FAILED:', error && error.stack || error);
        process.exit(1);
    });
