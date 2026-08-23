/** Binance Futures real-time trade-price stream with bounded reconnect. */
'use strict';
var WebSocket = require('ws');

function createFuturesPriceStream(symbol, handlers, options) {
    var h = handlers || {};
    var opts = options || {};
    var Ws = opts.WebSocket || WebSocket;
    var reconnectMs = opts.reconnectMs || 5000;
    var baseUrl = opts.baseUrl || 'wss://fstream.binance.com/ws/';
    var socket = null, timer = null, stopped = true;

    function emitError(err) { if (h.onError) h.onError(err); }
    function connect() {
        if (stopped) return;
        socket = new Ws(baseUrl + String(symbol).toLowerCase() + '@aggTrade');
        socket.on('open', function () { if (h.onOpen) h.onOpen(); });
        socket.on('message', function (raw) {
            try {
                var msg = JSON.parse(String(raw));
                var price = Number(msg.p);
                var at = Number(msg.T || msg.E || Date.now());
                if (isFinite(price) && price > 0 && h.onPrice) h.onPrice(price, at, msg);
            } catch (e) { emitError(e); }
        });
        socket.on('error', emitError);
        socket.on('close', function () {
            socket = null;
            if (!stopped) timer = setTimeout(connect, reconnectMs);
            if (h.onClose) h.onClose();
        });
    }
    function start() { if (!stopped) return; stopped = false; connect(); }
    function stop() {
        stopped = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (socket) { try { socket.close(); } catch (e) {} socket = null; }
    }
    return { start: start, stop: stop };
}

module.exports = { createFuturesPriceStream: createFuturesPriceStream };
