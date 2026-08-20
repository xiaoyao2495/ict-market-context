/**
 * Phase 12.1 — Pivot Population Audit（BTC 90d 运行入口）
 *
 * 用法：
 *   node scripts/pivotPopulationAudit.js BTCUSDT 90
 *
 * 母样本 = replay 确认的全部 2-2 LOCAL_PIVOT（即 result.swings，语义已正名为局部转折）。
 * 统计（先不看 HIGH，只描述市场结构）：
 *   a. 总量与密度（n / per hour）
 *   b. 相邻同向距离分布（1/2/3/4-6/7-12/13+ bars）
 *   c. prominence / ATR(14)（<0.25 / 0.25-0.5 / 0.5-1 / 1-2 / >=2）
 *   d. 穿越寿命（<=3 / 4-6 / 7-12 / 13-24 / >24）
 *   e. nesting 比例（±12 bars 内同向更极端）
 *
 * 纯诊断：pivotDetector / swingLiquidity / 所有消费方零改动。
 */
var historicalLoader = require('../replay/historicalLoader');
var replayEngine = require('../replay/replayEngine');
var pivotPopulationAudit = require('../stats/pivotPopulationAudit');

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
function pct(x) {
    if (x === null || x === undefined) return '-';
    return (x * 100).toFixed(1) + '%';
}
function histogram(map, total, labelWidth) {
    var keys = Object.keys(map).sort(function (a, b) {
        var na = parseInt(a, 10);
        var nb = parseInt(b, 10);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a < b ? -1 : 1;
    });
    keys.forEach(function (k) {
        var cnt = map[k];
        var ratio = total > 0 ? cnt / total : 0;
        var bar = '';
        var len = Math.round(ratio * 60);
        for (var i = 0; i < len; i++) bar += '#';
        console.log(pad(k, labelWidth) + pad(cnt, 7) + pad(pct(ratio), 8) + ' ' + bar);
    });
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
            var bars = (result.summary && result.summary.barCount) || (candles5m.length - startIndex);
            var res = pivotPopulationAudit.auditPivotPopulation({
                pivots: result.swings || [],
                candles: candles5m,
                bars: bars
            });

            console.log('');
            console.log('PIVOT POPULATION AUDIT (Phase 12.1, ' + SYMBOL + ' ' + DAYS + 'd)');
            console.log('母样本 = 全部 2-2 LOCAL_PIVOT（2-left+2-right 局部转折确认；unresolved ' + res.unresolved + '）');
            console.log('统计窗口 = ' + res.bars + ' bars（' + (res.bars / 12).toFixed(0) + 'h）；不看 HIGH，纯结构分布');
            console.log('');
            console.log('=== a. 总量与密度 ===');
            console.log('  LOCAL_PIVOT 总数        ' + res.n);
            console.log('  HIGH / LOW              ' + res.highCount + ' / ' + res.lowCount);
            console.log('  平均每小时              ' + res.perHour.toFixed(1) + ' 个');
            console.log('');
            console.log('=== b. 相邻同向 LOCAL_PIVOT 距离（bars） ===');
            console.log(pad('gap', 12) + pad('n', 7) + pad('ratio', 8) + ' histogram');
            histogram(res.distSameDir, Math.max(1, res.n - 2), 12);
            console.log('');
            console.log('=== c. prominence / ATR(14)（pivot 后 6 bars 反向极值距离） ===');
            console.log('  说明：prominence 反映 pivot 在局部有多"突出"；<0.25 = 极浅（噪声级）');
            console.log(pad('ratio', 12) + pad('n', 7) + pad('ratio', 8) + ' histogram');
            histogram(res.distProminence, res.n - res.promSkip, 12);
            console.log('  （promSkip ' + res.promSkip + '：窗口越界/ATR 缺失未计入）');
            console.log('');
            console.log('=== d. 穿越寿命（pivot 价位被后续多少 bars 再次触及） ===');
            console.log('  说明：寿命越短 = pivot 越"瞬时"；>24 = 未被回测（仍有效）');
            console.log(pad('life', 12) + pad('n', 7) + pad('ratio', 8) + ' histogram');
            histogram(res.distCrossLife, res.n, 12);
            console.log('');
            console.log('=== e. nesting（±12 bars 内同向更极端 → 被更大结构包含） ===');
            console.log('  nested ' + res.nested.nestedCount + ' / ' + res.nested.n + ' = ' + pct(res.nested.ratio));
            console.log('');
            console.log('解读（Phase 12.1 只问结构合理性，不做任何 forward 结论）：');
            console.log('  - perHour 过高 / 相邻同向距离集中在 1-3 bars → 2-2 输出过于"碎"，');
            console.log('    局部小拐点密度大 → Phase 12.2 需要 prominence/separation 过滤');
            console.log('  - prominence 大量 <0.25 → 多数 pivot 是噪声级转折');
            console.log('  - 穿越寿命分布 → pivot 被快速回测的比例（决定"未成熟 level"占比）');
            console.log('  - nesting 比例高 → 大量 pivot 是更大结构内部点，不配独立身份');
            console.log('  - 纯诊断：pivotDetector / swingLiquidity / MSS / EQL / 通知全部零改动');
            console.log('');
        });
    })
    .catch(function (error) {
        console.error('PIVOT POPULATION AUDIT FAILED:', error && error.stack || error);
        process.exit(1);
    });
