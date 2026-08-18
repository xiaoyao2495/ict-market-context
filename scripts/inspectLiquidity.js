/**
 * Liquidity Map 总览脚本（Phase 4）
 *
 * 输出：
 *   - 当前价格 + source
 *   - ACTIVE BSL CLUSTERS / ACTIVE SSL CLUSTERS（zone + strength + members）
 *   - STANDALONE（未进入任何 cluster 的 ACTIVE liquidity，带 strength）
 *   - RECENT SWEPT / RECENT BROKEN（5m 回放事件）
 *   - Registry 统计（Total / Active / Touched / Swept / Broken）
 *
 * 数据来源：5m(200) / 1d(5) / 1w(3) / 1M(3)，Swing + EQH/EQL + PDH/PDL +
 * PWH/PWL + PMH/PML + Session(ASIA/LONDON/NEW_YORK)。
 *
 * 回放安全：
 *   - 只用已收盘 K 线；liquidity.confirmedAt <= candle.closeTime 才允许被触发
 *   - Cluster 为 Registry 派生视图，不写入 Registry
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

function padRight(s, n) {
    while (s.length < n) {
        s += ' ';
    }
    return s;
}

/**
 * strength → 星标
 */
function stars(strength) {
    if (strength >= 90) return '★★★★★';
    if (strength >= 80) return '★★★★☆';
    if (strength >= 70) return '★★★☆☆';
    if (strength >= 60) return '★★☆☆☆';
    return '★☆☆☆☆';
}

function labelOf(l) {
    return TYPE_LABEL[l.type] || l.type;
}

function memberLabel(m) {
    var mult = m.type === 'EQH' || m.type === 'EQL' ? ' × ' + m.metadata.memberCount : '';
    return labelOf(m) + mult + ' ' + m.price.toFixed(2);
}

function fetchAll() {
    return Promise.all([
        binanceRest.getKlines(SYMBOL, '5m', 200),
        binanceRest.getKlines(SYMBOL, '1d', 5),
        binanceRest.getKlines(SYMBOL, '1w', 3),
        binanceRest.getKlines(SYMBOL, '1M', 3)
    ]);
}

fetchAll()
    .then(function (results) {
        var candles5m = results[0];
        var candles1d = results[1];
        var candles1w = results[2];
        var candles1M = results[3];

        var lastCandle = candles5m[candles5m.length - 1];
        var currentPrice = lastCandle ? lastCandle.close : null;

        // Swing + EQH/EQL
        var pivots = pivotDetector.detectPivots(candles5m, {
            left: RIGHT,
            right: RIGHT
        });
        var swing = swingLiquidity.buildSwingLiquidity(
            SYMBOL,
            '5m',
            pivots,
            candles5m,
            RIGHT
        );
        var equal = equalLiquidity.detectEqualLiquidity(swing, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime
        });

        // Calendar（Daily / Weekly / Monthly）
        var fetcher = cachedFetcher({ '1d': candles1d, '1w': candles1w, '1M': candles1M });
        var dailyP = dailyLiquidity.getDailyLiquidity(SYMBOL, evaluationTime, {
            fetcher: fetcher
        });
        var weeklyP = weeklyLiquidity.getWeeklyLiquidity(SYMBOL, evaluationTime, {
            fetcher: fetcher
        });
        var monthlyP = monthlyLiquidity.getMonthlyLiquidity(SYMBOL, evaluationTime, {
            fetcher: fetcher
        });

        // Sessions（ASIA / LONDON / NEW_YORK，复用 5m candles）
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
                swing: swing,
                equal: equal,
                daily: more[0],
                weekly: more[1],
                monthly: more[2],
                sessions: more[3],
                candles5m: candles5m,
                source: lastCandle ? lastCandle.source : 'n/a'
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

        // 回放 5m 已收盘 K 线，推进生命周期并收集事件
        var recentSwept = [];
        var recentBroken = [];
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
                if (result.status === 'SWEPT') {
                    recentSwept.push({ l: l, at: result.event.at });
                } else if (result.status === 'BROKEN') {
                    recentBroken.push({ l: l, at: result.event.at });
                }
            });
        });

        // Cluster（派生视图）+ Strength
        var all = registry.getAll(SYMBOL);
        var clusters = liquidityCluster.buildClusters(all, {
            symbol: SYMBOL,
            evaluationTime: evaluationTime
        });
        clusters.forEach(function (c) {
            var breakdown = liquidityScorer.scoreCluster(c, {});
            c.strength = breakdown.final;
            c.metadata.strengthBreakdown = breakdown;
            // 填充类别
            var catSet = {};
            c.members.forEach(function (m) {
                catSet[liquidityScorer.categoryOf(m)] = true;
            });
            c.metadata.categories = Object.keys(catSet);
        });

        // Standalone（未进 cluster 的 ACTIVE）
        var standalone = liquidityCluster.findStandalone(all, clusters, {
            evaluationTime: evaluationTime
        });
        standalone.forEach(function (s) {
            s._score = liquidityScorer.scoreIndividual(s, {});
        });

        // 输出
        var bslClusters = clusters
            .filter(function (c) { return c.side === 'BSL'; })
            .sort(function (a, b) { return b.strength - a.strength; });
        var sslClusters = clusters
            .filter(function (c) { return c.side === 'SSL'; })
            .sort(function (a, b) { return b.strength - a.strength; });
        var standaloneBSL = standalone
            .filter(function (s) { return s.side === 'BSL'; })
            .sort(function (a, b) { return b._score - a._score; });
        var standaloneSSL = standalone
            .filter(function (s) { return s.side === 'SSL'; })
            .sort(function (a, b) { return b._score - a._score; });

        console.log('══════════════════════════════════════');
        console.log('=== ' + SYMBOL + ' Liquidity Map @ ' + formatUTC(evaluationTime) + ' ===');
        console.log('Price: ' + (ctx.currentPrice !== null ? ctx.currentPrice.toFixed(2) : 'n/a') + '   [source: ' + ctx.source + ']');
        console.log('');

        var showClusters = function (list, title) {
            console.log('════ ' + title + ' ════');
            if (list.length === 0) {
                console.log('  (none)');
                console.log('');
                return;
            }
            list.forEach(function (c, idx) {
                console.log(stars(c.strength) + ' Cluster #' + (idx + 1));
                console.log('  Zone: ' + c.zoneLow.toFixed(2) + ' - ' + c.zoneHigh.toFixed(2));
                console.log('  Strength: ' + c.strength + '  [' + c.state + ']');
                console.log('  Members:');
                c.members.forEach(function (m) {
                    var mark = m.status === 'ACTIVE' || m.status === 'TOUCHED' ? ' ' : ' *' + m.status;
                    console.log('    ' + memberLabel(m) + mark);
                });
                var bd = c.metadata.strengthBreakdown;
                console.log('    (base ' + bd.base + ' + conf ' + bd.confluenceBonus + ' + div ' + bd.diversityBonus + ')');
                console.log('');
            });
        };
        showClusters(bslClusters, 'ACTIVE BSL CLUSTERS');
        showClusters(sslClusters, 'ACTIVE SSL CLUSTERS');

        var showStandalone = function (list, title) {
            console.log('════ ' + title + ' ════');
            if (list.length === 0) {
                console.log('  (none)');
                console.log('');
                return;
            }
            list.forEach(function (s) {
                console.log(
                    stars(s._score) + ' ' + padRight(labelOf(s), 14) +
                    s.price.toFixed(2) + '  Strength: ' + s._score
                );
            });
            console.log('');
        };
        showStandalone(standaloneBSL, 'STANDALONE BSL (未进 cluster)');
        showStandalone(standaloneSSL, 'STANDALONE SSL (未进 cluster)');

        var showRecent = function (events, title) {
            console.log('════ ' + title + ' ════');
            var slice = events.slice(-5);
            if (slice.length === 0) {
                console.log('  (none)');
                console.log('');
                return;
            }
            slice.forEach(function (e) {
                console.log(
                    '  ' + padRight(labelOf(e.l), 16) +
                    e.l.price.toFixed(2) + '  at ' + formatUTC(e.at)
                );
            });
            console.log('');
        };
        showRecent(recentSwept, 'RECENT SWEPT');
        showRecent(recentBroken, 'RECENT BROKEN');

        console.log('════ REGISTRY ════');
        console.log(
            'Total:   ' + registry.size() + '\n' +
            'Active:  ' + registry.getActive(SYMBOL).length + '\n' +
            'Touched: ' + registry.getByStatus(SYMBOL, 'TOUCHED').length + '\n' +
            'Swept:   ' + registry.getByStatus(SYMBOL, 'SWEPT').length + '\n' +
            'Broken:  ' + registry.getByStatus(SYMBOL, 'BROKEN').length
        );
        console.log('══════════════════════════════════════');
    })
    .catch(function (error) {
        console.error(error);
        process.exit(1);
    });
