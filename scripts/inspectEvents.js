/**
 * Market Events 总览脚本（Phase 7.1）
 *
 * 输出：
 *   - 最近 LIQUIDITY_SWEEP / MSS / DISPLACEMENT 事件
 *   - Delivery Chain（Sweep → MSS → Displacement）+ Delivery Score
 *   - 数据源标注（futures / spot-mirror）
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
var eventEngine = require('../events/eventEngine');
var deliveryBias = require('../bias/deliveryBias');
var utcTime = require('../utils/utcTime');

var SYMBOL = 'BTCUSDT';
var RIGHT = 2;
var evaluationTime = Date.now();

function cachedFetcher(candlesByInterval) {
    return function (symbol, interval, limit, startTime, endTime) {
        return Promise.resolve(candlesByInterval[interval] || []);
    };
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

function formatHM(ms) {
    var d = new Date(ms);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
}

function formatPrice(p) {
    return Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

Promise.all([
    binanceRest.getKlines(SYMBOL, '5m', 300),
    binanceRest.getKlines(SYMBOL, '1d', 5),
    binanceRest.getKlines(SYMBOL, '1w', 3),
    binanceRest.getKlines(SYMBOL, '1M', 3),
    binanceRest.getExchangeInfo(SYMBOL)
])
    .then(function (results) {
        var candles5m = results[0];
        var candles1d = results[1];
        var candles1w = results[2];
        var candles1M = results[3];
        var exchangeInfo = results[4];

        // Swing（MSS reference 用）
        var pivots = pivotDetector.detectPivots(candles5m, { left: RIGHT, right: RIGHT });
        var swing = swingLiquidity.buildSwingLiquidity(SYMBOL, '5m', pivots, candles5m, RIGHT);

        // Calendar + Sessions（sweep 的 liquidity 池）
        var fetcher = cachedFetcher({ '1d': candles1d, '1w': candles1w, '1M': candles1M });
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
            var registry = liquidityRegistry.createRegistry();
            registry.addMany(swing);
            registry.addMany(equalLiquidity.detectEqualLiquidity(swing, {
                symbol: SYMBOL,
                evaluationTime: evaluationTime,
                tickSize: exchangeInfo.tickSize
            }));
            registry.addMany(more[0]);
            registry.addMany(more[1]);
            registry.addMany(more[2]);
            registry.addMany(more[3]);
            return {
                candles5m: candles5m,
                swing: swing,
                registry: registry,
                source: candles5m.length ? candles5m[candles5m.length - 1].source : 'n/a',
                tickSize: exchangeInfo.tickSize
            };
        });
    })
    .then(function (ctx) {
        // Event Engine（完整流水线）
        var out = eventEngine.runEventEngine({
            symbol: SYMBOL,
            timeframe: '5m',
            candles: ctx.candles5m,
            swings: ctx.swing,
            liquidityRegistry: ctx.registry
        });
        var reg = out.eventRegistry;

        // Delivery Bias 消费 Event Registry
        var delivery = deliveryBias.scoreDeliveryBias({
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            timeframe: '5m',
            eventRegistry: reg
        }, {});

        // ---- 输出 ----
        console.log('========================================');
        console.log(SYMBOL + ' 5m  MARKET EVENTS  [' + ctx.source + ']');
        console.log('');

        var showType = function (type, label, limit) {
            var events = reg.getRecent(SYMBOL, type, evaluationTime, limit);
            console.log('RECENT ' + label + ' (' + events.length + ')');
            console.log('────────────────────────────');
            events.forEach(function (e) {
                var arrow = e.direction === 'BULLISH' ? '🟢' : '🔴';
                console.log(formatHM(e.confirmedAt) + '  ' + arrow + ' ' + e.direction + ' ' + label);
                if (type === 'LIQUIDITY_SWEEP') {
                    console.log('  ' + (e.source.liquidityType || '?') + ' ' + formatPrice(e.price));
                } else if (type === 'MSS') {
                    console.log('  Broke ' + formatPrice(e.price) + ' ' + (e.direction === 'BULLISH' ? 'swing high' : 'swing low'));
                    console.log('  Close ' + formatPrice(e.source.candle.close) + '  bodyRatio ' + e.metadata.bodyRatio);
                } else if (type === 'DISPLACEMENT') {
                    console.log('  Body Ratio: ' + e.metadata.bodyRatio + '  Range: ' + e.metadata.rangeAtr.toFixed(2) + ' ATR');
                    console.log('  Score: ' + e.metadata.score + '/' + e.metadata.maxScore);
                }
                console.log('');
            });
        };
        showType('LIQUIDITY_SWEEP', 'BSL/SSL SWEEP', 5);
        showType('MSS', 'MSS', 5);
        showType('DISPLACEMENT', 'DISPLACEMENT', 5);

        console.log('DELIVERY CHAIN');
        console.log('────────────────────────────');
        if (!delivery.available) {
            console.log('  (no delivery events)');
        } else if (!delivery.sweep) {
            console.log('  events present but no valid chain');
        } else {
            var chain = [];
            chain.push((delivery.direction === 'BULLISH' ? 'SSL' : 'BSL') + ' Sweep');
            if (delivery.mss) chain.push((delivery.direction === 'BULLISH' ? 'Bullish' : 'Bearish') + ' MSS');
            if (delivery.displacement) chain.push((delivery.direction === 'BULLISH' ? 'Bullish' : 'Bearish') + ' Displacement');
            console.log('  ' + chain.join('\n  → '));
            console.log('Delivery Score: ' + delivery.score);
            console.log('Bias Impact: ' + (delivery.direction ? delivery.direction + ' DELIVERY' : 'NONE'));
        }
        console.log('');
        console.log('IMPORTANT: confirmedAt = trigger candle.closeTime.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
