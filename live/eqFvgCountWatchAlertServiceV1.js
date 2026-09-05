'use strict';

var watchModel = require('./eqFvgCountWatchV1');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function notificationKey(event) {
    return ['EQ_FVG_WATCH', event.watchId, event.rawFvg.id, event.ordinal].join('|');
}

function createService(options) {
    var opts = options || {};
    var machine = watchModel.createStateMachine({ watches: opts.watches || [] });
    var delivered = clone(opts.delivered || {});
    var pending = clone(opts.pending || []);
    var send = opts.send || function () { return Promise.resolve({ errcode: 0 }); };
    var persist = opts.persist || function () {};

    function snapshot() {
        return { watches: machine.getAll(), delivered: clone(delivered), pending: clone(pending) };
    }
    function isPending(key) {
        return pending.some(function (item) { return item.notificationKey === key; });
    }
    function onStep(input) {
        var result = machine.step(input || {});
        result.notifications.forEach(function (event) {
            var key = notificationKey(event);
            if (!delivered[key] && !isPending(key)) {
                pending.push({ notificationKey: key, event: clone(event), attempts: 0 });
            }
        });
        if (result.changed || result.notifications.length) persist(snapshot());
        return result;
    }
    function flush() {
        var queue = pending.slice();
        pending = [];
        return queue.reduce(function (chain, item) {
            return chain.then(function () {
                if (delivered[item.notificationKey]) return;
                return Promise.resolve(send(item.event, item.notificationKey)).then(function (response) {
                    if (!response || response.errcode !== 0) {
                        throw new Error('errcode=' + (response ? response.errcode : 'none'));
                    }
                    delivered[item.notificationKey] = {
                        watchId: item.event.watchId,
                        rawFvgId: item.event.rawFvg.id,
                        ordinal: item.event.ordinal,
                        deliveredAt: Date.now()
                    };
                    machine.markDelivered(item.event.watchId, item.event.ordinal);
                    persist(snapshot());
                }).catch(function () {
                    item.attempts = (item.attempts || 0) + 1;
                    if (!isPending(item.notificationKey)) pending.push(item);
                    persist(snapshot());
                });
            });
        }, Promise.resolve()).then(snapshot);
    }

    return { onStep: onStep, flush: flush, snapshot: snapshot, getMachine: function () { return machine; } };
}

module.exports = { notificationKey: notificationKey, createService: createService };
