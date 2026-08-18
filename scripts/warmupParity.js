/**
 * Phase 11L.2 — Warmup Parity（诊断脚本，Fix 7）
 * 验证 bootstrap warmup 长度对机会的影响：
 *   同一目标窗口（最近 7 天），分别用 3d / 30d 历史初始化引擎，
 *   比较窗口内产生的 HIGH 机会（id/tier/anchor/nearTarget）是否一致。
 * 若 3d 与 30d 明显不同 → 生产不能用短 warmup。
 */
var liveEngineMod = require('../live/liveEngine');
var dataSource = require('../live/dataSource');
var thresholds = require('../config/thresholds');

var SYMBOL = process.argv[2] || 'BTCUSDT';
var WINDOW_DAYS = 7;
var BOOTSTRAP_A_DAYS = 3;
var BOOTSTRAP_B_DAYS = 30;
var BAR_MS = 300000;

var end = Date.now();
var start = end - BOOTSTRAP_B_DAYS * 24 * 3600 * 1000;

function makeEngine(data) {
    var structureCandles = { '1d': data['1d'], '4h': data['4h'], '1h': data['1h'] };
    var calendarCandles = { '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] };
    return liveEngineMod.createLiveEngine({
        symbol: SYMBOL,
        exchangeInfo: data.exchangeInfo,
        structureCandles: structureCandles,
        calendarCandles: calendarCandles,
        fetcher: dataSource.makeFetcher(calendarCandles),
        thresholds: thresholds
    }, { snapshotInterval: 12, baseIndex: 0 });
}

function runAll(engine, candles) {
    var opps = [];
    var chain = Promise.resolve();
    candles.forEach(function (c, idx) {
        chain = chain.then(function () {
            return engine.onBar(c, idx).then(function (opp) { if (opp) opps.push(opp); });
        });
    });
    return chain.then(function () {
        var tail = engine.flushLeg();
        if (tail) opps.push(tail);
        return opps;
    });
}

dataSource.fetchInitial(SYMBOL, BOOTSTRAP_B_DAYS).then(function (data) {
    var candles = (data['5m'] || []).slice();
    console.log(SYMBOL + ' ' + BOOTSTRAP_B_DAYS + 'd: ' + candles.length + ' 根 5m');
    var windowBars = WINDOW_DAYS * 24 * 12; // 尾部 7 天根数
    // 引擎 A：只喂尾部 10 天（3d bootstrap + 7d 窗口）——模拟生产 3d 启动
    // 引擎 B：喂全部 30d —— 模拟生产 30d 启动（权威）
    var sliceA = candles.slice(Math.max(0, candles.length - (BOOTSTRAP_A_DAYS + WINDOW_DAYS) * 24 * 12));
    var engineA = makeEngine(data);
    var engineB = makeEngine(data);
    return runAll(engineA, sliceA).then(function (oppsA) {
        return runAll(engineB, candles).then(function (oppsB) {
            // 只比较尾部 7 天（各自窗口的最后 windowBars 根内完成的机会）
            var cutA = sliceA.length - windowBars;
            var cutB = candles.length - windowBars;
            var winA = oppsA.filter(function (o) { return o.anchorIndex >= cutA; });
            var winB = oppsB.filter(function (o) { return o.anchorIndex >= cutB; });
            var highA = winA.filter(function (o) { return o.tier === 'HIGH_QUALITY'; });
            var highB = winB.filter(function (o) { return o.tier === 'HIGH_QUALITY'; });
            console.log('');
            console.log('WARMUP PARITY（目标窗口 = 最近 ' + WINDOW_DAYS + ' 天，' + windowBars + ' 根）');
            console.log('  bootstrap ' + BOOTSTRAP_A_DAYS + 'd: HIGH ' + highA.length + ' / 窗口机会 ' + winA.length);
            console.log('  bootstrap ' + BOOTSTRAP_B_DAYS + 'd: HIGH ' + highB.length + ' / 窗口机会 ' + winB.length);

                    // 按 id 对账 HIGH
                    var mapA = {}; highA.forEach(function (o) { mapA[o.id] = o; });
                    var mapB = {}; highB.forEach(function (o) { mapB[o.id] = o; });
                    var match = 0, diff = 0, onlyA = 0, onlyB = 0;
                    var ids = Object.keys(mapA).concat(Object.keys(mapB)).filter(function (v, i, a) { return a.indexOf(v) === i; });
                    console.log('  3d 窗口期 HIGH ids: ' + highA.map(function (o) { return o.id.slice(0, 30); }).join(' | '));
                    console.log('  30d 窗口期 HIGH ids: ' + highB.map(function (o) { return o.id.slice(0, 30); }).join(' | '));
                    ids.forEach(function (id) {
                        var a = mapA[id], b = mapB[id];
                        if (!a) { onlyB++; return; }
                        if (!b) { onlyA++; return; }
                        // 用时间对账（anchorTime = leg 完成根 closeTime，跨引擎一致；index 因窗口起点不同不可比）
                        if (a.tier === b.tier && a.anchorTime === b.anchorTime &&
                            (a.nearTarget === b.nearTarget || (a.nearTarget !== null && b.nearTarget !== null && Math.abs(a.nearTarget - b.nearTarget) < 1e-6))) {
                            match++;
                        } else {
                            diff++;
                        }
                    });
                    console.log('  HIGH 对账: MATCH ' + match + ' | DIFF ' + diff + ' | only3d ' + onlyA + ' | only30d ' + onlyB);
                    console.log('  （若 MATCH 高 → warmup 长度对机会影响小；若 only3d/only30d 多 → 必须用长 warmup）');
                    var ratio = highB.length > 0 ? (highA.length / highB.length * 100).toFixed(0) + '%' : '-';
                    console.log('  结论: 3d HIGH = ' + ratio + ' of 30d HIGH' +
                        (onlyA === 0 && onlyB === 0 && diff === 0 ? ' —— 一致，短 warmup 可用' : ' —— 不一致，建议 30d+'));
                });
        });
}).catch(function (e) {
    console.error('warmup parity 失败:', e && e.stack || e);
    process.exit(1);
});
