/**
 * Bias Phase 1 — Formation Fix A.1（纯只读，不改任何算法）
 *
 * 目的：对之前 35 个 RULE_A(最近) vs RULE_B(structural) 归因分歧簇，
 * 拆成两类，确定 1:1 attribution rule 的真实决策样本：
 *
 *   SAME_BAR_DIVERGENCE   : RULE_A 与 RULE_B 落在同一根 K（最近 bar 同时扫多个
 *                            liquidity identity：EQL/session + SWING/PD*）。
 *                            = 一次 raid 被 registry 挂了多个 identity，无争议、可归并。
 *
 *   DIFFERENT_BAR_DIVERGENCE: RULE_A 在更近的 bar（非 structural：EQL/session），
 *                            RULE_B 在较早的 bar（structural）。
 *                            = 真正的 attribution 决策样本：nearest raid 还是
 *                              nearest structural raid？需人眼/图确认。
 *
 * 复用 narrativeFanoutInspect.js 完全相同的 eligible / RULE_A / RULE_B 定义，
 * 仅把输出收窄为"35 个分歧 → 两类"，DIFFERENT_BAR 全量明细以供看图。
 *
 * 纪律：Detection 冻结、Bias Engine 不动、Outcome 不动、不调参数、不改 Formation。
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeFanoutDiverge.js [SYMBOL] [DAYS]
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

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

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for divergence split (A.1) ...');

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
            var legByMssId = {};
            Object.keys(legByDispId).forEach(function (did) {
                var leg = legByDispId[did];
                if (!leg || !leg.mssId) return;
                if (!legByMssId[leg.mssId]) legByMssId[leg.mssId] = [];
                legByMssId[leg.mssId].push(leg);
            });

            var sweeps = (result.sweepEvents || []).filter(function (s) {
                return (s.direction === 'BULLISH' || s.direction === 'BEARISH') && typeof s.candleIndex === 'number';
            }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

            var mssAll = (result.mssEvents || []).filter(function (m) {
                return m && (m.direction === 'BULLISH' || m.direction === 'BEARISH') && typeof m.candleIndex === 'number';
            }).slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; });

            function dispOf(m, D) {
                var leg = null;
                (legByMssId[m.id] || []).forEach(function (l) { if (l.direction === D) leg = l; });
                if (!leg) return '-';
                var sB = candles5m[leg.startIndex], eB = candles5m[leg.endIndex];
                var net = (leg.endIndex === leg.startIndex)
                    ? (eB.close - eB.open) : (eB.close - sB.close);
                var atr = leg.atr;
                var norm = (atr && atr > 0) ? net / atr : null;
                var dirOk = (D === 'BULLISH' && net > 0) || (D === 'BEARISH' && net < 0);
                return 'disp[' + leg.startIndex + '..' + leg.endIndex + '] bars=' +
                    (leg.endIndex - leg.startIndex + 1) + ' net=' + (net > 0 ? '+' : '') + net.toFixed(1) +
                    ' (' + (norm !== null ? (norm > 0 ? '+' : '') + norm.toFixed(2) + 'ATR' : '?') + ')' +
                    (dirOk ? ' DIR✓' : ' DIR✗');
            }

            // 反推簇 + 仅保留 RULE_A vs RULE_B 分歧簇，并分类
            var diverge = [];
            mssAll.forEach(function (m) {
                var Mi = m.candleIndex, D = m.direction;
                var prevSameDir = -Infinity;
                for (var k2 = 0; k2 < mssAll.length; k2++) {
                    if (mssAll[k2].candleIndex >= Mi) break;
                    if (mssAll[k2].direction === D) prevSameDir = mssAll[k2].candleIndex;
                }
                var eligible = sweeps.filter(function (s) {
                    return s.direction === D && s.candleIndex > prevSameDir && s.candleIndex < Mi;
                });
                if (eligible.length < 2) return;
                var nearest = eligible.reduce(function (a, b) { return b.candleIndex > a.candleIndex ? b : a; });
                var struct = eligible.filter(function (s) { return isStructural(s.source && s.source.liquidityType); });
                var structPick = struct.length
                    ? struct.reduce(function (a, b) { return b.candleIndex > a.candleIndex ? b : a; })
                    : nearest;
                if (nearest.id === structPick.id) return; // 不分歧，跳过
                diverge.push({
                    mss: m, dir: D, Mi: Mi, dispTxt: dispOf(m, D),
                    eligible: eligible, nearest: nearest, structPick: structPick,
                    sameBar: nearest.candleIndex === structPick.candleIndex
                });
            });

            var nSame = diverge.filter(function (c) { return c.sameBar; }).length;
            var nDiff = diverge.filter(function (c) { return !c.sameBar; }).length;

            console.log('\n=== Fan-out Divergence Split — Phase 1 Formation Fix A.1 (BTCUSDT ' + DAYS + 'd, futures) ===');
            console.log('RULE_A(最近) vs RULE_B(structural) 分歧簇总数 = ' + diverge.length);
            console.log('  SAME_BAR_DIVERGENCE     = ' + nSame + '  (最近 bar 同含 structural + EQL/session → 归并，无争议)');
            console.log('  DIFFERENT_BAR_DIVERGENCE= ' + nDiff + '  (更近 EQL/session vs 较早 structural → 真决策样本)');
            console.log('');
            console.log('RULE_A = eligible 中 candleIndex 最大（距 MSS 最近，任何 liquidity type）');
            console.log('RULE_B = eligible 中 structural(SWING*/PD*/PW*/PM*) 且 candleIndex 最大；无 structural→fallback RULE_A');
            console.log('SAME_BAR = RULE_A.bar === RULE_B.bar（同一次 raid 的多 identity）');
            console.log('DIFFERENT_BAR = RULE_A 在更近 bar(非 structural)，RULE_B 在较早 bar(structural)');
            console.log('');

            // ---- SAME_BAR 轻列 ----
            console.log('--- SAME_BAR_DIVERGENCE (' + nSame + ') — 可安全归并到 structural，附 alsoSwept ---');
            diverge.filter(function (c) { return c.sameBar; }).forEach(function (c, i) {
                var side = c.dir === 'BULLISH' ? 'SSL' : 'BSL';
                var aType = (c.nearest.source && c.nearest.source.liquidityType) || '?';
                var bType = (c.structPick.source && c.structPick.source.liquidityType) || '?';
                var aPx = (c.nearest.source && c.nearest.source.liquidityPrice) || c.nearest.price || 0;
                var bPx = (c.structPick.source && c.structPick.source.liquidityPrice) || c.structPick.price || 0;
                // 同 bar 扫的其他 liquidity identity
                var others = c.eligible.filter(function (s) {
                    return s.candleIndex === c.nearest.candleIndex && s.id !== c.nearest.id && s.id !== c.structPick.id;
                }).map(function (s) { return (s.source && s.source.liquidityType) || '?'; });
                console.log('  [S' + (i + 1) + '] MSS#' + c.mss.id + ' ' + c.dir + '(' + side + ') idx=' + c.Mi +
                    ' ' + fmt(c.mss.confirmedAt) + '  nearest=' + aType + (isStructural(aType) ? '*' : '') +
                    ' struct=' + bType + '*  pxΔ=' + Math.abs(aPx - bPx).toFixed(1) +
                    (others.length ? '  alsoSwept=[' + others.join(',') + ']' : ''));
            });
            console.log('');

            // ---- DIFFERENT_BAR 全量明细 ----
            console.log('--- DIFFERENT_BAR_DIVERGENCE (' + nDiff + ') — 真决策样本，全部列出供人工看图 ---');
            diverge.filter(function (c) { return !c.sameBar; }).forEach(function (c, i) {
                var side = c.dir === 'BULLISH' ? 'SSL' : 'BSL';
                var aType = (c.nearest.source && c.nearest.source.liquidityType) || '?';
                var bType = (c.structPick.source && c.structPick.source.liquidityType) || '?';
                var aPx = (c.nearest.source && c.nearest.source.liquidityPrice) || c.nearest.price || 0;
                var bPx = (c.structPick.source && c.structPick.source.liquidityPrice) || c.structPick.price || 0;
                var aBars = c.Mi - c.nearest.candleIndex;
                var bBars = c.Mi - c.structPick.candleIndex;
                var gap = c.nearest.candleIndex - c.structPick.candleIndex;
                console.log('[D' + (i + 1) + '] MSS#' + c.mss.id + ' ' + c.dir + '(' + side + ') idx=' + c.Mi +
                    ' ' + fmt(c.mss.confirmedAt) + '  ' + c.dispTxt);
                console.log('      A(nearest)     idx=' + c.nearest.candleIndex + ' ' + fmt(c.nearest.confirmedAt) +
                    ' ' + aType + (isStructural(aType) ? '*' : '') + ' px=' + aPx.toFixed(1) + ' bars=' + aBars + '  <-- 更近·非 structural');
                console.log('      B(struct)      idx=' + c.structPick.candleIndex + ' ' + fmt(c.structPick.confirmedAt) +
                    ' ' + bType + '* px=' + bPx.toFixed(1) + ' bars=' + bBars + '  <-- 较早·structural');
                console.log('      gap = ' + gap + ' bars (structural 比 nearest raid 早 ' + gap + ' 根 5m)');
                // 全 eligible 列表（按 bar 升序），A/B 标注
                c.eligible.slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; }).forEach(function (s) {
                    var lt = (s.source && s.source.liquidityType) || '?';
                    var lp = (s.source && s.source.liquidityPrice) || s.price || 0;
                    var bars = c.Mi - s.candleIndex;
                    var tag = (s.id === c.nearest.id) ? 'A' : (s.id === c.structPick.id ? 'B' : ' ');
                    console.log('         raid idx=' + s.candleIndex + ' ' + fmt(s.confirmedAt) + ' ' +
                        (lt + (isStructural(lt) ? '*' : '')) + ' px=' + lp.toFixed(1) + ' bars=' + bars +
                        (tag !== ' ' ? '  <' + tag + '>' : ''));
                });
                console.log('      → decision: nearest(A, ' + aType + ')  OR  nearest-structural(B, ' + bType + ') ?');
                console.log('');
            });

            console.log('（* = structural；<A>=RULE_A 最近 <B>=RULE_B 最近 structural）');
            console.log('结论待定：SAME_BAR 直接归并 structural；DIFFERENT_BAR 逐条/抽样人眼看图后定 rule。');
        });
    })
    .catch(function (error) {
        console.error('DIVERGE SPLIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
