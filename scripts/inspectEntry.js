/**
 * Entry Gate 总览脚本（Phase 9）
 *
 * 输出：
 *   - SCENARIO / ACTION
 *   - ENTRY GATE 状态（CLOSED / WAITING_FVG / WAITING_RETRACE / ENTRY_READY / INVALIDATED）
 *   - primary FVG 详情（zone / midpoint / score / 关联事件）
 *   - Current Price / Waiting
 *
 * 核心原则：
 *   FVG 不是独立信号；只有 Action = WATCH 时 Entry Gate 才运行。
 *   ENTRY_READY 只是 entry confirmation ready，不是自动交易。
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
var fvgDetector = require('../fvg/fvgDetector');
var fvgRegistry = require('../fvg/fvgRegistry');
var fvgScorer = require('../fvg/fvgScorer');
var entryGate = require('../entry/entryGate');
var entryExplanation = require('../entry/entryExplanation');

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
                exchangeInfo: exchangeInfo,
                displacementEvents: events.displacementEvents
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

        // ---- FVG 检测（只消费已确认 displacement） ----
        var fvgList = fvgDetector.detectFvg(ctx.candles5m, {
            symbol: SYMBOL,
            timeframe: '5m',
            evaluationTime: evaluationTime,
            tickSize: ctx.exchangeInfo.tickSize,
            displacements: ctx.displacementEvents
        });
        var fvgReg = fvgRegistry.createFvgRegistry();
        fvgReg.addMany(fvgList);

        // ---- Entry Gate（只在 WATCH 运行） ----
        var gate = entryGate.runEntryGate({
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            currentPrice: ctx.currentPrice,
            scenario: scenario,
            action: scenario.action,
            amd: amd,
            alignment: alignment.alignment,
            fvgs: fvgReg.getBefore(evaluationTime)
        }, {});
        var explanation = entryExplanation.buildEntryExplanation(gate, {
            scenario: scenario,
            amd: amd,
            alignment: alignment.alignment,
            action: scenario.action
        }, {});

        // ---- 输出 ----
        console.log('========================================');
        console.log(SYMBOL + '  ENTRY  [' + ctx.source + ']');
        console.log('Price: ' + ctx.currentPrice.toFixed(2));
        console.log('');
        console.log('SCENARIO');
        console.log('  ' + scenario.scenarioState);
        console.log('  Action: ' + scenario.action);
        console.log('');
        console.log('AMD');
        console.log('  State: ' + amd.state + '  Direction: ' + (amd.direction || 'NONE'));
        console.log('  Alignment: ' + alignment.alignment);
        console.log('');
        console.log('FVG');
        console.log('  Detected: ' + fvgList.length + ' (all closed candles, gap >= min)');
        fvgList.slice(-3).forEach(function (f) {
            var scored = fvgScorer.scoreFvg(f, {
                amdDirection: amd.direction,
                scenarioDirection: scenario.direction
            }, {});
            console.log('  ' + f.direction + ' ' + f.zoneLow + ' - ' + f.zoneHigh +
                '  status ' + f.status + '  score ' + scored.total +
                (f.displacementEventId ? '  [disp]' : ''));
        });
        console.log('');
        console.log('ENTRY GATE');
        console.log('  State: ' + gate.state);
        if (gate.reason) {
            console.log('  Reason: ' + gate.reason);
        }
        if (gate.invalidatedReason) {
            console.log('  Invalidated: ' + gate.invalidatedReason);
        }
        if (gate.fvg) {
            console.log('  Primary FVG: ' + gate.fvg.direction + '  ' +
                gate.fvg.zoneLow + ' - ' + gate.fvg.zoneHigh +
                '  Midpoint ' + gate.fvg.midpoint + '  Score ' + gate.fvg._score);
            console.log('  Associated: displacement ' + (gate.fvg.displacementEventId ? 'YES' : 'NO') +
                (gate.fvg.metadata && gate.fvg.metadata.displacementMetadata &&
                 gate.fvg.metadata.displacementMetadata.mssEventId ? ' + MSS' : ''));
        }
        if (gate.entryZone) {
            console.log('  Entry Zone: ' + gate.entryZone.low + ' - ' + gate.entryZone.high +
                '  Preferred: ' + gate.entryZone.midpoint + ' (midpoint)');
        }
        console.log('');
        console.log('WAITING');
        explanation.waiting.forEach(function (w) { console.log('  ○ ' + w); });
        if (explanation.waiting.length === 0) {
            console.log('  (none)');
        }
        console.log('');
        console.log('IMPORTANT: ENTRY_READY is entry confirmation, not automatic trade execution.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
