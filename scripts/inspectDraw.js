/**
 * Draw on Liquidity 总览脚本（Phase 5）
 *
 * 输出：
 *   - 当前价格 + source（futures / spot-mirror）
 *   - BSL DRAW / SSL DRAW（候选排名，含 zone/target/strength/distance/draw score/reasons）
 *   - DRAW STATE（BSL Primary / SSL Primary / Imbalance / Liquidity Draw label）
 *
 * 原则：这是 liquidity draw，不是 HTF Bias。
 */
var binanceRest = require('../data/binanceRest');
var pivotDetector = require('../structure/pivotDetector');
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
var utcTime = require('../utils/utcTime');

var SYMBOL = 'BTCUSDT';
var RIGHT = 2;
var evaluationTime = Date.now();

var TYPE_LABEL = {
    SWING_HIGH: '5m Swing',
    SWING_LOW: '5m Swing',
    EQH: 'EQH',
    EQL: 'EQL',
    PDH: 'PDH',
    PDL: 'PDL',
    PWH: 'PWH',
    PWL: 'PWL',
    PMH: 'PMH',
    PML: 'PML',
    ASIA_HIGH: 'Asia High',
    ASIA_LOW: 'Asia Low',
    LONDON_HIGH: 'London High',
    LONDON_LOW: 'London Low',
    NEW_YORK_HIGH: 'NY High',
    NEW_YORK_LOW: 'NY Low'
};

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

function candidateTitle(c) {
    if (c.targetType === 'CLUSTER') {
        return c.sourceTypes.map(function (t) {
            return TYPE_LABEL[t] || t;
        }).join(' + ') + ' Cluster';
    }
    return TYPE_LABEL[c.sourceTypes[0]] || c.sourceTypes[0];
}

function showCandidate(c, idx, side) {
    var sign = side === 'BSL' ? '+' : '-';
    console.log('#' + idx);
    console.log(candidateTitle(c));
    if (c.targetType === 'CLUSTER') {
        console.log('Zone: ' + c.zoneLow.toFixed(2) + ' - ' + c.zoneHigh.toFixed(2));
    }
    console.log('Target: ' + c.targetPrice.toFixed(2));
    console.log('Strength: ' + c.strength);
    console.log('Distance: ' + sign + (c.distancePct * 100).toFixed(2) + '%');
    console.log('Distance Score: ' + c.distanceScore);
    console.log('Freshness: ' + c.freshness);
    console.log('Draw Score: ' + c.drawScore);
    if (c.reasons) {
        console.log('Reasons:');
        c.reasons.forEach(function (r) {
            console.log('  - ' + r);
        });
    }
    console.log('');
}

Promise.all([
    binanceRest.getKlines(SYMBOL, '5m', 200),
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

        var lastCandle = candles5m[candles5m.length - 1];
        var currentPrice = lastCandle ? lastCandle.close : null;
        if (currentPrice === null) {
            throw new Error('No closed 5m candle for current price');
        }
        var source = lastCandle.source || 'n/a';

        // Swing + EQH/EQL（tickSize 参与 equal tolerance）
        var pivots = pivotDetector.detectPivots(candles5m, {
            left: RIGHT,
            right: RIGHT
        });
        var swing = swingLiquidity.buildSwingLiquidity(
            SYMBOL, '5m', pivots, candles5m, RIGHT
        );
        var equal = equalLiquidity.detectEqualLiquidity(swing, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            tickSize: exchangeInfo.tickSize
        });

        // Calendar + Sessions
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
                candles5m: candles5m
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

        // 回放 5m 推进 lifecycle（与 inspectLiquidity 一致）
        ctx.candles5m.forEach(function (candle) {
            if (candle.closed === false) {
                return;
            }
            registry.getAll(SYMBOL).forEach(function (l) {
                if (l.confirmedAt > candle.closeTime) {
                    return;
                }
                var result = lifecycle.evaluateLiquidity(l, candle);
                if (!result) {
                    return;
                }
                registry.applyLifecycleEvent(l.id, result);
            });
        });

        // Clusters + Strength（tickSize 参与 cluster tolerance）
        var all = registry.getAll(SYMBOL);
        var clusters = liquidityCluster.buildClusters(all, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime,
            tickSize: ctx.exchangeInfo.tickSize
        });
        clusters.forEach(function (c) {
            var breakdown = liquidityScorer.scoreCluster(c, {});
            c.strength = breakdown.final;
            c.metadata.strengthBreakdown = breakdown;
            var catSet = {};
            c.members.forEach(function (m) {
                catSet[liquidityScorer.categoryOf(m)] = true;
            });
            c.metadata.categories = Object.keys(catSet);
        });

        // Draw Engine
        var result = drawEngine.runDrawEngine({
            symbol: SYMBOL,
            currentPrice: ctx.currentPrice,
            evaluationTime: evaluationTime,
            registry: registry,
            clusters: clusters
        });

        // ---- 输出 ----
        console.log('========================================');
        console.log(SYMBOL);
        console.log('Price: ' + ctx.currentPrice.toFixed(2));
        console.log('Source: ' + (ctx.source === 'futures' ? 'futures' : ctx.source + ' (dev only)'));
        if (ctx.exchangeInfo.tickSize !== null) {
            console.log('tickSize: ' + ctx.exchangeInfo.tickSize + ' [' + ctx.exchangeInfo.source + ']');
        } else {
            console.log('tickSize: null (tolerance = percentage only)');
        }
        console.log('');

        console.log('============================');
        console.log('BSL DRAW (上方目标)');
        console.log('============================');
        if (result.bsl.candidates.length === 0) {
            console.log('(no active BSL candidates)');
        }
        result.bsl.candidates.slice(0, 5).forEach(function (c, i) {
            showCandidate(c, i + 1, 'BSL');
        });

        console.log('============================');
        console.log('SSL DRAW (下方目标)');
        console.log('============================');
        if (result.ssl.candidates.length === 0) {
            console.log('(no active SSL candidates)');
        }
        result.ssl.candidates.slice(0, 5).forEach(function (c, i) {
            showCandidate(c, i + 1, 'SSL');
        });

        console.log('============================');
        console.log('DRAW STATE');
        console.log('============================');
        console.log('BSL Primary: ' + (result.bsl.primary ? result.bsl.primary.drawScore : 'n/a'));
        if (result.bsl.primary) {
            console.log('  -> ' + candidateTitle(result.bsl.primary) + ' @ ' + result.bsl.primary.targetPrice.toFixed(2));
        }
        console.log('SSL Primary: ' + (result.ssl.primary ? result.ssl.primary.drawScore : 'n/a'));
        if (result.ssl.primary) {
            console.log('  -> ' + candidateTitle(result.ssl.primary) + ' @ ' + result.ssl.primary.targetPrice.toFixed(2));
        }
        console.log('Imbalance: ' + (result.imbalance >= 0 ? '+' : '') + result.imbalance);
        console.log('Liquidity Draw: ' + result.direction);
        if (result.explanation) {
            console.log('Explanation: ' + result.explanation);
        }
        console.log('');
        console.log('IMPORTANT: This is liquidity draw, NOT HTF Bias.');
        console.log('========================================');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
