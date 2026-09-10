'use strict';

var WebSocket = require('ws');
var net = require('net');
var tls = require('tls');
var network = require('../config/network');

function proxyTlsConnection(options, callback) {
    var socket = net.connect({ host: network.proxy.host, port: network.proxy.port });
    var settled = false;
    socket.once('error', function (error) { if (!settled) { settled = true; callback(error); } });
    socket.once('connect', function () {
        socket.write('CONNECT ' + options.host + ':443 HTTP/1.1\r\nHost: ' + options.host + ':443\r\nConnection: keep-alive\r\n\r\n');
    });
    var buffer = Buffer.alloc(0);
    socket.on('data', function onData(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        var end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        socket.removeListener('data', onData);
        var header = buffer.slice(0, end).toString('ascii');
        if (!/^HTTP\/1\.[01] 200\b/.test(header)) {
            settled = true; socket.destroy(); callback(new Error('PROXY_CONNECT_FAILED: ' + header.split('\r\n')[0])); return;
        }
        var rest = buffer.slice(end + 4); if (rest.length) socket.unshift(rest);
        var secure = tls.connect({ socket: socket, servername: options.host });
        secure.once('secureConnect', function () { if (!settled) { settled = true; callback(null, secure); } });
        secure.once('error', function (error) { if (!settled) { settled = true; callback(error); } });
    });
}

function createStream(options) {
    var opts = options || {};
    var client = opts.client;
    var onEvent = opts.onEvent || function () {};
    var onReconnect = opts.onReconnect || function () { return Promise.resolve(); };
    var observe = opts.observe || function () {};
    var WebSocketImpl = opts.WebSocket || WebSocket;
    var socket = null;
    var stopped = false;
    var reconnectTimer = null;
    var keepaliveTimer = null;
    var listenKey = null;

    function wsOptions() {
        return network.proxy && network.proxy.enabled ? { createConnection: proxyTlsConnection } : {};
    }
    function control(method) {
        return new Promise(function (resolve, reject) {
            var controlSocket = new WebSocketImpl('wss://ws-fapi.binance.com/ws-fapi/v1', wsOptions());
            var id = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
            var done = false;
            function finish(error, result) {
                if (done) return; done = true;
                try { controlSocket.close(); } catch (ignore) {}
                if (error) reject(error); else resolve(result || {});
            }
            controlSocket.on('open', function () {
                controlSocket.send(JSON.stringify({ id: id, method: method,
                    params: { apiKey: client.getUserDataApiKey() } }));
            });
            controlSocket.on('message', function (raw) {
                var response;
                try { response = JSON.parse(String(raw)); } catch (error) { finish(error); return; }
                if (response.id !== id) return;
                if (response.status !== 200) finish(Object.assign(new Error('USER_STREAM_CONTROL_FAILED'), { responseStatus: response.status }));
                else finish(null, response.result);
            });
            controlSocket.on('error', finish);
        });
    }

    function scheduleReconnect() {
        if (stopped || reconnectTimer) return;
        reconnectTimer = setTimeout(function () {
            reconnectTimer = null;
            Promise.resolve(onReconnect()).then(connect, function (error) {
                observe({ type: 'WS_RECONCILIATION_ERROR', error: error && error.message }); scheduleReconnect();
            });
        }, 1000);
    }
    function connect() {
        if (stopped) return Promise.resolve();
        return control('userDataStream.start').then(function (value) {
            listenKey = value.listenKey;
            socket = new WebSocketImpl('wss://fstream.binance.com/ws/' + listenKey, wsOptions());
            socket.on('message', function (raw) {
                try { onEvent(JSON.parse(String(raw))); } catch (error) { observe({ type: 'WS_EVENT_ERROR', error: error.message }); }
            });
            socket.on('error', function (error) { observe({ type: 'WS_ERROR', error: error.message }); });
            socket.on('close', scheduleReconnect);
            if (!keepaliveTimer) keepaliveTimer = setInterval(function () {
                control('userDataStream.ping').catch(function (error) { observe({ type: 'WS_KEEPALIVE_ERROR', error: error.message }); });
            }, 50 * 60 * 1000);
        });
    }
    function stop() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        reconnectTimer = null; keepaliveTimer = null;
        if (socket) socket.close();
        return listenKey ? control('userDataStream.stop').catch(function () {}) : Promise.resolve();
    }
    return { start: connect, stop: stop };
}

function createReadOnlyProbe(options) {
    var opts = options || {};
    var client = opts.client;
    var WebSocketImpl = opts.WebSocket || WebSocket;
    var timeoutMs = Number(opts.timeoutMs) || 10000;
    var observeMs = Number(opts.observeMs) || 250;

    function wsOptions() {
        return network.proxy && network.proxy.enabled ? { createConnection: proxyTlsConnection } : {};
    }
    function control(method) {
        return new Promise(function (resolve, reject) {
            var socket = new WebSocketImpl('wss://ws-fapi.binance.com/ws-fapi/v1', wsOptions());
            var id = String(Date.now()) + '-' + Math.random().toString(16).slice(2);
            var settled = false;
            var timer = setTimeout(function () { finish(new Error('USER_STREAM_CONTROL_TIMEOUT')); }, timeoutMs);
            function finish(error, value) {
                if (settled) return; settled = true; clearTimeout(timer);
                try { socket.close(); } catch (ignore) {}
                if (error) reject(error); else resolve(value || {});
            }
            socket.on('open', function () {
                socket.send(JSON.stringify({ id: id, method: method,
                    params: { apiKey: client.getUserDataApiKey() } }));
            });
            socket.on('message', function (raw) {
                var response;
                try { response = JSON.parse(String(raw)); } catch (error) { finish(error); return; }
                if (response.id !== id) return;
                if (response.status !== 200) finish(Object.assign(new Error('USER_STREAM_CONTROL_FAILED'), {
                    responseStatus: response.status, responseCode: response.error && response.error.code
                }));
                else finish(null, response.result);
            });
            socket.on('error', finish);
        });
    }
    function openDataSocket(listenKey) {
        return new Promise(function (resolve, reject) {
            var socket = new WebSocketImpl('wss://fstream.binance.com/ws/' + listenKey, wsOptions());
            var settled = false;
            var timer = setTimeout(function () { finish(new Error('USER_STREAM_CONNECT_TIMEOUT')); }, timeoutMs);
            function finish(error) {
                if (settled) return; settled = true; clearTimeout(timer);
                if (error) { try { socket.close(); } catch (ignore) {} reject(error); } else resolve(socket);
            }
            socket.on('open', function () { finish(); });
            socket.on('error', finish);
        });
    }
    function closeDataSocket(socket) {
        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(finish, Math.min(timeoutMs, 1000));
            function finish() { if (settled) return; settled = true; clearTimeout(timer); resolve(); }
            socket.once('close', finish);
            try { socket.close(); } catch (ignore) { finish(); }
        });
    }
    function run() {
        var listenKey;
        var dataSocket;
        var result = { authenticated: false, connected: false, keepalive: false, cleanClose: false, eventCount: 0 };
        return control('userDataStream.start').then(function (value) {
            listenKey = value.listenKey;
            if (!listenKey) throw new Error('USER_STREAM_LISTEN_KEY_MISSING');
            result.authenticated = true;
            return openDataSocket(listenKey);
        }).then(function (socket) {
            dataSocket = socket; result.connected = true;
            socket.on('message', function () { result.eventCount += 1; });
            return new Promise(function (resolve) { setTimeout(resolve, observeMs); });
        }).then(function () {
            return control('userDataStream.ping');
        }).then(function () {
            result.keepalive = true;
            return closeDataSocket(dataSocket);
        }).then(function () {
            return control('userDataStream.stop');
        }).then(function () {
            result.cleanClose = true; return result;
        }, function (error) {
            if (dataSocket) { try { dataSocket.close(); } catch (ignore) {} }
            if (!listenKey) throw error;
            return control('userDataStream.stop').catch(function () {}).then(function () { throw error; });
        });
    }
    return { run: run };
}

function createReadOnlySession(options) {
    var opts = options || {};
    var client = opts.client;
    var onEvent = opts.onEvent || function () {};
    var WebSocketImpl = opts.WebSocket || WebSocket;
    var timeoutMs = Number(opts.timeoutMs) || 10000;
    var socket = null;
    var listenKey = null;
    function wsOptions() { return network.proxy && network.proxy.enabled ? { createConnection: proxyTlsConnection } : {}; }
    function control(method) {
        return new Promise(function (resolve, reject) {
            var controlSocket = new WebSocketImpl('wss://ws-fapi.binance.com/ws-fapi/v1', wsOptions());
            var id = String(Date.now()) + '-' + Math.random().toString(16).slice(2); var settled = false;
            var timer = setTimeout(function () { finish(new Error('USER_STREAM_CONTROL_TIMEOUT')); }, timeoutMs);
            function finish(error, value) { if (settled) return; settled = true; clearTimeout(timer);
                try { controlSocket.close(); } catch (ignore) {} if (error) reject(error); else resolve(value || {}); }
            controlSocket.on('open', function () { controlSocket.send(JSON.stringify({ id: id, method: method,
                params: { apiKey: client.getUserDataApiKey() } })); });
            controlSocket.on('message', function (raw) { var response;
                try { response = JSON.parse(String(raw)); } catch (error) { finish(error); return; }
                if (response.id !== id) return;
                if (response.status !== 200) finish(Object.assign(new Error('USER_STREAM_CONTROL_FAILED'), { responseStatus: response.status }));
                else finish(null, response.result); });
            controlSocket.on('error', finish);
        });
    }
    function start() {
        return control('userDataStream.start').then(function (value) {
            listenKey = value.listenKey; if (!listenKey) throw new Error('USER_STREAM_LISTEN_KEY_MISSING');
            return new Promise(function (resolve, reject) {
                socket = new WebSocketImpl('wss://fstream.binance.com/ws/' + listenKey, wsOptions()); var settled = false;
                var timer = setTimeout(function () { finish(new Error('USER_STREAM_CONNECT_TIMEOUT')); }, timeoutMs);
                function finish(error) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); }
                socket.on('open', function () { finish(); }); socket.on('error', finish);
                socket.on('message', function (raw) { try { onEvent(JSON.parse(String(raw))); } catch (ignore) {} });
            });
        });
    }
    function ping() { return listenKey ? control('userDataStream.ping') : Promise.reject(new Error('USER_STREAM_NOT_STARTED')); }
    function stop() {
        if (socket) { try { socket.close(); } catch (ignore) {} socket = null; }
        if (!listenKey) return Promise.resolve();
        listenKey = null; return control('userDataStream.stop').catch(function () {});
    }
    return { start: start, ping: ping, stop: stop };
}

module.exports = { createStream: createStream, createReadOnlyProbe: createReadOnlyProbe,
    createReadOnlySession: createReadOnlySession };
