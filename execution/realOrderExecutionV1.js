'use strict';

var crypto = require('crypto');
var rules = require('./executionRulesV1');
var repositoryModule = require('./executionRepositoryV1');
var streamModule = require('./userDataStreamV1');
var rateLimitGovernor = require('../data/binanceRateLimitGovernorV1');

var OPEN_ORDER_STATUSES = ['NEW', 'PARTIALLY_FILLED', 'PENDING_NEW'];
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function num(value) { var n = Number(value); return Number.isFinite(n) ? n : 0; }
function orderId(order) { return order && (order.clientOrderId || order.clientAlgoId); }
function statusOf(order) { return order && (order.status || order.algoStatus || order.orderStatus); }
function isOpen(order) { return OPEN_ORDER_STATUSES.indexOf(statusOf(order)) >= 0; }
function tradeIdFor(event) {
    return 'T_' + crypto.createHash('sha256').update([event.symbol, event.liquidityId,
        event.rawFvg.id, event.rawFvg.confirmedAt].join('|')).digest('hex').slice(0, 18);
}
function orderRecord(trade, role, response) {
    var plan = trade.plan;
    var protection = role !== 'ENTRY';
    return {
        tradeId: trade.tradeId, role: role,
        clientOrderId: response.clientOrderId || response.clientAlgoId,
        exchangeOrderId: response.orderId || response.algoId || null,
        symbol: plan.symbol,
        side: plan.direction === 'LONG' ? (role === 'ENTRY' ? 'BUY' : 'SELL') : (role === 'ENTRY' ? 'SELL' : 'BUY'),
        type: role === 'ENTRY' ? 'LIMIT' : (role === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET'),
        requestedQty: role === 'ENTRY' ? plan.requestedQty : null,
        executedQty: num(response.executedQty || response.cumQty),
        averagePrice: num(response.avgPrice || response.averagePrice),
        stopPrice: protection ? (role === 'SL' ? plan.stopPrice : plan.targetPrice) : null,
        workingType: protection ? 'MARK_PRICE' : null,
        status: statusOf(response) || 'NEW', createdAt: Date.now(), updatedAt: Date.now(), lastExchangeSyncAt: Date.now()
    };
}

function createService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var client = opts.client;
    var live = opts.liveTradingEnabled === true;
    var repository = opts.repository || repositoryModule.createRepository({ initial: opts.initialState, persist: opts.persist });
    var getContext = opts.getContext || function () { return {}; };
    var observe = opts.observe || function () {};
    var alert = opts.alert || function () { return Promise.resolve(); };
    var archiveTrade = opts.archiveTrade || function () {};
    var streamFactory = opts.streamFactory || streamModule.createStream;
    var getNewTradeAdmission = opts.getNewTradeAdmission || function () {
        return { admitted: true, reasonCode: null };
    };
    var stream = null;
    var pollTimer = null;
    var queue = Promise.resolve();
    var accountReady = !live;

    function emit(type, trade, extra) {
        var event = Object.assign({ type: type, symbol: symbol, tradeId: trade && trade.tradeId || null }, extra || {});
        observe(clone(event));
        return Promise.resolve(alert(clone(event))).catch(function () {});
    }
    function enqueue(fn) {
        queue = queue.then(fn, fn).catch(function (error) {
            return emit('EXECUTION_ERROR', repository.activeTrade(), { critical: true,
                reasonCode: error.code || 'EXECUTION_ERROR', detail: error.message });
        });
        return queue;
    }
    function saveTrade(trade) {
        trade.updatedAt = Date.now(); repository.updateTrade(trade);
        if (trade.tradeCaseId) {
            try { archiveTrade(clone(trade)); }
            catch (error) { observe({ type: 'REAL_TRADE_CASE_ARCHIVE_ERROR', symbol: symbol,
                tradeId: trade.tradeId, critical: true, reasonCode: 'REAL_TRADE_CASE_ARCHIVE_ERROR', detail: error.message }); }
        }
    }
    function emitOnce(type, trade, extra) {
        if (!trade) return emit(type, trade, extra);
        trade.alertedEvents = trade.alertedEvents || {};
        if (trade.alertedEvents[type]) return Promise.resolve();
        trade.alertedEvents[type] = Date.now();
        trade.lifecycleTimestamps = trade.lifecycleTimestamps || {};
        trade.lifecycleTimestamps[type] = trade.alertedEvents[type];
        saveTrade(trade);
        return emit(type, trade, extra);
    }
    function slotFree() {
        var trade = repository.activeTrade();
        if (!trade) return true;
        var positionZero = num(trade.positionQty) === 0;
        var noOpen = !isOpen(trade.entryOrder) && !isOpen(trade.slOrder) && !isOpen(trade.tpOrder);
        var noUnknown = (!trade.entryOrder || trade.entryOrder.status !== 'UNKNOWN') &&
            (!trade.slOrder || trade.slOrder.status !== 'UNKNOWN') && (!trade.tpOrder || trade.tpOrder.status !== 'UNKNOWN');
        var noPending = trade.status !== 'CANCEL_REQUESTED' && trade.status !== 'RECONCILING' &&
            trade.status !== 'EXECUTION_ERROR' && trade.status !== 'PROTECTION_ERROR';
        return positionZero && noOpen && noUnknown && noPending && (trade.status === 'CLOSED' || trade.status === 'CANCELED' || trade.status === 'NO_TRADE' || trade.status === 'SHADOW_ORDER');
    }
    function releaseIfFree(trade) { if (slotFree()) repository.release(); }
    function holdForRateLimit(trade, error) {
        trade.status = 'RECONCILING';
        trade.reasonCode = 'DATA_SOURCE_BLOCKED';
        saveTrade(trade);
        return emitOnce('DATA_SOURCE_BLOCKED', trade, { critical: true,
            reasonCode: 'DATA_SOURCE_BLOCKED', detail: error && error.message,
            blockedUntil: error && error.blockedUntil }).then(function () { return trade; });
    }

    function submitProtection(trade) {
        if (!live || num(trade.positionQty) === 0) return Promise.resolve(trade);
        trade.status = 'PROTECTING'; saveTrade(trade);
        function ensure(role) {
            if (isOpen(trade[role.toLowerCase() + 'Order'])) return Promise.resolve();
            var attempt = function () {
                return client.submitProtection(trade.plan, role).then(function (response) {
                    trade[role.toLowerCase() + 'Order'] = orderRecord(trade, role, response); saveTrade(trade);
                });
            };
            return attempt().catch(function (firstError) {
                if (rateLimitGovernor.isRateLimitError(firstError)) return holdForRateLimit(trade, firstError);
                return attempt().catch(function (secondError) {
                    if (rateLimitGovernor.isRateLimitError(secondError)) return holdForRateLimit(trade, secondError);
                    var code = secondError.code || firstError.code || 'PROTECTION_FAILED';
                    if (role === 'TP') {
                        emit('PROTECTION_FAILED', trade, { critical: true, reasonCode: code, detail: 'TP; SL remains priority' });
                        return;
                    }
                    trade.status = 'PROTECTION_ERROR'; saveTrade(trade);
                    return emit('UNPROTECTED_POSITION', trade, { critical: true, reasonCode: code }).then(function () {
                        trade.status = 'CLOSE_REQUESTED'; saveTrade(trade);
                        return client.emergencyClose(symbol, trade.plan.direction, Math.abs(num(trade.positionQty)), trade.tradeId).then(function () {
                            return emit('PROTECTION_FAILED', trade, { critical: true, reasonCode: 'PROTECTION_FAILED', detail: 'MARKET_CLOSE_SUBMITTED' });
                        });
                    });
                });
            });
        }
        return ensure('SL').then(function () {
            if (!isOpen(trade.slOrder)) return trade;
            return ensure('TP').then(function () {
                if (trade.reasonCode === 'DATA_SOURCE_BLOCKED') return trade;
                trade.status = isOpen(trade.tpOrder) ? 'PROTECTED' : 'PROTECTION_ERROR'; saveTrade(trade);
                if (trade.status === 'PROTECTED') return emitOnce('POSITION_PROTECTED', trade).then(function () { return trade; });
                return trade;
            });
        });
    }

    function cancelConfirmed(order, role, trade) {
        if (!order || !isOpen(order)) return Promise.resolve();
        var cancel = role === 'ENTRY' ? client.cancelEntry(symbol, order.clientOrderId)
            : client.cancelAlgo(symbol, order.clientOrderId);
        return cancel.then(function (response) {
            var status = statusOf(response);
            if (status !== 'CANCELED') throw Object.assign(new Error(role + '_CANCEL_NOT_CONFIRMED'), { code: 'RECONCILIATION_CONFLICT' });
            order.status = 'CANCELED'; order.updatedAt = Date.now(); order.lastExchangeSyncAt = Date.now(); saveTrade(trade);
        });
    }

    function reconcile() {
        var trade = repository.activeTrade();
        if (!live || !trade) return Promise.resolve(trade);
        trade.status = 'RECONCILING'; saveTrade(trade);
        var entryQuery = trade.entryOrder ? client.queryOrder(symbol, trade.entryOrder.exchangeOrderId, trade.entryOrder.clientOrderId).catch(function (error) {
            if (rateLimitGovernor.isRateLimitError(error)) throw error;
            return null;
        }) : Promise.resolve(null);
        function algoQuery(local) {
            if (!local || !client.queryAlgoOrder) return Promise.resolve(null);
            return client.queryAlgoOrder(symbol, local.exchangeOrderId, local.clientOrderId).catch(function (error) {
                if (rateLimitGovernor.isRateLimitError(error)) throw error;
                return null;
            });
        }
        return Promise.all([client.getPositionRisk(symbol), client.getOpenOrders(symbol), client.getOpenAlgoOrders(symbol), entryQuery,
            algoQuery(trade.slOrder), algoQuery(trade.tpOrder)]).then(function (values) {
            var positions = Array.isArray(values[0]) ? values[0] : [values[0]];
            var position = positions.filter(function (p) { return p && (!p.positionSide || p.positionSide === 'BOTH'); })[0] || {};
            var signedQty = num(position.positionAmt);
            var qty = Math.abs(signedQty);
            var openOrders = values[1] || [];
            var openAlgos = values[2] || [];
            var entry = values[3] || openOrders.filter(function (o) {
                return trade.entryOrder && orderId(o) === trade.entryOrder.clientOrderId;
            })[0] || null;
            var previousSlOpen = isOpen(trade.slOrder);
            var previousTpOpen = isOpen(trade.tpOrder);
            trade.positionQty = qty;
            if (entry && trade.entryOrder) {
                trade.entryOrder.status = statusOf(entry);
                trade.entryOrder.executedQty = num(entry.executedQty || entry.cumQty);
                trade.entryOrder.requestedQty = num(entry.origQty || trade.entryOrder.requestedQty);
                trade.entryOrder.remainingQty = Math.max(0, trade.entryOrder.requestedQty - trade.entryOrder.executedQty);
                trade.entryOrder.averagePrice = num(entry.avgPrice || trade.entryOrder.averagePrice);
                trade.entryOrder.lastExchangeSyncAt = Date.now();
            } else if (trade.entryOrder && isOpen(trade.entryOrder)) {
                trade.entryOrder.status = 'UNKNOWN'; trade.entryOrder.lastExchangeSyncAt = Date.now();
                emitOnce('ORDER_STATE_UNKNOWN', trade, { critical: true, reasonCode: 'ORDER_STATE_UNKNOWN', role: 'ENTRY' });
            }
            ['slOrder', 'tpOrder'].forEach(function (key) {
                var local = trade[key]; if (!local) return;
                var match = openAlgos.filter(function (o) { return orderId(o) === local.clientOrderId; })[0];
                var queried = key === 'slOrder' ? values[4] : values[5];
                local.status = queried ? statusOf(queried) : (match ? statusOf(match) || 'NEW' : (qty === 0 ? 'FILLED_OR_CANCELED' : 'UNKNOWN'));
                local.lastExchangeSyncAt = Date.now();
            });
            saveTrade(trade);
            if (qty > 0) {
                var expectedSign = trade.plan.direction === 'LONG' ? 1 : -1;
                if (Math.sign(signedQty) !== expectedSign) {
                    trade.status = 'EXECUTION_ERROR'; trade.reasonCode = 'RECONCILIATION_CONFLICT'; saveTrade(trade);
                    return emit('RECONCILIATION_CONFLICT', trade, { critical: true,
                        reasonCode: 'RECONCILIATION_CONFLICT', detail: 'exchange position direction differs from EntryPlan' });
                }
                if (trade.entryOrder && trade.entryOrder.status === 'PARTIALLY_FILLED') emitOnce('ENTRY_PARTIAL', trade);
                if (trade.entryOrder && trade.entryOrder.status === 'FILLED') emitOnce('ENTRY_FILLED', trade);
                return submitProtection(trade);
            }
            var orphans = openAlgos.filter(function (o) { var id = orderId(o) || ''; return id.indexOf('IMC_') === 0; });
            var chain = Promise.resolve();
            if (previousSlOpen && trade.slOrder && ['FILLED', 'FINISHED'].indexOf(trade.slOrder.status) >= 0 && previousTpOpen) emitOnce('SL_FILLED', trade);
            if (previousTpOpen && trade.tpOrder && ['FILLED', 'FINISHED'].indexOf(trade.tpOrder.status) >= 0 && previousSlOpen) emitOnce('TP_FILLED', trade);
            orphans.forEach(function (orphan) {
                chain = chain.then(function () {
                    return emit('ORPHAN_ORDER_FOUND', trade, { critical: true, detail: orderId(orphan) }).then(function () {
                        return cancelConfirmed({ clientOrderId: orderId(orphan), status: statusOf(orphan) || 'NEW' }, 'PROTECTIVE', trade);
                    });
                });
            });
            return chain.then(function () {
                if (trade.entryOrder && trade.entryOrder.status === 'UNKNOWN') {
                    trade.status = 'EXECUTION_ERROR'; trade.reasonCode = 'ORDER_STATE_UNKNOWN';
                } else if (trade.entryOrder && isOpen(trade.entryOrder)) { trade.status = trade.entryOrder.status === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED' : 'ENTRY_PENDING'; }
                else if (trade.entryOrder && trade.entryOrder.status === 'CANCELED') trade.status = 'CANCELED';
                else trade.status = 'CLOSED';
                saveTrade(trade);
                if (trade.status === 'CLOSED') emitOnce('TRADE_CLOSED', trade);
                releaseIfFree(trade); return trade;
            });
        }).catch(function (error) {
            if (rateLimitGovernor.isRateLimitError(error)) return holdForRateLimit(trade, error);
            throw error;
        });
    }

    function startupOrphanReconcile() {
        if (!live || repository.activeTrade()) return reconcile();
        return Promise.all([client.getPositionRisk(symbol), client.getOpenOrders(symbol), client.getOpenAlgoOrders(symbol)]).then(function (values) {
            var positions = Array.isArray(values[0]) ? values[0] : [values[0]];
            var qty = Math.abs(num((positions[0] || {}).positionAmt));
            var normal = (values[1] || []).filter(function (o) { return String(orderId(o) || '').indexOf('IMC_') === 0; });
            var algos = (values[2] || []).filter(function (o) { return String(orderId(o) || '').indexOf('IMC_') === 0; });
            if (qty > 0 || normal.length > 0) {
                return emit('RECONCILIATION_CONFLICT', null, { critical: true,
                    reasonCode: 'RECONCILIATION_CONFLICT', detail: 'exchange lifecycle exists without a recoverable local EntryPlan' }).then(function () {
                    throw Object.assign(new Error('UNRECOVERABLE_EXCHANGE_LIFECYCLE'), { code: 'RECONCILIATION_CONFLICT' });
                });
            }
            return algos.reduce(function (chain, order) {
                return chain.then(function () {
                    return emit('ORPHAN_ORDER_FOUND', null, { critical: true, detail: orderId(order) }).then(function () {
                        return client.cancelAlgo(symbol, orderId(order)).then(function (response) {
                            if (statusOf(response) !== 'CANCELED') throw Object.assign(new Error('ORPHAN_CANCEL_NOT_CONFIRMED'), { code: 'RECONCILIATION_CONFLICT' });
                        });
                    });
                });
            }, Promise.resolve());
        });
    }

    function consumeSignal(event, alreadyConsumed) {
        if (!event || event.ordinal !== 1) return Promise.resolve({ status: 'IGNORED' });
        var admission = getNewTradeAdmission();
        if (admission === false || (admission && admission.admitted === false)) {
            var deniedReason = admission && admission.reasonCode || 'SYMBOL_NOT_IN_SCAN_UNIVERSE';
            emit('NO_TRADE', null, { reasonCode: deniedReason });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: deniedReason });
        }
        if (!alreadyConsumed && !repository.consumeEq(event.liquidityId, { watchId: event.watchId, fvgId: event.rawFvg.id,
            decisionTime: event.rawFvg.confirmedAt })) {
            emit('NO_TRADE', null, { reasonCode: 'EQ_ALREADY_CONSUMED' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'EQ_ALREADY_CONSUMED' });
        }
        if (!slotFree()) {
            emit('NO_TRADE', null, { reasonCode: 'SYMBOL_SLOT_BUSY' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'SYMBOL_SLOT_BUSY' });
        }
        var context = Object.assign({}, getContext(event.rawFvg.confirmedAt), {
            tradeId: tradeIdFor(event), liveTradingEnabled: live
        });
        var built = rules.buildEntryPlan(event, context);
        var trade = { tradeId: context.tradeId, symbol: symbol, status: built.ok ? 'PLANNED' : 'NO_TRADE',
            reasonCode: built.reasonCode || null, plan: built.plan, positionQty: 0,
            entryOrder: null, slOrder: null, tpOrder: null, createdAt: Date.now(), updatedAt: Date.now() };
        repository.putTrade(trade);
        if (!built.ok) { emit('NO_TRADE', trade, { reasonCode: built.reasonCode }); repository.release(); return Promise.resolve(trade); }
        if (!live) { trade.status = 'SHADOW_ORDER'; trade.reasonCode = 'LIVE_TRADING_DISABLED';
            trade.entryOrder = { tradeId: trade.tradeId, role: 'ENTRY', clientOrderId: null, exchangeOrderId: null,
                symbol: symbol, side: trade.plan.direction === 'LONG' ? 'BUY' : 'SELL', type: 'LIMIT',
                requestedQty: trade.plan.requestedQty, executedQty: 0, remainingQty: trade.plan.requestedQty,
                averagePrice: 0, status: 'SHADOW_PENDING', createdAt: Date.now(), updatedAt: Date.now(), lastExchangeSyncAt: null };
            saveTrade(trade);
            emitOnce('SHADOW_ORDER', trade, { reasonCode: 'LIVE_TRADING_DISABLED' }); repository.release(); return Promise.resolve(trade); }
        if (!accountReady) { trade.status = 'EXECUTION_ERROR'; trade.reasonCode = 'ACCOUNT_MODE_INVALID'; saveTrade(trade);
            return emit('EXCHANGE_REJECTED', trade, { critical: true, reasonCode: trade.reasonCode }).then(function () { return trade; }); }
        return client.submitEntry(trade.plan).then(function (response) {
            trade.entryOrder = orderRecord(trade, 'ENTRY', response);
            trade.tradeCaseId = 'REAL_TRADE_CASE_' + trade.tradeId;
            if (trade.entryOrder.status === 'REJECTED') throw Object.assign(new Error('ENTRY_REJECTED'), { code: 'EXCHANGE_REJECTED' });
            trade.status = trade.entryOrder.status === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED'
                : trade.entryOrder.status === 'FILLED' ? 'FILLED' : 'ENTRY_PENDING'; saveTrade(trade);
            return emitOnce('ENTRY_SUBMITTED', trade).then(function () { return trade; });
        }).catch(function (error) {
            if (rateLimitGovernor.isRateLimitError(error)) return holdForRateLimit(trade, error);
            trade.status = 'EXECUTION_ERROR'; trade.reasonCode = error.code || 'EXCHANGE_REJECTED'; saveTrade(trade);
            return emit(error.code === 'ORDER_STATE_UNKNOWN' ? 'ORDER_STATE_UNKNOWN' : 'EXCHANGE_REJECTED', trade,
                { critical: true, reasonCode: trade.reasonCode }).then(function () { return trade; });
        });
    }

    function onConfirmedSwings(swings) {
        return enqueue(function () {
            if (!live) {
                var all = repository.snapshot().trades;
                Object.keys(all).forEach(function (id) {
                    var shadow = all[id];
                    if (shadow.status !== 'SHADOW_ORDER' || !shadow.entryOrder || shadow.entryOrder.status !== 'SHADOW_PENDING') return;
                    var shadowStopType = shadow.plan.direction === 'LONG' ? 'SWING_LOW' : 'SWING_HIGH';
                    var match = (swings || []).some(function (s) { return s.type === shadowStopType && num(s.confirmedAt) > num(shadow.plan.decisionTime); });
                    if (!match) return;
                    shadow.status = 'SHADOW_CANCELED'; shadow.entryOrder.status = 'CANCELED'; shadow.entryOrder.updatedAt = Date.now();
                    repository.updateTrade(shadow); emitOnce('ENTRY_CANCELED', shadow, { shadow: true });
                });
                return;
            }
            var trade = repository.activeTrade();
            if (!trade || !trade.entryOrder || !isOpen(trade.entryOrder)) return;
            var stopType = trade.plan.direction === 'LONG' ? 'SWING_LOW' : 'SWING_HIGH';
            var pivot = (swings || []).filter(function (s) {
                return s.type === stopType && num(s.confirmedAt) > num(trade.plan.decisionTime);
            }).sort(function (a, b) { return a.confirmedAt - b.confirmedAt; })[0];
            if (!pivot) return;
            trade.status = 'CANCEL_REQUESTED'; trade.cancelReason = 'NEW_CONFIRMED_' + stopType; saveTrade(trade);
            return cancelConfirmed(trade.entryOrder, 'ENTRY', trade).then(function () {
                return emitOnce('ENTRY_CANCELED', trade).then(reconcile);
            }, function () { return reconcile(); });
        });
    }

    function verifyAccount() {
        if (!live) return Promise.resolve(true);
        return client.syncTime().then(function () {
            return Promise.all([client.getPositionMode(), client.getSymbolConfig(symbol)]);
        }).then(function (values) {
            if (values[0].dualSidePosition === true || values[0].dualSidePosition === 'true') throw Object.assign(new Error('POSITION_MODE_NOT_ONE_WAY'), { code: 'POSITION_MODE_INVALID' });
            var configs = Array.isArray(values[1]) ? values[1] : [values[1]];
            var config = configs.filter(function (item) { return item && item.symbol === symbol; })[0] || {};
            if (String(config.marginType || '').toUpperCase() !== 'CROSSED') throw Object.assign(new Error('MARGIN_MODE_NOT_CROSS'), { code: 'MARGIN_MODE_INVALID' });
            if (Number(config.leverage) !== 10) return client.setLeverage(symbol, 10);
        }).then(function () { accountReady = true; return startupOrphanReconcile(); }).catch(function (error) {
            accountReady = false;
            var active = repository.activeTrade();
            if (active && rateLimitGovernor.isRateLimitError(error)) return holdForRateLimit(active, error).then(function () { return false; });
            return emit('EXCHANGE_REJECTED', null, { critical: true,
                reasonCode: error.code || 'ACCOUNT_MODE_INVALID', detail: error.message }).then(function () { return false; });
        });
    }
    function start() {
        return verifyAccount().then(function () {
            if (!live || !accountReady) return;
            stream = streamFactory({ client: client, onEvent: function (event) {
                if (event && (event.e === 'ORDER_TRADE_UPDATE' || event.e === 'ACCOUNT_UPDATE')) enqueue(reconcile);
            }, onReconnect: function () { return enqueue(startupOrphanReconcile); }, observe: observe });
            return stream.start().catch(function (error) { emit('WS_ERROR', null, { critical: true, detail: error.message }); });
        }).then(function () {
            pollTimer = setInterval(function () { if (repository.activeTrade()) enqueue(reconcile); }, 5000);
        });
    }
    function stop() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; return stream ? stream.stop() : Promise.resolve(); }
    function onFirstMatchingFvg(event) {
        if (!event || event.ordinal !== 1) return Promise.resolve({ status: 'IGNORED' });
        var admission = getNewTradeAdmission();
        if (admission === false || (admission && admission.admitted === false)) {
            var deniedReason = admission && admission.reasonCode || 'SYMBOL_NOT_IN_SCAN_UNIVERSE';
            emit('NO_TRADE', null, { reasonCode: deniedReason });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: deniedReason });
        }
        // Persist the one-shot consumption synchronously at the WATCH boundary.
        // Exchange work remains queued and cannot block or roll back WATCH.
        var consumed = repository.consumeEq(event.liquidityId, { watchId: event.watchId,
            fvgId: event.rawFvg.id, decisionTime: event.rawFvg.confirmedAt });
        if (!consumed) {
            emit('NO_TRADE', null, { reasonCode: 'EQ_ALREADY_CONSUMED' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'EQ_ALREADY_CONSUMED' });
        }
        return enqueue(function () { return consumeSignal(event, true); });
    }
    return { start: start, stop: stop, onFirstMatchingFvg: onFirstMatchingFvg,
        onConfirmedSwings: onConfirmedSwings, reconcile: function () { return enqueue(reconcile); },
        getSnapshot: repository.snapshot, isSlotFree: slotFree,
        hasActiveLifecycle: function () { return !slotFree(); },
        isExecutionReady: function () { return !live || accountReady; },
        _repository: repository };
}

module.exports = { VERSION: rules.VERSION, createService: createService, tradeIdFor: tradeIdFor,
    orderRecord: orderRecord, isOpen: isOpen };
