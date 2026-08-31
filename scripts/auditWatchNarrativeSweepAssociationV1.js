#!/usr/bin/env node
'use strict';

/**
 * Audit-only WATCH / Sweep forensic replay.
 *
 * This harness calls the production live engine and watch store without
 * modifying either. It deliberately keeps downloaded evidence under the
 * audit report directory. The Binance spot mirror is used only when the
 * USD-M Futures endpoint is unavailable; reports must retain source="spot-mirror"
 * and must not describe that replay as production-equivalent.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
var OUT = path.join(ROOT, 'research', 'watch-narrative-sweep-association-audit-v1');
var FIXTURES = path.join(OUT, 'fixtures');
var START = Date.parse('2026-07-29T00:00:00.000Z');
var END = Date.parse('2026-08-30T06:00:00.000Z');
var SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['ZECUSDT', 'BTCUSDT'];

var binance = require('../data/binanceRest');
var liveEngine = require('../live/liveEngine');
var displacementWatch = require('../stats/displacementWatch');
var thresholds = require('../config/thresholds');

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function requestedSourceLabel() {
    return process.env.ICT_USE_FALLBACK === '1' ? 'spot-mirror' : 'futures';
}
function fixturePath(symbol) { return path.join(FIXTURES, symbol + '-5m-' + requestedSourceLabel() + '.json'); }

function loadCandles(symbol) {
    ensureDir(FIXTURES);
    var file = fixturePath(symbol);
    if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
    return binance.loadHistory(symbol, '5m', START, END, { pageLimit: 1500 }).then(function (candles) {
        var payload = { symbol: symbol, interval: '5m', source: candles[0] && candles[0].source,
            requestedStart: START, requestedEnd: END, candles: candles };
        fs.writeFileSync(file, JSON.stringify(payload));
        return payload;
    });
}

function localMinute(ms) {
    if (typeof ms !== 'number') return null;
    var d = new Date(ms + 8 * 3600000 + 1);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
        ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

function forensic(watch, state, observationKind) {
    var primary = watch.liquidityTaken && watch.liquidityTaken.primary || null;
    var sweep = primary && primary.id ? state.eventRegistry.getById(primary.id) : null;
    var eq = primary && primary.eqMemberProvenance || null;
    return {
        observationKind: observationKind,
        watchTime: localMinute(watch.firstTouchAt || watch.updatedAt),
        watchId: watch.id,
        direction: watch.direction,
        liquidityType: primary && primary.sourceType || null,
        liquidityPrice: primary && primary.sourcePrice,
        liquidityId: primary && primary.sourceId || null,
        eqV3ClusterId: eq && eq.eqObjectId || null,
        eqMemberProvenance: eq || null,
        sweepId: primary && primary.id || null,
        sweepOccurredAt: sweep && sweep.occurredAt,
        sweepConfirmedAt: primary && primary.confirmedAt,
        sweepPrice: sweep && sweep.price,
        sweepLiquidityId: sweep && sweep.liquidityId,
        canonicalDisplacementId: watch.canonicalDisplacementId,
        legStartAt: watch.displacement && watch.displacement.firstConfirmedAt,
        legEndAt: watch.displacement && watch.displacement.lastConfirmedAt,
        legDirection: watch.displacement && watch.displacement.direction,
        legStrength: watch.displacement && watch.displacement.quality,
        formationBars: watch.displacement ? watch.displacement.endIndex - watch.displacement.startIndex + 1 : null,
        mssExists: watch.mss && watch.mss.exists,
        mssReferenceRole: watch.mss && watch.mss.referenceRole,
        mssProtectedBreak: watch.mss && watch.mss.protectedBreak,
        fvgId: watch.nativeFvg && watch.nativeFvg.id,
        fvgFormedAt: watch.nativeFvg && watch.nativeFvg.confirmedAt,
        firstTouchAt: watch.firstTouchAt,
        primarySweepTiming: primary && primary.relation,
        barsFromLegStart: primary && primary.barsBeforeLegStart,
        notificationKey: watch.notificationKey,
        candidateSweepIds: (watch.liquidityTaken && watch.liquidityTaken.allCandidates || []).map(function (c) { return c.id; })
    };
}

function replay(payload) {
    var symbol = payload.symbol;
    var candles = payload.candles;
    var engine = liveEngine.createLiveEngine({
        symbol: symbol,
        exchangeInfo: { symbol: symbol, tickSize: 0.01, stepSize: null, source: payload.source },
        contextCandles5m: candles,
        structureCandles: { '1h': [], '4h': [] },
        calendarCandles: { '1d': [], '1w': [], '1M': [] },
        fetcher: function () { return Promise.resolve([]); },
        thresholds: thresholds
    }, {
        snapshotInterval: 12,
        baseIndex: 0,
        eqProductionVersion: 'V3',
        dailyBiasProvider: function () { return null; }
    });
    var store = displacementWatch.createWatchStore([], {});
    var touches = [];
    var formations = [];
    var chain = Promise.resolve();
    candles.forEach(function (candle, index) {
        chain = chain.then(function () {
            return engine.onBar(candle, index).then(function () {
                engine.drainDisplacementWatchUpdates().forEach(function (watch) {
                    store.upsert(watch);
                    if (localMinute(watch.updatedAt).slice(0, 10) === '2026-08-30') {
                        formations.push(forensic(watch, engine.getState(), 'WATCH_UPDATE'));
                    }
                });
                store.onCandle(candle).forEach(function (watch) {
                    touches.push(forensic(clone(watch), engine.getState(), 'FIRST_TOUCH_CANDLE'));
                });
            });
        });
    });
    return chain.then(function () {
        return {
            audit: 'WATCH_NARRATIVE_SWEEP_ASSOCIATION_AUDIT_V1',
            symbol: symbol,
            dataSource: payload.source,
            productionEquivalent: payload.source === 'futures',
            requestedStart: START,
            requestedEnd: END,
            candleCount: candles.length,
            firstCandleOpenTime: candles[0] && candles[0].openTime,
            lastCandleCloseTime: candles.length && candles[candles.length - 1].closeTime,
            fixtureSha256: sha256(JSON.stringify(payload)),
            touchesOnTargetDate: touches.filter(function (x) { return x.watchTime && x.watchTime.slice(0, 10) === '2026-08-30'; }),
            watchUpdatesOnTargetDate: formations
        };
    });
}

ensureDir(OUT);
SYMBOLS.reduce(function (promise, symbol) {
    return promise.then(function () {
        console.log('[audit] load ' + symbol);
        return loadCandles(symbol).then(replay).then(function (result) {
            var file = path.join(OUT, symbol + '-forensic-replay.json');
            fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
            console.log('[audit] wrote ' + file + ' touches=' + result.touchesOnTargetDate.length);
        });
    });
}, Promise.resolve()).catch(function (error) {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
