/** Atomic per-symbol persistence for the latest valid Daily Bias snapshot. */
var persistence = require('./persistence');

function createDailyBiasStore(file, symbol) {
    var state = persistence.loadJson(file, null) || {
        version: 1,
        symbol: symbol,
        snapshot: null,
        lastAttempt: null
    };

    function save() {
        persistence.saveJson(file, state);
    }

    function recordSuccess(snapshot, attemptedAt) {
        state.snapshot = snapshot;
        state.lastAttempt = {
            evaluationTime: snapshot.evaluationTime,
            attemptedAt: attemptedAt,
            status: 'SUCCESS',
            error: null
        };
        save();
    }

    function recordFailure(evaluationTime, attemptedAt, error) {
        state.lastAttempt = {
            evaluationTime: evaluationTime,
            attemptedAt: attemptedAt,
            status: 'FAILED',
            error: {
                code: error && error.code || 'DAILY_BIAS_ERROR',
                message: error && error.message || String(error)
            }
        };
        save();
    }

    return {
        getState: function () { return state; },
        getSnapshot: function () { return state.snapshot; },
        getLastAttempt: function () { return state.lastAttempt; },
        recordSuccess: recordSuccess,
        recordFailure: recordFailure
    };
}

module.exports = { createDailyBiasStore: createDailyBiasStore };
