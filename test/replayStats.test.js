/**
 * Replay Engine + Stats 测试（Phase 11）
 *
 * 覆盖：
 *   replayStats.computeFunnel / computeOverall / groupExpectancy
 *   replayEngine.runReplay（合成数据：steps/trades 结构、deterministic、AMD lookback）
 */
var assert = require('assert');
var replayEngine = require('../replay/replayEngine');
var replayStats = require('../stats/replayStats');

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function runTest(t) {
    try {
        t.fn();
        console.log('PASS  ' + t.name);
        return true;
    } catch (e) {
        console.log('FAIL  ' + t.name);
        console.log('      ' + (e && e.message ? e.message : e));
        return false;
    }
}

/* ---------------- helpers ---------------- */

var BAR = 300000;

function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return {
        openTime: t, open: open, high: high, low: low, close: close,
        closeTime: t + BAR - 1, closed: true, source: 'futures'
    };
}

function makeCandles(n, base, drift) {
    var out = [];
    var i;
    var price = base;
    for (i = 0; i < n; i++) {
        var open = price;
        var close = price + (drift || 0) + (i % 3 === 0 ? -2 : 2);
        var high = Math.max(open, close) + 5;
        var low = Math.min(open, close) - 5;
        out.push(m5(open, high, low, close, i));
        price = close;
    }
    return out;
}

function makeCalendar(n) {
    var out = [];
    var i;
    for (i = 0; i < n; i++) {
        var p = 100 + i * 0.5;
        out.push(m5(p, p + 8, p - 8, p + 2, i));
    }
    return out;
}

function replayData(n, drift) {
    return {
        symbol: 'BTCUSDT',
        candles5m: makeCandles(n, 100, drift !== undefined ? drift : 0.1),
        structureCandles: {
            '1d': makeCalendar(150),
            '4h': makeCalendar(200),
            '1h': makeCalendar(200)
        },
        calendarCandles: {
            '1d': makeCalendar(150),
            '1w': makeCalendar(3),
            '1M': makeCalendar(3)
        },
        exchangeInfo: { tickSize: 0.1, symbol: 'BTCUSDT' },
        startIndex: 60,
        stepBars: 24
    };
}

/* ================= replayStats ================= */

test('stats：funnel 按状态跃迁计数（transition 口径）', function () {
    var transitions = [
        { type: 'SCENARIO_ENTER_WATCH', direction: 'BULLISH' },
        { type: 'ENTRY_GATE_ENTER_READY' },
        { type: 'PLAN_CREATED' },
        { type: 'TRADE_FILLED', status: 'WIN' },
        { type: 'SCENARIO_TRANSITION' },
        { type: 'GATE_TRANSITION' },
        { type: 'AMD_TRANSITION' }
    ];
    var f = replayStats.computeFunnel(transitions);
    assert.strictEqual(f.watchEntries, 1);
    assert.strictEqual(f.entryReadyEntries, 1);
    assert.strictEqual(f.plansReady, 1);
    assert.strictEqual(f.tradeFilled, 1);
    assert.strictEqual(f.evaluations, 3); // 三个 transition 计数
});

test('stats：funnel 兼容旧 steps 口径（诊断用）', function () {
    var steps = [
        { biasDirection: 'BULLISH', action: 'WATCH', gateState: 'ENTRY_READY', planStatus: 'READY' },
        { biasDirection: 'NEUTRAL', action: 'WAIT', gateState: 'CLOSED', planStatus: null }
    ];
    var f = replayStats.computeFunnelBySteps(steps);
    assert.strictEqual(f.watch, 1);
    assert.strictEqual(f.directionalBias, 1);
});

test('stats：overall 统计（WIN/LOSS/AMBIGUOUS 区分）', function () {
    var trades = [
        { status: 'WIN', realizedR: 2.0, holdBars: 5, mfeR: 2.5, maeR: 0.3 },
        { status: 'LOSS', realizedR: -1, holdBars: 3, mfeR: 0.5, maeR: 1.0 },
        { status: 'WIN', realizedR: 1.5, holdBars: 7, mfeR: 1.8, maeR: 0.2 },
        { status: 'AMBIGUOUS', realizedR: 0, holdBars: 2 },
        { status: 'EXPIRED', realizedR: 0, holdBars: 0 }
    ];
    var o = replayStats.computeOverall(trades);
    assert.strictEqual(o.total, 5);
    assert.strictEqual(o.wins, 2);
    assert.strictEqual(o.losses, 1);
    assert.strictEqual(o.ambiguous, 1);
    assert.strictEqual(o.expired, 1);
    assert.strictEqual(o.closed, 3);
    assert.ok(Math.abs(o.winRate - 2 / 3) < 1e-4); // round4 后
    assert.ok(Math.abs(o.avgR - (2.0 - 1 + 1.5) / 3) < 1e-4);
    assert.strictEqual(o.maxConsecLosses, 1);
    assert.ok(Math.abs(o.avgMfeR - (2.5 + 0.5 + 1.8) / 3) < 1e-4);
});

test('stats：overall 最大连亏', function () {
    var trades = [
        { status: 'LOSS', realizedR: -1, holdBars: 1 },
        { status: 'LOSS', realizedR: -1, holdBars: 1 },
        { status: 'WIN', realizedR: 2, holdBars: 1 },
        { status: 'LOSS', realizedR: -1, holdBars: 1 },
        { status: 'LOSS', realizedR: -1, holdBars: 1 },
        { status: 'LOSS', realizedR: -1, holdBars: 1 }
    ];
    var o = replayStats.computeOverall(trades);
    assert.strictEqual(o.maxConsecLosses, 3);
});

test('stats：overall OPEN_AT_END / profit factor / median R（Authoritative Run 字段）', function () {
    var trades = [
        { status: 'WIN', realizedR: 2.0, holdBars: 5 },
        { status: 'LOSS', realizedR: -1, holdBars: 3 },
        { status: 'WIN', realizedR: 1.5, holdBars: 7 },
        { status: 'OPEN_AT_END', realizedR: 0, holdBars: 20 }
    ];
    var o = replayStats.computeOverall(trades);
    assert.strictEqual(o.openEnd, 1);
    assert.strictEqual(o.closed, 3);
    assert.strictEqual(o.total, 4);
    // profit factor = grossWin(3.5) / grossLoss(1) = 3.5
    assert.ok(Math.abs(o.profitFactor - 3.5) < 1e-4);
    // median R of [2.0, -1, 1.5] = 1.5
    assert.ok(Math.abs(o.medianR - 1.5) < 1e-4);
    // OPEN_AT_END 不计入 totalR
    assert.ok(Math.abs(o.totalR - 2.5) < 1e-4);
});

test('stats：groupExpectancy 按组合分组', function () {
    var trades = [
        { status: 'WIN', realizedR: 2, context: { bias: 'BULLISH', amd: 'BULLISH' } },
        { status: 'LOSS', realizedR: -1, context: { bias: 'BULLISH', amd: 'BULLISH' } },
        { status: 'WIN', realizedR: 1.5, context: { bias: 'BEARISH', amd: 'BEARISH' } }
    ];
    var g = replayStats.groupExpectancy(trades, ['context.bias']);
    assert.strictEqual(g['BULLISH'].total, 2);
    assert.ok(Math.abs(g['BULLISH'].winRate - 0.5) < 1e-9);
    assert.strictEqual(g['BEARISH'].total, 1);
    var g2 = replayStats.groupExpectancy(trades, ['context.bias', 'context.amd']);
    assert.strictEqual(g2['BULLISH|BULLISH'].total, 2);
});

test('stats：AMBIGUOUS/EXPIRED 不参与 expectancy', function () {
    var trades = [
        { status: 'WIN', realizedR: 2, context: { bias: 'BULLISH' } },
        { status: 'AMBIGUOUS', realizedR: 0, context: { bias: 'BULLISH' } },
        { status: 'EXPIRED', realizedR: 0, context: { bias: 'BULLISH' } }
    ];
    var g = replayStats.groupExpectancy(trades, ['context.bias']);
    assert.strictEqual(g['BULLISH'].total, 1);
    assert.strictEqual(g['BULLISH'].wins, 1);
});

/* ================= replayEngine ================= */

test('engine：合成数据可跑通，steps 结构完整', function () {
    var data = replayData(200, 0.1);
    return replayEngine.runReplay(data, { amdLookback: 12 }).then(function (r) {
        assert.ok(r.steps.length >= 5);
        var s = r.steps[0];
        assert.ok('biasDirection' in s);
        assert.ok('amdState' in s);
        assert.ok('scenarioState' in s);
        assert.ok('action' in s);
        assert.ok('gateState' in s);
        assert.ok(r.steps.every(function (x) { return typeof x.evaluationTime === 'number'; }));
    });
});

test('engine：deterministic（两次运行 steps 一致）', function () {
    var data = replayData(200, 0.1);
    var r1 = null;
    var r2 = null;
    return replayEngine.runReplay(data, { amdLookback: 12 }).then(function (a) {
        r1 = a;
        return replayEngine.runReplay(data, { amdLookback: 12 });
    }).then(function (b) {
        r2 = b;
        assert.strictEqual(r1.steps.length, r2.steps.length);
        r1.steps.forEach(function (s, i) {
            assert.strictEqual(s.scenarioState, r2.steps[i].scenarioState);
            assert.strictEqual(s.gateState, r2.steps[i].gateState);
        });
    });
});

test('engine：trades 数组结构与 context 完整', function () {
    var data = replayData(240, 0.1);
    return replayEngine.runReplay(data, { amdLookback: 12 }).then(function (r) {
        r.trades.forEach(function (t) {
            assert.ok('direction' in t);
            assert.ok('status' in t);
            assert.ok('entryPrice' in t);
            assert.ok('rr' in t);
            assert.ok(t.context && t.context.bias);
        });
    });
});

test('engine：evaluationTime 单调递增（无未来数据）', function () {
    var data = replayData(200, 0.1);
    return replayEngine.runReplay(data, { amdLookback: 12 }).then(function (r) {
        var prev = 0;
        r.steps.forEach(function (s) {
            assert.ok(s.evaluationTime > prev);
            prev = s.evaluationTime;
        });
    });
});

/* ---------------- run ---------------- */

var passCount = 0;
var pending = [];

tests.forEach(function (t) {
    try {
        var ret = t.fn();
        if (ret && typeof ret.then === 'function') {
            pending.push(
                ret.then(function () {
                    console.log('PASS  ' + t.name);
                    passCount++;
                }).catch(function (e) {
                    console.log('FAIL  ' + t.name);
                    console.log('      ' + (e && e.message ? e.message : e));
                })
            );
        } else {
            console.log('PASS  ' + t.name);
            passCount++;
        }
    } catch (e) {
        console.log('FAIL  ' + t.name);
        console.log('      ' + (e && e.message ? e.message : e));
    }
});

Promise.all(pending).then(function () {
    console.log('--------------------------------');
    console.log(passCount + ' / ' + tests.length + ' passed');
    if (passCount !== tests.length) {
        process.exit(1);
    }
});
