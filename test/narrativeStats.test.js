/**
 * Phase 11D — Narrative Diagnostics 测试
 * 覆盖：biasAmdTable / alignmentForwardStats（MFE/MAE/DrawHit）/ amdRoleClassify / amdRoleTable
 */
var assert = require('assert');
var narrativeStats = require('../stats/narrativeStats');

var passed = 0;
var failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('PASS ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + ' -> ' + e.message);
    }
}

var BAR = 300000;
function m5(open, high, low, close, i) {
    var t = 1000000 + i * BAR;
    return { openTime: t, open: open, high: high, low: low, close: close, closeTime: t + BAR - 1, closed: true, source: 'futures' };
}

function step(over) {
    var s = {
        index: 0, evaluationTime: 0, price: 100,
        biasDirection: 'BULLISH', biasConfidence: 'MEDIUM',
        amdState: 'MANIPULATION_CONFIRMED', amdDirection: 'BULLISH',
        alignment: 'MATCH', scenarioState: 'BULLISH_WATCH',
        drawPrimaryBsl: 110, drawPrimarySsl: 90
    };
    if (over) { for (var k in over) s[k] = over[k]; }
    return s;
}

/* ---------- biasAmdTable ---------- */

test('biasAmdTable：组合 occupancy 正确', function () {
    var steps = [
        step({ biasDirection: 'BULLISH', amdDirection: 'BULLISH', amdState: 'MANIPULATION_CONFIRMED' }),
        step({ biasDirection: 'BULLISH', amdDirection: 'BULLISH', amdState: 'DISTRIBUTION_CONFIRMED' }),
        step({ biasDirection: 'BULLISH', amdDirection: 'BEARISH', amdState: 'MANIPULATION_CONFIRMED' }),
        step({ biasDirection: 'NEUTRAL', amdState: 'SEARCHING', amdDirection: null })
    ];
    var t = narrativeStats.biasAmdTable(steps);
    assert.strictEqual(t.total, 4);
    var bb = t.rows.filter(function (r) { return r.bias === 'BULLISH' && r.amd === 'BULLISH'; })[0];
    var ob = t.rows.filter(function (r) { return r.bias === 'BULLISH' && r.amd === 'BEARISH'; })[0];
    var nn = t.rows.filter(function (r) { return r.bias === 'NEUTRAL' && r.amd === 'NONE'; })[0];
    assert.strictEqual(bb.count, 2);
    assert.strictEqual(ob.count, 1);
    assert.strictEqual(nn.count, 1);
    assert.ok(Math.abs(bb.pct - 50) < 0.001);
});

test('biasAmdTable：SEARCHING 时 amdDir = NONE', function () {
    var t = narrativeStats.biasAmdTable([step({ amdState: 'SEARCHING', amdDirection: null })]);
    var row = t.rows[0];
    assert.strictEqual(row.amd, 'NONE');
});

/* ---------- alignmentForwardStats ---------- */

test('alignmentForwardStats：MATCH bullish 未来 MFE/MAE/DrawHit 正确', function () {
    var candles = [];
    var i;
    for (i = 0; i < 60; i++) {
        candles.push(m5(99, 101, 98, 100, i)); // 平缓
    }
    // 未来 10 根内 high 到 105（MFE 5%），low 到 97（MAE 3%），target 110 未触
    for (i = 0; i < 10; i++) {
        candles[i + 5] = m5(100, 105, 97, 103, i + 5);
    }
    // 未来 15-20 根 high 到 110（DrawHit）
    for (i = 15; i < 20; i++) {
        candles[i + 5] = m5(103, 110, 102, 108, i + 5);
    }

    var steps = [
        step({ index: 4, evaluationTime: candles[4].closeTime, price: candles[4].close, drawPrimaryBsl: 110 })
    ];
    var fwd = narrativeStats.alignmentForwardStats(steps, candles, { lookaheads: [12, 24, 48] });
    var m = fwd.MATCH;
    assert.ok(m);
    assert.strictEqual(m.n, 1);
    // lookahead 12: MFE = (105-100)/100 = 5%, MAE = (100-97)/100 = 3%, DrawHit = 0
    var s12 = m.lookaheads[12];
    assert.ok(Math.abs(s12.mfePct - 5.0) < 0.01, 'MFE12=' + s12.mfePct);
    assert.ok(Math.abs(s12.maePct - 3.0) < 0.01, 'MAE12=' + s12.maePct);
    assert.strictEqual(s12.hitRate, 0);
    // lookahead 48: DrawHit = 1（high 110 被触）
    var s48 = m.lookaheads[48];
    assert.strictEqual(s48.hitRate, 1);
});

test('alignmentForwardStats：bearish 对称（low 触 SSL target）', function () {
    var candles = [];
    var i;
    for (i = 0; i < 60; i++) {
        candles.push(m5(101, 102, 99, 100, i));
    }
    for (i = 5; i < 20; i++) {
        candles[i] = m5(100, 102, 90, 92, i); // low 90 <= SSL target 90 → hit
    }
    var steps = [
        step({
            index: 4, evaluationTime: candles[4].closeTime, price: candles[4].close,
            amdDirection: 'BEARISH', alignment: 'OPPOSITE', drawPrimarySsl: 90
        })
    ];
    var fwd = narrativeStats.alignmentForwardStats(steps, candles, { lookaheads: [24] });
    var o = fwd.OPPOSITE;
    assert.strictEqual(o.n, 1);
    assert.strictEqual(o.lookaheads[24].hitRate, 1);
});

/* ---------- amdRoleClassify ---------- */

test('amdRole：MATCH + 同向 → CONTINUATION', function () {
    assert.strictEqual(
        narrativeStats.amdRoleClassify(step({ alignment: 'MATCH', amdDirection: 'BULLISH', biasDirection: 'BULLISH' })),
        'CONTINUATION'
    );
});

test('amdRole：OPPOSITE + MED confidence → RETRACEMENT（核心假设）', function () {
    assert.strictEqual(
        narrativeStats.amdRoleClassify(step({ alignment: 'OPPOSITE', amdDirection: 'BEARISH', biasDirection: 'BULLISH', biasConfidence: 'MEDIUM' })),
        'RETRACEMENT'
    );
});

test('amdRole：OPPOSITE + LOW confidence → REVERSAL_CANDIDATE', function () {
    assert.strictEqual(
        narrativeStats.amdRoleClassify(step({ alignment: 'OPPOSITE', amdDirection: 'BEARISH', biasDirection: 'BULLISH', biasConfidence: 'LOW' })),
        'REVERSAL_CANDIDATE'
    );
});

test('amdRole：bias NEUTRAL → UNCLASSIFIED', function () {
    assert.strictEqual(
        narrativeStats.amdRoleClassify(step({ biasDirection: 'NEUTRAL', amdDirection: 'BULLISH' })),
        'UNCLASSIFIED'
    );
});

test('amdRole：AMD 无方向 → UNCLASSIFIED', function () {
    assert.strictEqual(
        narrativeStats.amdRoleClassify(step({ amdState: 'SEARCHING', amdDirection: null })),
        'UNCLASSIFIED'
    );
});

/* ---------- amdRoleTable ---------- */

test('amdRoleTable：occupancy 正确', function () {
    var steps = [
        step({ alignment: 'MATCH', amdDirection: 'BULLISH', biasDirection: 'BULLISH' }),
        step({ alignment: 'OPPOSITE', amdDirection: 'BEARISH', biasDirection: 'BULLISH', biasConfidence: 'MEDIUM' }),
        step({ alignment: 'OPPOSITE', amdDirection: 'BEARISH', biasDirection: 'BULLISH', biasConfidence: 'LOW' }),
        step({ biasDirection: 'NEUTRAL' })
    ];
    var t = narrativeStats.amdRoleTable(steps);
    assert.strictEqual(t.roles.CONTINUATION, 1);
    assert.strictEqual(t.roles.RETRACEMENT, 1);
    assert.strictEqual(t.roles.REVERSAL_CANDIDATE, 1);
    assert.strictEqual(t.roles.UNCLASSIFIED, 1);
});

console.log('');
console.log('narrativeStats: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
