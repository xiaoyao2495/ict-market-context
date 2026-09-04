/**
 * Persistent delivery boundary for RANGE_OBJECT_V1.
 * Detection is synchronous; DingTalk delivery is async and success-deduped.
 */
var rangeDetectorV1 = require('../range/rangeDetectorV1');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function notificationKey(event) {
    return ['RANGE_CONFIRMED', event.version, event.symbol, event.timeframe, event.confirmedAt].join(':');
}

function createRangeAlertService(options) {
    var opts = options || {};
    var detector = opts.detector || rangeDetectorV1.createRangeDetectorV1({ symbol: opts.symbol });
    var delivered = clone(opts.delivered || {});
    var pending = clone(opts.pending || []);
    var send = opts.send || function () { return Promise.resolve({ errcode: 0 }); };
    var record = opts.record || function () {};
    var persist = opts.persist || function () {};

    function snapshot() {
        return { delivered: clone(delivered), pending: clone(pending) };
    }

    function isPending(key) {
        return pending.some(function (item) { return item.notificationKey === key; });
    }

    function onCandle(candle, options2) {
        var mode = options2 || {};
        var result = detector.onCandle(candle);
        if (mode.recordEvents !== false) result.events.forEach(record);
        if (mode.notificationsEnabled) {
            result.events.forEach(function (event) {
                if (event.type !== 'RANGE_CONFIRMED') return;
                var key = notificationKey(event);
                if (delivered[key] || isPending(key)) return;
                pending.push({ notificationKey: key, event: clone(event), attempts: 0 });
                persist(snapshot());
            });
        }
        return result;
    }

    function flush() {
        var queue = pending.slice();
        pending = [];
        return queue.reduce(function (chain, item) {
            return chain.then(function () {
                if (delivered[item.notificationKey]) return;
                return Promise.resolve(send(item.event, item.notificationKey)).then(function (response) {
                    if (!response || response.errcode !== 0) throw new Error('errcode=' + (response ? response.errcode : 'none'));
                    delivered[item.notificationKey] = {
                        rangeId: item.event.rangeId,
                        confirmedAt: item.event.confirmedAt,
                        deliveredAt: Date.now()
                    };
                    persist(snapshot());
                }).catch(function () {
                    item.attempts = (item.attempts || 0) + 1;
                    pending.push(item);
                    persist(snapshot());
                });
            });
        }, Promise.resolve()).then(snapshot);
    }

    return {
        onCandle: onCandle,
        flush: flush,
        snapshot: snapshot,
        getDetector: function () { return detector; }
    };
}

module.exports = {
    notificationKey: notificationKey,
    createRangeAlertService: createRangeAlertService
};
