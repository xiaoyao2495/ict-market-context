/**
 * Bias Phase 1 — Formation Fix A 研究（纯只读，不改任何算法）
 *
 * 目的：把 90d 的 fan-out 簇拉成表，回答一个问题——
 *   "当一个 MSS 前面存在多个同方向 Raid 时，哪一个 Raid 才应该拥有这个 MSS？"
 *
 * 不改 buildNarratives：本脚本用与 buildNarratives 完全相同的 loose 归属逻辑
 * （raid 之后下一个同方向 MSS）反推簇，但保留 sweep 全对象（含 source.liquidityType/
 * liquidityPrice），以便逐条展示每个 raid 扫的是哪种流动性、价格、距 MSS 几 bars。
 *
 * 关键洞见（写进输出）：1:1 归因后每个 MSS 只产 1 条 narrative，无论用 RULE_A(最近)
 * 还是 RULE_B(structural liquidity) 总数都同样坍缩；两规则区别只在"同一个 MSS 归哪个
 * raid"——本表直接对比两种 pick 是否一致，供定 1:1 attribution rule 用。
 *
 * 纪律：Detection 冻结、Bias Engine 不动、Outcome 层不动、不调参数。
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeFanoutInspect.js [SYMBOL] [DAYS]
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

// structural liquidity：ICT "swing / prior-period extreme" = 真正结构流动性
function isStructural(t) {
    if (!t) return false;
    if (t.indexOf('SWING') >= 0) return true;
    return ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'].indexOf(t) >= 0;
}

function fmt(ms) {
    return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-';
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for fan-out cluster research ...');

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

            // displacement leg（与 buildNarratives 同口径）
            var legByDispId = displacementLeg.buildWindowedLegIndex(
                result.displacementEvents || [], candles5m, result.mssEvents || [], result.swings || []
            );
            var legByMssId = {};
            Object.keys(legByDispId).forEach(function (did) {
                var leg = legByDispId[did];
                if (!leg || !leg.mssId) return;
                if (!legByMssId[leg.mssId]) legByMssId[leg.mssId] = [];
                legByMssId[leg.mssId].push(leg);
            });

            // sweepEvents（raid）→ 保留 liquidityType/Price
            var sweeps = (result.sweepEvents || []).filter(function (s) {
                return (s.direction === 'BULLISH' || s.direction === 'BEARISH') && typeof s.candleIndex === 'number';
            }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

            var mssAll = (result.mssEvents || []).filter(function (m) {
                return m && (m.direction === 'BULLISH' || m.direction === 'BEARISH') && typeof m.candleIndex === 'number';
            }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

            // 反推 fan-out 簇：对每个 MSS，找它前面同方向、且其间无更近同方向 MSS 的 raid
            var clusters = [];
            mssAll.forEach(function (m) {
                var Mi = m.candleIndex, D = m.direction;
                // 最近的前一个同方向 MSS
                var prevSameDir = -Infinity;
                for (var k = 0; k < mssAll.length; k++) {
                    if (mssAll[k].candleIndex >= Mi) break;
                    if (mssAll[k].direction === D) prevSameDir = mssAll[k].candleIndex;
                }
                var eligible = sweeps.filter(function (s) {
                    return s.direction === D && s.candleIndex > prevSameDir && s.candleIndex < Mi;
                });
                if (eligible.length >= 2) {
                    // MSS 的 displacement leg 摘要
                    var leg = null;
                    (legByMssId[m.id] || []).forEach(function (l) { if (l.direction === D) leg = l; });
                    var dispTxt = '-';
                    if (leg) {
                        var sB = candles5m[leg.startIndex], eB = candles5m[leg.endIndex];
                        var net = (leg.endIndex === leg.startIndex)
                            ? (eB.close - eB.open) : (eB.close - sB.close);
                        var atr = leg.atr;
                        var norm = (atr && atr > 0) ? net / atr : null;
                        var dirOk = (D === 'BULLISH' && net > 0) || (D === 'BEARISH' && net < 0);
                        dispTxt = 'disp[' + leg.startIndex + '..' + leg.endIndex + '] bars=' +
                            (leg.endIndex - leg.startIndex + 1) + ' net=' + (net > 0 ? '+' : '') + net.toFixed(1) +
                            ' (' + (norm !== null ? (norm > 0 ? '+' : '') + norm.toFixed(2) + 'ATR' : '?') + ')' +
                            (dirOk ? ' DIR✓' : ' DIR✗');
                    }
                    // 候选规则
                    var nearest = eligible.reduce(function (a, b) { return b.candleIndex > a.candleIndex ? b : a; });
                    var struct = eligible.filter(function (s) { return isStructural(s.source && s.source.liquidityType); });
                    var structPick = struct.length
                        ? struct.reduce(function (a, b) { return b.candleIndex > a.candleIndex ? b : a; })
                        : nearest; // 无 structural → fallback 最近
                    clusters.push({
                        mss: m, dir: D, Mi: Mi, eligible: eligible, dispTxt: dispTxt,
                        nearestId: nearest.id, structId: structPick.id,
                        diverge: nearest.id !== structPick.id
                    });
                }
            });

            // ---- 聚合 ----
            var totalMss = mssAll.length;
            var totalRaidWithMss = 0; // 当前每个 raid → 1 narrative
            mssAll.forEach(function (m) {
                var Mi = m.candleIndex, D = m.direction;
                var prevSameDir = -Infinity;
                for (var k = 0; k < mssAll.length; k++) {
                    if (mssAll[k].candleIndex >= Mi) break;
                    if (mssAll[k].direction === D) prevSameDir = mssAll[k].candleIndex;
                }
                var c = sweeps.filter(function (s) {
                    return s.direction === D && s.candleIndex > prevSameDir && s.candleIndex < Mi;
                }).length;
                if (c >= 1) totalRaidWithMss += c;
            });
            var mssWithRaid = clusters.length + mssAll.filter(function (m) {
                var Mi = m.candleIndex, D = m.direction;
                var prevSameDir = -Infinity;
                for (var k = 0; k < mssAll.length; k++) {
                    if (mssAll[k].candleIndex >= Mi) break;
                    if (mssAll[k].direction === D) prevSameDir = mssAll[k].candleIndex;
                }
                var c = sweeps.filter(function (s) {
                    return s.direction === D && s.candleIndex > prevSameDir && s.candleIndex < Mi;
                }).length;
                return c === 1;
            }).length;
            var sizeHist = {};
            clusters.forEach(function (c) {
                var s = c.eligible.length;
                var key = s >= 5 ? '5+' : String(s);
                sizeHist[key] = (sizeHist[key] || 0) + 1;
            });
            var divergeCount = clusters.filter(function (c) { return c.diverge; }).length;

            console.log('\n=== Fan-out Cluster Research (BTCUSDT ' + DAYS + 'd, futures) ===');
            console.log('MSS 总数 = ' + totalMss);
            console.log('当前 narrative 数（每 raid→1）≈ ' + totalRaidWithMss);
            console.log('fan-out 簇（一个 MSS ≥2 raid）数 = ' + clusters.length);
            console.log('→ 1:1 归因后 narrative 数 = ' + mssWithRaid + '（无论 RULE_A/B 计数相同，仅归因不同）');
            console.log('   reduction = ' + (totalRaidWithMss - mssWithRaid) + ' 条 (' +
                (100 * (totalRaidWithMss - mssWithRaid) / totalRaidWithMss).toFixed(1) + '%)');
            console.log('簇大小分布 = ' + JSON.stringify(sizeHist));
            console.log('RULE_A(最近) vs RULE_B(structural) 归因分歧簇 = ' + divergeCount +
                ' / ' + clusters.length + ' (' + (100 * divergeCount / clusters.length).toFixed(1) + '%)');
            console.log('');
            console.log('RULE_A = 同方向 raid 中 candleIndex 最大（距 MSS 最近）');
            console.log('RULE_B = 优先 structural liquidity（SWING*/PD*/PW*/PM*），其中取最近；无 structural→fallback 最近');
            console.log('');

            // ---- 明细：所有 size>=3 全列；size==2 列前 40 ----
            var big = clusters.filter(function (c) { return c.eligible.length >= 3; })
                .sort(function (a, b) { return b.eligible.length - a.eligible.length; });
            var two = clusters.filter(function (c) { return c.eligible.length === 2; }).slice(0, 40);

            function dumpCluster(c, label) {
                var side = c.dir === 'BULLISH' ? 'SSL' : 'BSL';
                console.log('[' + label + '] MSS#' + c.mss.id + ' dir=' + c.dir + '(' + side + ') idx=' + c.Mi +
                    ' ' + fmt(c.mss.confirmedAt) + '  ' + c.dispTxt);
                c.eligible.sort(function (a, b) { return a.candleIndex - b.candleIndex; });
                c.eligible.forEach(function (s) {
                    var lt = (s.source && s.source.liquidityType) || '?';
                    var lp = (s.source && s.source.liquidityPrice) || s.price || 0;
                    var bars = c.Mi - s.candleIndex;
                    var tags = [];
                    if (s.id === c.nearestId) tags.push('A');
                    if (s.id === c.structId) tags.push('B');
                    console.log('    raid idx=' + s.candleIndex + ' ' + fmt(s.confirmedAt) +
                        ' ' + (lt + (isStructural(lt) ? '*' : '')) +
                        ' px=' + lp.toFixed(1) + ' bars=' + bars +
                        (tags.length ? '  <' + tags.join('+') + '>' : ''));
                });
                console.log('    → RULE_A=' + c.nearestId + '  RULE_B=' + c.structId +
                    (c.diverge ? '  ⚠️DIVERGE' : '  same'));
            }

            console.log('--- DETAIL: size>=3 clusters (' + big.length + ') ---');
            big.forEach(function (c, i) { dumpCluster(c, 'F' + (i + 1)); });
            console.log('--- DETAIL: size==2 clusters (first ' + two.length + ' of ' +
                clusters.filter(function (c) { return c.eligible.length === 2; }).length + ') ---');
            two.forEach(function (c, i) { dumpCluster(c, 'T' + (i + 1)); });
            console.log('');
            console.log('（* = structural liquidity；<A>=RULE_A 最近 <B>=RULE_B structural；⚠️DIVERGE = 两规则归因不同）');
        });
    })
    .catch(function (error) {
        console.error('FANOUT INSPECT FAILED:', error && error.stack || error);
        process.exit(1);
    });
