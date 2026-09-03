/**
 * Phase 13A.1 — 当前 Bias 审计 测试
 *
 * 覆盖：
 *   - auditCurrentBias：bias direction 分布、bias vs nextDrawSide 命中（BULLISH→BSL）、
 *     分桶命中、组件命中、conflicts 分布、confidence 分层
 *   - future label 复用 drawLiquidityAudit 唯一实现（不复制）
 */
var assert = require('assert');
var bca = require('../stats/biasContextAudit');
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
function mkBias(i, dir, conf, comps, conflicts) {
    return { direction: dir, confidence: conf, components: comps || null, conflicts: conflicts || null };
}

test('13A.1：bias 分布 + bias vs nextDraw 命中（BULLISH→BSL）+ 分桶 + 组件 + conflicts + confidence', function () {
    var candles = [];
    for (var i = 0; i < 60; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 106, 99, 100);  // BSL @105 raid bar12
    candles[22] = mkBar(22, 100, 101, 94, 100);  // SSL @95 raid bar22
    var liqs = [
        mkLiq('B1', 'EQH', 'BSL', 105, 4),
        mkLiq('S1', 'EQL', 'SSL', 95, 6),
        mkLiq('B3', 'EQH', 'BSL', 107, 25)  // confirm bar25，bar30 high 108 raid
    ];
    var biasTrace = {};
    // t=5..11：BULLISH bias（预测 BSL）；nextDraw = BSL（B1 raid bar12）→ 命中
    for (var t = 5; t <= 11; t++) {
        biasTrace[t] = mkBias(t, 'BULLISH', 'HIGH', {
            liquidity: 'BULLISH', structure: 'BULLISH', location: 'NEUTRAL', delivery: null
        }, [{ type: 'X', severity: 'MINOR' }]);
    }
    // t=13..21：BEARISH bias（预测 SSL）；nextDraw = SSL（S1 raid bar22）→ 命中
    for (var u = 13; u <= 21; u++) {
        biasTrace[u] = mkBias(u, 'BEARISH', 'MEDIUM', {
            liquidity: 'BEARISH', structure: null, location: 'BEARISH', delivery: 'BEARISH'
        }, [{ type: 'Y', severity: 'MAJOR' }]);
    }
    // t=25..29：BULLISH bias 0.3（lo 桶）；nextDraw = BSL（B3 raid bar30）→ 命中
    candles[30] = mkBar(30, 100, 108, 99, 100); // BSL @105 再次 raid bar30；B3 @107 raid bar30
    for (var v = 25; v <= 29; v++) {
        biasTrace[v] = mkBias(v, 'BULLISH', 'LOW', { liquidity: 'BULLISH' }, null);
    }

    var res = bca.auditCurrentBias({
        candles: candles,
        biasTrace: biasTrace,
        liquidityObjects: liqs,
        dcSwings: [],
        atrSeries: {},
        htf1hCandles: [],
        displacementEvents: [],
        startIndex: 0
    });

    assert.ok(res.n > 0, '有 bias+label 的行');
    assert.ok(res.biasDirDist.BULLISH >= 1 && res.biasDirDist.BEARISH >= 1, '两个方向都有');
    assert.ok(res.biasAcc !== null && res.biasAcc > 0.9, '构造全命中 → biasAcc 接近 1；实际 ' + res.biasAcc);
    // 分桶：t=5..11 nextDraw=B1 raid bar12 → barsToRaid = 12-t ∈ [1..7] → 30m/1h 桶
    var bucketTotal = Object.keys(res.biasByBucket).reduce(function (s, k) { return s + res.biasByBucket[k].n; }, 0);
    assert.strictEqual(bucketTotal, res.biasN, '分桶 n 之和 = 有方向的行数');
    // 组件：liquidity 有 21 行（t5-11 7 + t13-21 9 + t25-29 5），命中率 >0.9
    assert.ok(res.componentAcc.liquidity && res.componentAcc.liquidity.n === 21, 'liquidity 组件 21 行有方向（实际 ' +
        (res.componentAcc.liquidity && res.componentAcc.liquidity.n) + '）');
    assert.ok(res.componentAcc.liquidity.hit / res.componentAcc.liquidity.n > 0.9, 'liquidity 组件命中');
    // conflicts：t5-11 X|MINOR 7 个 + t13-21 Y|MAJOR 9 个
    assert.strictEqual(res.conflictDist['X|MINOR'], 7);
    assert.strictEqual(res.conflictDist['Y|MAJOR'], 9);
    // confidence：BULLISH 0.8（hi 桶 t5-11）+ BEARISH 0.5（mid t13-21）+ BULLISH 0.3（lo t25-29）
    assert.ok(res.confidenceBands.hi.n >= 1 && res.confidenceBands.mid.n >= 1 && res.confidenceBands.lo.n >= 1, '三层 confidence 都有');
    assert.strictEqual(res.confidenceBands.lo.n, 5, 't25-29 共 5 行 lo 桶（t23-24 B3 未确认 → 无 label 跳过）');
    assert.ok(res.confidenceBands.lo.hit === 5, 'lo 桶全命中（构造：BULLISH → B3 BSL raid 30）');
});

test('13A.1：NEUTRAL bias 不计命中；无 bias 行跳过', function () {
    var candles = [];
    for (var i = 0; i < 40; i++) candles.push(mkBar(i, 100, 101, 99, 100.5));
    candles[12] = mkBar(12, 100, 106, 99, 100);
    var liqs = [mkLiq('B1', 'EQH', 'BSL', 105, 4)];
    var biasTrace = {};
    for (var t = 5; t <= 11; t++) biasTrace[t] = mkBias(t, 'NEUTRAL', 0.2, null, null);
    var res = bca.auditCurrentBias({
        candles: candles, biasTrace: biasTrace, liquidityObjects: liqs, dcSwings: [],
        atrSeries: {}, htf1hCandles: [], displacementEvents: [], startIndex: 0
    });
    assert.ok(res.n >= 7, 'NEUTRAL 行也计入 n（方向分布）');
    assert.strictEqual(res.biasN, 0, 'NEUTRAL 不参与命中统计');
    assert.strictEqual(res.biasAcc, null, '无方向 → 命中率 null');
    assert.strictEqual(res.biasDirDist.NEUTRAL, 7);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
