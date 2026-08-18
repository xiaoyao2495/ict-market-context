/**
 * HTF Bias 总览脚本（Phase 6.2 完整链路）
 *
 * 输出：
 *   Direction / Score / Confidence
 *   COMPONENTS：Liquidity / Structure / Location / Delivery（score + direction + reasons）
 *   CONFLICTS
 *   EVIDENCE COVERAGE
 *
 * 完整链路：Liquidity → Draw → HTF Context → Delivery → Bias
 * 注意：MSS / Displacement 检测器在 Phase 7/8 就位，当前 delivery 只消费真实 sweep 事件。
 */
var binanceRest = require('../data/binanceRest');
var pivotDetector = require('../structure/pivotDetector');
var swingClassifier = require('../structure/swingClassifier');
var dealingRange = require('../structure/dealingRange');
var premiumDiscount = require('../context/premiumDiscount');
var swingLiquidity = require('../liquidity/swingLiquidity');
var dailyLiquidity = require('../liquidity/dailyLiquidity');
var weeklyLiquidity = require('../liquidity/weeklyLiquidity');
var monthlyLiquidity = require('../liquidity/monthlyLiquidity');
var sessionLiquidity = require('../liquidity/sessionLiquidity');
var equalLiquidity = require('../liquidity/equalLiquidity');
var lifecycle = require('../liquidity/liquidityLifecycle');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var liquidityCluster = require('../liquidity/liquidityCluster');
var liquidityScorer = require('../liquidity/liquidityScorer');
var drawEngine = require('../draw/drawEngine');
var biasEngine = require('../bias/biasEngine');
var utcTime = require('../utils/utcTime');

var SYMBOL = 'BTCUSDT';
var RIGHT = 2;
var evaluationTime = Date.now();
var STRUCTURE_TIMEFRAMES = ['1d', '4h', '1h'];

function cachedFetcher(candlesByInterval) {
    return function (symbol, interval, limit, startTime, endTime) {
        return Promise.resolve(candlesByInterval[interval] || []);
    };
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

function formatUTC(ms) {
    var d = new Date(ms);
    return (
        utcTime.formatDateUTC(ms) +
        ' ' +
        pad2(d.getUTCHours()) +
        ':' +
        pad2(d.getUTCMinutes()) +
        ' UTC'
    );
}

function sign(n) {
    return n > 0 ? '+' + n : String(n);
}

var requests = {
    '5m': binanceRest.getKlines(SYMBOL, '5m', 200),
    '1d': binanceRest.getKlines(SYMBOL, '1d', 150),
    '1w': binanceRest.getKlines(SYMBOL, '1w', 3),
    '1M': binanceRest.getKlines(SYMBOL, '1M', 3)
};
STRUCTURE_TIMEFRAMES.forEach(function (tf) {
    if (!requests[tf]) {
        requests[tf] = binanceRest.getKlines(SYMBOL, tf, 200);
    }
});
requests.exchangeInfo = binanceRest.getExchangeInfo(SYMBOL);

Promise.all(
    Object.keys(requests).map(function (k) {
        return requests[k].then(function (v) {
            return [k, v];
        });
    })
)
    .then(function (pairs) {
        var data = {};
        pairs.forEach(function (p) {
            data[p[0]] = p[1];
        });
        return data;
    })
    .then(function (data) {
        var candles5m = data['5m'];
        var exchangeInfo = data.exchangeInfo;
        var lastCandle = candles5m[candles5m.length - 1];
        var currentPrice = lastCandle ? lastCandle.close : null;
        if (currentPrice === null) {
            throw new Error('No closed 5m candle for current price');
        }
        var source = lastCandle.source || 'n/a';

        // ---------- Draw 管道 ----------
        var pivots5m = pivotDetector.detectPivots(candles5m, { left: RIGHT, right: RIGHT });
        var swing = swingLiquidity.buildSwingLiquidity(SYMBOL, '5m', pivots5m, candles5m, RIGHT);
        var equal = equalLiquidity.detectEqualLiquidity(swing, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            tickSize: exchangeInfo.tickSize
        });

        var fetcher = cachedFetcher({ '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] });
        var dailyP = dailyLiquidity.getDailyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var weeklyP = weeklyLiquidity.getWeeklyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var monthlyP = monthlyLiquidity.getMonthlyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var sessionP = Promise.all(
            ['ASIA', 'LONDON', 'NEW_YORK'].map(function (name) {
                return sessionLiquidity.getSessionLiquidity(SYMBOL, name, evaluationTime, {
                    candles: candles5m
                });
            })
        ).then(function (lists) {
            var out = [];
            lists.forEach(function (l) {
                out = out.concat(l);
            });
            return out;
        });

        return Promise.all([dailyP, weeklyP, monthlyP, sessionP]).then(function (more) {
            return {
                currentPrice: currentPrice,
                source: source,
                exchangeInfo: exchangeInfo,
                swing: swing,
                equal: equal,
                daily: more[0],
                weekly: more[1],
                monthly: more[2],
                sessions: more[3],
                candles5m: candles5m,
                candles: data
            };
        });
    })
    .then(function (ctx) {
        var registry = liquidityRegistry.createRegistry();
        registry.addMany(ctx.swing);
        registry.addMany(ctx.equal);
        registry.addMany(ctx.daily);
        registry.addMany(ctx.weekly);
        registry.addMany(ctx.monthly);
        registry.addMany(ctx.sessions);

        // 回放 5m：推进 lifecycle 并收集 sweep 事件（confirmedAt = 触发 candle closeTime）
        var sweeps = [];
        ctx.candles5m.forEach(function (candle) {
            if (candle.closed === false) return;
            registry.getAll(SYMBOL).forEach(function (l) {
                if (l.confirmedAt > candle.closeTime) return;
                var result = lifecycle.evaluateLiquidity(l, candle);
                if (!result) return;
                registry.applyLifecycleEvent(l.id, result);
                if (result.status === 'SWEPT') {
                    sweeps.push({
                        id: l.id,
                        symbol: SYMBOL,
                        timeframe: '5m',
                        side: l.side,
                        direction: l.side === 'SSL' ? 'BULLISH' : 'BEARISH',
                        price: l.price,
                        confirmedAt: result.event.at
                    });
                }
            });
        });

        // Clusters + Strength
        var all = registry.getAll(SYMBOL);
        var clusters = liquidityCluster.buildClusters(all, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            tickSize: ctx.exchangeInfo.tickSize
        });
        clusters.forEach(function (c) {
            var bd = liquidityScorer.scoreCluster(c, {});
            c.strength = bd.final;
            c.metadata.strengthBreakdown = bd;
        });

        // Draw Engine
        var drawResult = drawEngine.runDrawEngine({
            symbol: SYMBOL,
            currentPrice: ctx.currentPrice,
            evaluationTime: evaluationTime,
            registry: registry,
            clusters: clusters
        });

        // Structure（1D / 4H / 1H）
        var structures = {};
        var structurePivots = {};
        STRUCTURE_TIMEFRAMES.forEach(function (tf) {
            var candles = ctx.candles[tf];
            var pivots = candles
                ? pivotDetector.detectPivots(candles, { left: RIGHT, right: RIGHT })
                : [];
            structurePivots[tf] = pivots;
            structures[tf] = swingClassifier.classifyStructure(pivots, {
                timeframe: tf,
                evaluationTime: evaluationTime
            });
        });

        // Location
        var range = dealingRange.buildDealingRange(
            structurePivots['4h'],
            { evaluationTime: evaluationTime }
        );
        var location = premiumDiscount.classifyLocation(ctx.currentPrice, range, {});

        // ---------- Bias Engine（完整链路） ----------
        var bias = biasEngine.runBiasEngine({
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            timeframe: '5m',
            draw: drawResult,
            structures: structures,
            location: location,
            events: {
                sweeps: sweeps,
                mss: [], // MSS 检测器 Phase 7/8 就位
                displacements: []
            }
        });

        // ---------- 输出 ----------
        console.log('========================================');
        console.log(SYMBOL + '  HTF BIAS（完整链路 Phase 6.2）');
        console.log('Price: ' + ctx.currentPrice.toFixed(2) + '   [' + ctx.source + ']');
        console.log('Time: ' + formatUTC(evaluationTime));
        console.log('');
        console.log('Direction: ' + bias.direction);
        console.log('Score: ' + sign(bias.score));
        console.log('Confidence: ' + bias.confidence);
        console.log('');

        console.log('COMPONENTS');
        console.log('━━━━━━━━━━━━━━━━━━━━');
        showComponent('Liquidity', bias.components.liquidity);
        showComponent('Structure', bias.components.structure);
        showComponent('Location', bias.components.location);
        showComponent('Delivery', bias.components.delivery);

        console.log('CONFLICTS');
        console.log('━━━━━━━━━━━━━━━━━━━━');
        if (bias.conflicts.length === 0) {
            console.log('  None');
        }
        bias.conflicts.forEach(function (cf) {
            console.log('  ⚠ ' + cf.type + ' [' + cf.severity + ']');
            console.log('    ' + cf.reason);
        });
        console.log('');

        console.log('EVIDENCE COVERAGE: ' + bias.evidenceCoverage.available + '/' + bias.evidenceCoverage.total);
        console.log('');
        console.log('Bullish evidence:');
        bias.explanation.bullish.forEach(function (t) {
            console.log('  ✓ ' + t);
        });
        if (bias.explanation.bullish.length === 0) console.log('  (none)');
        console.log('Bearish evidence:');
        bias.explanation.bearish.forEach(function (t) {
            console.log('  ✓ ' + t);
        });
        if (bias.explanation.bearish.length === 0) console.log('  (none)');
        console.log('');
        console.log('IMPORTANT: Bias Score is not probability.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });

function showComponent(name, c) {
    console.log(name + ': ' + sign(c.score) + '  [' + c.direction + ']' + (c.available ? '' : '  (no data)'));
    (c.reasons || []).forEach(function (r) {
        console.log('    - ' + r);
    });
}
