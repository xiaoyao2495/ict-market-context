/**
 * Bias Phase 1 — Formation Fix A.1b（纯只读，不改任何算法）
 *
 * 目的：对 A.1 拆出的 DIFFERENT_BAR 分歧簇，进一步锁定"material case"
 * （A=更近 EQL/session，B=较早 structural，两者指不同流动性事件），
 * 并对每个 material case 做 B→A→MSS→Disp 的 OHLC 事件链审计，
 * 以便逐条回答四个问题：
 *   Q1 A raid 是否真实 sweep（非普通穿越/重复标签）
 *   Q2 B raid（更早 structural swing）是否真被 raid
 *   Q3 B→A→MSS 之间价格做了什么（最关键的 causal 判断）
 *   Q4 删 A 或删 B 后 ICT narrative 是否仍成立（反事实）
 *
 * 复用 narrativeFanoutDiverge.js 完全一致的 eligible / RULE_A / RULE_B 定义，
 * 仅新增：materiality 计算 + 全量 OHLC 事件链 dump。
 *
 * 纪律：Detection 冻结、Bias Engine 不动、Outcome 不动、不调参数、不改 Formation。
 *
 * 用法：ARCHIVED_DIRECTIONAL_CHANGE=1 node scripts/narrativeFanoutChain.js [SYMBOL] [DAYS]
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = 12;
if (!process.env.ARCHIVED_DIRECTIONAL_CHANGE) process.env.ARCHIVED_DIRECTIONAL_CHANGE = '1';

// materiality 阈值（A 与 B 是否指"不同流动性事件"）
//   priceGapNorm = |A.price - B.price| / atr(在该 MSS 处)
//   barsGap      = A.bar - B.bar
var MAT_PRICE_NORM = 0.15; // 价格分离 > 0.15 ATR 视为 material
var MAT_BARS_GAP = 12;     // 或两 raid 时间间隔 > 12 根 5m 视为 material

function isStructural(t) {
    if (!t) return false;
    if (t.indexOf('SWING') >= 0) return true;
    return ['PDH', 'PDL', 'PWH', 'PWL', 'PMH', 'PML'].indexOf(t) >= 0;
}
function fmt(ms) {
    return ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-';
}
function hm(ms) {
    if (!ms) return '--:--';
    var d = new Date(ms);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2);
}
function num(x) { return (x === undefined || x === null) ? NaN : parseFloat(x); }

// 简单 ATR(14) @ index i（用 5m true range）
function atrAt(candles, i) {
    var n = 14, trs = [];
    for (var k = Math.max(1, i - n + 1); k <= i; k++) {
        var c = candles[k], p = candles[k - 1];
        if (!c || !p) continue;
        var tr = Math.max(num(c.high) - num(c.low),
            Math.abs(num(c.high) - num(p.close)),
            Math.abs(num(c.low) - num(p.close)));
        trs.push(tr);
    }
    if (!trs.length) return NaN;
    var s = 0; trs.forEach(function (x) { s += x; });
    return s / trs.length;
}

var endTime = process.env.BACKTEST_END_MS !== undefined
    ? parseInt(process.env.BACKTEST_END_MS, 10) : Date.now();
var startTime = endTime - DAYS * 24 * 3600 * 1000;

console.log('Loading ' + SYMBOL + ' futures data (' + DAYS + 'd) for A.1b chain audit ...');

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
                if (!leg) return { txt: '-', leg: null };
                var sB = candles5m[leg.startIndex], eB = candles5m[leg.endIndex];
                var net = (leg.endIndex === leg.startIndex)
                    ? (num(eB.close) - num(eB.open)) : (num(eB.close) - num(sB.close));
                var atr = leg.atr;
                var norm = (atr && atr > 0) ? net / atr : null;
                var dirOk = (D === 'BULLISH' && net > 0) || (D === 'BEARISH' && net < 0);
                return {
                    txt: 'disp[' + leg.startIndex + '..' + leg.endIndex + '] bars=' +
                        (leg.endIndex - leg.startIndex + 1) + ' net=' + (net > 0 ? '+' : '') + net.toFixed(1) +
                        ' (' + (norm !== null ? (norm > 0 ? '+' : '') + norm.toFixed(2) + 'ATR' : '?') + ')' +
                        (dirOk ? ' DIR✓' : ' DIR✗'),
                    leg: leg
                };
            }

            // 反推 DIFFERENT_BAR 簇（与 A.1 完全一致）
            var diffCases = [];
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
                if (nearest.id === structPick.id) return; // 不分歧
                if (nearest.candleIndex === structPick.candleIndex) return; // SAME_BAR，非本步对象
                diffCases.push({
                    mss: m, dir: D, Mi: Mi, eligible: eligible,
                    A: nearest, B: structPick
                });
            });

            // 计算 materiality
            diffCases.forEach(function (c) {
                var aPx = num((c.A.source && c.A.source.liquidityPrice) || c.A.price || 0);
                var bPx = num((c.B.source && c.B.source.liquidityPrice) || c.B.price || 0);
                var atr = (legByMssId[c.mss.id] && legByMssId[c.mss.id][0] && legByMssId[c.mss.id][0].atr)
                    || atrAt(candles5m, c.Mi);
                c.atr = atr;
                c.aPx = aPx; c.bPx = bPx;
                c.priceGapNorm = (atr && atr > 0) ? Math.abs(aPx - bPx) / atr : NaN;
                c.barsGap = c.A.candleIndex - c.B.candleIndex;
                c.material = (c.priceGapNorm > MAT_PRICE_NORM) || (c.barsGap > MAT_BARS_GAP);
            });

            var nMat = diffCases.filter(function (c) { return c.material; }).length;
            console.log('\n=== A.1b OHLC Event-Chain Audit (BTCUSDT ' + DAYS + 'd, futures) ===');
            console.log('DIFFERENT_BAR 簇 = ' + diffCases.length);
            console.log('material case (价格分离>' + MAT_PRICE_NORM + 'ATR 或 间隔>' + MAT_BARS_GAP + 'bars) = ' + nMat);
            console.log('');
            console.log('Q1/Q2 辅助：REAL_SWEEP(coarse)= 该 raid 蜡烛是否在前 24 根同方向极值之外（仅提示，liquidity 目标可能更老）');
            console.log('Q3 辅助：B→A / A→MSS / MSS→Disp 净移动（按叙事方向 + 为涨 / - 为跌）');
            console.log('Q4 辅助：移除 A 后 / 移除 B 后 eligible 数与是否仍含 structural');
            console.log('');

            // 全 DIFFERENT_BAR 一行索引（material 标注）
            console.log('--- DIFFERENT_BAR index (all ' + diffCases.length + ') ---');
            diffCases.forEach(function (c, i) {
                var side = c.dir === 'BULLISH' ? 'SSL' : 'BSL';
                var aT = (c.A.source && c.A.source.liquidityType) || '?';
                var bT = (c.B.source && c.B.source.liquidityType) || '?';
                console.log('  [D' + (i + 1) + '] ' + (c.material ? '★MAT ' : '     ') + 'MSS#' + c.mss.id + ' ' +
                    c.dir + '(' + side + ') ' + fmt(c.mss.confirmedAt) +
                    '  A=' + aT + '@' + c.aPx.toFixed(1) + '(' + (c.Mi - c.A.candleIndex) + 'b)' +
                    '  B=' + bT + '@' + c.bPx.toFixed(1) + '(' + (c.Mi - c.B.candleIndex) + 'b)' +
                    '  pxGap=' + (isNaN(c.priceGapNorm) ? '?' : c.priceGapNorm.toFixed(2)) + 'ATR' +
                    '  barsGap=' + c.barsGap);
            });
            console.log('');

            // ---- material case 全量 OHLC 事件链 ----
            console.log('=== MATERIAL CASES — B→A→MSS→Disp 事件链 ===');
            diffCases.filter(function (c) { return c.material; }).forEach(function (c, mi) {
                var side = c.dir === 'BULLISH' ? 'SSL' : 'BSL';
                var D = c.dir;
                var aIdx = c.A.candleIndex, bIdx = c.B.candleIndex, mIdx = c.Mi;
                var d = dispOf(c.mss, D);
                var dLeg = d.leg;
                var dStart = dLeg ? dLeg.startIndex : mIdx;
                var dEnd = dLeg ? dLeg.endIndex : mIdx;

                // 真实扫单粗判（前 24 根同方向极值）
                function realSweep(s) {
                    var i = s.candleIndex;
                    if (i < 24) return '?';
                    var c0 = candles5m[i];
                    if (D === 'BULLISH') { // SSL raid：向下扫 → low 破前 24 低
                        var pre = Infinity;
                        for (var k = i - 24; k < i; k++) if (candles5m[k]) pre = Math.min(pre, num(candles5m[k].low));
                        return num(c0.low) < pre ? '✓real' : '✗tag';
                    } else { // BSL raid：向上扫 → high 破前 24 高
                        var preH = -Infinity;
                        for (var k2 = i - 24; k2 < i; k2++) if (candles5m[k2]) preH = Math.max(preH, num(candles5m[k2].high));
                        return num(c0.high) > preH ? '✓real' : '✗tag';
                    }
                }

                // 净移动
                function move(i0, i1) {
                    if (i0 < 0 || i1 < 0 || !candles5m[i0] || !candles5m[i1]) return '?';
                    var p0 = (D === 'BULLISH') ? num(candles5m[i0].low) : num(candles5m[i0].high);
                    var p1 = (D === 'BULLISH') ? num(candles5m[i1].high) : num(candles5m[i1].low);
                    return (p1 - p0 > 0 ? '+' : '') + (p1 - p0).toFixed(1);
                }
                var bA = move(bIdx, aIdx), aM = move(aIdx, mIdx), mD = (dLeg ? move(mIdx, dLeg.endIndex) : '?');

                // 去 A / 去 B 后 eligible
                var afterRmA = c.eligible.filter(function (s) { return s.id !== c.A.id; });
                var afterRmB = c.eligible.filter(function (s) { return s.id !== c.B.id; });
                var hasStructAfterA = afterRmA.some(function (s) { return isStructural(s.source && s.source.liquidityType); });
                var nearestAfterB = afterRmB.length
                    ? afterRmB.reduce(function (a, b) { return b.candleIndex > a.candleIndex ? b : a; }) : null;
                var nearestAfterBtype = nearestAfterB ? ((nearestAfterB.source && nearestAfterB.source.liquidityType) || '?') : '-';

                console.log('\n────────────────────────────────────────────────────────');
                console.log('★MAT#' + (mi + 1) + '  MSS#' + c.mss.id + ' ' + D + '(' + side + ') ' + fmt(c.mss.confirmedAt) +
                    '  ATR≈' + (isNaN(c.atr) ? '?' : c.atr.toFixed(1)));
                console.log('  A(nearest,非structural): ' + ((c.A.source && c.A.source.liquidityType) || '?') +
                    ' @' + c.aPx.toFixed(1) + ' idx=' + aIdx + ' (' + (c.Mi - aIdx) + 'b before MSS)  REAL_SWEEP=' + realSweep(c.A));
                console.log('  B(structural)         : ' + ((c.B.source && c.B.source.liquidityType) || '?') +
                    ' @' + c.bPx.toFixed(1) + ' idx=' + bIdx + ' (' + (c.Mi - bIdx) + 'b before MSS)  REAL_SWEEP=' + realSweep(c.B));
                console.log('  Disp: ' + d.txt);
                console.log('  Q3 价格序列 (按叙事方向: +涨/-跌): B→A=' + bA + '  A→MSS=' + aM + '  MSS→Disp=' + mD);
                console.log('  Q4 反事实: 删A后 eligible=' + afterRmA.length + ' (仍含structural=' + hasStructAfterA + ')' +
                    ' | 删B后 nearest=' + nearestAfterBtype + ' (无B时最近raid退化为A或其等价)');
                console.log('  全 eligible raids (按 bar 升序):');
                c.eligible.slice().sort(function (a, b) { return a.candleIndex - b.candleIndex; }).forEach(function (s) {
                    var lt = (s.source && s.source.liquidityType) || '?';
                    var lp = (s.source && s.source.liquidityPrice) || s.price || 0;
                    var tag = (s.id === c.A.id) ? 'A' : (s.id === c.B.id ? 'B' : ' ');
                    console.log('     idx=' + s.candleIndex + ' ' + fmt(s.confirmedAt) + ' ' +
                        (lt + (isStructural(lt) ? '*' : '')) + ' px=' + num(lp).toFixed(1) +
                        ' bars=' + (c.Mi - s.candleIndex) + (tag !== ' ' ? '  <' + tag + '>' : ''));
                });

                // OHLC 事件链：B-2 .. Disp.end+1（cap 70，超则锚定三段）
                var startIdx = Math.min(bIdx, aIdx) - 2;
                var endIdx = Math.max(mIdx, dEnd) + 1;
                var total = endIdx - startIdx + 1;
                console.log('  B→A→MSS→Disp OHLC 事件链 (5m):');
                if (total <= 70) {
                    dumpStrip(candles5m, startIdx, endIdx, bIdx, aIdx, mIdx, dStart, dEnd, D);
                } else {
                    console.log('    [窗口 ' + total + ' 根 > 70，改锚定三段]');
                    console.log('    -- B 附近 --');
                    dumpStrip(candles5m, bIdx - 2, bIdx + 4, bIdx, aIdx, mIdx, dStart, dEnd, D);
                    console.log('    -- A→MSS --');
                    dumpStrip(candles5m, aIdx - 4, mIdx + 2, bIdx, aIdx, mIdx, dStart, dEnd, D);
                    console.log('    -- MSS→Disp --');
                    dumpStrip(candles5m, mIdx - 1, dEnd + 1, bIdx, aIdx, mIdx, dStart, dEnd, D);
                }
            });

            console.log('\n（★MAT = material case；* = structural；<A>=最近raid <B>=最近structural；' +
                'REAL_SWEEP=粗判前24根极值；Q3/Q4 见上）');
            console.log('结论待定：material case 逐条人眼核对后，定 1:1 attribution rule（nearest / nearest-structural / causal-sequence）。');
        });
    })
    .catch(function (error) {
        console.error('A.1b CHAIN AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });

function dumpStrip(candles5m, from, to, bIdx, aIdx, mIdx, dStart, dEnd, D) {
    for (var i = from; i <= to; i++) {
        var c = candles5m[i];
        if (!c) continue;
        var o = num(c.open), h = num(c.high), l = num(c.low), cl = num(c.close);
        var marks = [];
        if (i === bIdx) marks.push('[B-RAID]');
        if (i === aIdx) marks.push('[A-RAID]');
        if (i === mIdx) marks.push('[MSS]');
        if (i === dStart) marks.push('[DISP>]');
        if (i === dEnd) marks.push('[<DISP]');
        var body = (D === 'BULLISH')
            ? (cl >= o ? '▲' : '▼') : (cl >= o ? '▲' : '▼');
        console.log('    c[' + i + '] ' + hm(c.openTime) + ' O=' + o.toFixed(1) + ' H=' + h.toFixed(1) +
            ' L=' + l.toFixed(1) + ' C=' + cl.toFixed(1) + ' ' + body + (marks.length ? ' ' + marks.join('') : ''));
    }
}
