'use strict';

var path = require('path');
var engineModule = require('./marketStateMapV1Engine');
var llm1 = require('./trendEstablishmentMinimalEscapeV1_1Llm');

var VERSION = engineModule.VERSION;
var BOOTSTRAP_HISTORY_BARS = 2016; // frozen cross-symbol convention: seven closed 5m days
var MAX_SNAPSHOT_HISTORY = 4096;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function safeError(error) {
    return { errorCode: error && error.code || 'MARKET_STATE_RUNTIME_ERROR',
        detail: String(error && error.message || error || 'unknown').slice(0, 500) };
}
function expectedClosedAt(timestamp) {
    var value = Number(timestamp);
    if (!Number.isFinite(value)) return null;
    return Math.floor((value + 1) / engineModule.BAR_MS) * engineModule.BAR_MS - 1;
}
function normalizeCandles(rows) {
    var seen = {};
    return (rows || []).filter(function (c) {
        return c && c.closeTime === c.openTime + engineModule.BAR_MS - 1 && c.closed !== false;
    }).sort(function (a, b) { return a.openTime - b.openTime; }).filter(function (c) {
        if (seen[c.closeTime]) return false;
        seen[c.closeTime] = true; return true;
    });
}
function assertContinuous(rows) {
    for (var i = 1; i < rows.length; i++) {
        if (rows[i].openTime !== rows[i - 1].openTime + engineModule.BAR_MS) throw new Error('MARKET_STATE_BOOTSTRAP_5M_GAP');
    }
}

function createRuntime(options) {
    var opts = options || {}, symbol = opts.symbol;
    var observe = opts.observe || function () {};
    var decide = opts.decide || llm1.createDecisionProvider({
        storeDirectory: opts.storeDirectory || path.join('.live-state', symbol, 'market-state-map-v1', 'llm-cache'),
        requestSemantic: opts.requestSemantic
    });
    var makeEngine = opts.engineFactory || function () { return engineModule.createEngine({ decide: decide }); };
    var status = 'NOT_READY', engine = null, snapshots = [], transitions = [], queued = {}, pending = {},
        bootstrapPromise = null, updateChain = Promise.resolve(), latestProcessedCloseTime = null,
        lastError = null, lastUpdateAt = null;

    function publish(result) {
        snapshots = result.snapshots.slice(-MAX_SNAPSHOT_HISTORY);
        transitions = result.transitions;
        latestProcessedCloseTime = result.latestEvaluationTime;
        lastUpdateAt = Date.now();
    }
    function emit(event, extra) { observe(Object.assign({ event: event, symbol: symbol }, extra || {})); }
    function fail(event, error, evaluationTime) {
        var safe = safeError(error); status = 'ERROR'; lastError = Object.assign({ at: Date.now(), evaluationTime: evaluationTime || null }, safe);
        emit(event, { evaluationTime: evaluationTime || null, errorCode: safe.errorCode, detail: safe.detail });
    }
    function appendResult(result) {
        if (result.status !== 'PROCESSED') return;
        snapshots.push(result.snapshot);
        if (snapshots.length > MAX_SNAPSHOT_HISTORY) snapshots.shift();
        latestProcessedCloseTime = result.snapshot.evaluationTime; lastUpdateAt = Date.now();
        if (result.transition) {
            transitions.push(result.transition);
            emit('MARKET_STATE_TRANSITION', { evaluationTime: result.transition.evaluationTime,
                from: result.transition.from, to: result.transition.to, direction: result.transition.direction || null,
                reason: result.transition.reason });
        }
    }
    function queuedRowsAfter(time) {
        return Object.keys(queued).map(Number).filter(function (t) { return t > time; }).sort(function (a, b) { return a - b; })
            .map(function (t) { var row = queued[t]; delete queued[t]; return row; });
    }
    function bootstrap(rows) {
        if (bootstrapPromise) return bootstrapPromise;
        status = 'BOOTSTRAPPING';
        emit('MARKET_STATE_BOOTSTRAP_STARTED', { historyPolicy: 'LATEST_2016_CONTINUOUS_CLOSED_5M',
            requestedBars: BOOTSTRAP_HISTORY_BARS });
        bootstrapPromise = Promise.resolve().then(async function () {
            var history = normalizeCandles(rows).slice(-BOOTSTRAP_HISTORY_BARS);
            if (!history.length) throw new Error('MARKET_STATE_BOOTSTRAP_EMPTY');
            assertContinuous(history);
            var candidate = makeEngine();
            var result = await candidate.replay(history);
            var tail = result.latestEvaluationTime;
            while (true) {
                var pending = queuedRowsAfter(tail);
                if (!pending.length) break;
                assertContinuous([history[history.length - 1]].concat(pending));
                for (var i = 0; i < pending.length; i++) {
                    var update = await candidate.onClosedCandle(pending[i]);
                    history.push(pending[i]); tail = pending[i].closeTime;
                    if (update.transition) result.transitions.push(update.transition);
                }
                result = candidate.getResult();
            }
            engine = candidate; publish(result); status = 'READY'; lastError = null;
            emit('MARKET_STATE_BOOTSTRAP_READY', { evaluationTime: latestProcessedCloseTime,
                bars: history.length, state: result.current && result.current.state });
            return getStatus();
        }).catch(function (error) {
            fail('MARKET_STATE_BOOTSTRAP_FAILED', error, null); return getStatus();
        });
        return bootstrapPromise;
    }
    function failBootstrap(error) {
        fail('MARKET_STATE_BOOTSTRAP_FAILED', error, null);
        return getStatus();
    }
    function onClosedCandle(candle) {
        if (!candle || candle.closeTime !== candle.openTime + engineModule.BAR_MS - 1 || candle.closed === false) {
            fail('MARKET_STATE_UPDATE_FAILED', new Error('MARKET_STATE_REQUIRES_FULLY_CLOSED_5M'), candle && candle.closeTime);
            return Promise.resolve({ status: 'REJECTED' });
        }
        if (latestProcessedCloseTime !== null && candle.closeTime <= latestProcessedCloseTime) {
            return Promise.resolve({ status: candle.closeTime === latestProcessedCloseTime ? 'DUPLICATE' : 'OLDER_IGNORED' });
        }
        if (queued[candle.closeTime] || pending[candle.closeTime]) return Promise.resolve({ status: 'DUPLICATE' });
        if (status !== 'READY') { queued[candle.closeTime] = clone(candle); return Promise.resolve({ status: 'BUFFERED' }); }
        pending[candle.closeTime] = true;
        updateChain = updateChain.then(function () {
            return engine.onClosedCandle(candle).then(function (result) {
                delete pending[candle.closeTime];
                appendResult(result);
                return result;
            });
        }).catch(function (error) {
            delete pending[candle.closeTime];
            fail('MARKET_STATE_UPDATE_FAILED', error, candle.closeTime); return { status: 'FAILED' };
        });
        return updateChain;
    }
    function snapshotAt(timestamp) {
        if (status !== 'READY') return null;
        var expected = expectedClosedAt(timestamp);
        for (var i = snapshots.length - 1; i >= 0; i--) {
            if (snapshots[i].evaluationTime === expected) return clone(snapshots[i]);
            if (snapshots[i].evaluationTime < expected) return null; // stale may not impersonate the expected bar
        }
        return null;
    }
    function getStatus() {
        var current = snapshots.length ? snapshots[snapshots.length - 1] : null;
        return { version: VERSION, symbol: symbol, status: status,
            state: current && current.state || null, latestEvaluationTime: latestProcessedCloseTime,
            stateSince: current && current.stateSince || null,
            trendEstablishedAt: current && current.trendEstablishedAt || null,
            activeProtectedType: current && current.activeProtectedType || null,
            activeProtectedPrice: current && current.activeProtectedPrice || null,
            lastError: clone(lastError), lastUpdateAt: lastUpdateAt };
    }
    return { VERSION: VERSION, bootstrap: bootstrap, failBootstrap: failBootstrap, onClosedCandle: onClosedCandle,
        snapshotAt: snapshotAt, getStatus: getStatus,
        getTimeline: function () { return clone(snapshots); },
        getTransitions: function () { return clone(transitions); },
        constants: { bootstrapHistoryBars: BOOTSTRAP_HISTORY_BARS,
            establishmentVersion: engineModule.ESTABLISHMENT_VERSION,
            lifecycleVersion: engineModule.LIFECYCLE_VERSION, llm2Enabled: false,
            marketStateAffectsTrading: false } };
}

module.exports = { VERSION: VERSION, BOOTSTRAP_HISTORY_BARS: BOOTSTRAP_HISTORY_BARS,
    MAX_SNAPSHOT_HISTORY: MAX_SNAPSHOT_HISTORY, expectedClosedAt: expectedClosedAt,
    createRuntime: createRuntime };
