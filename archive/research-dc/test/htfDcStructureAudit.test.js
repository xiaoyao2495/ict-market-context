/**
 * Phase 13A.2 — HTF DC Structure 独立审计 测试
 *
 * 覆盖：
 *   - buildHtfDcStates：DC 状态机逐根推进、state 映射（BULLISH/BEARISH/TRANSITION/
 *     NEUTRAL）、交替性
 *   - stateAt5m：5m 快照 → 最近已收盘 htf 状态（无未来）
 *   - auditHtfDcStructure：context 分组（1D/4H/ALIGN/CONFLICT）+ horizon 分桶
 *   - futureLabel horizonBars 可配
 */
var assert = require('assert');
var hsa = require('../stats/htfDcStructureAudit');
var dla = require('../stats/drawLiquidityAudit');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ' -> ' + (e && e.message || e));
    }
}

var BAR = 300000;
function mkBar(i, open, high, low, close) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true };
}
function mkLiq(id, type, side, price, confirmBar) {
    return { id: id, type: type, side: side, price: price,
        confirmedAt: 1000000 + confirmBar * BAR + BAR - 1,
        confirmBar: confirmBar,
        status: 'ACTIVE', touchedAt: null, sweptAt: null, brokenAt: null,
        metadata: {}, source: 'registry' };
}

/* ---------- buildHtfDcStates ---------- */

test('13A.2：buildHtfDcStates（状态机推进 + state 映射 + 交替 + TRANSITION）', function () {
    // 构造 4h 序列：先 5 根小上涨（UP → BULLISH，无 swing 确认也是 BULLISH）
    var c = [];
    for (var i = 0; i < 5; i++) c.push(mkBar(i, 100 + i, 101 + i, 99 + i, 100.5 + i));
    var states = hsa.buildHtfDcStates(c);
    assert.strictEqual(states[0].state, 'BULLISH', 'DC 首根 init 后 direction=UP → BULLISH（NEUTRAL 仅空输入）');
    assert.strictEqual(states[4].state, 'BULLISH', '纯上涨 direction=UP → BULLISH（无需 swing 确认）');
    assert.deepStrictEqual(hsa.buildHtfDcStates([]), [], '空输入 → 空数组');
    // bar5 创新高（106>105）→ candidate 更新，不确认；bar6 不创新高且 close 回撤 → 确认 SWING_HIGH
    c.push(mkBar(5, 105, 106, 100, 101)); // 创新高，candidate 更新（不确认）
    c.push(mkBar(6, 101, 104, 98, 99));   // 不创新高，close 99 → rev=106-99=7 >= 1.5*ATR → 确认 HIGH
    var st2 = hsa.buildHtfDcStates(c);
    var last = st2[st2.length - 1];
    assert.strictEqual(last.lastSwing, 'HIGH', 'bar6 回撤确认 SWING_HIGH');
    assert.ok(last.state === 'BEARISH' || last.state === 'TRANSITION', '确认 HIGH 后 → BEARISH 或 TRANSITION；实际 ' + last.state);
    assert.strictEqual(last.swingsConfirmed, 1);
});

test('13A.2：stateAt5m（5m 快照 → 最近已收盘 htf，无未来）', function () {
    // 4h 桶：bar k 覆盖 5m bar k*12..k*12+11，closeTime = t + 12*300000 - 1
    var htf2 = [];
    for (var k = 0; k < 5; k++) {
        var t = 1000000 + k * 12 * 300000;
        htf2.push({ openTime: t, open: 100, high: 101, low: 99, close: 100, closeTime: t + 12 * 300000 - 1, closed: true });
    }
    var st2 = hsa.buildHtfDcStates(htf2);
    var c5 = [];
    for (var j = 0; j < 80; j++) c5.push(mkBar(j, 100, 101, 99, 100.5)); // 5m bars
    // 5m bar5：在 4h bar0 内部（bar0 未收盘）→ 无已收盘 4h → null（无未来语义）
    assert.strictEqual(hsa.stateAt5m(st2, htf2, 5, c5), null, '5m bar5 时 4h bar0 未收盘 → null');
    // 5m bar13：> 4h bar0 closeTime、< 4h bar1 → htf bar0
    var s0 = hsa.stateAt5m(st2, htf2, 13, c5);
    assert.ok(s0, '5m bar13 对应 htf bar0');
    assert.strictEqual(s0.closeTime, htf2[0].closeTime);
    // 5m bar25 → htf bar1
    var s1 = hsa.stateAt5m(st2, htf2, 25, c5);
    assert.strictEqual(s1.closeTime, htf2[1].closeTime, '5m bar25 → htf bar1（无未来）');
    // 5m bar80（超出 htf 范围）→ null
    var sn = hsa.stateAt5m(st2, htf2, 80, c5);
    assert.strictEqual(sn, null, '超出 htf 范围 → null');
});

/* ---------- auditHtfDcStructure ---------- */

test('13A.2：auditHtfDcStructure（context 分组 + horizon 分桶 + futureLabel 24h horizon）', function () {
    // 5m：400 根（>1 天，确保 1d bar0 收盘）；BSL @105 raid bar380
    var c5 = [];
    for (var i = 0; i < 400; i++) c5.push(mkBar(i, 100, 101, 99, 100.5));
    c5[380] = mkBar(380, 100, 106, 99, 100);
    var liqs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    // 4h：34 根上涨（覆盖 5m 0..407）
    var h4 = [];
    for (var k = 0; k < 34; k++) {
        var t = 1000000 + k * 12 * 300000;
        h4.push({ openTime: t, open: 100 + k * 0.1, high: 102 + k * 0.1, low: 99 + k * 0.1, close: 101 + k * 0.1, closeTime: t + 12 * 300000 - 1, closed: true });
    }
    // 1d：3 根上涨（bar0 收盘于 5m ~288 之后）
    var d1 = [];
    for (var j = 0; j < 3; j++) {
        var t2 = 1000000 + j * 288 * 300000;
        d1.push({ openTime: t2, open: 100 + j, high: 102 + j, low: 99 + j, close: 101 + j, closeTime: t2 + 288 * 300000 - 1, closed: true });
    }
    var res = hsa.auditHtfDcStructure({
        candles: c5,
        liquidityObjects: liqs,
        dcSwings: [],
        htf4hCandles: h4,
        htf1dCandles: d1,
        startIndex: 0
    });
    // 1D/4H 都是上涨 → 1D_BULLISH + 4H_BULLISH + ALIGN_BULLISH 都有样本
    assert.ok(res.byContext['1D_BULLISH'] && res.byContext['1D_BULLISH'].n > 0, '1D_BULLISH 有样本');
    assert.ok(res.byContext['4H_BULLISH'] && res.byContext['4H_BULLISH'].n > 0, '4H_BULLISH 有样本');
    assert.ok(res.byContext['ALIGN_BULLISH'] && res.byContext['ALIGN_BULLISH'].n > 0, 'ALIGN_BULLISH 有样本');
    // 所有样本 BULLISH → 预测 PDH_FIRST（BSL）→ 命中（B1 raid 380）
    assert.strictEqual(res.byContext['ALIGN_BULLISH'].bsl, res.byContext['ALIGN_BULLISH'].n, 'BULLISH context 全部 PDH_FIRST（构造）');
    // horizon 分桶：barsToRaid = 380 - t（t<380）→ <=4h 桶
    var h4b = res.byHorizon['<=4h'];
    assert.ok(h4b && h4b['ALIGN_BULLISH'] && h4b['ALIGN_BULLISH'].n > 0, '<=4h 桶有 ALIGN_BULLISH');
    // CONFLICT 不出现（1D/4H 同向）
    assert.strictEqual(res.byContext['CONFLICT_BULL_BEAR'], undefined, '同向无冲突组');
});

test('13A.2：futureLabel horizonBars 可配（默认 96 vs 288）', function () {
    var candles = [];
    for (var i = 0; i < 300; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[200] = mkBar(200, 100, 106, 99, 100); // BSL @105 raid bar200
    var liqs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    var idx = dla.buildCandidateIndex(liqs, candles);
    var actives = liqs.filter(function (c) { return dla.isActiveAt(c, idx, 5, candles); });
    // 默认 horizon 96：raid 200 - t 5 = 195 > 96 → null
    assert.strictEqual(dla.futureLabel(actives, idx, 5), null, '默认 96 bars 内无 draw → null');
    // horizon 288：命中
    var lb = dla.futureLabel(actives, idx, 5, 288);
    assert.ok(lb && lb.nextSide === 'BSL' && lb.barsToRaid === 195, 'horizon 288 命中（195 bars）');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
