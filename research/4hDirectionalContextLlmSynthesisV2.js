/** Research candidate only: contextual synthesis over LLM_INPUT_FACT_SET_V1. */
var CONTRACT = require('./4hDirectionalContextSemanticContractV1');

var SYNTHESIS_ID = '4H_DIRECTIONAL_CONTEXT_LLM_SYNTHESIS_V2';
var INPUT_SCHEMA = 'LLM_INPUT_FACT_SET_V1';
var DIRECTIONS = ['BULLISH', 'BEARISH', 'NO_PRIORITY'];
var CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'];
var TOP_LEVEL_FIELDS = [
    'confidence',
    'conflictingFacts',
    'direction',
    'dominantFacts',
    'stateInterpretation',
    'whatWouldChangeTheAssessment'
].sort();

var SYSTEM_PROMPT = [
    'You are evaluating CURRENT 4H DIRECTIONAL PRIORITY.',
    '',
    'Using only the supplied causal facts from closed 4H candles, determine whether future',
    'lower-timeframe opportunities should currently be prioritized toward BULLISH, BEARISH,',
    'or NO_PRIORITY.',
    '',
    'This is NOT a prediction of the next candle, future return, target, trade outcome, or profitability.',
    '',
    'The deterministic supplied facts are authoritative.',
    'Raw OHLC is finite contextual information only. Do not re-detect or override supplied',
    'directional legs, structural state, or deterministic metrics.',
    '',
    'SEMANTIC CONTRACT:',
    '',
    '1. Coherent alignment across price delivery and directional states strongly supports directional priority.',
    '2. Cross-scale conflict alone does not justify NO_PRIORITY.',
    '3. A counter-directional minor leg may be a correction inside an otherwise coherent directional context.',
    '   A counter minor leg alone must not automatically cancel directional priority.',
    '4. An older opposing major leg may coexist with a newer coherent directional context.',
    '   A residual major leg alone must not automatically cancel directional priority.',
    '5. When delivery is internally mixed and directional states are also internally mixed, uncertainty is',
    '   materially higher, but mixed facts do not automatically equal NO_PRIORITY.',
    '6. Evaluate directional magnitude, signed efficiency, persistence, age, confirmedAt recency, structural',
    '   transition recency, and the finite raw OHLC context together.',
    '7. Return NO_PRIORITY only when neither bullish nor bearish interpretation has sufficient current dominance.',
    '8. Do not invent numeric weights, scores, voting rules, fixed priority hierarchies, or deterministic classifiers.',
    '9. When a directional priority is selected, material opposing evidence must still be listed in conflictingFacts.',
    '',
    'whatWouldChangeTheAssessment may describe only changes expressible by the supplied fact schema, such as',
    'delivery becoming coherently opposite, a minor or major direction transition, or a structural state transition.',
    'Do not invent support/resistance, liquidity targets, news, future price targets, entry points, or ICT objects.',
    '',
    'Return one JSON object and no prose outside it. Use exactly these top-level fields:',
    '{',
    '  "direction": "BULLISH" | "BEARISH" | "NO_PRIORITY",',
    '  "confidence": "HIGH" | "MEDIUM" | "LOW",',
    '  "dominantFacts": ["..."],',
    '  "conflictingFacts": ["..."],',
    '  "stateInterpretation": "...",',
    '  "whatWouldChangeTheAssessment": ["..."]',
    '}'
].join('\n');

function buildUserPrompt(input) {
    if (!input || input.schemaVersion !== INPUT_SCHEMA) {
        throw new Error('FACT_SCHEMA_MISMATCH');
    }
    return [
        'Assess CURRENT 4H DIRECTIONAL PRIORITY as of evaluationTime.',
        'Use only the following frozen fact set.',
        '',
        JSON.stringify(input, null, 2)
    ].join('\n');
}

function assertStringArray(value, name) {
    if (!Array.isArray(value) || value.some(function (item) { return typeof item !== 'string'; })) {
        throw new Error(name + '_MUST_BE_STRING_ARRAY');
    }
}

function validateOutput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RESPONSE_MUST_BE_OBJECT');
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(TOP_LEVEL_FIELDS)) {
        throw new Error('UNEXPECTED_TOP_LEVEL_FIELDS');
    }
    if (DIRECTIONS.indexOf(value.direction) < 0) throw new Error('INVALID_DIRECTION');
    if (CONFIDENCE.indexOf(value.confidence) < 0) throw new Error('INVALID_CONFIDENCE');
    assertStringArray(value.dominantFacts, 'dominantFacts');
    assertStringArray(value.conflictingFacts, 'conflictingFacts');
    assertStringArray(value.whatWouldChangeTheAssessment, 'whatWouldChangeTheAssessment');
    if (typeof value.stateInterpretation !== 'string') throw new Error('stateInterpretation_MUST_BE_STRING');
    return value;
}

module.exports = {
    id: SYNTHESIS_ID,
    contractId: CONTRACT.id,
    inputSchema: INPUT_SCHEMA,
    directions: DIRECTIONS,
    confidence: CONFIDENCE,
    systemPrompt: SYSTEM_PROMPT,
    buildUserPrompt: buildUserPrompt,
    validateOutput: validateOutput
};
