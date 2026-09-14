'use strict';

/**
 * TURNING_SEMANTIC_TESTS — HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 contract and
 * canary gate (spec §32-§34, §53, §66).
 */

var assert = require('assert');
var contract = require('../semantic/turningPointSignificanceSemanticV1');

var passed = 0;
function check(name, fn) { fn(); passed += 1; console.log('PASS ' + name); }

function decision(significance, confidence, reason) {
    return {
        significance: significance,
        confidence: confidence,
        primaryReason: reason || 'INDEPENDENT_DIRECTIONAL_TURN',
        evidence: ['deterministic fact based evidence'],
        counterEvidence: []
    };
}

check('1. SIGNIFICANT + HIGH is eligible', function () {
    var gate = contract.evaluateGate(decision('SIGNIFICANT', 'HIGH'));
    assert.strictEqual(gate.result, 'PASS');
    assert.strictEqual(gate.reason, null);
});

check('2. VALID + HIGH is eligible', function () {
    assert.strictEqual(contract.evaluateGate(decision('VALID', 'HIGH')).result, 'PASS');
});

check('3. SIGNIFICANT + MEDIUM is eligible', function () {
    var gate = contract.evaluateGate(decision('SIGNIFICANT', 'MEDIUM'));
    assert.strictEqual(gate.result, 'PASS');
    assert.strictEqual(gate.reason, null);
});

check('4. SIGNIFICANT + LOW is blocked', function () {
    assert.strictEqual(contract.evaluateGate(decision('SIGNIFICANT', 'LOW')).result, 'BLOCK');
});

check('5. VALID + MEDIUM is eligible', function () {
    assert.strictEqual(contract.evaluateGate(decision('VALID', 'MEDIUM')).result, 'PASS');
});

check('6. VALID + LOW is blocked', function () {
    assert.strictEqual(contract.evaluateGate(decision('VALID', 'LOW')).result, 'BLOCK');
});

check('7. WEAK at any confidence is blocked', function () {
    ['HIGH', 'MEDIUM', 'LOW'].forEach(function (confidence) {
        var gate = contract.evaluateGate(decision('WEAK', confidence));
        assert.strictEqual(gate.result, 'BLOCK');
        assert.strictEqual(gate.reason, 'TURNING_SIGNIFICANCE_WEAK');
    });
});

check('8. UNCLEAR at any confidence is blocked', function () {
    ['HIGH', 'MEDIUM', 'LOW'].forEach(function (confidence) {
        var gate = contract.evaluateGate(decision('UNCLEAR', confidence));
        assert.strictEqual(gate.result, 'BLOCK');
        assert.strictEqual(gate.reason, 'TURNING_SIGNIFICANCE_UNCLEAR');
    });
});

check('9. an unavailable / non-schema decision is blocked as SEMANTIC_INVALID', function () {
    assert.strictEqual(contract.evaluateGate(null).result, 'BLOCK');
    assert.strictEqual(contract.evaluateGate(null).reason, 'TURNING_SIGNIFICANCE_SEMANTIC_INVALID');
    assert.strictEqual(contract.evaluateGate({ significance: 'SIGNIFICANT' }).result, 'BLOCK');
});

check('9b. confidence is an ordered minimum threshold, not exact equality', function () {
    var mediumPolicy = { allowedLabels: ['SIGNIFICANT', 'VALID'], minimumConfidence: 'MEDIUM' };
    assert.strictEqual(contract.evaluateGate(decision('VALID', 'MEDIUM'), mediumPolicy).result, 'PASS');
    assert.strictEqual(contract.evaluateGate(decision('VALID', 'HIGH'), mediumPolicy).result, 'PASS');
    var low = contract.evaluateGate(decision('VALID', 'LOW'), mediumPolicy);
    assert.strictEqual(low.result, 'BLOCK');
    assert.strictEqual(low.reason, 'TURNING_SIGNIFICANCE_CONFIDENCE_BELOW_MINIMUM');
});

check('9c. an invalid deterministic policy fails closed', function () {
    var gate = contract.evaluateGate(decision('VALID', 'HIGH'), {
        allowedLabels: ['SIGNIFICANT', 'VALID'], minimumConfidence: 'CERTAIN'
    });
    assert.strictEqual(gate.result, 'BLOCK');
    assert.strictEqual(gate.reason, 'TURNING_SIGNIFICANCE_POLICY_INVALID');
});

check('10. schema rejects every out-of-contract shape', function () {
    function code(fn) { try { fn(); } catch (error) { return error.code; } return null; }

    var unknownSignificance = decision('MAJOR', 'HIGH');
    assert.strictEqual(code(function () { contract.validateDecision(unknownSignificance); }),
        'TURNING_SIGNIFICANCE_LABEL_INVALID');

    var unknownConfidence = decision('VALID', 'CERTAIN');
    assert.strictEqual(code(function () { contract.validateDecision(unknownConfidence); }),
        'TURNING_SIGNIFICANCE_CONFIDENCE_INVALID');

    var unknownReason = decision('VALID', 'HIGH', 'LOOKS_GOOD');
    assert.strictEqual(code(function () { contract.validateDecision(unknownReason); }),
        'TURNING_SIGNIFICANCE_PRIMARY_REASON_INVALID');

    var extraKey = decision('VALID', 'HIGH');
    extraKey.entry = 100;
    assert.strictEqual(code(function () { contract.validateDecision(extraKey); }),
        'TURNING_SIGNIFICANCE_OUTPUT_SCHEMA_INVALID');

    var missing = decision('VALID', 'HIGH');
    delete missing.counterEvidence;
    assert.strictEqual(code(function () { contract.validateDecision(missing); }),
        'TURNING_SIGNIFICANCE_OUTPUT_SCHEMA_INVALID');

    var emptyEvidence = decision('VALID', 'HIGH');
    emptyEvidence.evidence = [''];
    assert.strictEqual(code(function () { contract.validateDecision(emptyEvidence); }),
        'TURNING_SIGNIFICANCE_EVIDENCE_INVALID');

    var notArray = decision('VALID', 'HIGH');
    notArray.counterEvidence = 'none';
    assert.strictEqual(code(function () { contract.validateDecision(notArray); }),
        'TURNING_SIGNIFICANCE_COUNTEREVIDENCE_INVALID');

    var otherWithoutEvidence = decision('VALID', 'HIGH', 'OTHER');
    otherWithoutEvidence.evidence = [];
    assert.strictEqual(code(function () { contract.validateDecision(otherWithoutEvidence); }),
        'TURNING_SIGNIFICANCE_OTHER_EXPLANATION_REQUIRED');
});

check('11. OTHER with an explanation is accepted', function () {
    var value = decision('VALID', 'HIGH', 'OTHER');
    assert.strictEqual(contract.validateDecision(value).primaryReason, 'OTHER');
});

check('12. malformed JSON is rejected without inventing a decision', function () {
    assert.throws(function () { contract.parseDecision('not json'); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_MALFORMED_JSON'; });
});

check('13. decision keys are canonically ordered', function () {
    var validated = contract.validateDecision(decision('VALID', 'HIGH'));
    assert.deepStrictEqual(Object.keys(validated).sort(),
        ['confidence', 'counterEvidence', 'evidence', 'primaryReason', 'significance']);
});

check('14. model identity accepts the documented alias and rejects anything else', function () {
    assert.strictEqual(contract.validateModelIdentity('deepseek-v4-flash', 'deepseek-v4-flash'),
        'deepseek-v4-flash');
    assert.strictEqual(contract.validateModelIdentity('deepseek-v4-flash', 'deepseek-flash'),
        'deepseek-v4-flash|deepseek-flash');
    assert.throws(function () { contract.validateModelIdentity('deepseek-v4-flash', 'gpt-4o'); },
        function (error) { return error.code === 'TURNING_SIGNIFICANCE_UNEXPECTED_RESPONSE_MODEL_ID'; });
});

check('15. prompt and schema hashes are frozen', function () {
    assert.strictEqual(contract.PROMPT_SHA256,
        'e1962266a20c67182dc11859d0b68f1b166dd3beddb591727f4a92ce5cf917e0');
    assert.strictEqual(contract.SCHEMA_SHA256,
        '43cde0b84a26136472b3f2353ffc4fc7e8eefe07363d18a2c5e3e126276caa50');
    assert.strictEqual(contract.sha256(contract.PROMPT_TEMPLATE), contract.PROMPT_SHA256);
    assert.strictEqual(contract.sha256(contract.stableSerialize(contract.SCHEMA)),
        contract.SCHEMA_SHA256);
});

check('16. version identifiers are exactly as specified', function () {
    assert.strictEqual(contract.VERSION, 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1');
    assert.strictEqual(contract.PROMPT_VERSION, 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_PROMPT_V1');
    assert.strictEqual(contract.MODEL, 'deepseek-v4-flash');
    assert.strictEqual(contract.RESPONSE_MODEL_ALIAS, 'deepseek-flash');
});

check('17. prompt forbids the trading vocabulary the LLM must never emit', function () {
    var prompt = contract.SYSTEM_PROMPT;
    ['TRADE', 'NO_TRADE', 'BUY', 'SELL', 'Entry', 'SL', 'TP', 'position size',
        'expected return', 'future target', 'probability of profit'].forEach(function (token) {
        assert.ok(prompt.indexOf(token) >= 0, 'prompt must explicitly forbid: ' + token);
    });
    assert.ok(/Do not consider future performance/.test(prompt));
    assert.ok(/INTRINSIC SIGNIFICANCE/.test(prompt));
});

check('18. prompt forbids single-feature hard pass / hard veto', function () {
    var prompt = contract.SYSTEM_PROMPT;
    assert.ok(/DO NOT use any single feature as a hard pass or hard veto/.test(prompt));
    assert.ok(/large incoming move does not automatically mean SIGNIFICANT/.test(prompt));
    assert.ok(/causal pivot role does not automatically mean SIGNIFICANT/.test(prompt));
    assert.ok(/absence of a structure break does not automatically mean WEAK/.test(prompt));
});

check('19. prompt forbids rewriting the deterministic location/time facts', function () {
    // The semantic question must be about significance only; the prompt scope
    // excludes discovering, moving or re-timing a turning point.
    assert.strictEqual(contract.SIGNIFICANCE.length, 4);
    assert.deepStrictEqual(contract.SIGNIFICANCE, ['SIGNIFICANT', 'VALID', 'WEAK', 'UNCLEAR']);
    assert.deepStrictEqual(contract.CONFIDENCE, ['HIGH', 'MEDIUM', 'LOW']);
    assert.strictEqual(contract.REASONS.length, 12);
    ['INDEPENDENT_DIRECTIONAL_TURN', 'STRONG_REVERSAL_WITH_STRUCTURAL_CHANGE',
        'EFFICIENT_REVERSAL_FROM_EXTREME', 'STRUCTURALLY_MEANINGFUL_CONTROL_POINT',
        'VALID_LOCAL_TURN_WITH_CLEAR_REVERSAL', 'LOCAL_REVERSAL_WITH_LIMITED_SIGNIFICANCE',
        'WEAK_OR_CHOPPY_REVERSAL', 'INCOMING_PROCESS_NOT_DISTINCT',
        'REVERSAL_NOT_INDEPENDENT_ENOUGH', 'CONFLICTING_EVIDENCE',
        'INSUFFICIENT_PROVENANCE', 'OTHER'].forEach(function (reason) {
        assert.ok(contract.REASONS.indexOf(reason) >= 0, 'missing reason: ' + reason);
    });
});

check('20. the schema advertises the exact frozen output contract', function () {
    assert.deepStrictEqual(contract.SCHEMA.required.slice().sort(),
        ['confidence', 'counterEvidence', 'evidence', 'primaryReason', 'significance']);
    assert.strictEqual(contract.SCHEMA.additionalProperties, false);
    assert.deepStrictEqual(contract.SCHEMA.properties.significance.enum, contract.SIGNIFICANCE);
    assert.deepStrictEqual(contract.SCHEMA.properties.confidence.enum, contract.CONFIDENCE);
    assert.deepStrictEqual(contract.SCHEMA.properties.primaryReason.enum, contract.REASONS);
});

console.log('\nTURNING_SEMANTIC_TESTS=PASS (' + passed + ' checks)');
