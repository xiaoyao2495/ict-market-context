/**
 * exchangeInfo / tickSize 基础设施测试
 *
 * 核心验证点：
 * - parseExchangeInfo：tickSize 正确解析、symbol 匹配
 * - symbol 不存在 → tickSize null
 * - spot source 明确标注（不伪造 futures）
 * - tickSize 集成：equal / cluster tolerance = max(percent, tickSize * multiplier)
 */
var assert = require('assert');
var binanceRest = require('../data/binanceRest');
var equalLiquidity = require('../liquidity/equalLiquidity');
var liquidityCluster = require('../liquidity/liquidityCluster');

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

/**
 * 构造 Binance 风格 exchangeInfo 响应
 */
function exchangeInfoData(symbol, tickSize, stepSize) {
    return {
        symbols: [
            {
                symbol: symbol,
                pricePrecision: 1,
                filters: [
                    { filterType: 'PRICE_FILTER', tickSize: String(tickSize) },
                    { filterType: 'LOT_SIZE', stepSize: String(stepSize) }
                ]
            }
        ]
    };
}

/* ---------- parseExchangeInfo ---------- */

test('tickSize / stepSize 正确解析', function () {
    var info = binanceRest.parseExchangeInfo(
        exchangeInfoData('BTCUSDT', 0.1, 0.001),
        'BTCUSDT',
        'futures'
    );
    assert.strictEqual(info.symbol, 'BTCUSDT');
    assert.strictEqual(info.tickSize, 0.1);
    assert.strictEqual(info.stepSize, 0.001);
    assert.strictEqual(info.pricePrecision, 1);
    assert.strictEqual(info.source, 'futures');
});

test('symbol 查询正确：多 symbol 中找到目标', function () {
    var data = {
        symbols: [
            { symbol: 'ETHUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }] },
            { symbol: 'BTCUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }] },
            { symbol: 'BNBUSDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.1' }] }
        ]
    };
    var info = binanceRest.parseExchangeInfo(data, 'ETHUSDT', 'futures');
    assert.strictEqual(info.tickSize, 0.01);
});

test('symbol 不存在 → tickSize null（不伪造）', function () {
    var info = binanceRest.parseExchangeInfo(
        exchangeInfoData('BTCUSDT', 0.1, 0.001),
        'NOTEXIST',
        'futures'
    );
    assert.strictEqual(info.tickSize, null);
    assert.strictEqual(info.stepSize, null);
});

test('spot-mirror source 明确标注，不冒充 futures', function () {
    var info = binanceRest.parseExchangeInfo(
        exchangeInfoData('BTCUSDT', 0.01, 0.001),
        'BTCUSDT',
        'spot-mirror'
    );
    assert.strictEqual(info.source, 'spot-mirror'); // 现货 tickSize 有明确来源标记
    assert.notStrictEqual(info.source, 'futures');
});

test('无 PRICE_FILTER → tickSize null（容忍缺失）', function () {
    var data = {
        symbols: [{ symbol: 'BTCUSDT', filters: [] }]
    };
    var info = binanceRest.parseExchangeInfo(data, 'BTCUSDT', 'futures');
    assert.strictEqual(info.tickSize, null);
});

/* ---------- tolerance 集成 ---------- */

test('equal tolerance：tickSize 存在时升级为 max(percent, tickSize * multiplier)', function () {
    // price 100，percent 0.0002 → 0.02；tickSize 1 × 2 = 2 → tolerance 2
    var tol = equalLiquidity.toleranceFor(100, 0.0002, 1, 2);
    assert.strictEqual(tol, 2);
    // 无 tickSize → 纯百分比
    var tolNoTick = equalLiquidity.toleranceFor(100, 0.0002, 0, 2);
    assert.strictEqual(tolNoTick, 0.02);
});

test('cluster tolerance：tickSize 存在时升级', function () {
    var tol = liquidityCluster.toleranceFor(63000, 0.0003, 0.1, 2);
    // percent = 63000*0.0003 = 18.9；tick = 0.1*2 = 0.2 → max = 18.9
    assert.strictEqual(tol, 18.9);
    // 大 tickSize 主导：tickSize 100 × 2 = 200 > 18.9
    var tolBig = liquidityCluster.toleranceFor(63000, 0.0003, 100, 2);
    assert.strictEqual(tolBig, 200);
});

test('equal V2：tickSize 不再绕过 distanceATR Price Gate', function () {
    function swing(type, index, price, confirmedAt, openTime) {
        return {
            id: 'BTCUSDT:5m:' + type + ':' + openTime,
            symbol: 'BTCUSDT',
            timeframe: '5m',
            type: type,
            side: type === 'SWING_HIGH' ? 'BSL' : 'SSL',
            price: price,
            sourceOpenTime: openTime,
            sourceCloseTime: openTime + 300000 - 1,
            createdAt: confirmedAt,
            confirmedAt: confirmedAt,
            status: 'ACTIVE',
            touchedAt: null,
            sweptAt: null,
            brokenAt: null,
            metadata: { source: 'futures', index: index }
        };
    }
    var swings = [
        swing('SWING_HIGH', 10, 100, 1000, 10000),
        swing('SWING_HIGH', 20, 101.5, 2000, 20000)
    ];
    var result = equalLiquidity.detectEqualLiquidity(swings, {
        symbol: 'BTCUSDT',
        evaluationTime: 9999999999999,
        tickSize: 1,
        tickMultiplier: 2
    });
    // V2 缺少 formation-time candles/ATR 时 fail closed；tick tolerance 仅保留 audit 诊断。
    assert.strictEqual(result.length, 0);
});

console.log('----');
console.log('exchangeInfo/tickSize: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) {
    process.exit(1);
}
