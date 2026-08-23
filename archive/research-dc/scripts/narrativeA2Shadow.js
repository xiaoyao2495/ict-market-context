/**
 * Bias Phase 1 — Formation Fix A.2 Shadow（不改 production buildNarratives）
 *
 * 跑同一条 replay 管线，用 narrativeFormationA2.buildNarrativesA2 替代 production
 * buildNarratives，对比：
 *   - A2 Narrative 数 vs 3330 基线（production） → 看 fan-out 坍缩幅度（非成功指标）
 *   - causalRule 分布（NEAREST_DEEPEST / EARLIER_DEEPEST_REPRICING / NO_CLEAR 丢弃）
 *   - 20 Bull + 20 Bear 人眼锚点（cluster.sources[] / 极值 / bars + MSS + Disp）
 *
 * 纪律：Detection 冻结、Bias/Outcome/13A.2 不动；本脚本只读审计，不接生产。
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeA2Shadow.js [SYMBOL] [DAYS]
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var a2 = require('../stats/narrativeFormationA2');
var baseline = require('../stats/narrativeLabelAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

function fmt(ms) { return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-'; }
function num(v) { return (typeof v === 'number' && !isNaN(v)) ? v : NaN; }
function hm(ms) { return ms ? new Date(ms).toISOString().slice(11, 16) : '-'; }
function isStructural(t) {
    if (!t) return false;
    if (t.indexOf('SWING') >= 0) return true;
    return ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'].indexOf(t) >= 0;
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.2 Shadow (terminal causal raid) ...');

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
            var ctx = {
                sweeps: result.sweepEvents || [],
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                swings: result.swings || [],
                legByDispId: legByDispId,
                candles5m: candles5m
            };

            // 基线（production buildNarratives）
            var base = baseline.auditNarratives(ctx);
            // A.2 shadow（开启 drop 计数）
            ctx.collectDrops = true;
            ctx.drops = [];
            var a2n = a2.buildNarrativesA2(ctx);

            // distinct MSS 对比（A.2 是 1:1，a2n 即 distinct 数）
            var baseMss = {};
            base.narratives.forEach(function (n) { baseMss[n.mssId] = true; });
            var distinctBaseMss = Object.keys(baseMss).length;
            var dropCount = {};
            (ctx.drops || []).forEach(function (r) { dropCount[r] = (dropCount[r] || 0) + 1; });
            var distinctA2 = a2n.length;

            var baseN = base.narratives.length;
            var a2N = a2n.length;

            // causalRule 分布
            var ruleCount = {};
            a2n.forEach(function (n) { ruleCount[n.causalRule] = (ruleCount[n.causalRule] || 0) + 1; });
            var nClustersDist = {};
            a2n.forEach(function (n) { nClustersDist[n.nClusters] = (nClustersDist[n.nClusters] || 0) + 1; });
            var sideCount = { SSL: 0, BSL: 0 };
            a2n.forEach(function (n) { sideCount[n.raidSide] = (sideCount[n.raidSide] || 0) + 1; });

            // 时间结构
            function medianOf(arr) {
                if (!arr.length) return null;
                var s = arr.slice().sort(function (a, b) { return a - b; });
                var m = Math.floor(s.length / 2);
                return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
            }
            var r2m = a2n.map(function (n) { return n.raidToMssBars; });
            var m2d = a2n.map(function (n) { return n.mssToDispBars; }).filter(function (v) { return v !== null; });

            console.log('\n=== A.2 Shadow — Terminal Causal Raid Attribution (BTCUSDT ' + DAYS + 'd, futures) ===');
            console.log('基线 production buildNarratives : ' + baseN + ' narratives (' + distinctBaseMss + ' distinct MSS，含 fan-out)');
            console.log('A.2 terminal-causal            : ' + a2N + ' narratives  (fan-out 坍缩 ' +
                (baseN ? Math.round((1 - a2N / baseN) * 100) : 0) + '%, 非成功指标)');
            console.log('  候选 distinct MSS (基线有≥1 narrative) = ' + distinctBaseMss);
            console.log('  A.2 保留 = ' + distinctA2 + '  |  丢弃 = ' + (distinctBaseMss - distinctA2) +
                '  (drop 明细: ' + JSON.stringify(dropCount) + ')');
            console.log('  causalRule 分布              : ' + JSON.stringify(ruleCount));
            console.log('  raidSide                     : SSL=' + sideCount.SSL + ' / BSL=' + sideCount.BSL);
            console.log('  nClusters(单 MSS 前 eligible cluster 数) 分布: ' + JSON.stringify(nClustersDist));
            console.log('  median raidToMssBars         : ' + medianOf(r2m));
            console.log('  median mssToDispBars        : ' + medianOf(m2d));
            console.log('');
            console.log('参数（可调，见 stats/narrativeFormationA2.js）：clusterGapMax=12, repThresholdAtr=0.6, alignAtr=1.5');
            console.log('causalRule: NEAREST_DEEPEST=A胜(rule3) / EARLIER_DEEPEST_REPRICING=B胜(rule4) / NO_CLEAR=丢弃(rule5,未计入 a2N)');
            console.log('');

            // disp net/atr 辅助
            function dispInfo(mssId, D) {
                var leg = null;
                Object.keys(legByDispId).forEach(function (did) {
                    var l = legByDispId[did];
                    if (l.mssId === mssId && l.direction === D) leg = l;
                });
                if (!leg) return 'Disp:-';
                var sB = candles5m[leg.startIndex], eB = candles5m[leg.endIndex];
                if (!sB || !eB) return 'Disp:-';
                var net = (leg.endIndex === leg.startIndex) ? (eB.close - eB.open) : (eB.close - sB.close);
                var atr = leg.atr; var norm = (atr && atr > 0) ? net / atr : null;
                var dirOk = (D === 'BULLISH' && net > 0) || (D === 'BEARISH' && net < 0);
                return 'disp[' + leg.startIndex + '..' + leg.endIndex + '] bars=' + (leg.endIndex - leg.startIndex + 1) +
                    ' net=' + (net > 0 ? '+' : '') + net.toFixed(1) + ' (' +
                    (norm !== null ? (norm > 0 ? '+' : '') + norm.toFixed(2) + 'ATR' : '?') + ')' + (dirOk ? ' DIR✓' : ' DIR✗');
            }

            function dumpAnchors(dir, label, count) {
                var sel = a2n.filter(function (n) { return n.raidSide === (dir === 'BULLISH' ? 'SSL' : 'BSL'); }).slice(0, count);
                console.log('--- ' + label + ' 人眼锚点 (' + sel.length + ') ---');
                sel.forEach(function (n, i) {
                    var D = dir === 'BULLISH' ? 'BULLISH' : 'BEARISH';
                    console.log('[' + label[0] + (i + 1) + '] MSS#' + n.mssId + ' ' + D + '(' + n.raidSide + ') idx=' + n.mssIndex +
                        ' ' + fmt(n.mssTime) + '  ' + dispInfo(n.mssId, D));
                    console.log('     CausalRaid cluster: sources=[' + n.clusterSources.map(function (s) {
                        return s + (isStructural(s) ? '*' : ''); }).join(',') + ']  extremeIdx=' + n.raidIndex +
                        ' (' + n.raidToMssBars + 'b before MSS)  rule=' + n.causalRule + '  nClusters=' + n.nClusters);
                });
                console.log('');
            }

            dumpAnchors('BULLISH', 'BULL', 20);
            dumpAnchors('BEARISH', 'BEAR', 20);

            console.log('（* = structural；rule 见上。人眼核对：cluster 是否真启动 repricing、Disp 是否真同方向 delivery。）');
            console.log('验收：重跑仅看数量下降不够；须 20+20 人眼确认每条只讲一个自然可信的 Raid→MSS→Disp 故事。');
        });
    })
    .catch(function (error) {
        console.error('A.2 SHADOW FAILED:', error && error.stack || error);
        process.exit(1);
    });
