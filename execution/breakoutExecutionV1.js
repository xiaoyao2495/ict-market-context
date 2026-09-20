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
var clientModule = require('./binanceExecutionClientV1');
var rateLimitGovernor = require('../data/binanceRateLimitGovernorV1');

var VERSION = 'BREAKOUT_EXECUTION_V1';
// REAL_SMOKE_2 hardening: bound the protection placement attempts per role and
// the visibility retries of one accepted placement.
// LAST-RESORT insurance only: it may never be the reason a new revision is placed.
var MAX_PROTECTION_PLACEMENTS_PER_ROLE = 3;
// A protection that cannot be confirmed on the exchange within this window leaves
// the position effectively unprotected: the service stops mutating and reports
// PROTECTION_UNVERIFIED (the runner/smoke then exits the position safely).
var PROTECTION_UNVERIFIED_AFTER_MS = 5000;
// Only these exchange answers prove that an EXACT protection order is finished.
var TERMINAL_PROTECTION_STATUS = ['CANCELED', 'REJECTED', 'EXPIRED', 'EXPIRED_IN_MATCH', 'FILLED'];

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
function validIdentity(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}
function validExecutionPlanIdentity(plan) {
    return !!plan && validIdentity(plan.setupId) && validIdentity(plan.eqId) &&
        validIdentity(plan.symbol) && validIdentity(plan.direction);
}
function ensureExecutionAudit(trade) {
    trade.executionAudit = trade.executionAudit || {
        protectionVerifyFailureCount: 0,
        temporaryExecutionHaltSeen: false,
        temporaryExecutionHaltCleared: false,
        protectionEventuallyVerified: false,
        protectionVerifiedRoles: { SL: false, TP: false },
        duplicateOrderDetected: false,
        orphanProtectionDetected: false
    };
    return trade.executionAudit;
}
function applyExecutionAuditEvent(type, trade, extra) {
    if (!trade) return false;
    var audit = ensureExecutionAudit(trade);
    if (type === 'PROTECTION_VERIFY_FAILED') {
        audit.protectionVerifyFailureCount = (audit.protectionVerifyFailureCount || 0) + 1;
        return true;
    }
    if (type === 'EXECUTION_HALT' && audit.temporaryExecutionHaltSeen !== true) {
        audit.temporaryExecutionHaltSeen = true; return true;
    }
    if (type === 'EXECUTION_HALT_CLEARED' && audit.temporaryExecutionHaltCleared !== true) {
        audit.temporaryExecutionHaltCleared = true; return true;
    }
    if (type === 'PROTECTION_VERIFIED') {
        audit.protectionVerifiedRoles = audit.protectionVerifiedRoles || { SL: false, TP: false };
        var role = extra && extra.role;
        var changed = false;
        if ((role === 'SL' || role === 'TP') && audit.protectionVerifiedRoles[role] !== true) {
            audit.protectionVerifiedRoles[role] = true; changed = true;
        }
        if (audit.protectionVerifiedRoles.SL === true && audit.protectionVerifiedRoles.TP === true &&
                audit.protectionEventuallyVerified !== true) {
            audit.protectionEventuallyVerified = true; changed = true;
        }
        return changed;
    }
    if (type === 'ORPHAN_ORDER_FOUND' && audit.orphanProtectionDetected !== true) {
        audit.orphanProtectionDetected = true; return true;
    }
    if ((type === 'BREAKOUT_ENTRY_FILLED' || type === 'BREAKOUT_ENTRY_FILL_RACE_RECOGNIZED') &&
            extra && num(extra.positionQty) > num(audit.maxFilledQty)) {
        audit.maxFilledQty = num(extra.positionQty); return true;
    }
    return false;
}
function closedSummary(trade) {
    var plan = trade.plan || {};
    var audit = ensureExecutionAudit(trade);
    var holdingSeconds = trade.positionOpenedAt && trade.closedAt
        ? Math.max(0, (trade.closedAt - trade.positionOpenedAt) / 1000) : null;
    var unresolved = Boolean((trade.slOrder && trade.slOrder.unresolved === true) ||
        (trade.tpOrder && trade.tpOrder.unresolved === true));
    return {
        symbol: trade.symbol, direction: plan.direction, tradeId: trade.tradeId,
        setupId: plan.setupId, eqId: plan.eqId,
        setup: { submittedAt: trade.submittedAt || (trade.entryOrder && trade.entryOrder.createdAt) || null,
            plannedEntry: plan.entryTrigger, initialSL: plan.initialSL,
            initialTP: plan.initialTP, initialRR: plan.initialRR },
        entry: { filled: trade.positionOpenedAt !== null && trade.positionOpenedAt !== undefined,
            fillPrice: null, filledAt: trade.positionOpenedAt || null,
            qty: audit.maxFilledQty || null, notional: null },
        protection: { slPlaced: !!trade.slOrder, tpPlaced: !!trade.tpOrder,
            protectionEventuallyVerified: audit.protectionEventuallyVerified === true,
            protectionVerifyFailureCount: audit.protectionVerifyFailureCount || 0,
            temporaryExecutionHaltSeen: audit.temporaryExecutionHaltSeen === true,
            temporaryExecutionHaltCleared: audit.temporaryExecutionHaltCleared === true },
        exit: { exitReason: 'UNKNOWN', exitPrice: null, closedAt: trade.closedAt || null,
            holdingSeconds: holdingSeconds },
        result: { grossPnl: null, fees: null, netPnl: null, realizedR: null },
        executionAudit: { duplicateOrderDetected: audit.duplicateOrderDetected === true,
            orphanProtectionDetected: audit.orphanProtectionDetected === true,
            unresolvedProtection: unresolved,
            executionAnomaly: audit.duplicateOrderDetected === true ||
                audit.orphanProtectionDetected === true || unresolved ||
                (audit.temporaryExecutionHaltSeen === true && audit.temporaryExecutionHaltCleared !== true) }
    };
}

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
    // Circuit breaker: one accepted placement per expected clientAlgoId, ever.
    var protectionAttempts = {};
    /**
     * Every `protectionAttempts[id]` entry is an OBJECT carrying at least `state`.
     * Older/foreign snapshots may hold a bare status string; normalise on access so
     * an object-shaped write can never throw on a string primitive.
     */
    function attemptEntryAt(id) {
        var entry = protectionAttempts[id];
        if (!entry || typeof entry !== 'object') {
            entry = (typeof entry === 'string' && entry) ? { state: entry } : {};
            protectionAttempts[id] = entry;
        }
        return entry;
    }
    // Cleanup idempotency: once a protection is known terminal (cancel accepted,
    // exchange terminal, or confirmed absent) it is only ever QUERIED again.
    var cleanupTerminal = {};

    function emit(type, trade, extra) {
        if (applyExecutionAuditEvent(type, trade, extra)) persistTradeSoft(trade, 'EXECUTION_AUDIT_' + type);
        var event = Object.assign({ type: type, symbol: symbol, tradeId: trade && trade.tradeId || null }, extra || {});
        if (type === 'POSITION_CLOSED' && trade) event.summary = closedSummary(trade);
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

    /** §10 idempotent: one breakout entry per consumed EQ identity, ever. */
    function onSetup(envelope, ctx) {
        if (!envelope || envelope.ok !== true) return Promise.resolve({ status: 'REJECTED_PLAN' });
        var plan = envelope.plan;
        if (!validExecutionPlanIdentity(plan)) {
            emit('NO_TRADE', null, { reasonCode: 'INVALID_EXECUTION_PLAN_IDENTITY',
                setupId: plan && plan.setupId, eqId: plan && plan.eqId });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'INVALID_EXECUTION_PLAN_IDENTITY' });
        }
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
        if (!repository.consumeEq(plan.eqId, { symbol: plan.symbol, direction: plan.direction,
                setupId: plan.setupId })) {
            emit('NO_TRADE', null, { reasonCode: 'SETUP_ALREADY_CONSUMED' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'SETUP_ALREADY_CONSUMED' });
        }
        if (!slotFree()) {
            emit('NO_TRADE', null, { reasonCode: 'SYMBOL_SLOT_BUSY' });
            return Promise.resolve({ status: 'NO_TRADE', reasonCode: 'SYMBOL_SLOT_BUSY' });
        }
        var trade = {
            tradeId: tradeIdFor(plan), symbol: symbol, status: 'PENDING_BREAKOUT_SETUP',
            reasonCode: null, plan: clone(plan), positionQty: 0,
            entryOrder: null, slOrder: null, tpOrder: null,
            slRevision: 0, tpRevision: 0, positionOpenedAt: null,
            createdAt: Date.now(), updatedAt: Date.now(), alertedEvents: {},
            executionAudit: ensureExecutionAudit({})
        };
        repository.putTrade(trade);
        if (!live) {
            trade.entryOrder = { role: 'ENTRY', clientOrderId: null, status: 'SHADOW_PENDING',
                type: 'STOP_MARKET', triggerPrice: trade.plan.entryTrigger,
                workingType: 'CONTRACT_PRICE', requestedQty: trade.plan.requestedQty };
            trade.status = 'SHADOW_BREAKOUT_PENDING';
            trade.submittedAt = Date.now();
            saveTrade(trade);
            emitOnce('BREAKOUT_ENTRY_SUBMITTED', trade, { shadow: true,
                reasonCode: 'LIVE_TRADING_DISABLED', entryTrigger: trade.plan.entryTrigger,
                entryWorkingType: 'CONTRACT_PRICE', setupId: trade.plan.setupId, eqId: trade.plan.eqId,
                direction: trade.plan.direction, initialSL: trade.plan.initialSL,
                initialTP: trade.plan.initialTP, initialRR: trade.plan.initialRR,
                qty: trade.plan.requestedQty,
                notional: num(trade.plan.requestedQty) * num(trade.plan.entryTrigger),
                submittedAt: trade.submittedAt });
            return Promise.resolve({ status: 'SHADOW_ORDER', trade: trade });
        }
        if (!accountReady) {
            trade.status = 'EXECUTION_ERROR'; trade.reasonCode = 'ACCOUNT_MODE_INVALID'; saveTrade(trade);
            return emit('EXCHANGE_REJECTED', trade, { critical: true, reasonCode: 'ACCOUNT_MODE_INVALID' })
                .then(function () { return { status: 'EXCHANGE_REJECTED' }; });
        }
        return client.placeBreakoutEntry(trade.plan).then(function (response) {
            trade.submittedAt = Date.now();
            trade.entryOrder = { role: 'ENTRY', clientOrderId: response && (response.clientAlgoId || response.clientOrderId),
                algoId: response && response.algoId, status: statusOf(response) || 'NEW', type: 'STOP_MARKET',
                triggerPrice: trade.plan.entryTrigger, workingType: 'CONTRACT_PRICE',
                requestedQty: trade.plan.requestedQty, createdAt: Date.now(), updatedAt: Date.now() };
            trade.status = 'BREAKOUT_ENTRY_PENDING';
            saveTrade(trade);
            return emitOnce('BREAKOUT_ENTRY_SUBMITTED', trade, {
                entryTrigger: trade.plan.entryTrigger, entryWorkingType: 'CONTRACT_PRICE',
                direction: trade.plan.direction, initialSL: trade.plan.initialSL,
                initialTP: trade.plan.initialTP, initialRR: trade.plan.initialRR,
                setupId: trade.plan.setupId, eqId: trade.plan.eqId,
                qty: trade.plan.requestedQty,
                notional: num(trade.plan.requestedQty) * num(trade.plan.entryTrigger),
                submittedAt: trade.submittedAt });
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

    /**
     * Protect the live position with EXCHANGE TRUTH FIRST semantics.
     *
     * Invariants (REAL_SMOKE_2 root-cause fix):
     *  1. A successful POST means the protection EXISTS. Its identity is written to
     *     the trade BEFORE any verification, so a failed verify can never make the
     *     local state believe "no SL" and re-submit.
     *  2. Verification never re-places. It retries against the exchange by the exact
     *     algoId/clientAlgoId; an order that really exists is adopted.
     *  3. While halted, no protection placement may happen at all. Adoption is the
     *     only way out of a protection halt (it is a read, not a mutation).
     *  4. One accepted placement per expected clientAlgoId, hard-capped per role.
     */

    function exchangeErrorInfo(error) {
        var response = error && error.response;
        var data = (response && response.data) || {};
        return {
            status: (response && response.status) || (error && error.httpStatus) || null,
            code: data.code !== undefined ? data.code : ((error && error.binanceCode) || null),
            msg: data.msg !== undefined ? data.msg : ((error && error.binanceMessage) || null)
        };
    }

    function protectionRecord(trade, role) { return role === 'SL' ? trade.slOrder : trade.tpOrder; }
    function setProtectionRecord(trade, role, record) {
        if (role === 'SL') trade.slOrder = record; else trade.tpOrder = record;
    }
    function protectionRevision(trade, role) {
        return (role === 'SL' ? (trade.slRevision || 0) : (trade.tpRevision || 0)) + 1;
    }
    /** The exact clientAlgoId the next placement for this role would use. */
    function expectedProtectionClientId(trade, role, revision) {
        var rev = revision === undefined ? protectionRevision(trade, role) : revision;
        if (opts.deriveProtectionClientId) return opts.deriveProtectionClientId(trade, role, rev);
        return clientModule.clientId(trade.plan.symbol || symbol,
            trade.tradeId + ':' + role + ':' + rev, role);
    }
    function placementCount(trade, role) {
        trade.protectionPlacements = trade.protectionPlacements || { SL: 0, TP: 0 };
        return trade.protectionPlacements[role] || 0;
    }
    function notePlacement(trade, role) {
        trade.protectionPlacements = trade.protectionPlacements || { SL: 0, TP: 0 };
        trade.protectionPlacements[role] = (trade.protectionPlacements[role] || 0) + 1;
        return trade.protectionPlacements[role];
    }
    function rememberAbandoned(trade, role, clientAlgoId, algoId, reason) {
        trade.abandonedProtections = trade.abandonedProtections || [];
        trade.abandonedProtections.push({ role: role, clientAlgoId: clientAlgoId || null,
            algoId: algoId || null, reason: reason || null, at: Date.now() });
        if (trade.abandonedProtections.length > 8) {
            trade.abandonedProtections = trade.abandonedProtections.slice(-8);
        }
    }
    /**
     * §2/§3 REAL V3 halt-recovery fix.
     *
     * A protection halt may only be cleared on FRESH exchange truth that shows a LIVE
     * position protected on BOTH legs:
     *   positionQty != 0  AND  SL exchange-confirmed ACTIVE  AND  TP exchange-confirmed ACTIVE
     * - flat position          -> never clear (that path is cleanup)
     * - only SL or only TP     -> keep the halt
     * - accepted-but-unverified (POST 2xx then -2013/timeout) -> never clear
     */
    function clearProtectionHaltIfFullyProtected(trade) {
        if (!halted) return false;
        if (['PROTECTION_REPLACEMENT_FAILED', 'UNPROTECTED_LIVE_POSITION',
            'PROTECTION_PLACEMENT_UNKNOWN', 'PROTECTION_UNVERIFIED'].indexOf(haltReason) < 0) {
            return false;
        }
        if (!(Math.abs(num(trade && trade.positionQty)) > 0)) return false;
        var sl = trade.slOrder;
        var tp = trade.tpOrder;
        if (!sl || !tp) return false;
        if (sl.verified !== true || tp.verified !== true) return false;
        if (!isOpen(sl) || !isOpen(tp)) return false;
        return clearHalt('PROTECTION_VERIFIED_BOTH_LEGS', trade);
    }

    function clearHalt(reason, trade) {
        if (!halted) return false;
        halted = false;
        haltReason = null;
        emit('EXECUTION_HALT_CLEARED', trade, { detail: reason || null });
        return true;
    }

    /**
     * §19: a persistence failure must never erase an identity we just received
     * from the exchange. The in-memory trade keeps the protection id (so no
     * duplicate POST can follow), the trade is flagged, and the alarm is emitted.
     */
    function persistTradeSoft(trade, context) {
        try {
            saveTrade(trade);
            return true;
        } catch (error) {
            trade.persistenceDegraded = true;
            trade.persistenceError = { code: (error && error.code) || 'PERSIST_FAILED',
                message: (error && error.message) || String(error), at: Date.now() };
            emit('TRADE_PERSIST_FAILED', trade, { critical: true, phase: context || null,
                reasonCode: (error && error.code) || 'PERSIST_FAILED',
                detail: 'order identity is kept in memory; durable state is degraded' });
            return false;
        }
    }

    /** Commit an ACCEPTED placement before verifying it (exchange truth first). */
    function commitAcceptedPlacement(trade, role, price, expectedId, response) {
        var record = {
            role: role, clientOrderId: orderId(response) || expectedId,
            algoId: (response && response.algoId !== undefined) ? response.algoId : null,
            expectedClientAlgoId: expectedId, status: statusOf(response) || 'NEW', price: price,
            placedAt: Date.now(), verified: false, verifyAttempts: 0, verifyError: null,
            createdAt: Date.now(), updatedAt: Date.now()
        };
        setProtectionRecord(trade, role, record);
        if (role === 'SL') trade.slRevision = (trade.slRevision || 0) + 1;
        else trade.tpRevision = (trade.tpRevision || 0) + 1;
        var entry = attemptEntryAt(record.clientOrderId);
        entry.role = role;
        entry.state = 'PLACED';
        entry.accepted = true;
        entry.acceptedAt = entry.acceptedAt || Date.now();
        protectionAttempts[record.clientOrderId] = entry;
        return emit('PROTECTION_PLACED_VERIFICATION_PENDING', trade, { role: role,
            clientAlgoId: record.clientOrderId, algoId: record.algoId, status: record.status,
            triggerPrice: price, detail: 'POST accepted; identity committed before verification' })
            .then(function () { persistTradeSoft(trade, 'COMMIT_PLACEMENT'); return record; });
    }

    function isTerminalStatus(status) {
        return TERMINAL_PROTECTION_STATUS.indexOf(String(status || '').toUpperCase()) >= 0;
    }

    /**
     * TERMINAL PROOF ONLY. An accepted POST locks the role: a new revision may only
     * be placed after the exchange explicitly reports that THIS exact order ended
     * (CANCELED / REJECTED / EXPIRED / FILLED). "not found" is never proof.
     */
    function markProtectionTerminal(trade, role, record, status, info, source) {
        var entry = attemptEntryAt(record.clientOrderId);
        entry.role = role;
        entry.state = 'TERMINAL';
        entry.accepted = true;
        entry.terminalStatus = String(status || '').toUpperCase();
        entry.terminalAt = Date.now();
        entry.terminalSource = source || null;
        protectionAttempts[record.clientOrderId] = entry;
        rememberAbandoned(trade, role, record.clientOrderId, record.algoId, entry.terminalStatus);
        record.terminalStatus = entry.terminalStatus;
        record.verified = false;
        record.unresolved = false;
        setProtectionRecord(trade, role, null);
        persistTradeSoft(trade, 'PROTECTION_TERMINAL');
        return emit('PROTECTION_TERMINAL_ON_EXCHANGE', trade, { role: role,
            clientAlgoId: record.clientOrderId, algoId: record.algoId || null,
            status: entry.terminalStatus, source: source || null,
            exchangeCode: (info || {}).code === undefined ? null : info.code,
            exchangeMessage: (info || {}).msg === undefined ? null : info.msg,
            detail: 'terminal proof received; exactly one new revision is allowed' })
            .then(function () { return null; });
    }

    function markVerificationPending(trade, role, record, status, info) {
        var entry = attemptEntryAt(record.clientOrderId);
        entry.role = role;
        entry.state = 'VERIFICATION_PENDING';
        entry.accepted = entry.accepted !== false;
        entry.firstPendingAt = entry.firstPendingAt || Date.now();
        protectionAttempts[record.clientOrderId] = entry;
        record.status = status || 'VERIFICATION_PENDING';
        record.verified = false;
        record.unresolved = true;
        record.unresolvedSince = record.unresolvedSince || entry.firstPendingAt;
        record.verifyError = info || record.verifyError;
        persistTradeSoft(trade, 'VERIFY_PENDING');
        return record;
    }

    /** Is there an accepted-but-unresolved protection attempt for this role? */
    function unresolvedProtectionAttempt(trade, role) {
        var record = protectionRecord(trade, role);
        var id = record && record.clientOrderId;
        if (!id) return null;
        var entry = protectionAttempts[id];
        if (!entry) return null;
        entry = attemptEntryAt(id);
        if (entry.state === 'TERMINAL') return null;
        if (record.verified === true && isOpen(record)) return null;
        return { record: record, entry: entry };
    }

    /**
     * A.3: once a POST returned an algoId, that algoId is the AUTHORITATIVE identity of
     * the accepted order. Query it first, fall back to the clientAlgoId only while the
     * algoId is still unknown (e.g. right after restart from older state).
     */
    function queryProtectionByExactIds(record) {
        if (record.algoId !== null && record.algoId !== undefined) {
            return client.queryAlgoOrder(symbol, record.algoId, null).catch(function (error) {
                return client.queryAlgoOrder(symbol, null, record.clientOrderId).catch(function () {
                    throw error;
                });
            });
        }
        return client.queryAlgoOrder(symbol, null, record.clientOrderId);
    }

    /**
     * A.3: only an answer that identifies THIS accepted order may be judged. When the
     * algoId is known, a clientAlgoId match alone is not enough: a stale client id may
     * still resolve to an OLD terminal order of a previous lifecycle.
     */
    function answerIdentifiesRecord(state, record) {
        if (!state) return false;
        var answeredAlgoId = state.algoId;
        var answeredClientId = state.clientAlgoId || state.clientOrderId || state.newClientOrderId || null;
        if (record.algoId !== null && record.algoId !== undefined) {
            if (answeredAlgoId !== undefined && answeredAlgoId !== null) {
                // authoritative: the exchange-reported algoId must be OUR accepted order
                return String(answeredAlgoId) === String(record.algoId);
            }
            // the answer carries no algoId: fall back to the exact client id
            return Boolean(answeredClientId) && answeredClientId === record.clientOrderId;
        }
        return Boolean(answeredClientId) && answeredClientId === record.clientOrderId;
    }

    /** Exchange-truth verification of one stored protection record. */
    function verifyProtectionRecord(trade, role) {
        var record = protectionRecord(trade, role);
        if (!record || !record.clientOrderId) return Promise.resolve(null);
        if (record.verified === true && isOpen(record)) return Promise.resolve(record);
        record.verifyAttempts = (record.verifyAttempts || 0) + 1;
        return queryProtectionByExactIds(record)
            .then(function (state) {
                // §7 + A.3: only an answer that identifies THIS accepted order counts.
                var identityMatches = answerIdentifiesRecord(state, record);
                if (!identityMatches) {
                    markVerificationPending(trade, role, record, 'VERIFICATION_PENDING', null);
                    return emit('PROTECTION_VERIFY_PENDING', trade, { role: role,
                        clientAlgoId: record.clientOrderId, status: record.status,
                        verifyAttempts: record.verifyAttempts,
                        detail: 'exchange answer did not identify this exact order; stays locked' })
                        .then(function () { return record; });
                }
                var status = statusOf(state);
                if (isOpen({ status: status })) {
                    record.status = status;
                    record.algoId = (state && state.algoId !== undefined) ? state.algoId : record.algoId;
                    record.verified = true;
                    record.unresolved = false;
                    record.verifyError = null;
                    var entry = attemptEntryAt(record.clientOrderId);
                    entry.role = role;
                    entry.state = 'ACTIVE';
                    entry.accepted = entry.accepted !== false;
                    entry.activeAt = entry.activeAt || Date.now();
                    protectionAttempts[record.clientOrderId] = entry;
                    persistTradeSoft(trade, 'VERIFY_RECORD');
                    return emit('PROTECTION_VERIFIED', trade, { role: role,
                        clientAlgoId: record.clientOrderId, algoId: record.algoId || null,
                        status: record.status, source: 'QUERY_EXACT_ID' }).then(function () {
                        // §2: one verified leg is NOT enough - only BOTH legs on a live
                        // position may clear a protection halt.
                        clearProtectionHaltIfFullyProtected(trade);
                        return record;
                    });
                }
                if (isTerminalStatus(status)) {
                    return markProtectionTerminal(trade, role, record, status,
                        { code: null, msg: null }, 'QUERY_EXACT_ID');
                }
                // Inconclusive answer (empty / unknown status): stay pending.
                markVerificationPending(trade, role, record, status, null);
                return emit('PROTECTION_VERIFY_PENDING', trade, { role: role,
                    clientAlgoId: record.clientOrderId, status: record.status,
                    verifyAttempts: record.verifyAttempts,
                    detail: 'inconclusive exchange answer; the accepted id stays locked' })
                    .then(function () { return record; });
            })
            .catch(function (error) {
                var info = exchangeErrorInfo(error);
                // -2013 / not found / visibility failure / network error are NOT
                // terminal proof: the id stays locked, no revision is released and no
                // new POST is allowed.
                if (!record.verifyError || info.code === -2013) record.verifyError = info;
                markVerificationPending(trade, role, record, 'VERIFICATION_PENDING', info);
                return emit('PROTECTION_VERIFY_FAILED', trade, { role: role, phase: 'VERIFY_NEW',
                    clientAlgoId: record.clientOrderId, algoId: record.algoId || null,
                    reasonCode: (error && error.code) || 'VERIFY_FAILED',
                    exchangeCode: info.code, exchangeMessage: info.msg, httpStatus: info.status,
                    verifyAttempts: record.verifyAttempts,
                    detail: 'not terminal proof: the accepted id stays locked, no re-submit' })
                    .then(function () { return record; });
            });
    }

    /** Every id that provably belongs to this trade (exact-match adoption only). */
    function protectionIdentityCandidates(trade) {
        var out = [];
        function push(role, clientAlgoId, algoId) {
            if (!clientAlgoId && !algoId) return;
            var duplicate = out.some(function (c) {
                return (clientAlgoId && c.clientAlgoId === clientAlgoId) ||
                    (!clientAlgoId && algoId && String(c.algoId) === String(algoId));
            });
            if (!duplicate) out.push({ role: role, clientAlgoId: clientAlgoId || null, algoId: algoId || null });
        }
        ['SL', 'TP'].forEach(function (role) {
            var record = protectionRecord(trade, role);
            if (record) push(role, record.clientOrderId, record.algoId);
            push(role, expectedProtectionClientId(trade, role), null);
        });
        (trade.abandonedProtections || []).forEach(function (item) {
            push(item.role, item.clientAlgoId, item.algoId);
        });
        return out;
    }

    /** §6/§7: adopt an EXACT exchange-side protection instead of re-submitting. */
    function adoptExistingProtection(trade, openAlgos) {
        var adopted = [];
        protectionIdentityCandidates(trade).forEach(function (candidate) {
            var current = protectionRecord(trade, candidate.role);
            if (current && isOpen(current)) return;
            var match = (openAlgos || []).filter(function (order) {
                if (!order || !order.clientAlgoId) return false;
                if (candidate.clientAlgoId) return order.clientAlgoId === candidate.clientAlgoId;
                return candidate.algoId !== null && order.algoId !== undefined &&
                    String(order.algoId) === String(candidate.algoId);
            })[0];
            if (!match) return;
            // A terminal order is never adopted: only a live protection may be taken
            // over from the exchange.
            if (!isOpen({ status: statusOf(match) })) return;
            var record = { role: candidate.role, clientOrderId: match.clientAlgoId,
                algoId: match.algoId !== undefined ? match.algoId : null,
                expectedClientAlgoId: candidate.clientAlgoId || match.clientAlgoId,
                status: statusOf(match) || 'NEW', price: Number(match.triggerPrice),
                placedAt: Date.now(), verified: true, verifyAttempts: 0, verifyError: null,
                unresolved: false, adoptedFromExchange: true,
                createdAt: Date.now(), updatedAt: Date.now() };
            setProtectionRecord(trade, candidate.role, record);
            var entry = attemptEntryAt(match.clientAlgoId);
            entry.role = candidate.role;
            entry.state = 'ACTIVE';
            entry.accepted = entry.accepted !== false;
            entry.adopted = true;
            protectionAttempts[match.clientAlgoId] = entry;
            persistTradeSoft(trade, 'ADOPT_EXISTING');
            adopted.push(record);
            emit('PROTECTION_ADOPTED_FROM_EXCHANGE', trade, { role: candidate.role,
                algoId: record.algoId, clientAlgoId: record.clientOrderId, status: record.status,
                triggerPrice: record.price });
        });
        if (adopted.length > 0) clearProtectionHaltIfFullyProtected(trade);
        return adopted;
    }

    function cancelOldProtection(trade, role, record, previous) {
        var oldId = orderId(previous);
        if (!oldId || oldId === record.clientOrderId) {
            return Promise.resolve({ placed: record.clientOrderId, canceledOld: null });
        }
        return client.cancelAlgo(symbol, oldId).then(function () {
            emit('PROTECTION_OLD_CANCELED', trade, { role: role, oldClientAlgoId: oldId,
                clientAlgoId: record.clientOrderId });
            return { placed: record.clientOrderId, canceledOld: oldId };
        });
    }

    // ==========================================================================
    // PRODUCTION BRIDGE REPLACEMENT  (§1 - §12)
    // ==========================================================================
    //
    // Moving a canonical protection is ONLY allowed through this lifecycle:
    //
    //   fresh positionQty -> verify old canonical ACTIVE -> place reduceOnly bridge
    //   -> verify bridge ACTIVE -> cancel old ONCE -> read-only wait old terminal
    //   -> fresh position truth -> place new closePosition canonical
    //   -> verify new ACTIVE -> cancel bridge ONCE -> wait bridge terminal -> COMPLETE
    //
    // The retired "place the new closePosition canonical first, then cancel the old
    // one" sequence can never come back: the real exchange refuses a second same-role
    // closePosition order with -4130 ("open stop or take profit ... is existing").
    //
    // The phase is persisted on the trade, so a restart resumes from the exchange
    // truth of whatever phase it stopped in - read-only first, never a blind re-post
    // and never a second DELETE.

    var REPLACEMENT_DEADLINE_MS = PROTECTION_UNVERIFIED_AFTER_MS;   // frozen 5s window
    // After a SAFE abort (FAILED_SAFE / FLAT_ABORT) the role must not immediately start a
    // new replacement on the same trigger: the same dynamic candidate would otherwise
    // re-fire inside the same reconcile pass.
    var REPLACEMENT_SAFE_HOLD_MS = PROTECTION_UNVERIFIED_AFTER_MS;
    var REPLACEMENT_FINAL_PHASES = ['COMPLETE', 'FAILED_SAFE', 'FLAT_ABORT'];

    function replacementFor(trade, role) {
        return (trade && trade.replacements && trade.replacements[role]) || null;
    }
    function persistReplacement(trade, role, state) {
        trade.replacements = trade.replacements || { SL: null, TP: null };
        if (state) state.updatedAt = Date.now();
        trade.replacements[role] = state;
        saveTrade(trade);
        return state;
    }
    function finishReplacement(trade, role, phase, reasonCode) {
        var st = replacementFor(trade, role);
        if (!st) return null;
        st.phase = phase;
        st.reasonCode = reasonCode || null;
        st.finishedAt = Date.now();
        trade.lastReplacement = { role: role, phase: phase, reasonCode: st.reasonCode,
            oldCanonicalId: st.oldCanonicalId || null,
            bridgeClientAlgoId: st.bridgeClientAlgoId || null,
            newCanonicalId: st.newCanonicalId || null, finishedAt: st.finishedAt };
        if (phase !== 'COMPLETE') {
            trade.replacementHold = trade.replacementHold || {};
            trade.replacementHold[role] = { reason: st.reasonCode || phase,
                until: Date.now() + REPLACEMENT_SAFE_HOLD_MS, at: Date.now() };
        }
        persistReplacement(trade, role, null);
        return st;
    }
    /** §9: a safely aborted replacement keeps the role out of a new one for one window. */
    function replacementHoldActive(trade, role) {
        var hold = (trade.replacementHold || {})[role];
        return Boolean(hold && hold.until > Date.now()) ? hold : null;
    }
    /** §2 SINGLE OWNER: while this role has a replacement in flight, nothing else may
     *  create a canonical protection for it. */
    function replacementOwnsRole(trade, role) {
        return replacementFor(trade, role) !== null;
    }

    /** §7 DELETE ledger (persisted): one DELETE per exact id, then read-only forever. */
    function deleteLedger(trade) {
        trade.protectionDeletes = trade.protectionDeletes || {};
        return trade.protectionDeletes;
    }
    function deleteAttemptsFor(trade, clientAlgoId) {
        var entry = deleteLedger(trade)[clientAlgoId];
        return (entry && entry.attempts) || 0;
    }
    function noteDeleteAttempt(trade, clientAlgoId) {
        var ledger = deleteLedger(trade);
        var entry = ledger[clientAlgoId] || { attempts: 0 };
        entry.attempts += 1;
        entry.lastAttemptAt = Date.now();
        ledger[clientAlgoId] = entry;
        saveTrade(trade);
        return entry;
    }
    function noteDeleteAccepted(trade, clientAlgoId) {
        var entry = deleteLedger(trade)[clientAlgoId];
        if (entry) { entry.acceptedAt = entry.acceptedAt || Date.now(); saveTrade(trade); }
        return entry;
    }

    /** Read-only exact-id state, with -2013 normalized to NOT_FOUND. */
    function queryOrderState(clientAlgoId, algoId) {
        return queryProtectionByExactIds({ algoId: algoId === undefined ? null : algoId,
            clientOrderId: clientAlgoId }).catch(function (error) {
            var info = exchangeErrorInfo(error);
            if (info.code === -2013) {
                return { clientAlgoId: clientAlgoId, algoId: null, algoStatus: 'NOT_FOUND' };
            }
            throw error;
        });
    }
    /** §7: DELETE at most once per exact id; afterwards this is a pure read. */
    function cancelExactlyOnce(trade, clientAlgoId) {
        if (deleteAttemptsFor(trade, clientAlgoId) > 0) {
            return queryOrderState(clientAlgoId, null).then(function (stateNow) {
                return { attempted: false, queryOnly: true, state: stateNow };
            }, function () { return { attempted: false, queryOnly: true, state: null }; });
        }
        noteDeleteAttempt(trade, clientAlgoId);
        return client.cancelAlgo(symbol, clientAlgoId).then(function () {
            noteDeleteAccepted(trade, clientAlgoId);
            return { attempted: true, accepted: true };
        }, function (error) {
            var info = exchangeErrorInfo(error);
            if (info.code === -2011 || info.code === -2013) {
                return { attempted: true, accepted: false, alreadyTerminal: true, info: info };
            }
            // unknown outcome: never a second DELETE - the phase poll resolves it
            return { attempted: true, accepted: false, uncertain: true, info: info };
        });
    }
    function bridgeClientAlgoIdFor(trade, role, revision) {
        return clientModule.clientId(symbol,
            trade.tradeId + ':' + role + ':BRIDGE:' + revision, role + '_BRIDGE');
    }
    function isOrderActive(state) { return isOpen({ status: statusOf(state) }); }
    function terminalProofOf(state) {
        var status = statusOf(state);
        if (status === 'NOT_FOUND') return 'ABSENT';
        return isTerminalStatus(status) ? status : null;
    }

    /**
     * Place the NEW canonical closePosition protection (the only non-bridge placement
     * left for a role that needs a protection). Returns the committed record.
     */
    function placeCanonicalProtection(trade, role, price) {
        var revision = protectionRevision(trade, role);
        var expectedId = expectedProtectionClientId(trade, role, revision);
        var known = protectionAttempts[expectedId];
        if (known && (known.state ? known.state !== 'TERMINAL' : true)) {
            return emit('SKIP_DUPLICATE_PROTECTION_SUBMIT', trade, { role: role,
                clientAlgoId: expectedId,
                detail: 'expected id already used (' + (known.state || known) + ')' })
                .then(function () { return { placed: null, skipped: true, clientAlgoId: expectedId,
                    reasonCode: 'SKIP_DUPLICATE_PROTECTION_SUBMIT' }; });
        }
        if (placementCount(trade, role) >= MAX_PROTECTION_PLACEMENTS_PER_ROLE) {
            return emit('PROTECTION_PLACEMENT_LIMIT_REACHED', trade, { critical: true, role: role,
                detail: 'placements=' + placementCount(trade, role) })
                .then(function () { return halt('PROTECTION_REPLACEMENT_FAILED', trade); })
                .then(function () { return { placed: null, reasonCode: 'PROTECTION_PLACEMENT_LIMIT_REACHED' }; });
        }
        var planForPlacement = Object.assign({}, trade.plan,
            { tradeId: trade.tradeId + ':' + role + ':' + revision });
        if (role === 'SL') planForPlacement.stopPrice = price; else planForPlacement.targetPrice = price;
        var previousRecord = protectionRecord(trade, role);
        protectionAttempts[expectedId] = { role: role, state: 'PLACING', accepted: null,
            placingAt: Date.now() };
        notePlacement(trade, role);
        return client.submitProtection(planForPlacement, role).then(function (response) {
            var entry = attemptEntryAt(expectedId);
            entry.role = role;
            entry.state = 'PLACED';
            entry.accepted = true;
            entry.acceptedAt = Date.now();
            protectionAttempts[expectedId] = entry;
            return commitAcceptedPlacement(trade, role, price, expectedId, response);
        }).then(function (record) {
            return verifyProtectionRecord(trade, role).then(function (verified) {
                if (verified && verified.verified === true) {
                    return { placed: record.clientOrderId, verified: true, record: record };
                }
                return emit('PROTECTION_VERIFICATION_PENDING', trade, { role: role,
                    phase: 'VERIFY_NEW', clientAlgoId: record.clientOrderId, algoId: record.algoId,
                    exchangeCode: (record.verifyError || {}).code || null,
                    exchangeMessage: (record.verifyError || {}).msg || null,
                    detail: 'placement kept; verification will be retried by reconcile' })
                    .then(function () {
                        return { placed: record.clientOrderId, verified: false, record: record };
                    });
            });
        }).catch(function (error) {
            var info = exchangeErrorInfo(error);
            var acceptanceUnknown = uncertainPlacement(error);
            var entry = attemptEntryAt(expectedId);
            entry.role = role;
            // A local refusal / explicit exchange rejection is NOT an accepted
            // placement; an unknown network result must never be blind-retried.
            entry.state = acceptanceUnknown ? 'PLACEMENT_UNKNOWN'
                : (isRejectedByExchange(info) ? 'TERMINAL' : 'FAILED_BEFORE_ACCEPTANCE');
            entry.accepted = acceptanceUnknown ? null : false;
            entry.terminalStatus = isRejectedByExchange(info) ? 'REJECTED' : null;
            if (acceptanceUnknown) entry.placementUnknownAt = Date.now();
            protectionAttempts[expectedId] = entry;
            if (acceptanceUnknown && !(previousRecord && isOpen(previousRecord))) {
                // Keep an existing open protection untouched; otherwise commit the
                // expected identity so reconcile can adopt it by exact id. Either way
                // the role stays locked and no later reconcile may blind-retry.
                setProtectionRecord(trade, role, {
                    role: role, clientOrderId: expectedId, algoId: null,
                    expectedClientAlgoId: expectedId, status: 'PLACEMENT_UNKNOWN',
                    price: price, placedAt: Date.now(), verified: false,
                    unverifiedAcceptance: true, unresolved: true,
                    unresolvedSince: Date.now(), verifyAttempts: 0, verifyError: info,
                    createdAt: Date.now(), updatedAt: Date.now() });
                persistTradeSoft(trade, 'PLACEMENT_UNKNOWN');
            }
            return emit('PROTECTION_REPLACE_FAILED', trade, { critical: true, role: role,
                phase: 'PLACE_NEW', symbol: symbol, clientAlgoId: expectedId, algoId: null,
                reasonCode: (error && error.code) || 'PROTECTION_REPLACE_FAILED',
                exchangeCode: info.code, exchangeMessage: info.msg, httpStatus: info.status,
                placementUnknown: acceptanceUnknown,
                detail: (error && error.message) || null })
                .then(function () {
                    if (acceptanceUnknown) {
                        return emit('PROTECTION_PLACEMENT_UNKNOWN', trade, { critical: true, role: role,
                            clientAlgoId: expectedId,
                            detail: 'POST acceptance unknown; query/adopt by exact id only - never blind retry' })
                            .then(function () { return halt('PROTECTION_PLACEMENT_UNKNOWN', trade); });
                    }
                    return halt('PROTECTION_REPLACEMENT_FAILED', trade);
                })
                .then(function () {
                    return { placed: null, keptOld: true, reasonCode: 'PLACE_REJECTED',
                        placementUnknown: acceptanceUnknown,
                        errorCode: (error && error.code) || null };
                });
        });
    }

    /**
     * One resumable step of the bridge replacement. Returns the (possibly advanced)
     * state; the caller loops while the phase keeps changing.
     */
    async function advanceReplacement(trade, role, ctx) {
        var st = replacementFor(trade, role);
        if (!st) return null;
        if (REPLACEMENT_FINAL_PHASES.indexOf(st.phase) >= 0) return st;
        // §9 fresh position truth at EVERY phase: the quantity passed in by the caller
        // may already be stale by the time the next step runs.
        var positionQty = null;
        try {
            var livePositions = await client.getPositionRisk(symbol);
            positionQty = Math.abs(num(((Array.isArray(livePositions) ? livePositions[0]
                : livePositions) || {}).positionAmt));
        } catch (error) {
            positionQty = Math.abs(num(ctx && ctx.positionQty));
        }
        if (!Number.isFinite(positionQty)) positionQty = Math.abs(num(ctx && ctx.positionQty));

        // ---------------------------------------------------- §9 position race
        if (positionQty === 0) {
            await emit('PROTECTION_REPLACEMENT_FLAT_ABORT', trade, { critical: true, role: role,
                phase: st.phase, bridgeClientAlgoId: st.bridgeClientAlgoId || null,
                detail: 'position is flat - no further placement, cleanup only (no emergencyClose)' });
            return finishReplacement(trade, role, 'FLAT_ABORT', 'POSITION_FLAT_DURING_REPLACEMENT');
        }
        if (st.freshPositionQty !== null && st.freshPositionQty !== undefined &&
                positionQty !== st.freshPositionQty) {
            await emit('PROTECTION_REPLACEMENT_POSITION_CHANGED', trade, { critical: true, role: role,
                phase: st.phase, expectedQty: st.freshPositionQty, actualQty: positionQty,
                detail: 'the replacement quantity is stale - stop, never reuse the old qty' });
            await halt('PROTECTION_REPLACEMENT_FAILED', trade);
            return finishReplacement(trade, role, 'FAILED_SAFE', 'POSITION_CHANGED_DURING_REPLACEMENT');
        }
        function expire(phase) {
            if (Date.now() - (st.phaseStartedAt || st.startedAt) < REPLACEMENT_DEADLINE_MS) return false;
            st.phase = phase;
            return true;
        }

        // ------------------------------------------------- STEP 1/2/3: bridge
        if (st.phase === 'BRIDGE_PLACE_PENDING') {
            var expectedBridgeId = bridgeClientAlgoIdFor(trade, role, st.revision);
            st.bridgeClientAlgoId = expectedBridgeId;
            st.bridgeTrigger = st.desiredTrigger;
            st.bridgeQuantity = positionQty;
            // single owner: adopt an exact identity that already exists
            var existing = await queryOrderState(expectedBridgeId, null)
                .catch(function () { return null; });
            if (existing && isOrderActive(existing)) {
                st.bridgeAlgoId = existing.algoId === undefined ? null : existing.algoId;
                st.bridgeAccepted = true;
                st.bridgeAcceptedAt = Date.now();
                st.phase = 'BRIDGE_VERIFICATION_PENDING';
                st.phaseStartedAt = Date.now();
                return persistReplacement(trade, role, st);
            }
            st.bridgeAttemptedAt = Date.now();
            var placed = await client.submitBridgeProtection(
                Object.assign({}, trade.plan,
                    { tradeId: trade.tradeId + ':' + role + ':BRIDGE:' + st.revision }),
                role, positionQty, st.desiredTrigger)
                .then(function (response) { return { ok: true, response: response }; },
                    function (error) { return { ok: false, error: error }; });
            if (placed.ok) {
                st.bridgeAccepted = true;
                st.bridgeAcceptedAt = Date.now();
                st.bridgeAlgoId = placed.response && placed.response.algoId !== undefined
                    ? placed.response.algoId : null;
                st.phase = 'BRIDGE_VERIFICATION_PENDING';
                st.phaseStartedAt = Date.now();
                persistReplacement(trade, role, st);
                await emit('PROTECTION_BRIDGE_PLACED', trade, { role: role,
                    clientAlgoId: st.bridgeClientAlgoId, algoId: st.bridgeAlgoId,
                    triggerPrice: st.bridgeTrigger, quantity: st.bridgeQuantity,
                    closePosition: false, reduceOnly: true });
                return st;
            }
            var info = exchangeErrorInfo(placed.error);
            st.exchangeCode = info.code;
            st.exchangeMessage = info.msg;
            var afterUnknown = await queryOrderState(expectedBridgeId, null)
                .catch(function () { return null; });
            if (afterUnknown && isOrderActive(afterUnknown)) {
                st.bridgeAccepted = true;
                st.bridgeAcceptedAt = Date.now();
                st.bridgeAlgoId = afterUnknown.algoId === undefined ? null : afterUnknown.algoId;
                st.phase = 'BRIDGE_VERIFICATION_PENDING';
                st.phaseStartedAt = Date.now();
                return persistReplacement(trade, role, st);
            }
            st.phase = 'FAILED_SAFE';
            st.reasonCode = isRejectedByExchange(info) ? 'BRIDGE_POST_REJECTED'
                : 'BRIDGE_POST_UNKNOWN';
            await emit('PROTECTION_BRIDGE_REJECTED', trade, { critical: true, role: role,
                clientAlgoId: expectedBridgeId, exchangeCode: info.code, exchangeMessage: info.msg,
                detail: 'the old canonical protection is untouched' });
            await halt('PROTECTION_REPLACEMENT_FAILED', trade);
            return finishReplacement(trade, role, 'FAILED_SAFE', st.reasonCode);
        }

        // ------------------------------------------- STEP 4: bridge ACTIVE proof
        if (st.phase === 'BRIDGE_VERIFICATION_PENDING') {
            var bridgeState = await queryOrderState(st.bridgeClientAlgoId, st.bridgeAlgoId)
                .catch(function () { return null; });
            if (bridgeState && isOrderActive(bridgeState)) {
                st.bridgeVerifiedActive = true;
                st.bridgeVerifiedAt = Date.now();
                if (bridgeState.algoId !== undefined && bridgeState.algoId !== null) {
                    st.bridgeAlgoId = bridgeState.algoId;
                }
                // the role is now protected by the BRIDGE: keep the trade view live so
                // nothing else decides this role is unprotected (§2 single owner)
                setProtectionRecord(trade, role, { role: role,
                    clientOrderId: st.bridgeClientAlgoId, algoId: st.bridgeAlgoId,
                    expectedClientAlgoId: st.bridgeClientAlgoId, status: statusOf(bridgeState),
                    price: st.bridgeTrigger, bridge: true, verified: true,
                    placedAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
                st.phase = 'BRIDGE_ACTIVE';
                st.phaseStartedAt = Date.now();
                persistReplacement(trade, role, st);
                await emit('PROTECTION_BRIDGE_VERIFIED_ACTIVE', trade, { role: role,
                    clientAlgoId: st.bridgeClientAlgoId, algoId: st.bridgeAlgoId });
                return st;
            }
            if (expire('FAILED_SAFE')) {
                await emit('PROTECTION_BRIDGE_UNVERIFIED', trade, { critical: true, role: role,
                    clientAlgoId: st.bridgeClientAlgoId,
                    detail: 'bridge was never confirmed ACTIVE inside the window' });
                await halt('PROTECTION_REPLACEMENT_FAILED', trade);
                return finishReplacement(trade, role, 'FAILED_SAFE', 'BRIDGE_NOT_VERIFIED_ACTIVE');
            }
            return st;
        }

        // ------------------------------------ STEP 5/6: cancel + wait old terminal
        if (st.phase === 'BRIDGE_ACTIVE') {
            var cancelOld = await cancelExactlyOnce(trade, st.oldCanonicalId);
            st.oldCancelAttempts = deleteAttemptsFor(trade, st.oldCanonicalId);
            st.oldCancelAttemptedAt = Date.now();
            st.oldCancelAccepted = cancelOld.accepted === true;
            st.phase = 'OLD_CANCEL_PENDING';
            st.phaseStartedAt = Date.now();
            persistReplacement(trade, role, st);
            await emit('PROTECTION_OLD_CANONICAL_CANCELED', trade, { role: role,
                clientAlgoId: st.oldCanonicalId, deleteAttempts: st.oldCancelAttempts,
                accepted: st.oldCancelAccepted, queryOnly: cancelOld.queryOnly === true });
            return st;
        }
        if (st.phase === 'OLD_CANCEL_PENDING') {
            var oldState = await queryOrderState(st.oldCanonicalId, st.oldCanonicalAlgoId)
                .catch(function () { return null; });
            var oldProof = oldState ? terminalProofOf(oldState) : null;
            if (oldProof) {
                st.oldTerminalVerifiedAt = Date.now();
                st.oldTerminalProof = oldProof;
                if (oldProof === 'FILLED' || oldProof === 'TRIGGERED') {
                    // the old stop FIRED: the position truth decides if we may continue
                    st.oldFilled = true;
                }
                st.phase = 'OLD_TERMINAL';
                st.phaseStartedAt = Date.now();
                persistReplacement(trade, role, st);
                return st;
            }
            if (expire('FAILED_SAFE')) {
                await emit('PROTECTION_OLD_CANONICAL_NOT_TERMINAL', trade, { critical: true,
                    role: role, clientAlgoId: st.oldCanonicalId,
                    detail: 'the old canonical never proved terminal inside the window; the ' +
                        'bridge is still ACTIVE and is kept' });
                await halt('PROTECTION_REPLACEMENT_FAILED', trade);
                return finishReplacement(trade, role, 'FAILED_SAFE', 'OLD_CANONICAL_TERMINAL_TIMEOUT');
            }
            return st;
        }

        // -------------------------------- STEP 7/8: new canonical + ACTIVE proof
        if (st.phase === 'OLD_TERMINAL') {
            var newId = expectedProtectionClientId(trade, role, protectionRevision(trade, role));
            st.newCanonicalId = newId;
            st.newCanonicalTrigger = st.desiredTrigger;
            st.phase = 'NEW_CANONICAL_PLACE_PENDING';
            st.phaseStartedAt = Date.now();
            persistReplacement(trade, role, st);
            return st;
        }
        if (st.phase === 'NEW_CANONICAL_PLACE_PENDING') {
            var placedNew = await placeCanonicalProtection(trade, role, st.desiredTrigger);
            st.newCanonicalClientAlgoId = placedNew && placedNew.placed !== undefined
                ? placedNew.placed : st.newCanonicalId;
            st.newCanonicalPlaced = Boolean(placedNew && placedNew.placed);
            st.newCanonicalReason = (placedNew && placedNew.reasonCode) || null;
            st.phase = st.newCanonicalPlaced ? 'NEW_CANONICAL_VERIFICATION_PENDING'
                : 'FAILED_SAFE';
            st.phaseStartedAt = Date.now();
            persistReplacement(trade, role, st);
            if (!st.newCanonicalPlaced) {
                // the bridge is still ACTIVE, so the position never lost protection
                st.reasonCode = st.newCanonicalReason || 'NEW_CANONICAL_PLACE_FAILED';
                await emit('PROTECTION_NEW_CANONICAL_FAILED', trade, { critical: true, role: role,
                    clientAlgoId: st.newCanonicalClientAlgoId,
                    detail: 'bridge kept ACTIVE; no second placement attempt' });
                await halt('PROTECTION_REPLACEMENT_FAILED', trade);
                return finishReplacement(trade, role, 'FAILED_SAFE', st.reasonCode);
            }
            return st;
        }
        if (st.phase === 'NEW_CANONICAL_VERIFICATION_PENDING') {
            var newState = await queryOrderState(st.newCanonicalClientAlgoId, null)
                .catch(function () { return null; });
            if (newState && isOrderActive(newState)) {
                st.newCanonicalVerifiedActive = true;
                st.newCanonicalVerifiedAt = Date.now();
                st.newCanonicalAlgoId = newState.algoId === undefined ? null : newState.algoId;
                // the trade now points at the verified new canonical
                if (st.newCanonicalAlgoId !== null) {
                    attemptEntryAt(st.newCanonicalClientAlgoId).algoId = st.newCanonicalAlgoId;
                }
                st.phase = 'NEW_CANONICAL_ACTIVE';
                st.phaseStartedAt = Date.now();
                persistReplacement(trade, role, st);
                await emit('PROTECTION_NEW_CANONICAL_VERIFIED_ACTIVE', trade, { role: role,
                    clientAlgoId: st.newCanonicalClientAlgoId, algoId: st.newCanonicalAlgoId });
                return st;
            }
            if (expire('FAILED_SAFE')) {
                await emit('PROTECTION_NEW_CANONICAL_UNVERIFIED', trade, { critical: true,
                    role: role, clientAlgoId: st.newCanonicalClientAlgoId,
                    detail: 'accepted POST never proved ACTIVE; the bridge is still ACTIVE' });
                await halt('PROTECTION_REPLACEMENT_FAILED', trade);
                return finishReplacement(trade, role, 'FAILED_SAFE', 'NEW_CANONICAL_VERIFY_TIMEOUT');
            }
            return st;
        }

        // --------------------------------- STEP 9/10: cancel bridge, wait terminal
        if (st.phase === 'NEW_CANONICAL_ACTIVE') {
            var cancelBridge = await cancelExactlyOnce(trade, st.bridgeClientAlgoId);
            st.bridgeCancelAttempts = deleteAttemptsFor(trade, st.bridgeClientAlgoId);
            st.bridgeCancelAttemptedAt = Date.now();
            st.bridgeCancelAccepted = cancelBridge.accepted === true;
            st.phase = 'BRIDGE_CANCEL_PENDING';
            st.phaseStartedAt = Date.now();
            persistReplacement(trade, role, st);
            await emit('PROTECTION_BRIDGE_CANCELED', trade, { role: role,
                clientAlgoId: st.bridgeClientAlgoId, deleteAttempts: st.bridgeCancelAttempts,
                accepted: st.bridgeCancelAccepted, queryOnly: cancelBridge.queryOnly === true });
            return st;
        }
        if (st.phase === 'BRIDGE_CANCEL_PENDING') {
            var bridgeAfter = await queryOrderState(st.bridgeClientAlgoId, st.bridgeAlgoId)
                .catch(function () { return null; });
            var bridgeProof = bridgeAfter ? terminalProofOf(bridgeAfter) : null;
            if (bridgeProof) {
                st.bridgeTerminalVerifiedAt = Date.now();
                st.bridgeTerminalProof = bridgeProof;
                await emit('PROTECTION_REPLACEMENT_COMPLETE', trade, { role: role,
                    clientAlgoId: st.newCanonicalClientAlgoId, newTrigger: st.newCanonicalTrigger,
                    oldCanonicalId: st.oldCanonicalId, bridgeClientAlgoId: st.bridgeClientAlgoId });
                return finishReplacement(trade, role, 'COMPLETE', null);
            }
            if (expire('FAILED_SAFE')) {
                await emit('PROTECTION_BRIDGE_CANCEL_TIMEOUT', trade, { critical: true, role: role,
                    clientAlgoId: st.bridgeClientAlgoId,
                    detail: 'bridge cancel never converged; the NEW canonical is ACTIVE and is kept' });
                await halt('PROTECTION_REPLACEMENT_FAILED', trade);
                return finishReplacement(trade, role, 'FAILED_SAFE', 'BRIDGE_CANCEL_TERMINAL_TIMEOUT');
            }
            return st;
        }
        return st;
    }

    /**
     * Drive one role's replacement to its next stable point (bounded), then return the
     * terminal record. Called by the dynamic path, by every reconcile and by recovery.
     */
    function runReplacement(trade, role, ctx) {
        var steps = 0;
        function loop() {
            var st = replacementFor(trade, role);
            if (!st || REPLACEMENT_FINAL_PHASES.indexOf(st.phase) >= 0) return Promise.resolve(st);
            if (steps >= 12) return Promise.resolve(st);      // wait for the next pass
            steps += 1;
            var phaseBefore = st.phase;
            return advanceReplacement(trade, role, ctx).then(function () {
                var now = replacementFor(trade, role);
                if (!now || REPLACEMENT_FINAL_PHASES.indexOf(now.phase) >= 0) return now;
                if (now.phase === phaseBefore) return now;     // waiting on the exchange
                return loop();
            });
        }
        return loop();
    }

    /** §10 restart safety: keep every in-flight replacement moving. */
    function advanceInFlightReplacements(trade, ctx) {
        return ['SL', 'TP'].reduce(function (chain, role) {
            return chain.then(function () {
                if (!replacementFor(trade, role)) return null;
                return runReplacement(trade, role, ctx);
            });
        }, Promise.resolve());
    }

    function startBridgeReplacement(trade, role, desiredTrigger, previous) {
        trade.replacementRevisions = trade.replacementRevisions || { SL: 0, TP: 0 };
        trade.replacementRevisions[role] = (trade.replacementRevisions[role] || 0) + 1;
        var st = { role: role, phase: 'BRIDGE_PLACE_PENDING',
            revision: trade.replacementRevisions[role], desiredTrigger: desiredTrigger,
            freshPositionQty: Math.abs(num(trade.positionQty)),
            oldCanonicalId: orderId(previous), oldCanonicalAlgoId: (previous && previous.algoId) || null,
            oldCanonicalTrigger: previous && previous.price,
            bridgeClientAlgoId: null, bridgeAlgoId: null, bridgeAccepted: false,
            bridgeVerifiedActive: false, newCanonicalClientAlgoId: null, newCanonicalAlgoId: null,
            newCanonicalVerifiedActive: false,
            startedAt: Date.now(), phaseStartedAt: Date.now(), updatedAt: Date.now() };
        persistReplacement(trade, role, st);
        return st;
    }

    /** The retired new-protection-first path is gone; every MOVE goes through the
     *  bridge lifecycle decided by whether a live old canonical actually exists. */
    function replaceProtection(trade, role, price, options) {
        var op = options || {};
        if (halted && op.allowWhileHalted !== true) {
            return Promise.resolve({ placed: null, skipped: true, reasonCode: 'EXECUTION_HALT_ACTIVE' });
        }
        // §2 SINGLE OWNER: this role is already being moved by the bridge machine
        var inFlight = replacementFor(trade, role);
        if (inFlight) {
            return runReplacement(trade, role,
                { positionQty: trade.positionQty, markPrice: op.markPrice })
                .then(function (st) {
                    if (st && st.phase === 'COMPLETE') {
                        return { placed: st.newCanonicalClientAlgoId || st.newCanonicalId,
                            bridgeLifecycle: true, replacement: st };
                    }
                    return { placed: null, pending: true, replacement: st,
                        reasonCode: 'REPLACEMENT_IN_PROGRESS' };
                });
        }
        // ACCEPTED-POST LOCK: while this role has an accepted-but-unresolved order,
        // nothing may be placed for it. Only explicit terminal proof unlocks it.
        var unresolved = unresolvedProtectionAttempt(trade, role);
        if (unresolved) {
            emit('SKIP_DUPLICATE_PROTECTION_SUBMIT', trade, { role: role,
                clientAlgoId: unresolved.record.clientOrderId,
                detail: 'unresolved accepted placement (' + unresolved.entry.state + ')' });
            return Promise.resolve({ placed: null, skipped: true,
                clientAlgoId: unresolved.record.clientOrderId,
                reasonCode: 'SKIP_DUPLICATE_PROTECTION_SUBMIT', state: unresolved.entry.state });
        }
        var previous = protectionRecord(trade, role);
        if (!(previous && isOpen(previous))) {
            // Nothing live to move: this is a first/repair placement, not a replacement.
            return placeCanonicalProtection(trade, role, price).then(function (placedNew) {
                if (!placedNew || !placedNew.placed) return placedNew;
                return { placed: placedNew.placed, verificationPending: placedNew.verified !== true,
                    keptOld: false };
            });
        }
        var hold = replacementHoldActive(trade, role);
        if (hold) {
            emit('SKIP_REPLACEMENT_SAFE_HOLD', trade, { role: role, reasonCode: hold.reason,
                detail: 'the previous replacement ended safely; retry after ' + hold.until });
            return Promise.resolve({ placed: null, skipped: true, reasonCode: 'REPLACEMENT_SAFE_HOLD' });
        }
        // §4/§12: a live canonical exists -> the ONLY allowed move is the bridge lifecycle.
        startBridgeReplacement(trade, role, price, previous);
        return runReplacement(trade, role, { positionQty: trade.positionQty, markPrice: op.markPrice })
            .then(function (st) {
                if (st && st.phase === 'COMPLETE') {
                    return { placed: st.newCanonicalClientAlgoId || st.newCanonicalId,
                        bridgeLifecycle: true, replacement: st };
                }
                return { placed: null, pending: true, replacement: st || null,
                    reasonCode: (st && st.reasonCode) || 'REPLACEMENT_IN_PROGRESS' };
            });
    }

    /**
     * "Did the POST even reach the exchange?" - our own refusal and an explicit
     * exchange rejection are certain; timeouts / resets / 5xx are NOT.
     */
    function uncertainPlacement(error) {
        if (!error) return false;
        if (['LIVE_TRADING_DISABLED', 'BINANCE_CREDENTIALS_MISSING', 'MUTATION_GUARD_BLOCKED']
                .indexOf(error.code) >= 0) return false;
        var info = exchangeErrorInfo(error);
        if (isRejectedByExchange(info)) return false;
        if (error.code === 'ORDER_STATE_UNKNOWN') return true;
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                error.code === 'ECONNRESET' || error.code === 'EPIPE') return true;
        if (!error.response) return true;
        return info.status !== null && info.status >= 500;
    }

    function isRejectedByExchange(info) {
        if (!info || info.status === null || info.status === undefined) return false;
        if (info.status < 400 || info.status >= 500) return false;
        return true;   // an explicit 4xx from Binance = the request was answered
    }

    function ensureProtection(trade, qty, openAlgos) {
        // 1) exchange truth for anything already recorded (never re-places).
        //    Verification/adoption are READS: they must keep running even while the
        //    service is halted, because they are the only way out of a protection halt.
        return verifyProtectionRecord(trade, 'SL')
            .then(function () { return verifyProtectionRecord(trade, 'TP'); })
            .then(function () {
                // 2) adopt an EXACT exchange-side order instead of re-submitting
                adoptExistingProtection(trade, openAlgos);
                // 3) while halted, no placement of any kind
                if (halted) return null;
                // 3) place only what is genuinely missing
                if (isOpen(trade.slOrder)) return null;
                // §2 SINGLE OWNER: the bridge lifecycle owns this role right now
                if (replacementOwnsRole(trade, 'SL')) return null;
                return replaceProtection(trade, 'SL',
                    (trade.slOrder && trade.slOrder.price) || trade.plan.initialSL);
            })
            .then(function () {
                if (halted) return null;
                if (isOpen(trade.tpOrder)) return null;
                if (replacementOwnsRole(trade, 'TP')) return null;
                return replaceProtection(trade, 'TP',
                    (trade.tpOrder && trade.tpOrder.price) || trade.plan.initialTP);
            })
            .then(function () { return trade; });
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
    function protectOpenPosition(trade, position, markPrice, openAlgos) {
        var qty = Math.abs(num(trade.positionQty));
        // A stop that EXISTED and is now gone means the exchange showed real exposure
        // without protection (restart / dropped order). Repair it, but still raise the
        // fail-safe halt: new entries stay blocked while the manager protects.
        // A brand-new fill is NOT "lost protection" - that is the normal first pass.
        var lostProtection = Boolean(trade.slOrder) && !isOpen(trade.slOrder);
        // §10 RESTART/RECONCILE SAFETY: an in-flight replacement is resumed from the
        // persisted phase using exchange truth only (no blind re-post, no re-delete).
        return advanceInFlightReplacements(trade, { positionQty: qty, markPrice: markPrice })
            .then(function () { return ensureProtection(trade, qty, openAlgos); }).then(function () {
            // §2: both legs confirmed on a live position -> the protection halt is
            // cleared here, BEFORE any dynamic replacement in this same pass.
            clearProtectionHaltIfFullyProtected(trade);
            if (!isOpen(trade.slOrder)) {
                // §6: an accepted-but-unconfirmed protection must NOT be re-submitted.
                // If it stays unconfirmed past the safety window the position is
                // effectively unprotected: stop mutating and report PROTECTION_UNVERIFIED
                // so the runner/smoke exits the position safely.
                var unresolved = unresolvedProtectionAttempt(trade, 'SL');
                if (unresolved) {
                    var since = unresolved.record.unresolvedSince ||
                        (unresolved.entry && unresolved.entry.firstPendingAt) || Date.now();
                    if (Date.now() - since >= PROTECTION_UNVERIFIED_AFTER_MS) {
                        return emit('PROTECTION_UNVERIFIED', trade, { critical: true, role: 'SL',
                            clientAlgoId: unresolved.record.clientOrderId,
                            algoId: unresolved.record.algoId || null,
                            exchangeCode: (unresolved.record.verifyError || {}).code || null,
                            exchangeMessage: (unresolved.record.verifyError || {}).msg || null,
                            detail: 'no terminal proof and no confirmation within ' +
                                PROTECTION_UNVERIFIED_AFTER_MS + 'ms; no re-submit' })
                            .then(function () { return halt('PROTECTION_UNVERIFIED', trade); });
                    }
                }
                // ensureProtection already tried (and is now halted): NEVER place from
                // here again - the previous version re-submitted on every reconcile.
                return halt('UNPROTECTED_LIVE_POSITION', trade);
            }
            return applyDynamic(trade, position, markPrice, Date.now()).then(function () {
                if (!isOpen(trade.slOrder)) return halt('UNPROTECTED_LIVE_POSITION', trade);
                trade.status = isOpen(trade.tpOrder) ? 'PROTECTED' : 'PROTECTION_ERROR';
                saveTrade(trade);
                return lostProtection ? halt('UNPROTECTED_LIVE_POSITION', trade) : null;
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
            if (match) {
                // The open-order snapshot IS exchange truth: record it as verified.
                var wasVerified = protection.verified === true;
                protection.status = statusOf(match) || 'NEW';
                if (isOpen({ status: protection.status })) {
                    protection.verified = true;
                    protection.verifyError = null;
                    protection.algoId = match.algoId !== undefined ? match.algoId : protection.algoId;
                    // Same object contract as every other writer: an attempt entry is
                    // an OBJECT with a `state`, never a bare string. A bare string here
                    // made the next accepted placement throw while committing its record
                    // ("Cannot create property 'role' on string 'ACTIVE'"), which was then
                    // mis-read as PLACEMENT_UNKNOWN and re-raised a protection halt.
                    var snapshotEntry = protectionAttempts[orderId(protection)];
                    if (!snapshotEntry || typeof snapshotEntry !== 'object') {
                        snapshotEntry = {};
                    }
                    snapshotEntry.role = protection.role;
                    snapshotEntry.state = 'ACTIVE';
                    snapshotEntry.accepted = snapshotEntry.accepted !== false;
                    snapshotEntry.activeAt = snapshotEntry.activeAt || Date.now();
                    protectionAttempts[orderId(protection)] = snapshotEntry;
                    if (!wasVerified) {
                        // Exchange-confirmed ACTIVE timestamp for latency accounting.
                        emit('PROTECTION_VERIFIED', trade, { role: protection.role,
                            clientAlgoId: orderId(protection),
                            algoId: protection.algoId === undefined ? null : protection.algoId,
                            status: protection.status, source: 'OPEN_ORDERS_SNAPSHOT' });
                    }
                } else if (isTerminalStatus(protection.status)) {
                    markCleanupTerminal(orderId(protection), protection.status);
                }
            } else {
                protection.status = 'MISSING_ON_EXCHANGE';
                protection.verified = false;
            }
        });
    }

    /** §2: remember that this exact order needs no further DELETE. */
    function markCleanupTerminal(clientAlgoId, reason) {
        if (!clientAlgoId) return;
        if (cleanupTerminal[clientAlgoId]) return;
        cleanupTerminal[clientAlgoId] = { reason: reason || null, at: Date.now() };
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
                                    return protectOpenPosition(trade, positions[0], markPrice, openAlgos);
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
                if (!firstFill) return protectOpenPosition(trade, positions[0], markPrice, openAlgos);
                return emitOnce('BREAKOUT_ENTRY_FILLED', trade, { positionQty: qty,
                    entryWorkingType: 'CONTRACT_PRICE' }).then(function () {
                    return protectOpenPosition(trade, positions[0], markPrice, openAlgos);
                });
            }

            // position closed -> sibling / orphan cleanup
            // §9/§10: a replacement that was in flight when the position went flat ends
            // as FLAT_ABORT - no further placement, cleanup only.
            if (replacementOwnsRole(trade, 'SL') || replacementOwnsRole(trade, 'TP')) {
                return advanceInFlightReplacements(trade, { positionQty: 0, markPrice: markPrice })
                    .then(function () { return reconcileFlatCleanup(trade, markPrice, openAlgos); });
            }
            return reconcileFlatCleanup(trade, markPrice, openAlgos);
        });
    }

    function reconcileFlatCleanup(trade, markPrice, openAlgos) {
            // Never treat an order we cannot identify as an orphan: if the just
            // placed entry has not been recorded yet (user-data-stream/first REST
            // reconcile can race the placement response) the only safe action is to
            // wait for the next reconcile.
            if (!trade.entryOrder) return trade;
            // C: a pending entry that never held a position has nothing to close. Emitting
            // POSITION_CLOSED here (and terminalizing) for a flat pending breakout was a
            // diagnostic/state bug: only run the close path when a position was actually
            // seen or protective orders exist.
            if (trade.positionOpenedAt === null && !trade.slOrder && !trade.tpOrder) return trade;
            var orphans = openAlgos.filter(function (o) {
                var id = orderId(o) || '';
                return id.indexOf('IMC_') === 0 && (!trade.slOrder || id !== orderId(trade.slOrder))
                    && (!trade.tpOrder || id !== orderId(trade.tpOrder))
                    && id !== orderId(trade.entryOrder);
            });
            var chain = Promise.resolve();
            [trade.slOrder, trade.tpOrder].forEach(function (protection) {
                if (!isOpen(protection)) return;
                var protectionId = orderId(protection);
                if (!protectionId) return;
                if (cleanupTerminal[protectionId]) {
                    // §2 idempotent cleanup: this exact order is already terminal -
                    // QUERY it, never send another DELETE.
                    chain = chain.then(function () {
                        return client.queryAlgoOrder(symbol, null, protectionId).then(function (state) {
                            if (!isOpen({ status: statusOf(state) })) {
                                protection.status = statusOf(state) || 'CANCELED';
                            }
                            return null;
                        }, function () { return null; });
                    });
                    return;
                }
                chain = chain.then(function () {
                    return client.cancelAlgo(symbol, protectionId).then(function () {
                        protection.status = 'CANCELED';
                        markCleanupTerminal(protectionId, 'CANCEL_ACCEPTED');
                    }, function (error) {
                        var info = exchangeErrorInfo(error);
                        // -2013 order does not exist / -2011 unknown order sent:
                        // the order is already gone, so cleanup is terminal.
                        if (info.code === -2013 || info.code === -2011 ||
                                isTerminalStatus(statusOf(protection))) {
                            markCleanupTerminal(protectionId, 'ABSENT_OR_ALREADY_CANCELED');
                        }
                        return null;
                    });
                });
            });
            orphans.forEach(function (orphan) {
                var orphanId = orderId(orphan);
                if (!orphanId || cleanupTerminal[orphanId]) return;
                chain = chain.then(function () {
                    return emit('ORPHAN_ORDER_FOUND', trade, { critical: true, detail: orphanId })
                        .then(function () { return client.cancelAlgo(symbol, orphanId); })
                        .then(function () { markCleanupTerminal(orphanId, 'ORPHAN_CANCELED'); },
                            function (error) {
                                var info = exchangeErrorInfo(error);
                                if (info.code === -2013 || info.code === -2011) {
                                    markCleanupTerminal(orphanId, 'ORPHAN_ABSENT');
                                }
                                return null;
                            });
                });
            });
            return chain.then(function () {
                if (trade.status !== 'BREAKOUT_ENTRY_CANCELED') {
                    trade.status = 'CLOSED';
                    trade.closedAt = Date.now();
                    saveTrade(trade);
                    return emitOnce('POSITION_CLOSED', trade);
                }
                return null;
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
        /** §3: resolves once every queued reconcile/cleanup has finished, so a
         *  caller can print a final summary that nothing may mutate afterwards. */
        awaitIdle: function () {
            return queue.then(function () { return null; }, function () { return null; });
        },
        cleanupTerminalIds: function () { return Object.keys(cleanupTerminal); },
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

module.exports = { VERSION: VERSION, createService: createService, tradeIdFor: tradeIdFor,
    applyExecutionAuditEvent: applyExecutionAuditEvent, closedSummary: closedSummary };
