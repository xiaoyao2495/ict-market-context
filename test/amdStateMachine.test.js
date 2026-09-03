/**
 * amdStateMachine / amdScorer / amdAlignment / amdExplanation 单元测试
 */
var assert = require('assert');
var amdStateMachine = require('../amd/amdStateMachine');
var amdScorer = require('../amd/amdScorer');
var amdAlignment = require('../amd/amdAlignment');
var amdExplanation = require('../amd/amdExplanation');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var eventRegistry = require('../events/eventRegistry');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS  ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL  ' + name + '  ->  ' + e.message);
    }
}

var BAR = 300000;

function m5(open, high, low, close, openTime) {
    return {
        openTime: openTime, open: open, high: high, low: low, close: close,
        closeTime: openTime + BAR - 1, closed: true, source: 'futures'
    };
}

/**
 * 横盘 accumulation 环境（价格 100±2，24 根）
 */
function chopCandles(n) {
    var closes = [100, 98, 102, 99, 103, 97, 101, 99, 103, 98, 102, 100, 104, 97, 101, 99, 102, 98, 100, 101, 99, 103, 100, 102];
    var out = [];
    var i;
    for (i = 0; i < n; i++) {
        var c = closes[i % closes.length];
        out.push(m5(c - 1, c + 1.5, c - 1.5, c, 1000000 + i * BAR));
    }
    return out;
}

function makeContext(candles, events, opts) {
    var o = opts || {};
    var displacements = (events || []).filter(function (event) { return event.type === 'DISPLACEMENT'; });
    return {
        symbol: 'BTCUSDT',
        timeframe: '5m',
        candles: candles,
        // 默认 evaluationTime = 最后一根 closeTime + 1 bar（贴近“当前”，不触发超时 INVALIDATED）
        evaluationTime: o.evaluationTime !== undefined
            ? o.evaluationTime
            : candles[candles.length - 1].closeTime + BAR,
        liquidityRegistry: o.registry || liquidityRegistry.createRegistry(),
        eventRegistry: o.eventRegistry || makeEventRegistry(events || []),
        displacementStore: o.displacementStore || { getAsOf: function (evaluationTime, symbol) {
            return displacements.filter(function (event) { return event.confirmedAt <= evaluationTime && event.symbol === symbol; });
        } },
        draw: o.draw || null,
        bias: o.bias || null
    };
}

function makeEventRegistry(events) {
    var r = eventRegistry.createEventRegistry();
    r.addMany(events);
    return r;
}

function sweep(id, side, price, confirmedAt, candleIndex, type) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'LIQUIDITY_SWEEP',
        direction: side === 'SSL' ? 'BULLISH' : 'BEARISH', side: side,
        liquidityId: id, price: price, confirmedAt: confirmedAt, candleIndex: candleIndex,
        source: { liquidityType: type || 'LONDON_HIGH', side: side }, metadata: {}
    };
}

function mss(id, direction, confirmedAt, candleIndex) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'STRUCTURAL_MSS', direction: direction,
        confirmedAt: confirmedAt, candleIndex: candleIndex, price: 100,
        source: { candle: { close: 100 } }, metadata: {}
    };
}

function disp(id, direction, confirmedAt, close, candleIndex) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m', type: 'DISPLACEMENT', direction: direction,
        confirmedAt: confirmedAt, startIndex: candleIndex, endIndex: candleIndex,
        startPrice: close, endPrice: close, price: close
    };
}

/* ---------- 状态机基础 ---------- */

test('无 accumulation → SEARCHING', function () {
    var candles = [];
    var i;
    for (i = 0; i < 24; i++) {
        candles.push(m5(80 + i, 84 + i, 79 + i, 82 + i, 1000000 + i * BAR)); // trending
    }
    var r = amdStateMachine.runAmd(makeContext(candles, []), {});
    assert.strictEqual(r.state, 'SEARCHING');
});

test('accumulation confirmed → ACCUMULATION_CONFIRMED（无 manipulation）', function () {
    var candles = chopCandles(24);
    var r = amdStateMachine.runAmd(makeContext(candles, []), {});
    assert.strictEqual(r.state, 'ACCUMULATION_CONFIRMED');
    assert.ok(r.accumulation);
});

test('accumulation + manipulation → MANIPULATION_CONFIRMED', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var events = [sweep('s1', 'SSL', 95, accTime + 2 * BAR, 26, 'LONDON_LOW')];
    var r = amdStateMachine.runAmd(makeContext(candles, events, {
        evaluationTime: accTime + 3 * BAR
    }), {});
    assert.strictEqual(r.state, 'MANIPULATION_CONFIRMED');
    assert.strictEqual(r.direction, 'BULLISH');
});

test('完整 bullish AMD → DISTRIBUTION_CONFIRMED', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var events = [
        sweep('s1', 'SSL', 95, accTime + 2 * BAR, 26, 'LONDON_LOW'),
        mss('m1', 'BULLISH', accTime + 3 * BAR, 27),
        disp('d1', 'BULLISH', accTime + 4 * BAR, 114, 28)
    ];
    var r = amdStateMachine.runAmd(makeContext(candles, events, {
        evaluationTime: accTime + 5 * BAR
    }), {});
    assert.strictEqual(r.state, 'DISTRIBUTION_CONFIRMED');
    assert.strictEqual(r.direction, 'BULLISH');
    assert.ok(r.distribution);
});

/* ---------- INVALIDATED ---------- */

test('manipulation timeout → INVALIDATED（A）', function () {
    var candles = chopCandles(24);
    var accConfirmed = candles[23].closeTime;
    // evaluationTime 远超 accumulation + 12 bars，且无 sweep
    var r = amdStateMachine.runAmd(makeContext(candles, [], {
        evaluationTime: accConfirmed + 20 * BAR
    }), {});
    assert.strictEqual(r.state, 'INVALIDATED');
    assert.ok(r.invalidationReason.indexOf('manipulation') !== -1);
});

test('distribution timeout → INVALIDATED（C）', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var sweepTime = accTime + 2 * BAR;
    var events = [sweep('s1', 'SSL', 95, sweepTime, 26, 'LONDON_LOW')];
    // 有 manipulation 但无 displacement，时间超过 timeout
    var r = amdStateMachine.runAmd(makeContext(candles, events, {
        evaluationTime: sweepTime + 20 * BAR
    }), {});
    assert.strictEqual(r.state, 'INVALIDATED');
    assert.ok(r.invalidationReason.indexOf('matching displacement') !== -1);
});

test('opposite legacy structure event has no AMD effect', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var events = [
        sweep('s1', 'SSL', 95, accTime + 2 * BAR, 26, 'LONDON_LOW'),
        mss('mBear', 'BEARISH', accTime + 4 * BAR, 28) // 相反方向 MSS 先出现
    ];
    var r = amdStateMachine.runAmd(makeContext(candles, events, {
        evaluationTime: accTime + 6 * BAR
    }), {});
    assert.strictEqual(r.state, 'MANIPULATION_CONFIRMED');
    assert.strictEqual(r.invalidationReason, null);
});

/* ---------- deterministic ---------- */

test('deterministic replay', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var events = [
        sweep('s1', 'SSL', 95, accTime + 2 * BAR, 26, 'LONDON_LOW'),
        mss('m1', 'BULLISH', accTime + 3 * BAR, 27),
        disp('d1', 'BULLISH', accTime + 4 * BAR, 114, 28)
    ];
    var ctx = function () {
        return makeContext(candles, events.slice(), { evaluationTime: accTime + 5 * BAR });
    };
    var r1 = amdStateMachine.runAmd(ctx(), {});
    var r2 = amdStateMachine.runAmd(ctx(), {});
    assert.strictEqual(r1.state, r2.state);
    assert.strictEqual(r1.direction, r2.direction);
});

test('future sweep 不推进状态（evaluationTime 早于 sweep）', function () {
    var candles = chopCandles(24);
    var accTime = candles[23].closeTime;
    var events = [sweep('s1', 'SSL', 95, accTime + 2 * BAR, 26, 'LONDON_LOW')];
    var r = amdStateMachine.runAmd(makeContext(candles, events, {
        evaluationTime: accTime + 1 * BAR // sweep 还没发生
    }), {});
    assert.strictEqual(r.state, 'ACCUMULATION_CONFIRMED'); // 只有 accumulation
});

/* ---------- AMD Score ---------- */

test('amdScorer：30/30/40 加权', function () {
    var r = amdScorer.scoreAmd({
        state: 'DISTRIBUTION_CONFIRMED',
        accumulation: { score: 80 },
        manipulation: { score: 90 },
        distribution: { score: 85 }
    }, {});
    assert.strictEqual(r.score, Math.round(80 * 0.3 + 90 * 0.3 + 100 * 0.4));
    assert.strictEqual(r.complete, true);
});

test('amdScorer：未完成阶段 → 部分加权，不标 complete', function () {
    var r = amdScorer.scoreAmd({
        state: 'ACCUMULATION_CONFIRMED',
        accumulation: { score: 80 },
        manipulation: null,
        distribution: null
    }, {});
    assert.strictEqual(r.score, Math.round(80 * 0.3));
    assert.strictEqual(r.complete, false);
});

test('amdScorer：cap 100', function () {
    var r = amdScorer.scoreAmd({
        state: 'DISTRIBUTION_CONFIRMED',
        accumulation: { score: 100 },
        manipulation: { score: 100 },
        distribution: { score: 100 }
    }, {});
    assert.strictEqual(r.score, 100);
});

test('amdScorer：权重和 != 1 → 报错', function () {
    assert.throws(function () {
        amdScorer.scoreAmd({ accumulation: null, manipulation: null, distribution: null }, {
            thresholds: { amd: { score: { accumulation: 0.5, manipulation: 0.3, distribution: 0.3 } } }
        });
    }, /must sum to 1/);
});

/* ---------- Alignment ---------- */

test('alignment：bullish bias + bullish AMD → MATCH', function () {
    var r = amdAlignment.align({ direction: 'BULLISH', confidence: 'HIGH' }, 'BULLISH');
    assert.strictEqual(r.alignment, 'MATCH');
    assert.strictEqual(r.biasConfidenceLow, false);
});

test('alignment：LEAN_BULLISH + BULLISH → MATCH', function () {
    assert.strictEqual(amdAlignment.align({ direction: 'LEAN_BULLISH', confidence: 'HIGH' }, 'BULLISH').alignment, 'MATCH');
});

test('alignment：bearish + bearish → MATCH', function () {
    assert.strictEqual(amdAlignment.align({ direction: 'BEARISH', confidence: 'MEDIUM' }, 'BEARISH').alignment, 'MATCH');
});

test('alignment：bullish bias + bearish AMD → OPPOSITE', function () {
    assert.strictEqual(amdAlignment.align({ direction: 'BULLISH', confidence: 'HIGH' }, 'BEARISH').alignment, 'OPPOSITE');
});

test('alignment：bearish bias + bullish AMD → OPPOSITE', function () {
    assert.strictEqual(amdAlignment.align({ direction: 'LEAN_BEARISH', confidence: 'HIGH' }, 'BULLISH').alignment, 'OPPOSITE');
});

test('alignment：bias NEUTRAL → UNCONFIRMED', function () {
    assert.strictEqual(amdAlignment.align({ direction: 'NEUTRAL', confidence: 'HIGH' }, 'BULLISH').alignment, 'UNCONFIRMED');
});

test('alignment：低 confidence 标记，不改变 alignment', function () {
    var r = amdAlignment.align({ direction: 'BULLISH', confidence: 'LOW' }, 'BULLISH');
    assert.strictEqual(r.alignment, 'MATCH');
    assert.strictEqual(r.biasConfidenceLow, true);
});

/* ---------- Explanation ---------- */

test('explanation：各阶段 reasons 正确分类', function () {
    var ex = amdExplanation.buildAmdExplanation({
        state: 'DISTRIBUTION_CONFIRMED',
        accumulation: { score: 82, reasons: ['24 bars', 'Range 100 - 104'] },
        manipulation: { score: 91, reasons: ['SSL swept', 'Fast reclaim'] },
        distribution: { score: 85, reasons: ['Bullish MSS', 'Range escaped'] },
        invalidationReason: null
    }, { alignment: 'MATCH', biasDirection: 'BULLISH', amdDirection: 'BULLISH', biasConfidenceLow: false });
    assert.strictEqual(ex.accumulation.length, 2);
    assert.strictEqual(ex.manipulation.length, 2);
    assert.strictEqual(ex.distribution.length, 2);
    assert.strictEqual(ex.alignment.length, 1);
    assert.strictEqual(ex.invalidation.length, 0);
});

test('explanation：invalidation reason 输出', function () {
    var ex = amdExplanation.buildAmdExplanation({
        state: 'INVALIDATED',
        accumulation: null, manipulation: null, distribution: null,
        invalidationReason: 'no manipulation within 12 bars'
    }, null);
    assert.strictEqual(ex.invalidation.length, 1);
    assert.strictEqual(ex.invalidation[0], 'no manipulation within 12 bars');
});

console.log('----');
console.log('amd state machine suite: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
