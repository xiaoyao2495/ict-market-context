'use strict';

var VERSION = 'EQ_FVG_COUNT_WATCH_V1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function watchId(liquidity) {
    return VERSION + ':' + liquidity.id;
}

function rawFvgAt(candles, index, symbol) {
    if (index < 2) return null;
    var k1 = candles[index - 2];
    var k3 = candles[index];
    if (!k1 || !k3 || k3.closed === false) return null;
    var direction = null;
    var low = null;
    var high = null;
    if (k3.low > k1.high) {
        direction = 'BULLISH';
        low = k1.high;
        high = k3.low;
    } else if (k3.high < k1.low) {
        direction = 'BEARISH';
        low = k3.high;
        high = k1.low;
    } else {
        return null;
    }
    return {
        id: ['RAW_3C_FVG', symbol, '5m', direction, k1.openTime, k3.closeTime].join(':'),
        symbol: symbol,
        timeframe: '5m',
        direction: direction,
        k1Index: index - 2,
        k3Index: index,
        k1OpenTime: k1.openTime,
        confirmedAt: k3.closeTime,
        low: low,
        high: high
    };
}

function anchorPriceOf(liquidity) {
    var current = liquidity.metadata && liquidity.metadata.currentPivot;
    return current && current.price !== undefined ? current.price : liquidity.price;
}

function buildWatch(liquidity) {
    var type = liquidity && (liquidity.liquidityType || liquidity.type);
    if (!liquidity || !liquidity.id || (type !== 'EQL' && type !== 'EQH')) return null;
    return {
        watchId: watchId(liquidity),
        version: VERSION,
        symbol: liquidity.symbol,
        timeframe: liquidity.timeframe || '5m',
        liquidityId: liquidity.id,
        liquidityType: type,
        liquidityPrice: liquidity.price,
        liquidityAnchorPrice: anchorPriceOf(liquidity),
        expectedDirection: type === 'EQL' ? 'BULLISH' : 'BEARISH',
        openedAt: liquidity.confirmedAt,
        bullFvgCount: 0,
        bearFvgCount: 0,
        firstBullFvg: null,
        secondBullFvg: null,
        firstBearFvg: null,
        secondBearFvg: null,
        notification1Delivered: false,
        notification2Delivered: false,
        status: 'OPEN',
        closedAt: null,
        closeReason: null,
        consumedRawFvgIds: []
    };
}

function notificationFor(watch, rawFvg, ordinal) {
    return {
        version: VERSION,
        watchId: watch.watchId,
        symbol: watch.symbol,
        timeframe: watch.timeframe,
        liquidityId: watch.liquidityId,
        liquidityType: watch.liquidityType,
        liquidityPrice: watch.liquidityPrice,
        expectedDirection: watch.expectedDirection,
        eqConfirmedAt: watch.openedAt,
        ordinal: ordinal,
        rawFvg: clone(rawFvg),
        watchStatusAfterEvent: ordinal === 2 ? 'CLOSED' : 'OPEN'
    };
}

function consume(watch, rawFvg) {
    if (!watch || watch.status !== 'OPEN' || !rawFvg) return { changed: false, notification: null };
    if (rawFvg.confirmedAt < watch.openedAt) return { changed: false, notification: null };
    if (watch.consumedRawFvgIds.indexOf(rawFvg.id) >= 0) return { changed: false, notification: null };
    watch.consumedRawFvgIds.push(rawFvg.id);

    var isBull = rawFvg.direction === 'BULLISH';
    var countField = isBull ? 'bullFvgCount' : 'bearFvgCount';
    var firstField = isBull ? 'firstBullFvg' : 'firstBearFvg';
    var secondField = isBull ? 'secondBullFvg' : 'secondBearFvg';
    watch[countField] += 1;
    if (watch[countField] === 1) watch[firstField] = clone(rawFvg);
    if (watch[countField] === 2) watch[secondField] = clone(rawFvg);

    var matching = rawFvg.direction === watch.expectedDirection;
    var notification = matching && watch[countField] <= 2
        ? notificationFor(watch, rawFvg, watch[countField]) : null;
    if (watch[countField] === 2) {
        watch.status = 'CLOSED';
        watch.closedAt = rawFvg.confirmedAt;
        watch.closeReason = matching ? 'SECOND_MATCHING_FVG' : 'SECOND_OPPOSITE_FVG';
        if (notification) notification.watchStatusAfterEvent = 'CLOSED';
    }
    return { changed: true, notification: notification };
}

function createStateMachine(options) {
    var opts = options || {};
    var watches = {};
    (opts.watches || []).forEach(function (watch) {
        if (watch && watch.version === VERSION && watch.watchId) watches[watch.watchId] = clone(watch);
    });

    function step(input) {
        var opened = [];
        var notifications = [];
        var changed = false;
        (input.newEqualLiquidity || []).forEach(function (liquidity) {
            var candidate = buildWatch(liquidity);
            if (!candidate || watches[candidate.watchId]) return;
            watches[candidate.watchId] = candidate;
            opened.push(clone(candidate));
            changed = true;
        });
        var rawFvg = input.rawFvg || null;
        if (rawFvg) {
            Object.keys(watches).sort().forEach(function (id) {
                var result = consume(watches[id], rawFvg);
                if (result.changed) changed = true;
                if (result.notification) notifications.push(result.notification);
            });
        }
        return { changed: changed, opened: opened, notifications: notifications };
    }

    return {
        step: step,
        get: function (id) { return watches[id] || null; },
        getAll: function () { return Object.keys(watches).sort().map(function (id) { return clone(watches[id]); }); },
        markDelivered: function (id, ordinal) {
            var watch = watches[id];
            if (!watch) return false;
            var field = ordinal === 1 ? 'notification1Delivered' : 'notification2Delivered';
            if (watch[field]) return false;
            watch[field] = true;
            return true;
        }
    };
}

module.exports = {
    VERSION: VERSION,
    watchId: watchId,
    rawFvgAt: rawFvgAt,
    buildWatch: buildWatch,
    consume: consume,
    createStateMachine: createStateMachine
};
