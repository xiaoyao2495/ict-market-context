/**
 * Scenario / Action 总览脚本（Phase 8）
 *
 * 输出：
 *   - Bias / Draw / AMD / Alignment
 *   - Scenario State / Action
 *   - Scenario Quality（0-100，不是 probability）
 *   - Confirmed / Waiting / Conflicts / Invalidation
 *
 * 核心原则：Direction ≠ Action。Bias 有方向不代表 BUY。
 * setupReadyType = 'CONTEXT_READY'（Phase 8 无 FVG，非 Entry Ready）。
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
var amdAlignment = require('../amd/amdAlignment');
var scenarioEngine = require('../scenario/scenarioEngine');

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

            var events = eventEngine.runEventEngine({
                symbol: SYMBOL, timeframe: '5m',
                candles: candles5m, swings: swing, liquidityRegistry: registry
            });

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
        var amd = amdStateMachine.runAmd({
            symbol: SYMBOL,
            timeframe: '5m',
            candles: ctx.candles5m,
            evaluationTime: evaluationTime,
            liquidityRegistry: ctx.registry,
            eventRegistry: ctx.eventRegistry,
            draw: ctx.draw
        });
        var alignment = amdAlignment.align(ctx.bias, amd.direction);

        var scenario = scenarioEngine.runScenarioEngine({
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            bias: ctx.bias,
            draw: ctx.draw,
            amd: amd,
            alignment: alignment.alignment,
            conflicts: ctx.bias.conflicts,
            delivery: ctx.bias.components.delivery
        });

        // ---- 输出 ----
        console.log('========================================');
        console.log(SYMBOL + '  SCENARIO  [' + ctx.source + ']');
        console.log('Price: ' + ctx.currentPrice.toFixed(2));
        console.log('');
        console.log('BIAS');
        console.log('  Direction: ' + ctx.bias.direction + '  Score ' + ctx.bias.score);
        console.log('  Confidence: ' + ctx.bias.confidence);
        console.log('');
        console.log('DRAW');
        console.log('  Direction: ' + ctx.draw.direction + '  Imbalance ' + ctx.draw.imbalance);
        if (ctx.draw.bsl && ctx.draw.bsl.primary) {
            console.log('  Primary BSL: ' + ctx.draw.bsl.primary.targetType + ' ' +
                ctx.draw.bsl.primary.targetPrice + '  Draw ' + ctx.draw.bsl.primary.drawScore);
        }
        if (ctx.draw.ssl && ctx.draw.ssl.primary) {
            console.log('  Primary SSL: ' + ctx.draw.ssl.primary.targetType + ' ' +
                ctx.draw.ssl.primary.targetPrice + '  Draw ' + ctx.draw.ssl.primary.drawScore);
        }
        console.log('');
        console.log('AMD');
        console.log('  State: ' + amd.state);
        console.log('  Direction: ' + (amd.direction || 'NONE'));
        console.log('  Score: ' + amd.score + '  (not probability)');
        console.log('  Alignment: ' + alignment.alignment +
            (alignment.biasConfidenceLow ? '  (bias confidence LOW)' : ''));
        console.log('');
        console.log('SCENARIO');
        console.log('  State: ' + scenario.scenarioState);
        console.log('  Action: ' + scenario.action);
        if (scenario.setupReadyType) {
            console.log('  Setup Ready Type: ' + scenario.setupReadyType + ' (NOT Entry Ready)');
        }
        console.log('  Quality: ' + scenario.quality.total + ' / 100  [' + scenario.quality.quality + ']');
        console.log('  (Scenario Score is not probability)');
        console.log('');
        console.log('CONFIRMED');
        scenario.explanation.confirmations.forEach(function (c) { console.log('  ✓ ' + c); });
        if (scenario.explanation.confirmations.length === 0) {
            console.log('  (none)');
        }
        console.log('');
        console.log('WAITING');
        scenario.explanation.missing.forEach(function (m) { console.log('  ○ ' + m); });
        if (scenario.explanation.missing.length === 0) {
            console.log('  (none)');
        }
        console.log('');
        console.log('CONFLICTS');
        scenario.explanation.conflicts.forEach(function (c) { console.log('  ⚠ ' + c); });
        if (scenario.explanation.conflicts.length === 0) {
            console.log('  None');
        }
        console.log('');
        console.log('INVALIDATION');
        scenario.explanation.invalidation.forEach(function (i) { console.log('  - ' + i); });
        console.log('');
        console.log('IMPORTANT: Direction != Action. This is market state, not an entry signal.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
