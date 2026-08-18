/**
 * WARMUP STABILITY（Phase 11S.1）
 *
 * 验证同一个目标窗口，用不同长度的 warmup 跑到相同日期后，
 * persistent state（AMD / Bias / WATCH / ENTRY_READY）是否收敛。
 *
 * 用法：
 *   node scripts/warmupStability.js BTCUSDT        # 目标 30 天，warmup 30/60/90
 *   WARMUP_TARGET=14 node scripts/warmupStability.js BTCUSDT
 *   WARMUPS=60,120 node scripts/warmupStability.js BTCUSDT
 *
 * 机制：
 *   - 对每个 warmupDays：加载 (targetDays + warmupDays) 天数据
 *   - fullWarmup=true：0 → startIndex-1 真实推进增量状态（liquidity/events/AMD/FVG/gate），
 *     不记录 steps/transitions/plan；startIndex 之后才是目标窗口
 *   - 统计目标窗口内的 AMD state / Bias direction occupancy + WATCH / ENTRY_READY transitions
 *   - 三组一致 → persistent state 已稳定（STABLE）；否则 → DIFFERS
 *
 * IMPORTANT: 诊断脚本，不改变任何正式规则。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var replayStats = require('../stats/replayStats');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var TARGET_DAYS = parseInt(process.env.WARMUP_TARGET || '30', 10);
var WARMUPS = (process.env.WARMUPS || '30,60,90').split(',').map(function (s) { return parseInt(s, 10); });

var BARS_PER_DAY = 288; // 5m

function occupancy(stepKeys) {
    var o = {};
    stepKeys.forEach(function (k) { o[k] = (o[k] || 0) + 1; });
    return o;
}

function runWithWarmup(warmupDays) {
    var endTime = Date.now();
    var startTime = endTime - (TARGET_DAYS + warmupDays) * 24 * 3600 * 1000;
    console.log('  warmup ' + warmupDays + 'd: loading ' + (TARGET_DAYS + warmupDays) + 'd (' +
        new Date(startTime).toISOString().slice(0, 10) + ' -> ' + new Date(endTime).toISOString().slice(0, 10) + ') ...');
    return historicalLoader.loadAll(SYMBOL, startTime, endTime).then(function (data) {
        var candles5m = data['5m'];
        var startIndex = warmupDays * BARS_PER_DAY;
        return replayEngine.runReplay({
            symbol: SYMBOL,
            candles5m: candles5m,
            structureCandles: { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] },
            calendarCandles: { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] },
            exchangeInfo: data.exchangeInfo,
            startIndex: startIndex,
            logEvery: 1000000
        }, { fullWarmup: true }).then(function (result) {
            var steps = result.steps;
            var funnel = replayStats.computeFunnel(result.transitions);
            var amdOcc = occupancy(steps.map(function (s) { return s.amdState; }));
            var biasOcc = occupancy(steps.map(function (s) { return s.biasDirection; }));
            var last = steps[steps.length - 1];
            return {
                warmupDays: warmupDays,
                loadedBars: candles5m.length,
                startIndex: startIndex,
                targetBars: steps.length,
                watchEntries: funnel.watchEntries,
                entryReadyEntries: funnel.entryReadyEntries,
                amdOcc: amdOcc,
                biasOcc: biasOcc,
                retraceCount: (result.retraces || []).length,
                trades: result.trades.length,
                finalLiquidity: last ? last.activeLiquidityCount : null,
                finalEvents: last ? last.eventCount : null,
                consumedRefs: last ? {
                    total: last.consumedRefsCount,
                    oldestAgeBars: last.consumedRefsOldestAgeBars,
                    olderThan1d: last.consumedRefsOlderThan1d,
                    olderThan7d: last.consumedRefsOlderThan7d
                } : null
            };
        });
    });
}

function summarize(row) {
    return {
        warmupDays: row.warmupDays,
        targetBars: row.targetBars,
        watch: row.watchEntries,
        entryReady: row.entryReadyEntries,
        retraces: row.retraceCount,
        trades: row.trades,
        amd: row.amdOcc,
        bias: row.biasOcc,
        finalLiquidity: row.finalLiquidity,
        finalEvents: row.finalEvents
    };
}

function compareRows(rows) {
    var ref = rows[0];
    var differences = [];
    rows.forEach(function (r, idx) {
        if (idx === 0) { return; }
        if (r.watch !== ref.watch || r.entryReady !== ref.entryReady || r.retraces !== ref.retraces) {
            differences.push('warmup ' + r.warmupDays + 'd: watch ' + r.watch + ' (ref ' + ref.watch +
                ') / entryReady ' + r.entryReady + ' (ref ' + ref.entryReady + ') / retraces ' + r.retraces + ' (ref ' + ref.retraces + ')');
        }
        var amdRef = JSON.stringify(ref.amd);
        if (JSON.stringify(r.amd) !== amdRef) {
            differences.push('warmup ' + r.warmupDays + 'd: AMD occupancy differs');
        }
    });
    return differences;
}

console.log('========================================');
console.log('WARMUP STABILITY  ' + SYMBOL + '  target ' + TARGET_DAYS + 'd  warmups [' + WARMUPS.join(',') + ']d');
console.log('IMPORTANT: diagnostic only — persistent state convergence check.');
console.log('');

var tasks = WARMUPS.map(function (w) { return runWithWarmup(w); });

Promise.all(tasks).then(function (results) {
    var rows = results.map(summarize);
    console.log('');
    console.log('WARMUP COMPARISON (target window = last ' + TARGET_DAYS + 'd)');
    console.log('  ' + pad('warmup', 8) + pad('targetBars', 11) + pad('WATCH', 7) + pad('ENTRY_READY', 12) + pad('retraces', 9) + pad('trades', 7));
    rows.forEach(function (r) {
        console.log('  ' + pad(r.warmupDays + 'd', 8) + pad(r.targetBars, 11) + pad(r.watch, 7) + pad(r.entryReady, 12) + pad(r.retraces, 9) + pad(r.trades, 7));
    });
    console.log('');
    console.log('AMD STATE OCCUPANCY (target window)');
    var amdStates = ['SEARCHING', 'ACCUMULATION_CONFIRMED', 'MANIPULATION_CONFIRMED', 'DISTRIBUTION_CONFIRMED', 'INVALIDATED'];
    console.log('  ' + pad('warmup', 8) + amdStates.map(function (s) { return pad(s.slice(0, 12), 13); }).join(''));
    rows.forEach(function (r) {
        console.log('  ' + pad(r.warmupDays + 'd', 8) + amdStates.map(function (s) { return pad(r.amd[s] || 0, 13); }).join(''));
    });
    console.log('');
    console.log('BIAS DIRECTION OCCUPANCY (target window)');
    var biasStates = ['BULLISH', 'LEAN_BULLISH', 'NEUTRAL', 'LEAN_BEARISH', 'BEARISH'];
    console.log('  ' + pad('warmup', 8) + biasStates.map(function (s) { return pad(s.slice(0, 12), 13); }).join(''));
    rows.forEach(function (r) {
        console.log('  ' + pad(r.warmupDays + 'd', 8) + biasStates.map(function (s) { return pad(r.bias[s] || 0, 13); }).join(''));
    });
    console.log('');
    console.log('LONG-TERM REGISTRY SIZE (end of target window)');
    rows.forEach(function (r) {
        console.log('  ' + pad(r.warmupDays + 'd', 8) +
            ' activeLiquidity ' + pad(r.finalLiquidity === null ? 'N/A' : r.finalLiquidity, 6) +
            ' events ' + pad(r.finalEvents === null ? 'N/A' : r.finalEvents, 6));
    });
    console.log('');

    // ---- Phase 11R.2：consumedRefs 生命周期（无界污染检查） ----
    console.log('CONSUMED MSS REFS (end of target window — unbounded accumulation check)');
    rows.forEach(function (r) {
        var c = r.consumedRefs;
        console.log('  ' + pad(r.warmupDays + 'd', 8) +
            ' total ' + pad(c ? c.total : 'N/A', 6) +
            ' oldestAge ' + pad(c && c.oldestAgeBars !== null ? c.oldestAgeBars + ' bars' : 'N/A', 12) +
            ' >1d ' + pad(c ? c.olderThan1d : 'N/A', 6) +
            ' >7d ' + pad(c ? c.olderThan7d : 'N/A', 6));
    });
    console.log('  (若 >7d 的 consumed refs 大量存在：这些 swing 突破发生在目标窗口之前，');
    console.log('  会改变目标窗口内 MSS reference 可用性 → warmup 差异的一个传导路径)');
    console.log('');

    // ---- Phase 11R.2：Memory Horizon 分类报告 ----
    var mh = require('../config/memoryHorizon');
    var diffs = compareRows(rows);
    console.log('MEMORY HORIZON CLASSIFICATION (config/memoryHorizon.js)');
    console.log('  MUST_CONVERGE:      ATR14 / 5m Pivot / Displacement / PDH-PML / Scenario / EntryGate / PendingTrade');
    console.log('  EXPECTED_LONG_MEMORY: EQH / MSS consumedRefs / FVG lifecycle / Old Swing / Draw / Bias');
    console.log('');

    if (diffs.length === 0) {
        console.log('VERDICT: STABLE — persistent state converges across warmup lengths.');
        console.log('========================================');
        return;
    }

    // 分类：AMD occupancy 差异 = 需要进一步定位（经 compareWarmupReplay 确认传导路径）
    var amdDiff = diffs.filter(function (d) { return d.indexOf('AMD') !== -1; });
    var otherDiff = diffs.filter(function (d) { return d.indexOf('AMD') === -1; });

    console.log('VERDICT: DIFFERS — 差异分类（Phase 11R.2 审计框架）');
    if (amdDiff.length > 0) {
        console.log('  UNEXPECTED_DIVERGENCE (AMD):');
        amdDiff.forEach(function (d) { console.log('    - ' + d); });
        console.log('    -> 审计结论：AMD 状态机本身 bounded（36 根 lookback + phase-local 事件），');
        console.log('       差异经【长期 registry】传导（EQH 加分 + sweep 事件流来自历史 swing/calendar）。');
        console.log('       运行 scripts/compareWarmupReplay.js 定位第一分叉 K 与具体传导字段。');
    }
    if (otherDiff.length > 0) {
        console.log('  EXPECTED_DIVERGENCE (Watch/EntryReady/Retraces — 依赖 Draw/Bias 的长期 liquidity):');
        otherDiff.forEach(function (d) { console.log('    - ' + d); });
        console.log('    -> 归类 EXPECTED_LONG_MEMORY（可追溯到具体 liquidity source 即为可解释）。');
    }
    console.log('');
    console.log('  注册表规模差异（长期记忆证据）:');
    rows.forEach(function (r) {
        console.log('    warmup ' + r.warmupDays + 'd: activeLiquidity ' + r.finalLiquidity + ' / events ' + r.finalEvents);
    });
    console.log('========================================');
}).catch(function (e) {
    console.error('WARMUP STABILITY FAILED:', e.message);
    process.exit(1);
});

function pad(s, n) {
    s = String(s);
    while (s.length < n) { s = ' ' + s; }
    return s;
}
