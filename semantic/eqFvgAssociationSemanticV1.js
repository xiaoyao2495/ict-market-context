'use strict';

var crypto = require('crypto');

var VERSION = 'EQ_FVG_ASSOCIATION_SEMANTIC_V1';
var PROMPT_VERSION = 'EQ_FVG_ASSOCIATION_SEMANTIC_PROMPT_V1';
var MODEL = 'deepseek-v4-flash';
var RESPONSE_MODEL_ALIAS = 'deepseek-flash';
var TEMPERATURE = 0;
var MAX_TOKENS = 4096;
var ASSOCIATIONS = ['STRONG_ASSOCIATION', 'PLAUSIBLE_ASSOCIATION', 'WEAK_ASSOCIATION', 'BROKEN_ASSOCIATION', 'UNCLEAR'];
var CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
var REASONS = ['DIRECT_CONTINUOUS_REPRICING', 'CONTINUOUS_WITH_MINOR_INTERRUPTION', 'NEW_LOCAL_PROCESS_EMERGED',
    'OPPOSITE_REPRICING_INTERRUPTED_PROCESS', 'ORIGINAL_CONTEXT_SUPERSEDED', 'MULTIPLE_CONFLICTING_SIGNALS',
    'INSUFFICIENT_PROVENANCE', 'OTHER'];
var OUTPUT_KEYS = ['association', 'confidence', 'counterEvidence', 'evidence', 'primaryReason'].sort();
var SCHEMA = { type: 'object', additionalProperties: false,
    required: ['association', 'confidence', 'primaryReason', 'evidence', 'counterEvidence'], properties: {
        association: { enum: ASSOCIATIONS }, confidence: { enum: CONFIDENCE }, primaryReason: { enum: REASONS },
        evidence: { type: 'array', items: { type: 'string' } }, counterEvidence: { type: 'array', items: { type: 'string' } }
    } };
var SYSTEM_PROMPT = [
    'You classify semantic continuity between an already-confirmed equal-liquidity observation (EQ) and its first later direction-matching raw three-candle FVG.',
    'Use only the supplied deterministic facts, all of which were available by the FVG confirmation time.',
    'The question is PROCESS CONTINUITY: Does the original EQ and the matching FVG still belong to one coherent directional price process?',
    'Do not judge whether the FVG is good, whether a trade should be taken, future performance, profitability, entries, stops, targets, or expected return.',
    '',
    'Labels:',
    'STRONG_ASSOCIATION: The FVG is clearly part of the same direct, continuous directional repricing after the original EQ; the EQ retains direct explanatory relevance.',
    'PLAUSIBLE_ASSOCIATION: The same process remains plausible, with pauses, local pivots, or mild complexity, but the relationship is less direct.',
    'WEAK_ASSOCIATION: Direction still matches, but substantial newer local price development makes the original EQ only weakly explanatory.',
    'BROKEN_ASSOCIATION: A clearly independent process, opposite repricing, structural reset, or superseding context has replaced the original process before the FVG.',
    'UNCLEAR: Provenance is materially insufficient or evidence is too conflicting for a reasoned classification.',
    '',
    'Judge the whole sequence. DO NOT use any single feature as a hard veto or hard pass.',
    'Many bars does not automatically mean WEAK. Large ATR distance does not automatically mean WEAK.',
    'A new pivot does not automatically mean BROKEN. An opposite displacement does not automatically mean BROKEN.',
    'A first displacement leg does not automatically mean STRONG.',
    'Prioritize: price-process continuity; intervening directional legs; opposite repricing; newer structure that supersedes the original context; newer EQ relationships; path efficiency and directional consistency.',
    'Use time and ATR distance only as supporting evidence, never as mechanical thresholds.',
    'Missing provenance may justify UNCLEAR, but do not invent facts.',
    '',
    'Return exactly one JSON object and no prose outside it:',
    '{"association":"STRONG_ASSOCIATION|PLAUSIBLE_ASSOCIATION|WEAK_ASSOCIATION|BROKEN_ASSOCIATION|UNCLEAR","confidence":"HIGH|MEDIUM|LOW","primaryReason":"DIRECT_CONTINUOUS_REPRICING|CONTINUOUS_WITH_MINOR_INTERRUPTION|NEW_LOCAL_PROCESS_EMERGED|OPPOSITE_REPRICING_INTERRUPTED_PROCESS|ORIGINAL_CONTEXT_SUPERSEDED|MULTIPLE_CONFLICTING_SIGNALS|INSUFFICIENT_PROVENANCE|OTHER","evidence":["..."],"counterEvidence":["..."]}',
    'If primaryReason is OTHER, the first evidence item must explain it.'
].join('\n');
var USER_PREFIX = 'Classify the process continuity from this canonical deterministic fact object.\n\n';
var PROMPT_TEMPLATE = SYSTEM_PROMPT + '\n---USER---\n' + USER_PREFIX + '{{CANONICAL_JSON}}';

function canonicalize(value) {
    if (value === null) return null;
    if (typeof value === 'number') {
        if (!isFinite(value)) throw coded('EQ_FVG_CANONICAL_NON_FINITE');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.keys(value).sort().reduce(function (out, key) {
        if (typeof value[key] === 'undefined') throw coded('EQ_FVG_CANONICAL_UNDEFINED');
        out[key] = canonicalize(value[key]); return out;
    }, {});
    throw coded('EQ_FVG_CANONICAL_VALUE_INVALID');
}
function stableSerialize(value) { return JSON.stringify(canonicalize(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function coded(code, message) { var error = new Error(message || code); error.code = code; return error; }
function exactKeys(value, keys, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).sort().join('|') !== keys.slice().sort().join('|')) throw coded(code);
}
function validateDecision(value) {
    exactKeys(value, OUTPUT_KEYS, 'EQ_FVG_OUTPUT_SCHEMA_INVALID');
    if (ASSOCIATIONS.indexOf(value.association) < 0) throw coded('EQ_FVG_ASSOCIATION_INVALID');
    if (CONFIDENCE.indexOf(value.confidence) < 0) throw coded('EQ_FVG_CONFIDENCE_INVALID');
    if (REASONS.indexOf(value.primaryReason) < 0) throw coded('EQ_FVG_PRIMARY_REASON_INVALID');
    ['evidence', 'counterEvidence'].forEach(function (key) {
        if (!Array.isArray(value[key]) || value[key].some(function (item) { return typeof item !== 'string' || !item.trim(); })) {
            throw coded('EQ_FVG_' + key.toUpperCase() + '_INVALID');
        }
    });
    if (value.primaryReason === 'OTHER' && !value.evidence.length) throw coded('EQ_FVG_OTHER_EXPLANATION_REQUIRED');
    return canonicalize(value);
}
function parseDecision(text) {
    var parsed;
    try { parsed = JSON.parse(text); } catch (error) { throw coded('EQ_FVG_MALFORMED_JSON', error.message); }
    return validateDecision(parsed);
}
function validateModelIdentity(requested, response) {
    if (requested === response) return requested;
    if (requested === MODEL && response === RESPONSE_MODEL_ALIAS) return MODEL + '|' + RESPONSE_MODEL_ALIAS;
    throw coded('EQ_FVG_UNEXPECTED_RESPONSE_MODEL_ID');
}
function evaluateGate(decision) {
    try { decision = validateDecision(decision); } catch (error) {
        return { result: 'BLOCK', reason: 'EQ_FVG_SEMANTIC_INVALID' };
    }
    if (decision.confidence !== 'HIGH') return { result: 'BLOCK', reason: 'EQ_FVG_ASSOCIATION_CONFIDENCE_NOT_HIGH' };
    if (decision.association === 'STRONG_ASSOCIATION' || decision.association === 'PLAUSIBLE_ASSOCIATION') {
        return { result: 'PASS', reason: null };
    }
    return { result: 'BLOCK', reason: 'EQ_FVG_ASSOCIATION_' + decision.association.replace('_ASSOCIATION', '') };
}

var PROMPT_SHA256 = sha256(PROMPT_TEMPLATE);
if (PROMPT_SHA256 !== '82b434bfb0112cfa32f4921cb1a80156feeeb1c0e83bbd448f22886232292918') {
    throw new Error('EQ_FVG_FROZEN_PROMPT_HASH_MISMATCH');
}

module.exports = { VERSION: VERSION, PROMPT_VERSION: PROMPT_VERSION, PROMPT_SHA256: PROMPT_SHA256,
    MODEL: MODEL, RESPONSE_MODEL_ALIAS: RESPONSE_MODEL_ALIAS, TEMPERATURE: TEMPERATURE, MAX_TOKENS: MAX_TOKENS,
    SCHEMA: SCHEMA, SYSTEM_PROMPT: SYSTEM_PROMPT, USER_PREFIX: USER_PREFIX, PROMPT_TEMPLATE: PROMPT_TEMPLATE,
    ASSOCIATIONS: ASSOCIATIONS, CONFIDENCE: CONFIDENCE, REASONS: REASONS,
    canonicalize: canonicalize, stableSerialize: stableSerialize, sha256: sha256,
    validateDecision: validateDecision, parseDecision: parseDecision,
    validateModelIdentity: validateModelIdentity, evaluateGate: evaluateGate };
