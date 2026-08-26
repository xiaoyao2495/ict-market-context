#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var performance = require('perf_hooks').performance;
var binance = require('../data/binanceRest');
var liveEngine = require('../live/liveEngine');
var displacementWatch = require('../stats/displacementWatch');
var thresholds = require('../config/thresholds');

var ROOT = path.resolve(__dirname, '..');
var SYMBOL = 'BTCUSDT';
var BAR_MS = 300000;
var END_OPEN = Date.parse('2026-08-26T09:15:00.000Z');
var START_OPEN = END_OPEN - 8639 * BAR_MS;
var TARGET_WATCH_ID = 'WATCH:BTCUSDT:BULLISH:LEG:BTCUSDT:5m:DISPLACEMENT:BULLISH:1787734800000';
var OUTPUT = process.env.LINKAGE_SNAPSHOT_OUT;

if (!OUTPUT) throw new Error('LINKAGE_SNAPSHOT_OUT is required');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function hash(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function iso(value) {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function sortById(rows) {
    return rows.slice().sort(function (a, b) { return a.id.localeCompare(b.id); });
}

function displacementBehavior(event) {
    var view = clone(event);
    if (view.metadata) delete view.metadata.mssEventId;
    return view;
}

function withoutMssLinkage(value) {
    if (Array.isArray(value)) return value.map(withoutMssLinkage);
    if (!value || typeof value !== 'object') return value;
    var out = {};
    Object.keys(value).forEach(function (key) {
        if (key !== 'mssEventId') out[key] = withoutMssLinkage(value[key]);
    });
    return out;
}

function watchBehavior(watch) {
    var view = clone(watch);
    delete view.mss;
    return view;
}

function matrix(watches) {
    var out = {
        BULLISH_DISPLACEMENT_BULLISH_MSS: 0,
        BULLISH_DISPLACEMENT_BEARISH_MSS: 0,
        BEARISH_DISPLACEMENT_BEARISH_MSS: 0,
        BEARISH_DISPLACEMENT_BULLISH_MSS: 0,
        BULLISH_DISPLACEMENT_NO_MSS: 0,
        BEARISH_DISPLACEMENT_NO_MSS: 0
    };
    watches.forEach(function (watch) {
        var direction = watch.displacement && watch.displacement.direction;
        var mssDirection = watch.mss && watch.mss.exists ? watch.mss.direction : null;
        if (direction === 'BULLISH' && mssDirection === 'BULLISH') out.BULLISH_DISPLACEMENT_BULLISH_MSS++;
        else if (direction === 'BULLISH' && mssDirection === 'BEARISH') out.BULLISH_DISPLACEMENT_BEARISH_MSS++;
        else if (direction === 'BEARISH' && mssDirection === 'BEARISH') out.BEARISH_DISPLACEMENT_BEARISH_MSS++;
        else if (direction === 'BEARISH' && mssDirection === 'BULLISH') out.BEARISH_DISPLACEMENT_BULLISH_MSS++;
        else if (direction === 'BULLISH') out.BULLISH_DISPLACEMENT_NO_MSS++;
        else if (direction === 'BEARISH') out.BEARISH_DISPLACEMENT_NO_MSS++;
    });
    return out;
}

function population(watches) {
    var withMss = watches.filter(function (watch) { return watch.mss && watch.mss.exists; });
    var mismatches = withMss.filter(function (watch) {
        return watch.displacement.direction !== watch.mss.direction;
    });
    return {
        TOTAL_WATCH: watches.length,
        WATCH_WITH_MSS: withMss.length,
        WATCH_DIRECTION_MSS_DIRECTION_MATCH: withMss.length - mismatches.length,
        WATCH_DIRECTION_MSS_DIRECTION_MISMATCH: mismatches.length,
        LONG_WITH_BEARISH_MSS: mismatches.filter(function (watch) { return watch.direction === 'BULLISH'; }).length,
        SHORT_WITH_BULLISH_MSS: mismatches.filter(function (watch) { return watch.direction === 'BEARISH'; }).length,
        WATCH_WITH_MSS_EXISTS_FALSE: watches.length - withMss.length
    };
}

async function main() {
    var started = performance.now();
    console.log('[Fetch] ' + iso(START_OPEN) + ' -> ' + iso(END_OPEN));
    var candles = await binance.loadHistory(SYMBOL, '5m', START_OPEN, END_OPEN, {
        pageLimit: 1500,
        onProgress: function (count) { console.log('[Fetch] ' + count + ' bars'); }
    });
    var byOpen = {};
    candles.forEach(function (candle) {
        if (candle.closed !== false && candle.openTime >= START_OPEN && candle.openTime <= END_OPEN) {
            byOpen[candle.openTime] = candle;
        }
    });
    candles = Object.keys(byOpen).map(function (key) { return byOpen[key]; })
        .sort(function (a, b) { return a.openTime - b.openTime; });
    if (candles.length !== 8640) throw new Error('Expected 8640 closed bars, got ' + candles.length);
    for (var gapIndex = 1; gapIndex < candles.length; gapIndex++) {
        if (candles[gapIndex].openTime - candles[gapIndex - 1].openTime !== BAR_MS) {
            throw new Error('5m continuity violation at ' + gapIndex);
        }
    }

    var exchangeInfo = await binance.getExchangeInfo(SYMBOL);
    var engine = liveEngine.createLiveEngine({
        symbol: SYMBOL,
        exchangeInfo: exchangeInfo,
        structureCandles: { '1d': [], '4h': [], '1h': [] },
        calendarCandles: { '1d': [], '1w': [], '1M': [] },
        fetcher: function () { return Promise.resolve([]); },
        thresholds: thresholds
    }, {
        snapshotInterval: 12,
        baseIndex: 0,
        watchLiquidityEvidenceV1Enabled: false,
        sweepContextV1Enabled: false,
        dailyBiasProvider: function () { return null; }
    });
    var store = displacementWatch.createWatchStore([], {});
    var transitionState = {};
    var transitions = [];

    function recordTransition(watch, evaluationTime) {
        var previous = transitionState[watch.id];
        if (previous === watch.state) return;
        transitionState[watch.id] = watch.state;
        transitions.push({ id: watch.id, state: watch.state, evaluationTime: evaluationTime });
    }

    for (var index = 0; index < candles.length; index++) {
        await engine.onBar(candles[index], index);
        engine.drainDisplacementWatchUpdates().forEach(function (watch) {
            store.upsert(clone(watch));
            recordTransition(watch, candles[index].closeTime);
        });
        store.onCandle(candles[index]).forEach(function (watch) {
            recordTransition(watch, candles[index].closeTime);
        });
        if ((index + 1) % 500 === 0 || index + 1 === candles.length) {
            console.log('[Replay] ' + (index + 1) + ' / ' + candles.length);
        }
    }

    var state = engine.getState();
    var displacements = sortById(state.eventRegistry.getByType(SYMBOL, 'DISPLACEMENT'));
    var sweeps = sortById(state.eventRegistry.getByType(SYMBOL, 'LIQUIDITY_SWEEP'));
    var mss = sortById(state.eventRegistry.getByType(SYMBOL, 'MSS'));
    var fvgs = sortById(state.fvgReg.getAll(SYMBOL));
    var watches = sortById(store.getAll());
    var displacementBehaviors = displacements.map(displacementBehavior);
    var watchBehaviors = watches.map(watchBehavior);
    var futureLeaks = [];
    watches.forEach(function (watch) {
        if (watch.mss && watch.mss.exists && watch.mss.confirmedAt > watch.updatedAt) {
            futureLeaks.push({ watchId: watch.id, mssId: watch.mss.id, reason: 'MSS_AFTER_WATCH_EVALUATION' });
        }
    });
    var target = watches.filter(function (watch) { return watch.id === TARGET_WATCH_ID; })[0] || null;
    var snapshot = {
        window: {
            bars: candles.length,
            firstOpenTime: candles[0].openTime,
            firstOpenTimeIso: iso(candles[0].openTime),
            lastCloseTime: candles[candles.length - 1].closeTime,
            lastCloseTimeIso: iso(candles[candles.length - 1].closeTime)
        },
        runtimeSeconds: (performance.now() - started) / 1000,
        counts: {
            displacements: displacements.length,
            sweeps: sweeps.length,
            mss: mss.length,
            fvgs: fvgs.length,
            watches: watches.length,
            watchTransitions: transitions.length
        },
        hashes: {
            displacementBehavior: hash(displacementBehaviors),
            displacementIds: hash(displacements.map(function (event) { return event.id; })),
            sweepEvents: hash(sweeps),
            fvgEvents: hash(fvgs),
            fvgBehavior: hash(fvgs.map(withoutMssLinkage)),
            fvgIds: hash(fvgs.map(function (event) { return event.id; })),
            watchBehavior: hash(watchBehaviors),
            watchIds: hash(watches.map(function (watch) { return watch.id; })),
            watchTransitions: hash(transitions)
        },
        displacementLinks: displacements.map(function (event) {
            return { id: event.id, direction: event.direction, candleIndex: event.candleIndex, confirmedAt: event.confirmedAt, mssEventId: event.metadata && event.metadata.mssEventId || null };
        }),
        watchMss: watches.map(function (watch) {
            return { id: watch.id, direction: watch.direction, createdAt: watch.createdAt, updatedAt: watch.updatedAt, state: watch.state, mss: clone(watch.mss || { exists: false }) };
        }),
        transitions: transitions,
        matrix: matrix(watches),
        population: population(watches),
        target: clone(target),
        FUTURE_LEAK_VIOLATIONS: futureLeaks.length,
        futureLeaks: futureLeaks
    };
    fs.writeFileSync(OUTPUT, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(JSON.stringify({ output: OUTPUT, runtimeSeconds: snapshot.runtimeSeconds, counts: snapshot.counts, population: snapshot.population, matrix: snapshot.matrix, hashes: snapshot.hashes }, null, 2));
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
