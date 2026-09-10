'use strict';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function createRepository(options) {
    var opts = options || {};
    var initial = opts.initial || {};
    var state = { version: 'REAL_ORDER_EXECUTION_V1', consumedEqIds: clone(initial.consumedEqIds || {}),
        trades: clone(initial.trades || {}), activeTradeId: initial.activeTradeId || null };
    var persist = opts.persist || function () {};
    function save() { persist(clone(state)); }
    return {
        consumeEq: function (eqId, meta) {
            if (state.consumedEqIds[eqId]) return false;
            state.consumedEqIds[eqId] = Object.assign({ consumedAt: Date.now() }, clone(meta || {})); save(); return true;
        },
        isConsumed: function (eqId) { return !!state.consumedEqIds[eqId]; },
        putTrade: function (trade) { state.trades[trade.tradeId] = clone(trade); state.activeTradeId = trade.tradeId; save(); },
        updateTrade: function (trade) { state.trades[trade.tradeId] = clone(trade); save(); },
        activeTrade: function () { return state.activeTradeId ? clone(state.trades[state.activeTradeId]) : null; },
        release: function () { state.activeTradeId = null; save(); },
        snapshot: function () { return clone(state); }
    };
}
module.exports = { createRepository: createRepository };
