'use strict';

/**
 * BREAKOUT_EXECUTION_V1 - the new production order lifecycle.
 *
 *   breakout STOP_MARKET entry (CONTRACT_PRICE)
 *     -> exchange fill (real position qty is the source of truth)
 *     -> initial SL / TP (MARK_PRICE, closePosition)
 *     -> Dynamic-D driven SL (monotonic) / TP (bidirectional) replacement,
 *        new-protection-first, never cancel-first
 *     -> sibling cleanup / orphan cleanup / restart recovery / EXECUTION_HALT
 *
 * All mutation goes through the execution client, which is itself gated by
 * LIVE_TRADING_ENABLED. With live=false every mutation call rejects and the
 * trade stays a SHADOW plan.
 */

var rules = require('./breakoutEntryRulesV1');
var pm = require('./positionManagementV1');
var repositoryModule = require('./executionRepositoryV1');
var streamModule = require('./userDataStreamV1');
var rateLimitGovernor = require('../data/binanceRateLimitGovernorV1');

var VERSION = 'BREAKOUT_EXECUTION_V1';

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
function isOpen(order) {
    return !!order && ['NEW', 'PARTIALLY_FILLED', 'PENDING', 'ACTIVE', 'TRIGGERED', 'SHADOW_PENDING']
        .indexOf(order.status) >= 0;
}
function orderId(order) {
    return order && (order.clientAlgoId || order.clientOrderId || order.algoId || order.orderId) || null;
}
function statusOf(raw) {
    return (raw && (raw.algoStatus || raw.status)) || null;
}

function tradeIdFor(plan) { return 'BB_' + String(plan.setupId).replace(/[^A-Za-z0-9]/g, '').slice(-24); }

function createService(options) {
    var opts = options || {};
    var symbol = opts.symbol;
    var client = opts.client;
    var live = opts.liveTradingEnabled === true;
    var repository = opts.repository || repositoryModule.createRepository({ initial: opts.initialState, persist: opts.persist });
    var observe = opts.observe || function () {};
    var alert = opts.alert || function () { return Promise.resolve(); };
    var streamFactory = opts.streamFactory || streamModule.createStream;
    var getNewTradeAdmission = opts.getNewTradeAdmission || function () { return { admitted: true, reasonCode: null }; };
    var getMarkPrice = opts.getMarkPrice || function () { return null; };
    var stream = null;
    var pollTimer = null;
    var queue = Promise.resolve();
    var accountReady = !live;
    var halted = false;
    var haltReason = null;
    var pendingDynamicD = [];
    var latestTwoBar = null;

    function emit(type, trade, extra) {
        var event = Object.assign({ type: type, symbol: symbol, tradeId: trade && trade.tradeId || null }, extra || {});
        observe(clone(event));
        return Promise.resolve(alert(clone(event))).catch(function () {});
    }
    function enqueue(fn) {
        queue = queue.then(fn, fn).catch(function (error) {
            return emit('EXECUTION_ERROR', repository.activeTrade(),
                { critical: true, reasonCode: error.code || 'EXECUTION_ERROR', detail: error.message });
        });
        return queue;
    }
    function saveTrade(trade) {
        trade.updatedAt = Date.now();
        repository.updateTrade(trade);
    }
    function emitOnce(type, trade, extra) {
        if (!trade) return emit(type, trade, extra);
        trade.alertedEvents = trade.alertedEvents || {};
        if (trade.alertedEvents[type]) return Promise.resolve();
        trade.alertedEvents[type] = Date.now();
        saveTrade(trade);
        return emit(type, trade, extra);
    }
    function slotFree() {
        var trade = repository.activeTrade();
        if (!trade) return true;
        var positionZero = num(trade.positionQty) === 0;
        var noOpen = !isOpen(trade.entryOrder) && !isOpen(trade.slOrder) && !isOpen(trade.tpOrder);
        return noOpen && positionZero && (!trade.entryOrder || trade.entryOrder.status !== 'UNKNOWN');
    }
    function halt(reason, trade) {
        halted = true;
        haltReason = reason;
        return emitOnce('EXECUTION_HALT', trade, { critical: true, reasonCode: reason });
    }

    // ------------------------------------------------------------- entry path

    /** §10 idempotent: one breakout entry per setupId, ever. */
    function onSetup(plan, ctx) {
        if (!plan || plan.ok !== true) return Promise.resolve({ status: 'REJECTED_PLAN' });
        if (halted) {
            emit('NEW_ENTRY_BLOCKED', null, { reasonCode: 'EXECUTION_HALT_ACTIVE', detail: haltReason });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'EXECUTION_HALT_ACTIVE' });
        }
        var admission = getNewTradeAdmission();
        if (admission === false || (admission && admission.admitted === false)) {
            var denied = (admission && admission.reasonCode) || 'SYMBOL_NOT_IN_SCAN_UNIVERSE';
            emit('NO_TRADE', null, { reasonCode: denied });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: denied });
        }
        if (!repository.consumeEq(plan.setupId, { symbol: symbol, direction: plan.direction })) {
            emit('NO_TRADE', null, { reasonCode: 'SETUP_ALREADY_CONSUMED' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'SETUP_ALREADY_CONSUMED' });
        }
        if (!slotFree()) {
            emit('NO_TRADE', null, { reasonCode: 'SYMBOL_SLOT_BUSY' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'SYMBOL_SLOT_BUSY' });
        }
        var trade = {
            tradeId: tradeIdFor(plan), symbol: symbol, status: 'PENDING_BREAKOUT_SETUP',
            reasonCode: null, plan: clone(plan.plan), positionQty: 0,
            entryOrder: null, slOrder: null, tpOrder: null,
            slRevision: 0, tpRevision: 0, positionOpenedAt: null,
            createdAt: Date.now(), updatedAt: Date.now(), alertedEvents: {}
        };
        repository.putTrade(trade);
        if (!live) {
            trade.entryOrder = { role: 'ENTRY', clientOrderId: null, status: 'SHADOW_PENDING',
                type: 'STOP_MARKET', triggerPrice: trade.plan.entryTrigger,
                workingType: 'CONTRACT_PRICE', requestedQty: trade.plan.requestedQty };
            trade.status = 'SHADOW_BREAKOUT_PENDING';
            saveTrade(trade);
            emitOnce('BREAKOUT_ENTRY_SUBMITTED', trade, { shadow: true,
                reasonCode: 'LIVE_TRADING_DISABLED', entryTrigger: trade.plan.entryTrigger,
                entryWorkingType: 'CONTRACT_PRICE' });
            return Promise.resolve({ status: 'SHADOW_ORDER', trade: trade });
        }
        if (!accountReady) {
            trade.status = 'EXECUTION_ERROR'; trade.reasonCode = 'ACCOUNT_MODE_INVALID'; saveTrade(trade);
            return emit('EXCHANGE_REJECTED', trade, { critical: true, reasonCode: 'ACCOUNT_MODE_INVALID' })
                .then(function () { return { status: 'EXCHANGE_REJECTED' }; });
        }
        return client.placeBreakoutEntry(trade.plan).then(function (response) {
            trade.entryOrder = { role: 'ENTRY', clientOrderId: response && (response.clientAlgoId || response.clientOrderId),
                algoId: response && response.algoId, status: statusOf(response) || 'NEW', type: 'STOP_MARKET',
                triggerPrice: trade.plan.entryTrigger, workingType: 'CONTRACT_PRICE',
                requestedQty: trade.plan.requestedQty, createdAt: Date.now(), updatedAt: Date.now() };
            trade.status = 'BREAKOUT_ENTRY_PENDING';
            saveTrade(trade);
            return emitOnce('BREAKOUT_ENTRY_SUBMITTED', trade, {
                entryTrigger: trade.plan.entryTrigger, entryWorkingType: 'CONTRACT_PRICE',
                direction: trade.plan.direction, initialSL: trade.plan.initialSL,
                initialTP: trade.plan.initialTP, initialRR: trade.plan.initialRR });
        }).then(function () { return { status: 'BREAKOUT_ENTRY_PENDING', trade: trade }; })
            .catch(function (error) {
                if (rateLimitGovernor.isRateLimitError(error)) {
                    trade.status = 'RATE_LIMITED'; saveTrade(trade);
                    return { status: 'RATE_LIMITED' };
                }
                trade.status = 'EXECUTION_ERROR'; trade.reasonCode = error.code || 'EXCHANGE_REJECTED';
                saveTrade(trade);
                return emit('EXCHANGE_REJECTED', trade, { critical: true, reasonCode: trade.reasonCode })
                    .then(function () { return { status: 'EXCHANGE_REJECTED', reasonCode: trade.reasonCode }; });
            });
    }

    // --------------------------------------------------------- protection path

    /** New-protection-first: place, confirm, then cancel the old one. */
    function replaceProtection(trade, role, price) {
        var revisionKey = role + ':' + (role === 'SL' ? trade.slRevision + 1 : trade.tpRevision + 1);
        var planForPlacement = Object.assign({}, trade.plan, { tradeId: trade.tradeId + ':' + revisionKey });
        if (role === 'SL') planForPlacement.stopPrice = price; else planForPlacement.targetPrice = price;
        return client.submitProtection(planForPlacement, role).then(function (response) {
            var placedId = orderId(response);
            if (!placedId) throw Object.assign(new Error('PROTECTION_ID_MISSING'), { code: 'PROTECTION_ID_MISSING' });
            return client.queryAlgoOrder(symbol, null, placedId).then(function (state) {
                if (!isOpen({ status: statusOf(state) })) {
                    throw Object.assign(new Error('PROTECTION_NOT_ACTIVE'), { code: 'PROTECTION_NOT_ACTIVE' });
                }
                var old = role === 'SL' ? trade.slOrder : trade.tpOrder;
                var next = { role: role, clientOrderId: placedId, status: statusOf(state),
                    price: price, createdAt: Date.now(), updatedAt: Date.now() };
                if (role === 'SL') { trade.slRevision += 1; trade.slOrder = next; }
                else { trade.tpRevision += 1; trade.tpOrder = next; }
                saveTrade(trade);
                var oldId = orderId(old);
                if (!oldId || oldId === placedId) return { placed: placedId, canceledOld: null };
                return client.cancelAlgo(symbol, oldId).then(function () {
                    if (role === 'SL') trade.slOrder = next; else trade.tpOrder = next;
                    saveTrade(trade);
                    return { placed: placedId, canceledOld: oldId };
                });
            });
        }).catch(function (error) {
            // the old protection is deliberately left in place
            return emit('PROTECTION_REPLACE_FAILED', trade, { critical: true,
                reasonCode: error.code || 'PROTECTION_REPLACE_FAILED', role: role })
                .then(function () { return halt('PROTECTION_REPLACEMENT_FAILED', trade); })
                .then(function () { return { placed: null, keptOld: true, errorCode: error.code }; });
        });
    }

    function ensureProtection(trade, qty) {
        var missingSl = !isOpen(trade.slOrder);
        var missingTp = !isOpen(trade.tpOrder);
        if (!missingSl && !missingTp) return Promise.resolve(trade);
        if (missingSl && !trade.slOrder) {
            return replaceProtection(trade, 'SL', trade.plan.initialSL).then(function () {
                return ensureProtection(trade, qty);
            });
        }
        if (missingTp && !trade.tpOrder) {
            return replaceProtection(trade, 'TP', trade.plan.initialTP).then(function () {
                return ensureProtection(trade, qty);
            });
        }
        return Promise.resolve(trade);
    }

    // ------------------------------------------------------------ dynamic part

    /** §19-§23 dynamic SL / TP driven by newly confirmed Causal Dynamic-D. */
    function applyDynamic(trade, position, markPrice, evaluationTime) {
        var direction = trade.plan.direction;
        var updates = pendingDynamicD.filter(function (p) {
            return pm.isEligibleUpdate(p, trade.positionOpenedAt, evaluationTime);
        });
        var chain = Promise.resolve(trade);
        updates.forEach(function (point) {
            chain = chain.then(function () {
                var wantStop = direction === 'LONG' ? point.pointSide === 'LOW' : point.pointSide === 'HIGH';
                if (wantStop && point.price !== undefined) {
                var decision = pm.nextStop(direction, trade.slOrder && trade.slOrder.price, point.price, markPrice);
                    if (decision.action === 'UPDATE') {
                        var old = trade.slOrder && trade.slOrder.price;
                        return replaceProtection(trade, 'SL', decision.newStop).then(function (placement) {
                            // new-protection-first: on failure the old stop stays and the
                            // symbol is halted, so no SL_UPDATED event may be emitted.
                            if (!placement || placement.placed === undefined || placement.placed === null) return null;
                            return emitOnce('SL_UPDATED_' + decision.newStop, trade, { oldSL: old,
                                newSL: decision.newStop, dynamicDSource: point.id,
                                dynamicDConfirmedAt: point.confirmedAt });
                        });
                    }
                }
                return null;
            }).then(function () {
                var opposite = direction === 'LONG' ? 'HIGH' : 'LOW';
                if (point.pointSide !== opposite) return null;
                var target = rules.selectTarget(direction, markPrice, pendingDynamicD, [], evaluationTime, null);
                if (!target) return null;
                var decision = pm.nextTarget(direction, trade.tpOrder && trade.tpOrder.price, target.price, markPrice);
                if (decision.action !== 'UPDATE') return null;
                var oldTp = trade.tpOrder && trade.tpOrder.price;
                return replaceProtection(trade, 'TP', decision.newTarget).then(function (placement) {
                    if (!placement || placement.placed === undefined || placement.placed === null) return null;
                    return emitOnce('TP_UPDATED_' + decision.newTarget, trade, { oldTP: oldTp,
                        newTP: decision.newTarget, dynamicDSource: target.id,
                        dynamicDConfirmedAt: target.confirmedAt });
                });
            });
        });
        return chain;
    }

    function onDynamicD(points, evaluationTime) {
        (points || []).forEach(function (point) {
            if (!point || typeof point.confirmedAt !== 'number') return;
            if (point.confirmedAt > evaluationTime) return;
            pendingDynamicD.push(point);
        });
        if (pendingDynamicD.length > 500) pendingDynamicD = pendingDynamicD.slice(-500);
        return Promise.resolve();
    }

    function onTwoBar(setup) {
        latestTwoBar = setup || null;
        return Promise.resolve();
    }

    // ------------------------------------------------------------- reconcile

    /**
     * An open position is never allowed to sit without its protective legs. Used
     * by the ordinary reconcile loop, by the first fill, and by the cancel/fill
     * race path (exchange truth wins over a cancel request).
     */
    function protectOpenPosition(trade, position, markPrice) {
        var qty = Math.abs(num(trade.positionQty));
        return ensureProtection(trade, qty).then(function () {
            if (!isOpen(trade.slOrder)) {
                // §48: the exchange shows exposure without a live stop. Repair with the
                // frozen plan's stop, then halt new entries (the runner keeps managing).
                return replaceProtection(trade, 'SL', trade.slOrder && trade.slOrder.price || trade.plan.initialSL)
                    .then(function () { return halt('UNPROTECTED_LIVE_POSITION', trade); });
            }
            return applyDynamic(trade, position, markPrice, Date.now()).then(function () {
                if (!isOpen(trade.slOrder)) return halt('UNPROTECTED_LIVE_POSITION', trade);
                trade.status = isOpen(trade.tpOrder) ? 'PROTECTED' : 'PROTECTION_ERROR';
                saveTrade(trade);
                return null;
            });
        });
    }

    /**
     * Re-syncs the protective legs with the exchange. A stop that vanished from
     * the exchange while the position is still open must not stay "NEW" in the
     * persisted plan - otherwise an unprotected live position would look healthy.
     */
    function syncProtectionStatus(trade, openAlgos) {
        [trade.slOrder, trade.tpOrder].forEach(function (protection) {
            if (!protection) return;
            var match = openAlgos.filter(function (o) { return orderId(o) === orderId(protection); })[0];
            protection.status = match ? (statusOf(match) || 'NEW') : 'MISSING_ON_EXCHANGE';
        });
    }

    function reconcile() {
        var trade = repository.activeTrade();
        if (!trade || !live) return Promise.resolve(trade);
        return Promise.all([
            client.getPositionRisk(symbol), client.getOpenOrders(symbol), client.getOpenAlgoOrders(symbol)
        ]).then(function (values) {
            var positions = Array.isArray(values[0]) ? values[0] : [values[0]];
            var qty = Math.abs(num((positions[0] || {}).positionAmt));
            var openOrders = values[1] || [];
            var openAlgos = values[2] || [];
            var entryMatch = openAlgos.filter(function (o) {
                return orderId(o) && trade.entryOrder && orderId(o) === orderId(trade.entryOrder);
            })[0];
            trade.positionQty = qty;
            if (trade.entryOrder && trade.entryOrder.role === 'ENTRY') {
                trade.entryOrder.status = entryMatch ? (statusOf(entryMatch) || 'NEW') : 'FILLED_OR_GONE';
            }
            if (qty > 0) syncProtectionStatus(trade, openAlgos);
            saveTrade(trade);

            // §26: the very first time the exchange shows a position (even a partial
            // fill) the protective legs are created in this same pass.
            var firstFill = false;
            if (qty > 0 && !trade.positionOpenedAt) {
                trade.positionOpenedAt = Date.now();
                trade.status = 'POSITION_OPEN';
                saveTrade(trade);
                firstFill = true;
            }

            var rawMark = getMarkPrice();
            var markPrice = num(rawMark);
            // A missing mark price must never be read as "price is 0" and
            // invalidate a healthy pending breakout.
            var markKnown = rawMark !== null && rawMark !== undefined && Number.isFinite(Number(rawMark)) &&
                Number(rawMark) > 0;

            if (qty === 0 && markKnown && trade.entryOrder && isOpen(trade.entryOrder)) {
                var invalidation = pm.pendingEntryInvalidation(trade.plan, {
                    currentContractPrice: markPrice,
                    oppositeTwoBarConfirmed: !!(latestTwoBar && latestTwoBar.direction !== trade.plan.direction)
                });
                if (invalidation.cancel) {
                    // §50 PENDING_ENTRY_CANCEL_FILL_RACE: the cancel may race a fill.
                    // Re-read the exchange instead of trusting "canceled".
                    return client.cancelAlgo(symbol, orderId(trade.entryOrder)).catch(function () { return null; })
                        .then(function () { return client.getPositionRisk(symbol); })
                        .then(function (after) {
                            var afterQty = Math.abs(num(((Array.isArray(after) ? after[0] : after) || {}).positionAmt));
                            trade.positionQty = afterQty;
                            if (afterQty > 0) {
                                // Exchange truth wins: the pending entry actually filled.
                                trade.entryOrder.status = 'FILLED_OR_GONE';
                                if (!trade.positionOpenedAt) trade.positionOpenedAt = Date.now();
                                trade.status = 'POSITION_OPEN';
                                saveTrade(trade);
                                return emitOnce('BREAKOUT_ENTRY_FILL_RACE_RECOGNIZED', trade, {
                                    positionQty: afterQty, requestedCancelReason: invalidation.reason
                                }).then(function () {
                                    return protectOpenPosition(trade, positions[0], markPrice);
                                });
                            }
                            trade.entryOrder.status = 'CANCELED';
                            trade.status = 'BREAKOUT_ENTRY_CANCELED';
                            trade.reasonCode = invalidation.reason;
                            saveTrade(trade);
                            return emitOnce('BREAKOUT_ENTRY_CANCELED', trade, { reasonCode: invalidation.reason });
                        });
                }
                return trade;
            }

            if (qty > 0) {
                if (!firstFill) return protectOpenPosition(trade, positions[0], markPrice);
                return emitOnce('BREAKOUT_ENTRY_FILLED', trade, { positionQty: qty,
                    entryWorkingType: 'CONTRACT_PRICE' }).then(function () {
                    return protectOpenPosition(trade, positions[0], markPrice);
                });
            }

            // position closed -> sibling / orphan cleanup
            var orphans = openAlgos.filter(function (o) {
                var id = orderId(o) || '';
                return id.indexOf('IMC_') === 0 && (!trade.slOrder || id !== orderId(trade.slOrder))
                    && (!trade.tpOrder || id !== orderId(trade.tpOrder));
            });
            var chain = Promise.resolve();
            [trade.slOrder, trade.tpOrder].forEach(function (protection) {
                if (!isOpen(protection)) return;
                chain = chain.then(function () {
                    return client.cancelAlgo(symbol, orderId(protection)).then(function () {
                        protection.status = 'CANCELED';
                    }, function () { return null; });
                });
            });
            orphans.forEach(function (orphan) {
                chain = chain.then(function () {
                    return emit('ORPHAN_ORDER_FOUND', trade, { critical: true, detail: orderId(orphan) })
                        .then(function () { return client.cancelAlgo(symbol, orderId(orphan)); });
                });
            });
            return chain.then(function () {
                if (trade.status !== 'BREAKOUT_ENTRY_CANCELED') {
                    trade.status = 'CLOSED';
                    saveTrade(trade);
                    return emitOnce('POSITION_CLOSED', trade);
                }
                return null;
            });
        });
    }

    /** §29 restart recovery over the exchange truth. */
    function recover() {
        if (!live) return Promise.resolve({ mode: 'SHADOW' });
        var trade = repository.activeTrade();
        return Promise.all([
            client.getPositionRisk(symbol), client.getOpenOrders(symbol), client.getOpenAlgoOrders(symbol)
        ]).then(function (values) {
            var positions = Array.isArray(values[0]) ? values[0] : [values[0]];
            var qty = Math.abs(num((positions[0] || {}).positionAmt));
            var algos = (values[2] || []).filter(function (o) {
                return String(orderId(o) || '').indexOf('IMC_') === 0;
            });
            if (qty > 0 && !trade) {
                return halt('UNRECOVERABLE_EXCHANGE_POSITION', null).then(function () {
                    return { mode: 'CRITICAL_NO_PLAN', qty: qty, protectiveOrders: algos.length };
                });
            }
            if (trade) {
                var matched = {
                    entry: algos.filter(function (o) { return orderId(o) === orderId(trade.entryOrder); }).length,
                    sl: algos.filter(function (o) { return orderId(o) === orderId(trade.slOrder); }).length,
                    tp: algos.filter(function (o) { return orderId(o) === orderId(trade.tpOrder); }).length
                };
                trade.positionQty = qty;
                if (qty > 0 && trade.positionOpenedAt === null) trade.positionOpenedAt = Date.now();
                saveTrade(trade);
                return reconcile().then(function () {
                    return { mode: 'RESTORED', qty: qty, matched: matched, protectiveOrders: algos.length };
                });
            }
            if (algos.length > 0) {
                var cleanup = Promise.resolve();
                algos.forEach(function (o) {
                    cleanup = cleanup.then(function () {
                        return emit('ORPHAN_ORDER_FOUND', null, { critical: true, detail: orderId(o) })
                            .then(function () { return client.cancelAlgo(symbol, orderId(o)); });
                    });
                });
                return cleanup.then(function () { return { mode: 'ORPHANS_CLEARED', count: algos.length }; });
            }
            return { mode: 'CLEAN' };
        });
    }

    function verifyAccount() {
        if (!live) return Promise.resolve(true);
        return client.syncTime().then(function () {
            return Promise.all([client.getPositionMode(), client.getSymbolConfig(symbol)]);
        }).then(function (values) {
            var config = (Array.isArray(values[1]) ? values[1] : [values[1]])
                .filter(function (c) { return c && c.symbol === symbol; })[0] || {};
            if (Number(config.leverage) !== 10) return client.setLeverage(symbol, 10);
            accountReady = true;
            return null;
        }).then(function () {
            accountReady = true;
            return recover();
        }).catch(function (error) {
            accountReady = false;
            return emit('EXCHANGE_REJECTED', null, { critical: true,
                reasonCode: error.code || 'ACCOUNT_MODE_INVALID' }).then(function () { return false; });
        });
    }

    function start() {
        return verifyAccount().then(function () {
            if (!live || !accountReady) return null;
            stream = streamFactory({ client: client, onEvent: function (event) {
                if (event && (event.e === 'ORDER_TRADE_UPDATE' || event.e === 'ACCOUNT_UPDATE')) enqueue(reconcile);
            }, onReconnect: function () { return enqueue(recover); }, observe: observe });
            return stream.start().catch(function (error) {
                return emit('WS_ERROR', null, { critical: true, detail: error.message });
            });
        }).then(function () {
            pollTimer = setInterval(function () {
                if (repository.activeTrade()) enqueue(reconcile);
            }, 5000);
        });
    }
    function stop() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        return stream ? stream.stop() : Promise.resolve();
    }

    return {
        onSetup: onSetup,
        onDynamicD: onDynamicD,
        onTwoBar: onTwoBar,
        reconcile: function () { return enqueue(reconcile); },
        recover: function () { return enqueue(recover); },
        start: start,
        stop: stop,
        isHalted: function () { return halted; },
        haltReason: function () { return haltReason; },
        getSnapshot: repository.snapshot,
        hasActiveLifecycle: function () { return !slotFree(); },
        isExecutionReady: function () { return !live || accountReady; },
        _repository: repository
    };
}

module.exports = { VERSION: VERSION, createService: createService, tradeIdFor: tradeIdFor };
