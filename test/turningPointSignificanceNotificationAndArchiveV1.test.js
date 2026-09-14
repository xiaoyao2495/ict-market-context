'use strict';

/**
 * TURNING_SIGNIFICANCE_NOTIFICATION_AND_ARCHIVE_TESTS —
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 §55–§58.
 *
 * The semantic layer is allowed to be *visible* in exactly two places: the EQ
 * notification (which historical anchors were consulted, and what was frozen for
 * each) and the real-trade case archive (which anchor actually became the TP
 * target). Nothing here may re-decide, re-order, re-price or reinterpret
 * anything — every assertion below is a projection of an already frozen decision.
 *
 * Checks run STRICTLY SERIALLY (reduce over a promise chain) so console output is
 * deterministic and a rejected assertion fails the file.
 */

var assert = require('assert');
var os = require('os');
var path = require('path');
var fs = require('fs');

var contract = require('../semantic/turningPointSignificanceSemanticV1');
var eligibilityModule = require('../liquidity/historicalAnchorEligibilityV1');
var rules = require('../execution/executionRulesV1');
var repository = require('../execution/executionRepositoryV1');
var serviceModule = require('../execution/realOrderExecutionV1');
var archiveModule = require('../execution/realTradeCaseArchiveV1');
var eqNotification = require('../notify/eqFvgCountWatchNotificationV1');
var executionNotification = require('../notify/executionNotificationV1');
var fixtures = require('./fixtures/turningPointSignificanceV1');

var passed = 0;
var checks = [];
function check(name, fn) { checks.push({ name: name, fn: fn }); }

var T0 = fixtures.BASE_TIME;
function at(index) { return T0 + index * fixtures.BAR_MS; }
function time(ms) { return 'T' + ms; }
function price(value) { return String(value); }

var CONFIG = Object.freeze({
    semanticEnabled: true, liveFilterEnabled: true, failClosed: true,
    minimumConfidence: 'MEDIUM', allowedLabels: Object.freeze(['SIGNIFICANT', 'VALID'])
});

function result(significance, confidence, eligible, reason) {
    return {
        status: 'AVAILABLE', eligible: eligible,
        decision: { significance: significance, confidence: confidence,
            primaryReason: reason || 'INDEPENDENT_DIRECTIONAL_TURN',
            evidence: ['evidence'], counterEvidence: [] },
        factsHash: 'a'.repeat(64), promptHash: contract.PROMPT_SHA256,
        decisionKey: 'b'.repeat(64), semanticVersion: contract.VERSION,
        gateResult: eligible ? 'PASS' : 'BLOCK',
        gateReason: eligible ? null : 'TURNING_SIGNIFICANCE_' + significance
    };
}

function registry(pairs) {
    var r = eligibilityModule.createRegistry({ config: CONFIG });
    (pairs || []).forEach(function (pair) { r.publish(pair.point, pair.result); });
    return r;
}

/* ---------------------------------------------------------------- §55–§56 */

check('§56: an eligible anchor renders label / confidence / reason / frozen version', function () {
    var lines = eqNotification.turningSignificanceLines({
        turningPointId: 'P1', price: 64250, significance: 'SIGNIFICANT', confidence: 'HIGH',
        primaryReason: 'INDEPENDENT_DIRECTIONAL_TURN', eligible: true, semanticVersion: contract.VERSION
    });
    assert.deepStrictEqual(lines, [
        '  Turning Significance: SIGNIFICANT / HIGH',
        '  Turning Reason: INDEPENDENT_DIRECTIONAL_TURN',
        '  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR',
        '  Turning Semantic Version: ' + contract.VERSION
    ]);
});

check('§56: a blocked anchor shows the gate reason, never a fabricated label', function () {
    var lines = eqNotification.turningSignificanceLines({
        turningPointId: 'P2', price: 64100, significance: 'WEAK', confidence: 'HIGH',
        primaryReason: 'INTERNAL_PULLBACK', eligible: false,
        gateReason: 'TURNING_SIGNIFICANCE_WEAK', semanticVersion: contract.VERSION
    });
    assert.strictEqual(lines[0], '  Turning Significance: WEAK / HIGH');
    assert.strictEqual(lines[2], '  Turning Status: TURNING_SIGNIFICANCE_WEAK');
});

check('§56: no frozen decision renders UNAVAILABLE and states fail-closed exclusion', function () {
    var lines = eqNotification.turningSignificanceLines(null);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /UNAVAILABLE/);
    assert.match(lines[0], /fail-closed/);
});

check('§55: universe filter state is explicit (APPLIED / DISABLED / absent)', function () {
    assert.match(eqNotification.anchorUniverseLine('APPLIED'), /^Anchor Universe Filter: APPLIED/);
    assert.match(eqNotification.anchorUniverseLine('DISABLED'), /^Anchor Universe Filter: DISABLED/);
    assert.strictEqual(eqNotification.anchorUniverseLine(undefined), null);
});

check('§56: EQ Source Context shows Current Point, partners, then per-anchor significance', function () {
    var partnerA = fixtures.anchorPoint({ id: 'A', pointSide: 'LOW', price: 100.4, occurredAt: at(10), confirmedAt: at(11), occurredBarIndex: 10 });
    var partnerB = fixtures.anchorPoint({ id: 'B', pointSide: 'LOW', price: 100.6, occurredAt: at(20), confirmedAt: at(21), occurredBarIndex: 20 });
    var lines = eqNotification.sourceContextLines({
        anchorUniverseFilter: 'APPLIED',
        eqConfirmedAt: at(30),
        eqSourceContext: {
            status: 'AVAILABLE',
            currentPivot: { id: 'CUR', price: 101, occurredAt: at(25), confirmedAt: at(26) },
            historicalPartners: [partnerA, partnerB]
        },
        eqHistoricalAnchorSignificance: [
            { turningPointId: 'A', price: 100.4, significance: 'SIGNIFICANT', confidence: 'HIGH',
                primaryReason: 'INDEPENDENT_DIRECTIONAL_TURN', eligible: true, semanticVersion: contract.VERSION },
            null
        ]
    }, time, price);
    assert.strictEqual(lines[0], 'EQ Source Context:');
    assert.match(lines[1], /^Current Point: /);
    assert.strictEqual(lines[2], 'Historical Partners: 2');
    assert.match(lines[3], /^Partner #1: /);
    assert.strictEqual(lines[4], '  Turning Significance: SIGNIFICANT / HIGH');
    assert.strictEqual(lines[5], '  Turning Reason: INDEPENDENT_DIRECTIONAL_TURN');
    assert.strictEqual(lines[6], '  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR');
    assert.strictEqual(lines[7], '  Turning Semantic Version: ' + contract.VERSION);
    // Partner B has no frozen decision ⇒ UNAVAILABLE, never silently omitted.
    assert.match(lines[8], /^Partner #2: /);
    assert.match(lines[9], /UNAVAILABLE/);
    assert.match(lines[10], /^Anchor Universe Filter: APPLIED/);
    assert.match(lines[11], /^EQ确认: /);
    assert.strictEqual(lines.length, 12);
});

check('§56: the significance block follows the partner even when display order is reversed', function () {
    var early = fixtures.anchorPoint({ id: 'EARLY', pointSide: 'LOW', price: 100.4, occurredAt: at(10), confirmedAt: at(11), occurredBarIndex: 10 });
    var late = fixtures.anchorPoint({ id: 'LATE', pointSide: 'LOW', price: 100.6, occurredAt: at(20), confirmedAt: at(21), occurredBarIndex: 20 });
    var lines = eqNotification.sourceContextLines({
        eqConfirmedAt: at(30),
        eqSourceContext: { status: 'AVAILABLE', currentPivot: { id: 'CUR', price: 101, occurredAt: at(25), confirmedAt: at(26) },
            historicalPartners: [late, early] },
        eqHistoricalAnchorSignificance: [
            { turningPointId: 'LATE', significance: 'WEAK', confidence: 'HIGH', primaryReason: 'INTERNAL_PULLBACK', eligible: false,
                gateReason: 'TURNING_SIGNIFICANCE_WEAK', semanticVersion: contract.VERSION },
            { turningPointId: 'EARLY', significance: 'VALID', confidence: 'HIGH', primaryReason: 'REACTION_PIVOT', eligible: true,
                semanticVersion: contract.VERSION }
        ]
    }, time, price);
    // Presentation re-sorts to chronological order; significance must follow its id.
    assert.match(lines[3], /^Partner #1: /);
    assert.strictEqual(lines[4], '  Turning Significance: VALID / HIGH');
    assert.strictEqual(lines[6], '  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR');
    assert.strictEqual(lines[8].indexOf('Partner #2: ') === 0, true);
    assert.strictEqual(lines[9], '  Turning Significance: WEAK / HIGH');
    assert.strictEqual(lines[11], '  Turning Status: TURNING_SIGNIFICANCE_WEAK');
});

check('§56: universe line is omitted when the contract is not configured (rollback)', function () {
    var lines = eqNotification.sourceContextLines({
        eqConfirmedAt: at(30),
        eqSourceContext: { status: 'AVAILABLE',
            currentPivot: { id: 'CUR', price: 101, occurredAt: at(25), confirmedAt: at(26) },
            historicalPartners: [fixtures.anchorPoint({ id: 'A', pointSide: 'LOW', price: 100.4, occurredAt: at(10), confirmedAt: at(11), occurredBarIndex: 10 })] },
        eqHistoricalAnchorSignificance: [null]
    }, time, price);
    assert.strictEqual(lines.filter(function (line) { return /Anchor Universe Filter/.test(line); }).length, 0);
});

check('§56: UNAVAILABLE EQ Source Context is byte-identical to the legacy output', function () {
    assert.deepStrictEqual(
        eqNotification.sourceContextLines({ eqConfirmedAt: at(30), eqSourceContext: { status: 'UNAVAILABLE' } }, time, price),
        ['EQ Source Context: UNAVAILABLE', 'EQ确认: T' + at(30)]);
});

check('§56: a partner without any provenance still renders exactly one significance line', function () {
    var lines = eqNotification.sourceContextLines({
        eqConfirmedAt: at(30),
        eqSourceContext: { status: 'AVAILABLE', currentPivot: { id: 'CUR', price: 101, occurredAt: at(25), confirmedAt: at(26) },
            historicalPartners: [{ id: 'A', price: 1, occurredAt: at(10), confirmedAt: at(11) }] }
    }, time, price);
    assert.strictEqual(lines.length, 6);
    assert.match(lines[4], /UNAVAILABLE/);
    assert.match(lines[5], /^EQ确认: /);
});

/* ------------------------------------------------------------------- §57 */

check('§57: TP anchor block renders price / label / reason / version', function () {
    assert.deepStrictEqual(executionNotification.tpAnchorLines({
        price: 104, significance: 'SIGNIFICANT', confidence: 'HIGH',
        primaryReason: 'INDEPENDENT_DIRECTIONAL_TURN', eligible: true, semanticVersion: contract.VERSION
    }), [
        'TP Anchor: 104',
        '  Turning Significance: SIGNIFICANT / HIGH',
        '  Turning Reason: INDEPENDENT_DIRECTIONAL_TURN',
        '  Turning Semantic Version: ' + contract.VERSION,
        '  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR'
    ]);
});

check('§57: a plan without any anchor provenance says so instead of inventing one', function () {
    var lines = executionNotification.tpAnchorLines(null);
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /无 Historical Anchor 语义记录/);
});

check('§57: ENTRY_SUBMITTED keeps the legacy lines and appends TP provenance', function () {
    var lines = executionNotification.build({
        type: 'ENTRY_SUBMITTED', symbol: 'BTCUSDT', tradeId: 'T_1',
        entryPrice: 101, stopPrice: 99, targetPrice: 104, initialRR: 1.5,
        tpAnchorSignificance: { price: 104, significance: 'VALID', confidence: 'HIGH',
            primaryReason: 'DEEP_RETRACEMENT_ORIGIN', eligible: true, semanticVersion: contract.VERSION },
        eqHistoricalAnchorSignificance: [{ eligible: true }, { eligible: false }]
    }, '检测').split('\n');
    assert.deepStrictEqual(lines.slice(0, 3), ['检测 REAL ORDER EXECUTION V1', 'event=ENTRY_SUBMITTED', 'symbol=BTCUSDT']);
    assert.deepStrictEqual(lines.slice(3, 7), ['tradeId=T_1', 'Entry: 101', 'SL: 99', 'TP: 104']);
    assert.strictEqual(lines[7], 'RR: 1.5');
    assert.strictEqual(lines[8], 'TP Anchor: 104');
    assert.strictEqual(lines[9], '  Turning Significance: VALID / HIGH');
    assert.strictEqual(lines[12], '  Turning Status: LLM_QUALIFIED_HISTORICAL_ANCHOR');
    assert.strictEqual(lines[13], 'EQ Historical Anchors: 1 / 2 LLM_QUALIFIED');
});

check('§57: a legacy execution event (no plan provenance) is unchanged', function () {
    assert.strictEqual(executionNotification.build({ type: 'EXCHANGE_REJECTED', symbol: 'BTCUSDT', reasonCode: 'X' }, '检测'),
        '检测 REAL ORDER EXECUTION V1\nevent=EXCHANGE_REJECTED\nsymbol=BTCUSDT\nreason=X');
});

check('§57: eqAnchorCountLine counts only LLM_QUALIFIED anchors and stays silent when empty', function () {
    assert.strictEqual(executionNotification.eqAnchorCountLine([]), null);
    assert.strictEqual(executionNotification.eqAnchorCountLine(null), null);
    assert.strictEqual(executionNotification.eqAnchorCountLine([{ eligible: true }, { eligible: false }, null]),
        'EQ Historical Anchors: 1 / 3 LLM_QUALIFIED');
});

/* ------------------------------------------------------------------- §58 */

var TARGET = fixtures.anchorPoint({ id: 'D', pointSide: 'HIGH', price: 104, occurredAt: at(80), confirmedAt: at(81), occurredBarIndex: 80 });

function anchorPlanContext(targetPoint, targetResult, withEligibility) {
    var context = {
        tradeId: 'T_ANCHOR', liveTradingEnabled: false,
        bias: { status: 'AVAILABLE', closedAt: 100, semantic: { direction: 'BULLISH', strength: 'STRONG', confidence: 'HIGH' } },
        expected4hClosedAt: 100, dynamicDPoints: [targetPoint], candles: [],
        symbolRules: { source: 'futures', tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5 }
    };
    if (withEligibility !== false) context.anchorEligibility = registry([{ point: targetPoint, result: targetResult }]);
    return context;
}

function eqEvent() {
    return { ordinal: 1, watchId: 'W-EQL', symbol: 'BTCUSDT', liquidityId: 'EQ-EQL', liquidityType: 'EQL',
        liquidityPrice: 99, eqConfirmedAt: at(90),
        eqSourceContext: { status: 'AVAILABLE', currentPivot: { id: 'CUR', price: 99, occurredAt: at(80), confirmedAt: at(90) },
            historicalPartners: [] },
        rawFvg: { id: 'F-EQL-1', direction: 'BULLISH', low: 100, high: 102, k3Index: 8, confirmedAt: at(120) } };
}

check('§58: the trade object carries EQ_HISTORICAL_ANCHOR_SIGNIFICANCE and TP_ANCHOR_SIGNIFICANCE', function () {
    var repo = repository.createRepository();
    var service = serviceModule.createService({
        symbol: 'BTCUSDT', liveTradingEnabled: false, repository: repo,
        client: { submitEntry: function () {} },
        getContext: function () { return anchorPlanContext(TARGET, result('SIGNIFICANT', 'HIGH', true)); }
    });
    return service.onFirstMatchingFvg(eqEvent()).then(function () {
        var trades = repo.snapshot().trades;
        var trade = trades[Object.keys(trades)[0]];
        assert.deepStrictEqual(trade.EQ_HISTORICAL_ANCHOR_SIGNIFICANCE, []);
        var record = trade.TP_ANCHOR_SIGNIFICANCE;
        assert.ok(record, 'TP_ANCHOR_SIGNIFICANCE must be present');
        assert.strictEqual(record.turningPointId, 'D');
        assert.strictEqual(record.processId, TARGET.processId);
        assert.strictEqual(record.price, 104);
        assert.strictEqual(record.side, 'HIGH');
        assert.strictEqual(record.confirmedAt, at(81));
        assert.strictEqual(record.significance, 'SIGNIFICANT');
        assert.strictEqual(record.confidence, 'HIGH');
        assert.strictEqual(record.primaryReason, 'INDEPENDENT_DIRECTIONAL_TURN');
        assert.deepStrictEqual(record.evidence, ['evidence']);
        assert.deepStrictEqual(record.counterEvidence, []);
        assert.strictEqual(record.eligible, true);
        assert.strictEqual(record.factsHash, 'a'.repeat(64));
        assert.strictEqual(record.promptHash, contract.PROMPT_SHA256);
        assert.strictEqual(record.decisionKey, 'b'.repeat(64));
        assert.strictEqual(record.semanticVersion, contract.VERSION);
    });
});

check('§58: without an eligibility seam the archive fields are empty/null, never invented', function () {
    var repo = repository.createRepository();
    var service = serviceModule.createService({
        symbol: 'BTCUSDT', liveTradingEnabled: false, repository: repo,
        client: { submitEntry: function () {} },
        getContext: function () { return anchorPlanContext(TARGET, result('SIGNIFICANT', 'HIGH', true), false); }
    });
    return service.onFirstMatchingFvg(eqEvent()).then(function () {
        var trades = repo.snapshot().trades;
        var trade = trades[Object.keys(trades)[0]];
        assert.deepStrictEqual(trade.EQ_HISTORICAL_ANCHOR_SIGNIFICANCE, []);
        assert.strictEqual(trade.TP_ANCHOR_SIGNIFICANCE, null);
        assert.strictEqual(trade.plan.targetAnchorSignificance, null);
    });
});

check('§58: a blocked target leaves the universe and yields NO_VALID_DYNAMIC_D_TARGET', function () {
    var blockedTarget = fixtures.anchorPoint({ id: 'D2', pointSide: 'HIGH', price: 104, occurredAt: at(80), confirmedAt: at(81), occurredBarIndex: 80 });
    var built = rules.buildEntryPlan(eqEvent(), anchorPlanContext(blockedTarget, result('WEAK', 'HIGH', false)));
    assert.strictEqual(built.ok, false);
    assert.strictEqual(built.reasonCode, 'NO_VALID_DYNAMIC_D_TARGET');
    // No fallback anchor is ever substituted: the plan simply carries no target.
    assert.strictEqual(built.plan.targetAnchorSignificance == null, true);
    assert.strictEqual(built.plan.targetDynamicDId == null, true);
});

check('§58: real trade case archive persists the frozen anchor provenance verbatim', function () {
    var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'turning-significance-case-'));
    try {
        var file = archiveModule.createArchive({ directory: directory }).append({
            tradeCaseId: 'REAL_TRADE_CASE_T_ANCHOR', tradeId: 'T_ANCHOR', symbol: 'BTCUSDT',
            EQ_HISTORICAL_ANCHOR_SIGNIFICANCE: [{ turningPointId: 'A', significance: 'VALID', confidence: 'HIGH', eligible: true }],
            TP_ANCHOR_SIGNIFICANCE: { turningPointId: 'D', significance: 'SIGNIFICANT', confidence: 'HIGH', eligible: true }
        });
        var line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
        assert.deepStrictEqual(line.trade.EQ_HISTORICAL_ANCHOR_SIGNIFICANCE,
            [{ turningPointId: 'A', significance: 'VALID', confidence: 'HIGH', eligible: true }]);
        assert.strictEqual(line.trade.TP_ANCHOR_SIGNIFICANCE.turningPointId, 'D');
        assert.strictEqual(line.trade.TP_ANCHOR_SIGNIFICANCE.eligible, true);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) { /* temp dir */ }
    }
});

check('§58: an EQ plan records one provenance entry per consulted historical partner', function () {
    var partnerA = fixtures.anchorPoint({ id: 'PA', pointSide: 'HIGH', price: 104, occurredAt: at(80), confirmedAt: at(81), occurredBarIndex: 80 });
    var partnerB = fixtures.anchorPoint({ id: 'PB', pointSide: 'HIGH', price: 105, occurredAt: at(70), confirmedAt: at(71), occurredBarIndex: 70 });
    var event = eqEvent();
    event.eqSourceContext = { status: 'AVAILABLE', currentPivot: { id: 'CUR', price: 99, occurredAt: at(80), confirmedAt: at(90) },
        historicalPartners: [partnerA, partnerB] };
    var context = anchorPlanContext(TARGET, result('VALID', 'HIGH', true));
    context.anchorEligibility = registry([
        { point: partnerA, result: result('SIGNIFICANT', 'HIGH', true) },
        { point: partnerB, result: result('WEAK', 'HIGH', false) },
        { point: TARGET, result: result('VALID', 'HIGH', true) }
    ]);
    var built = rules.buildEntryPlan(event, context);
    assert.strictEqual(built.ok, true);
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance.length, 2);
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance[0].turningPointId, 'PA');
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance[0].eligible, true);
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance[1].turningPointId, 'PB');
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance[1].eligible, false);
    assert.strictEqual(built.plan.eqHistoricalAnchorSignificance[1].gateReason, 'TURNING_SIGNIFICANCE_WEAK');
});

/* ------------------------------------------------------------------ runner */

checks.reduce(function (chain, item) {
    return chain.then(function () {
        return Promise.resolve().then(item.fn).then(function () {
            passed += 1;
            console.log('PASS ' + item.name);
        });
    });
}, Promise.resolve()).then(function () {
    console.log('turningPointSignificanceNotificationAndArchiveV1: ' + passed + '/' + checks.length + ' checks passed');
    process.exitCode = passed === checks.length ? 0 : 1;
}, function (error) {
    console.error('FAIL after ' + passed + ' passing checks');
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
