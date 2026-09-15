'use strict';

/**
 * LIQUIDITY_MODEL_V2_PHASE_1_EQ_PARITY — unit + contract tests.
 *
 * Frozen semantics under test:
 *   Location != Liquidity; Liquidity Location != Liquidity Interaction;
 *   Interaction != Response.
 *
 * The V2 model is SHADOW infrastructure: it must not change production, must
 * not re-derive anything production already decided, and must not call a model.
 *
 * Real-EQ fixtures are produced by the REAL production detector
 * (productionEqualLiquidityV1.evaluatePivot), never hand-written, so the adapter
 * is always exercised against the genuine EQ schema.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var ROOT = path.join(__dirname, '..');

var cand = require(path.join(ROOT, 'liquidity', 'liquidityLocationCandidateV2'));
var src = require(path.join(ROOT, 'liquidity', 'eqLiquidityLocationSourceV2'));
var reg = require(path.join(ROOT, 'liquidity', 'liquidityLocationRegistryV2'));
var producer = require(path.join(ROOT, 'liquidity', 'productionEqualLiquidityV1'));

var BAR = 300000;
var passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('PASS  ' + name); }
    catch (error) { failed++; console.log('FAIL  ' + name + ' -> ' + (error && error.stack)); }
}
function skip(name, reason) { skipped++; console.log('SKIP  ' + name + ' (' + reason + ')'); }

// ---------------------------------------------------------------- fixtures

function eqState(points) {
    var value = producer.createState({ symbol: 'BTCUSDT', timeframe: '5m' });
    value.fiveMinuteAtrValue = 10;
    value.dynamicD.recentSurvivalPoints = points || [];
    return value;
}
function anchor(id, side, index, price) {
    return {
        id: id, pointSide: side, price: price, selectorPrice: price,
        occurredAt: index * BAR, confirmedAt: (index + 3) * BAR,
        occurredBarIndex: index, state: 'ACTIVE',
        inactivatedBy: null, inactivatedAt: null
    };
}
function pivotFor(id, side, index, price) {
    return {
        id: id, symbol: 'BTCUSDT', timeframe: '5m',
        type: side === 'HIGH' ? 'SWING_HIGH' : 'SWING_LOW',
        side: side === 'HIGH' ? 'BSL' : 'SSL',
        price: price,
        sourceOpenTime: index * BAR, sourceCloseTime: (index + 1) * BAR - 1,
        occurredAt: index * BAR, confirmedAt: (index + 3) * BAR,
        metadata: { index: index, right: 2 }
    };
}

/** Produce a GENUINE production EQ event (EQH for HIGH, EQL for LOW). */
function realEq(side) {
    var historical = anchor('A', side, 10, 100);
    var current = side === 'HIGH'
        ? pivotFor('P', side, 20, 97)
        : pivotFor('P', side, 20, 103);
    var event = producer.evaluatePivot(eqState([historical]), current);
    assert.ok(event, 'production EQ must emit for ' + side);
    return event;
}

// ------------------------------------------------- candidate: frozen semantics

test('candidate contract declares the LIQUIDITY_LOCATION_V2 model version', function () {
    assert.strictEqual(cand.VERSION, 'LIQUIDITY_LOCATION_V2');
});

test('EQH maps to BUY_SIDE and EQL maps to SELL_SIDE (frozen)', function () {
    assert.strictEqual(cand.sideForEqType('EQH'), 'BUY_SIDE');
    assert.strictEqual(cand.sideForEqType('EQL'), 'SELL_SIDE');
    // production liquidity.side cross-check mapping
    assert.strictEqual(cand.sideForEqLiquiditySide('BSL'), 'BUY_SIDE');
    assert.strictEqual(cand.sideForEqLiquiditySide('SSL'), 'SELL_SIDE');
});

test('an unknown EQ type never yields a side', function () {
    assert.strictEqual(cand.sideForEqType('EQX'), null);
    assert.strictEqual(cand.sideForEqLiquiditySide('XXX'), null);
});

test('BUY_SIDE is not LONG and SELL_SIDE is not SHORT', function () {
    assert.notStrictEqual(cand.SIDE_BUY, 'LONG');
    assert.notStrictEqual(cand.SIDE_SELL, 'SHORT');
    assert.notStrictEqual(cand.SIDE_BUY, 'SHORT');
    assert.notStrictEqual(cand.SIDE_SELL, 'LONG');
    // No trade-direction mapping is exposed at all.
    assert.strictEqual(typeof cand.tradeDirectionFor, 'undefined');
    assert.strictEqual(typeof cand.directionForSide, 'undefined');
    // The frozen side vocabulary contains only location sides.
    assert.deepStrictEqual(Object.keys(cand.SIDE_BY_EQ_TYPE).sort(), ['EQH', 'EQL']);
});

test('candidate id is deterministic, injective and reversible to the source id', function () {
    var sourceId = 'EQX1:BTCUSDT:5m:EQH:[BTCUSDT|HIGH|1|2]';
    var id = cand.candidateIdFor('EQ', sourceId);
    assert.strictEqual(id, cand.candidateIdFor('EQ', sourceId));
    assert.strictEqual(cand.sourceIdFromCandidateId(id), sourceId);
    assert.strictEqual(cand.sourceTypeFromCandidateId(id), 'EQ');
    assert.notStrictEqual(cand.candidateIdFor('EQ', 'a'), cand.candidateIdFor('EQ', 'b'));
});

test('canonical serialization is independent of property insertion order', function () {
    var a = { x: 1, y: { p: 1, q: 2 } };
    var b = { y: { q: 2, p: 1 }, x: 1 };
    assert.strictEqual(cand.stableSerialize(a), cand.stableSerialize(b));
});

test('the canonical candidate carries no lifecycle / interaction / response field', function () {
    var adapted = src.adapt(realEq('HIGH'));
    assert.strictEqual(adapted.status, 'AVAILABLE');
    var keys = Object.keys(adapted.candidate).sort();
    assert.deepStrictEqual(keys, [
        'confirmedAt', 'id', 'location', 'modelVersion',
        'occurredAt', 'semanticProvenance', 'side', 'sourceProvenance', 'sourceType'
    ]);
    var serialized = cand.stableSerialize(adapted.candidate);
    ['"status"', 'TAKEN', 'SWEPT', 'REJECTED', 'ACCEPTED', 'INVALIDATED', 'liquidityTaken'].forEach(function (token) {
        assert.strictEqual(serialized.indexOf(token), -1, 'must not contain ' + token);
    });
});

test('validate rejects every malformed candidate shape with a typed error code', function () {
    var good = src.adapt(realEq('HIGH')).candidate;
    assert.strictEqual(cand.validate(good).valid, true);

    var cases = [
        [null, cand.REJECTION.NOT_AN_OBJECT],
        [[], cand.REJECTION.NOT_AN_OBJECT],
        ['x', cand.REJECTION.NOT_AN_OBJECT]
    ];
    cases.forEach(function (pair) {
        assert.strictEqual(cand.validate(pair[0]).errorCode, pair[1]);
    });

    function mutate(fn) {
        var copy = JSON.parse(JSON.stringify(good));
        fn(copy);
        return cand.validate(copy).errorCode;
    }
    assert.strictEqual(mutate(function (c) { c.modelVersion = 'X'; }),
        cand.REJECTION.MODEL_VERSION_MISMATCH);
    assert.strictEqual(mutate(function (c) { c.side = 'LONG'; }),
        cand.REJECTION.SIDE_INCONSISTENT);
    assert.strictEqual(mutate(function (c) { c.side = 'SELL_SIDE'; }),
        cand.REJECTION.SIDE_INCONSISTENT);
    assert.strictEqual(mutate(function (c) { c.sourceProvenance.sourceId = 'zz'; }),
        cand.REJECTION.ID_MISMATCH);
    assert.strictEqual(mutate(function (c) { c.location.referencePrice = null; }),
        cand.REJECTION.REFERENCE_PRICE_INVALID);
    assert.strictEqual(mutate(function (c) { c.occurredAt = null; }),
        cand.REJECTION.TIME_INVALID);
    assert.strictEqual(mutate(function (c) { c.occurredAt = c.confirmedAt + 1; }),
        cand.REJECTION.CAUSALITY_INVALID);
    assert.strictEqual(mutate(function (c) { c.semanticProvenance = null; }),
        cand.REJECTION.PROVENANCE_INVALID);
    assert.strictEqual(mutate(function (c) {
        c.location.priceBand = { lower: 1, upper: 2 };
        c.location.referencePrice = 5;
    }), cand.REJECTION.PRICE_BAND_INVALID);
});

// ------------------------------------------------------ adapter: EQ source

/**
 * Parity is defined on the CANONICAL JSON projection. `undefined`-valued keys
 * are not representable in JSON, so they are dropped identically on both sides;
 * canonical serialization equality is therefore exactly losslessness for a
 * serializable object, and it is the comparison the live/audit path uses.
 */
function sameCanonical(actual, expected) {
    assert.strictEqual(cand.stableSerialize(actual), cand.stableSerialize(expected));
}

test('adapter projects a real EQH losslessly onto a BUY_SIDE location', function () {
    var eq = realEq('HIGH');
    var result = src.adapt(eq, { evaluationTime: eq.confirmedAt });
    assert.strictEqual(result.status, 'AVAILABLE');
    var k = result.candidate;
    assert.strictEqual(k.sourceType, 'EQ');
    assert.strictEqual(k.side, 'BUY_SIDE');
    assert.strictEqual(k.location.referencePrice, eq.price);
    assert.strictEqual(k.occurredAt, eq.occurredAt);
    assert.strictEqual(k.confirmedAt, eq.confirmedAt);
    assert.strictEqual(k.sourceProvenance.sourceId, eq.id);
    assert.strictEqual(k.sourceProvenance.eqType, 'EQH');
    assert.strictEqual(k.sourceProvenance.liquiditySide, 'BSL');
    sameCanonical(k.sourceProvenance.currentPoint, eq.metadata.currentPivot);
    sameCanonical(k.sourceProvenance.historicalPartners, eq.metadata.historicalPartners);
    assert.strictEqual(k.sourceProvenance.partnerCount, eq.metadata.historicalPartners.length);
    assert.strictEqual(k.id, cand.candidateIdFor('EQ', eq.id));
    // the projection survives a JSON round-trip byte-identically
    assert.strictEqual(cand.stableSerialize(JSON.parse(JSON.stringify(k))),
        cand.stableSerialize(k));
});

test('adapter projects a real EQL losslessly onto a SELL_SIDE location', function () {
    var eq = realEq('LOW');
    var k = src.adapt(eq, { evaluationTime: eq.confirmedAt }).candidate;
    assert.strictEqual(eq.type, 'EQL');
    assert.strictEqual(k.side, 'SELL_SIDE');
    assert.strictEqual(k.sourceProvenance.liquiditySide, 'SSL');
    sameCanonical(k.sourceProvenance.historicalPartners, eq.metadata.historicalPartners);
    sameCanonical(k.sourceProvenance.currentPoint, eq.metadata.currentPivot);
});

test('priceBand is a lossless projection of the ALREADY-APPLIED production tolerance', function () {
    var eq = realEq('HIGH');
    var k = src.adapt(eq, { evaluationTime: eq.confirmedAt }).candidate;
    var tolerance = eq.metadata.historicalPartners[0].eqTolerance;
    assert.ok(tolerance > 0);
    assert.deepStrictEqual(k.location.priceBand, {
        lower: eq.price - tolerance,
        upper: eq.price + tolerance
    });
    assert.strictEqual(k.sourceProvenance.priceBandDerivation,
        src.BAND_DERIVATION.PROJECTED);
});

test('the tolerance recorded is the production one (ATR14 x priceStrongMaxATR), not a new threshold', function () {
    var thresholds = require(path.join(ROOT, 'config', 'thresholds'));
    var eq = realEq('HIGH');
    var k = src.adapt(eq, { evaluationTime: eq.confirmedAt }).candidate;
    assert.strictEqual(k.sourceProvenance.tolerance.atrPeriod, producer.FIVE_MINUTE_ATR_PERIOD);
    assert.strictEqual(k.sourceProvenance.tolerance.atrMultiplier,
        thresholds.equalLiquidity.priceStrongMaxATR);
    assert.strictEqual(producer.FIVE_MINUTE_ATR_PERIOD,
        thresholds.equalLiquidity.atrPeriod);
    // 5m ATR14 x 0.7 with the fixture ATR of 10.
    assert.strictEqual(k.sourceProvenance.tolerance.applied, 10 * thresholds.equalLiquidity.priceStrongMaxATR);
});

test('priceBand is null (never invented) when the source carries no single positive tolerance', function () {
    var eq = realEq('HIGH');
    var copy = JSON.parse(JSON.stringify(eq));
    copy.metadata.historicalPartners.forEach(function (p) { delete p.eqTolerance; });
    var k = src.adapt(copy, { evaluationTime: copy.confirmedAt }).candidate;
    assert.strictEqual(k.location.priceBand, null);
    assert.strictEqual(k.sourceProvenance.priceBandDerivation,
        src.BAND_DERIVATION.NOT_AVAILABLE);
    assert.strictEqual(k.sourceProvenance.tolerance.applied, null);
});

test('adapter rejects a non-EQ object with a typed error code', function () {
    assert.strictEqual(src.adapt(null).errorCode, src.REJECTION.NOT_AN_EQ_OBJECT);
    assert.strictEqual(src.adapt({ type: 'SWING_HIGH' }).errorCode, src.REJECTION.NOT_AN_EQ_OBJECT);
    assert.strictEqual(src.adapt({ type: 'EQH', metadata: {} }).errorCode,
        src.REJECTION.MODEL_VERSION_UNKNOWN);
});

test('adapter rejects an EQ whose type and liquidity side disagree', function () {
    var eq = realEq('HIGH');
    var copy = JSON.parse(JSON.stringify(eq));
    copy.side = 'SSL';
    var result = src.adapt(copy);
    assert.strictEqual(result.status, 'UNAVAILABLE');
    assert.strictEqual(result.errorCode, src.REJECTION.SIDE_INCONSISTENT);
    assert.strictEqual(result.candidate, null);
});

test('adapter enforces causality: a candidate cannot be built before its own confirmation', function () {
    var eq = realEq('HIGH');
    assert.strictEqual(src.adapt(eq, { evaluationTime: eq.confirmedAt }).status, 'AVAILABLE');
    var early = src.adapt(eq, { evaluationTime: eq.confirmedAt - 1 });
    assert.strictEqual(early.status, 'UNAVAILABLE');
    assert.strictEqual(early.errorCode, cand.REJECTION.NOT_YET_CONFIRMED);
});

test('adapter does not mutate the EQ it consumes', function () {
    var eq = realEq('HIGH');
    var before = cand.stableSerialize(eq);
    src.adapt(eq, { evaluationTime: eq.confirmedAt });
    assert.strictEqual(cand.stableSerialize(eq), before);
});

test('adapt is total: an internal failure becomes a typed rejection, never a throw', function () {
    var evil = { type: 'EQH', id: 'x' };
    Object.defineProperty(evil, 'metadata', {
        get: function () { throw new Error('boom'); }
    });
    var result = src.adapt(evil);
    assert.strictEqual(result.status, 'UNAVAILABLE');
    assert.strictEqual(result.errorCode, src.REJECTION.ADAPTER_INTERNAL_ERROR);
});

test('adaptAll preserves source order and reports rejections positionally', function () {
    var eqh = realEq('HIGH');
    var eql = realEq('LOW');
    var out = src.adaptAll([eqh, { type: 'nope' }, eql], { evaluationTime: eqh.confirmedAt });
    assert.strictEqual(out.adapted, 2);
    assert.strictEqual(out.rejected, 1);
    assert.strictEqual(out.rejections[0].index, 1);
    assert.strictEqual(out.candidates[0].sourceProvenance.sourceId, eqh.id);
    assert.strictEqual(out.candidates[1].sourceProvenance.sourceId, eql.id);
});

test('adapter makes zero model calls (transport tripwire)', function () {
    var calls = 0;
    var client = require(path.join(ROOT, 'ai', 'deepseekClient'));
    assert.strictEqual(typeof client.chat, 'function');
    var original = client.chat;
    client.chat = function () { calls++; return Promise.resolve({}); };
    try {
        assert.strictEqual(src.adapt(realEq('HIGH'), { evaluationTime: 1e15 }).status, 'AVAILABLE');
        assert.strictEqual(src.adapt(realEq('LOW'), { evaluationTime: 1e15 }).status, 'AVAILABLE');
    } finally {
        client.chat = original;
    }
    assert.strictEqual(calls, 0);
});

test('the adapter module itself depends on no ai/ module', function () {
    var source = fs.readFileSync(path.join(ROOT, 'liquidity', 'eqLiquidityLocationSourceV2.js'), 'utf8');
    var requires = source.match(/require\(([^)]*)\)/g) || [];
    var modelDeps = requires.filter(function (line) {
        return line.indexOf('ai/') >= 0 || line.indexOf('deepseek') >= 0;
    });
    assert.deepStrictEqual(modelDeps, []);
});

test('the adapter never re-runs a detector: it exposes no detection surface', function () {
    ['step', 'detectStep', 'evaluatePivot', 'eligibleHistoricalPoints', 'rebuild', 'recompute']
        .forEach(function (name) {
            assert.strictEqual(typeof src[name], 'undefined', 'must not expose ' + name);
        });
});

// --------------------------------------------------------------- registry

test('registry stores in deterministic registration order and looks up by id', function () {
    var registry = reg.createRegistry();
    var eqh = realEq('HIGH');
    var eql = realEq('LOW');
    var a = src.adapt(eqh, { evaluationTime: eqh.confirmedAt }).candidate;
    var b = src.adapt(eql, { evaluationTime: eql.confirmedAt }).candidate;
    assert.strictEqual(registry.register(b), true);
    assert.strictEqual(registry.register(a), true);
    assert.strictEqual(registry.size(), 2);
    // registration order, NOT sorted order
    assert.deepStrictEqual(registry.list().map(function (c) { return c.id; }), [b.id, a.id]);
    assert.strictEqual(registry.getById(a.id).id, a.id);
    assert.strictEqual(registry.has(a.id), true);
    assert.strictEqual(registry.getById('nope'), null);
});

test('registry finds by side, by source type and by source identity', function () {
    var registry = reg.createRegistry();
    var eqh = realEq('HIGH');
    var eql = realEq('LOW');
    registry.register(src.adapt(eqh, { evaluationTime: eqh.confirmedAt }).candidate);
    registry.register(src.adapt(eql, { evaluationTime: eql.confirmedAt }).candidate);
    assert.strictEqual(registry.findBySide('BUY_SIDE').length, 1);
    assert.strictEqual(registry.findBySide('SELL_SIDE').length, 1);
    assert.strictEqual(registry.findBySide('LONG').length, 0);
    assert.strictEqual(registry.findBySourceType('EQ').length, 2);
    assert.strictEqual(registry.findBySourceType('STRUCTURAL_SWING').length, 0);
    assert.strictEqual(registry.getBySourceId('EQ', eqh.id).sourceProvenance.sourceId, eqh.id);
});

test('registry is duplicate-safe and reports content conflicts', function () {
    var registry = reg.createRegistry();
    var eq = realEq('HIGH');
    var k = src.adapt(eq, { evaluationTime: eq.confirmedAt }).candidate;
    assert.strictEqual(registry.register(k), true);
    assert.strictEqual(registry.register(k), false);
    assert.strictEqual(registry.size(), 1);
    assert.strictEqual(registry.stats().duplicates, 1);
    assert.strictEqual(registry.stats().conflicts, 0);

    var conflicting = JSON.parse(JSON.stringify(k));
    conflicting.location.referencePrice = k.location.referencePrice + 1;
    assert.strictEqual(registry.register(conflicting), false);
    assert.strictEqual(registry.size(), 1);
    assert.strictEqual(registry.stats().conflicts, 1);
    assert.deepStrictEqual(registry.stats().conflictIds, [k.id]);
});

test('registry rejects malformed candidates instead of storing them', function () {
    var registry = reg.createRegistry();
    assert.strictEqual(registry.register(null), false);
    assert.strictEqual(registry.register({ id: 'x' }), false);
    assert.strictEqual(registry.size(), 0);
    assert.strictEqual(registry.stats().rejected, 2);
});

test('registry serialization round-trips losslessly and is restart-safe', function () {
    var registry = reg.createRegistry();
    var eqh = realEq('HIGH');
    var eql = realEq('LOW');
    var a = src.adapt(eqh, { evaluationTime: eqh.confirmedAt }).candidate;
    var b = src.adapt(eql, { evaluationTime: eql.confirmedAt }).candidate;
    registry.register(a);
    registry.register(b);

    var snapshot = JSON.parse(JSON.stringify(registry.toJSON()));
    var restored = reg.fromJSON(snapshot);
    assert.strictEqual(restored.size(), 2);
    assert.deepStrictEqual(restored.list().map(function (c) { return c.id; }), [a.id, b.id]);
    assert.strictEqual(cand.stableSerialize(restored.getById(a.id)), cand.stableSerialize(a));
    // re-registering a restored candidate is a no-op (idempotent restart)
    assert.strictEqual(restored.register(a), false);
    assert.strictEqual(restored.size(), 2);
    // a foreign payload loads nothing rather than guessing
    assert.strictEqual(reg.createRegistry().load({ version: 'OTHER', order: [], candidates: {} }), 0);
});

test('registry exposes no lifecycle or mutation surface', function () {
    var registry = reg.createRegistry();
    ['update', 'applyLifecycleEvent', 'getActive', 'getByStatus', 'markTaken', 'setStatus']
        .forEach(function (name) {
            assert.strictEqual(typeof registry[name], 'undefined', 'must not expose ' + name);
        });
    var eq = realEq('HIGH');
    var k = src.adapt(eq, { evaluationTime: eq.confirmedAt }).candidate;
    registry.register(k);
    assert.strictEqual(registry.getById(k.id).status, undefined);
});

// -------------------------------------------------- shadow failure isolation

test('shadowAttach never throws even when the registry fails', function () {
    var broken = { register: function () { throw new Error('registry boom'); } };
    var summary = src.shadowAttach(broken, [realEq('HIGH')], { evaluationTime: 1e15 });
    assert.strictEqual(summary.failed, true);
    assert.ok(summary.failureDetail.indexOf('registry boom') >= 0);
});

test('shadowAttach on a broken source list degrades to zero without throwing', function () {
    var registry = reg.createRegistry();
    var summary = src.shadowAttach(registry, [null, undefined, 42], { evaluationTime: 1e15 });
    assert.strictEqual(summary.failed, false);
    assert.strictEqual(summary.considered, 3);
    assert.strictEqual(summary.adapted, 0);
    assert.strictEqual(summary.rejected, 3);
    assert.strictEqual(registry.size(), 0);
});

test('shadowAttach registers adapted candidates and is idempotent on replay', function () {
    var registry = reg.createRegistry();
    var eq = realEq('HIGH');
    var first = src.shadowAttach(registry, [eq], { evaluationTime: eq.confirmedAt });
    assert.strictEqual(first.registered, 1);
    var second = src.shadowAttach(registry, [eq], { evaluationTime: eq.confirmedAt });
    assert.strictEqual(second.registered, 0);
    assert.strictEqual(second.duplicates, 1);
    assert.strictEqual(registry.size(), 1);
});

// ------------------------------------- shadow does not perturb production EQ

function largestFiveMinuteCache(symbol) {
    var dir = path.join(ROOT, 'data-cache');
    if (!fs.existsSync(dir)) return null;
    var best = null;
    fs.readdirSync(dir).forEach(function (name) {
        if (name.indexOf(symbol + '_5m_') !== 0 || !/\.json$/.test(name)) return;
        var full = path.join(dir, name);
        var size = fs.statSync(full).size;
        if (!best || size > best.size) best = { path: full, size: size };
    });
    return best;
}

var parityCache = largestFiveMinuteCache('BTCUSDT');
if (!parityCache) {
    skip('attaching the V2 shadow registry does not change production EQ output',
        'no BTCUSDT 5m cache');
} else {
    test('attaching the V2 shadow registry does not change production EQ output', function () {
        var prefixReplay = require(path.join(ROOT, 'research',
            'historical-turning-point-significance-v1', 'lib', 'prefixReplayV1'));
        var replay = require(path.join(ROOT, 'replay', 'replayState'));
        var candles = JSON.parse(fs.readFileSync(parityCache.path, 'utf8')).slice(0, 2000);

        var baseline = prefixReplay.runPrefixReplay(candles, { symbol: 'BTCUSDT' });
        assert.ok(baseline.equalLiquidity.length > 0, 'fixture must emit EQ');

        // Attach the V2 shadow registry to every EQ the production pipeline
        // emits, then prove the production output is byte-identical.
        var registry = reg.createRegistry();
        var originalIncremental = replay.incrementalLiquidity;
        replay.incrementalLiquidity = function (state, all, index, exchangeInfo, evaluationTime) {
            var before = state.productionEq.events.length;
            var added = originalIncremental(state, all, index, exchangeInfo, evaluationTime);
            for (var i = before; i < state.productionEq.events.length; i++) {
                src.shadowAttach(registry, [state.productionEq.events[i]],
                    { evaluationTime: evaluationTime });
            }
            return added;
        };
        var perturbed;
        try {
            perturbed = prefixReplay.runPrefixReplay(candles, { symbol: 'BTCUSDT' });
        } finally {
            replay.incrementalLiquidity = originalIncremental;
        }

        assert.strictEqual(perturbed.equalLiquidity.length, baseline.equalLiquidity.length);
        assert.strictEqual(cand.stableSerialize(perturbed.equalLiquidity),
            cand.stableSerialize(baseline.equalLiquidity));
        assert.strictEqual(registry.size(), baseline.equalLiquidity.length);
    });
}

// ---------------------------------------------------------------- summary

console.log('');
if (failed > 0) {
    console.log('LIQUIDITY LOCATION MODEL V2 PHASE 1: ' + failed + ' FAILED of ' + (passed + failed));
    process.exit(1);
}
console.log('ALL LIQUIDITY LOCATION MODEL V2 PHASE 1 TESTS PASSED'
    + ' (' + passed + ' passed, ' + skipped + ' skipped)');
