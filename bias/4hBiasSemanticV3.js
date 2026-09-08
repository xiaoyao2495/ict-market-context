'use strict';

var crypto = require('crypto');

var VERSION = '4H_BIAS_SEMANTIC_V3';
var FACT_SET_VERSION = '4H_BIAS_FACT_SET_V3';
var MODEL = 'deepseek-v4-flash';
var DIRECTIONS = ['BULLISH', 'BEARISH', 'NO_PRIORITY'];
var STRENGTHS = ['STRONG', 'MODERATE', 'WEAK'];
var CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
var INPUT_FIELDS = ['closedAt', 'facts', 'symbol', 'timeframe'];
var FACT_FIELDS = [
    'adx14',
    'normalizedDirectionalSpread',
    'signedEfficiency24',
    'signedMoveAtr24',
    'structureDirection',
    'theilSenSlope48'
];
var OUTPUT_FIELDS = ['confidence', 'conflicts', 'direction', 'strength', 'summary'];

var SYSTEM_PROMPT = [
    'You compress deterministic CURRENT native-4H market facts into one concise 4H Bias.',
    'Use only the supplied facts. Do not create, calculate, or imply evidence that is not supplied.',
    '',
    'Direction and Strength are different dimensions.',
    'For signed facts, the sign contributes to Direction and the magnitude contributes to Strength.',
    'normalizedDirectionalSpread describes directional dominance.',
    'signedMoveAtr24 describes 24-bar net delivered magnitude in ATR units.',
    'signedEfficiency24 describes the direction and one-sidedness of the 24-bar delivery path.',
    'theilSenSlope48 describes robust slow-trend direction and magnitude.',
    'structureDirection contributes only supplied causal structural direction/context.',
    'ADX14 contributes to Strength only. ADX has no bullish or bearish direction.',
    '',
    'signedMoveAtr24 and signedEfficiency24 are correlated members of one Delivery family.',
    'Do not double-count them as two independent confirmations, although they describe net magnitude and path directness separately.',
    'Facts do not need to agree perfectly. Conflict is a valid current market condition and must be summarized honestly.',
    'Do not force a Direction merely to avoid NO_PRIORITY.',
    'Strength describes current directional-process intensity, not probability of future continuation.',
    'Do not use hard Strength thresholds, indicator thresholds, weighted voting, composite scores, or custom direction/strength scores.',
    '',
    'Do not infer Transition or Persistence.',
    'Do not predict future price, the next candle, continuation, reversal, outcome, or profitability.',
    'Do not provide trading advice, entries, targets, WATCH decisions, or notification decisions.',
    'Do not infer candlestick patterns, bodies, wicks, support/resistance, chart geometry, or unseen indicators.',
    '',
    'Return one JSON object with exactly these fields and no prose outside it:',
    '{',
    '  "direction": "BULLISH" | "BEARISH" | "NO_PRIORITY",',
    '  "strength": "STRONG" | "MODERATE" | "WEAK",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "summary": "short current-state explanation",',
    '  "conflicts": "short meaningful disagreement explanation, or NONE"',
    '}'
].join('\n');

var PROMPT_HASH = crypto.createHash('sha256').update(SYSTEM_PROMPT + '\n').digest('hex');

function exactKeys(value, expected, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected.slice().sort())) {
        throw Object.assign(new Error(code), { code: code });
    }
}

function validateInput(input) {
    exactKeys(input, INPUT_FIELDS, 'V3_INPUT_SCHEMA_INVALID');
    exactKeys(input.facts, FACT_FIELDS, 'V3_FACT_SCHEMA_INVALID');
    if (typeof input.symbol !== 'string' || input.timeframe !== '4h' ||
        typeof input.closedAt !== 'number' || !isFinite(input.closedAt)) {
        throw Object.assign(new Error('V3_INPUT_VALUE_INVALID'), { code: 'V3_INPUT_VALUE_INVALID' });
    }
    FACT_FIELDS.forEach(function (key) {
        var value = input.facts[key];
        if (key === 'structureDirection') {
            if (['UP', 'DOWN', 'NEUTRAL'].indexOf(value) < 0) throw new Error('V3_STRUCTURE_DIRECTION_INVALID');
        } else if (typeof value !== 'number' || !isFinite(value)) {
            throw new Error('V3_FACT_NON_FINITE_' + key);
        }
    });
    return input;
}

function buildInput(factSet) {
    return validateInput({
        symbol: factSet.symbol,
        timeframe: factSet.timeframe,
        closedAt: factSet.closedAt,
        facts: Object.assign({}, factSet.facts)
    });
}

function buildUserPrompt(input) {
    validateInput(input);
    return 'Compress the supplied deterministic facts into the current 4H Bias.\n\n' + JSON.stringify(input, null, 2);
}

function validateOutput(output) {
    exactKeys(output, OUTPUT_FIELDS, 'V3_OUTPUT_SCHEMA_INVALID');
    if (DIRECTIONS.indexOf(output.direction) < 0) throw new Error('V3_DIRECTION_INVALID');
    if (STRENGTHS.indexOf(output.strength) < 0) throw new Error('V3_STRENGTH_INVALID');
    if (CONFIDENCE.indexOf(output.confidence) < 0) throw new Error('V3_CONFIDENCE_INVALID');
    if (typeof output.summary !== 'string' || !output.summary.trim()) throw new Error('V3_SUMMARY_INVALID');
    if (typeof output.conflicts !== 'string') throw new Error('V3_CONFLICTS_INVALID');
    return output;
}

module.exports = {
    VERSION: VERSION,
    FACT_SET_VERSION: FACT_SET_VERSION,
    MODEL: MODEL,
    PROMPT_HASH: PROMPT_HASH,
    LEGACY_V2_PROMPT_HASH: 'f07b4f27cda27dc6a3188e0386e90a04353b0d922e15eb3d5401671f93c642fe',
    DIRECTIONS: DIRECTIONS,
    STRENGTHS: STRENGTHS,
    CONFIDENCE: CONFIDENCE,
    INPUT_FIELDS: INPUT_FIELDS,
    FACT_FIELDS: FACT_FIELDS,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildInput: buildInput,
    buildUserPrompt: buildUserPrompt,
    validateInput: validateInput,
    validateOutput: validateOutput
};
