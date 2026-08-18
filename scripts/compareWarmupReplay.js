/**
 * compareWarmupReplay（Phase 11R.2 — State Convergence Audit）
 *
 * 定位：同一个目标窗口，不同 warmup 长度下，状态到底从哪一根 K 开始分叉。
 *
 * 机制：
 *   - 加载 (targetDays + maxWarmupDays) 天数据（一次）
 *   - 对每个 warmupDays [30, 60, 90]：fullWarmup 从各自起点推进（不记录正式 steps），
 *     目标窗口起点 = 最后 targetDays 天前
 *   - 逐根记录 fingerprint：amdState/amdDirection/accumulationId/manipulationEventId/
 *     distributionEventId/biasDirection/drawDirection/scenarioState/activeLiquidityCount/
 *     eventCount/fvgCount
 *   - 逐根对比 3 组 → 找 FIRST DIVERGENCE（第一根字段不同的 K）
 *   - 输出 FIRST DIVERGENCE ±50 bars 的 AMD/MSS/事件明细，供人工定位原因
 *
 * 性能：snapshotInterval 用大值（首根 snapshot 后不再刷新 bias/draw——它们不是
 * AMD 分叉的输入，AMD 不依赖 draw）；主要成本在 incrementalLiquidity 全量 pivot。
 *
 * 用法：
 *   node scripts/compareWarmupReplay.js BTCUSDT          # target 30d, warmups 30,60,90
 *   WARMUP_TARGET=14 WARMUPS=30,60 node scripts/compareWarmupReplay.js BTCUSDT
 *
 * IMPORTANT: 诊断脚本，不改变正式规则。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var TARGET_DAYS = parseInt(process.env.WARMUP_TARGET || '30', 10);
var WARMUPS = (process.env.WARMUPS || '30,60,90').split(',').map(function (s) { return parseInt(s, 10); });
var MAX_WARMUP = Math.max.apply(null, WARMUPS);
var BARS_PER_DAY = 288;

var BAR_MS = 300000;

function fingerprintOf(step) {
    var acc = step.amdAccumulation;
    return {
        amdState: step.amdState,
        amdDirection: step.amdDirection || null,
        accumulationId: acc ? (acc.confirmedAt + '|' + acc.rangeLow + '-' + acc.rangeHigh) : null,
        manipulationEventId: step.amdManipulationEventId || null,
        distributionEventId: step.amdDistributionEventId || null,
        biasDirection: step.biasDirection,
        drawDirection: step.drawDirection,
        scenarioState: step.scenarioState,
        activeLiquidityCount: step.activeLiquidityCount,
        eventCount: step.eventCount,
        fvgCount: step.fvgCount,
        consumedRefsCount: step.consumedRefsCount
    };
}

function fingerprintKey(fp) {
    return [
        fp.amdState, fp.amdDirection, fp.accumulationId,
        fp.manipulationEventId, fp.distributionEventId,
        fp.biasDirection, fp.drawDirection, fp.scenarioState,
        fp.activeLiquidityCount, fp.eventCount, fp.fvgCount,
        fp.consumedRefsCount
    ].join('|');
}

function runWithWarmup(data, warmupDays) {
    var startIndex = warmupDays * BARS_PER_DAY;
    return replayEngine.runReplay({
        symbol: SYMBOL,
        candles5m: data['5m'],
        structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
        calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
        exchangeInfo: data.exchangeInfo,
        startIndex: startIndex,
        // snapshotInterval 大值：bias/draw 首根刷新后不再重算（AMD 不依赖 draw）
        snapshotInterval: 1000000000,
        logEvery: 1000000000
    }, {
        fullWarmup: true,
        onStep: function () {}
    });
}

var endTime = Date.now();
var startTime = endTime - (TARGET_DAYS + MAX_WARMUP) * 24 * 3600 * 1000;

console.log('========================================');
console.log('COMPARE WARMUP REPLAY  ' + SYMBOL +
    '  target ' + TARGET_DAYS + 'd  warmups [' + WARMUPS.join(',') + ']d');
console.log('loading ' + (TARGET_DAYS + MAX_WARMUP) + 'd (' +
    new Date(startTime).toISOString().slice(0, 10) + ' -> ' + new Date(endTime).toISOString().slice(0, 10) + ') ...');

var t0 = Date.now();
historicalLoader.loadAll(SYMBOL, startTime, endTime)
    .then(function (data) {
        console.log('loaded in ' + Math.round((Date.now() - t0) / 1000) + 's, ' + data['5m'].length + ' bars');
        var tasks = WARMUPS.map(function (w) { return runWithWarmup(data, w); });
        return Promise.all(tasks).then(function (results) {
            var rows = {};
            WARMUPS.forEach(function (w, idx) { rows[w] = results[idx]; });
            return rows;
        });
    })
    .then(function (rows) {
        console.log('replays done in ' + Math.round((Date.now() - t0) / 1000) + 's');
        console.log('');

        // ---- STATE FINGERPRINT at target window start ----
        console.log('TARGET START STATE (first bar of target window)');
        WARMUPS.forEach(function (w) {
            var s = rows[w].steps[0];
            console.log('  warmup ' + w + 'd: AMD ' + s.amdState + (s.amdDirection ? ' ' + s.amdDirection : '') +
                (s.amdAccumulation ? ' range ' + s.amdAccumulation.rangeLow + '-' + s.amdAccumulation.rangeHigh : '') +
                ' | bias ' + s.biasDirection + ' | draw ' + s.drawDirection +
                ' | scenario ' + s.scenarioState + ' | liq ' + s.activeLiquidityCount +
                ' | events ' + s.eventCount + ' | fvg ' + s.fvgCount);
        });
        console.log('');

        // ---- FIRST DIVERGENCE ----
        var ref = WARMUPS[0];
        var firstDivergence = null;
        var stepsRef = rows[ref].steps;
        var n = stepsRef.length;
        var i;
        for (i = 0; i < n; i++) {
            var fpRef = fingerprintOf(stepsRef[i]);
            var diverge = false;
            var divergeDetail = {};
            WARMUPS.forEach(function (w) {
                if (w === ref) return;
                var s = rows[w].steps[i];
                if (!s) return;
                var fp = fingerprintOf(s);
                var kRef = fingerprintKey(fpRef);
                var k = fingerprintKey(fp);
                if (k !== kRef) {
                    diverge = true;
                    divergeDetail[w] = { fpRef: fpRef, fp: fp, kRef: kRef, k: k };
                }
            });
            if (diverge) {
                firstDivergence = { index: i, step: stepsRef[i], detail: divergeDetail };
                break;
            }
        }

        if (!firstDivergence) {
            console.log('FIRST DIVERGENCE: NONE — fingerprints identical across all warmups in target window.');
            console.log('========================================');
            return;
        }

        var fs = firstDivergence.step;
        console.log('FIRST DIVERGENCE: bar index ' + fs.index + ' @ ' +
            new Date(fs.evaluationTime).toISOString().slice(0, 16).replace('T', ' '));
        console.log('  reference (warmup ' + ref + 'd): ' + fingerprintKey(fingerprintOf(fs)));
        Object.keys(firstDivergence.detail).forEach(function (w) {
            var d = firstDivergence.detail[w];
            var diffs = [];
            Object.keys(d.fpRef).forEach(function (k) {
                if (d.fpRef[k] !== d.fp[k]) {
                    diffs.push(k + ': ' + d.fpRef[k] + ' -> ' + d.fp[k]);
                }
            });
            console.log('  warmup ' + w + 'd differs: ' + diffs.join(' ; '));
        });
        console.log('');

        // ---- DIVERGENCE RATE ----
        var divergedBars = 0;
        var amdDivergedBars = 0; // AMD-only 分叉（状态机本身）
        var firstAmdDivergence = null;
        for (i = 0; i < n; i++) {
            var kRef = fingerprintKey(fingerprintOf(stepsRef[i]));
            var fpRefAmd = fingerprintOf(stepsRef[i]);
            var any = false;
            var amdAny = false;
            WARMUPS.forEach(function (w) {
                if (w === ref) return;
                var s = rows[w].steps[i];
                if (!s) return;
                if (fingerprintKey(fingerprintOf(s)) !== kRef) any = true;
                var fp = fingerprintOf(s);
                if (
                    fp.amdState !== fpRefAmd.amdState ||
                    fp.amdDirection !== fpRefAmd.amdDirection ||
                    fp.accumulationId !== fpRefAmd.accumulationId ||
                    fp.manipulationEventId !== fpRefAmd.manipulationEventId ||
                    fp.distributionEventId !== fpRefAmd.distributionEventId
                ) {
                    amdAny = true;
                }
            });
            if (any) divergedBars++;
            if (amdAny) {
                amdDivergedBars++;
                if (!firstAmdDivergence) {
                    firstAmdDivergence = stepsRef[i];
                }
            }
        }
        console.log('DIVERGENCE RATE (full fingerprint): ' + divergedBars + ' / ' + n + ' = ' +
            (divergedBars / n * 100).toFixed(1) + '% of target-window bars differ from ref');
        console.log('DIVERGENCE RATE (AMD-only state):  ' + amdDivergedBars + ' / ' + n + ' = ' +
            (amdDivergedBars / n * 100).toFixed(1) + '%');
        if (firstAmdDivergence) {
            var fad = firstAmdDivergence;
            var acc = fad.amdAccumulation;
            console.log('FIRST AMD DIVERGENCE: bar ' + fad.index + ' @ ' +
                new Date(fad.evaluationTime).toISOString().slice(0, 16).replace('T', ' '));
            console.log('  ref AMD: ' + fad.amdState + (fad.amdDirection ? ' ' + fad.amdDirection : ''));
            console.log('    accumulation: ' + (acc ? (acc.rangeLow + '-' + acc.rangeHigh + ' @ ' + new Date(acc.confirmedAt).toISOString().slice(0, 16).replace('T', ' ')) : 'none'));
            console.log('    manipulation: ' + (fad.amdManipulationEventId || 'none'));
            console.log('    distribution: ' + (fad.amdDistributionEventId || 'none'));
        }
        console.log('');

        // ---- ±50 bars detail ----
        var from = Math.max(0, firstDivergence.index - 50);
        var to = Math.min(n - 1, firstDivergence.index + 50);
        console.log('DIVERGENCE WINDOW (±50 bars, ' + from + '..' + to + ')');
        var w1 = WARMUPS[0], w2 = WARMUPS[1], w3 = WARMUPS[2];
        for (i = from; i <= to; i++) {
            var a = rows[w1].steps[i];
            var b = w2 ? rows[w2].steps[i] : null;
            var c = w3 ? rows[w3].steps[i] : null;
            if (!a) break;
            var mark = '';
            if (b && fingerprintKey(fingerprintOf(a)) !== fingerprintKey(fingerprintOf(b))) mark += ' <';
            if (c && fingerprintKey(fingerprintOf(a)) !== fingerprintKey(fingerprintOf(c))) mark += ' <';
            console.log(
                new Date(a.evaluationTime).toISOString().slice(5, 16) +
                ' [' + pad(a.amdState, 26) + ' ' + (a.amdDirection || '-') + ']' +
                ' [' + (b ? pad(b.amdState, 26) + ' ' + (b.amdDirection || '-') : '') + ']' +
                (c ? ' [' + pad(c.amdState, 26) + ' ' + (c.amdDirection || '-') + ']' : '') +
                mark
            );
        }
        console.log('========================================');
    })
    .catch(function (e) {
        console.error('COMPARE WARMUP FAILED:', e.message, e.stack);
        process.exit(1);
    });

function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}
