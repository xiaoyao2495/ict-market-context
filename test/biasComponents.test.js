/**
 * liquidityBias / structureBias / locationBias 单元测试
 */
var assert = require('assert');
var liquidityBias = require('../bias/liquidityBias');
var structureBias = require('../bias/structureBias');
var locationBias = require('../bias/locationBias');

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

/* ---------- liquidityBias ---------- */

test('Draw BSL → +30', function () {
    var r = liquidityBias.scoreLiquidityBias({ direction: 'BSL' }, {});
    assert.strictEqual(r.score, 30);
});

test('Draw LEAN_BSL → +15', function () {
    assert.strictEqual(liquidityBias.scoreLiquidityBias({ direction: 'LEAN_BSL' }, {}).score, 15);
});

test('Draw BALANCED → 0', function () {
    var r = liquidityBias.scoreLiquidityBias({ direction: 'BALANCED', explanation: 'No active liquidity draw candidates' }, {});
    assert.strictEqual(r.score, 0);
    assert.ok(r.reason.indexOf('No active') !== -1);
});

test('Draw LEAN_SSL → -15', function () {
    assert.strictEqual(liquidityBias.scoreLiquidityBias({ direction: 'LEAN_SSL' }, {}).score, -15);
});

test('Draw SSL → -30', function () {
    assert.strictEqual(liquidityBias.scoreLiquidityBias({ direction: 'SSL' }, {}).score, -30);
});

test('无 draw 结果 → 0', function () {
    assert.strictEqual(liquidityBias.scoreLiquidityBias(null, {}).score, 0);
});

/* ---------- structureBias ---------- */

function struct(tf, structure) {
    return { timeframe: tf, structure: structure, reason: 'x' };
}

test('全 BULLISH：1D+4H+1H 加权合成 ≈ +20.75', function () {
    var r = structureBias.scoreStructureBias({
        '1d': struct('1d', 'BULLISH'),
        '4h': struct('4h', 'BULLISH'),
        '1h': struct('1h', 'BULLISH')
    }, {});
    // 25×0.45 + 20×0.40 + 10×0.15 = 11.25 + 8 + 1.5 = 20.75
    assert.strictEqual(r.score, 20.75);
    assert.strictEqual(r.breakdown['4h'].contribution, 8);
    assert.strictEqual(r.breakdown['1d'].contribution, 11.25);
});

test('全 BEARISH：-20.75', function () {
    var r = structureBias.scoreStructureBias({
        '1d': struct('1d', 'BEARISH'),
        '4h': struct('4h', 'BEARISH'),
        '1h': struct('1h', 'BEARISH')
    }, {});
    assert.strictEqual(r.score, -20.75);
});

test('混合：4H bullish + 1D bearish → 主周期贡献可见', function () {
    var r = structureBias.scoreStructureBias({
        '1d': struct('1d', 'BEARISH'),
        '4h': struct('4h', 'BULLISH'),
        '1h': struct('1h', 'NEUTRAL')
    }, {});
    // -25×0.45 + 20×0.40 + 0 = -11.25 + 8 = -3.25
    assert.strictEqual(r.score, -3.25);
});

test('CONFLICTED 周期 → 0 贡献', function () {
    var r = structureBias.scoreStructureBias({
        '1d': struct('1d', 'CONFLICTED'),
        '4h': struct('4h', 'BULLISH'),
        '1h': struct('1h', 'NEUTRAL')
    }, {});
    assert.strictEqual(r.breakdown['1d'].contribution, 0);
    assert.strictEqual(r.score, 8);
});

test('数据缺失 → 该周期 0 贡献', function () {
    var r = structureBias.scoreStructureBias({}, {});
    assert.strictEqual(r.score, 0);
});

/* ---------- locationBias ---------- */

test('bullish 参考 + DISCOUNT → +10', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'LEAN_BSL',
        location: { zone: 'DISCOUNT', intensity: 'MODERATE', ratio: 0.3 }
    }, {});
    assert.strictEqual(r.score, 10);
});

test('bullish 参考 + EXTREME_DISCOUNT → +15', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'BSL',
        location: { zone: 'DISCOUNT', intensity: 'EXTREME', ratio: 0.1 }
    }, {});
    assert.strictEqual(r.score, 15);
});

test('bullish 参考 + EQUILIBRIUM → 0', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'BSL',
        location: { zone: 'EQUILIBRIUM', intensity: 'MODERATE', ratio: 0.5 }
    }, {});
    assert.strictEqual(r.score, 0);
});

test('bullish 参考 + EXTREME_PREMIUM → -10（追高削弱）', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'BSL',
        location: { zone: 'PREMIUM', intensity: 'EXTREME', ratio: 0.9 }
    }, {});
    assert.strictEqual(r.score, -10);
});

test('bearish 参考 + PREMIUM → +10（对称）', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'SSL',
        location: { zone: 'PREMIUM', intensity: 'MODERATE', ratio: 0.7 }
    }, {});
    assert.strictEqual(r.score, 10);
});

test('bearish 参考 + EXTREME_PREMIUM → +15', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'LEAN_SSL',
        location: { zone: 'PREMIUM', intensity: 'EXTREME', ratio: 0.9 }
    }, {});
    assert.strictEqual(r.score, 15);
});

test('bearish 参考 + EXTREME_DISCOUNT → -10', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'SSL',
        location: { zone: 'DISCOUNT', intensity: 'EXTREME', ratio: 0.1 }
    }, {});
    assert.strictEqual(r.score, -10);
});

test('draw BALANCED → 0（location 不独立制造方向）', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'BALANCED',
        location: { zone: 'DISCOUNT', intensity: 'EXTREME', ratio: 0.1 }
    }, {});
    assert.strictEqual(r.score, 0);
});

test('无 range → 0', function () {
    var r = locationBias.scoreLocationBias({
        drawDirection: 'BSL',
        location: { zone: 'UNKNOWN', intensity: null, ratio: null }
    }, {});
    assert.strictEqual(r.score, 0);
});

console.log('----');
console.log('bias components: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
