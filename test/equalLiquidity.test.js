/** Equal Liquidity V2 production pipeline tests. */
var assert = require('assert');
var equalLiquidity = require('../liquidity/equalLiquidity');
var productionThresholds = require('../config/thresholds').equalLiquidity;

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

var STEP = 300000;
var START = 1700000000000;

function candles(count) {
    var rows = [];
    for (var i = 0; i < count; i++) {
        rows.push({
            openTime: START + i * STEP,
            closeTime: START + (i + 1) * STEP - 1,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            closed: true,
            source: 'futures'
        });
    }
    return rows;
}

function swing(type, index, price, rows) {
    var confirmedIndex = index + 2;
    return {
        id: 'BTCUSDT:5m:' + type + ':' + rows[index].openTime,
        symbol: 'BTCUSDT',
        timeframe: '5m',
        type: type,
        side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
        price: price,
        sourceOpenTime: rows[index].openTime,
        sourceCloseTime: rows[index].closeTime,
        createdAt: rows[confirmedIndex].closeTime,
        confirmedAt: rows[confirmedIndex].closeTime,
        status: 'ACTIVE',
        touchedAt: null,
        sweptAt: null,
        brokenAt: null,
        metadata: { source: 'futures', index: index }
    };
}

function highPair(opts) {
    var o = opts || {};
    var rows = candles(o.count || 280);
    var firstIndex = o.firstIndex === undefined ? 20 : o.firstIndex;
    var secondIndex = o.secondIndex === undefined ? 30 : o.secondIndex;
    var firstPrice = o.firstPrice === undefined ? 110 : o.firstPrice;
    var secondPrice = o.secondPrice === undefined ? 109.5 : o.secondPrice;
    rows[firstIndex].high = firstPrice;
    rows[secondIndex].high = secondPrice;
    for (var i = firstIndex + 1; i < secondIndex; i++) {
        rows[i].high = o.interHigh === undefined ? 101 : o.interHigh;
        rows[i].low = o.interLow === undefined ? 99 : o.interLow;
        rows[i].close = o.interClose === undefined ? 100 : o.interClose;
    }
    return {
        candles: rows,
        swings: [
            swing('SWING_HIGH', firstIndex, firstPrice, rows),
            swing('SWING_HIGH', secondIndex, secondPrice, rows)
        ],
        evaluationTime: rows[secondIndex + 2].closeTime
    };
}

function lowPair() {
    var rows = candles(80);
    rows[20].low = 90;
    rows[30].low = 90.5;
    for (var i = 21; i < 30; i++) {
        rows[i].high = 101;
        rows[i].low = 99;
    }
    return {
        candles: rows,
        swings: [
            swing('SWING_LOW', 20, 90, rows),
            swing('SWING_LOW', 30, 90.5, rows)
        ],
        evaluationTime: rows[32].closeTime
    };
}

function run(fixture, extra) {
    var opts = extra || {};
    opts.symbol = 'BTCUSDT';
    if (opts.evaluationTime === undefined) opts.evaluationTime = fixture.evaluationTime;
    opts.candles = fixture.candles;
    return equalLiquidity.evaluateEqualLiquidityPipeline(fixture.swings, opts);
}

test('Lifecycle → Price → Formation → Grouping 生成 VALID EQH', function () {
    var f = highPair();
    var result = run(f);
    assert.strictEqual(result.validPairs.length, 1);
    assert.strictEqual(result.objects.length, 1);
    assert.strictEqual(result.objects[0].type, 'EQH');
    assert.strictEqual(result.objects[0].metadata.pipelineVersion, 2);
    assert.strictEqual(result.objects[0].metadata.classification, 'VALID_EQ');
});

test('EQL 使用对称 formation geometry', function () {
    var result = run(lowPair());
    assert.strictEqual(result.validPairs.length, 1);
    assert.strictEqual(result.objects[0].type, 'EQL');
    assert.strictEqual(result.objects[0].side, 'SSL');
});

test('SWEPT first swing 在 second confirmedAt 时 REJECT', function () {
    var f = highPair();
    f.candles[25].high = 111;
    f.candles[25].close = 100;
    var result = run(f);
    assert.strictEqual(result.pairs[0].firstSwingState, 'SWEPT');
    assert.strictEqual(result.pairs[0].classification, 'REJECT_EQ');
    assert.strictEqual(result.pairs[0].rejectionReason, 'FIRST_SWING_SWEPT');
    assert.strictEqual(result.objects.length, 0);
});

test('BROKEN first swing 在 second confirmedAt 时 REJECT', function () {
    var f = highPair();
    f.candles[25].high = 112;
    f.candles[25].close = 111;
    var result = run(f);
    assert.strictEqual(result.pairs[0].firstSwingState, 'BROKEN');
    assert.strictEqual(result.pairs[0].rejectionReason, 'FIRST_SWING_BROKEN');
    assert.strictEqual(result.objects.length, 0);
});

test('production replay fast path 会计入当前 confirmation candle 的 lifecycle', function () {
    var f = highPair();
    var secondConfirmIndex = f.swings[1].metadata.index + 2;
    f.candles[secondConfirmIndex].high = 111;
    f.candles[secondConfirmIndex].close = 100;
    var result = equalLiquidity.evaluateEqualLiquidityPipeline(f.swings, {
        symbol: 'BTCUSDT',
        evaluationTime: f.evaluationTime,
        candles: f.candles,
        canonicalClosedCandles: true,
        lifecycleFromCurrentState: true,
        secondSwingIds: [f.swings[1].id]
    });
    assert.strictEqual(result.pairs[0].firstSwingState, 'SWEPT');
    assert.strictEqual(result.pairs[0].classification, 'REJECT_EQ');
});

test('TOUCHED first swing 保持 lifecycle eligible', function () {
    var f = highPair({ secondPrice: 110 });
    var result = run(f);
    assert.strictEqual(result.pairs[0].firstSwingState, 'TOUCHED');
    assert.strictEqual(result.pairs[0].lifecycleEligible, true);
    assert.strictEqual(result.pairs[0].classification, 'VALID_EQ');
});

test('distanceATR > 1.1 即使 formation 很强仍 REJECT', function () {
    var f = highPair({ firstPrice: 130, secondPrice: 100, interLow: 80 });
    var result = run(f);
    assert(result.pairs[0].distanceATR > 1.1);
    assert.strictEqual(result.pairs[0].departureATR, null);
    assert.strictEqual(result.pairs[0].rejectionReason, 'PRICE_FAIL');
    assert.strictEqual(result.objects.length, 0);
});

test('Price PASS 但 formation 不独立 → BORDERLINE_EQ', function () {
    var f = highPair({ interHigh: 109.4, interLow: 108.7, interClose: 109 });
    var result = run(f);
    assert(result.pairs[0].distanceATR <= 0.7);
    assert(result.pairs[0].departureATR < 1.75);
    assert.strictEqual(result.pairs[0].classification, 'BORDERLINE_EQ');
    assert.strictEqual(result.objects.length, 0);
});

test('Price gray band + strong formation → BORDERLINE_EQ', function () {
    var f = highPair({ secondPrice: 108 });
    var cfg = Object.assign({}, productionThresholds, {
        priceStrongMaxATR: 0.1,
        priceFailAboveATR: 1.1
    });
    var result = run(f, { thresholds: cfg });
    assert(result.pairs[0].distanceATR > cfg.priceStrongMaxATR);
    assert(result.pairs[0].distanceATR <= cfg.priceFailAboveATR);
    assert(result.pairs[0].departureATR >= cfg.formationDepartureMinATR);
    assert.strictEqual(result.pairs[0].classification, 'BORDERLINE_EQ');
});

test('barsApart 小于旧 minBarsApart 不再 hard reject', function () {
    var f = highPair({ firstIndex: 20, secondIndex: 22, interHigh: 90, interLow: 80 });
    var cfg = Object.assign({}, productionThresholds, {
        formationDepartureMinATR: 0,
        formationMinConsecutiveOutsideBars: 0
    });
    var result = run(f, { thresholds: cfg });
    assert.strictEqual(result.pairs[0].barsApart, 2);
    assert.notStrictEqual(result.pairs[0].rejectionReason, 'BARS_APART');
});

test('barsApart 大于旧 maxBarsApart 不再 hard reject', function () {
    var f = highPair({ count: 280, firstIndex: 20, secondIndex: 225 });
    var result = run(f);
    assert.strictEqual(result.pairs[0].barsApart, 205);
    assert.notStrictEqual(result.pairs[0].rejectionReason, 'BARS_APART');
    assert.strictEqual(result.pairs[0].classification, 'VALID_EQ');
});

test('0.5 ATR outside 使用完整 wick range，而非 close', function () {
    var f = highPair();
    var result = run(f);
    var pair = result.pairs[0];
    assert(pair.maxConsecutiveBarsOutsideZone_0_5ATR >= 1);
    // 让所有 inter-swing high 回到 zone，但 close 仍远离：full-range persistence 应归零。
    for (var i = 21; i < 30; i++) {
        f.candles[i].high = 109.5;
        f.candles[i].close = 100;
    }
    result = run(f);
    assert.strictEqual(result.pairs[0].maxConsecutiveBarsOutsideZone_0_5ATR, 0);
    assert.strictEqual(result.pairs[0].classification, 'BORDERLINE_EQ');
});

test('bounded grouping 不做 graph transitive closure', function () {
    var rows = candles(90);
    [20, 30, 40].forEach(function (idx) {
        for (var i = idx + 1; i < idx + 10; i++) {
            rows[i].high = 101;
            rows[i].low = 99;
        }
    });
    rows[20].high = 110;
    rows[30].high = 109.7;
    rows[40].high = 109.4;
    var swings = [
        swing('SWING_HIGH', 20, 110, rows),
        swing('SWING_HIGH', 30, 109.7, rows),
        swing('SWING_HIGH', 40, 109.4, rows)
    ];
    var cfg = Object.assign({}, productionThresholds, {
        priceStrongMaxATR: 0.12,
        priceFailAboveATR: 1.1
    });
    var result = equalLiquidity.evaluateEqualLiquidityPipeline(swings, {
        symbol: 'BTCUSDT',
        evaluationTime: rows[42].closeTime,
        candles: rows,
        thresholds: cfg
    });
    assert.strictEqual(result.validPairs.length, 2); // A-B, B-C；A-C 不是 valid
    assert.strictEqual(result.objects.length, 1);
    assert.strictEqual(result.objects[0].metadata.memberCount, 2);
});

test('second swing confirmedAt 之前不生成 pair/object', function () {
    var f = highPair();
    var early = run(f, { evaluationTime: f.swings[1].confirmedAt - 1 });
    assert.strictEqual(early.pairs.length, 0);
    assert.strictEqual(early.objects.length, 0);
});

test('second confirmedAt 之后的 extreme candle 不改变 formation features', function () {
    var f = highPair();
    var atFormation = run(f).pairs[0];
    f.candles[40].high = 200;
    f.candles[40].low = 1;
    f.candles[40].close = 150;
    f.evaluationTime = f.candles[45].closeTime;
    var later = run(f).pairs[0];
    assert.strictEqual(later.distanceATR, atFormation.distanceATR);
    assert.strictEqual(later.departureATR, atFormation.departureATR);
    assert.strictEqual(
        later.maxConsecutiveBarsOutsideZone_0_5ATR,
        atFormation.maxConsecutiveBarsOutsideZone_0_5ATR
    );
    assert.strictEqual(later.firstSwingState, atFormation.firstSwingState);
});

test('未收盘 candle 不参与 lifecycle / formation', function () {
    var f = highPair();
    f.candles[25].closed = false;
    f.candles[25].high = 120;
    f.candles[25].close = 100;
    var result = run(f);
    assert.notStrictEqual(result.pairs[0].firstSwingState, 'SWEPT');
});

test('缺少 ATR/candle context 时 fail closed，不回退旧 percentage detector', function () {
    var f = highPair();
    var result = equalLiquidity.evaluateEqualLiquidityPipeline(f.swings, {
        symbol: 'BTCUSDT',
        evaluationTime: f.evaluationTime
    });
    assert.strictEqual(result.pairs[0].classification, 'REJECT_EQ');
    assert.strictEqual(result.pairs[0].rejectionReason, 'SECOND_CONFIRMATION_CANDLE_UNAVAILABLE');
    assert.strictEqual(result.objects.length, 0);
});

test('object confirmedAt、member reference 与 id deterministic', function () {
    var f = highPair();
    var r1 = run(f).objects[0];
    var r2 = run(f).objects[0];
    assert.strictEqual(r1.confirmedAt, f.swings[1].confirmedAt);
    assert.strictEqual(r1.metadata.members[0], f.swings[0]);
    assert.strictEqual(r1.metadata.members[1], f.swings[1]);
    assert.strictEqual(r1.id, r2.id);
    assert.strictEqual(r1.price, (110 + 109.5) / 2);
});

test('历史 tolerance helper 保持 audit 兼容', function () {
    assert.strictEqual(equalLiquidity.toleranceFor(100, 0.0002, 1, 2), 2);
});

console.log('----');
console.log('equalLiquidity V2: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
