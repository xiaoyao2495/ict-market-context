/**
 * AMD 总览脚本（Phase 7.2）
 *
 * 输出：
 *   - AMD State / Direction / AMD Score
 *   - ACCUMULATION / MANIPULATION / DISTRIBUTION 各阶段详情
 *   - BIAS + Alignment
 *
 * AMD 是 LTF price action 事实；Bias Alignment 是上下文评价。
 * AMD Score 不是 probability；AMD is observation only。
 */
var binanceRest = require('../data/binanceRest');
var pivotDetector = require('../structure/pivotDetector');
var swingLiquidity = require('../liquidity/swingLiquidity');
var dailyLiquidity = require('../liquidity/dailyLiquidity');
var weeklyLiquidity = require('../liquidity/weeklyLiquidity');
var monthlyLiquidity = require('../liquidity/monthlyLiquidity');
var sessionLiquidity = require('../liquidity/sessionLiquidity');
var equalLiquidity = require('../liquidity/equalLiquidity');
var liquidityRegistry = require('../liquidity/liquidityRegistry');
var liquidityCluster = require('../liquidity/liquidityCluster');
var liquidityScorer = require('../liquidity/liquidityScorer');
var eventEngine = require('../events/eventEngine');
var drawEngine = require('../draw/drawEngine');
var biasEngine = require('../bias/biasEngine');
var swingClassifier = require('../structure/swingClassifier');
var dealingRange = require('../structure/dealingRange');
var premiumDiscount = require('../context/premiumDiscount');
var amdStateMachine = require('../amd/amdStateMachine');
var amdScorer = require('../amd/amdScorer');
var amdAlignment = require('../amd/amdAlignment');
var amdExplanation = require('../amd/amdExplanation');

var SYMBOL = 'BTCUSDT';
var RIGHT = 2;
var evaluationTime = Date.now();
var STRUCTURE_TIMEFRAMES = ['1d', '4h', '1h'];

function cachedFetcher(candlesByInterval) {
    return function (symbol, interval, limit, startTime, endTime) {
        return Promise.resolve(candlesByInterval[interval] || []);
    };
}

var requests = {
    '5m': binanceRest.getKlines(SYMBOL, '5m', 300),
    '1d': binanceRest.getKlines(SYMBOL, '1d', 150),
    '1w': binanceRest.getKlines(SYMBOL, '1w', 3),
    '1M': binanceRest.getKlines(SYMBOL, '1M', 3)
};
STRUCTURE_TIMEFRAMES.forEach(function (tf) {
    if (!requests[tf]) requests[tf] = binanceRest.getKlines(SYMBOL, tf, 200);
});
requests.exchangeInfo = binanceRest.getExchangeInfo(SYMBOL);

Promise.all(Object.keys(requests).map(function (k) {
    return requests[k].then(function (v) { return [k, v]; });
}))
    .then(function (pairs) {
        var data = {};
        pairs.forEach(function (p) { data[p[0]] = p[1]; });
        return data;
    })
    .then(function (data) {
        var candles5m = data['5m'];
        var exchangeInfo = data.exchangeInfo;
        var currentPrice = candles5m[candles5m.length - 1].close;

        var pivots = pivotDetector.detectPivots(candles5m, { left: RIGHT, right: RIGHT });
        var swing = swingLiquidity.buildSwingLiquidity(SYMBOL, '5m', pivots, candles5m, RIGHT);
        var equal = equalLiquidity.detectEqualLiquidity(swing, {
            symbol: SYMBOL, evaluationTime: evaluationTime, tickSize: exchangeInfo.tickSize
        });

        var fetcher = cachedFetcher({ '1d': data['1d'], '1w': data['1w'], '1M': data['1M'] });
        var dailyP = dailyLiquidity.getDailyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var weeklyP = weeklyLiquidity.getWeeklyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var monthlyP = monthlyLiquidity.getMonthlyLiquidity(SYMBOL, evaluationTime, { fetcher: fetcher });
        var sessionP = Promise.all(
            ['ASIA', 'LONDON', 'NEW_YORK'].map(function (name) {
                return sessionLiquidity.getSessionLiquidity(SYMBOL, name, evaluationTime, { candles: candles5m });
            })
        ).then(function (lists) {
            var out = [];
            lists.forEach(function (l) { out = out.concat(l); });
            return out;
        });

        return Promise.all([dailyP, weeklyP, monthlyP, sessionP]).then(function (more) {
            var registry = liquidityRegistry.createRegistry();
            registry.addMany(swing);
            registry.addMany(equal);
            registry.addMany(more[0]);
            registry.addMany(more[1]);
            registry.addMany(more[2]);
            registry.addMany(more[3]);

            // Event Engine（sweep 事件 + 推进 lifecycle）
            var events = eventEngine.runEventEngine({
                symbol: SYMBOL, timeframe: '5m',
                candles: candles5m, swings: swing, liquidityRegistry: registry
            });

            // Clusters + Draw
            var all = registry.getAll(SYMBOL);
            var clusters = liquidityCluster.buildClusters(all, {
                symbol: SYMBOL, evaluationTime: evaluationTime, tickSize: exchangeInfo.tickSize
            });
            clusters.forEach(function (c) {
                var bd = liquidityScorer.scoreCluster(c, {});
                c.strength = bd.final;
                c.metadata.strengthBreakdown = bd;
            });
            var draw = drawEngine.runDrawEngine({
                symbol: SYMBOL, currentPrice: currentPrice,
                evaluationTime: evaluationTime, registry: registry, clusters: clusters
            });

            // Structure + Location（bias 需要）
            var structures = {};
            var structurePivots = {};
            STRUCTURE_TIMEFRAMES.forEach(function (tf) {
                var candles = data[tf];
                var ps = candles ? pivotDetector.detectPivots(candles, { left: RIGHT, right: RIGHT }) : [];
                structurePivots[tf] = ps;
                structures[tf] = swingClassifier.classifyStructure(ps, { timeframe: tf, evaluationTime: evaluationTime });
            });
            var range = dealingRange.buildDealingRange(structurePivots['4h'], { evaluationTime: evaluationTime });
            var location = premiumDiscount.classifyLocation(currentPrice, range, {});

            // Bias
            var bias = biasEngine.runBiasEngine({
                symbol: SYMBOL, evaluationTime: evaluationTime, timeframe: '5m',
                draw: draw, structures: structures, location: location,
                events: {
                    sweeps: events.sweepEvents,
                    mss: events.mssEvents,
                    displacements: events.displacementEvents
                }
            });

            return {
                currentPrice: currentPrice,
                source: candles5m[candles5m.length - 1].source,
                candles5m: candles5m,
                registry: registry,
                eventRegistry: events.eventRegistry,
                draw: draw,
                bias: bias,
                exchangeInfo: exchangeInfo
            };
        });
    })
    .then(function (ctx) {
        // AMD
        var amd = amdStateMachine.runAmd({
            symbol: SYMBOL,
            timeframe: '5m',
            candles: ctx.candles5m,
            evaluationTime: evaluationTime,
            liquidityRegistry: ctx.registry,
            eventRegistry: ctx.eventRegistry,
            draw: ctx.draw
        });
        var scored = amdScorer.scoreAmd(amd);
        var alignment = amdAlignment.align(ctx.bias, amd.direction);
        var explanation = amdExplanation.buildAmdExplanation(amd, alignment);

        // ---- 输出 ----
        console.log('========================================');
        console.log(SYMBOL + ' 5m  AMD  [' + ctx.source + ']');
        console.log('Price: ' + ctx.currentPrice.toFixed(2));
        console.log('');
        console.log('State: ' + amd.state);
        console.log('Direction Candidate: ' + (amd.direction || 'NONE'));
        console.log('AMD Score: ' + scored.score + '  (not probability)');
        console.log('');

        if (amd.accumulation) {
            var a = amd.accumulation;
            console.log('ACCUMULATION  Score ' + a.score);
            a.reasons.forEach(function (r) { console.log('  ✓ ' + r); });
            console.log('');
        }
        if (amd.manipulation) {
            var m = amd.manipulation;
            console.log('MANIPULATION  Score ' + m.score + '  [' + m.direction + ']');
            m.reasons.forEach(function (r) { console.log('  ✓ ' + r); });
            console.log('');
        }
        if (amd.distribution) {
            var d = amd.distribution;
            console.log('DISTRIBUTION  Score ' + d.score + '  [' + d.direction + ']');
            d.reasons.forEach(function (r) { console.log('  ✓ ' + r); });
            console.log('');
        } else {
            console.log('DISTRIBUTION');
            console.log('  ○ pending (no matching MSS/displacement yet)');
            console.log('');
        }

        console.log('BIAS');
        console.log('  HTF Bias: ' + ctx.bias.direction + '  Score ' + ctx.bias.score + '  Confidence ' + ctx.bias.confidence);
        console.log('  Alignment: ' + alignment.alignment + (alignment.biasConfidenceLow ? '  (bias confidence LOW)' : ''));
        if (amd.invalidationReason) {
            console.log('  INVALIDATED: ' + amd.invalidationReason);
        }
        console.log('');
        console.log('Action: NONE');
        console.log('AMD is observation only.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
