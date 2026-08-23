/**
 * Phase 11L.17 — Equal Liquidity Quality Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/equalLiquidityAudit.js BTCUSDT 90
 *
 * 主表：母样本 = 全部 EQL/EQH 类 LIQUIDITY_SWEEP。
 *   对每个被扫的 EQL/EQH level，用 sweep 时点已知信息判定 6 个透明维度（不合成总分）：
 *     touchCount / clusterWidth / formationSpan / ageBeforeSweep / reactionStrength / cleanliness
 *   输出：
 *     A. 每维度 true vs false 的后续 delivery 指标（MSS / protectedMSS / StrongLeg / HIGH / MFE / MAE）
 *     B. 维度命中数分布 0..6 → forward 曲线（是否单调）
 *
 * 附录：excursionV2（11L.16 修正版，诊断补充，非主线）
 *   母样本 = SWING 类 sweep；修正三处：① 窗口不含 sweep K；② ATR(14) 分母（True Range 均值）
 *   替代平均 candle range；③ <2 / 2-3 / >=3 ATR 三桶。
 *
 * 决策框架（用户）：2-touch loose EQL HIGH ~8% vs 3+ touch clean EQL HIGH ~18%+ → 找到
 *   Liquidity Object Quality；否则维持现状。纯诊断，生产 detector 零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var displacementLeg = require('../stats/displacementLeg');
var opportunity = require('../stats/opportunity');
var alertReplay = require('../stats/alertReplay');
var equalLiquidityAudit = require('../stats/equalLiquidityAudit');
var sweepCentricAudit = require('../stats/sweepCentricAudit');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var DAYS = parseInt(process.argv[3] || '90', 10);
var SNAPSHOT_INTERVAL = process.env.SNAPSHOT_INTERVAL !== undefined
    ? parseInt(process.env.SNAPSHOT_INTERVAL, 10)
    : 12;
var RIGHT = 2;

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
                result.displacementEvents || [], candles || [],
                result.mssEvents || [], result.swings || []);
            var opps = opportunity.buildOpportunities(result.symbol, result.fvgs || [], {
                DISPLACEMENT: result.displacementEvents || [],
                MSS: result.mssEvents || []
            });
            var alerts = alertReplay.buildAlerts(opps, result.fvgs || [], legByDispId,
                result.drawTrace || [], result.sweepEvents || [], candles || [], result.mssEvents || []);

            function printRow(label, g) {
                var mss = g.n > 0 ? pct(g.mss / g.n) : '-';
                var prot = g.n > 0 ? pct(g.protectedMss / g.n) : '-';
                var sl = g.n > 0 ? pct(g.strongLeg / g.n) : '-';
                var high = g.n > 0 ? pct(g.high / g.n) : '-';
                var mfe = g.mfeCnt > 0 ? (g.mfeSum / g.mfeCnt).toFixed(2) : '-';
                var mae = g.mfeCnt > 0 ? (g.maeSum / g.mfeCnt).toFixed(2) : '-';
                console.log(pad(label, 22) + pad(g.n, 6) + pad(mss, 9) + pad(prot, 10) + pad(sl, 10) + pad(high, 9) + pad(mfe, 8) + pad(mae, 8));
            }
            function printHeader() {
                console.log(pad('Group', 22) + pad('n', 6) + pad('MSS', 9) + pad('protMSS', 10) + pad('StrongLeg', 10) + pad('HIGH', 9) + pad('MFE', 8) + pad('MAE', 8));
            }

            // ============ 主表：EQL/EQH Quality ============
            var res = equalLiquidityAudit.auditEqualLiquidity({
                sweepEvents: result.sweepEvents || [],
                equalLiquidity: result.equalLiquidity || [],
                mssEvents: result.mssEvents || [],
                swings: result.swings || [],
                displacementEvents: result.displacementEvents || [],
                legByDispId: legByDispId,
                alerts: alerts,
                candles: candles,
                tickSize: data.exchangeInfo.tickSize
            });

            console.log('');
            console.log('EQUAL LIQUIDITY QUALITY AUDIT (Phase 11L.17, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('母样本 = EQL/EQH 类 sweep ' + res.nTotal + ' 笔（unresolved ' + res.unresolved + '）；窗口 1h');
            console.log('维度判定窗口 = level 形成（最后成员确认）时点已知 → sweep 发生（无 future leakage）');
            console.log('诊断参数：widthLooseRatio=' + res.cfg.widthLooseRatio + ' spanBarsMin=' + res.cfg.spanBarsMin +
                ' ageBarsMin=' + res.cfg.ageBarsMin + ' reactionBars=' + res.cfg.reactionBars +
                ' reactionAtrMin=' + res.cfg.reactionAtrMin);
            console.log('');
            console.log('=== A. 每维度 true vs false（n / MSS / protMSS / StrongLeg / HIGH / MFE / MAE） ===');
            printHeader();
            res.dims.forEach(function (d) {
                var s = res.dimensionStats[d];
                printRow(d + '=true', s.t);
                printRow(d + '=false', s.f);
            });
            console.log('');
            console.log('=== B. 维度命中数分布（0..6 → forward，看单调性） ===');
            printHeader();
            for (var h = 0; h <= 6; h++) {
                printRow(h + '/6 dims', res.countDist[h]);
            }
            console.log('');
            console.log('=== C. Quality Gate 组合（tight + young + clean，0/3 → 3/3） ===');
            printHeader();
            for (var q = 0; q <= 3; q++) {
                printRow(q + '/3 quality', res.qualityDist[q]);
            }
            console.log('');
            console.log('解读：');
            console.log('  - 某维度 true 的 HIGH/MSS 显著强于 false → 该质量特征有区分力，可纳入 Liquidity Qualification');
            console.log('  - 命中数 0-2 vs 5-6 若单调上升 → "2-touch loose" vs "3+ touch clean" 差距真实，');
            console.log('    后续可收窄 Significant 口径（通知层净化）');
            console.log('  - C 表 0/3 → 3/3 若单调（如 6% → 20%）→ EQL/EQH Quality Gate 成立（可硬过滤）；');
            console.log('    若仅微弱抬升（9% → 14%）→ 只适合 priority 加分，不适合硬过滤');
            console.log('  - 若全维度无差异 → EQL/EQH 升级 Significant 跃迁无大害，维持现状');
            console.log('  - 纯诊断：equalLiquidity / lifecycle / MSS / 通知全部零判定改动');
            console.log('');

            // ============ 附录：excursionV2（11L.16 修正，SWING 母样本） ============
            console.log('--- 附录：excursionV2（11L.16 修正版，诊断补充） ---');
            var swingsById = {};
            (result.swings || []).forEach(function (s) { if (s && s.id) swingsById[s.id] = s; });
            var idxByClose = {};
            candles.forEach(function (c, i) { if (c && typeof c.closeTime === 'number') idxByClose[c.closeTime] = i; });
            var idx = sweepCentricAudit.buildOutcomeIndex({
                mssEvents: result.mssEvents || [],
                displacementEvents: result.displacementEvents || [],
                alerts: alerts,
                swings: result.swings || [],
                legByDispId: legByDispId,
                candles: candles
            });

            function trueRange(c, prev) {
                if (!prev) return c.high - c.low;
                return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
            }
            function atr14At(candles, upTo) {
                // 截止 upTo（含）的前 14 根 TR 均值
                var sum = 0;
                var n = 0;
                for (var j = upTo; j >= 0 && n < 14; j--) {
                    var c = candles[j];
                    if (!c) continue;
                    sum += trueRange(c, candles[j - 1]);
                    n++;
                }
                return n > 0 ? sum / n : 0;
            }
            function swingIdx(s) {
                if (s && s.metadata && typeof s.metadata.index === 'number') return s.metadata.index;
                if (s && typeof s.confirmedAt === 'number' && idxByClose[s.confirmedAt] !== undefined) return idxByClose[s.confirmedAt];
                return null;
            }
            function excursionV2Atr(swing, se) {
                var pivotIdx = swingIdx(swing);
                if (pivotIdx === null || typeof se.candleIndex !== 'number') return null;
                var isLow = swing.type === 'SWING_LOW';
                var maxFar = 0;
                for (var j = pivotIdx + 1; j < se.candleIndex; j++) { // 不含 sweep K
                    var c = candles[j];
                    if (!c) continue;
                    if (isLow) {
                        if (c.high - swing.price > maxFar) maxFar = c.high - swing.price;
                    } else {
                        if (swing.price - c.low > maxFar) maxFar = swing.price - c.low;
                    }
                }
                var atr = atr14At(candles, se.candleIndex - 1);
                return atr > 0 ? maxFar / atr : null;
            }

            var buckets = { lt2: { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 },
                            m2to3: { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 },
                            ge3: { n: 0, mss: 0, protectedMss: 0, strongLeg: 0, high: 0, mfeSum: 0, maeSum: 0, mfeCnt: 0 } };
            var nSwing = 0;
            var unresSwing = 0;
            function addB(b, o) {
                b.n++;
                if (o.mss) b.mss++;
                if (o.protectedMss) b.protectedMss++;
                if (o.strongLeg) b.strongLeg++;
                if (o.high) b.high++;
                if (o.counted) { b.mfeSum += o.mfePct; b.maeSum += o.maePct; b.mfeCnt++; }
            }
            (result.sweepEvents || []).forEach(function (se) {
                var st = (se.source && se.source.liquidityType) || se.liquidityType;
                if (!sweepCentricAudit.isSwingType(st)) return;
                nSwing++;
                var swing = swingsById[se.liquidityId] || null;
                var o = sweepCentricAudit.computeSweepOutcomes(se, idx);
                if (!swing || !o) { unresSwing++; return; }
                var r = excursionV2Atr(swing, se);
                if (r === null) { unresSwing++; return; }
                if (r < 2) addB(buckets.lt2, o);
                else if (r < 3) addB(buckets.m2to3, o);
                else addB(buckets.ge3, o);
            });
            console.log('母样本 = SWING 类 sweep ' + nSwing + ' 笔（unresolved ' + unresSwing + '）；' +
                '不含 sweep K；ATR(14) 分母；分桶 <2 / 2-3 / >=3 ATR');
            printHeader();
            printRow('<2 ATR', buckets.lt2);
            printRow('2-3 ATR', buckets.m2to3);
            printRow('>=3 ATR', buckets.ge3);
            console.log('');
            console.log('解读：excursion 桶间差异 = "pivot 后最大远离（不含 sweep K，ATR 归一）"的增量价值；');
            console.log('  仅为 11L.16 死维度的修正复核，非主线（Liquidity Quality 主线见主表）。');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('EQUAL LIQUIDITY QUALITY AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
