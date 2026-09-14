'use strict';

/**
 * HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1 — frozen semantic contract.
 *
 * Pure ICT principle: "透过 ICT 名词看本质" (look through the ICT vocabulary to
 * the essence). The DETERMINISTIC layer owns WHERE and WHEN a turning point
 * happened and what the objective numbers are. The SEMANTIC layer owns only HOW
 * IMPORTANT that already-confirmed turning point was at the moment it became
 * causally confirmed.
 *
 * Division of labour (hard boundary):
 *   CODE  : what happened / where / when confirmed / objective values
 *   LLM   : whether this already-confirmed turn was significant enough, in
 *           market semantics, to be preserved as a historical anchor
 *
 * The LLM is forbidden from discovering, creating, or mutating a turning point,
 * its prices, its occurredAt/confirmedAt, its localized wick, the Dynamic-D
 * process, theta, SAME_PROCESS_WICK_V1, 2L/2R, Entry/SL/TP, sizing, or orders.
 *
 * The question is INTRINSIC SIGNIFICANCE AS OF candidate.confirmedAt — never
 * current relevance, and never whether the future outcome was good.
 */

var crypto = require('crypto');

var VERSION = 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_V1';
var PROMPT_VERSION = 'HISTORICAL_TURNING_POINT_SIGNIFICANCE_PROMPT_V1';
var MODEL = 'deepseek-v4-flash';
var RESPONSE_MODEL_ALIAS = 'deepseek-flash';
var TEMPERATURE = 0;
var MAX_TOKENS = 4096;

var SIGNIFICANCE = ['SIGNIFICANT', 'VALID', 'WEAK', 'UNCLEAR'];
var CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
var REASONS = [
    'INDEPENDENT_DIRECTIONAL_TURN',
    'STRONG_REVERSAL_WITH_STRUCTURAL_CHANGE',
    'EFFICIENT_REVERSAL_FROM_EXTREME',
    'STRUCTURALLY_MEANINGFUL_CONTROL_POINT',
    'VALID_LOCAL_TURN_WITH_CLEAR_REVERSAL',
    'LOCAL_REVERSAL_WITH_LIMITED_SIGNIFICANCE',
    'WEAK_OR_CHOPPY_REVERSAL',
    'INCOMING_PROCESS_NOT_DISTINCT',
    'REVERSAL_NOT_INDEPENDENT_ENOUGH',
    'CONFLICTING_EVIDENCE',
    'INSUFFICIENT_PROVENANCE',
    'OTHER'
];

var OUTPUT_KEYS = ['significance', 'confidence', 'primaryReason', 'evidence', 'counterEvidence'].sort();

/** Machine-readable schema, exported for prompt-metadata.json (SCHEMA_SHA256). */
var SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['significance', 'confidence', 'primaryReason', 'evidence', 'counterEvidence'],
    properties: {
        significance: { enum: SIGNIFICANCE },
        confidence: { enum: CONFIDENCE },
        primaryReason: { enum: REASONS },
        evidence: { type: 'array', items: { type: 'string' } },
        counterEvidence: { type: 'array', items: { type: 'string' } }
    }
};

var SYSTEM_PROMPT = [
    'You classify the INTRINSIC SIGNIFICANCE of an already-confirmed historical turning point.',
    'Use only the supplied deterministic facts, all of which were available by the turning point confirmedAt.',
    'The question is: at the time this turning point became causally confirmed, did it represent a sufficiently',
    'independent and meaningful directional turning process to deserve preservation as a historical market anchor?',
    '',
    'You are NOT judging:',
    '- whether the turning point later turned out to be accurate,',
    '- how far price moved afterwards,',
    '- whether this is a trading signal or whether a trade should be taken.',
    'Do not consider future performance, profitability, entries, stops, targets, expected return, position size, or win probability.',
    '',
    'Labels:',
    'SIGNIFICANT: By confirmedAt the turn already shows a clear, independent, market-meaningful directional',
    'turning process with strong historical anchor value.',
    'VALID: A genuine, reasonable, independent turning process. Not a dominant major turn, but still worth',
    'preserving as a historical anchor.',
    'WEAK: A directional turn exists, but it reads as a local swing, brief reaction, or noise; it did not',
    'establish independent directional control and is not a high-quality historical anchor.',
    'UNCLEAR: Available facts are insufficient, or evidence is clearly conflicting, so no reliable judgement is possible.',
    '',
    'Confidence states how certain you are of the significance label. It is NOT a future success probability,',
    'a trade win rate, or a price-target probability.',
    '',
    'Judge the whole picture. DO NOT use any single feature as a hard pass or hard veto.',
    'A large incoming move does not automatically mean SIGNIFICANT.',
    'High incoming efficiency does not automatically mean SIGNIFICANT.',
    'An opposite displacement does not automatically mean SIGNIFICANT.',
    'A structure break does not automatically mean SIGNIFICANT.',
    'A causal pivot role does not automatically mean SIGNIFICANT.',
    'A small reversal does not automatically mean WEAK.',
    'The absence of a structure break does not automatically mean WEAK.',
    'Integrate: whether the incoming process was a distinct directional process; the quality, efficiency and',
    'independence of the turning/reversal process; whether directional control actually changed; the structural',
    'relevance as of confirmation; and the consistency of the available evidence.',
    'Use time, distance, and ATR-normalized values only as supporting evidence, never as mechanical thresholds.',
    'Missing facts may justify UNCLEAR. Do not invent facts. null means unavailable, it does not mean zero.',
    '',
    'SIGNIFICANT does not mean "will definitely be useful in the future"; it means the turning process was',
    'plainly independent and had strong market-memory value at confirmation time.',
    'VALID is not "barely acceptable"; it means a reasonable and independent turning process that qualifies',
    'as a historical anchor, only less important than SIGNIFICANT.',
    'WEAK means a local turn happened, but there is not enough evidence that it deserves to be a high-quality anchor.',
    'UNCLEAR means facts are insufficient or conflicting, and no forced judgement should be made.',
    '',
    'Return exactly one JSON object and no prose outside it:',
    '{"significance":"SIGNIFICANT|VALID|WEAK|UNCLEAR","confidence":"HIGH|MEDIUM|LOW","primaryReason":"INDEPENDENT_DIRECTIONAL_TURN|STRONG_REVERSAL_WITH_STRUCTURAL_CHANGE|EFFICIENT_REVERSAL_FROM_EXTREME|STRUCTURALLY_MEANINGFUL_CONTROL_POINT|VALID_LOCAL_TURN_WITH_CLEAR_REVERSAL|LOCAL_REVERSAL_WITH_LIMITED_SIGNIFICANCE|WEAK_OR_CHOPPY_REVERSAL|INCOMING_PROCESS_NOT_DISTINCT|REVERSAL_NOT_INDEPENDENT_ENOUGH|CONFLICTING_EVIDENCE|INSUFFICIENT_PROVENANCE|OTHER","evidence":["..."],"counterEvidence":["..."]}',
    'If primaryReason is OTHER, the first evidence item must explain it.',
    'Never output TRADE, NO_TRADE, BUY, SELL, Entry, SL, TP, position size, expected return, future target, or probability of profit.'
].join('\n');

var USER_PREFIX = 'Classify the intrinsic significance of this confirmed historical turning point from its canonical deterministic fact object.\n\n';
var PROMPT_TEMPLATE = SYSTEM_PROMPT + '\n---USER---\n' + USER_PREFIX + '{{CANONICAL_JSON}}';

function coded(code, message) { var error = new Error(message || code); error.code = code; return error; }

function canonicalize(value) {
    if (value === null) return null;
    if (typeof value === 'number') {
        if (!isFinite(value)) throw coded('TURNING_SIGNIFICANCE_CANONICAL_NON_FINITE');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce(function (out, key) {
        if (typeof value[key] === 'undefined') throw coded('TURNING_SIGNIFICANCE_CANONICAL_UNDEFINED');
        out[key] = canonicalize(value[key]); return out;
    }, {});
    throw coded('TURNING_SIGNIFICANCE_CANONICAL_VALUE_INVALID');
}
function stableSerialize(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function exactKeys(value, keys, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).sort().join('|') !== keys.slice().sort().join('|')) throw coded(code);
}

function validateDecision(value) {
    exactKeys(value, OUTPUT_KEYS, 'TURNING_SIGNIFICANCE_OUTPUT_SCHEMA_INVALID');
    if (SIGNIFICANCE.indexOf(value.significance) < 0) throw coded('TURNING_SIGNIFICANCE_LABEL_INVALID');
    if (CONFIDENCE.indexOf(value.confidence) < 0) throw coded('TURNING_SIGNIFICANCE_CONFIDENCE_INVALID');
    if (REASONS.indexOf(value.primaryReason) < 0) throw coded('TURNING_SIGNIFICANCE_PRIMARY_REASON_INVALID');
    ['evidence', 'counterEvidence'].forEach(function (key) {
        if (!Array.isArray(value[key]) || value[key].some(function (item) {
            return typeof item !== 'string' || !item.trim();
        })) throw coded('TURNING_SIGNIFICANCE_' + key.toUpperCase() + '_INVALID');
    });
    if (value.primaryReason === 'OTHER' && !value.evidence.length) {
        throw coded('TURNING_SIGNIFICANCE_OTHER_EXPLANATION_REQUIRED');
    }
    return canonicalize(value);
}

function parseDecision(text) {
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { throw coded('TURNING_SIGNIFICANCE_MALFORMED_JSON', error.message); }
    return validateDecision(parsed);
}

function validateModelIdentity(requested, response) {
    if (requested === response) return requested;
    if (requested === MODEL && response === RESPONSE_MODEL_ALIAS) return MODEL + '|' + RESPONSE_MODEL_ALIAS;
    throw coded('TURNING_SIGNIFICANCE_UNEXPECTED_RESPONSE_MODEL_ID');
}

/**
 * LIVE_PHASE = LOW_NOTIONAL_SEMANTIC_CANARY.
 * The deterministic live policy qualifies an allowed semantic label at or above
 * the configured minimum confidence. Confidence ordering is LOW < MEDIUM < HIGH.
 * Everything else blocks, including a semantic service failure. Blocking never
 * removes the raw candidate.
 */
function evaluateGate(decision, policy) {
    try { decision = validateDecision(decision); }
    catch (error) { return { result: 'BLOCK', reason: 'TURNING_SIGNIFICANCE_SEMANTIC_INVALID' }; }
    var config = policy || {};
    var allowedLabels = config.allowedLabels || ['SIGNIFICANT', 'VALID'];
    var minimumConfidence = config.minimumConfidence || 'MEDIUM';
    var confidenceRank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    if (!Array.isArray(allowedLabels) || confidenceRank[minimumConfidence] === undefined) {
        return { result: 'BLOCK', reason: 'TURNING_SIGNIFICANCE_POLICY_INVALID' };
    }
    // A label outside the allow-list is a hard block regardless of confidence,
    // and is reported first because label is the primary discriminator.
    if (allowedLabels.indexOf(decision.significance) < 0) {
        return { result: 'BLOCK', reason: 'TURNING_SIGNIFICANCE_' + decision.significance };
    }
    if (confidenceRank[decision.confidence] < confidenceRank[minimumConfidence]) {
        return { result: 'BLOCK', reason: 'TURNING_SIGNIFICANCE_CONFIDENCE_BELOW_MINIMUM' };
    }
    return { result: 'PASS', reason: null };
}

var PROMPT_SHA256 = sha256(PROMPT_TEMPLATE);
var SCHEMA_SHA256 = sha256(stableSerialize(SCHEMA));

// PROMPT / SCHEMA FREEZE. Once promoted to production the prompt must never be
// edited silently: any change is a V2. A deliberate edit here is therefore a
// deliberate, reviewable V2 event, not an accident.
if (PROMPT_SHA256 !== 'e1962266a20c67182dc11859d0b68f1b166dd3beddb591727f4a92ce5cf917e0') {
    throw new Error('TURNING_SIGNIFICANCE_FROZEN_PROMPT_HASH_MISMATCH');
}
if (SCHEMA_SHA256 !== '43cde0b84a26136472b3f2353ffc4fc7e8eefe07363d18a2c5e3e126276caa50') {
    throw new Error('TURNING_SIGNIFICANCE_FROZEN_SCHEMA_HASH_MISMATCH');
}

module.exports = {
    VERSION: VERSION,
    PROMPT_VERSION: PROMPT_VERSION,
    PROMPT_SHA256: PROMPT_SHA256,
    SCHEMA_SHA256: SCHEMA_SHA256,
    OUTPUT_KEYS: OUTPUT_KEYS,
    MODEL: MODEL,
    RESPONSE_MODEL_ALIAS: RESPONSE_MODEL_ALIAS,
    TEMPERATURE: TEMPERATURE,
    MAX_TOKENS: MAX_TOKENS,
    SCHEMA: SCHEMA,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    USER_PREFIX: USER_PREFIX,
    PROMPT_TEMPLATE: PROMPT_TEMPLATE,
    SIGNIFICANCE: SIGNIFICANCE,
    CONFIDENCE: CONFIDENCE,
    REASONS: REASONS,
    canonicalize: canonicalize,
    stableSerialize: stableSerialize,
    sha256: sha256,
    validateDecision: validateDecision,
    parseDecision: parseDecision,
    validateModelIdentity: validateModelIdentity,
    evaluateGate: evaluateGate
};
