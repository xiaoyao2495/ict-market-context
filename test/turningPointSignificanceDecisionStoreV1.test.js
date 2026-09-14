'use strict';

/**
 * FROZEN_STORE_TESTS — HISTORICAL_TURNING_POINT_SIGNIFICANCE_FROZEN_STORE_V1
 * and the raw-response-before-parse lifecycle (spec §37-§42, §67).
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var fixtures = require('./fixtures/turningPointSignificanceV1');
var contract = require('../semantic/turningPointSignificanceSemanticV1');
var storeModule = require('../semantic/turningPointSignificanceDecisionStoreV1');
var serviceModule = require('../live/turningPointSignificanceSemanticV1');

var passed = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(function () { passed += 1; console.log('PASS ' + name); }); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (ignore) {} }

var CLOSES = fixtures.highTurningSeries({ up: 20, down: 5, start: 1000, step: 10 });
var CANDLES = fixtures.buildSeries(CLOSES, { pad: 5, step: 10 });
var CANDIDATE = fixtures.makeCandidate(CANDLES, {
    side: 'HIGH', selectorIndex: 20, localizedIndex: 20, confirmationIndex: 25, processStartIndex: 0
});

function source() {
    return {
        candles: CANDLES,
        state: { swings: [], displacementStore: { getAsOf: function () { return []; } } }
    };
}
function decisionOf(significance, confidence, reason) {
    return {
        significance: significance || 'SIGNIFICANT',
        confidence: confidence || 'HIGH',
        primaryReason: reason || 'INDEPENDENT_DIRECTIONAL_TURN',
        evidence: ['frozen evidence'],
        counterEvidence: []
    };
}
function rawResponse(decision) {
    return {
        rawContent: JSON.stringify(decision),
        rawResponseModelId: 'deepseek-flash',
        usage: { promptTokens: 501, completionTokens: 42, totalTokens: 543 },
        finishReason: 'stop'
    };
}
var CONFIG = Object.freeze({
    semanticEnabled: true, liveFilterEnabled: true, failClosed: true,
    requiredConfidence: 'HIGH', allowedLabels: Object.freeze(['SIGNIFICANT', 'VALID'])
});

function makeService(store, options) {
    var opts = options || {};
    var events = [];
    var service = serviceModule.createService({
        config: CONFIG, store: store,
        buildFacts: opts.buildFacts,
        request: opts.request || function () { return Promise.resolve(rawResponse(decisionOf())); },
        observe: function (record) { events.push(record); },
        archive: opts.archive,
        now: opts.now
    });
    return { service: service, events: events };
}

var checks = [];

checks.push(check('1. identical facts produce a decisionKey that is stable and content-bound', function () {
    var identity = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
        turningPointId: 'TP1', processId: 'P1', facts: { a: 1, b: [1, 2] },
        promptHash: contract.PROMPT_SHA256, promptVersion: contract.PROMPT_VERSION,
        requestedModelId: contract.MODEL });
    var again = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
        turningPointId: 'TP1', processId: 'P1', facts: { b: [1, 2], a: 1 },
        promptHash: contract.PROMPT_SHA256, promptVersion: contract.PROMPT_VERSION,
        requestedModelId: contract.MODEL });
    assert.strictEqual(identity.decisionKey, again.decisionKey, 'key must ignore input key order');
    var changedFacts = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
        turningPointId: 'TP1', processId: 'P1', facts: { a: 2, b: [1, 2] },
        promptHash: contract.PROMPT_SHA256, promptVersion: contract.PROMPT_VERSION,
        requestedModelId: contract.MODEL });
    assert.notStrictEqual(identity.decisionKey, changedFacts.decisionKey, 'factsHash must bind');
    var changedPrompt = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
        turningPointId: 'TP1', processId: 'P1', facts: { a: 1, b: [1, 2] },
        promptHash: 'x'.repeat(64), promptVersion: contract.PROMPT_VERSION,
        requestedModelId: contract.MODEL });
    assert.notStrictEqual(identity.decisionKey, changedPrompt.decisionKey, 'promptHash must bind');
    var changedModel = storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
        turningPointId: 'TP1', processId: 'P1', facts: { a: 1, b: [1, 2] },
        promptHash: contract.PROMPT_SHA256, promptVersion: contract.PROMPT_VERSION,
        requestedModelId: 'other-model' });
    assert.notStrictEqual(identity.decisionKey, changedModel.decisionKey, 'requestedModelId must bind');
    assert.throws(function () {
        storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
            turningPointId: 'TP1', processId: null, facts: {}, promptHash: contract.PROMPT_SHA256,
            promptVersion: contract.PROMPT_VERSION, requestedModelId: contract.MODEL });
    }, function (error) { return error.code === 'TURNING_SIGNIFICANCE_IDENTITY_SOURCE_INVALID'; });
    assert.throws(function () {
        storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
            turningPointId: 'TP1', processId: 'P1', facts: {}, promptHash: '',
            promptVersion: contract.PROMPT_VERSION, requestedModelId: contract.MODEL });
    }, function (error) { return error.code === 'TURNING_SIGNIFICANCE_IDENTITY_PROMPTHASH_INVALID'; });
    assert.throws(function () {
        storeModule.buildIdentity({ semanticVersion: contract.VERSION, symbol: 'TESTUSDT',
            turningPointId: 'TP1', processId: 'P1', facts: {}, promptHash: contract.PROMPT_SHA256,
            promptVersion: contract.PROMPT_VERSION, requestedModelId: '' });
    }, function (error) { return error.code === 'TURNING_SIGNIFICANCE_IDENTITY_REQUESTEDMODELID_INVALID'; });
}));

checks.push(check('2. raw response is persisted BEFORE parse and is byte-verifiable', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-store-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var calls = 0;
        var machine = makeService(store, { request: function () { calls += 1; return Promise.resolve(rawResponse(decisionOf())); } });
        return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
            assert.strictEqual(calls, 1);
            assert.strictEqual(result.status, 'AVAILABLE');
            var rawPath = store.rawPath(result.decisionKey);
            var decisionPath = store.decisionPath(result.decisionKey);
            assert.ok(fs.existsSync(rawPath), 'raw response must exist');
            assert.ok(fs.existsSync(decisionPath), 'frozen decision must exist');
            var raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
            assert.strictEqual(raw.rawContent, JSON.stringify(decisionOf()));
            assert.strictEqual(raw.rawContentSha256, contract.sha256(raw.rawContent));
            assert.strictEqual(raw.usage.totalTokens, 543);
            assert.strictEqual(raw.finishReason, 'stop');
            assert.strictEqual(raw.requestedModelId, contract.MODEL);
            assert.strictEqual(raw.rawResponseModelId, 'deepseek-flash');
            assert.strictEqual(raw.normalizedModelIdentity, contract.MODEL + '|' + contract.RESPONSE_MODEL_ALIAS);
            var text = fs.readFileSync(rawPath, 'utf8') + fs.readFileSync(decisionPath, 'utf8');
            ['api_key', 'apiKey', 'DEEPSEEK_API_KEY', 'Authorization', 'Bearer', 'cookie', 'secret']
                .forEach(function (token) { assert.strictEqual(text.indexOf(token), -1, 'secret leaked: ' + token); });
            var eventNames = machine.events.map(function (e) { return e.event; });
            assert.ok(eventNames.indexOf('TURNING_SIGNIFICANCE_CACHE_MISS') >= 0);
            assert.ok(eventNames.indexOf('TURNING_SIGNIFICANCE_RAW_PERSISTED') >= 0);
            assert.ok(eventNames.indexOf('TURNING_SIGNIFICANCE_FROZEN') >= 0);
            assert.ok(eventNames.indexOf('TURNING_SIGNIFICANCE_ANCHOR_ELIGIBLE') >= 0);
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('3. same facts re-evaluate as CACHE_HIT with zero further LLM calls', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-hit-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var calls = 0;
        var request = function () { calls += 1; return Promise.resolve(rawResponse(decisionOf())); };
        return makeService(store, { request: request }).service.evaluate(CANDIDATE, source())
            .then(function (first) {
                assert.strictEqual(calls, 1);
                var machine = makeService(store, { request: request });
                return machine.service.evaluate(CANDIDATE, source()).then(function (second) {
                    assert.strictEqual(calls, 1, 'a cache hit must not call the model again');
                    assert.strictEqual(second.decisionSource, 'FROZEN_STORE');
                    assert.strictEqual(second.decisionKey, first.decisionKey);
                    assert.deepStrictEqual(second.decision, first.decision);
                    assert.ok(machine.events.map(function (e) { return e.event; })
                        .indexOf('TURNING_SIGNIFICANCE_CACHE_HIT') >= 0);
                });
            }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('4. restart reproduces CACHE_HIT and restores eligibility without the model', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-restart-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var calls = 0;
        var request = function () { calls += 1; return Promise.resolve(rawResponse(decisionOf('VALID', 'HIGH'))); };
        return makeService(store, { request: request }).service.evaluate(CANDIDATE, source())
            .then(function () {
                assert.strictEqual(calls, 1);
                // Simulated restart: brand new store and brand new service.
                var restarted = storeModule.createStore({ directory: dir });
                var machine = makeService(restarted, { request: request });
                var restored = machine.service.restoreEligibility();
                assert.strictEqual(restored, 1);
                assert.strictEqual(machine.service.eligibilityOf(CANDIDATE.id).eligible, true);
                return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
                    assert.strictEqual(calls, 1, 'restart must not re-ask the model');
                    assert.strictEqual(result.decisionSource, 'FROZEN_STORE');
                    assert.strictEqual(result.eligible, true);
                });
            }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('5. schema-invalid response keeps the raw, blocks the anchor, and never re-rolls', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-invalid-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var calls = 0;
        var bad = { significance: 'MAJOR', confidence: 'HIGH', primaryReason: 'INDEPENDENT_DIRECTIONAL_TURN',
            evidence: ['x'], counterEvidence: [] };
        var request = function () { calls += 1; return Promise.resolve(rawResponse(bad)); };
        var machine = makeService(store, { request: request });
        return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
            assert.strictEqual(calls, 1);
            assert.strictEqual(result.status, 'UNAVAILABLE');
            assert.strictEqual(result.eligible, false);
            assert.strictEqual(result.gateResult, 'BLOCK');
            assert.strictEqual(result.errorCode, 'TURNING_SIGNIFICANCE_LABEL_INVALID');
            var files = fs.readdirSync(path.join(dir, 'raw-responses'));
            assert.strictEqual(files.length, 1, 'the invalid raw response must still be archived');
            assert.ok(!fs.existsSync(path.join(dir, 'decisions')) ||
                fs.readdirSync(path.join(dir, 'decisions')).length === 0,
                'an invalid response must not create a frozen decision');
            assert.ok(machine.events.map(function (e) { return e.event; })
                .indexOf('TURNING_SIGNIFICANCE_ERROR') >= 0);
            // Re-evaluating must not roll the dice again.
            return machine.service.evaluate(CANDIDATE, source()).then(function (second) {
                assert.strictEqual(calls, 1, 'a schema-invalid response must never be re-rolled');
                assert.strictEqual(second.eligible, false);
            });
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('6. raw persistence failure blocks the anchor and never reaches parse', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-rawfail-'));
    return Promise.resolve().then(function () {
        var real = storeModule.createStore({ directory: dir });
        var broken = {
            lookup: real.lookup,
            lookupRaw: real.lookupRaw,
            rawPath: real.rawPath,
            decisionPath: real.decisionPath,
            listDecisionRecords: real.listDecisionRecords,
            persistRaw: function () {
                throw Object.assign(new Error('disk full'), { code: 'TURNING_SIGNIFICANCE_RAW_PERSIST_FAILED' });
            },
            freeze: real.freeze
        };
        // Deliberately unparseable: if parse ran we would see MALFORMED_JSON
        // instead of the persistence failure, which is exactly the ordering we
        // are asserting.
        var request = function () {
            return Promise.resolve({ rawContent: 'this is not json',
                rawResponseModelId: 'deepseek-flash', usage: {}, finishReason: null });
        };
        return makeService(broken, { request: request }).service.evaluate(CANDIDATE, source())
            .then(function (result) {
                assert.strictEqual(result.status, 'UNAVAILABLE');
                assert.strictEqual(result.eligible, false);
                assert.strictEqual(result.errorCode, 'TURNING_SIGNIFICANCE_RAW_PERSIST_FAILED');
                assert.notStrictEqual(result.errorCode, 'TURNING_SIGNIFICANCE_MALFORMED_JSON');
                assert.strictEqual(result.decision, null);
                assert.ok(!fs.existsSync(path.join(dir, 'decisions')));
            }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('7. a transport failure fails closed without pausing anything', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-outage-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var request = function () {
            return Promise.reject(Object.assign(new Error('DeepSeek outage'), { code: 'NETWORK_ERROR' }));
        };
        var machine = makeService(store, { request: request });
        return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
            assert.strictEqual(result.status, 'UNAVAILABLE');
            assert.strictEqual(result.eligible, false);
            assert.strictEqual(result.gateResult, 'BLOCK');
            assert.strictEqual(result.gateReason, 'TURNING_SIGNIFICANCE_SEMANTIC_UNAVAILABLE');
            assert.strictEqual(result.errorCode, 'NETWORK_ERROR');
            // The model identity mismatch and store corruption paths must behave
            // the same way: block one anchor, never throw outward.
            return machine.service.evaluate(Object.assign({}, CANDIDATE, { id: 'TPX' }), source());
        }).then(function (second) {
            assert.strictEqual(second.eligible, false);
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('8. a facts build failure fails closed', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-facts-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var machine = makeService(store, {
            buildFacts: function () {
                throw Object.assign(new Error('facts unavailable'), { code: 'TURNING_SIGNIFICANCE_FACT_SOURCE_MISSING' });
            }
        });
        return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
            assert.strictEqual(result.eligible, false);
            assert.strictEqual(result.errorCode, 'TURNING_SIGNIFICANCE_FACT_SOURCE_MISSING');
            assert.strictEqual(result.facts, null);
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('9. an unexpected response model identity blocks the anchor', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-model-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var response = rawResponse(decisionOf());
        response.rawResponseModelId = 'some-other-model';
        return makeService(store, { request: function () { return Promise.resolve(response); } })
            .service.evaluate(CANDIDATE, source()).then(function (result) {
                assert.strictEqual(result.eligible, false);
                assert.strictEqual(result.status, 'UNAVAILABLE');
                assert.strictEqual(result.decision, null);
                assert.strictEqual(result.errorCode, 'TURNING_SIGNIFICANCE_UNEXPECTED_RESPONSE_MODEL_ID');
                // The raw response is still retained for audit before the identity
                // check rejects it.
                assert.strictEqual(fs.readdirSync(path.join(dir, 'raw-responses')).length, 1);
                assert.ok(!fs.existsSync(path.join(dir, 'decisions')) ||
                    fs.readdirSync(path.join(dir, 'decisions')).length === 0);
            }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('10. a corrupt decision file is detected rather than trusted', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-corrupt-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        return makeService(store).service.evaluate(CANDIDATE, source()).then(function (result) {
            var file = store.decisionPath(result.decisionKey);
            var record = JSON.parse(fs.readFileSync(file, 'utf8'));
            record.facts.incomingProcess.moveAtr = 999999;   // tamper with frozen facts
            fs.writeFileSync(file, JSON.stringify(record));
            assert.throws(function () { store.lookup({
                decisionKey: result.decisionKey, factsHash: result.factsHash,
                decisionKeyFields: { promptHash: contract.PROMPT_SHA256,
                    requestedModelId: contract.MODEL, turningPointId: CANDIDATE.id,
                    processId: CANDIDATE.processId }
            }); }, function (error) { return error.code === 'TURNING_SIGNIFICANCE_DECISION_STORE_CORRUPT'; });
            return true;
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('11. hydration is serial and de-duplicated per turning point', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-serial-'));
    return Promise.resolve().then(function () {
        var store = storeModule.createStore({ directory: dir });
        var concurrent = 0, maxConcurrent = 0, calls = 0;
        var request = function () {
            calls += 1; concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
            return new Promise(function (resolve) {
                setTimeout(function () {
                    concurrent -= 1;
                    resolve(rawResponse(decisionOf('VALID', 'HIGH')));
                }, 1);
            });
        };
        var machine = makeService(store, { request: request });
        var second = Object.assign({}, CANDIDATE, { id: CANDIDATE.id + ':B' });
        var third = Object.assign({}, CANDIDATE, { id: CANDIDATE.id + ':C' });
        return Promise.all([
            machine.service.enqueue(CANDIDATE, source()),
            machine.service.enqueue(CANDIDATE, source()),
            machine.service.enqueue(second, source()),
            machine.service.enqueue(third, source())
        ]).then(function () {
            assert.strictEqual(maxConcurrent, 1, 'hydration must be strictly serial');
            assert.strictEqual(calls, 3, 'a duplicate request for one turning point must be coalesced');
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('12. the archive records blocks with their candidate context', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-archive-'));
    return Promise.resolve().then(function () {
        var written = [];
        var store = storeModule.createStore({ directory: dir });
        var machine = makeService(store, {
            request: function () { return Promise.resolve(rawResponse(decisionOf('WEAK', 'HIGH', 'WEAK_OR_CHOPPY_REVERSAL'))); },
            archive: function (record) { written.push(record); return 'archived'; }
        });
        return machine.service.evaluate(CANDIDATE, source()).then(function (result) {
            assert.strictEqual(result.eligible, false);
            assert.strictEqual(result.gateReason, 'TURNING_SIGNIFICANCE_WEAK');
            assert.strictEqual(written.length, 1);
            assert.strictEqual(written[0].eligible, false);
            assert.strictEqual(written[0].significance, 'WEAK');
            assert.strictEqual(written[0].turningPointId, CANDIDATE.id);
            assert.strictEqual(written[0].processId, CANDIDATE.processId);
            assert.strictEqual(written[0].semanticTask, contract.VERSION);
            assert.ok(written[0].factsHash && written[0].promptHash && written[0].decisionKey);
        }).then(function () { cleanup(dir); });
    });
}));

checks.push(check('13. the case archive writes create-only block and candidate files', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-case-'));
    var caseArchive = require('../semantic/turningPointSignificanceCaseArchiveV1');
    var archive = caseArchive.createArchive({ directory: dir });
    var blocked = archive.write({ eligible: false, decisionKey: 'a'.repeat(64), turningPointId: 'TP1' });
    assert.ok(/TURNING_SIGNIFICANCE_BLOCK_CASE_/.test(path.basename(blocked)));
    var qualified = archive.write({ eligible: true, decisionKey: 'b'.repeat(64), turningPointId: 'TP2' });
    assert.ok(/TURNING_SIGNIFICANCE_CANDIDATE_CASE_/.test(path.basename(qualified)));
    fs.writeFileSync(blocked, 'tampered');
    archive.write({ eligible: false, decisionKey: 'a'.repeat(64), turningPointId: 'TP1' });
    assert.strictEqual(fs.readFileSync(blocked, 'utf8'), 'tampered',
        'an existing archive record must never be overwritten');
    cleanup(dir);
}));

checks.push(check('14. the config refuses a live filter without semantic evaluation', function () {
    var loadConfig = require('../config/turningPointSignificanceV1').loadConfig;
    assert.throws(function () {
        loadConfig({ TURNING_SIGNIFICANCE_SEMANTIC_ENABLED: 'false', TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED: 'true' });
    }, function (error) { return /LIVE_FILTER_REQUIRES_SEMANTIC_ENABLED/.test(error.message); });
    assert.throws(function () {
        loadConfig({ TURNING_SIGNIFICANCE_FAIL_CLOSED: 'false' });
    }, function (error) { return /FAIL_CLOSED_MUST_BE_TRUE/.test(error.message); });
    assert.throws(function () {
        loadConfig({ TURNING_SIGNIFICANCE_REQUIRED_CONFIDENCE: 'MEDIUM' });
    }, function (error) { return /REQUIRED_CONFIDENCE_MUST_BE_HIGH/.test(error.message); });
    assert.throws(function () {
        loadConfig({ TURNING_SIGNIFICANCE_ALLOWED_LABELS: 'SIGNIFICANT' });
    }, function (error) { return /ALLOWED_LABELS_MUST_BE/.test(error.message); });
    var rollback = loadConfig({ TURNING_SIGNIFICANCE_LIVE_FILTER_ENABLED: 'false' });
    assert.strictEqual(rollback.liveFilterEnabled, false);
    assert.strictEqual(rollback.semanticEnabled, true, 'shadow collection survives the rollback');
    var defaults = loadConfig({});
    assert.strictEqual(defaults.semanticEnabled, true);
    assert.strictEqual(defaults.liveFilterEnabled, true);
    assert.strictEqual(defaults.failClosed, true);
}));

checks.reduce(function (chain, next) { return chain.then(function () { return next; }); }, Promise.resolve())
    .then(function () {
        console.log('\nFROZEN_STORE_TESTS=PASS (' + passed + ' checks)');
    }).catch(function (error) {
        console.error('FROZEN_STORE_TESTS=FAIL');
        console.error(error && error.stack || error);
        process.exitCode = 1;
    });
